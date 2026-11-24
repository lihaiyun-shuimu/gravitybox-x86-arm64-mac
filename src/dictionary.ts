import {withProcessLease} from './process-lock.js';
import {decodeScopedKey} from './candidates.js';
import { access, mkdir, readFile, readdir, rename, lstat } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { atomicJson } from './files.js';
import { SUPPORTED_BUNDLES, normalizeText as normalize } from './bundle.js';
import { bt, getActiveLocale } from './i18n.js';

export type DeclarativeTemplateRule = {
  key: string;
  pattern: string;
  flags?: string;
  replacement: string;
  inlineOnly?: boolean;
};
export type Dictionary = {
  schema: 1;
  version: string;
  entries: Record<string, string>;
  templateRules?: DeclarativeTemplateRule[];
};
export type LayerCounts = { builtin:number; incremental:number; personal:number };
export function sourceCategory(source:string):keyof LayerCounts { return source.endsWith('个人覆盖.json') ? 'personal' : source.includes('增量补全') ? 'incremental' : (source.startsWith('内置') || source.startsWith('Built-in') || source.startsWith(bt('dictionary.source.builtin'))) ? 'builtin' : 'personal'; }
export type LayeredDictionary = {
  dictionary: Dictionary;
  /** 被更高层覆盖的词条，供覆盖率报告与发布门禁核对，不静默吞掉 */
  overrode: { key: string; from: string; to: string }[];
  files: string[];
  sources: Record<string, string>;
};

const LEGACY_LAYER_FILE = /^增量补全-(\d+\.\d+\.\d+)\.json$/;

/**
 * 合并历史碎片层到统一增量层。
 *
 * 只压平“受支持版本”的碎片层。未知/未来版本的专用译文保留在原文件（加载器会按 targetVersion 过滤），
 * 避免把只对某个新版本有效的译文推广成全版本生效。非版本名（如 `增量补全-legacy.json`）仍按原行为合并。
 * 默认受支持版本取自 `SUPPORTED_BUNDLES`，测试/迁移工具可用 `supportedVersions` 覆盖。
 */
export async function migrateLegacyIncrementalDictionaries(userDir: string, options: { supportedVersions?: Iterable<string> } = {}): Promise<void> {
  return withProcessLease(join(userDir,'incremental-write.lock'),()=>migrateLegacyLocked(userDir,options));
}
async function migrateLegacyLocked(userDir:string, options:{supportedVersions?:Iterable<string>}):Promise<void> {
  try {
    const supported = new Set(options.supportedVersions ?? SUPPORTED_BUNDLES.keys());
    const files = await readdir(userDir);
    const legacyFiles = files
      .filter(f => /^增量补全-.+\.json$/.test(f) && !f.endsWith('.quarantine') && !f.includes('.migrated') && f !== '增量补全-fixture.json')
      .filter(file => {
        const version = file.match(LEGACY_LAYER_FILE)?.[1];
        return !version || supported.has(version);
      });
    if (!legacyFiles.length) return;
    const unifiedPath = join(userDir, '增量补全.json');
    let combined: Record<string, string> = {};
    try {
      const existingRaw = await readFile(unifiedPath, 'utf8');
      try {
        combined = validateEntries(JSON.parse(existingRaw), bt('dictionary.label.existing_incremental'));
      } catch {
        // 现有统一词典损坏：绝不能退回空对象后覆盖原文件！必须保留原件，停止自动合并，避免丢失原内容
        return;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        return;
      }
      combined = {};
    }

    const successfullyValidatedFiles: string[] = [];
    for (const file of legacyFiles.sort(compareLayers)) {
      try {
        const raw = await readFile(join(userDir, file), 'utf8');
        const data = JSON.parse(raw);
        const validated = validateEntries(data, file);
        for (const [k, v] of Object.entries(validated)) {
          if (!Object.hasOwn(combined,k)) combined[k] = v;
        }
        successfullyValidatedFiles.push(file);
      } catch {
        // 输入损坏时保留原文件，绝不加入成功迁移列表，不删除、不重命名
      }
    }

    if (!successfullyValidatedFiles.length) {
      // 没有任一成功解析的旧文件，不作任何写盘或文件变动，原文件完整保留
      return;
    }

    const sorted = Object.fromEntries(Object.entries(combined).sort(([a], [b]) => a.localeCompare(b)));
    validateEntries(sorted);
    const expectedDigest = createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
    await atomicJson(unifiedPath, sorted);
    const checkBack = validateEntries(JSON.parse(await readFile(unifiedPath, 'utf8')), bt('dictionary.label.write_check'));
    const actualDigest = createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(checkBack).sort(([a], [b]) => a.localeCompare(b))))).digest('hex');
    if (Object.keys(checkBack).length < Object.keys(sorted).length || actualDigest !== expectedDigest) {
      throw new Error(bt('dictionary.err.migration_mismatch'));
    }

    // 成功迁移的旧文件：保留在可恢复的 .migrated 备份中，若已存在同名恢复副本则使用唯一后缀禁止覆盖
    for (const file of successfullyValidatedFiles) {
      try {
        const defaultBackup = join(userDir, `${file}.migrated`);
        const exists = await lstat(defaultBackup).then(() => true).catch(() => false);
        const targetBackup = exists
          ? join(userDir, `${file}.migrated.${Date.now()}-${randomUUID().slice(0, 8)}`)
          : defaultBackup;
        await rename(join(userDir, file), targetBackup);
      } catch {}
    }
  } catch {}
}

/* ------------------------------------------------------------------ 增量补全层：按 key / 按批次删除与撤销 */

export const INCREMENTAL_DICTIONARY_FILE = '增量补全.json';
export const incrementalDictionaryPath = (userDir: string) => join(userDir, INCREMENTAL_DICTIONARY_FILE);
const textDigest = (text: string) => createHash('sha256').update(text).digest('hex');
const sortedEntries = (entries: Record<string, string>) => Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)));
const serialized = (entries: Record<string, string>) => JSON.stringify(sortedEntries(entries), null, 2) + '\n';

/** 删除前的撤销快照；`batchId` 供按补译批次追溯。 */
export type IncrementalSnapshot = {
  schema: 1;
  at: string;
  batchId?: string;
  file: string;
  removed: Record<string, string>;
};

export type IncrementalRemovalOptions = {
  /** 删除前写撤销快照的路径；提供后可用 restoreIncrementalSnapshot 撤销。 */
  snapshotPath?: string;
  /** CAS：当前增量文件原文的 sha256（来自 readIncrementalEntries）；不一致说明已被其他位置/批次修改，拒绝删除。 */
  expectedDigest?: string;
  /** 补译批次标识，写入撤销快照。 */
  batchId?: string;
  /** 只计算结果，不写盘。 */
  dryRun?: boolean;
};

export type IncrementalRemoval = {
  ok: true;
  file: string;
  /** 实际删除的增量词条（规范化后的键）。 */
  removed: string[];
  /** 请求删除但增量层本来就不存在的键（幂等，不算失败）。 */
  missing: string[];
  /** 删除后增量层剩余条数。 */
  remaining: number;
  /** 将写入（dryRun 下为预期写入）文件的 sha256，可作为下一次 expectedDigest。 */
  digest: string;
  dryRun: boolean;
  snapshot?: { path: string; batchId?: string };
};

export type IncrementalBatch = { id?: string; keys: string[] };

type IncrementalState = { raw: string; entries: Record<string, string>; digest: string };

async function readIncremental(userDir: string): Promise<IncrementalState | undefined> {
  const file = incrementalDictionaryPath(userDir);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  let entries: Record<string, string>;
  try {
    entries = validateEntries(JSON.parse(raw), INCREMENTAL_DICTIONARY_FILE);
  } catch (error) {
    // 损坏时只读不写：调用方必须能知道“无法安全删除”，又不能让操作覆盖原文件
    throw new Error(bt('dictionary.err.incremental_parse', { file: INCREMENTAL_DICTIONARY_FILE, error: (error as Error).message }));
  }
  return { raw, entries, digest: textDigest(raw) };
}

/**
 * 读取增量层当前词条与原文摘要。`digest` 可作为删除/撤销时的 CAS 期望值，避免覆盖并发写入。
 * 文件不存在时返回空的 entries 与空文本摘要（幂等删除场景）。
 */
export async function readIncrementalEntries(userDir: string): Promise<{ entries: Record<string, string>; digest: string; exists: boolean }> {
  const current = await readIncremental(userDir);
  return current
    ? { entries: { ...current.entries }, digest: current.digest, exists: true }
    : { entries: Object.create(null) as Record<string, string>, digest: textDigest(''), exists: false };
}

/**
 * 从增量补译层删除指定词条。这是“错误自动译文只能覆盖不能删”问题的存储 API：
 * 按 key 删除、按批次（传一组 key + batchId）删除、dryRun 预览、expectedDigest CAS、删除前撤销快照。
 * 写入使用原子写 + 写后核对；增量层损坏时抛错且不触碰原文件。
 */
export async function removeIncrementalEntries(userDir: string, keys: string[], options: IncrementalRemovalOptions = {}): Promise<IncrementalRemoval> {
  if (!Array.isArray(keys) || !keys.length) throw new Error(bt('dictionary.err.remove_need_one'));
  if (keys.length > 1000) throw new Error(bt('dictionary.err.remove_max'));
  const targets = [...new Set(keys.map(key => {
    if (typeof key !== 'string' || !key.trim()) throw new Error(bt('dictionary.err.remove_empty_key'));
    return normalize(key);
  }))];
  const execute = async (): Promise<IncrementalRemoval> => {
    const file = incrementalDictionaryPath(userDir);
    const current = await readIncremental(userDir);
    if (options.expectedDigest !== undefined) {
      const currentDigest = current?.digest ?? textDigest('');
      if (options.expectedDigest !== currentDigest) throw new Error(bt('dictionary.err.incremental_modified'));
    }
    const entries: Record<string, string> = current ? { ...current.entries } : (Object.create(null) as Record<string, string>);
    const removed: string[] = [];
    const missing: string[] = [];
    const removedEntries: Record<string, string> = Object.create(null);
    for (const key of targets) {
      if (!Object.hasOwn(entries, key)) { missing.push(key); continue; }
      removedEntries[key] = entries[key]!;
      delete entries[key];
      removed.push(key);
    }
    const digest = textDigest(serialized(entries));
    const write = !options.dryRun && removed.length > 0;
    if (write && options.snapshotPath) {
      const snapshot: IncrementalSnapshot = { schema: 1, at: new Date().toISOString(), ...(options.batchId ? { batchId: options.batchId } : {}), file, removed: removedEntries };
      await atomicJson(options.snapshotPath, snapshot);
    }
    if (write) {
      await atomicJson(file, sortedEntries(entries));
      const writtenRaw = await readFile(file, 'utf8');
      let checkBack: Record<string, string>;
      try {
        checkBack = validateEntries(JSON.parse(writtenRaw), bt('dictionary.label.incremental_write_check'));
      } catch (error) {
        throw new Error(bt('dictionary.err.write_check_failed', { error: (error as Error).message }));
      }
      if (Object.keys(checkBack).length !== Object.keys(entries).length || textDigest(writtenRaw) !== digest) {
        throw new Error(bt('dictionary.err.write_mismatch'));
      }
      for (const key of removed) if (Object.hasOwn(checkBack, key)) throw new Error(bt('dictionary.err.still_present', { key }));
    }
    return {
      ok: true,
      file,
      removed,
      missing,
      remaining: Object.keys(entries).length,
      digest,
      dryRun: !!options.dryRun,
      ...(write && options.snapshotPath ? { snapshot: { path: options.snapshotPath, ...(options.batchId ? { batchId: options.batchId } : {}) } } : {}),
    };
  };
  const dirExists = await lstat(userDir).then(st => st.isDirectory()).catch(() => false);
  if (!dirExists) return execute();
  return withProcessLease(join(userDir, 'incremental-write.lock'), execute);
}

/** 按补译批次删除：批次 = 一组 key + 可选批次标识，等价于带 batchId 的 removeIncrementalEntries。 */
export async function removeIncrementalBatch(userDir: string, batch: IncrementalBatch, options: Omit<IncrementalRemovalOptions, 'batchId'> = {}): Promise<IncrementalRemoval> {
  if (!batch || !Array.isArray(batch.keys)) throw new Error(bt('dictionary.err.batch_keys_required'));
  return removeIncrementalEntries(userDir, batch.keys, { ...options, ...(batch.id ? { batchId: batch.id } : {}) });
}

/**
 * 用撤销快照恢复被删除的增量词条。默认覆盖同键现值；`overwriteExisting:false` 时保留现值并报告 skipped。
 * 返回 restored/skipped/remaining，便于 UI 或运维核对。
 */
export async function restoreIncrementalSnapshot(
  userDir: string,
  snapshotPath: string,
  options: { overwriteExisting?: boolean } = {}
): Promise<{ restored: string[]; skipped: string[]; remaining: number }> {
  let snapshot: IncrementalSnapshot;
  try {
    const parsed = JSON.parse(await readFile(snapshotPath, 'utf8')) as Partial<IncrementalSnapshot>;
    if (!parsed || parsed.schema !== 1 || !parsed.removed || typeof parsed.removed !== 'object' || Array.isArray(parsed.removed)) throw new Error(bt('dictionary.err.missing_schema_removed'));
    snapshot = parsed as IncrementalSnapshot;
  } catch (error) {
    throw new Error(bt('dictionary.err.undo_invalid', { error: (error as Error).message }));
  }
  const incoming = validateEntries(snapshot.removed, bt('dictionary.label.undo_snapshot'));
  await mkdir(userDir, { recursive: true, mode: 0o700 });
  return withProcessLease(join(userDir, 'incremental-write.lock'), async () => {
    const current = await readIncremental(userDir);
    const entries: Record<string, string> = current ? { ...current.entries } : (Object.create(null) as Record<string, string>);
    const restored: string[] = [];
    const skipped: string[] = [];
    for (const [key, value] of Object.entries(incoming)) {
      if (Object.hasOwn(entries, key) && entries[key] !== value && options.overwriteExisting === false) { skipped.push(key); continue; }
      entries[key] = value;
      restored.push(key);
    }
    if (restored.length) {
      await atomicJson(incrementalDictionaryPath(userDir), sortedEntries(entries));
      const writtenRaw = await readFile(incrementalDictionaryPath(userDir), 'utf8');
      const checkBack = validateEntries(JSON.parse(writtenRaw), bt('dictionary.label.undo_check'));
      if (Object.keys(checkBack).length !== Object.keys(entries).length || textDigest(writtenRaw) !== textDigest(serialized(entries))) {
        throw new Error(bt('dictionary.err.undo_write_mismatch'));
      }
    }
    return { restored: restored.sort(), skipped: skipped.sort(), remaining: Object.keys(entries).length };
  });
}

/**
 * 层内加载顺序决定覆盖关系，不能靠文件名字典序：`2.24.0.json` 会排在 `base.json` 前面，
 * 结果版本层反被基础层覆盖（实测如此）。这里显式定义优先级：
 *   base.json 最先（最低）→ `<版本号>.json` 按版本号升序 → 其他杂项文件最后（最高）
 */
function layerRank(name: string): [number, number[], string] {
  if (name === '个人覆盖.json') return [3, [], name];
  if (name.toLowerCase() === 'base.json') return [0, [], name];
  const version = name.match(/^(\d+(?:\.\d+)*)\.json$/);
  if (version) {
    const parts = version[1]!.split('.').map(Number);
    // Date-stamped releases (e.g. 1.0.20261103010115) rank above 2.x.y semver layers
    if (parts.length >= 3 && parts[0] === 1 && parts[1] === 0 && (version[1]!.split('.')[2]?.length ?? 0) >= 8) {
      return [1, [9999, ...parts], name];
    }
    return [1, parts, name];
  }
  return [2, [], name];
}
export function compareLayers(a: string, b: string): number {
  const [ra, va, na] = layerRank(a);
  const [rb, vb, nb] = layerRank(b);
  if (ra !== rb) return ra - rb;
  for (let i = 0; i < Math.max(va.length, vb.length); i += 1) {
    const diff = (va[i] ?? 0) - (vb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return na.localeCompare(nb);
}
const PLACEHOLDER_TOKEN_RE = /\{\{?[a-zA-Z0-9_.-]+\}?\}|\$\{[^}]+\}|\$\d+|%(?:\d+\$)?[sdifu]/g;
const placeholderSignature = (s: string): string =>
  (s.includes('{') || s.includes('$') || s.includes('%'))
    ? (s.match(PLACEHOLDER_TOKEN_RE)?.sort().join('|') ?? '')
    : '';

export function validateEntries(data: unknown, file = bt('dictionary.default_file_label')): Record<string, string> {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(bt('dictionary.err.must_be_object', { file }));
  const entries: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(data)) {
    if (typeof value !== 'string') throw new Error(bt('dictionary.err.non_string_value', { file }));
    const normalized = normalize(key);
    if (!normalized || normalized.length > 2000 || value.length > 4000 || normalized === '__proto__' || normalized === 'constructor' || normalized === 'prototype') {
      throw new Error(bt('dictionary.err.invalid_entry', { file }));
    }
    if (Object.hasOwn(entries, normalized)) throw new Error(bt('dictionary.err.duplicate_normalized', { file }));
    if (placeholderSignature(key) !== placeholderSignature(value)) throw new Error(bt('dictionary.err.placeholder_mismatch', { file }));
    entries[normalized] = value;
  }
  return entries;
}

function isRepeatableBraceQuantifier(tail: string): boolean {
  const m = tail.match(/^\{(\d+)(?:,(\d*))?\}/);
  if (!m) return false;
  if (m[2] === undefined) return Number(m[1]) >= 2;
  if (m[2] === '') return true;
  return Number(m[2]) >= 2;
}

export function hasNestedQuantifiedGroup(pattern: string): boolean {
  const groupHasQuantifier: boolean[] = [];
  let inCharClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '\\') { i++; continue; }
    if (ch === '[') { inCharClass = true; continue; }
    if (ch === ']' && inCharClass) { inCharClass = false; continue; }
    if (inCharClass) continue;
    if (ch === '(') {
      groupHasQuantifier.push(false);
    } else if (ch === ')') {
      const innerQuantified = groupHasQuantifier.pop() ?? false;
      const next = pattern[i + 1] ?? '';
      const outerRepeats =
        next === '+' ||
        next === '*' ||
        (next === '{' && isRepeatableBraceQuantifier(pattern.slice(i + 1)));
      const outerOptional = next === '?';
      if (innerQuantified && (outerRepeats || outerOptional)) return true;
      if ((innerQuantified || outerRepeats) && groupHasQuantifier.length > 0) {
        groupHasQuantifier[groupHasQuantifier.length - 1] = true;
      }
    } else if (
      (ch === '+' || ch === '*' || (ch === '{' && isRepeatableBraceQuantifier(pattern.slice(i))))
      && groupHasQuantifier.length > 0
    ) {
      groupHasQuantifier[groupHasQuantifier.length - 1] = true;
    }
  }
  return false;
}

export function validateTemplateRules(data: unknown): DeclarativeTemplateRule[] {
  const rawList = Array.isArray(data)
    ? data
    : data && typeof data === 'object' && Array.isArray((data as { rules?: unknown }).rules)
    ? (data as { rules: unknown[] }).rules
    : [];
  const out: DeclarativeTemplateRule[] = [];
  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue;
    const candidate = item as Record<string, unknown>;
    const key = typeof candidate.key === 'string' ? normalize(candidate.key) : '';
    const pattern = typeof candidate.pattern === 'string' ? candidate.pattern : '';
    const flags = typeof candidate.flags === 'string' ? candidate.flags : 'i';
    const replacement = typeof candidate.replacement === 'string' ? candidate.replacement : '';
    if (!key || key.length > 240 || !pattern || pattern.length > 320 || !pattern.startsWith('^') || !replacement || replacement.length > 400) continue;
    if (!/^[iu]*$/.test(flags)) continue;
    if (hasNestedQuantifiedGroup(pattern) || /(\([^)]*[+*][^)]*\))[+*?]/.test(pattern)) continue;
    if (!/\{\d+\}/.test(key) && candidate.inlineOnly !== true && /\{\d+\}/.test(replacement)) continue;
    try {
      new RegExp(pattern, flags);
      out.push({
        key,
        pattern,
        flags,
        replacement,
        ...(typeof candidate.inlineOnly === 'boolean' ? { inlineOnly: candidate.inlineOnly } : {}),
      });
      if (out.length >= 256) break;
    } catch {}
  }
  return out;
}

export function dictionaryFromEntries(entries: Record<string, string>, templateRules?: DeclarativeTemplateRule[]): Dictionary {
  const sorted = Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)));
  const cleanRules = templateRules && templateRules.length > 0 ? templateRules : undefined;
  const hashPayload = cleanRules ? JSON.stringify({ entries: sorted, templateRules: cleanRules }) : JSON.stringify(sorted);
  return {
    schema: 1,
    version: createHash('sha256').update(hashPayload).digest('hex').slice(0, 16),
    entries: sorted,
    ...(cleanRules ? { templateRules: cleanRules } : {}),
  };
}

/**
 * 词典分层加载：`base.json` 是历史积累层，`<应用版本>.json` 是针对某个版本的层，用户目录最高。
 * 后加载的层覆盖先加载的层——这正是"新版本新增一批译文"该有的语义。
 *
 * 旧实现遇到跨文件重复键直接抛错，后果是"新版本词典只要与 base 撞任意一个键，
 * 整份词典加载失败、新词一条都不生效"。覆盖是预期行为，因此这里允许覆盖，
 * 但把每一次覆盖记进 `overrode`，让覆盖率报告与发布门禁能核对，而不是静默吞掉。
 */
const TEMPLATE_RULES_FILE = 'template-rules.json';
const MAX_LAYER_FILE_CACHE_ENTRIES = 32;
const layerFileCache = new Map<string, { mtimeMs: number; size: number; validated: Record<string, string> }>();

function setLayerFileCacheEntry(filePath: string, entry: { mtimeMs: number; size: number; validated: Record<string, string> }): void {
  layerFileCache.delete(filePath);
  if (layerFileCache.size >= MAX_LAYER_FILE_CACHE_ENTRIES) {
    const oldest = layerFileCache.keys().next().value;
    if (oldest !== undefined) layerFileCache.delete(oldest);
  }
  layerFileCache.set(filePath, entry);
}

export async function loadDictionaryLayers(baseDir: string, userDir?: string,targetVersion?:string): Promise<LayeredDictionary> {
  const entries: Record<string, string> = Object.create(null);
  const templateRuleByKey = new Map<string, DeclarativeTemplateRule>();
  const owner = new Map<string, { file: string; dir: string }>();
  const overrode: { key: string; from: string; to: string }[] = [];
  const files: string[] = [];
  const personalGlobals=new Set<string>();
  const sources: Record<string, string> = Object.create(null);
  for (const dir of userDir ? [baseDir, userDir] : [baseDir]) {
    const names = (await readdir(dir)).filter(name => name.endsWith('.json')).sort(compareLayers);
    for (const file of names) {
      if (file.toLowerCase() === TEMPLATE_RULES_FILE) {
        const ruleContent = await readFile(join(dir, file), 'utf8');
        if (ruleContent.length > 512_000) throw new Error(bt('dictionary.err.size_limit', { file }));
        let ruleData: unknown;
        try { ruleData = JSON.parse(ruleContent); } catch { throw new Error(bt('dictionary.err.invalid_json', { file })); }
        for (const rule of validateTemplateRules(ruleData)) {
          templateRuleByKey.delete(rule.key);
          templateRuleByKey.set(rule.key, rule);
        }
        files.push(file);
        continue;
      }
      const version=file.match(/^(?:增量补全-)?(\d+\.\d+\.\d+)\.json$/)?.[1];
      if(targetVersion&&version&&compareLayers(version+'.json',targetVersion+'.json')>0)continue;
      const filePath = join(dir, file);
      const st = await lstat(filePath);
      const cached = layerFileCache.get(filePath);
      let validated: Record<string, string>;
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
        setLayerFileCacheEntry(filePath, cached);
        validated = cached.validated;
      } else {
        const content = await readFile(filePath, 'utf8');
        if (content.length > 2_000_000) throw new Error(bt('dictionary.err.size_limit', { file }));
        let data: unknown;
        try { data = JSON.parse(content); } catch { throw new Error(bt('dictionary.err.invalid_json', { file })); }
        validated = validateEntries(data, file);
        /* 同一个文件里出现重复 JSON 键属于写错（JSON.parse 会静默保留最后一个），必须拦下；
           跨文件重复是分层覆盖，允许。 */
        const seen = new Set<string>();
        for (const match of content.matchAll(/("(?:[^"\\]|\\.)*")\s*:\s*("(?:[^"\\]|\\.)*")/g)) {
          const key = normalize(JSON.parse(match[1]!));
          if (seen.has(key)) throw new Error(bt('dictionary.err.duplicate_json_key', { file }));
          seen.add(key);
        }
        setLayerFileCacheEntry(filePath, { mtimeMs: st.mtimeMs, size: st.size, validated });
      }
      if(dir===userDir&&file==='个人覆盖.json')for(const key of Object.keys(validated))if(!decodeScopedKey(key))personalGlobals.add(key.toLowerCase());
      for (const [key, value] of Object.entries(validated)) {
        const previous = owner.get(key);
        if (previous && (previous.file !== file || previous.dir !== dir) && entries[key] !== value) {
          overrode.push({ key, from: previous.file, to: file });
        }
        sources[key] = `${dir === baseDir ? bt('dictionary.source.builtin') : bt('dictionary.source.personal')} · ${file}`;
        entries[key] = value;
        owner.set(key, { file, dir });
      }
      files.push(file);
    }
  }
  for(const key of Object.keys(entries)){const context=decodeScopedKey(key);if(context&&personalGlobals.has(context.key.toLowerCase())&&!sources[key]?.endsWith('个人覆盖.json')){delete entries[key];delete sources[key];}}
  const mergedRules = templateRuleByKey.size > 0 ? [...templateRuleByKey.values()] : undefined;
  return { dictionary: dictionaryFromEntries(entries, mergedRules), overrode, files, sources };
}

export async function resolveDictionaryForLocale(baseDir: string, locale: string): Promise<{ baseDir: string; hasTargetDictionary: boolean }> {
  const normalized = locale.trim();
  if (!normalized || normalized === 'en') {
    return { baseDir, hasTargetDictionary: false };
  }
  const localizedDir = join(baseDir, normalized);
  try {
    await access(join(localizedDir, 'base.json'));
    return { baseDir: localizedDir, hasTargetDictionary: true };
  } catch {
    if (normalized === 'zh-Hans' || normalized === 'zh') {
      return { baseDir, hasTargetDictionary: true };
    }
    return { baseDir, hasTargetDictionary: false };
  }
}

export async function loadDictionary(baseDir: string, userDir?: string,targetVersion?:string): Promise<Dictionary> {
  return (await loadDictionaryLayers(baseDir, userDir,targetVersion)).dictionary;
}

export class DictionaryStore extends EventEmitter {
  baseDir: string;
  current?: Dictionary;
  lastError?: string;
  sources: Record<string,string> = {};
  layerCounts: LayerCounts | null = null;
  private acceptLayers(layered:LayeredDictionary) {
    this.sources = layered.sources; const counts:LayerCounts = {builtin:0,incremental:0,personal:0};
    for(const source of Object.values(layered.sources)) counts[sourceCategory(source)]++;
    this.layerCounts = counts;
  }
  private watchers: FSWatcher[] = [];
  private timer?: NodeJS.Timeout;
  private closed = false;
  targetVersion?:string;
  /**
   * 切换目标版本并重载词典。**尝试过重载但失败时抛错并回滚 targetVersion**：
   * 调用方可以继续使用上一份有效词典，但不会把失败当成“已切换成功”，也不会静默拿到旧词典。
   * 版本未变化时不重载（启动时已用 fallback 降级的情况由 lastError + 'invalid' 事件上报，不在这里重复抛错，
   * 否则会破坏“损坏词典仍保持连接/最后有效词典”的既有恢复路径）。
   */
  async selectVersion(version:string):Promise<Dictionary>{
    const next=version==='fixture'?undefined:(version.match(/^(\d+\.\d+\.\d+)/)?.[1]??undefined);
    if(next===this.targetVersion){
      if(!this.current)throw new Error(bt('dictionary.err.not_ready'));
      return this.current;
    }
    const previous=this.targetVersion;
    this.targetVersion=next;
    await this.reload();
    if(this.lastError){
      /* 回滚到上一次成功的目标版本；失败由抛出的错误显式暴露，current/layerCounts 保持上一份有效值。 */
      this.targetVersion=previous;
      throw new Error(bt('dictionary.err.load_version_failed', { version, error: this.lastError }));
    }
    if(!this.current){this.targetVersion=previous;throw new Error(bt('dictionary.err.not_ready'));}
    return this.current;
  }
  /**
   * 不抛错的版本切换：显式返回 ok:false + error，同时给出仍可用的上一份有效词典。
   * 即便返回 ok:true，若当前词典仍处于降级状态也会带 `degraded` 原因，不会静默。
   */
  async selectVersionResult(version:string):Promise<
    | { ok:true; requestedVersion:string; targetVersion?:string; dictionary:Dictionary; degraded?:string }
    | { ok:false; requestedVersion:string; targetVersion?:string; error:string; dictionary:Dictionary }
  >{
    try{
      const dictionary=await this.selectVersion(version);
      return { ok:true, requestedVersion:version, targetVersion:this.targetVersion, dictionary, ...(this.lastError?{degraded:this.lastError}:{}) };
    }catch(error){
      if(!this.current)throw error; // 连上一份有效词典都没有时不能伪造成 ok:false 的“可降级”结果
      return { ok:false, requestedVersion:version, targetVersion:this.targetVersion, error:(error as Error).message, dictionary:this.current };
    }
  }
  /** 重载词典，失败时抛错（与只记录 lastError 的 reload() 并存，供需要显式失败语义的调用方使用）。 */
  async reloadStrict():Promise<void>{
    await this.reload();
    if(this.lastError)throw new Error(bt('dictionary.err.reload_failed', { error: this.lastError }));
  }
  private chain: Promise<void> = Promise.resolve();
  private sourceLocale = getActiveLocale();
  private started = false;
  constructor(baseDir: string, readonly userDir?: string) { super(); this.baseDir = baseDir; }
  private setupWatchers(): void {
    for (const watcher of this.watchers) {
      try { watcher.close(); } catch {}
    }
    this.watchers = [];
    if (this.closed) return;
    for (const dir of (this.userDir ? [this.baseDir, this.userDir] : [this.baseDir])) {
      const watcher = watch(dir, () => {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.reload(), 150);
      });
      watcher.on('error', () => this.emit('invalid', bt('dictionary.err.watcher_failed')));
      this.watchers.push(watcher);
    }
  }
  async setBaseDir(nextBaseDir: string): Promise<void> {
    const activeLocale = getActiveLocale();
    const dirChanged = nextBaseDir !== this.baseDir;
    if (!dirChanged && activeLocale === this.sourceLocale) return;
    this.baseDir = nextBaseDir;
    this.sourceLocale = activeLocale;
    if (dirChanged && this.started && !this.closed) {
      this.setupWatchers();
    }
    await this.reload();
  }
  async start(fallback?: Dictionary) {
    if (this.userDir) await migrateLegacyIncrementalDictionaries(this.userDir);
    try { const layered=await loadDictionaryLayers(this.baseDir,this.userDir,this.targetVersion); this.current=layered.dictionary; this.acceptLayers(layered); }
    catch (error) {
      if (!fallback) throw error;
      const validRules = fallback.templateRules ? validateTemplateRules(fallback.templateRules) : undefined;
      this.current = dictionaryFromEntries(
        validateEntries(fallback.entries, bt('dictionary.label.valid_cache')),
        validRules
      );
      this.lastError = (error as Error).message;
      const fakeSources: Record<string, string> = Object.create(null);
      for (const k of Object.keys(this.current.entries)) fakeSources[k] = bt('dictionary.source.cache_entry');
      this.acceptLayers({ dictionary: this.current, overrode: [], files: [bt('dictionary.source.cache_file')], sources: fakeSources });
    }
    this.started = true;
    this.setupWatchers();
    // Reconcile once after registering native watchers. macOS can coalesce the first rename
    // into directory-creation events before a fresh FSEvents watch is fully active.
    this.timer = setTimeout(() => void this.reload(), 150);
  }
  reload(): Promise<void> {
    this.chain = this.chain.then(async () => {
      if (this.closed) return;
      try {
        const layered = await loadDictionaryLayers(this.baseDir, this.userDir,this.targetVersion); const next=layered.dictionary;
        if(!this.closed)this.acceptLayers(layered);
        if (!this.closed && next.version !== this.current?.version) { this.current = next; this.emit('updated', next); }
        if (!this.closed) { this.lastError = undefined; this.emit('valid'); }
      } catch (error) { if (!this.closed) { this.lastError = (error as Error).message; this.emit('invalid', this.lastError); } }
    });
    return this.chain;
  }
  close() { this.closed = true; clearTimeout(this.timer); for (const watcher of this.watchers) watcher.close(); }
}
