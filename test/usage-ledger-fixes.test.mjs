import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, lstat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { UsageStatsManager } from '../dist/usage.js';
import { UsageLedger } from '../dist/usage-ledger.js';
import { SqliteReadSnapshot } from '../dist/sqlite-read.js';
import { USAGE_PROJECTION_VERSION } from '../dist/protobuf-projection.js';
import {
  classifyUsageWarningCode,
  buildPricingWarningCodes,
  buildUsageSummaryReport,
} from '../dist/usage-report.js';
import {
  isUnpricedZeroSentinel,
  calculateLockedEventUsd,
  formatLocalDate,
} from '../dist/usage-aggregate.js';
import { ProtobufWriter as W } from '../dist/protobuf.js';
import { setActiveLocale, getActiveLocale } from '../dist/i18n.js';

async function withFixture(t, fn) {
  const root = await mkdtemp(join(tmpdir(), 'gb-usage-fixes-'));
  const stateDir = join(root, 'state');
  const geminiDir = join(root, 'gemini');
  const convDir = join(geminiDir, 'antigravity', 'conversations');
  await mkdir(stateDir, { recursive: true });
  await mkdir(convDir, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return fn({ root, stateDir, geminiDir, convDir });
}

test('P0-04: pricing_warning_codes 中英文 1:1 并行输出且 receipts_unmatched 不污染实例 storageWarnings', async t => {
  assert.equal(classifyUsageWarningCode('旧JSON含缺少来源或归属证据的记录，已加入人工复核列表'), 'legacy_json_migrated');
  assert.equal(classifyUsageWarningCode('Legacy JSON contains entries without verified sources'), 'legacy_json_migrated');
  assert.equal(classifyUsageWarningCode('旧账本含费用反推记录，已标记待核对'), 'legacy_ledger_migrated');
  assert.equal(classifyUsageWarningCode('Legacy ledger contains synthetic receipts'), 'legacy_ledger_migrated');
  assert.equal(classifyUsageWarningCode('历史金额凭据缺少原始用量或时间，未计入汇总'), 'historical_receipts_locked');
  assert.equal(classifyUsageWarningCode('Historical cost receipts lack raw token counts or timestamps'), 'historical_receipts_locked');
  assert.equal(classifyUsageWarningCode('其他自定义提醒'), 'warning');
  assert.deepEqual(
    buildPricingWarningCodes([
      'Legacy JSON item',
      'Legacy ledger item',
      'Historical cost receipts item',
      'other',
    ]),
    ['legacy_json_migrated', 'legacy_ledger_migrated', 'historical_receipts_locked', 'warning']
  );

  const prevLocale = getActiveLocale();
  t.after(() => setActiveLocale(prevLocale));

  await withFixture(t, async ({ stateDir, geminiDir }) => {
    await writeFile(
      join(stateDir, 'usage-rate-locks.json'),
      JSON.stringify({
        version: 1,
        profiles: [{ model: 'gemini-4-carbon', input: 2, output: 10, cached: 0.1 }],
        entries: { ['a'.repeat(64)]: { usd: 0.05, p: 0 } },
      })
    );

    for (const locale of ['zh-Hans', 'en']) {
      setActiveLocale(locale);
      const manager = new UsageStatsManager({ stateDir, geminiDir });
      const summary = await manager.getUsageSummary(true);
      assert.ok(Array.isArray(summary.pricing_warning_codes));
      assert.equal(summary.pricing_warning_codes.length, summary.pricing_warnings.length);
      assert.ok(summary.pricing_warning_codes.includes('historical_receipts_locked'));
    }

    // 同一实例先遇未匹配凭据，再在后续扫描中补齐对应事件时，实例 storageWarnings 不得残留上轮 receipts_unmatched
    const manager = new UsageStatsManager({ stateDir, geminiDir });
    let includeReceiptEvent = false;
    manager.discoverDatabaseFiles = async () => ['synthetic-receipt.db'];
    manager.scanDatabaseEvents = async () => ({
      events: includeReceiptEvent
        ? [
            {
              event_key: 'a'.repeat(64),
              source_id: 'src-receipt',
              model: 'gemini-4-carbon',
              input_tokens: 100,
              output_tokens: 10,
              cached_tokens: 0,
              total_tokens: 110,
              timestamp_seconds: Math.floor(Date.now() / 1000) - 30,
            },
          ]
        : [],
      generationsScanned: includeReceiptEvent ? 1 : 0,
      skippedLargeRecords: 0,
    });
    const withReceipt = await manager.getUsageSummary(true);
    assert.ok(withReceipt.pricing_warning_codes.includes('historical_receipts_locked'));

    includeReceiptEvent = true;
    const afterMatched = await manager.getUsageSummary(true);
    assert.equal(afterMatched.pricing_warning_codes.includes('historical_receipts_locked'), false);
    assert.equal(afterMatched.availability, 'complete');
  });
});

test('P0-10 & P0-11: zero-sentinel 与缺失 cacheWrite 锁在 lockedCost 与 ledgerEventPage 中统一标记未计价且不抛错', async t => {
  assert.equal(isUnpricedZeroSentinel({ model: 'legacy', input: 0, output: 0, cached: 0 }), true);
  assert.equal(isUnpricedZeroSentinel({ model: 'legacy', input: 0, output: 0, cached: 0, cacheWrite: 0 }), true);
  assert.equal(
    isUnpricedZeroSentinel({ model: 'free', input: 0, output: 0, cached: 0, provenance: { verification: 'confirmed' } }),
    false
  );
  assert.equal(isUnpricedZeroSentinel({ model: 'paid', input: 0, output: 1, cached: 0 }), false);

  assert.equal(
    calculateLockedEventUsd(
      { input_tokens: 1000, output_tokens: 500, cached_tokens: 200, cache_write_tokens: 100 },
      { model: 'm', input: 1, output: 2, cached: 0.1 }
    ),
    null
  );
  assert.equal(
    calculateLockedEventUsd(
      { input_tokens: 1000, output_tokens: 500, cached_tokens: 200, cache_write_tokens: 0 },
      { model: 'm', input: 0, output: 0, cached: 0 }
    ),
    null
  );
  const tieredLockedUsd = calculateLockedEventUsd(
    { input_tokens: 150_000, output_tokens: 0, cached_tokens: 60_000, cache_write_tokens: 0 },
    {
      model: 'tier',
      input: 1,
      output: 2,
      cached: 0.1,
      contextTiers: [{ thresholdTokens: 200_000, input: 3, output: 6, cached: 0.3 }],
    }
  );
  assert.ok(Math.abs(tieredLockedUsd - 0.468) < 1e-12);

  await withFixture(t, async ({ stateDir, geminiDir }) => {
    const now = Math.floor(Date.now() / 1000);
    const kZero = '1'.repeat(64);
    const kNoCw = '2'.repeat(64);

    // 1. 小账本 lockedCost：跳过 zero-sentinel 锁，且在实时费率也无 cacheWrite 时返回 null 而不抛错
    await writeFile(
      join(stateDir, 'usage-rate-locks.json'),
      JSON.stringify({
        version: 1,
        profiles: [
          { model: 'gemini-2.5-flash', input: 0, output: 0, cached: 0 },
          { model: 'custom-no-cw', input: 1, output: 2, cached: 0.1 },
        ],
        entries: {
          [kZero]: { usd: 0, p: 0 },
          [kNoCw]: { usd: 0.5, p: 1 },
        },
      })
    );

    const manager = new UsageStatsManager({ stateDir, geminiDir });
    await manager.savePricingTable({
      'custom-no-cw': { model: 'custom-no-cw', input: 1, output: 2, cached: 0.1 },
    });
    manager.discoverDatabaseFiles = async () => ['synthetic.db'];
    manager.scanDatabaseEvents = async () => ({
      events: [
        {
          event_key: kZero,
          source_id: 'src-1',
          model: 'gemini-2.5-flash',
          input_tokens: 1_000_000,
          output_tokens: 0,
          cached_tokens: 0,
          total_tokens: 1_000_000,
          timestamp_seconds: now - 60,
        },
        {
          event_key: kNoCw,
          source_id: 'src-2',
          model: 'custom-no-cw',
          input_tokens: 1000,
          output_tokens: 100,
          cached_tokens: 0,
          cache_write_tokens: 500,
          total_tokens: 1600,
          timestamp_seconds: now - 30,
        },
      ],
      generationsScanned: 2,
      skippedLargeRecords: 0,
    });

    const summary = await manager.getUsageSummary(true);
    const flashStat = summary.all_time.by_model.find(m => m.model === 'gemini-2.5-flash');
    const noCwStat = summary.all_time.by_model.find(m => m.model === 'custom-no-cw');
    assert.ok(flashStat && flashStat.priced === true && flashStat.estimated_usd > 0, 'zero-sentinel 锁应被跳过并改用真实实时费率');
    assert.ok(noCwStat && noCwStat.priced === false && noCwStat.estimated_usd === 0, '缺少 cacheWrite 时不应使用缺字段旧锁或抛错');

    // 2. Worker / ledgerEventPage 口径一致性：zero-sentinel 与缺 cacheWrite 锁返回 estimated_usd: null, priced: false
    const ledger = new UsageLedger(join(stateDir, 'isolated-ledger'));
    const evZero = {
      event_key: '3'.repeat(64),
      source_id: 'src-3',
      model: 'unpriced-legacy-zero',
      input_tokens: 1000,
      output_tokens: 500,
      cached_tokens: 0,
      total_tokens: 1500,
      timestamp_seconds: now - 20,
    };
    const evNoCw = {
      event_key: '4'.repeat(64),
      source_id: 'src-4',
      model: 'unpriced-legacy-nocw',
      input_tokens: 1000,
      output_tokens: 500,
      cached_tokens: 0,
      cache_write_tokens: 100,
      total_tokens: 1600,
      timestamp_seconds: now - 10,
    };
    await ledger.save([evZero, evNoCw]);
    await ledger.saveLocks({
      [evZero.event_key]: { usd: 0, price: { model: 'unpriced-legacy-zero', input: 0, output: 0, cached: 0 } },
      [evNoCw.event_key]: { usd: 0.5, price: { model: 'unpriced-legacy-nocw', input: 1, output: 2, cached: 0.1 } },
    });

    const agg = await ledger.aggregate({ prices: {}, accountId: 'all', accounts: [], now });
    assert.equal(agg.all_time.estimated_usd, 0);
    assert.ok(agg.all_time.by_model.every(m => m.priced === false));

    const page = await ledger.events({
      snapshot: agg.ledger_snapshot,
      period: 'all',
      query: '',
      offset: 0,
      limit: 10,
    });
    assert.equal(page.total, 2);
    for (const row of page.rows) {
      assert.equal(row.estimated_usd, null);
      assert.equal(row.priced, false);
    }
  });
});

test('P1-08 & P1-13: 未来偏移时间不污染日趋势、buildUsageSummaryReport 空有效集合按 allEvents 判可用性、失败缓存跨午夜失效', async t => {
  const fixedNoon = new Date(2026, 10, 15, 12, 0, 0, 0);
  const now = Math.floor(fixedNoon.getTime() / 1000);
  const tomorrowStart = Math.floor(new Date(2026, 10, 16, 0, 0, 0, 0).getTime() / 1000);
  const todayStr = formatLocalDate(fixedNoon);

  // 1. buildUsageSummaryReport: future event 保留在 all_time，但不进入 daily_trends 或 today
  const report = buildUsageSummaryReport({
    allEvents: [
      {
        event_key: 'a'.repeat(64),
        model: 'gemini-2.5-flash',
        input_tokens: 100,
        output_tokens: 0,
        cached_tokens: 0,
        total_tokens: 100,
        timestamp_seconds: now - 60,
      },
      {
        event_key: 'b'.repeat(64),
        model: 'gemini-2.5-flash',
        input_tokens: 200,
        output_tokens: 0,
        cached_tokens: 0,
        total_tokens: 200,
        timestamp_seconds: tomorrowStart + 3600,
      },
    ],
    effectiveEvents: [
      {
        event_key: 'a'.repeat(64),
        model: 'gemini-2.5-flash',
        input_tokens: 100,
        output_tokens: 0,
        cached_tokens: 0,
        total_tokens: 100,
        timestamp_seconds: now - 60,
      },
      {
        event_key: 'b'.repeat(64),
        model: 'gemini-2.5-flash',
        input_tokens: 200,
        output_tokens: 0,
        cached_tokens: 0,
        total_tokens: 200,
        timestamp_seconds: tomorrowStart + 3600,
      },
    ],
    knownReceiptKeys: new Set(),
    unattributedRequests: 0,
    unattributedTokens: 0,
    accountMap: new Map([['all', { id: 'all', label: 'All', type: 'all', total_tokens: 0, request_count: 0 }]]),
    accountId: 'all',
    accKey: 'all',
    now,
    rawPricing: {},
    pricing: {},
    calKey: todayStr,
    rateLocks: {},
    resolvePricing: () => null,
    lockedCost: () => null,
    dbPathsCount: 1,
    archivedDbCount: 0,
    lastDiscoveredDatabaseCount: 1,
    cachedDatabasesCount: 0,
    liveEventsCount: 2,
    generationsScanned: 2,
    skippedLargeRecords: 0,
    failedDatabasesCount: 0,
    diagnostics: [],
    ledgerCorrupt: false,
    archivedUnavailable: false,
    storageWarnings: new Set(),
    pricingWarnings: [],
  });
  assert.equal(report.all_time.totals.request_count, 2);
  assert.equal(report.today.totals.request_count, 1);
  assert.equal(report.daily_trends.length, 30);
  assert.equal(report.daily_trends.at(-1)?.date, todayStr);
  assert.equal(report.daily_trends.some(d => d.date > todayStr), false);
  assert.equal(report.daily_trends.at(-1)?.request_count, 1);
  assert.equal(report.today_hourly.reduce((s, h) => s + h.request_count, 0), 1);

  // P1-13: allEvents 非空而 effectiveEvents 为空时，不得仅因筛选/未归属空集错标为 unavailable
  const filteredEmptyReport = buildUsageSummaryReport({
    allEvents: [
      {
        event_key: 'c'.repeat(64),
        model: 'gemini-2.5-flash',
        input_tokens: 50,
        output_tokens: 0,
        cached_tokens: 0,
        total_tokens: 50,
        timestamp_seconds: now - 60,
      },
    ],
    effectiveEvents: [],
    knownReceiptKeys: new Set(),
    unattributedRequests: 0,
    unattributedTokens: 0,
    accountMap: new Map([['all', { id: 'all', label: 'All', type: 'all', total_tokens: 0, request_count: 0 }]]),
    accountId: 'acc-empty',
    accKey: 'acc-empty',
    now,
    rawPricing: {},
    pricing: {},
    calKey: todayStr,
    rateLocks: {},
    resolvePricing: () => null,
    lockedCost: () => null,
    dbPathsCount: 0,
    archivedDbCount: 0,
    lastDiscoveredDatabaseCount: 0,
    cachedDatabasesCount: 0,
    liveEventsCount: 0,
    generationsScanned: 0,
    skippedLargeRecords: 0,
    failedDatabasesCount: 1,
    diagnostics: [],
    ledgerCorrupt: false,
    archivedUnavailable: false,
    storageWarnings: new Set(),
    pricingWarnings: [],
  });
  assert.equal(filteredEmptyReport.availability, 'partial');

  // 2. aggregateLedger 同样拦截 >= tomorrowStart 的未来时间戳进入 daily_trends
  await withFixture(t, async ({ stateDir, geminiDir }) => {
    const ledger = new UsageLedger(join(stateDir, 'agg-future'));
    await ledger.save([
      {
        event_key: 'd'.repeat(64),
        source_id: 's1',
        model: 'gemini-2.5-flash',
        input_tokens: 100,
        output_tokens: 0,
        cached_tokens: 0,
        total_tokens: 100,
        timestamp_seconds: now - 60,
      },
      {
        event_key: 'e'.repeat(64),
        source_id: 's2',
        model: 'gemini-2.5-flash',
        input_tokens: 200,
        output_tokens: 0,
        cached_tokens: 0,
        total_tokens: 200,
        timestamp_seconds: tomorrowStart + 3600,
      },
    ]);
    const agg = await ledger.aggregate({ prices: {}, accountId: 'all', accounts: [], now });
    assert.equal(agg.all_time.totals.request_count, 2);
    assert.equal(agg.today.totals.request_count, 1);
    assert.equal(agg.daily_trends.length, 30);
    assert.equal(agg.daily_trends.at(-1)?.date, todayStr);
    assert.equal(agg.daily_trends.some(d => d.date > todayStr), false);
    assert.equal(agg.daily_trends.at(-1)?.request_count, 1);

    // 3. 失败缓存跨午夜失效：23:59:50 成功写入缓存 -> 00:00:05 扫描失败时不得返回昨天的 cachedSummary
    const RealDate = Date;
    let fakeNowMs = new RealDate(2026, 10, 15, 23, 59, 50, 0).getTime();
    class FixedDate extends RealDate {
      constructor(...args) {
        super(...(args.length ? args : [fakeNowMs]));
      }
      static now() {
        return fakeNowMs;
      }
    }
    globalThis.Date = FixedDate;
    t.after(() => {
      globalThis.Date = RealDate;
    });

    const mgr = new UsageStatsManager({ stateDir: join(stateDir, 'midnight'), geminiDir });
    const eventTs = Math.floor(new RealDate(2026, 10, 15, 23, 50, 0, 0).getTime() / 1000);
    let failDb = false;
    mgr.discoverDatabaseFiles = async () => ['synthetic-midnight.db'];
    mgr.scanDatabaseEvents = async () => {
      if (failDb) {
        return { events: [], generationsScanned: 0, skippedLargeRecords: 0, hasError: true, error: 'read failed' };
      }
      return {
        events: [
          {
            event_key: 'f'.repeat(64),
            source_id: 's-mid',
            model: 'gemini-2.5-flash',
            input_tokens: 100,
            output_tokens: 0,
            cached_tokens: 0,
            total_tokens: 100,
            timestamp_seconds: eventTs,
          },
        ],
        generationsScanned: 1,
        skippedLargeRecords: 0,
      };
    };

    const day1 = await mgr.getUsageSummary(true);
    assert.equal(day1.today.totals.request_count, 1);

    fakeNowMs = new RealDate(2026, 10, 16, 0, 0, 5, 0).getTime();
    failDb = true;
    const day2 = await mgr.getUsageSummary(false);
    assert.equal(day2.today.totals.request_count, 0, '跨午夜后遇到读取失败不能复用前一日 cached 汇总');
  });
});

test('P1-11 & P1-12: revalueLedger 轻量级快照库、排除项对齐、dryRun/restore、confirmed $0 保留与 saveLocks 删除遗留锁', async t => {
  await withFixture(t, async ({ stateDir }) => {
    const ledger = new UsageLedger(join(stateDir, 'revalue-store'));
    const now = Math.floor(Date.now() / 1000);
    const kPriced = '1'.repeat(64);
    const kConfirmedFree = '2'.repeat(64);
    const kZeroSentinel = '3'.repeat(64);
    const kSynthetic = '4'.repeat(64);
    const kLiveNoSource = '5'.repeat(64);
    const kStale = '6'.repeat(64);

    await ledger.save([
      {
        event_key: kPriced,
        source_id: 's1',
        db_file: 'live.db',
        model: 'test-paid',
        input_tokens: 1_000_000,
        output_tokens: 0,
        cached_tokens: 0,
        total_tokens: 1_000_000,
        timestamp_seconds: now - 100,
      },
      {
        event_key: kConfirmedFree,
        source_id: 's2',
        db_file: 'live.db',
        model: 'free-model',
        input_tokens: 1_000_000,
        output_tokens: 0,
        cached_tokens: 0,
        total_tokens: 1_000_000,
        timestamp_seconds: now - 90,
      },
      {
        event_key: kZeroSentinel,
        source_id: 's3',
        db_file: 'live.db',
        model: 'test-paid',
        input_tokens: 1_000_000,
        output_tokens: 0,
        cached_tokens: 0,
        total_tokens: 1_000_000,
        timestamp_seconds: now - 80,
      },
      {
        event_key: kSynthetic,
        source_id: 's4',
        db_file: 'recovered_session.db',
        model: 'test-paid',
        input_tokens: 1_000_000,
        output_tokens: 0,
        cached_tokens: 0,
        total_tokens: 1_000_000,
        timestamp_seconds: now - 70,
      },
      {
        event_key: kLiveNoSource,
        db_file: 'live.db',
        model: 'test-paid',
        input_tokens: 1_000_000,
        output_tokens: 0,
        cached_tokens: 0,
        total_tokens: 1_000_000,
        timestamp_seconds: now - 60,
      },
    ]);

    // P1-12: saveLocks 必须清理不再存在的旧键
    await ledger.saveLocks({
      [kPriced]: { usd: 9.99, price: { model: 'test-paid', input: 9.99, output: 0, cached: 0 } },
      [kConfirmedFree]: { usd: 0, price: { model: 'free-model', input: 0, output: 0, cached: 0, provenance: { verification: 'confirmed' } } },
      [kZeroSentinel]: { usd: 0, price: { model: 'test-paid', input: 0, output: 0, cached: 0 } },
      [kSynthetic]: { usd: 50, price: { model: 'test-paid', input: 50, output: 0, cached: 0 } },
      [kLiveNoSource]: { usd: 40, price: { model: 'test-paid', input: 40, output: 0, cached: 0 } },
      [kStale]: { usd: 1, price: { model: 'stale', input: 1, output: 0, cached: 0 } },
    });
    assert.equal(Object.hasOwn(await ledger.locks(), kStale), true);

    await ledger.saveLocks({
      [kPriced]: { usd: 9.99, price: { model: 'test-paid', input: 9.99, output: 0, cached: 0 } },
      [kConfirmedFree]: { usd: 0, price: { model: 'free-model', input: 0, output: 0, cached: 0, provenance: { verification: 'confirmed' } } },
      [kZeroSentinel]: { usd: 0, price: { model: 'test-paid', input: 0, output: 0, cached: 0 } },
      [kSynthetic]: { usd: 50, price: { model: 'test-paid', input: 50, output: 0, cached: 0 } },
      [kLiveNoSource]: { usd: 40, price: { model: 'test-paid', input: 40, output: 0, cached: 0 } },
    });
    assert.equal(Object.hasOwn(await ledger.locks(), kStale), false, 'P1-12: saveLocks 必须删除已被淘汰的遗留锁');

    const prices = {
      'test-paid': { model: 'test-paid', input: 2.0, output: 0, cached: 0 },
      'free-model': { model: 'free-model', input: 5.0, output: 0, cached: 0 },
    };

    // mode: unpriced_only 仅重估未定价值守卫 (kZeroSentinel -> $2)，保留 kPriced ($9.99) 与 confirmed $0 (kConfirmedFree)
    const previewUnpriced = await ledger.revalue({
      action: 'preview',
      mode: 'unpriced_only',
      prices,
      liveFiles: ['live.db'],
      now,
    });
    assert.equal(previewUnpriced.before, 9.99);
    assert.equal(previewUnpriced.after, 11.99);

    // 轻量快照库：backup 与 candidate 仅含 rate_locks，绝不复制全量 events/event_revisions 表
    for (const dbFile of [previewUnpriced.backup, previewUnpriced.candidate]) {
      const snapDb = new DatabaseSync(dbFile, { readOnly: true });
      try {
        const tables = snapDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
        assert.equal(tables.includes('rate_locks'), true);
        assert.equal(tables.includes('events'), false);
        assert.equal(tables.includes('event_revisions'), false);
      } finally {
        snapDb.close();
      }
    }

    // dryRun preview 不得改动主库锁表
    assert.equal((await ledger.locks())[kZeroSentinel].usd, 0);

    // force_all 预览 + apply + restore 全闭环
    const previewAll = await ledger.revalue({
      action: 'preview',
      mode: 'force_all',
      prices,
      liveFiles: ['live.db'],
      now,
    });
    assert.equal(previewAll.before, 9.99);
    assert.equal(previewAll.after, 9.0); // kPriced (2) + kConfirmedFree (5) + kZeroSentinel (2)

    await ledger.revalue({
      action: 'apply',
      previewId: previewAll.previewId,
      confirmed: true,
      prices,
      liveFiles: ['live.db'],
      now,
    });
    assert.equal((await ledger.aggregate({ prices, accountId: 'all', accounts: [], liveFiles: ['live.db'], now })).all_time.estimated_usd, 9.0);

    await ledger.revalue({
      action: 'restore',
      previewId: previewAll.previewId,
      confirmed: true,
      prices,
      liveFiles: ['live.db'],
      now,
    });
    const restoredLocks = await ledger.locks();
    assert.equal(restoredLocks[kPriced].usd, 9.99);
    assert.equal(restoredLocks[kZeroSentinel].usd, 0);
    assert.equal((await ledger.aggregate({ prices: {}, accountId: 'all', accounts: [], liveFiles: ['live.db'], now })).all_time.estimated_usd, 9.99);
    assert.equal((await ledger.aggregate({ prices, accountId: 'all', accounts: [], liveFiles: ['live.db'], now })).all_time.estimated_usd, 11.99);
  });
});

test('P1-13 & P1-14: >16MB 未投影 steps 计入 skippedLargeRecords、getUsageEvents all 快照子账号过滤与 xhigh 模型检索', async t => {
  await withFixture(t, async ({ stateDir, geminiDir, convDir }) => {
    // 1. >16MB 未投影 steps 触发 skippedLargeRecords++
    const bigStepsDb = join(convDir, 'big-steps.db');
    const db = new DatabaseSync(bigStepsDb);
    db.exec('CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY,data BLOB);CREATE TABLE steps(idx INTEGER PRIMARY KEY,step_type INTEGER,metadata BLOB)');
    const genBlob = Buffer.concat([
      W.encodeLengthDelimited(
        1,
        Buffer.concat([W.encodeString(19, 'gemini-2.5-flash'), W.encodeLengthDelimited(4, W.encodeVarintField(2, 42))])
      ),
      W.encodeLengthDelimited(2, W.encodeVarint(130)),
    ]);
    db.prepare('INSERT INTO gen_metadata VALUES(?,?)').run(0, genBlob);
    // field 9 length-delimited 超过 STEP_PROJECTION 安全上限，导致 projectBlob 失败且 size > 16MB
    const oversizedStepMeta = W.encodeLengthDelimited(9, Buffer.alloc(16 * 1024 * 1024 + 64));
    db.prepare('INSERT INTO steps VALUES(?,15,?)').run(130, oversizedStepMeta);
    db.close();

    const scannerMgr = new UsageStatsManager({ stateDir: join(stateDir, 'scan'), geminiDir });
    const scan = await scannerMgr.scanDatabaseEvents(bigStepsDb);
    assert.equal(scan.skippedLargeRecords, 1, '超过 16MB 且未成功投影的 steps 行必须计入 skippedLargeRecords');

    // 2. getUsageEvents 在 'all' 快照下支持按 accountId 子过滤，且 ledger/events 搜索归一化 xhigh/extra-high
    const now = Math.floor(Date.now() / 1000);
    const mgr = new UsageStatsManager({ stateDir: join(stateDir, 'events'), geminiDir });
    mgr.setKnownAccounts([
      { id: 'acc-1', email: 'one@example.invalid', name: 'One' },
      { id: 'acc-2', email: 'two@example.invalid', name: 'Two' },
    ]);
    mgr.discoverDatabaseFiles = async () => ['synthetic-events.db'];
    mgr.scanDatabaseEvents = async () => ({
      events: [
        {
          event_key: '7'.repeat(64),
          source_id: 's-acc1',
          model: 'claude-opus-5-5-xhigh',
          input_tokens: 100,
          output_tokens: 50,
          cached_tokens: 0,
          total_tokens: 150,
          timestamp_seconds: now - 30,
          account_id: 'acc-1',
          account_email: 'one@example.invalid',
          account_confidence: 'observed',
        },
        {
          event_key: '8'.repeat(64),
          source_id: 's-acc2',
          model: 'gemini-3.8-flash-extra-high',
          input_tokens: 200,
          output_tokens: 50,
          cached_tokens: 0,
          total_tokens: 250,
          timestamp_seconds: now - 20,
          account_id: 'acc-2',
          account_email: 'two@example.invalid',
          account_confidence: 'observed',
        },
      ],
      generationsScanned: 2,
      skippedLargeRecords: 0,
    });

    const allSummary = await mgr.getUsageSummary(true, 'all');
    const acc1Filtered = await mgr.getUsageEvents('all', '', 0, 20, allSummary.snapshot_id, false, false, 'acc-1');
    assert.equal(acc1Filtered.total, 1);
    assert.equal(acc1Filtered.rows[0].account_id, 'acc-1');
    assert.equal(acc1Filtered.rows[0].model, 'claude-opus-5-5-xhigh');

    // 3. ledgerEventPage 归一化查询：xhigh / extra-high 与占位符别名映射
    const ledger = new UsageLedger(join(stateDir, 'search-norm'));
    await ledger.save([
      {
        event_key: '7'.repeat(64),
        source_id: 's-acc1',
        model: 'claude-opus-5-5-xhigh',
        input_tokens: 100,
        output_tokens: 50,
        cached_tokens: 0,
        total_tokens: 150,
        timestamp_seconds: now - 30,
        account_id: 'acc-1',
        account_email: 'one@example.invalid',
      },
      {
        event_key: '8'.repeat(64),
        source_id: 's-acc2',
        model: 'MODEL_PLACEHOLDER_M669',
        input_tokens: 200,
        output_tokens: 50,
        cached_tokens: 0,
        total_tokens: 250,
        timestamp_seconds: now - 20,
        account_id: 'acc-2',
        account_email: 'two@example.invalid',
      },
    ]);
    const agg = await ledger.aggregate({ prices: {}, accountId: 'all', accounts: [], now });
    const opusPage = await ledger.events({
      snapshot: agg.ledger_snapshot,
      period: 'all',
      query: 'claude-opus-5-5-extra-high',
      offset: 0,
      limit: 20,
    });
    assert.equal(opusPage.total, 1);
    assert.equal(opusPage.rows[0].account_id, 'acc-1');

    const flashPage = await ledger.events({
      snapshot: agg.ledger_snapshot,
      period: 'all',
      query: 'gemini-3.8-flash',
      offset: 0,
      limit: 20,
    });
    assert.equal(flashPage.total, 1);
    assert.equal(flashPage.rows[0].model, 'gemini-3.8-flash');
  });
});

test('P1-3: 未知模型盘上语言中立存储与中英切换零分裂聚合/检索', async t => {
  const prevLocale = getActiveLocale();
  t.after(() => setActiveLocale(prevLocale));

  await withFixture(t, async ({ stateDir, geminiDir, convDir }) => {
    const unknownDb = join(convDir, 'unknown-locale-neutral.db');
    const now = Math.floor(Date.now() / 1000);
    const db = new DatabaseSync(unknownDb);
    db.exec('CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY,data BLOB);CREATE TABLE steps(idx INTEGER PRIMARY KEY,step_type INTEGER,metadata BLOB)');
    const genBlob = Buffer.concat([
      W.encodeLengthDelimited(1, W.encodeLengthDelimited(4, W.encodeVarintField(2, 120))),
      W.encodeLengthDelimited(2, W.encodeVarint(1)),
    ]);
    db.prepare('INSERT INTO gen_metadata VALUES(0,?)').run(genBlob);
    const stepMeta = Buffer.concat([
      W.encodeLengthDelimited(1, W.encodeVarintField(1, now - 30)),
      W.encodeLengthDelimited(9, W.encodeVarintField(2, 120)),
    ]);
    db.prepare('INSERT INTO steps VALUES(1,15,?)').run(stepMeta);
    db.close();

    setActiveLocale('en');
    const mgr = new UsageStatsManager({ stateDir: join(stateDir, 'neutral-unknown'), geminiDir });
    const scannedEn = await mgr.scanDatabaseEvents(unknownDb);
    assert.equal(scannedEn.events.length, 1);
    assert.equal(scannedEn.events[0].model, '未知模型');

    const ledger = new UsageLedger(join(stateDir, 'neutral-ledger'));
    await ledger.save([
      scannedEn.events[0],
      {
        event_key: '9'.repeat(64),
        source_id: 'legacy-en-unknown',
        model: 'Unknown Model',
        input_tokens: 80,
        output_tokens: 20,
        cached_tokens: 0,
        total_tokens: 100,
        timestamp_seconds: now - 15,
      },
    ]);

    setActiveLocale('en');
    const aggEn = await ledger.aggregate({ prices: {}, accountId: 'all', accounts: [], now });
    assert.equal(aggEn.all_time.by_model.length, 1);
    assert.equal(aggEn.all_time.by_model[0].model, 'Unknown Model');
    assert.equal(aggEn.all_time.by_model[0].request_count, 2);

    const searchEn = await ledger.events({
      snapshot: aggEn.ledger_snapshot,
      period: 'all',
      query: 'unknown model',
      offset: 0,
      limit: 10,
    });
    assert.equal(searchEn.total, 2);
    assert.ok(searchEn.rows.every(r => r.model === 'Unknown Model'));

    setActiveLocale('zh-Hans');
    const aggZh = await ledger.aggregate({ prices: {}, accountId: 'all', accounts: [], now });
    assert.equal(aggZh.all_time.by_model.length, 1);
    assert.equal(aggZh.all_time.by_model[0].model, '未知模型');
    assert.equal(aggZh.all_time.by_model[0].request_count, 2);
  });
});

test('跨 source_id 三轮以上归并、存量重复自愈、稳定 source_id 与大总账持久化缓存', async t => {
  await withFixture(t, async ({ stateDir, geminiDir, convDir }) => {
    const now = Math.floor(Date.now() / 1000);

    // 1. 验证连续 3 次 source_id 漂移（含 timestamp=0 补齐及不同观察顺序）不产生重复计数，并保留 observed 归属与 rate_locks
    const multiLedger = new UsageLedger(join(stateDir, 'multi-src-dedup'));
    const legKey = createHash('sha256').update('legacy-multi-src-1').digest('hex');
    const k1 = 'a'.repeat(64);
    const k2 = 'b'.repeat(64);
    const k3 = 'c'.repeat(64);
    const k4 = 'd'.repeat(64);
    const accounts = [{ id: 'acc-1', email: 'alice@example.invalid', name: 'Alice' }];

    await multiLedger.save([
      {
        event_key: k1,
        source_id: 'src-dev-16',
        db_file: 'conv-dup.db',
        generation_index: 0,
        legacy_event_key: legKey,
        model: 'gemini-3.8-flash',
        input_tokens: 1000,
        output_tokens: 500,
        cached_tokens: 0,
        total_tokens: 1500,
        timestamp_seconds: 0,
        account_id: 'acc-1',
        account_email: 'alice@example.invalid',
        account_confidence: 'observed',
        source_observed_at: 100,
      },
    ]);
    await multiLedger.saveLocks({
      [k1]: { usd: 0.2, price: { model: 'gemini-3.8-flash', input: 100, output: 200, cached: 1 } },
    });

    // 第 2 轮（dev 变化）并补齐真实时间戳
    await multiLedger.save([
      {
        event_key: k2,
        source_id: 'src-dev-15',
        db_file: 'conv-dup.db',
        generation_index: 0,
        legacy_event_key: legKey,
        model: 'gemini-3.8-flash',
        input_tokens: 1000,
        output_tokens: 500,
        cached_tokens: 0,
        total_tokens: 1500,
        timestamp_seconds: now - 120,
        account_confidence: 'unknown',
        source_observed_at: 200,
      },
    ]);

    // 第 3、4 轮（继续变换 source_id，模拟多次重启后跨版本迁移）
    await multiLedger.save([
      {
        event_key: k3,
        source_id: 'src-dev-14',
        db_file: 'conv-dup.db',
        generation_index: 0,
        legacy_event_key: legKey,
        model: 'gemini-3.8-flash',
        input_tokens: 1000,
        output_tokens: 500,
        cached_tokens: 0,
        total_tokens: 1500,
        timestamp_seconds: now - 120,
        account_confidence: 'unknown',
        source_observed_at: 300,
      },
    ]);
    await multiLedger.save([
      {
        event_key: k4,
        source_id: 'src-stable',
        db_file: 'conv-dup.db',
        generation_index: 0,
        legacy_event_key: legKey,
        model: 'gemini-3.8-flash',
        input_tokens: 1000,
        output_tokens: 500,
        cached_tokens: 0,
        total_tokens: 1500,
        timestamp_seconds: now - 120,
        account_confidence: 'unknown',
        source_observed_at: 400,
      },
    ]);

    const aggMulti = await multiLedger.aggregate({ prices: {}, accountId: 'all', accounts, now });
    assert.equal(aggMulti.all_time.totals.request_count, 1, '4 轮 source_id 漂移后只能统计 1 条');
    assert.equal(aggMulti.all_time.totals.total_tokens, 1500);
    assert.equal(aggMulti.all_time.estimated_usd, 0.2);
    assert.equal(aggMulti.historical_amount_receipts?.unmatchedCount, 0);
    const aliceSummary = aggMulti.available_accounts?.find(a => a.id === 'acc-1');
    assert.equal(aliceSummary?.request_count, 1, '归并后必须保留 observed 账号归属');
    const pageMulti = await multiLedger.events({ snapshot: aggMulti.ledger_snapshot, period: 'all', query: '', offset: 0, limit: 10 });
    assert.equal(pageMulti.total, 1);
    assert.equal(pageMulti.rows[0].account_id, 'acc-1');

    // 2. 验证存量损坏库（两条同 legacy_event_key 均未进 event_aliases）在首次 aggregate 时自动自愈去重
    const dirtyState = join(stateDir, 'dirty-ledger');
    await mkdir(dirtyState, { recursive: true });
    const dirtyDbPath = join(dirtyState, 'usage-ledger-v2.sqlite');
    const rawDb = new DatabaseSync(dirtyDbPath);
    rawDb.exec(`
      CREATE TABLE events(event_key TEXT PRIMARY KEY, timestamp INTEGER NOT NULL, account_id TEXT, model TEXT NOT NULL, payload TEXT NOT NULL, observed_at REAL NOT NULL DEFAULT 0);
      CREATE TABLE event_revisions(seq INTEGER PRIMARY KEY AUTOINCREMENT,event_key TEXT NOT NULL,timestamp INTEGER NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE rate_locks(event_key TEXT PRIMARY KEY,unit_price TEXT NOT NULL,usd REAL NOT NULL);
      CREATE TABLE event_aliases(legacy_key TEXT PRIMARY KEY,event_key TEXT NOT NULL);
      CREATE TABLE rate_changes(version INTEGER PRIMARY KEY,min_event_seq INTEGER NOT NULL);
      CREATE TABLE snapshot_pins(snapshot_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE ledger_maintenance(key TEXT PRIMARY KEY,last_run INTEGER NOT NULL);
      PRAGMA user_version=2;
    `);
    const dupLegacy = createHash('sha256').update('legacy-corrupt-dup').digest('hex');
    const oldWin = '1'.repeat(64);
    const newDup = '2'.repeat(64);
    const pOld = JSON.stringify({
      event_key: oldWin,
      source_id: 'old-src',
      db_file: 'archived-conv.db',
      generation_index: 5,
      legacy_event_key: dupLegacy,
      model: 'gemini-3.8-flash',
      input_tokens: 2000,
      output_tokens: 500,
      cached_tokens: 0,
      total_tokens: 2500,
      timestamp_seconds: now - 3600,
      account_id: 'acc-1',
      account_email: 'alice@example.invalid',
      account_confidence: 'observed',
      source_observed_at: 1000,
      ingested_at: '2026-11-12T10:00:00.000Z',
    });
    const pNew = JSON.stringify({
      event_key: newDup,
      source_id: 'new-src',
      db_file: 'archived-conv.db',
      generation_index: 5,
      legacy_event_key: dupLegacy,
      model: 'gemini-3.8-flash',
      input_tokens: 2000,
      output_tokens: 500,
      cached_tokens: 0,
      total_tokens: 2500,
      timestamp_seconds: now - 3600,
      account_confidence: 'unknown',
      source_observed_at: 2000,
      ingested_at: '2026-11-12T10:00:00.000Z',
    });
    rawDb.prepare('INSERT INTO events VALUES(?,?,?,?,?,?)').run(oldWin, now - 3600, 'acc-1', 'gemini-3.8-flash', pOld, 1000);
    rawDb.prepare('INSERT INTO events VALUES(?,?,?,?,?,?)').run(newDup, now - 3600, null, 'gemini-3.8-flash', pNew, 2000);
    rawDb.prepare('INSERT INTO event_revisions(event_key,timestamp,payload) VALUES(?,?,?)').run(oldWin, now - 3600, pOld);
    rawDb.prepare('INSERT INTO event_revisions(event_key,timestamp,payload) VALUES(?,?,?)').run(newDup, now - 3600, pNew);
    rawDb.prepare('INSERT INTO rate_locks VALUES(?,?,?)').run(oldWin, JSON.stringify({ model: 'gemini-3.8-flash', input: 100, output: 200, cached: 1 }), 0.3);
    rawDb.close();

    const healedLedger = new UsageLedger(dirtyState);
    const aggHealed = await healedLedger.aggregate({ prices: {}, accountId: 'all', accounts, now });
    assert.equal(aggHealed.all_time.totals.request_count, 1, '存量未遮蔽重复行应在 aggregate 时自动去重');
    assert.equal(aggHealed.all_time.totals.total_tokens, 2500);
    assert.equal(aggHealed.all_time.estimated_usd, 0.3, '胜出者必须继承旧行已锁定的 rate_locks');
    assert.equal(aggHealed.available_accounts?.find(a => a.id === 'acc-1')?.request_count, 1, '胜出者必须保留 observed 账号归属');
    assert.equal((await healedLedger.load()).length, 1, 'load() 也应过滤已被 alias 遮蔽的旧记录');

    // 3. 验证 source_id 不受 fileStat.dev 影响（仅由 basename + ino + birthtimeMs 决定）
    const stableDb = join(convDir, 'stable-source-id.db');
    const sdb = new DatabaseSync(stableDb);
    sdb.exec('CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY,data BLOB);CREATE TABLE steps(idx INTEGER PRIMARY KEY,step_type INTEGER,metadata BLOB)');
    const genBlob = Buffer.concat([
      W.encodeLengthDelimited(
        1,
        Buffer.concat([
          W.encodeLengthDelimited(4, W.encodeVarintField(2, 300)),
          W.encodeLengthDelimited(9, W.encodeLengthDelimited(4, W.encodeVarintField(1, now - 20))),
        ])
      ),
      W.encodeLengthDelimited(2, W.encodeVarint(1)),
    ]);
    sdb.prepare('INSERT INTO gen_metadata VALUES(0,?)').run(genBlob);
    sdb.close();

    const st = await lstat(stableDb);
    const expectedSourceId = createHash('sha256')
      .update(JSON.stringify([basename(stableDb), st.ino, st.birthtimeMs]))
      .digest('hex');
    const persistPath = join(stateDir, 'persist-file-cache.json');
    const mgr = new UsageStatsManager({
      stateDir: join(stateDir, 'scanner-state'),
      geminiDir,
    });
    mgr.persistCachePath = persistPath;
    const scanRes = await mgr.scanDatabaseEvents(stableDb);
    assert.equal(scanRes.events.length, 1);
    assert.equal(scanRes.events[0].source_id, expectedSourceId, 'source_id 必须脱离易漂移的 dev 字段');

    // 4. 验证 largeLedger 分支也会保存持久化文件缓存
    mgr.largeLedger = true;
    await mgr.getUsageSummary(true);
    await new Promise(resolve => setTimeout(resolve, 150));
    const persistedRaw = JSON.parse(await readFile(persistPath, 'utf8'));
    assert.ok(persistedRaw?.entries?.[stableDb], 'largeLedger 分支下也必须持久化文件缓存');
  });
});

test('1.1.1 终审回归: 反向旧别名重入零自环零丢账、Protobuf 严格式时间戳检测抗 3 字节假阳性、语言切换失效日历缓存', async t => {
  const { hasInlineGenerationTimestamp } = await import('../dist/sqlite-worker.js');
  const prevLocale = getActiveLocale();
  t.after(() => setActiveLocale(prevLocale));

  // 1. P1-8: 包含 0x4a _ 0x22 子串的字符串字段不得被误判为拥有内联 started_at 时间戳
  const falsePositiveBlob = Buffer.concat([
    W.encodeLengthDelimited(
      1,
      Buffer.concat([
        W.encodeString(19, `model-J${String.fromCharCode(6)}"-fake`),
        W.encodeLengthDelimited(4, W.encodeVarintField(2, 500)),
      ])
    ),
    W.encodeLengthDelimited(2, W.encodeVarint(1)),
  ]);
  assert.equal(hasInlineGenerationTimestamp(falsePositiveBlob), false, '普通文本内巧合出现的 0x4a _ 0x22 字节序不得误判为已含时间戳');

  const realTimestampBlob = Buffer.concat([
    W.encodeLengthDelimited(
      1,
      Buffer.concat([
        W.encodeString(19, 'gemini-4-hydrogen'),
        W.encodeLengthDelimited(9, W.encodeLengthDelimited(4, W.encodeVarintField(1, 1_760_000_000))),
      ])
    ),
  ]);
  assert.equal(hasInlineGenerationTimestamp(realTimestampBlob), true);

  await withFixture(t, async ({ stateDir, geminiDir }) => {
    const now = Math.floor(Date.now() / 1000);
    // 2. P1-1: 旧 key (kOld) 被新 key (kNew) 遮蔽后若从归档缓存反向重入，绝不可产生 (kOld->kOld) 自环导致双双隐身
    const reverseLedger = new UsageLedger(join(stateDir, 'reverse-alias-reentry'));
    const legKey = createHash('sha256').update('reverse-reentry-leg').digest('hex');
    const kOld = 'c'.repeat(64);
    const kNew = 'd'.repeat(64);

    await reverseLedger.save([
      {
        event_key: kOld,
        source_id: 'src-old',
        db_file: 'conv-rev.db',
        generation_index: 0,
        legacy_event_key: legKey,
        model: 'gemini-4-hydrogen',
        input_tokens: 1000,
        output_tokens: 200,
        cached_tokens: 0,
        total_tokens: 1200,
        timestamp_seconds: now - 60,
        source_observed_at: 100,
      },
    ]);
    await reverseLedger.save([
      {
        event_key: kNew,
        source_id: 'src-new',
        db_file: 'conv-rev.db',
        generation_index: 0,
        legacy_event_key: legKey,
        model: 'gemini-4-hydrogen',
        input_tokens: 1000,
        output_tokens: 200,
        cached_tokens: 0,
        total_tokens: 1200,
        timestamp_seconds: now - 60,
        source_observed_at: 200,
      },
    ]);
    // 模拟归档/旧缓存带着更新的 source_observed_at 重新送入 kOld 及 observed 归属
    await reverseLedger.save([
      {
        event_key: kOld,
        source_id: 'src-old',
        db_file: 'conv-rev.db',
        generation_index: 0,
        legacy_event_key: legKey,
        model: 'gemini-4-hydrogen',
        input_tokens: 1000,
        output_tokens: 200,
        cached_tokens: 0,
        total_tokens: 1200,
        timestamp_seconds: now - 60,
        account_id: 'acc-1',
        account_email: 'alice@example.invalid',
        account_confidence: 'observed',
        source_observed_at: 300,
      },
    ]);

    const loadedAfterReentry = await reverseLedger.load();
    assert.equal(loadedAfterReentry.length, 1, '反向重入后记录不得因自环而丢失');
    assert.equal(loadedAfterReentry[0].account_id, 'acc-1', '主记录应吸收重入旧记录的 observed 归属');
    const aggAfterReentry = await reverseLedger.aggregate({
      prices: {},
      accountId: 'all',
      accounts: [{ id: 'acc-1', email: 'alice@example.invalid', name: 'Alice' }],
      now,
    });
    assert.equal(aggAfterReentry.all_time.totals.request_count, 1);
    assert.equal(aggAfterReentry.all_time.totals.total_tokens, 1200);

    // 3. P1-6 & P1-11: UsageStatsManager 切换激活语言后不命中旧语言缓存摘要，且 legacyKeyIndex 准确归并
    setActiveLocale('zh-Hans');
    const mgr = new UsageStatsManager({ stateDir: join(stateDir, 'locale-cache'), geminiDir });
    mgr.discoverDatabaseFiles = async () => ['synthetic-locale.db'];
    mgr.scanDatabaseEvents = async () => ({
      events: [
        {
          event_key: 'e'.repeat(64),
          source_id: 'src-loc-1',
          db_file: 'synthetic-locale.db',
          legacy_event_key: 'f'.repeat(64),
          model: '未知模型',
          input_tokens: 500,
          output_tokens: 100,
          cached_tokens: 0,
          total_tokens: 600,
          timestamp_seconds: now - 10,
        },
      ],
      generationsScanned: 1,
      skippedLargeRecords: 0,
      cacheHit: true,
    });
    const zhSummary = await mgr.getUsageSummary(false);
    assert.equal(zhSummary.available_accounts?.[0]?.label, '全部账号');

    setActiveLocale('en');
    const enSummary = await mgr.getUsageSummary(false);
    assert.equal(enSummary.available_accounts?.[0]?.label, 'All Accounts', '切换语言后 calendarKey 变化应立即返回英文摘要而非复用中文缓存');
  });
});

test('v1.1.1 超大重复分块与大1.9/废弃字段3投影修复及策略A缓存自愈', async t => {
  await withFixture(t, async ({ stateDir, geminiDir, convDir }) => {
    const now = Math.floor(Date.now() / 1000);
    const largeDbPath = join(convDir, 'large-repeated-chunks.db');

    // 1. 构造 >18MB gen_metadata：包含 120 个 150KB 重复 1.2 载荷、>64KB 的 1.9（含 1.9.4.1 时间戳）与 >4MB 废弃字段 3
    {
      const db = new DatabaseSync(largeDbPath);
      db.exec('CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY,data BLOB);CREATE TABLE steps(idx INTEGER PRIMARY KEY,step_type INTEGER,metadata BLOB)');
      const repeated1_2 = Array.from({ length: 120 }, () =>
        W.encodeLengthDelimited(2, Buffer.alloc(150 * 1024))
      );
      const usagePayload = Buffer.concat([
        W.encodeVarintField(1, 1525),
        W.encodeVarintField(2, 2290),
        W.encodeVarintField(3, 1069),
        W.encodeVarintField(5, 495387),
      ]);
      const largeChatStart1_9 = Buffer.concat([
        W.encodeLengthDelimited(4, W.encodeVarintField(1, now - 120)),
        W.encodeLengthDelimited(10, Buffer.alloc(70 * 1024)),
      ]);
      const wrapped = Buffer.concat([
        ...repeated1_2,
        W.encodeVarintField(3, 1525),
        W.encodeLengthDelimited(4, usagePayload),
        W.encodeLengthDelimited(9, largeChatStart1_9),
        W.encodeString(19, 'gemini-4-hydrogen'),
        W.encodeString(21, 'Gemini 4 Hydrogen (High)'),
      ]);
      const deprecatedField3 = Buffer.concat([
        W.encodeLengthDelimited(27, W.encodeString(8, 'ignored-planner-model')),
        W.encodeLengthDelimited(28, Buffer.alloc(4 * 1024 * 1024 + 128)),
      ]);
      const genBlob = Buffer.concat([
        W.encodeLengthDelimited(2, W.encodeVarint(10)),
        W.encodeLengthDelimited(3, deprecatedField3),
        W.encodeString(4, 'exec-large-gen-1'),
        W.encodeLengthDelimited(1, wrapped),
      ]);
      assert.ok(genBlob.length > 16 * 1024 * 1024);
      db.prepare('INSERT INTO gen_metadata VALUES(?,?)').run(0, genBlob);
      db.close();
    }

    const reader = new SqliteReadSnapshot(largeDbPath);
    try {
      const projected = await reader.projectBlob('gen_metadata', 'data', 0);
      assert.equal(projected.ok, true, projected.error);
      assert.ok(projected.rows[0].data_blob.length < 4096);
    } finally {
      await reader.close();
    }

    const scanGenMgr = new UsageStatsManager({ stateDir: join(stateDir, 'scan-gen'), geminiDir });
    const genScan = await scanGenMgr.scanDatabaseEvents(largeDbPath);
    assert.equal(genScan.skippedLargeRecords, 0);
    assert.equal(genScan.events.length, 1);
    assert.equal(genScan.events[0].model, 'gemini-4-hydrogen');
    assert.equal(genScan.events[0].input_tokens, 2290);
    assert.equal(genScan.events[0].output_tokens, 1069);
    assert.equal(genScan.events[0].cached_tokens, 495387);
    assert.equal(genScan.events[0].total_tokens, 498746);
    assert.equal(genScan.events[0].timestamp_seconds, now - 120);

    // 2. 构造 >16MB steps (step_type=15)：含大字段 24 与大干扰字段，验证 STEP_PROJECTION 提取 1.1 时间戳回填
    const largeStepsDbPath = join(convDir, 'large-steps-resolvable.db');
    {
      const db = new DatabaseSync(largeStepsDbPath);
      db.exec('CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY,data BLOB);CREATE TABLE steps(idx INTEGER PRIMARY KEY,step_type INTEGER,metadata BLOB)');
      const usageBuf = Buffer.concat([W.encodeVarintField(2, 310), W.encodeVarintField(3, 90)]);
      const execBuf = Buffer.from('exec-large-step-1', 'utf8');
      const genBlob = Buffer.concat([
        W.encodeLengthDelimited(
          1,
          Buffer.concat([W.encodeString(19, 'gemini-4-carbon'), W.encodeLengthDelimited(4, usageBuf)])
        ),
        W.encodeLengthDelimited(2, W.encodeVarint(130)),
        W.encodeLengthDelimited(4, execBuf),
      ]);
      db.prepare('INSERT INTO gen_metadata VALUES(?,?)').run(0, genBlob);
      const stepChunks = Array.from({ length: 115 }, () =>
        W.encodeLengthDelimited(30, Buffer.alloc(150 * 1024))
      );
      const oversizedStepMeta = Buffer.concat([
        W.encodeLengthDelimited(1, W.encodeVarintField(1, now - 300)),
        ...stepChunks,
        W.encodeLengthDelimited(24, Buffer.alloc(128 * 1024)),
        W.encodeLengthDelimited(9, usageBuf),
        W.encodeLengthDelimited(12, execBuf),
      ]);
      assert.ok(oversizedStepMeta.length > 16 * 1024 * 1024);
      db.prepare('INSERT INTO steps VALUES(?,15,?)').run(130, oversizedStepMeta);
      db.close();
    }

    const scanStepMgr = new UsageStatsManager({ stateDir: join(stateDir, 'scan-step'), geminiDir });
    const stepScan = await scanStepMgr.scanDatabaseEvents(largeStepsDbPath);
    assert.equal(stepScan.skippedLargeRecords, 0);
    assert.equal(stepScan.events.length, 1);
    assert.equal(stepScan.events[0].model, 'gemini-4-carbon');
    assert.equal(stepScan.events[0].total_tokens, 400);
    assert.equal(stepScan.events[0].timestamp_seconds, now - 300);

    // 3. 策略 A 持久化缓存自愈验证：清理 largeStepsDbPath 留下 largeDbPath + tinyDbPath
    await rm(largeStepsDbPath, { force: true });
    const tinyDbPath = join(convDir, 'tiny-healthy.db');
    {
      const db = new DatabaseSync(tinyDbPath);
      db.exec('CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY,data BLOB);CREATE TABLE steps(idx INTEGER PRIMARY KEY,step_type INTEGER,metadata BLOB)');
      const blob = Buffer.concat([
        W.encodeLengthDelimited(
          1,
          Buffer.concat([
            W.encodeString(19, 'gemini-4-carbon'),
            W.encodeLengthDelimited(4, W.encodeVarintField(2, 100)),
            W.encodeLengthDelimited(9, W.encodeLengthDelimited(4, W.encodeVarintField(1, now - 60))),
          ])
        ),
        W.encodeLengthDelimited(2, W.encodeVarint(1)),
      ]);
      db.prepare('INSERT INTO gen_metadata VALUES(?,?)').run(0, blob);
      db.close();
    }

    const largeSt = await lstat(largeDbPath);
    const tinySt = await lstat(tinyDbPath);
    const tinySourceId = createHash('sha256')
      .update(JSON.stringify([basename(tinyDbPath), tinySt.ino, tinySt.birthtimeMs]))
      .digest('hex');

    const persistPath = join(stateDir, 'usage-db-cache-antigravity-v3.json');
    await writeFile(
      persistPath,
      JSON.stringify({
        version: 3,
        entries: {
          [largeDbPath]: {
            mtimeMs: largeSt.mtimeMs,
            size: largeSt.size,
            walMtimeMs: 0,
            walSize: 0,
            events: [],
            generationsScanned: 1,
            skippedLargeRecords: 1,
            hasError: false,
            lastSuccessAt: now - 10,
          },
          [tinyDbPath]: {
            mtimeMs: tinySt.mtimeMs,
            size: tinySt.size,
            walMtimeMs: 0,
            walSize: 0,
            events: [
              {
                event_key: 'a'.repeat(64),
                source_id: tinySourceId,
                generation_index: 0,
                legacy_event_key: 'b'.repeat(64),
                account_confidence: 'unknown',
                model: 'gemini-4-carbon',
                input_tokens: 100,
                output_tokens: 0,
                cached_tokens: 0,
                total_tokens: 100,
                timestamp_seconds: now - 60,
              },
            ],
            generationsScanned: 1,
            skippedLargeRecords: 0,
            hasError: false,
            lastSuccessAt: now - 10,
          },
        },
      }),
      'utf8'
    );

    const healMgr = new UsageStatsManager({ stateDir: join(stateDir, 'heal'), geminiDir });
    healMgr.persistCachePath = persistPath;
    await healMgr.loadPersistentFileCache();

    // <= 16MB 健康旧缓存保留命中（策略 A 不误杀）
    const tinyCheck = await healMgr.scanDatabaseEvents(tinyDbPath, false);
    assert.equal(tinyCheck.cacheHit, true, '<= 16MB 且无异常的旧缓存条目应保持命中');

    // 未修改文件任何时间戳，getUsageSummary(false) 自动绕过 skippedLargeRecords:1 坏缓存并完成恢复
    const healedSummary = await healMgr.getUsageSummary(false);
    assert.equal(healedSummary.skipped_large_records, 0);
    assert.equal(healedSummary.availability, 'complete');
    assert.equal(healedSummary.has_error, false);
    assert.equal(healedSummary.all_time.totals.total_tokens, 498746 + 100);

    await healMgr.persistSaveChain;
    const savedCache = JSON.parse(await readFile(persistPath, 'utf8'));
    assert.equal(savedCache.entries[largeDbPath]?.skippedLargeRecords, 0);
    assert.equal(savedCache.entries[largeDbPath]?.projectionVersion, USAGE_PROJECTION_VERSION);

    // 4. P1-01 回归：当前 projectionVersion 已尝试过但仍存在无法投影超限记录的静态历史库必须命中缓存并持久化，不再每轮冷扫
    const { isFileCacheEntryReusable } = await import('../dist/usage-types.js');
    assert.equal(
      isFileCacheEntryReusable({ hasError: false, skippedLargeRecords: 1, size: 20 * 1024 * 1024, projectionVersion: undefined }),
      false,
      '无 projectionVersion 的旧版超限记录仍须触发自愈重扫'
    );
    assert.equal(
      isFileCacheEntryReusable({ hasError: false, skippedLargeRecords: 1, size: 20 * 1024 * 1024, projectionVersion: USAGE_PROJECTION_VERSION - 1 }),
      false,
      '旧 projectionVersion 条目在算法升级后仍须触发重扫'
    );
    assert.equal(
      isFileCacheEntryReusable({ hasError: false, skippedLargeRecords: 1, size: 20 * 1024 * 1024, projectionVersion: USAGE_PROJECTION_VERSION }),
      true,
      '当前 projectionVersion 下已完成投影探测的静态大文件应允许命中缓存'
    );

    const unprojectableDbPath = join(convDir, 'unprojectable-v2-cached.db');
    {
      const db = new DatabaseSync(unprojectableDbPath);
      db.exec('CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY,data BLOB);CREATE TABLE steps(idx INTEGER PRIMARY KEY,step_type INTEGER,metadata BLOB)');
      const genBlob = Buffer.concat([
        W.encodeLengthDelimited(
          1,
          Buffer.concat([W.encodeString(19, 'gemini-2.5-flash'), W.encodeLengthDelimited(4, W.encodeVarintField(2, 55))])
        ),
        W.encodeLengthDelimited(2, W.encodeVarint(99)),
      ]);
      db.prepare('INSERT INTO gen_metadata VALUES(?,?)').run(0, genBlob);
      db.prepare('INSERT INTO steps VALUES(?,15,?)').run(99, W.encodeLengthDelimited(9, Buffer.alloc(16 * 1024 * 1024 + 64)));
      db.close();
    }

    const v2CachePath = join(stateDir, 'v2-skipped-persist.json');
    const v2Mgr = new UsageStatsManager({ stateDir: join(stateDir, 'v2-skipped'), geminiDir });
    v2Mgr.persistCachePath = v2CachePath;
    const firstUnprojectable = await v2Mgr.scanDatabaseEvents(unprojectableDbPath, false);
    assert.equal(firstUnprojectable.skippedLargeRecords, 1);
    assert.equal(Boolean(firstUnprojectable.cacheHit), false);
    const secondUnprojectable = await v2Mgr.scanDatabaseEvents(unprojectableDbPath, false);
    assert.equal(secondUnprojectable.cacheHit, true, '同一 projectionVersion 下静态未变化大文件第二次扫描必须命中内存缓存');
    assert.equal(secondUnprojectable.skippedLargeRecords, 1);

    await v2Mgr.getUsageSummary(false);
    await v2Mgr.persistSaveChain;
    const v2Saved = JSON.parse(await readFile(v2CachePath, 'utf8'));
    assert.equal(v2Saved.entries[unprojectableDbPath]?.skippedLargeRecords, 1, 'v2 已探测大记录条目应持久化落盘避免重启后重复冷扫');
    assert.equal(v2Saved.entries[unprojectableDbPath]?.projectionVersion, USAGE_PROJECTION_VERSION);
  });
});

test('P1-12 & P1-13: revalueLedger 保护缺 cacheWrite 合法锁/强制 environmentId=all/统计删锁变更；aggregateIndexCache 跨连接命中且上限 2 项受 epoch 失效控制', async t => {
  await withFixture(t, async ({ stateDir }) => {
    const {
      aggregateLedger,
      bumpAggregateModelCatalogEpoch,
      getAggregateIndexCacheStats,
      invalidateAggregateIndexCache,
    } = await import('../dist/usage-aggregate.js');

    // P1-12: revalueLedger
    const revDir = join(stateDir, 'p1-12-revalue');
    const ledger = new UsageLedger(revDir);
    const now = Math.floor(Date.now() / 1000);
    const cwEventKey = 'c'.repeat(64);
    const sshEventKey = 'd'.repeat(64);
    const legacySshKey = 'e'.repeat(64);

    await ledger.save([
      {
        event_key: cwEventKey,
        source_id: 'src-cw',
        db_file: 'live-cw.db',
        model: 'test-cw-model',
        input_tokens: 1_000_000,
        output_tokens: 0,
        cached_tokens: 0,
        cache_write_tokens: 1_000_000,
        total_tokens: 2_000_000,
        timestamp_seconds: now - 120,
        environment_kind: 'local',
        environment_id: 'local',
      },
      {
        event_key: sshEventKey,
        legacy_event_key: legacySshKey,
        source_id: 'src-ssh',
        db_file: 'remote-ssh.db',
        model: 'test-ssh-model',
        input_tokens: 1_000_000,
        output_tokens: 0,
        cached_tokens: 0,
        total_tokens: 1_000_000,
        timestamp_seconds: now - 60,
        environment_kind: 'ssh',
        environment_id: 'ssh:box-1',
        environment_label: 'box-1',
      },
    ]);
    await ledger.saveLocks({
      [cwEventKey]: {
        usd: 6.0,
        price: { model: 'test-cw-model', input: 2.0, output: 0, cached: 0, cacheWrite: 4.0 },
      },
      [legacySshKey]: {
        usd: 5.0,
        price: { model: 'test-ssh-model', input: 5.0, output: 0, cached: 0 },
      },
    });

    // 1) unpriced_only 模式：新价缺 cacheWrite 保留原有 $6 合法锁；预览聚合强制 environmentId='all' 涵盖 ssh:box-1
    const previewUnpriced = await ledger.revalue({
      action: 'preview',
      mode: 'unpriced_only',
      environmentId: 'local',
      prices: {
        'test-cw-model': { model: 'test-cw-model', input: 3.0, output: 0, cached: 0 },
        'test-ssh-model': { model: 'test-ssh-model', input: 2.0, output: 0, cached: 0 },
      },
      liveFiles: ['live-cw.db', 'remote-ssh.db'],
      now,
    });
    assert.equal(previewUnpriced.unverifiableCount, 1);
    assert.equal(previewUnpriced.before, 11.0);
    assert.equal(previewUnpriced.after, 8.0, 'unpriced_only 保留 cw 合法锁($6) + 全环境聚合含 SSH($2，ignoreLegacyRates=true) = $8');

    // 2) force_all 模式：对齐 Release-Audit-P0 契约，移除未核实 cacheWrite 原锁并计入 changedCount/samples(after: null)，
    //    即使调用方传入 environmentId: 'local'，预览聚合也必须覆盖全部环境（含 ssh:box-1）；
    //    同时旧 legacySshKey 与 cwEventKey 被删锁均计入 changedCount 与 samples(after: null)。
    const preview = await ledger.revalue({
      action: 'preview',
      mode: 'force_all',
      environmentId: 'local',
      prices: {
        'test-cw-model': { model: 'test-cw-model', input: 3.0, output: 0, cached: 0 },
        'test-ssh-model': { model: 'test-ssh-model', input: 2.0, output: 0, cached: 0 },
      },
      liveFiles: ['live-cw.db', 'remote-ssh.db'],
      now,
    });
    assert.equal(preview.unverifiableCount, 1, '新价缺 cacheWrite 应计入 unverifiableCount');
    assert.equal(preview.before, 11.0, '重估前总额应为 6.0 + 5.0');
    assert.equal(preview.after, 2.0, 'force_all 移除缺 cacheWrite 的原锁后仅剩 ssh 重估($2)，不受传入 environmentId=local 干扰');
    assert.ok(
      preview.samples.some(s => s.key === legacySshKey && s.before === 5.0 && s.after === null),
      'backupLocks 中被删除的遗留锁键应记录在 samples(after: null)'
    );
    assert.ok(
      preview.samples.some(s => s.key === cwEventKey && s.before === 6.0 && s.after === null),
      'backupLocks 中因缺 cacheWrite 被移除的原锁键应记录在 samples(after: null)'
    );
    assert.equal(preview.changedCount, 3, '新增 sshEventKey($2) + 删除 legacySshKey($5->null) + 删除 cwEventKey($6->null) 共 3 处变更');

    // P1-13: aggregateIndexCache 跨独立 DatabaseSync 连接命中、上限 2 项淘汰、epoch 与 locale 失效
    invalidateAggregateIndexCache();
    const makeTempLedgerDb = async (name) => {
      const d = join(stateDir, `p1-13-${name}`);
      const l = new UsageLedger(d);
      await l.save([
        {
          event_key: createHash('sha256').update(name).digest('hex'),
          source_id: `src-${name}`,
          db_file: `${name}.db`,
          model: name === 'a' ? '' : 'gemini-3.8-flash',
          input_tokens: 100,
          output_tokens: 50,
          cached_tokens: 0,
          total_tokens: 150,
          timestamp_seconds: now - 30,
        },
      ]);
      return join(d, 'usage-ledger-v2.sqlite');
    };
    const dbPathA = await makeTempLedgerDb('a');
    const dbPathB = await makeTempLedgerDb('b');
    const dbPathC = await makeTempLedgerDb('c');
    const aggOpts = { prices: {}, accounts: [], now };
    const origLocale = getActiveLocale();
    t.after(() => setActiveLocale(origLocale));

    setActiveLocale('en');
    const stats0 = getAggregateIndexCacheStats();
    const dbA1 = new DatabaseSync(dbPathA);
    const aggEn = aggregateLedger(dbA1, aggOpts);
    dbA1.close();
    assert.equal(aggEn.all_time.by_model[0].model, 'Unknown Model');
    const stats1 = getAggregateIndexCacheStats();
    assert.equal(stats1.misses, stats0.misses + 1);

    // 重新打开同一路径的新 DatabaseSync 实例（同 locale）必须命中缓存（不再因 WeakMap 实例变化而失效）
    const dbA2 = new DatabaseSync(dbPathA);
    aggregateLedger(dbA2, aggOpts);
    dbA2.close();
    const stats2 = getAggregateIndexCacheStats();
    assert.equal(stats2.hits, stats1.hits + 1, '重新打开同路径 DatabaseSync 实例应命中基于 dbPath+dev:ino 的索引缓存');

    // 切换语言后不得命中英文缓存，必须按新 locale 重建返回中文占位名
    setActiveLocale('zh-Hans');
    const dbA3 = new DatabaseSync(dbPathA);
    const aggZh = aggregateLedger(dbA3, aggOpts);
    dbA3.close();
    assert.equal(aggZh.all_time.by_model[0].model, '未知模型', '切换 locale 后索引缓存必须失效并按新语言解析未知模型名');

    // 连续访问 B 和 C 后，缓存条数上限固定为 2（淘汰最久未用项）
    const dbB = new DatabaseSync(dbPathB);
    aggregateLedger(dbB, aggOpts);
    dbB.close();
    const dbC = new DatabaseSync(dbPathC);
    aggregateLedger(dbC, aggOpts);
    dbC.close();
    const stats3 = getAggregateIndexCacheStats();
    assert.equal(stats3.size, 2, 'aggregateIndexCache 上限必须严格保持 2 项');
    assert.equal(stats3.maxSize, 2);

    // 目录/观测元数据 epoch 递增后应清空旧缓存并触发重建
    const prevEpoch = stats3.epoch;
    const nextEpoch = bumpAggregateModelCatalogEpoch();
    assert.equal(nextEpoch, prevEpoch + 1);
    assert.equal(getAggregateIndexCacheStats().size, 0, 'bumpAggregateModelCatalogEpoch 后旧索引缓存应立即失效');
  });
});

test('sqlite-worker 修复: closeSqliteDatabase 抗 ROLLBACK 异常防句柄泄漏，createSqlBlobChunkReader 单次物化中等 BLOB 且不越界超大 BLOB', async () => {
  const { closeSqliteDatabase, createSqlBlobChunkReader } = await import('../dist/sqlite-worker.js');

  // 1. ROLLBACK 抛错时仍必须执行 close()，且 close() 自身抛错也不向外泄漏异常
  let closedCount = 0;
  closeSqliteDatabase({
    exec() { throw new Error('cannot rollback - no transaction is active'); },
    close() { closedCount += 1; },
  });
  assert.equal(closedCount, 1, 'ROLLBACK 抛错后仍必须调用 db.close()');

  assert.doesNotThrow(() => {
    closeSqliteDatabase({
      exec() { throw new Error('rollback failed'); },
      close() { throw new Error('close failed'); },
    });
    closeSqliteDatabase(undefined);
  });

  // 2. <=64MB BLOB：前 3 次走 substr，第 4 次起单次物化并零拷贝切片
  const payload = Uint8Array.from({ length: 64 }, (_, i) => i);
  let substrCalls = 0;
  let fullCalls = 0;
  const reader = createSqlBlobChunkReader(
    payload.byteLength,
    7,
    () => ({
      get(start1Based, length, key) {
        assert.equal(key, 7);
        substrCalls += 1;
        return { chunk: payload.slice(start1Based - 1, start1Based - 1 + length) };
      },
    }),
    () => ({
      get(key) {
        assert.equal(key, 7);
        fullCalls += 1;
        return { data: payload };
      },
    })
  );

  assert.deepEqual([...reader(0, 4)], [0, 1, 2, 3]);
  assert.deepEqual([...reader(4, 4)], [4, 5, 6, 7]);
  assert.deepEqual([...reader(8, 4)], [8, 9, 10, 11]);
  assert.equal(substrCalls, 3);
  assert.equal(fullCalls, 0);

  // 第 4、5 次读取应触发且仅触发 1 次全量物化，并用 subarray 返回切片
  const slice4 = reader(12, 4);
  const slice5 = reader(16, 4);
  assert.deepEqual([...slice4], [12, 13, 14, 15]);
  assert.deepEqual([...slice5], [16, 17, 18, 19]);
  assert.equal(substrCalls, 3);
  assert.equal(fullCalls, 1);

  // 3. >64MB 超大 BLOB：即使超过 3 次调用也绝不全量物化
  let hugeSubstrCalls = 0;
  let hugeFullCalls = 0;
  const hugeReader = createSqlBlobChunkReader(
    65 * 1024 * 1024,
    99,
    () => ({
      get(start1Based, length) {
        hugeSubstrCalls += 1;
        return { chunk: payload.slice(start1Based - 1, start1Based - 1 + length) };
      },
    }),
    () => ({
      get() {
        hugeFullCalls += 1;
        return { data: payload };
      },
    })
  );
  for (let i = 0; i < 5; i += 1) {
    assert.deepEqual([...hugeReader(i, 2)], [i, i + 1]);
  }
  assert.equal(hugeSubstrCalls, 5);
  assert.equal(hugeFullCalls, 0);
});





