import { readdir, lstat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import type { DataDirectoryName } from './application-target.js';
import { runUsageDbScanInWorker } from './sqlite-read.js';
import { ProtobufReader } from './protobuf.js';
import { USAGE_PROJECTION_VERSION } from './protobuf-projection.js';
import type { LedgerEvent } from './usage-ledger.js';
import {
  isFileCacheEntryReusable,
  resolveDatabaseModelFullName,
  type FileCacheEntry,
  type GenerationEvent,
  type TokenUsageSummary,
} from './usage-types.js';
import { bt } from './i18n.js';

export interface DiscoveredDbStat {
  dev: number;
  ino: number;
  birthtimeMs: number;
  mtimeMs: number;
  size: number;
  walMtimeMs: number;
  walSize: number;
  at: number;
}

export type UsageWorkerScanner = (
  req: { dbPath: string },
  signal?: AbortSignal
) => Promise<
  Awaited<ReturnType<typeof runUsageDbScanInWorker>> & {
    trajectoryType?: number;
    forkStepIndex?: number;
    forkParentCascadeId?: string;
  }
>;

export interface UsageScanContext {
  discoveredStats: Map<string, DiscoveredDbStat>;
  fileCache: Map<string, FileCacheEntry>;
  setFileCacheEntry: (dbPath: string, entry: FileCacheEntry) => void;
  markFileCacheDirty: () => void;
  lookupObservedContext: (timestampSec: number) => { id?: string; email?: string; account_type: 'consumer' | 'enterprise_vertex' | 'unknown' } | null;
  loadUsageLedger: () => Promise<void>;
  upsertLedger: (event: LedgerEvent) => void;
  getLedgerEvent: (eventKey: string) => LedgerEvent | undefined;
  scanDbWorker?: UsageWorkerScanner;
}

export interface StepLinkCandidate {
  timestamp: number;
  usage: Buffer | null;
  execution: Buffer | null;
}

interface TokenUsageTuple {
  input: number;
  output: number;
  cacheWrite: number;
  cached: number;
}

function extractTokenTuple(usage: Buffer | null): TokenUsageTuple | null {
  if (!usage || usage.length === 0) return null;
  const input = ProtobufReader.findVarint(usage, 2) ?? 0;
  const output = ProtobufReader.findVarint(usage, 3) ?? 0;
  const cacheWrite = ProtobufReader.findVarint(usage, 4) ?? 0;
  const cached = ProtobufReader.findVarint(usage, 5) ?? 0;
  if (
    !Number.isSafeInteger(input) || input < 0 ||
    !Number.isSafeInteger(output) || output < 0 ||
    !Number.isSafeInteger(cacheWrite) || cacheWrite < 0 ||
    !Number.isSafeInteger(cached) || cached < 0
  ) {
    return null;
  }
  return { input, output, cacheWrite, cached };
}

function tokenTuplesEqual(a: TokenUsageTuple | null, b: TokenUsageTuple | null): boolean {
  return Boolean(
    a && b &&
    a.input === b.input &&
    a.output === b.output &&
    a.cacheWrite === b.cacheWrite &&
    a.cached === b.cached
  );
}

/**
 * Resolve a generation timestamp from linked step metadata rows.
 * Primary: exact single-step execution + raw usage byte equality.
 * Secondary fallback: when linked contains extra non-matching/zero-timestamp steps or usage protobuf
 * adds new fields, match uniquely by executionId byte equality + token 4-tuple (f2/f3/f4/f5) equality.
 */
export function resolveLinkedStepTimestamp(
  linked: readonly StepLinkCandidate[],
  execution: Buffer | null,
  usage: Buffer | null
): number {
  if (!execution || !usage || linked.length === 0) return 0;
  if (
    linked.length === 1 &&
    linked[0]!.timestamp > 0 &&
    linked[0]!.execution?.equals(execution) &&
    linked[0]!.usage?.equals(usage)
  ) {
    return linked[0]!.timestamp;
  }
  // Multi-step exact match fallback (requires a single unambiguous valid step)
  const exactMatches = linked.filter(
    (step) => step.timestamp > 0 && step.execution?.equals(execution) && step.usage?.equals(usage)
  );
  if (exactMatches.length === 1) {
    return exactMatches[0]!.timestamp;
  }
  if (exactMatches.length > 1) {
    return 0;
  }
  // Protobuf field-evolution fallback: executionId + token 4-tuple (f2/f3/f4/f5) equality (single unambiguous valid step)
  const targetTuple = extractTokenTuple(usage);
  if (!targetTuple) return 0;
  const tupleMatches = linked.filter(
    (step) =>
      step.timestamp > 0 &&
      step.execution?.equals(execution) &&
      tokenTuplesEqual(extractTokenTuple(step.usage), targetTuple)
  );
  if (tupleMatches.length === 1) {
    return tupleMatches[0]!.timestamp;
  }
  return 0;
}

export async function discoverDatabaseFiles(
  geminiDir: string,
  dataDirectoryNames: readonly DataDirectoryName[],
  discoveredStats: Map<string, DiscoveredDbStat>,
  maxFiles = Number.POSITIVE_INFINITY
): Promise<{
  paths: string[];
  errors: NonNullable<TokenUsageSummary['database_diagnostics']>;
  discoveredCount: number;
}> {
  const errors: NonNullable<TokenUsageSummary['database_diagnostics']> = [];
  const issue = (path: string, error: unknown) => errors.push({
    id: createHash('sha256').update(path).digest('hex').slice(0, 10),
    state: 'discovery_failed',
    category: (error as NodeJS.ErrnoException).code === 'EACCES' ? bt('scanner.err.access_denied') : bt('scanner.err.discovery_failed'),
  });
  const list: { path: string; mtime: number }[] = [];
  const now = Date.now();
  discoveredStats.clear();
  const allowedDirs = new Set<string>(dataDirectoryNames);
  try {
    const entries = await readdir(geminiDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !allowedDirs.has(entry.name)) continue;
      const convDir = join(geminiDir, entry.name, 'conversations');
      try {
        const convFiles = await readdir(convDir);
        const fileSet = new Set(convFiles);
        const dbFiles = convFiles.filter(f => f.endsWith('.db'));
        const batchSize = 32;
        for (let i = 0; i < dbFiles.length; i += batchSize) {
          const slice = dbFiles.slice(i, i + batchSize);
          await Promise.all(slice.map(async file => {
            const fullPath = join(convDir, file);
            try {
              const st = await lstat(fullPath);
              if (!st.isFile() || st.isSymbolicLink()) return;
              const wal = fileSet.has(file + '-wal') ? await lstat(fullPath + '-wal').catch(() => null) : null;
              const walMtimeMs = wal?.mtimeMs ?? 0;
              const walSize = wal?.size ?? 0;
              discoveredStats.set(fullPath, {
                dev: st.dev,
                ino: st.ino,
                birthtimeMs: st.birthtimeMs,
                mtimeMs: st.mtimeMs,
                size: st.size,
                walMtimeMs,
                walSize,
                at: now,
              });
              list.push({ path: fullPath, mtime: Math.max(st.mtimeMs, walMtimeMs) });
            } catch (error) { issue(fullPath, error); }
          }));
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') issue(convDir, error); }
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') issue(geminiDir, error); }

  // 检查归档库
  for (const dirName of dataDirectoryNames) {
    const archivePath = join(geminiDir, dirName, 'token_usage_archive.db');
    try {
      const st = await lstat(archivePath);
      if (st.isFile() && !st.isSymbolicLink()) {
        discoveredStats.set(archivePath, {
          dev: st.dev,
          ino: st.ino,
          birthtimeMs: st.birthtimeMs,
          mtimeMs: st.mtimeMs,
          size: st.size,
          walMtimeMs: 0,
          walSize: 0,
          at: now,
        });
        list.push({ path: archivePath, mtime: st.mtimeMs });
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR') issue(archivePath, error); }
  }

  list.sort((a, b) => b.mtime - a.mtime);
  return { paths: list.slice(0, maxFiles).map(x => x.path), errors, discoveredCount: list.length };
}

export function isTransientSqliteReadError(message = ''): boolean {
  return /跨批读取期间变化|changed across batches|busy|locked|no such table|连接已关闭|connection closed|超出单批预算|exceeded batch budget|unable to open/i.test(message);
}

export async function isInitializingOrRemovedDb(dbPath: string, errorMessage = ''): Promise<boolean> {
  const stat = await lstat(dbPath).catch((err: NodeJS.ErrnoException) => (err?.code === 'ENOENT' ? null : undefined));
  if (stat === null) return true;
  if (stat && /no such table/i.test(errorMessage) && (stat.size <= 4096 || Date.now() - stat.mtimeMs < 60_000)) {
    return true;
  }
  return false;
}

export async function scanDatabaseEvents(ctx: UsageScanContext, dbPath: string, bypassCache = false, signal?: AbortSignal): Promise<{
  events: GenerationEvent[];
  generationsScanned: number;
  skippedLargeRecords: number;
  excludedForkedGenIndices?: number[];
  hasError?: boolean;
  error?: string;
  usedCached?: boolean;
  cacheHit?: boolean;
}> {
  let lastResult = await scanDatabaseEventsOnce(ctx, dbPath, bypassCache, signal);
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (!lastResult.hasError || signal?.aborted || !isTransientSqliteReadError(lastResult.error)) break;
    await new Promise(resolve => setTimeout(resolve, attempt * 100));
    if (signal?.aborted) break;
    lastResult = await scanDatabaseEventsOnce(ctx, dbPath, true, signal);
  }
  if (!lastResult.hasError && lastResult.changedDuringScan && !signal?.aborted) {
    lastResult = await scanDatabaseEventsOnce(ctx, dbPath, true, signal);
  }
  if (lastResult.hasError && !signal?.aborted && await isInitializingOrRemovedDb(dbPath, lastResult.error)) {
    const cached = ctx.fileCache.get(dbPath);
    return {
      events: cached?.events ?? [],
      generationsScanned: cached?.generationsScanned ?? 0,
      skippedLargeRecords: cached?.skippedLargeRecords ?? 0,
      hasError: false,
      usedCached: Boolean(cached),
    };
  }
  return lastResult;
}

async function scanDatabaseEventsOnce(ctx: UsageScanContext, dbPath: string, bypassCache = false, signal?: AbortSignal): Promise<{
  events: GenerationEvent[];
  generationsScanned: number;
  skippedLargeRecords: number;
  excludedForkedGenIndices?: number[];
  hasError?: boolean;
  error?: string;
  usedCached?: boolean;
  cacheHit?: boolean;
  changedDuringScan?: boolean;
}> {
  let fileStat: { dev: number; ino: number; birthtimeMs: number; mtimeMs: number; size: number } | null = null;
  let walMtimeMs = 0;
  let walSize = 0;
  let sourceId = '';
  try {
    const preStat = ctx.discoveredStats.get(dbPath);
    ctx.discoveredStats.delete(dbPath);
    if (preStat && Date.now() - preStat.at < 2000) {
      fileStat = {
        dev: preStat.dev,
        ino: preStat.ino,
        birthtimeMs: preStat.birthtimeMs,
        mtimeMs: preStat.mtimeMs,
        size: preStat.size,
      };
      walMtimeMs = preStat.walMtimeMs;
      walSize = preStat.walSize;
    } else {
      const st = await lstat(dbPath);
      fileStat = {
        dev: st.dev,
        ino: st.ino,
        birthtimeMs: st.birthtimeMs,
        mtimeMs: st.mtimeMs,
        size: st.size,
      };
      const walStat = await lstat(`${dbPath}-wal`).catch(() => null);
      walMtimeMs = walStat?.mtimeMs ?? 0;
      walSize = walStat?.size ?? 0;
    }
    sourceId = createHash('sha256').update(JSON.stringify([basename(dbPath), fileStat.ino, fileStat.birthtimeMs])).digest('hex');
    if (!bypassCache) {
      const cached = ctx.fileCache.get(dbPath);
      if (
        cached &&
        isFileCacheEntryReusable(cached) &&
        cached.events.every(event => event.source_id === sourceId) &&
        cached.mtimeMs === fileStat.mtimeMs &&
        cached.size === fileStat.size &&
        cached.walMtimeMs === walMtimeMs &&
        cached.walSize === walSize
      ) {
        return {
          events: cached.events,
          generationsScanned: cached.generationsScanned,
          skippedLargeRecords: cached.skippedLargeRecords,
          hasError: cached.hasError ?? false, error: cached.error,
          cacheHit: true,
        };
      }
    }
  } catch {
    // ignore
  }

  const workerScan = await (ctx.scanDbWorker ?? runUsageDbScanInWorker)({ dbPath }, signal);
  if (!workerScan.ok) {
    const cached = ctx.fileCache.get(dbPath);
    const errText = workerScan.changedDuringRead ? bt('scanner.err.changed_across_batches') : workerScan.error;
    if (cached) {
      return {
        events: cached.events,
        generationsScanned: cached.generationsScanned,
        skippedLargeRecords: cached.skippedLargeRecords,
        hasError: true,
        error: errText,
        usedCached: true,
      };
    }
    return {
      events: [],
      generationsScanned: 0,
      skippedLargeRecords: 0,
      hasError: true,
      error: errText,
    };
  }

  if (workerScan.countExceeded !== undefined) {
    const cached = ctx.fileCache.get(dbPath);
    return {
      events: cached?.events ?? [],
      generationsScanned: 0,
      skippedLargeRecords: workerScan.countExceeded,
      hasError: true,
      usedCached: !!cached,
      error: bt('scanner.err.batch_budget_exceeded'),
    };
  }

  const events: GenerationEvent[] = [];
  let generationsScanned = 0;
  let skippedLargeRecords = 0;
  if (workerScan.genRows.length === 0) {
    const afterEmpty = await lstat(dbPath).catch(() => null);
    if (!afterEmpty || afterEmpty.dev !== fileStat?.dev || afterEmpty.ino !== fileStat?.ino) {
      const previous = ctx.fileCache.get(dbPath);
      return {
        events: previous?.events ?? [],
        generationsScanned: 0,
        skippedLargeRecords: 0,
        hasError: true,
        usedCached: !!previous,
        error: bt('scanner.err.changed_across_batches'),
      };
    }
    if (fileStat) {
      ctx.setFileCacheEntry(dbPath, {
        mtimeMs: fileStat.mtimeMs,
        size: fileStat.size,
        walMtimeMs,
        walSize,
        events: [],
        generationsScanned: 0,
        skippedLargeRecords: 0,
        projectionVersion: USAGE_PROJECTION_VERSION,
        hasError: false,
        lastSuccessAt: Math.floor(Date.now() / 1000),
      });
      ctx.markFileCacheDirty();
    }
    return { events: [], generationsScanned: 0, skippedLargeRecords: 0, hasError: false };
  }

  const forkScan = workerScan as {
    trajectoryType?: number;
    forkStepIndex?: number;
    forkParentCascadeId?: string;
  };
  const hasForkCutoff =
    typeof forkScan.forkParentCascadeId === 'string' &&
    forkScan.forkParentCascadeId.trim().length > 0 &&
    typeof forkScan.forkStepIndex === 'number' &&
    Number.isSafeInteger(forkScan.forkStepIndex) &&
    forkScan.forkStepIndex >= 0;
  const forkStepIndex = hasForkCutoff ? forkScan.forkStepIndex! : -1;
  const excludedForkedGenIndices: number[] = [];

  const validTimestamp = (value: number) => Number.isSafeInteger(value) && value >= 946684800 && value <= Date.now() / 1000 + 86400;
  const siblingModelIds = new Set<string>();
  for (const row of workerScan.genRows) {
    if (!row.data_blob || (row.size > 16 * 1024 * 1024 && !row.projected)) continue;
    const blob = Buffer.from(row.data_blob.buffer, row.data_blob.byteOffset, row.data_blob.byteLength);
    const wrapped = ProtobufReader.findField(blob, 1);
    if (!wrapped) continue;
    const mid = ProtobufReader.findString(wrapped, 19);
    if (mid && mid.trim()) siblingModelIds.add(mid.trim());
  }
  const pendingStepLinks: { event: GenerationEvent; indices: number[]; execution: Buffer | null; usage: Buffer }[] = [];
  for (const row of workerScan.genRows) {
    generationsScanned++;
    if (row.size > 16 * 1024 * 1024 && !row.projected) {
      skippedLargeRecords++;
      continue;
    }
    if (!row.data_blob) continue;

    const blob = Buffer.from(row.data_blob.buffer, row.data_blob.byteOffset, row.data_blob.byteLength);
    let stepIndices: number[] | null | undefined;
    if (hasForkCutoff) {
      stepIndices = ProtobufReader.stepIndices(blob);
      if (stepIndices !== null && stepIndices.length > 0 && stepIndices.every(i => i <= forkStepIndex)) {
        const genIdx = Number(row.idx);
        if (Number.isSafeInteger(genIdx) && genIdx >= 0) {
          excludedForkedGenIndices.push(genIdx);
        }
        continue;
      }
    }
    const wrapped = ProtobufReader.findField(blob, 1);
    if (!wrapped) continue;

    const modelId = ProtobufReader.findString(wrapped, 19);
    const label = ProtobufReader.findString(wrapped, 21);
    const usage = ProtobufReader.findField(wrapped, 4);

    if (!usage) continue;
    const cacheWriteTokens = ProtobufReader.findVarint(usage, 4) ?? 0;
    const rawInput = ProtobufReader.findVarint(usage, 2) ?? 0;
    const outputTokens = ProtobufReader.findVarint(usage, 3) ?? 0;
    const cachedTokens = ProtobufReader.findVarint(usage, 5) ?? 0;
    const isValidTokenField = (v: number): boolean => Number.isSafeInteger(v) && v >= 0;
    if (
      !isValidTokenField(cacheWriteTokens) ||
      !isValidTokenField(rawInput) ||
      !isValidTokenField(outputTokens) ||
      !isValidTokenField(cachedTokens)
    ) {
      continue;
    }
    const inputTokens = rawInput;
    const totalTokens = inputTokens + cachedTokens + cacheWriteTokens + outputTokens;

    if (!Number.isSafeInteger(totalTokens) || totalTokens <= 0) continue;

    let timestamp = 0;
    const timingBuf = ProtobufReader.findField(wrapped, 9);
    if (timingBuf) {
      const innerTiming = ProtobufReader.findField(timingBuf, 4);
      if (innerTiming) {
        timestamp = ProtobufReader.findVarint(innerTiming, 1) ?? 0;
      }
    }
    if (!validTimestamp(timestamp)) timestamp = 0;

    const modelEnum = ProtobufReader.findVarint(wrapped, 3) ?? ProtobufReader.findVarint(usage, 1) ?? null;
    const assignedModel = resolveDatabaseModelFullName(modelId, label, modelEnum, {
      canonicalUnknown: true,
      ...(siblingModelIds.size > 0 ? { siblingModelIds } : {}),
    });
    const lockModelKey = modelId || label || '未知模型';

    const observedCtx = ctx.lookupObservedContext(timestamp);
    const canAttributeToCurrent = Boolean(observedCtx);
    const accountId = observedCtx?.id;
    const accountEmail = observedCtx?.email;
    const accountType = canAttributeToCurrent ? (observedCtx?.account_type ?? 'unknown') : undefined;
    const execution = ProtobufReader.findField(blob, 4)?.toString('hex') ?? '';
    const legacyKey = createHash('sha256').update(JSON.stringify([
      basename(dbPath), row.idx, execution || undefined, lockModelKey, rawInput, cachedTokens, cacheWriteTokens, outputTokens,
    ])).digest('hex');
    const eventObj: GenerationEvent = {
      event_key: createHash('sha256').update(JSON.stringify([
        sourceId, row.idx, execution,
      ])).digest('hex'),
      source_id: sourceId, generation_index: Number(row.idx), legacy_event_key: legacyKey,
      account_confidence: canAttributeToCurrent ? 'observed' : 'unknown',
      model: assignedModel,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cached_tokens: cachedTokens,
      ...(cacheWriteTokens > 0 ? { cache_write_tokens: cacheWriteTokens } : {}),
      total_tokens: totalTokens,
      timestamp_seconds: timestamp,
      ...(accountId ? { account_id: accountId, account_email: accountEmail } : (accountEmail ? { account_email: accountEmail } : {})),
      ...(accountType ? { account_type: accountType } : {}),
    };
    if (timestamp === 0) {
      const indices = stepIndices !== undefined ? stepIndices : ProtobufReader.stepIndices(blob);
      if (indices !== null) {
        pendingStepLinks.push({ event: eventObj, indices, execution: ProtobufReader.findField(blob, 4), usage });
      }
    }
    events.push(eventObj);
  }

  let stepOk = true;
  if (events.some(event => event.timestamp_seconds <= 0)) {
    stepOk = workerScan.stepSchemaOk;
    if (stepOk && pendingStepLinks.length > 0) {
      const stepTimes = new Map<number, { timestamp: number; usage: Buffer | null; execution: Buffer | null }>();
      for (const row of workerScan.stepRows) {
        if (row.size > 16 * 1024 * 1024 && !row.projected) {
          skippedLargeRecords++;
          continue;
        }
        if (!row.data_blob) continue;
        const metaBuf = Buffer.from(row.data_blob.buffer, row.data_blob.byteOffset, row.data_blob.byteLength);
        const tsBuf = ProtobufReader.findField(metaBuf, 1);
        const rawTime = tsBuf ? ProtobufReader.findVarint(tsBuf, 1) ?? 0 : 0;
        const timestamp = validTimestamp(rawTime) ? rawTime : 0;
        stepTimes.set(Number(row.idx), { timestamp, usage: ProtobufReader.findField(metaBuf, 9), execution: ProtobufReader.findField(metaBuf, 12) });
      }
      for (const item of pendingStepLinks) {
        const linked = item.indices.map(idx => stepTimes.get(idx)).filter((step): step is NonNullable<typeof step> => !!step);
        const linkedTs = resolveLinkedStepTimestamp(linked, item.execution, item.usage);
        if (linkedTs > 0) {
          item.event.timestamp_seconds = linkedTs;
          const obs = ctx.lookupObservedContext(item.event.timestamp_seconds);
          if (obs) {
            item.event.account_id = obs.id;
            item.event.account_email = obs.email;
            item.event.account_type = obs.account_type;
            item.event.account_confidence = 'observed';
          }
        }
      }
    }
  }

  const after = await lstat(dbPath).catch(() => null);
  const afterWal = await lstat(`${dbPath}-wal`).catch(() => null);
  if (!after || after.dev !== fileStat?.dev || after.ino !== fileStat?.ino) {
    const previous = ctx.fileCache.get(dbPath);
    return {
      events: previous?.events ?? events,
      generationsScanned,
      skippedLargeRecords,
      hasError: true,
      usedCached: !!previous,
      error: bt('scanner.err.changed_across_batches'),
    };
  }
  const observedAt = performance.timeOrigin + performance.now();
  for (const event of events) event.source_observed_at = observedAt;
  await ctx.loadUsageLedger();
  for (const event of events) {
    ctx.upsertLedger({ ...event, db_file: basename(dbPath) });
    Object.assign(event, ctx.getLedgerEvent(event.event_key!));
  }
  const unknownTime = events.some(event => event.timestamp_seconds <= 0);
  const hasError = !stepOk && unknownTime;
  const timeError = hasError ? bt('scanner.err.timestamp_read_failed') : undefined;
  const changedDuringScan = Boolean(
    fileStat && (
      after.mtimeMs !== fileStat.mtimeMs ||
      after.size !== fileStat.size ||
      (afterWal?.mtimeMs ?? 0) !== walMtimeMs ||
      (afterWal?.size ?? 0) !== walSize
    )
  );
  if (changedDuringScan) {
    // Do not bind a snapshot read before/during a WAL append to the newer file fingerprint.
    ctx.fileCache.delete(dbPath);
  } else {
    ctx.setFileCacheEntry(dbPath, {
      mtimeMs: after.mtimeMs,
      size: after.size,
      walMtimeMs: afterWal?.mtimeMs ?? 0,
      walSize: afterWal?.size ?? 0,
      events,
      generationsScanned,
      skippedLargeRecords,
      projectionVersion: USAGE_PROJECTION_VERSION,
      hasError,
      error: timeError,
      lastSuccessAt: hasError ? ctx.fileCache.get(dbPath)?.lastSuccessAt : Math.floor(Date.now() / 1000),
    });
    if (!hasError) ctx.markFileCacheDirty();
  }

  return {
    events,
    generationsScanned,
    skippedLargeRecords,
    ...(excludedForkedGenIndices.length > 0 ? { excludedForkedGenIndices } : {}),
    hasError,
    error: timeError,
    ...(changedDuringScan ? { changedDuringScan: true } : {}),
  };
}
