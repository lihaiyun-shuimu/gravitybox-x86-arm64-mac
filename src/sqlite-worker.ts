import { DatabaseSync } from 'node:sqlite';
import { createHash, type Hash } from 'node:crypto';
import { basename } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { bt, setActiveLocale } from './i18n.js';
import { decodeVarint64, skipProtobufField } from './protobuf.js';
import {
  projectProtobuf,
  GENERATION_PROJECTION,
  STEP_PROJECTION,
  USAGE_PROTO_LIMITS,
  HUD_GEN_PROTO_LIMITS,
  HUD_STEP_METADATA_PROJECTION,
  HUD_STEP_METADATA_MINIMAL_PROJECTION,
  HUD_STEP_RENDER_INFO_PROJECTION,
  HUD_GEN_METADATA_PROJECTION,
  HUD_EXECUTOR_METADATA_PROJECTION,
} from './protobuf-projection.js';

export interface HudWorkerScanRequest {
  dbPath: string;
  inlineBlobLimitBytes: number;
  selfCascadeIdHint?: string;
  knownColumns?: {
    hasDataColumn: boolean;
    hasRenderInfoColumn: boolean;
    hasStepPayloadColumn: boolean;
  };
  cachedTrajectoryId?: string;
  prevParentMetaDigest?: string;
  prevExecutorMetaDigest?: string;
  prevStepPrefixCutoffIdx?: number;
  prevStepPrefixDigest?: string;
  prevGenDigest?: string;
  prevGenPrefixCutoffIdx?: number;
  prevGenPrefixDigest?: string;
}

export interface HudWorkerRawStepRow {
  idx: number;
  step_type: number;
  status: number;
  metadata: Uint8Array | null;
  metadata_len: number;
  data?: Uint8Array | null;
  render_info?: Uint8Array | null;
  render_info_len?: number;
  step_payload?: Uint8Array | null;
}

export interface HudWorkerScanResult {
  hasDataColumn: boolean;
  hasRenderInfoColumn: boolean;
  hasStepPayloadColumn: boolean;
  hasTrajectoryMeta: boolean;
  hasParentMetadataBlob: boolean;
  parentMetaReadError: boolean;
  parentMetaUnchanged: boolean;
  parentMetaDigest: string;
  executorMetaUnchanged?: boolean;
  executorMetaDigest?: string;
  executorMetaBlob?: Uint8Array | null;
  trajectoryId?: string;
  cascadeId?: string;
  trajectoryType?: number;
  forkStepIndex?: number;
  forkParentCascadeId?: string;
  metaBlobProjectedSlices: Uint8Array[];
  maxIdx: number;
  stepsMode: 'full' | 'append';
  stepPrefixCutoffIdx: number;
  stepPrefixDigest: string;
  appendedSteps: HudWorkerRawStepRow[];
  genMode: 'full' | 'append' | 'unchanged';
  lastGenIdx: number;
  genDigest: string;
  genPrefixCutoffIdx: number;
  genPrefixDigest: string;
  genBlobs: Array<{ idx: number; data: Uint8Array }>;
}

const TERMINAL_STEP_STATUSES = new Set([3, 5]);
// SQLite 的 substr(blob, start, len) 每次调用都会经由 OP_Column 物化整列 BLOB；
// 对含大量重复分块的中等 BLOB（<=64MB），在连续 chunk 读取超过阈值后只物化一次并用 subarray 零拷贝切片，
// 避免百次内存分配与页错误开销，同时保持超大 BLOB（>64MB）的内存有界性。
const MAX_MATERIALIZED_BLOB_BYTES = 64 * 1024 * 1024;
const SUBSTR_FALLBACK_CALL_THRESHOLD = 3;

export function createSqlBlobChunkReader(
  size: number,
  key: number | string,
  getSubstrStmt: () => { get(...args: any[]): unknown },
  getFullStmt: () => { get(...args: any[]): unknown }
): (offset: number, length: number) => Uint8Array {
  let calls = 0;
  let fullBlob: Uint8Array | null | undefined;
  return (offset: number, length: number): Uint8Array => {
    calls += 1;
    if (fullBlob === undefined && calls > SUBSTR_FALLBACK_CALL_THRESHOLD && size <= MAX_MATERIALIZED_BLOB_BYTES) {
      const row = getFullStmt().get(key) as { data?: Uint8Array | null } | undefined;
      fullBlob = row?.data instanceof Uint8Array ? row.data : null;
    }
    if (fullBlob) {
      return fullBlob.subarray(offset, offset + length);
    }
    return ((getSubstrStmt().get(offset + 1, length, key) as { chunk?: Uint8Array } | undefined)?.chunk) ?? new Uint8Array(0);
  };
}

function hashRawStepRow(hash: Hash, r: any): void {
  hash.update(`${r.idx}:${r.step_type}:${r.status}:${r.metadata_len ?? 0}:`);
  if (r.metadata && r.metadata.byteLength > 0) {
    hash.update(r.metadata);
  } else {
    if (r.metadata_head && r.metadata_head.byteLength > 0) hash.update(r.metadata_head);
    if (r.metadata_tail && r.metadata_tail.byteLength > 0) hash.update(r.metadata_tail);
  }
  hash.update(`:${r.data?.byteLength ?? 0}:`);
  if (r.data && r.data.byteLength > 0) hash.update(r.data);
  hash.update(`:${r.render_info_len ?? r.render_info?.byteLength ?? 0}:`);
  if (r.render_info && r.render_info.byteLength > 0) {
    hash.update(r.render_info);
  } else {
    if (r.render_info_head && r.render_info_head.byteLength > 0) hash.update(r.render_info_head);
    if (r.render_info_tail && r.render_info_tail.byteLength > 0) hash.update(r.render_info_tail);
  }
  hash.update(`:${r.step_payload?.byteLength ?? 0}:`);
  if (r.step_payload && r.step_payload.byteLength > 0) hash.update(r.step_payload);
  hash.update('\n');
}

const MAX_PROJECTED_GEN_CACHE_ENTRIES = 128;
const projectedGenBlobCache = new Map<string, Uint8Array | null>();

function getCachedProjectedGenBlob(cacheKey: string): Uint8Array | null | undefined {
  if (!projectedGenBlobCache.has(cacheKey)) return undefined;
  const val = projectedGenBlobCache.get(cacheKey)!;
  projectedGenBlobCache.delete(cacheKey);
  projectedGenBlobCache.set(cacheKey, val);
  return val;
}

function setCachedProjectedGenBlob(cacheKey: string, value: Uint8Array | null): void {
  if (projectedGenBlobCache.has(cacheKey)) {
    projectedGenBlobCache.delete(cacheKey);
  }
  projectedGenBlobCache.set(cacheKey, value);
  while (projectedGenBlobCache.size > MAX_PROJECTED_GEN_CACHE_ENTRIES) {
    const oldest = projectedGenBlobCache.keys().next().value;
    if (oldest === undefined) break;
    projectedGenBlobCache.delete(oldest);
  }
}

function hashRawGenRowMeta(
  hash: Hash,
  idx: number,
  dataLen: number,
  inlineData: Uint8Array | null | undefined,
  dataHead?: Uint8Array | null,
  dataTail?: Uint8Array | null
): void {
  hash.update(`${idx}:${dataLen}:`);
  if (inlineData && inlineData.byteLength > 0) {
    hash.update(inlineData);
  } else {
    if (dataHead && dataHead.byteLength > 0) hash.update(dataHead);
    if (dataTail && dataTail.byteLength > 0) hash.update(dataTail);
  }
  hash.update('\n');
}

const EXACT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_VALID_FORK_STEP_INDEX = 10_000_000;

export interface ForkParentMetadata {
  trajectoryId?: string;
  cascadeId?: string;
  trajectoryType?: number;
  forkStepIndex?: number;
  forkParentCascadeId?: string;
}

function readVarint64Strict(buf: Uint8Array, cursor: { pos: number }): bigint | null {
  let result = 0n;
  let shift = 0n;
  while (cursor.pos < buf.length && shift <= 63n) {
    const b = BigInt(buf[cursor.pos++]!);
    result |= (b & 0x7fn) << shift;
    shift += 7n;
    if ((b & 0x80n) === 0n) {
      return result;
    }
  }
  cursor.pos = buf.length;
  return null;
}

function parseParentReferenceBlob(buf: Uint8Array): {
  parentTrajectoryId?: string;
  forkStepIndex?: number;
  referenceType?: number;
  parentCascadeId?: string;
} | null {
  if (!buf || buf.byteLength === 0) return null;
  const cursor = { pos: 0 };
  let parentTrajectoryId: string | undefined;
  let forkStepIndex: number | undefined;
  let forkStepIndexInvalid = false;
  let referenceType: number | undefined;
  let parentCascadeId: string | undefined;

  while (cursor.pos < buf.length) {
    const tagVal = readVarint64Strict(buf, cursor);
    if (tagVal === null || tagVal === 0n || tagVal > 0xffffffffn) return null;
    const tag = Number(tagVal);
    const fieldNum = tag >>> 3;
    const wireType = tag & 0x07;
    if (fieldNum < 1 || fieldNum > 16384) return null;

    if (wireType === 0) {
      const val = readVarint64Strict(buf, cursor);
      if (val === null) return null;
      if (fieldNum === 2) {
        if (val >= 0n && val < BigInt(MAX_VALID_FORK_STEP_INDEX)) {
          const n = Number(val);
          if (Number.isSafeInteger(n) && n >= 0 && n < MAX_VALID_FORK_STEP_INDEX) {
            forkStepIndex = n;
          } else {
            forkStepIndexInvalid = true;
          }
        } else {
          forkStepIndexInvalid = true;
        }
      } else if (fieldNum === 5) {
        if (val >= 0n && val <= 0x7fffffffn) {
          referenceType = Number(val);
        }
      }
    } else if (wireType === 2) {
      const lenVal = readVarint64Strict(buf, cursor);
      if (lenVal === null || lenVal < 0n || lenVal > BigInt(buf.length - cursor.pos)) return null;
      const len = Number(lenVal);
      const slice = buf.subarray(cursor.pos, cursor.pos + len);
      cursor.pos += len;
      if (fieldNum === 1) {
        parentTrajectoryId = Buffer.from(slice).toString('utf8').trim().toLowerCase();
      } else if (fieldNum === 6) {
        parentCascadeId = Buffer.from(slice).toString('utf8').trim().toLowerCase();
      }
    } else if (wireType === 1 || wireType === 5) {
      if (!skipProtobufField(buf, cursor, wireType)) return null;
    } else {
      return null;
    }
  }

  if (cursor.pos !== buf.length || forkStepIndexInvalid) return null;
  return {
    parentTrajectoryId,
    forkStepIndex,
    referenceType,
    parentCascadeId,
  };
}

export function readForkParentMetadata(
  db: DatabaseSync,
  selfCascadeIdHint?: string
): ForkParentMetadata {
  const out: ForkParentMetadata = {};
  const selfIds = new Set<string>();
  const cleanHint = typeof selfCascadeIdHint === 'string' ? selfCascadeIdHint.trim().toLowerCase() : '';
  if (cleanHint) selfIds.add(cleanHint);

  let hasParentReferencesTable = false;
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('trajectory_meta', 'parent_references')")
      .all() as Array<{ name?: unknown }>;
    const tableSet = new Set(tables.map(t => String(t.name ?? '')));
    hasParentReferencesTable = tableSet.has('parent_references');

    if (tableSet.has('trajectory_meta')) {
      const tmCols = new Set(
        (db.prepare('PRAGMA table_info(trajectory_meta)').all() as Array<{ name?: unknown }>).map(c => String(c.name ?? ''))
      );
      const selectCols = ['trajectory_id', 'cascade_id', 'trajectory_type'].filter(c => tmCols.has(c));
      if (selectCols.length > 0) {
        const tm = db
          .prepare(`SELECT ${selectCols.join(', ')} FROM trajectory_meta LIMIT 1`)
          .get() as { trajectory_id?: unknown; cascade_id?: unknown; trajectory_type?: unknown } | undefined;
        if (tm) {
          if (typeof tm.trajectory_id === 'string' && tm.trajectory_id.trim()) {
            out.trajectoryId = tm.trajectory_id.trim().toLowerCase();
            selfIds.add(out.trajectoryId);
          }
          if (typeof tm.cascade_id === 'string' && tm.cascade_id.trim()) {
            out.cascadeId = tm.cascade_id.trim().toLowerCase();
            selfIds.add(out.cascadeId);
          }
          if (tm.trajectory_type !== null && tm.trajectory_type !== undefined) {
            const tt = Number(tm.trajectory_type);
            if (Number.isSafeInteger(tt)) {
              out.trajectoryType = tt;
            }
          }
        }
      }
    }
  } catch {
    return out;
  }

  if (!hasParentReferencesTable) {
    return out;
  }

  try {
    const prCols = new Set(
      (db.prepare('PRAGMA table_info(parent_references)').all() as Array<{ name?: unknown }>).map(c => String(c.name ?? ''))
    );
    if (!prCols.has('data')) return out;
    const orderSql = prCols.has('idx') ? ' ORDER BY idx ASC' : '';
    const rows = db
      .prepare(`SELECT data FROM parent_references WHERE data IS NOT NULL${orderSql}`)
      .all() as Array<{ data?: unknown }>;

    let bestForkStepIndex: number | undefined;
    let bestParentCascadeId: string | undefined;

    for (const row of rows) {
      if (!(row.data instanceof Uint8Array) || row.data.byteLength === 0) continue;
      const parsed = parseParentReferenceBlob(row.data);
      if (!parsed) continue;
      const { parentCascadeId, forkStepIndex } = parsed;
      if (!parentCascadeId || !EXACT_UUID_RE.test(parentCascadeId)) continue;
      if (selfIds.has(parentCascadeId)) continue;
      if (
        forkStepIndex === undefined ||
        !Number.isSafeInteger(forkStepIndex) ||
        forkStepIndex < 0 ||
        forkStepIndex >= MAX_VALID_FORK_STEP_INDEX
      ) {
        continue;
      }
      if (bestForkStepIndex === undefined || forkStepIndex > bestForkStepIndex) {
        bestForkStepIndex = forkStepIndex;
        bestParentCascadeId = parentCascadeId;
      }
    }

    if (bestForkStepIndex !== undefined && bestParentCascadeId) {
      out.forkStepIndex = bestForkStepIndex;
      out.forkParentCascadeId = bestParentCascadeId;
    }
  } catch {
    // ignore corrupted or unreadable parent_references
  }

  return out;
}

function executeHudScan(req: HudWorkerScanRequest): { result: HudWorkerScanResult; transfers: ArrayBuffer[] } {
  const inlineLimit = req.inlineBlobLimitBytes || 65_536;
  const db = new DatabaseSync(req.dbPath, { readOnly: true });
  const transfers = new Set<ArrayBuffer>();
  const detachBuf = (u8: Uint8Array | null | undefined): Uint8Array | null => {
    if (!u8 || u8.byteLength === 0) return null;
    const copy = Uint8Array.from(u8);
    if (copy.buffer instanceof ArrayBuffer) transfers.add(copy.buffer);
    return copy;
  };

  try {
    // 单语句自动提交 (Auto-Commit)，严禁长事务 BEGIN，确保宿主 wal_checkpoint 零阻塞
    db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 800;');

    let hasDataColumn = req.knownColumns?.hasDataColumn;
    let hasRenderInfoColumn = req.knownColumns?.hasRenderInfoColumn;
    let hasStepPayloadColumn = req.knownColumns?.hasStepPayloadColumn;
    if (
      hasDataColumn === undefined ||
      hasRenderInfoColumn === undefined ||
      hasStepPayloadColumn === undefined
    ) {
      try {
        const cols = db.prepare('PRAGMA table_info(steps)').all() as Array<{ name?: string }>;
        const colSet = new Set(cols.map(c => String(c.name ?? '')));
        hasDataColumn = colSet.has('data');
        hasRenderInfoColumn = colSet.has('render_info');
        hasStepPayloadColumn = colSet.has('step_payload');
      } catch {
        hasDataColumn = false;
        hasRenderInfoColumn = false;
        hasStepPayloadColumn = false;
      }
    }

    let hasTrajectoryMeta = false;
    let hasParentMetadataBlob = false;
    let parentMetaReadError = false;
    let parentMetaUnchanged = false;
    let parentMetaDigest = '';
    let trajectoryId = req.cachedTrajectoryId;
    const metaBlobProjectedSlices: Uint8Array[] = [];

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('trajectory_meta', 'trajectory_metadata_blob', 'gen_metadata', 'executor_metadata')")
      .all() as Array<{ name?: string }>;
    const tableSet = new Set(tables.map(t => String(t.name ?? '')));
    hasTrajectoryMeta = tableSet.has('trajectory_meta');
    const hasGenTable = tableSet.has('gen_metadata');
    const hasExecutorMetaTable = tableSet.has('executor_metadata');
    const baseNameHint = basename(req.dbPath, '.db').toLowerCase();
    const selfCascadeIdHint =
      req.selfCascadeIdHint?.trim().toLowerCase() ||
      (EXACT_UUID_RE.test(baseNameHint) ? baseNameHint : undefined);
    const forkMeta = readForkParentMetadata(db, selfCascadeIdHint);
    if (!trajectoryId && forkMeta.trajectoryId) {
      trajectoryId = forkMeta.trajectoryId;
    }

    if (tableSet.has('trajectory_metadata_blob')) {
      try {
        const tmbRows = db
          .prepare(
            `SELECT id, length(data) AS size, CASE WHEN length(data) <= ${inlineLimit} THEN data ELSE NULL END AS inlineData FROM trajectory_metadata_blob WHERE data IS NOT NULL ORDER BY id ASC LIMIT 4`
          )
          .all() as Array<{ id: string; size: number; inlineData: Uint8Array | null }>;
        if (tmbRows.length > 0) {
          hasParentMetadataBlob = true;
          let allInline = true;
          const pmHash = createHash('sha256');
          for (const r of tmbRows) {
            const sz = Number(r.size ?? 0);
            pmHash.update(`${r.id}:${sz}:`);
            if (r.inlineData && sz <= inlineLimit) {
              if (r.inlineData.byteLength > 0) pmHash.update(r.inlineData);
            } else if (sz > 0) {
              allInline = false;
            }
            pmHash.update('\n');
          }
          if (allInline) {
            parentMetaDigest = pmHash.digest('hex');
          }
          if (allInline && req.prevParentMetaDigest && parentMetaDigest === req.prevParentMetaDigest) {
            parentMetaUnchanged = true;
          } else {
            let chunkStmt: ReturnType<DatabaseSync['prepare']> | undefined;
            let fullStmt: ReturnType<DatabaseSync['prepare']> | undefined;
            for (const r of tmbRows) {
              const sz = Number(r.size ?? 0);
              const inlineBuf = r.inlineData && sz <= inlineLimit ? r.inlineData : null;
              const readChunk = inlineBuf
                ? (offset: number, length: number) => inlineBuf.subarray(offset, offset + length)
                : createSqlBlobChunkReader(
                    sz,
                    r.id,
                    () => (chunkStmt ??= db.prepare('SELECT substr(data, ?, ?) AS chunk FROM trajectory_metadata_blob WHERE id = ?')),
                    () => (fullStmt ??= db.prepare('SELECT data AS data FROM trajectory_metadata_blob WHERE id = ?'))
                  );
              const projected = projectProtobuf(sz, readChunk, { 5: true, 6: true });
              const slice = detachBuf(projected.data);
              if (slice) metaBlobProjectedSlices.push(slice);
            }
          }
        }
      } catch {
        parentMetaReadError = true;
      }
    }

    const buildStepSelectColumns = () => {
      const metaExpr = `CASE WHEN step_type != 101 AND length(metadata) <= ${inlineLimit} THEN metadata ELSE NULL END as metadata, CASE WHEN step_type != 101 THEN COALESCE(length(metadata), 0) ELSE 0 END as metadata_len, CASE WHEN step_type != 101 AND length(metadata) > ${inlineLimit} THEN substr(metadata, 1, 512) ELSE NULL END as metadata_head, CASE WHEN step_type != 101 AND length(metadata) > ${inlineLimit} THEN substr(metadata, max(1, length(metadata) - 511), 512) ELSE NULL END as metadata_tail`;
      const extraCols: string[] = [];
      if (hasDataColumn) {
        extraCols.push(`CASE WHEN step_type IN (85, 127, 132) THEN substr(data, 1, ${inlineLimit}) ELSE NULL END as data`);
      }
      if (hasRenderInfoColumn) {
        extraCols.push(
          `CASE WHEN step_type IN (85, 127, 132) AND length(render_info) <= ${inlineLimit} THEN render_info WHEN step_type NOT IN (14, 15, 23, 85, 101, 127, 132) AND length(metadata) > ${inlineLimit} THEN substr(render_info, 1, 16384) ELSE NULL END as render_info, CASE WHEN step_type IN (85, 127, 132) THEN COALESCE(length(render_info), 0) ELSE 0 END as render_info_len, CASE WHEN step_type IN (85, 127, 132) AND length(render_info) > ${inlineLimit} THEN substr(render_info, 1, 512) ELSE NULL END as render_info_head, CASE WHEN step_type IN (85, 127, 132) AND length(render_info) > ${inlineLimit} THEN substr(render_info, max(1, length(render_info) - 511), 512) ELSE NULL END as render_info_tail`
        );
      }
      if (hasStepPayloadColumn) {
        extraCols.push(`CASE WHEN step_type IN (85, 127, 132) THEN substr(step_payload, 1, ${inlineLimit}) ELSE NULL END as step_payload`);
      }
      return ['idx', 'step_type', 'status', metaExpr, ...extraCols].join(', ');
    };

    const stepColumnsSql = buildStepSelectColumns();
    let projectStepMetaStmt: ReturnType<DatabaseSync['prepare']> | undefined;
    let projectStepMetaFullStmt: ReturnType<DatabaseSync['prepare']> | undefined;
    let projectRenderInfoStmt: ReturnType<DatabaseSync['prepare']> | undefined;
    let projectRenderInfoFullStmt: ReturnType<DatabaseSync['prepare']> | undefined;
    const canIncludeStepInPrefix = (row: any): boolean => {
      const st = Number(row.status);
      return TERMINAL_STEP_STATUSES.has(st);
    };
    const normalizeRawStep = (row: any): HudWorkerRawStepRow => {
      const idx = Number(row.idx);
      const metadataLen = Number(row.metadata_len ?? 0);
      let effectiveMeta: Uint8Array | null = row.metadata && row.metadata.byteLength > 0 ? detachBuf(row.metadata) : null;
      if (!effectiveMeta && Number.isSafeInteger(metadataLen) && metadataLen > inlineLimit) {
        const readMetaChunk = createSqlBlobChunkReader(
          metadataLen,
          idx,
          () => (projectStepMetaStmt ??= db.prepare('SELECT substr(metadata, ?, ?) AS chunk FROM steps WHERE idx = ?')),
          () => (projectStepMetaFullStmt ??= db.prepare('SELECT metadata AS data FROM steps WHERE idx = ?'))
        );
        try {
          const projected = projectProtobuf(
            metadataLen,
            readMetaChunk,
            HUD_STEP_METADATA_PROJECTION,
            { skipOversizedLeafFields: true }
          );
          effectiveMeta = detachBuf(projected.data);
        } catch {
          try {
            const minimal = projectProtobuf(
              metadataLen,
              readMetaChunk,
              HUD_STEP_METADATA_MINIMAL_PROJECTION,
              { skipOversizedLeafFields: true }
            );
            effectiveMeta = detachBuf(minimal.data);
          } catch {
            // 单步超大/损坏元数据就地降级，保留 idx/step_type/status 避免整库扫描回退
            effectiveMeta = null;
          }
        }
      }
      const renderInfoLen = Number(row.render_info_len ?? 0);
      let effectiveRenderInfo: Uint8Array | null =
        row.render_info && row.render_info.byteLength > 0 ? detachBuf(row.render_info) : null;
      if (!effectiveRenderInfo && Number.isSafeInteger(renderInfoLen) && renderInfoLen > inlineLimit) {
        try {
          const projectedRenderInfo = projectProtobuf(
            renderInfoLen,
            createSqlBlobChunkReader(
              renderInfoLen,
              idx,
              () => (projectRenderInfoStmt ??= db.prepare('SELECT substr(render_info, ?, ?) AS chunk FROM steps WHERE idx = ?')),
              () => (projectRenderInfoFullStmt ??= db.prepare('SELECT render_info AS data FROM steps WHERE idx = ?'))
            ),
            HUD_STEP_RENDER_INFO_PROJECTION,
            { skipOversizedLeafFields: true }
          );
          effectiveRenderInfo = detachBuf(projectedRenderInfo.data);
        } catch {
          projectRenderInfoStmt ??= db.prepare('SELECT substr(render_info, ?, ?) AS chunk FROM steps WHERE idx = ?');
          effectiveRenderInfo = detachBuf(
            (projectRenderInfoStmt.get(1, inlineLimit, idx) as { chunk?: Uint8Array } | undefined)?.chunk ?? null
          );
        }
      }
      return {
        idx,
        step_type: Number(row.step_type),
        status: Number(row.status),
        metadata: effectiveMeta,
        metadata_len: metadataLen,
        data: detachBuf(row.data),
        render_info: effectiveRenderInfo,
        render_info_len: renderInfoLen,
        step_payload: detachBuf(row.step_payload),
      };
    };

    let stepsMode: 'full' | 'append' = 'full';
    let stepPrefixCutoffIdx = -1;
    let stepPrefixDigest = '';
    let maxIdx = -1;
    const appendedSteps: HudWorkerRawStepRow[] = [];

    if (
      req.prevStepPrefixCutoffIdx !== undefined &&
      req.prevStepPrefixCutoffIdx >= 0 &&
      req.prevStepPrefixDigest
    ) {
      const prefixHasher = createHash('sha256');
      let prefixRowCount = 0;
      let prefixMaxIdx = -1;
      let prefixAllInline = true;
      for (const r of db
        .prepare(`SELECT ${stepColumnsSql} FROM steps WHERE idx < ? ORDER BY idx ASC`)
        .iterate(req.prevStepPrefixCutoffIdx) as Iterable<any>) {
        if (!canIncludeStepInPrefix(r)) {
          prefixAllInline = false;
          break;
        }
        hashRawStepRow(prefixHasher, r);
        prefixRowCount++;
        prefixMaxIdx = Number(r.idx);
      }
      if (
        prefixAllInline &&
        prefixRowCount > 0 &&
        prefixHasher.copy().digest('hex') === req.prevStepPrefixDigest
      ) {
        stepsMode = 'append';
        const tailRows = db
          .prepare(`SELECT ${stepColumnsSql} FROM steps WHERE idx >= ? ORDER BY idx ASC`)
          .all(req.prevStepPrefixCutoffIdx) as any[];
        maxIdx = tailRows.length > 0 ? Number(tailRows[tailRows.length - 1]!.idx) : prefixMaxIdx;
        let advanceCount = 0;
        while (advanceCount < tailRows.length - 2 && canIncludeStepInPrefix(tailRows[advanceCount])) {
          hashRawStepRow(prefixHasher, tailRows[advanceCount]);
          advanceCount++;
        }
        if (advanceCount > 0) {
          stepPrefixCutoffIdx = Number(tailRows[advanceCount]!.idx);
          stepPrefixDigest = prefixHasher.digest('hex');
        } else {
          stepPrefixCutoffIdx = req.prevStepPrefixCutoffIdx;
          stepPrefixDigest = req.prevStepPrefixDigest;
        }
        for (const r of tailRows) {
          appendedSteps.push(normalizeRawStep(r));
        }
      }
    }

    if (stepsMode === 'full') {
      const rows = db
        .prepare(`SELECT ${stepColumnsSql} FROM steps ORDER BY idx ASC`)
        .all() as any[];
      maxIdx = rows.length > 0 ? Number(rows[rows.length - 1]!.idx) : -1;
      let prefixEnd = 0;
      const prefixHasher = createHash('sha256');
      while (prefixEnd < rows.length - 2 && canIncludeStepInPrefix(rows[prefixEnd])) {
        hashRawStepRow(prefixHasher, rows[prefixEnd]);
        prefixEnd++;
      }
      if (prefixEnd > 0) {
        stepPrefixCutoffIdx = Number(rows[prefixEnd]!.idx);
        stepPrefixDigest = prefixHasher.digest('hex');
      }
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        rows[i] = null;
        if (r) appendedSteps.push(normalizeRawStep(r));
      }
      rows.length = 0;
    }

    let executorMetaUnchanged = false;
    let executorMetaDigest = '';
    let executorMetaBlob: Uint8Array | null = null;
    if (hasExecutorMetaTable) {
      try {
        const execRow = db
          .prepare(
            `SELECT idx, length(data) AS dataLen, CASE WHEN length(data) <= ${inlineLimit} THEN data ELSE NULL END AS inlineData, CASE WHEN length(data) > ${inlineLimit} THEN substr(data, 1, 512) ELSE NULL END AS dataHead, CASE WHEN length(data) > ${inlineLimit} THEN substr(data, max(1, length(data) - 511), 512) ELSE NULL END AS dataTail FROM executor_metadata WHERE data IS NOT NULL ORDER BY idx DESC LIMIT 1`
          )
          .get() as
          | {
              idx: number;
              dataLen: number;
              inlineData: Uint8Array | null;
              dataHead: Uint8Array | null;
              dataTail: Uint8Array | null;
            }
          | undefined;
        if (execRow && Number(execRow.dataLen ?? 0) > 0) {
          const execIdx = Number(execRow.idx);
          const execLen = Number(execRow.dataLen ?? 0);
          const execHasher = createHash('sha256');
          hashRawGenRowMeta(execHasher, execIdx, execLen, execRow.inlineData, execRow.dataHead, execRow.dataTail);
          executorMetaDigest = execHasher.digest('hex');
          if (req.prevExecutorMetaDigest && executorMetaDigest === req.prevExecutorMetaDigest) {
            executorMetaUnchanged = true;
          } else {
            const inlineBuf = execRow.inlineData && execLen <= inlineLimit ? execRow.inlineData : null;
            let execChunkStmt: ReturnType<DatabaseSync['prepare']> | undefined;
            let execFullStmt: ReturnType<DatabaseSync['prepare']> | undefined;
            const projected = projectProtobuf(
              execLen,
              inlineBuf
                ? (offset, length) => inlineBuf.subarray(offset, offset + length)
                : createSqlBlobChunkReader(
                    execLen,
                    execIdx,
                    () => (execChunkStmt ??= db.prepare('SELECT substr(data, ?, ?) AS chunk FROM executor_metadata WHERE idx = ?')),
                    () => (execFullStmt ??= db.prepare('SELECT data AS data FROM executor_metadata WHERE idx = ?'))
                  ),
              HUD_EXECUTOR_METADATA_PROJECTION,
              HUD_GEN_PROTO_LIMITS
            );
            executorMetaBlob = detachBuf(projected.data);
          }
        }
      } catch {
        // 兼容无 executor_metadata 表或损坏行，就地降级
      }
    }

    let genMode: 'full' | 'append' | 'unchanged' = 'full';
    let lastGenIdx = -1;
    let genDigest = '';
    let genPrefixCutoffIdx = -1;
    let genPrefixDigest = '';
    const genBlobs: Array<{ idx: number; data: Uint8Array }> = [];

    if (hasGenTable) {
      let chunkStmt: ReturnType<DatabaseSync['prepare']> | undefined;
      let fullGenStmt: ReturnType<DatabaseSync['prepare']> | undefined;
      const resolveRawGenBlob = (
        idx: number,
        dataLen: number,
        inlineData: Uint8Array | null | undefined,
        dataHead?: Uint8Array | null,
        dataTail?: Uint8Array | null
      ): Uint8Array | null => {
        if (dataLen <= 0) return null;
        if (dataLen <= inlineLimit) {
          return inlineData && inlineData.byteLength > 0 ? inlineData : null;
        }
        const keyHasher = createHash('sha256');
        keyHasher.update(`${req.dbPath}|${idx}|${dataLen}|`);
        if (dataHead && dataHead.byteLength > 0) keyHasher.update(dataHead);
        if (dataTail && dataTail.byteLength > 0) keyHasher.update(dataTail);
        const cacheKey = keyHasher.digest('hex');
        const cached = getCachedProjectedGenBlob(cacheKey);
        if (cached !== undefined) return cached;
        try {
          const projected = projectProtobuf(
            dataLen,
            createSqlBlobChunkReader(
              dataLen,
              idx,
              () => (chunkStmt ??= db.prepare('SELECT substr(data, ?, ?) AS chunk FROM gen_metadata WHERE idx = ?')),
              () => (fullGenStmt ??= db.prepare('SELECT data AS data FROM gen_metadata WHERE idx = ?'))
            ),
            HUD_GEN_METADATA_PROJECTION,
            HUD_GEN_PROTO_LIMITS
          );
          const resultBuf = Uint8Array.from(projected.data);
          setCachedProjectedGenBlob(cacheKey, resultBuf);
          return resultBuf;
        } catch {
          // 单行生成元数据投影异常就地降级，避免阻断整库读取
          return null;
        }
      };

      const genColsSql = `idx, length(data) AS dataLen, CASE WHEN length(data) <= ${inlineLimit} THEN data ELSE NULL END AS inlineData, CASE WHEN length(data) > ${inlineLimit} THEN substr(data, 1, 512) ELSE NULL END AS dataHead, CASE WHEN length(data) > ${inlineLimit} THEN substr(data, max(1, length(data) - 511), 512) ELSE NULL END AS dataTail`;
      let usedIncrementalGen = false;

      if (
        req.prevGenPrefixCutoffIdx !== undefined &&
        req.prevGenPrefixCutoffIdx >= 0 &&
        req.prevGenPrefixDigest
      ) {
        const genPrefixHasher = createHash('sha256');
        let prefixGenCount = 0;
        let prefixMaxGenIdx = -1;
        for (const r of db
          .prepare(`SELECT ${genColsSql} FROM gen_metadata WHERE data IS NOT NULL AND idx < ? ORDER BY idx ASC`)
          .iterate(req.prevGenPrefixCutoffIdx) as Iterable<any>) {
          const idx = Number(r.idx);
          const dataLen = Number(r.dataLen ?? 0);
          hashRawGenRowMeta(genPrefixHasher, idx, dataLen, r.inlineData, r.dataHead, r.dataTail);
          prefixGenCount++;
          prefixMaxGenIdx = idx;
        }
        if (
          prefixGenCount > 0 &&
          genPrefixHasher.copy().digest('hex') === req.prevGenPrefixDigest
        ) {
          usedIncrementalGen = true;
          const tailGenRows = db
            .prepare(`SELECT ${genColsSql} FROM gen_metadata WHERE data IS NOT NULL AND idx >= ? ORDER BY idx ASC`)
            .all(req.prevGenPrefixCutoffIdx) as any[];
          lastGenIdx = tailGenRows.length > 0 ? Number(tailGenRows[tailGenRows.length - 1]!.idx) : prefixMaxGenIdx;
          const fullGenHasher = genPrefixHasher.copy();
          for (const r of tailGenRows) {
            if (!r) continue;
            hashRawGenRowMeta(fullGenHasher, Number(r.idx), Number(r.dataLen ?? 0), r.inlineData, r.dataHead, r.dataTail);
          }
          genDigest = fullGenHasher.digest('hex');
          let advanceGen = 0;
          while (advanceGen < tailGenRows.length - 1) {
            const r = tailGenRows[advanceGen];
            if (r) {
              hashRawGenRowMeta(genPrefixHasher, Number(r.idx), Number(r.dataLen ?? 0), r.inlineData, r.dataHead, r.dataTail);
            }
            advanceGen++;
          }
          if (advanceGen > 0) {
            genPrefixCutoffIdx = Number(tailGenRows[advanceGen]!.idx);
            genPrefixDigest = genPrefixHasher.digest('hex');
          } else {
            genPrefixCutoffIdx = req.prevGenPrefixCutoffIdx;
            genPrefixDigest = req.prevGenPrefixDigest;
          }
          if (req.prevGenDigest && genDigest === req.prevGenDigest) {
            genMode = 'unchanged';
          } else {
            genMode = 'append';
            for (let i = 0; i < tailGenRows.length; i++) {
              const r = tailGenRows[i];
              tailGenRows[i] = null;
              if (!r) continue;
              const idx = Number(r.idx);
              const dataLen = Number(r.dataLen ?? 0);
              const rawBlob = resolveRawGenBlob(idx, dataLen, r.inlineData, r.dataHead, r.dataTail);
              const detached = detachBuf(rawBlob);
              if (detached) genBlobs.push({ idx, data: detached });
            }
          }
          tailGenRows.length = 0;
        }
      }

      if (!usedIncrementalGen) {
        const allGenRows = db
          .prepare(`SELECT ${genColsSql} FROM gen_metadata WHERE data IS NOT NULL ORDER BY idx ASC`)
          .all() as any[];
        lastGenIdx = allGenRows.length > 0 ? Number(allGenRows[allGenRows.length - 1]!.idx) : -1;
        const fullGenHasher = createHash('sha256');
        const prefixGenHasher = createHash('sha256');
        for (const r of allGenRows) {
          if (!r) continue;
          hashRawGenRowMeta(fullGenHasher, Number(r.idx), Number(r.dataLen ?? 0), r.inlineData, r.dataHead, r.dataTail);
        }
        genDigest = fullGenHasher.digest('hex');
        let prefixEnd = 0;
        while (prefixEnd < allGenRows.length - 1) {
          const r = allGenRows[prefixEnd];
          if (r) {
            hashRawGenRowMeta(prefixGenHasher, Number(r.idx), Number(r.dataLen ?? 0), r.inlineData, r.dataHead, r.dataTail);
          }
          prefixEnd++;
        }
        if (prefixEnd > 0) {
          genPrefixCutoffIdx = Number(allGenRows[prefixEnd]!.idx);
          genPrefixDigest = prefixGenHasher.digest('hex');
        }
        if (req.prevGenDigest !== undefined && genDigest === req.prevGenDigest) {
          genMode = 'unchanged';
        } else {
          genMode = 'full';
          for (let i = 0; i < allGenRows.length; i++) {
            const r = allGenRows[i];
            allGenRows[i] = null;
            if (!r) continue;
            const idx = Number(r.idx);
            const dataLen = Number(r.dataLen ?? 0);
            const rawBlob = resolveRawGenBlob(idx, dataLen, r.inlineData, r.dataHead, r.dataTail);
            const detached = detachBuf(rawBlob);
            if (detached) genBlobs.push({ idx, data: detached });
          }
        }
        allGenRows.length = 0;
      }
    }

    return {
      result: {
        hasDataColumn: Boolean(hasDataColumn),
        hasRenderInfoColumn: Boolean(hasRenderInfoColumn),
        hasStepPayloadColumn: Boolean(hasStepPayloadColumn),
        hasTrajectoryMeta,
        hasParentMetadataBlob,
        parentMetaReadError,
        parentMetaUnchanged,
        parentMetaDigest,
        executorMetaUnchanged,
        executorMetaDigest,
        executorMetaBlob,
        trajectoryId,
        ...(forkMeta.cascadeId !== undefined ? { cascadeId: forkMeta.cascadeId } : {}),
        ...(forkMeta.trajectoryType !== undefined ? { trajectoryType: forkMeta.trajectoryType } : {}),
        ...(forkMeta.forkStepIndex !== undefined ? { forkStepIndex: forkMeta.forkStepIndex } : {}),
        ...(forkMeta.forkParentCascadeId !== undefined ? { forkParentCascadeId: forkMeta.forkParentCascadeId } : {}),
        metaBlobProjectedSlices,
        maxIdx,
        stepsMode,
        stepPrefixCutoffIdx,
        stepPrefixDigest,
        appendedSteps,
        genMode,
        lastGenIdx,
        genDigest,
        genPrefixCutoffIdx,
        genPrefixDigest,
        genBlobs,
      },
      transfers: [...transfers],
    };
  } finally {
    try {
      db.close();
    } catch {}
  }
}
// The bundled SQLite supports closed WAL databases that the older system CLI cannot open.
// readOnly protects database contents; SQLite manages its own read coordination sidecars.
let database: DatabaseSync | undefined;
let sessionError: string | undefined;
let sessionDataVersion = 0;

export function closeSqliteDatabase(db: { exec(sql: string): unknown; close(): unknown } | undefined): void {
  if (!db) return;
  try { db.exec('ROLLBACK;'); } catch {}
  try { db.close(); } catch {}
}

function openSession(path: string) {
  closeSession();
  try {
    database = new DatabaseSync(path, { readOnly: true });
    database.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=250;');
    sessionDataVersion = Number(database.prepare('PRAGMA data_version').get()?.data_version);
  } catch (error) {
    sessionError = (error as Error).message;
  }
}

function closeSession() {
  closeSqliteDatabase(database);
  database = undefined;
  sessionError = undefined;
}

if (typeof workerData?.locale === 'string' && workerData.locale) {
  setActiveLocale(workerData.locale);
}
if (typeof workerData?.path === 'string' && workerData.path.length > 0) {
  openSession(workerData.path);
}

export interface UsageWorkerScanRequest {
  dbPath: string;
  inlineBlobLimitBytes?: number;
}

export interface UsageWorkerScanRow {
  idx: number;
  size: number;
  data_blob?: Uint8Array | null;
  projected?: boolean;
}

export interface UsageWorkerScanResult {
  ok: boolean;
  error?: string;
  changedDuringRead?: boolean;
  countExceeded?: number;
  trajectoryType?: number;
  forkStepIndex?: number;
  forkParentCascadeId?: string;
  genRows: UsageWorkerScanRow[];
  stepSchemaOk: boolean;
  stepError?: string;
  stepRows: UsageWorkerScanRow[];
}

export interface SummariesLookupRequest {
  dbPath: string;
  parentIds: string[];
  selfIds?: string[];
}

export interface SummariesLookupResult {
  foundTable: boolean;
  childIds: string[];
  terminalChildIds: string[];
  runningChildIds: string[];
  selfRunning: boolean;
}

const NON_RUNNING_SUMMARY_STATUS_RE =
  /^(?:CASCADE_RUN_STATUS_)?(?:IDLE|UNSPECIFIED|DONE|COMPLETED|CLEARED|ERROR|CANCELL?ED|KILLED|WAITING|PAUSED|BLOCKED|STANDING[_ -]?BY)$/i;
const RUNNING_SUMMARY_STATUS_RE =
  /^(?:CASCADE_RUN_STATUS_)?(?:RUNNING|IN_PROGRESS|ACTIVE)$/i;

function executeSummariesLookup(req: SummariesLookupRequest): SummariesLookupResult {
  const cleanParents = [...new Set((req.parentIds ?? []).map(p => String(p ?? '').trim().toLowerCase()).filter(Boolean))];
  const cleanSelfIds = [...new Set((req.selfIds ?? []).map(s => String(s ?? '').trim().toLowerCase()).filter(Boolean))];
  if (cleanParents.length === 0 && cleanSelfIds.length === 0) {
    return { foundTable: false, childIds: [], terminalChildIds: [], runningChildIds: [], selfRunning: false };
  }
  const db = new DatabaseSync(req.dbPath, { readOnly: true });
  try {
    db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 400;');
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('conversation_parents', 'conversation_summaries')")
      .all() as Array<{ name?: unknown }>;
    const tableSet = new Set(tables.map(t => String(t.name ?? '')));
    if (tableSet.size === 0) {
      return { foundTable: false, childIds: [], terminalChildIds: [], runningChildIds: [], selfRunning: false };
    }
    const childIds = new Set<string>();
    const parentTableChildIds = new Set<string>();
    const terminalChildIds = new Set<string>();
    const runningChildIds = new Set<string>();
    let selfRunning = false;
    if (cleanParents.length > 0 && tableSet.has('conversation_parents')) {
      const pCols = new Set(
        (db.prepare('PRAGMA table_info(conversation_parents)').all() as Array<{ name?: unknown }>).map(c => String(c.name ?? ''))
      );
      const childCol = pCols.has('conversation_id') ? 'conversation_id' : pCols.has('child_id') ? 'child_id' : '';
      const parentCol = pCols.has('parent_id') ? 'parent_id' : pCols.has('parent_conversation_id') ? 'parent_conversation_id' : '';
      if (childCol && parentCol) {
        const stmt = db.prepare(`SELECT ${childCol} AS cid FROM conversation_parents WHERE lower(${parentCol}) = ?`);
        for (const pid of cleanParents) {
          for (const r of stmt.all(pid) as Array<{ cid?: unknown }>) {
            const cid = String(r.cid ?? '').trim().toLowerCase();
            if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(cid)) {
              parentTableChildIds.add(cid);
            }
          }
        }
      }
    }
    if (!tableSet.has('conversation_summaries')) {
      for (const cid of parentTableChildIds) {
        childIds.add(cid);
      }
    } else {
      const cols = new Set(
        (db.prepare('PRAGMA table_info(conversation_summaries)').all() as Array<{ name?: unknown }>).map(c => String(c.name ?? ''))
      );
      const childCol = cols.has('conversation_id') ? 'conversation_id' : cols.has('id') ? 'id' : '';
      const parentCol = cols.has('parent_conversation_id') ? 'parent_conversation_id' : cols.has('parent_id') ? 'parent_id' : '';
      const hasStatus = cols.has('status');
      const selectStatusSql = hasStatus ? ', status' : '';
      const classifySummaryStatus = (cid: string, rawStatus: unknown) => {
        if (!hasStatus || rawStatus === null || rawStatus === undefined) return;
        const rawSt = String(rawStatus).trim();
        if (NON_RUNNING_SUMMARY_STATUS_RE.test(rawSt) || rawSt === '0' || rawSt === '1') {
          terminalChildIds.add(cid);
        } else if (RUNNING_SUMMARY_STATUS_RE.test(rawSt) || rawSt === '2') {
          runningChildIds.add(cid);
        }
      };
      if (cleanParents.length > 0 && childCol && parentCol) {
        const stmt = db.prepare(`SELECT ${childCol} AS cid${selectStatusSql} FROM conversation_summaries WHERE lower(${parentCol}) = ?`);
        for (const pid of cleanParents) {
          for (const r of stmt.all(pid) as Array<{ cid?: unknown; status?: unknown }>) {
            const cid = String(r.cid ?? '').trim().toLowerCase();
            if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(cid)) {
              childIds.add(cid);
              classifySummaryStatus(cid, r.status);
            }
          }
        }
      }
      if (cleanParents.length > 0 && childCol && parentTableChildIds.size > 0) {
        const selectExpr = hasStatus ? 'status' : '1 AS found';
        const byIdStmt = db.prepare(`SELECT ${selectExpr} FROM conversation_summaries WHERE lower(${childCol}) = ?`);
        for (const cid of parentTableChildIds) {
          const row = byIdStmt.get(cid) as { status?: unknown } | undefined;
          if (row) {
            childIds.add(cid);
            if (hasStatus) classifySummaryStatus(cid, row.status);
          }
        }
      }
      if (cleanSelfIds.length > 0 && childCol && hasStatus) {
        const selfStmt = db.prepare(`SELECT status FROM conversation_summaries WHERE lower(${childCol}) = ?`);
        for (const sid of cleanSelfIds) {
          const rows = selfStmt.all(sid) as Array<{ status?: unknown }>;
          for (const row of rows) {
            if (row && row.status !== null && row.status !== undefined) {
              const rawSt = String(row.status).trim();
              if (RUNNING_SUMMARY_STATUS_RE.test(rawSt) || rawSt === '2') {
                selfRunning = true;
                break;
              }
            }
          }
          if (selfRunning) break;
        }
      }
    }
    return {
      foundTable: true,
      childIds: [...childIds],
      terminalChildIds: [...terminalChildIds],
      runningChildIds: [...runningChildIds],
      selfRunning,
    };
  } finally {
    try { db.close(); } catch {}
  }
}

function hasValidStartedAtField4(startBuf: Uint8Array): boolean {
  const cStart = { pos: 0 };
  while (cStart.pos < startBuf.length) {
    let tagNum: number;
    try {
      tagNum = Number(decodeVarint64(startBuf, cStart));
    } catch {
      return false;
    }
    if (!tagNum) break;
    const fn = tagNum >>> 3;
    const wt = tagNum & 0x07;
    if (wt === 2 && fn === 4) {
      let len: number;
      try {
        len = Number(decodeVarint64(startBuf, cStart));
      } catch {
        return false;
      }
      if (!Number.isSafeInteger(len) || len <= 0 || cStart.pos + len > startBuf.length) return false;
      const tsBuf = startBuf.subarray(cStart.pos, cStart.pos + len);
      cStart.pos += len;
      const cTs = { pos: 0 };
      while (cTs.pos < tsBuf.length) {
        let tsTag: number;
        try {
          tsTag = Number(decodeVarint64(tsBuf, cTs));
        } catch {
          break;
        }
        if (!tsTag) break;
        if ((tsTag & 0x07) === 0 && (tsTag >>> 3) === 1) {
          try {
            const sec = Number(decodeVarint64(tsBuf, cTs));
            const maxValidSec = Math.floor(Date.now() / 1000) + 86400;
            if (Number.isFinite(sec) && sec >= 946_684_800 && sec <= maxValidSec) return true;
          } catch {
            break;
          }
        } else if (!skipProtobufField(tsBuf, cTs, tsTag & 0x07)) {
          break;
        }
      }
    } else if (!skipProtobufField(startBuf, cStart, wt)) {
      break;
    }
  }
  return false;
}

function hasChatStartTimestamp(modelBuf: Uint8Array): boolean {
  const cursor = { pos: 0 };
  while (cursor.pos < modelBuf.length) {
    let tagNum: number;
    try {
      tagNum = Number(decodeVarint64(modelBuf, cursor));
    } catch {
      return false;
    }
    if (!tagNum) break;
    const fn = tagNum >>> 3;
    const wt = tagNum & 0x07;
    if (wt === 2) {
      let len: number;
      try {
        len = Number(decodeVarint64(modelBuf, cursor));
      } catch {
        return false;
      }
      if (!Number.isSafeInteger(len) || len < 0 || cursor.pos + len > modelBuf.length) return false;
      const slice = modelBuf.subarray(cursor.pos, cursor.pos + len);
      cursor.pos += len;
      if (fn === 9 && hasValidStartedAtField4(slice)) return true;
    } else if (!skipProtobufField(modelBuf, cursor, wt)) {
      return false;
    }
  }
  return false;
}

export function hasInlineGenerationTimestamp(buf: Uint8Array): boolean {
  if (!buf || buf.byteLength < 6) return false;
  if (hasChatStartTimestamp(buf)) return true;
  const cursor = { pos: 0 };
  while (cursor.pos < buf.length) {
    let tagNum: number;
    try {
      tagNum = Number(decodeVarint64(buf, cursor));
    } catch {
      return false;
    }
    if (!tagNum) break;
    const fn = tagNum >>> 3;
    const wt = tagNum & 0x07;
    if (wt === 2) {
      let len: number;
      try {
        len = Number(decodeVarint64(buf, cursor));
      } catch {
        return false;
      }
      if (!Number.isSafeInteger(len) || len < 0 || cursor.pos + len > buf.length) return false;
      const slice = buf.subarray(cursor.pos, cursor.pos + len);
      cursor.pos += len;
      if (fn === 1 && hasChatStartTimestamp(slice)) return true;
      if (fn === 9 && hasValidStartedAtField4(slice)) return true;
    } else if (!skipProtobufField(buf, cursor, wt)) {
      return false;
    }
  }
  return false;
}

function executeUsageScan(req: UsageWorkerScanRequest): { result: UsageWorkerScanResult; transfers: ArrayBuffer[] } {
  const inlineLimit = req.inlineBlobLimitBytes ?? 262_144;
  const maxDirectBlob = 16_777_216;
  const db = new DatabaseSync(req.dbPath, { readOnly: true });
  const transfers = new Set<ArrayBuffer>();
  const detachBuf = (u8: Uint8Array | null | undefined): Uint8Array | null => {
    if (!u8 || u8.byteLength === 0) return null;
    const copy = Uint8Array.from(u8);
    if (copy.buffer instanceof ArrayBuffer) transfers.add(copy.buffer);
    return copy;
  };

  try {
    db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 250;');
    const dataVersionBefore = Number((db.prepare('PRAGMA data_version').get() as { data_version?: unknown } | undefined)?.data_version);
    const baseNameHint = basename(req.dbPath, '.db').toLowerCase();
    const forkMeta = readForkParentMetadata(
      db,
      EXACT_UUID_RE.test(baseNameHint) ? baseNameHint : undefined
    );
    const forkMetaFields = {
      ...(forkMeta.trajectoryType !== undefined ? { trajectoryType: forkMeta.trajectoryType } : {}),
      ...(forkMeta.forkStepIndex !== undefined ? { forkStepIndex: forkMeta.forkStepIndex } : {}),
      ...(forkMeta.forkParentCascadeId !== undefined ? { forkParentCascadeId: forkMeta.forkParentCascadeId } : {}),
    };

    const indexRows = db
      .prepare('SELECT idx, length(data) AS size FROM gen_metadata WHERE data IS NOT NULL ORDER BY idx;')
      .all() as Array<{ idx?: unknown; size?: unknown }>;

    if (indexRows.length > 50_000) {
      return {
        result: {
          ok: true,
          countExceeded: indexRows.length,
          ...forkMetaFields,
          genRows: [],
          stepSchemaOk: true,
          stepRows: [],
        },
        transfers: [],
      };
    }

    if (indexRows.length === 0) {
      const dataVersionAfterEmpty = Number((db.prepare('PRAGMA data_version').get() as { data_version?: unknown } | undefined)?.data_version);
      if (dataVersionBefore !== dataVersionAfterEmpty) {
        return {
          result: {
            ok: false,
            changedDuringRead: true,
            error: bt('sqlite.err.changed_during_read'),
            genRows: [],
            stepSchemaOk: true,
            stepRows: [],
          },
          transfers: [],
        };
      }
      return {
        result: {
          ok: true,
          ...forkMetaFields,
          genRows: [],
          stepSchemaOk: true,
          stepRows: [],
        },
        transfers: [],
      };
    }

    const genRows: UsageWorkerScanRow[] = [];
    let mayNeedSteps = false;
    const inlineStmt = db.prepare(
      `SELECT idx, length(data) AS size, CASE WHEN length(data) <= ${inlineLimit} THEN data ELSE NULL END AS data_blob FROM gen_metadata WHERE data IS NOT NULL ORDER BY idx;`
    );
    let chunkStmt: ReturnType<DatabaseSync['prepare']> | undefined;
    let fullRowStmt: ReturnType<DatabaseSync['prepare']> | undefined;

    for (const raw of inlineStmt.iterate() as Iterable<any>) {
      const idx = Number(raw.idx);
      const size = Number(raw.size ?? 0);
      if (!Number.isSafeInteger(idx)) {
        throw new Error(bt('scanner.err.unsupported_row_index'));
      }
      if (size <= inlineLimit) {
        const detached = detachBuf(raw.data_blob);
        if (!detached || !hasInlineGenerationTimestamp(detached)) {
          mayNeedSteps = true;
        }
        genRows.push({ idx, size, data_blob: detached });
        continue;
      }
      try {
        const projected = projectProtobuf(
          size,
          createSqlBlobChunkReader(
            size,
            idx,
            () => (chunkStmt ??= db.prepare('SELECT substr(data, ?, ?) AS chunk FROM gen_metadata WHERE idx = ?')),
            () => (fullRowStmt ??= db.prepare('SELECT data AS data FROM gen_metadata WHERE idx = ?'))
          ),
          GENERATION_PROJECTION,
          USAGE_PROTO_LIMITS
        );
        const detached = detachBuf(projected.data);
        if (!detached || !hasInlineGenerationTimestamp(detached)) {
          mayNeedSteps = true;
        }
        genRows.push({ idx, size, data_blob: detached, projected: true });
      } catch {
        if (size <= maxDirectBlob) {
          fullRowStmt ??= db.prepare('SELECT data AS data FROM gen_metadata WHERE idx = ?');
          const full = fullRowStmt.get(idx) as { data?: Uint8Array } | undefined;
          const detached = detachBuf(full?.data);
          if (!detached || !hasInlineGenerationTimestamp(detached)) {
            mayNeedSteps = true;
          }
          genRows.push({ idx, size, data_blob: detached });
        } else {
          genRows.push({ idx, size, data_blob: null });
        }
      }
    }

    let stepSchemaOk = true;
    let stepError: string | undefined;
    const stepRows: UsageWorkerScanRow[] = [];

    if (mayNeedSteps) {
      try {
        const stepCols = db.prepare('PRAGMA table_info(steps);').all() as Array<{ name?: unknown }>;
        const colSet = new Set(stepCols.map(c => String(c.name ?? '')));
        if (!['idx', 'metadata', 'step_type'].every(col => colSet.has(col))) {
          stepSchemaOk = false;
          stepError = bt('scanner.err.missing_timestamp_schema');
        } else {
          const stepStmt = db.prepare(
            `SELECT idx, COALESCE(length(metadata), 0) AS size, CASE WHEN length(metadata) <= ${inlineLimit} THEN metadata ELSE NULL END AS data_blob FROM steps WHERE step_type = 15 ORDER BY idx;`
          );
          let stepChunkStmt: ReturnType<DatabaseSync['prepare']> | undefined;
          let stepFullStmt: ReturnType<DatabaseSync['prepare']> | undefined;
          for (const sraw of stepStmt.iterate() as Iterable<any>) {
            const idx = Number(sraw.idx);
            const size = Number(sraw.size ?? 0);
            if (!Number.isSafeInteger(idx)) {
              throw new Error(bt('scanner.err.unsupported_row_index'));
            }
            if (size <= 0) continue;
            if (size <= inlineLimit) {
              stepRows.push({ idx, size, data_blob: detachBuf(sraw.data_blob) });
              continue;
            }
            try {
              const projected = projectProtobuf(
                size,
                createSqlBlobChunkReader(
                  size,
                  idx,
                  () => (stepChunkStmt ??= db.prepare('SELECT substr(metadata, ?, ?) AS chunk FROM steps WHERE idx = ?')),
                  () => (stepFullStmt ??= db.prepare('SELECT metadata AS data FROM steps WHERE idx = ?'))
                ),
                STEP_PROJECTION,
                USAGE_PROTO_LIMITS
              );
              stepRows.push({ idx, size, data_blob: detachBuf(projected.data), projected: true });
            } catch {
              if (size <= maxDirectBlob) {
                stepFullStmt ??= db.prepare('SELECT metadata AS data FROM steps WHERE idx = ?');
                const full = stepFullStmt.get(idx) as { data?: Uint8Array } | undefined;
                stepRows.push({ idx, size, data_blob: detachBuf(full?.data) });
              } else {
                stepRows.push({ idx, size, data_blob: null });
              }
            }
          }
        }
      } catch (err) {
        stepSchemaOk = false;
        stepError = (err as Error).message;
      }
    }

    const dataVersionAfter = Number((db.prepare('PRAGMA data_version').get() as { data_version?: unknown } | undefined)?.data_version);
    if (dataVersionBefore !== dataVersionAfter) {
      return {
        result: {
          ok: false,
          changedDuringRead: true,
          error: bt('sqlite.err.changed_during_read'),
          genRows: [],
          stepSchemaOk: true,
          stepRows: [],
        },
        transfers: [],
      };
    }

    return {
      result: {
        ok: true,
        ...forkMetaFields,
        genRows,
        stepSchemaOk,
        stepError,
        stepRows,
      },
      transfers: [...transfers],
    };
  } finally {
    try {
      db.close();
    } catch {}
  }
}

parentPort?.on('message', (request: { id: string; locale?: string; open?: string; sql?: string; verify?: boolean; close?: boolean; reusable?: boolean; projection?: {table:string;column:string;idx:number}; hudScan?: HudWorkerScanRequest; usageScan?: UsageWorkerScanRequest; summariesLookup?: SummariesLookupRequest }) => {
  if (typeof request.locale === 'string' && request.locale) {
    setActiveLocale(request.locale);
  }
  if (request.summariesLookup) {
    try {
      const summariesResult = executeSummariesLookup(request.summariesLookup);
      parentPort?.postMessage({ id: request.id, ok: true, summariesResult });
    } catch (error) {
      parentPort?.postMessage({ id: request.id, ok: false, error: (error as Error).message });
    }
    return;
  }
  if (request.hudScan) {
    try {
      const { result, transfers } = executeHudScan(request.hudScan);
      parentPort?.postMessage({ id: request.id, ok: true, hudResult: result }, transfers);
    } catch (error) {
      parentPort?.postMessage({ id: request.id, ok: false, error: (error as Error).message });
    }
    return;
  }
  if (request.usageScan) {
    try {
      const { result, transfers } = executeUsageScan(request.usageScan);
      parentPort?.postMessage({ id: request.id, ok: true, usageResult: result }, transfers);
    } catch (error) {
      parentPort?.postMessage({ id: request.id, ok: false, error: (error as Error).message });
    }
    return;
  }
  if (typeof request.open === 'string') {
    openSession(request.open);
    return;
  }
  if (request.close) {
    closeSession();
    if (request.reusable) {
      parentPort?.postMessage({ id: request.id, closed: true });
    } else {
      parentPort?.close();
    }
    return;
  }
  if (sessionError || !database) {
    parentPort?.postMessage({ id: request.id, ok: false, rows: [], error: sessionError || bt('sqlite.err.connection_closed') });
    return;
  }
  try {
    let rows: Record<string,any>[];
    if (request.verify) {
      const unchanged = sessionDataVersion === Number(database.prepare('PRAGMA data_version').get()?.data_version);
      parentPort?.postMessage({ id: request.id, ok: unchanged, rows: [], ...(unchanged ? {} : { error: bt('sqlite.err.changed_during_read') }) });
      return;
    }
    if(request.projection){
      database.exec('BEGIN;');
      try {
      const {table,column,idx}=request.projection;
      if(!Number.isSafeInteger(idx)||!((table==='gen_metadata'&&column==='data')||(table==='steps'&&column==='metadata')))throw Error(bt('sqlite.err.invalid_projection'));
      const sizes=database.prepare(`SELECT length(${column}) AS size FROM ${table} WHERE idx=?`).all(idx);
      if(sizes.length!==1)throw Error(bt('sqlite.err.projection_index_missing'));
      const statement=database.prepare(`SELECT substr(${column},?,?) AS chunk FROM ${table} WHERE idx=?`);
      let fullStatement: ReturnType<DatabaseSync['prepare']> | undefined;
      const blobSize = Number(sizes[0]!.size);
      const projected=projectProtobuf(
        blobSize,
        createSqlBlobChunkReader(
          blobSize,
          idx,
          () => statement,
          () => (fullStatement ??= database!.prepare(`SELECT ${column} AS data FROM ${table} WHERE idx=?`))
        ),
        table==='gen_metadata'?GENERATION_PROJECTION:STEP_PROJECTION,
        USAGE_PROTO_LIMITS
      );
      // Small Buffers may share Node's non-transferable slab. Give IPC its own ArrayBuffer.
      rows=[{idx,size:sizes[0]!.size,data_blob:Uint8Array.from(projected.data),projected:true,projectionBytesRead:projected.bytesRead}];
      } finally { database.exec('ROLLBACK;'); }
    } else rows = database.prepare(request.sql!).all();
    const transfers = new Set<ArrayBuffer>();
    for (const row of rows) for (const value of Object.values(row)) {
      if (value instanceof Uint8Array && value.buffer instanceof ArrayBuffer) transfers.add(value.buffer);
    }
    parentPort?.postMessage({ id: request.id, ok: true, rows }, [...transfers]);
  } catch (error) { parentPort?.postMessage({ id: request.id, ok: false, rows: [], error: (error as Error).message }); }
});
