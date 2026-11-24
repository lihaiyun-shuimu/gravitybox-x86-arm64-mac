import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { UsageStatsManager } from '../dist/usage.js';
import { UsageLedger } from '../dist/usage-ledger.js';
import { scanDatabaseEvents } from '../dist/usage-scanner.js';
import { USAGE_PROJECTION_VERSION } from '../dist/protobuf-projection.js';
import { isFileCacheEntryReusable } from '../dist/usage-types.js';
import { ProtobufWriter as W } from '../dist/protobuf.js';

function makeGenBlob({
  model = 'gemini-3.8-flash',
  input = 1000,
  output = 200,
  cached = 0,
  cacheWrite = 0,
  timestampSec = 1763700000,
  execution = 'exec-1',
  stepIndices,
}) {
  const usageFields = [
    W.encodeField(1, 0, W.encodeVarint(0)),
    W.encodeField(2, 0, W.encodeVarint(input)),
    W.encodeField(3, 0, W.encodeVarint(output)),
  ];
  if (cacheWrite > 0) usageFields.push(W.encodeField(4, 0, W.encodeVarint(cacheWrite)));
  if (cached > 0) usageFields.push(W.encodeField(5, 0, W.encodeVarint(cached)));
  const usageBuf = Buffer.concat(usageFields);

  const wrappedFields = [
    W.encodeField(4, 2, usageBuf),
    W.encodeString(19, model),
  ];
  if (timestampSec > 0) {
    const innerTiming = W.encodeVarintField(1, timestampSec);
    const timing = W.encodeField(4, 2, innerTiming);
    wrappedFields.push(W.encodeField(9, 2, timing));
  }

  const rootFields = [
    W.encodeField(1, 2, Buffer.concat(wrappedFields)),
  ];
  if (Array.isArray(stepIndices)) {
    for (const stepIdx of stepIndices) {
      rootFields.push(W.encodeField(2, 0, W.encodeVarint(stepIdx)));
    }
  }
  if (execution) {
    rootFields.push(W.encodeString(4, execution));
  }
  return Buffer.concat(rootFields);
}

async function withFixture(t, fn) {
  const root = await mkdtemp(join(tmpdir(), 'gb-btw-dedup-'));
  const stateDir = join(root, 'state');
  const geminiDir = join(root, 'gemini');
  const convDir = join(geminiDir, 'antigravity', 'conversations');
  await mkdir(stateDir, { recursive: true });
  await mkdir(convDir, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return fn({ root, stateDir, geminiDir, convDir });
}

test('USAGE_PROJECTION_VERSION bumped to 3 invalidates v2 fileCache entries', () => {
  assert.equal(USAGE_PROJECTION_VERSION, 3);
  assert.equal(
    isFileCacheEntryReusable({
      hasError: false,
      skippedLargeRecords: 0,
      size: 4096,
      projectionVersion: 2,
    }),
    false
  );
  assert.equal(
    isFileCacheEntryReusable({
      hasError: false,
      skippedLargeRecords: 0,
      size: 4096,
      projectionVersion: 3,
    }),
    true
  );
});

test('(a) scanDatabaseEvents skips cloned prefix genRows (stepIndices <= forkStepIndex) and keeps post-fork/null/empty rows', async t => {
  await withFixture(t, async ({ convDir }) => {
    const btwDbPath = join(convDir, 'btw-session.db');
    const db = new DatabaseSync(btwDbPath);
    db.exec('CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY, data BLOB); CREATE TABLE steps(idx INTEGER PRIMARY KEY, metadata BLOB);');
    db.close();

    const now = Math.floor(Date.now() / 1000) - 60;
    const genRows = [
      // Cloned prefix rows (should be skipped)
      { idx: 0, size: 100, data_blob: makeGenBlob({ input: 5000, output: 1000, timestampSec: now - 300, execution: 'ex-0', stepIndices: [0, 1] }) },
      { idx: 1, size: 100, data_blob: makeGenBlob({ input: 6000, output: 1200, timestampSec: now - 200, execution: 'ex-1', stepIndices: [3] }) },
      // Spanning fork boundary [3, 4] > forkStepIndex(3) -> kept
      { idx: 2, size: 100, data_blob: makeGenBlob({ input: 700, output: 100, timestampSec: now - 100, execution: 'ex-2', stepIndices: [3, 4] }) },
      // Strictly post-fork -> kept
      { idx: 3, size: 100, data_blob: makeGenBlob({ input: 900, output: 300, timestampSec: now - 50, execution: 'ex-3', stepIndices: [5] }) },
      // Missing field 2 (indices === null) -> kept
      { idx: 4, size: 100, data_blob: makeGenBlob({ input: 200, output: 50, timestampSec: now - 40, execution: 'ex-4', stepIndices: undefined }) },
      // Empty packed field 2 (indices.length === 0) -> kept
      {
        idx: 5,
        size: 100,
        data_blob: Buffer.concat([
          makeGenBlob({ input: 100, output: 25, timestampSec: now - 30, execution: 'ex-5', stepIndices: undefined }),
          W.encodeField(2, 2, Buffer.alloc(0)),
        ]),
      },
    ];

    const fileCache = new Map();
    let cacheDirty = false;
    const ctx = {
      discoveredStats: new Map(),
      fileCache,
      setFileCacheEntry: (p, entry) => fileCache.set(p, entry),
      markFileCacheDirty: () => { cacheDirty = true; },
      lookupObservedContext: () => null,
      loadUsageLedger: async () => {},
      upsertLedger: () => {},
      getLedgerEvent: () => undefined,
      scanDbWorker: async () => ({
        ok: true,
        genRows,
        stepSchemaOk: true,
        stepRows: [],
        trajectoryType: 2,
        forkStepIndex: 3,
        forkParentCascadeId: 'parent-main-uuid',
      }),
    };

    const res = await scanDatabaseEvents(ctx, btwDbPath, true);
    assert.equal(res.hasError, false);
    assert.equal(cacheDirty, true);
    assert.deepEqual(res.excludedForkedGenIndices, [0, 1]);
    assert.deepEqual(res.events.map(e => e.generation_index), [2, 3, 4, 5]);
    assert.deepEqual(res.events.map(e => e.input_tokens), [700, 900, 200, 100]);
  });
});

test('(b, c, d) purgeForkedClones atomically deletes pre-existing clone rows across all 4 tables, updates mirror, is idempotent, and fixes aggregate()', async t => {
  await withFixture(t, async ({ stateDir }) => {
    const ledger = new UsageLedger(stateDir);
    const now = Math.floor(Date.now() / 1000) - 120;
    const prices = {
      'gemini-3.8-flash': {
        model: 'gemini-3.8-flash',
        input: 1,
        output: 4,
        cached: 0.1,
      },
    };

    const mkKey = (label) => createHash('sha256').update(label).digest('hex');

    const mainEv0 = {
      event_key: mkKey('main-0'),
      legacy_event_key: mkKey('legacy-main-0'),
      source_id: 'src-main',
      generation_index: 0,
      db_file: 'main-convo.db',
      model: 'gemini-3.8-flash',
      input_tokens: 1_000_000,
      output_tokens: 250_000,
      cached_tokens: 0,
      total_tokens: 1_250_000,
      timestamp_seconds: now - 300,
      source_observed_at: 100,
    };
    const mainEv1 = {
      event_key: mkKey('main-1'),
      legacy_event_key: mkKey('legacy-main-1'),
      source_id: 'src-main',
      generation_index: 1,
      db_file: 'main-convo.db',
      model: 'gemini-3.8-flash',
      input_tokens: 500_000,
      output_tokens: 100_000,
      cached_tokens: 0,
      total_tokens: 600_000,
      timestamp_seconds: now - 200,
      source_observed_at: 200,
    };

    // Pre-existing cloned rows from BTW DB (same tokens as main, different source_id/db_file)
    const btwClone0OldKey = mkKey('btw-clone-0-old');
    const btwClone0 = {
      event_key: mkKey('btw-clone-0'),
      legacy_event_key: mkKey('legacy-btw-clone-0'),
      source_id: 'src-btw',
      generation_index: 0,
      db_file: 'btw-convo.db',
      model: 'gemini-3.8-flash',
      input_tokens: 1_000_000,
      output_tokens: 250_000,
      cached_tokens: 0,
      total_tokens: 1_250_000,
      timestamp_seconds: now - 300,
      source_observed_at: 300,
    };
    const btwClone1 = {
      event_key: mkKey('btw-clone-1'),
      legacy_event_key: mkKey('legacy-btw-clone-1'),
      source_id: 'src-btw',
      generation_index: 1,
      db_file: 'btw-convo.db',
      model: 'gemini-3.8-flash',
      input_tokens: 500_000,
      output_tokens: 100_000,
      cached_tokens: 0,
      total_tokens: 600_000,
      timestamp_seconds: now - 200,
      source_observed_at: 400,
    };
    const btwPostFork2 = {
      event_key: mkKey('btw-post-2'),
      legacy_event_key: mkKey('legacy-btw-post-2'),
      source_id: 'src-btw',
      generation_index: 2,
      db_file: 'btw-convo.db',
      model: 'gemini-3.8-flash',
      input_tokens: 200_000,
      output_tokens: 50_000,
      cached_tokens: 0,
      total_tokens: 250_000,
      timestamp_seconds: now - 60,
      source_observed_at: 500,
    };

    // Seed old aliased clone event first, then save all events with billingPrices so rate_locks & mirror are populated
    await ledger.save([{ ...btwClone0, event_key: btwClone0OldKey, source_id: 'src-btw-old', source_observed_at: 50 }], { billingPrices: prices });
    await ledger.save([mainEv0, mainEv1, btwClone0, btwClone1, btwPostFork2], { billingPrices: prices });

    // Ensure usage-rate-locks.json mirror exists
    const locksMirrorPath = join(stateDir, 'usage-rate-locks.json');
    const rawMirrorBefore = JSON.parse(await readFile(locksMirrorPath, 'utf8'));
    assert.ok(rawMirrorBefore.entries[btwClone0.event_key]);
    assert.ok(rawMirrorBefore.entries[btwClone1.event_key]);
    assert.ok(rawMirrorBefore.entries[mainEv0.event_key]);
    assert.ok(rawMirrorBefore.entries[btwPostFork2.event_key]);

    // Before purge: duplicated totals (main: 1.85M + btwClone: 1.85M + btwPost: 0.25M = 3.95M)
    const beforeAgg = await ledger.aggregate({ prices, accounts: [], now });
    assert.equal(beforeAgg.all_time.totals.total_tokens, 3_950_000);
    assert.equal(beforeAgg.all_time.totals.request_count, 5);
    // Main cost: (1*1 + 0.25*4) + (0.5*1 + 0.1*4) = 2.0 + 0.9 = 2.9; Clone: 2.9; Post-fork: 0.2*1 + 0.05*4 = 0.4 => 6.2
    assert.ok(Math.abs(beforeAgg.all_time.estimated_usd - 6.2) < 1e-6);

    const dbBefore = new DatabaseSync(ledger.path, { readOnly: true });
    const rateChangeVerBefore = Number(dbBefore.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM rate_changes').get().v);
    dbBefore.close();

    // Purge cloned indices [0, 1] for btw-convo.db
    const purgeRes1 = await ledger.purgeForkedClones([{ dbFile: 'btw-convo.db', excludedGenIndices: [0, 1] }]);
    // Should delete btwClone0, btwClone0OldKey, and btwClone1 = 3 rows in events
    assert.equal(purgeRes1.deleted, 3);

    // Verify all 4 tables in SQLite
    const dbAfter = new DatabaseSync(ledger.path, { readOnly: true });
    const remainingEvents = dbAfter.prepare('SELECT event_key FROM events ORDER BY event_key').all().map(r => r.event_key);
    assert.deepEqual(
      remainingEvents.sort(),
      [mainEv0.event_key, mainEv1.event_key, btwPostFork2.event_key].sort()
    );
    const cloneKeys = [btwClone0.event_key, btwClone0OldKey, btwClone1.event_key, btwClone0.legacy_event_key, btwClone1.legacy_event_key];
    for (const k of cloneKeys) {
      assert.equal(Number(dbAfter.prepare('SELECT COUNT(*) AS c FROM events WHERE event_key=?').get(k).c), 0);
      assert.equal(Number(dbAfter.prepare('SELECT COUNT(*) AS c FROM event_revisions WHERE event_key=?').get(k).c), 0);
      assert.equal(Number(dbAfter.prepare('SELECT COUNT(*) AS c FROM rate_locks WHERE event_key=?').get(k).c), 0);
      assert.equal(Number(dbAfter.prepare('SELECT COUNT(*) AS c FROM event_aliases WHERE event_key=? OR legacy_key=?').get(k, k).c), 0);
    }
    for (const keepKey of [mainEv0.event_key, mainEv1.event_key, btwPostFork2.event_key]) {
      assert.equal(Number(dbAfter.prepare('SELECT COUNT(*) AS c FROM events WHERE event_key=?').get(keepKey).c), 1);
      assert.equal(Number(dbAfter.prepare('SELECT COUNT(*) AS c FROM event_revisions WHERE event_key=?').get(keepKey).c), 1);
      assert.equal(Number(dbAfter.prepare('SELECT COUNT(*) AS c FROM rate_locks WHERE event_key=?').get(keepKey).c), 1);
    }
    const rateChangeVerAfter = Number(dbAfter.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM rate_changes').get().v);
    assert.ok(rateChangeVerAfter > rateChangeVerBefore);
    dbAfter.close();

    // Verify usage-rate-locks.json mirror refreshed
    const rawMirrorAfter = JSON.parse(await readFile(locksMirrorPath, 'utf8'));
    assert.equal(rawMirrorAfter.entries[btwClone0.event_key], undefined);
    assert.equal(rawMirrorAfter.entries[btwClone0OldKey], undefined);
    assert.equal(rawMirrorAfter.entries[btwClone1.event_key], undefined);
    assert.ok(rawMirrorAfter.entries[mainEv0.event_key]);
    assert.ok(rawMirrorAfter.entries[mainEv1.event_key]);
    assert.ok(rawMirrorAfter.entries[btwPostFork2.event_key]);

    // (c) Idempotency on repeat call
    const purgeRes2 = await ledger.purgeForkedClones([{ dbFile: 'btw-convo.db', excludedGenIndices: [0, 1] }]);
    assert.equal(purgeRes2.deleted, 0);
    const dbIdem = new DatabaseSync(ledger.path, { readOnly: true });
    assert.equal(Number(dbIdem.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM rate_changes').get().v), rateChangeVerAfter);
    dbIdem.close();

    // (d) aggregate() reflects accurate non-duplicated tokens & USD
    const afterAgg = await ledger.aggregate({ prices, accounts: [], now });
    assert.equal(afterAgg.all_time.totals.total_tokens, 2_100_000);
    assert.equal(afterAgg.all_time.totals.request_count, 3);
    assert.ok(Math.abs(afterAgg.all_time.estimated_usd - 3.3) < 1e-6);
  });
});

test('(e) UsageStatsManager purges pre-existing cloned BTW events from ledger + memory and produces accurate summary', async t => {
  await withFixture(t, async ({ stateDir, geminiDir, convDir }) => {
    const ledger = new UsageLedger(stateDir);
    const now = Math.floor(Date.now() / 1000) - 60;
    const mkKey = (label) => createHash('sha256').update(label).digest('hex');

    const mainDbPath = join(convDir, 'main-session.db');
    const btwDbPath = join(convDir, 'btw-session.db');
    await writeFile(mainDbPath, '');
    await writeFile(btwDbPath, '');

    const mainEv = {
      event_key: mkKey('mgr-main-0'),
      legacy_event_key: mkKey('mgr-legacy-main-0'),
      source_id: 'src-mgr-main',
      generation_index: 0,
      db_file: 'main-session.db',
      model: 'gemini-3.8-flash',
      input_tokens: 1_000_000,
      output_tokens: 0,
      cached_tokens: 0,
      total_tokens: 1_000_000,
      timestamp_seconds: now - 100,
      source_observed_at: 100,
    };
    const btwCloneEv = {
      event_key: mkKey('mgr-btw-clone-0'),
      legacy_event_key: mkKey('mgr-legacy-btw-clone-0'),
      source_id: 'src-mgr-btw',
      generation_index: 0,
      db_file: 'btw-session.db',
      model: 'gemini-3.8-flash',
      input_tokens: 1_000_000,
      output_tokens: 0,
      cached_tokens: 0,
      total_tokens: 1_000_000,
      timestamp_seconds: now - 100,
      source_observed_at: 200,
    };
    const btwPostEv = {
      event_key: mkKey('mgr-btw-post-1'),
      legacy_event_key: mkKey('mgr-legacy-btw-post-1'),
      source_id: 'src-mgr-btw',
      generation_index: 1,
      db_file: 'btw-session.db',
      model: 'gemini-3.8-flash',
      input_tokens: 250_000,
      output_tokens: 0,
      cached_tokens: 0,
      total_tokens: 250_000,
      timestamp_seconds: now - 30,
      source_observed_at: 300,
    };

    // Pre-populate ledger with the pre-fix duplicated state
    await ledger.save([mainEv, btwCloneEv, btwPostEv]);

    const manager = new UsageStatsManager({ stateDir, geminiDir });
    manager.discoverDatabaseFiles = async () => [mainDbPath, btwDbPath];
    manager.scanDatabaseEvents = async (dbPath) => {
      if (dbPath === mainDbPath) {
        return {
          events: [{ ...mainEv }],
          generationsScanned: 1,
          skippedLargeRecords: 0,
        };
      }
      return {
        events: [{ ...btwPostEv }],
        generationsScanned: 2,
        skippedLargeRecords: 0,
        excludedForkedGenIndices: [0],
      };
    };

    const summary = await manager.getUsageSummary(true);
    assert.equal(summary.all_time.totals.total_tokens, 1_250_000);
    assert.equal(summary.all_time.totals.request_count, 2);

    // Verify ledger on disk no longer contains btwCloneEv
    const reloaded = await new UsageLedger(stateDir).load();
    assert.deepEqual(
      reloaded.map(e => e.event_key).sort(),
      [mainEv.event_key, btwPostEv.event_key].sort()
    );
  });
});

test('P1-10: 扫描期间 WAL 文件增长时触发有界重扫，且绝不将旧事件绑定到新 WAL 指纹', async t => {
  await withFixture(t, async ({ root }) => {
    const dbPath = join(root, 'wal-race.db');
    const walPath = `${dbPath}-wal`;
    await writeFile(dbPath, 'sqlite-header-v1');
    await writeFile(walPath, 'wal-initial');

    let scanCalls = 0;
    const tsSec = Math.floor(Date.now() / 1000) - 10;
    const genRow1 = { idx: 0, data_blob: makeGenBlob({ model: 'gemini-3.8-flash', input: 100, output: 20, timestampSec: tsSec, stepIndices: [0], execution: 'wal-exec-1' }) };
    const genRow2 = { idx: 1, data_blob: makeGenBlob({ model: 'gemini-3.8-flash', input: 250, output: 20, timestampSec: tsSec + 1, stepIndices: [1], execution: 'wal-exec-2' }) };

    const fileCache = new Map();
    const ctx = {
      fileCache,
      discoveredStats: new Map(),
      loadUsageLedger: async () => {},
      upsertLedger: () => {},
      getLedgerEvent: (_k) => ({}),
      lookupObservedContext: () => null,
      setFileCacheEntry: (p, entry) => fileCache.set(p, entry),
      markFileCacheDirty: () => {},
      scanDbWorker: async () => {
        scanCalls++;
        if (scanCalls === 1) {
          // 模拟首次扫描完成到落缓存前，宿主向 WAL 追加了新记录
          await writeFile(walPath, 'wal-initial-plus-tail-append-bytes');
          return { ok: true, genRows: [genRow1], stepSchemaOk: true, stepRows: [], trajectoryType: 2 };
        }
        return { ok: true, genRows: [genRow1, genRow2], stepSchemaOk: true, stepRows: [], trajectoryType: 2 };
      },
    };

    const res1 = await scanDatabaseEvents(ctx, dbPath, false);
    assert.equal(scanCalls, 2, '检测到扫描期间 WAL 变更必须执行一次有界重扫');
    assert.equal(res1.events.length, 2, '重扫后必须立即包含尾部新增用量');

    // 再无任何写入的后续普通刷新，直接命中已更新的缓存且事件完整
    const res2 = await scanDatabaseEvents(ctx, dbPath, false);
    assert.equal(scanCalls, 2, '稳定后后续刷新命中最新缓存');
    assert.equal(res2.cacheHit, true);
    assert.equal(res2.events.length, 2);
  });
});
