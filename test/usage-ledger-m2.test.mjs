import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { UsageLedger } from '../dist/usage-ledger.js';
import {
  normalizeEventEnvironment,
  resolveDatabaseModelFullName,
} from '../dist/usage-types.js';
import { buildUsageSummaryReport } from '../dist/usage-report.js';
import { calculateLockedEventUsd } from '../dist/usage-aggregate.js';
import { resolvePricingFromTable } from '../dist/pricing.js';
import { getActiveLocale, setActiveLocale } from '../dist/i18n.js';

const shaKey = (label) => createHash('sha256').update(label).digest('hex');

async function withTempDir(t, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'gb-ledger-m2-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return fn(dir);
}

test('M2-1: 1.1.3 旧库无 sync_receipts 平滑只读/升级，零 event_revisions 抖动与零双计', async t => {
  await withTempDir(t, async dir => {
    const emptyLedger = new UsageLedger(join(dir, 'nonexistent'));
    assert.deepEqual(await emptyLedger.receipts(), {});
    assert.equal(existsSync(join(dir, 'nonexistent', 'usage-ledger-v2.sqlite')), false);

    // 验证 normalizeEventEnvironment 对旧本地记录与 SSH 记录的归一化
    assert.deepEqual(normalizeEventEnvironment(undefined), { kind: 'local', id: 'local', label: '' });
    assert.deepEqual(
      normalizeEventEnvironment({ model: 'gemini-3.8-flash', input_tokens: 1, output_tokens: 1, cached_tokens: 0, total_tokens: 2, timestamp_seconds: 100 }),
      { kind: 'local', id: 'local', label: '' }
    );
    assert.deepEqual(
      normalizeEventEnvironment({
        environment_kind: 'ssh',
        environment_id: 'ssh:demo001',
        environment_label: 'demo-ssh-host',
      }),
      { kind: 'ssh', id: 'ssh:demo001', label: 'demo-ssh-host' }
    );

    const now = Math.floor(Date.now() / 1000) - 60;
    const dbPath = join(dir, 'usage-ledger-v2.sqlite');
    const legacyKey = shaKey('legacy-113-local-event');
    const legacyPayloadObj = {
      event_key: legacyKey,
      source_id: 'local-src-113',
      generation_index: 0,
      model: 'gemini-3.8-flash',
      input_tokens: 1000,
      output_tokens: 200,
      cached_tokens: 0,
      total_tokens: 1200,
      timestamp_seconds: now,
      account_id: 'acc-local-1',
      account_email: 'local-user@example.invalid',
      account_confidence: 'observed',
      source_observed_at: 1000,
    };
    const legacyPayload = JSON.stringify(legacyPayloadObj);

    // 模拟纯粹的 1.1.3 数据库结构：无 sync_receipts 表，user_version=2
    const rawDb = new DatabaseSync(dbPath);
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
    rawDb.prepare('INSERT INTO events VALUES(?,?,?,?,?,?)').run(
      legacyKey,
      now,
      'acc-local-1',
      'gemini-3.8-flash',
      legacyPayload,
      1000
    );
    rawDb.prepare('INSERT INTO event_revisions(event_key,timestamp,payload) VALUES(?,?,?)').run(
      legacyKey,
      now,
      legacyPayload
    );
    rawDb.prepare('INSERT INTO rate_locks VALUES(?,?,?)').run(
      legacyKey,
      JSON.stringify({ model: 'gemini-3.8-flash', input: 1, output: 2, cached: 0.1 }),
      0.0014
    );
    rawDb.close();

    const ledger = new UsageLedger(dir);
    // 只读打开 1.1.3 旧库查 receipts() 不应报错或修改结构
    assert.deepEqual(await ledger.receipts(), {});

    const agg1 = await ledger.aggregate({
      prices: {},
      accountId: 'all',
      accounts: [{ id: 'acc-local-1', email: 'local-user@example.invalid', name: 'Local' }],
      now,
    });
    assert.equal(agg1.all_time.totals.request_count, 1);
    assert.equal(agg1.all_time.totals.total_tokens, 1200);
    assert.equal(agg1.available_environments?.length, 2);
    assert.equal(agg1.available_environments?.[0]?.kind, 'all');
    assert.equal(agg1.available_environments?.[1]?.kind, 'local');
    assert.equal(agg1.environment_breakdown?.has_ssh_data, false);
    assert.equal(agg1.environment_breakdown?.local_share_pct, 100);

    const versionBefore = await ledger.version();
    // 升级后再次保存同本地旧事件，必须保持零 event_revisions 抖动、零双计
    await ledger.save([{ ...legacyPayloadObj }]);
    assert.equal(await ledger.version(), versionBefore, '重入 1.1.3 本地旧记录不得触发 event_revisions 抖动');

    const loaded = await ledger.load();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].environment_kind, undefined, '绝不主动往存量本地记录回写 environment_kind');

    const agg2 = await ledger.aggregate({
      prices: {},
      accountId: 'all',
      accounts: [{ id: 'acc-local-1', email: 'local-user@example.invalid', name: 'Local' }],
      now,
    });
    assert.equal(agg2.all_time.totals.request_count, 1);
    assert.equal(agg2.all_time.totals.total_tokens, 1200);
  });
});

test('M2-2: 单事务 events + rate_locks + sync_receipts 原子提交、空事件仅写 receipts 与失败全回滚', async t => {
  await withTempDir(t, async dir => {
    const ledger = new UsageLedger(dir);
    const now = Math.floor(Date.now() / 1000) - 60;
    const validKey = shaKey('m2-tx-priced');
    const unpricedKey = shaKey('m2-tx-unpriced-gap');

    const billingPrices = {
      'm2-priced-model': [
        {
          model: 'm2-priced-model',
          validFrom: new Date((now - 3600) * 1000).toISOString(),
          input: 2,
          output: 10,
          cached: 0.2,
        },
      ],
      'm2-expired-model': [
        {
          model: 'm2-expired-model',
          validFrom: '2020-01-01T00:00:00Z',
          validUntil: '2021-01-01T00:00:00Z',
          input: 5,
          output: 15,
          cached: 0.5,
        },
      ],
    };

    const receipt1 = {
      source_id: 'ssh-src-1',
      environment_id: 'ssh:demo001',
      cursor_offset: 3,
      step_offset: 10,
      last_modified_sec: now,
      step_count: 10,
      committed_at: now,
    };

    const saveRes = await ledger.save(
      [
        {
          event_key: validKey,
          source_id: 'ssh-src-1',
          environment_kind: 'ssh',
          environment_id: 'ssh:demo001',
          environment_label: 'demo-ssh-host',
          trajectory_id: 'traj-tx-1',
          model: 'm2-priced-model',
          input_tokens: 1_000_000,
          output_tokens: 500_000,
          cached_tokens: 0,
          total_tokens: 1_500_000,
          timestamp_seconds: now,
        },
        {
          event_key: unpricedKey,
          source_id: 'ssh-src-1',
          environment_kind: 'ssh',
          environment_id: 'ssh:demo001',
          environment_label: 'demo-ssh-host',
          trajectory_id: 'traj-tx-1',
          model: 'm2-expired-model',
          input_tokens: 100_000,
          output_tokens: 0,
          cached_tokens: 0,
          total_tokens: 100_000,
          timestamp_seconds: now,
        },
      ],
      { billingPrices, receipts: [receipt1] }
    );

    assert.equal(saveRes.saved, 2);
    assert.equal(saveRes.locksWritten, 1, '不支持时段的事件绝不凭空写锁');
    assert.equal(saveRes.receiptsWritten, 1);

    const locks = await ledger.locks();
    assert.equal(Object.hasOwn(locks, validKey), true);
    assert.equal(locks[validKey].usd, 7);
    assert.equal(Object.hasOwn(locks, unpricedKey), false);

    // 验证派生 usage-rate-locks.json 镜像已同步生成，且二次聚合不触发自读循环异常
    const mirror = JSON.parse(await readFile(join(dir, 'usage-rate-locks.json'), 'utf8'));
    assert.equal(mirror.version, 1);
    assert.equal(mirror.entries[validKey].usd, 7);
    assert.deepEqual(await ledger.receipts(), { 'ssh-src-1': receipt1 });

    // 空 events 仅推进 receipts
    const receipt2 = { ...receipt1, cursor_offset: 5, step_offset: 14, step_count: 14, committed_at: now + 5 };
    const receiptOnlyRes = await ledger.save([], { receipts: [receipt2] });
    assert.equal(receiptOnlyRes.saved, 0);
    assert.equal(receiptOnlyRes.receiptsWritten, 1);
    assert.deepEqual((await ledger.receipts())['ssh-src-1'], receipt2);

    // 事务原子回滚：receipt 校验失败时，同批 events / rate_locks / sync_receipts 必须全部回滚
    const rollbackKey = shaKey('m2-tx-rollback-event');
    const badReceipt = { ...receipt2, cursor_offset: -1 };
    await assert.rejects(
      ledger.save(
        [
          {
            event_key: rollbackKey,
            source_id: 'ssh-src-2',
            environment_kind: 'ssh',
            environment_id: 'ssh:demo001',
            environment_label: 'demo-ssh-host',
            model: 'm2-priced-model',
            input_tokens: 500_000,
            output_tokens: 0,
            cached_tokens: 0,
            total_tokens: 500_000,
            timestamp_seconds: now,
          },
        ],
        { billingPrices, receipts: [badReceipt] }
      )
    );

    const eventsAfterFail = await ledger.load();
    assert.equal(eventsAfterFail.some(e => e.event_key === rollbackKey), false, '失败事务不得部分落盘事件');
    assert.equal(Object.hasOwn(await ledger.locks(), rollbackKey), false, '失败事务不得部分落盘锁');
    assert.deepEqual((await ledger.receipts())['ssh-src-1'], receipt2, '失败事务不得篡改已提交回执');

    const aggAfter = await ledger.aggregate({ prices: {}, accountId: 'all', accounts: [], now });
    assert.equal(aggAfter.all_time.estimated_usd, 7);
    assert.equal(aggAfter.all_time.totals.request_count, 2);
  });
});

test('M2-3: 流式 10→12 同键修订原样保留锁定单价并重算金额，不随后台改价漂移', async t => {
  await withTempDir(t, async dir => {
    const ledger = new UsageLedger(dir);
    const now = Math.floor(Date.now() / 1000) - 30;
    const streamKey = shaKey('m2-streaming-10-12');

    const priceV1 = {
      'stream-model': { model: 'stream-model', input: 2, output: 10, cached: 0.2, cacheWrite: 2.5 },
    };
    const priceV2 = {
      'stream-model': { model: 'stream-model', input: 50, output: 100, cached: 5, cacheWrite: 60 },
    };

    await ledger.save(
      [
        {
          event_key: streamKey,
          source_id: 'ssh-stream-src',
          environment_kind: 'ssh',
          environment_id: 'ssh:demo001',
          environment_label: 'demo-ssh-host',
          trajectory_id: 'traj-stream-1',
          model: 'stream-model',
          input_tokens: 10,
          output_tokens: 0,
          cached_tokens: 0,
          total_tokens: 10,
          timestamp_seconds: now,
          source_observed_at: 100,
        },
      ],
      { billingPrices: priceV1 }
    );
    assert.equal((await ledger.locks())[streamKey].usd, 0.00002);

    // 后台价格上涨至 $50/1M，同时流式步从 10 token 增长为 12 token
    await ledger.save(
      [
        {
          event_key: streamKey,
          source_id: 'ssh-stream-src',
          environment_kind: 'ssh',
          environment_id: 'ssh:demo001',
          environment_label: 'demo-ssh-host',
          trajectory_id: 'traj-stream-1',
          model: 'stream-model',
          input_tokens: 12,
          output_tokens: 0,
          cached_tokens: 0,
          total_tokens: 12,
          timestamp_seconds: now,
          source_observed_at: 200,
        },
      ],
      { billingPrices: priceV2 }
    );

    const lockAfter = (await ledger.locks())[streamKey];
    assert.equal(lockAfter.price.input, 2, '同键修订必须原样保留原锁定单价');
    assert.equal(lockAfter.usd, 0.000024, '同键修订应基于原单价和最新 token 重算金额');

    const agg = await ledger.aggregate({ prices: priceV2, accountId: 'all', accounts: [], now });
    assert.equal(agg.all_time.totals.request_count, 1);
    assert.equal(agg.all_time.totals.total_tokens, 12);
    assert.equal(agg.all_time.estimated_usd, 0.000024);

    // 验证空/zero-sentinel 或缺失 cacheWrite 锁在 save 传入完整 billingPrices 时可自愈补锁
    const repairKey = shaKey('m2-repair-nocw');
    await ledger.save([
      {
        event_key: repairKey,
        source_id: 'ssh-repair-src',
        model: 'stream-model',
        input_tokens: 1_000_000,
        output_tokens: 0,
        cached_tokens: 0,
        cache_write_tokens: 1_000_000,
        total_tokens: 2_000_000,
        timestamp_seconds: now,
      },
    ]);
    await ledger.saveLocks({
      [streamKey]: lockAfter,
      [repairKey]: { usd: 0.5, price: { model: 'stream-model', input: 2, output: 10, cached: 0.2 } },
    });
    const repairRes = await ledger.save(
      [
        {
          event_key: repairKey,
          source_id: 'ssh-repair-src',
          model: 'stream-model',
          input_tokens: 1_000_000,
          output_tokens: 0,
          cached_tokens: 0,
          cache_write_tokens: 1_000_000,
          total_tokens: 2_000_000,
          timestamp_seconds: now,
        },
      ],
      { billingPrices: priceV1 }
    );
    assert.equal(repairRes.locksWritten, 1);
    assert.equal((await ledger.locks())[repairKey].usd, 4.5);
  });
});

test('M2-4: observed > inferred > unknown > legacy 归属合并只升不降，同键修订保留已有 environment_* 与 trajectory_id', async t => {
  await withTempDir(t, async dir => {
    const ledger = new UsageLedger(dir);
    const now = Math.floor(Date.now() / 1000) - 60;
    const kChain = shaKey('m2-confidence-chain');
    const kInfStay = shaKey('m2-inferred-stay');
    const kEnvKeep = shaKey('m2-env-preserve');

    // 1. legacy -> unknown -> inferred -> observed 逐级升级，随后传入低置信度绝不降级
    await ledger.save([
      {
        event_key: kChain,
        source_id: 'src-conf-1',
        model: 'gemini-3.8-flash',
        input_tokens: 100,
        output_tokens: 50,
        cached_tokens: 0,
        total_tokens: 150,
        timestamp_seconds: now,
        account_confidence: 'legacy',
        source_observed_at: 10,
      },
    ]);
    await ledger.save([
      {
        event_key: kChain,
        source_id: 'src-conf-1',
        model: 'gemini-3.8-flash',
        input_tokens: 100,
        output_tokens: 50,
        cached_tokens: 0,
        total_tokens: 150,
        timestamp_seconds: now,
        account_confidence: 'unknown',
        source_observed_at: 20,
      },
    ]);
    assert.equal((await ledger.load()).find(e => e.event_key === kChain)?.account_confidence, 'unknown');

    await ledger.save([
      {
        event_key: kChain,
        source_id: 'src-conf-1',
        model: 'gemini-3.8-flash',
        input_tokens: 100,
        output_tokens: 50,
        cached_tokens: 0,
        total_tokens: 150,
        timestamp_seconds: now,
        account_email: 'inferred@example.invalid',
        account_confidence: 'inferred',
        source_observed_at: 30,
      },
    ]);
    let rowChain = (await ledger.load()).find(e => e.event_key === kChain);
    assert.equal(rowChain?.account_confidence, 'inferred');
    assert.equal(rowChain?.account_email, 'inferred@example.invalid');

    await ledger.save([
      {
        event_key: kChain,
        source_id: 'src-conf-1',
        model: 'gemini-3.8-flash',
        input_tokens: 100,
        output_tokens: 50,
        cached_tokens: 0,
        total_tokens: 150,
        timestamp_seconds: now,
        account_id: 'acc-obs',
        account_email: 'observed@example.invalid',
        account_confidence: 'observed',
        source_observed_at: 40,
      },
    ]);
    rowChain = (await ledger.load()).find(e => e.event_key === kChain);
    assert.equal(rowChain?.account_confidence, 'observed');
    assert.equal(rowChain?.account_id, 'acc-obs');

    // 即使新观测时间更晚，低置信度 (inferred / unknown / legacy) 不得覆盖 observed
    for (const [idx, conf] of ['inferred', 'unknown', 'legacy'].entries()) {
      await ledger.save([
        {
          event_key: kChain,
          source_id: 'src-conf-1',
          model: 'gemini-3.8-flash',
          input_tokens: 100,
          output_tokens: 50,
          cached_tokens: 0,
          total_tokens: 150,
          timestamp_seconds: now,
          ...(conf === 'inferred' ? { account_email: 'downgrade@example.invalid' } : {}),
          account_confidence: conf,
          source_observed_at: 50 + idx * 10,
        },
      ]);
      rowChain = (await ledger.load()).find(e => e.event_key === kChain);
      assert.equal(rowChain?.account_confidence, 'observed', `${conf} 不得覆盖 observed`);
      assert.equal(rowChain?.account_id, 'acc-obs');
      assert.equal(rowChain?.account_email, 'observed@example.invalid');
    }

    // 2. inferred 不可被 unknown / legacy 覆盖
    await ledger.save([
      {
        event_key: kInfStay,
        source_id: 'src-conf-2',
        model: 'gemini-3.8-flash',
        input_tokens: 80,
        output_tokens: 20,
        cached_tokens: 0,
        total_tokens: 100,
        timestamp_seconds: now,
        account_email: 'ssh-inferred@example.invalid',
        account_confidence: 'inferred',
        source_observed_at: 10,
      },
    ]);
    await ledger.save([
      {
        event_key: kInfStay,
        source_id: 'src-conf-2',
        model: 'gemini-3.8-flash',
        input_tokens: 80,
        output_tokens: 20,
        cached_tokens: 0,
        total_tokens: 100,
        timestamp_seconds: now,
        account_confidence: 'unknown',
        source_observed_at: 20,
      },
    ]);
    await ledger.save([
      {
        event_key: kInfStay,
        source_id: 'src-conf-2',
        model: 'gemini-3.8-flash',
        input_tokens: 80,
        output_tokens: 20,
        cached_tokens: 0,
        total_tokens: 100,
        timestamp_seconds: now,
        account_confidence: 'legacy',
        source_observed_at: 30,
      },
    ]);
    const rowInf = (await ledger.load()).find(e => e.event_key === kInfStay);
    assert.equal(rowInf?.account_confidence, 'inferred');
    assert.equal(rowInf?.account_email, 'ssh-inferred@example.invalid');

    // 3. 更新同 event_key 时保留已有 environment_* 与 trajectory_id
    await ledger.save([
      {
        event_key: kEnvKeep,
        source_id: 'ssh-src-keep',
        environment_kind: 'ssh',
        environment_id: 'ssh:demo001',
        environment_label: 'demo-ssh-host',
        trajectory_id: 'traj-anchor-99',
        execution: 'exec-1',
        model: 'gemini-3.8-flash',
        input_tokens: 50,
        output_tokens: 10,
        cached_tokens: 0,
        total_tokens: 60,
        timestamp_seconds: now,
        source_observed_at: 100,
      },
    ]);
    await ledger.save([
      {
        event_key: kEnvKeep,
        source_id: 'ssh-src-keep',
        model: 'gemini-3.8-flash',
        input_tokens: 80,
        output_tokens: 10,
        cached_tokens: 0,
        total_tokens: 90,
        timestamp_seconds: now,
        source_observed_at: 200,
      },
    ]);
    const rowEnv = (await ledger.load()).find(e => e.event_key === kEnvKeep);
    assert.equal(rowEnv?.total_tokens, 90);
    assert.equal(rowEnv?.environment_kind, 'ssh');
    assert.equal(rowEnv?.environment_id, 'ssh:demo001');
    assert.equal(rowEnv?.environment_label, 'demo-ssh-host');
    assert.equal(rowEnv?.trajectory_id, 'traj-anchor-99');

    // 4. 反向别名重入：inferred -> observed 可升级，observed 后旧别名重入 inferred/unknown 不得降级
    const legReentry = shaKey('m2-alias-reentry-leg');
    const kOldAlias = shaKey('m2-alias-old');
    const kNewAlias = shaKey('m2-alias-new');
    await ledger.save([
      {
        event_key: kOldAlias,
        source_id: 'src-alias-1',
        db_file: 'alias-m2.db',
        legacy_event_key: legReentry,
        model: 'gemini-3.8-flash',
        input_tokens: 100,
        output_tokens: 20,
        cached_tokens: 0,
        total_tokens: 120,
        timestamp_seconds: now,
        account_email: 'alias-inf@example.invalid',
        account_confidence: 'inferred',
        source_observed_at: 100,
      },
    ]);
    await ledger.save([
      {
        event_key: kNewAlias,
        source_id: 'src-alias-2',
        db_file: 'alias-m2.db',
        legacy_event_key: legReentry,
        model: 'gemini-3.8-flash',
        input_tokens: 100,
        output_tokens: 20,
        cached_tokens: 0,
        total_tokens: 120,
        timestamp_seconds: now,
        account_confidence: 'unknown',
        source_observed_at: 200,
      },
    ]);
    await ledger.save([
      {
        event_key: kOldAlias,
        source_id: 'src-alias-1',
        db_file: 'alias-m2.db',
        legacy_event_key: legReentry,
        model: 'gemini-3.8-flash',
        input_tokens: 100,
        output_tokens: 20,
        cached_tokens: 0,
        total_tokens: 120,
        timestamp_seconds: now,
        account_id: 'acc-alias-obs',
        account_email: 'alias-obs@example.invalid',
        account_confidence: 'observed',
        source_observed_at: 300,
      },
    ]);
    await ledger.save([
      {
        event_key: kOldAlias,
        source_id: 'src-alias-1',
        db_file: 'alias-m2.db',
        legacy_event_key: legReentry,
        model: 'gemini-3.8-flash',
        input_tokens: 100,
        output_tokens: 20,
        cached_tokens: 0,
        total_tokens: 120,
        timestamp_seconds: now,
        account_email: 'alias-downgrade@example.invalid',
        account_confidence: 'inferred',
        source_observed_at: 400,
      },
    ]);
    const rowAlias = (await ledger.load()).find(e => e.event_key === kNewAlias);
    assert.equal(rowAlias?.account_confidence, 'observed');
    assert.equal(rowAlias?.account_id, 'acc-alias-obs');
    assert.equal(rowAlias?.account_email, 'alias-obs@example.invalid');
  });
});

test('M2-5: usage-revalue 解除派生 rateDigest 硬校验后预览/应用/回滚全绿，SQLite 内部守卫依然生效', async t => {
  await withTempDir(t, async dir => {
    const ledger = new UsageLedger(dir);
    const now = Math.floor(Date.now() / 1000) - 60;
    const k1 = shaKey('m2-revalue-1');

    const initialPrices = { 'rev-model': { model: 'rev-model', input: 1, output: 2, cached: 0.1 } };
    const nextPrices = { 'rev-model': { model: 'rev-model', input: 4, output: 2, cached: 0.1 } };

    await ledger.save(
      [
        {
          event_key: k1,
          source_id: 'src-rev-1',
          model: 'rev-model',
          input_tokens: 1_000_000,
          output_tokens: 0,
          cached_tokens: 0,
          total_tokens: 1_000_000,
          timestamp_seconds: now,
        },
      ],
      { billingPrices: initialPrices }
    );

    const preview = await ledger.revalue({ action: 'preview', mode: 'force_all', prices: nextPrices, accounts: [], now });
    assert.equal(preview.before, 1);
    assert.equal(preview.after, 4);

    // 模拟派生 usage-rate-locks.json 发生重写/格式化（rateDigest 变化，但 SQLite 内部 rate_locks/revisions 未变）
    const ratesJsonPath = join(dir, 'usage-rate-locks.json');
    const originalMirror = JSON.parse(await readFile(ratesJsonPath, 'utf8'));
    await writeFile(ratesJsonPath, JSON.stringify(originalMirror, null, 2) + '\n');

    const applied = await ledger.revalue({
      action: 'apply',
      previewId: preview.previewId,
      confirmed: true,
      prices: nextPrices,
      accounts: [],
      now,
    });
    assert.equal(applied.after, 4);
    assert.equal((await ledger.aggregate({ prices: nextPrices, accountId: 'all', accounts: [], now })).all_time.estimated_usd, 4);

    const restored = await ledger.revalue({
      action: 'restore',
      previewId: preview.previewId,
      confirmed: true,
      prices: nextPrices,
      accounts: [],
      now,
    });
    assert.equal(restored.after, 1);
    assert.equal((await ledger.aggregate({ prices: {}, accountId: 'all', accounts: [], now })).all_time.estimated_usd, 1);

    // 若 SQLite 内部费率锁发生变化（sourceFeesDigest 改变），apply 仍必须拦截
    const preview2 = await ledger.revalue({ action: 'preview', mode: 'force_all', prices: nextPrices, accounts: [], now });
    await ledger.saveLocks({
      [k1]: { usd: 9, price: { model: 'rev-model', input: 9, output: 2, cached: 0.1 } },
    });
    await assert.rejects(
      ledger.revalue({
        action: 'apply',
        previewId: preview2.previewId,
        confirmed: true,
        prices: nextPrices,
        accounts: [],
        now,
      }),
      /变化|changed/i
    );
  });
});

test('M2-6: 正交 environmentId × accountId 聚合（大/小账本对齐）与 ledgerEventPage 脱敏投影', async t => {
  const prevLocale = getActiveLocale();
  t.after(() => setActiveLocale(prevLocale));

  await withTempDir(t, async dir => {
    const ledger = new UsageLedger(dir);
    const now = Math.floor(Date.now() / 1000) - 30;
    const prices = {
      'm2-ortho-model': { model: 'm2-ortho-model', input: 1, output: 2, cached: 0.1 },
    };
    const accounts = [
      { id: 'acc-a', email: 'alice@example.invalid', name: 'Alice' },
      { id: 'acc-b', email: 'bob@example.invalid', name: 'Bob' },
    ];
    const events = [
      {
        event_key: shaKey('ortho-local-a'),
        source_id: 'local-src-a',
        db_file: 'local-a.db',
        model: 'm2-ortho-model',
        input_tokens: 1_000_000,
        output_tokens: 0,
        cached_tokens: 0,
        total_tokens: 1_000_000,
        timestamp_seconds: now - 20,
        account_id: 'acc-a',
        account_email: 'alice@example.invalid',
        account_confidence: 'observed',
      },
      {
        event_key: shaKey('ortho-local-b'),
        source_id: 'local-src-b',
        db_file: 'local-b.db',
        model: 'm2-ortho-model',
        input_tokens: 500_000,
        output_tokens: 0,
        cached_tokens: 0,
        total_tokens: 500_000,
        timestamp_seconds: now - 15,
        account_id: 'acc-b',
        account_email: 'bob@example.invalid',
        account_confidence: 'observed',
      },
      {
        event_key: shaKey('ortho-ssh1-a'),
        source_id: 'ssh-src-1',
        db_file: 'remote-demo.db',
        environment_kind: 'ssh',
        environment_id: 'ssh:online01',
        environment_label: 'demo-ssh-host',
        trajectory_id: 'traj-ssh-1',
        execution: 'exec-ssh-1',
        model: 'm2-ortho-model',
        input_tokens: 300_000,
        output_tokens: 0,
        cached_tokens: 0,
        total_tokens: 300_000,
        timestamp_seconds: now - 10,
        account_id: 'acc-a',
        account_email: 'alice@example.invalid',
        account_confidence: 'observed',
      },
      {
        event_key: shaKey('ortho-ssh1-unattributed'),
        source_id: 'ssh-src-1',
        db_file: 'remote-demo.db',
        environment_kind: 'ssh',
        environment_id: 'ssh:online01',
        environment_label: 'demo-ssh-host',
        trajectory_id: 'traj-ssh-1',
        execution: 'exec-ssh-2',
        model: 'm2-ortho-model',
        input_tokens: 100_000,
        output_tokens: 0,
        cached_tokens: 0,
        total_tokens: 100_000,
        timestamp_seconds: now - 5,
        account_confidence: 'unknown',
      },
      {
        event_key: shaKey('ortho-ssh2-b'),
        source_id: 'ssh-src-2',
        db_file: 'remote-offline.db',
        environment_kind: 'ssh',
        environment_id: 'ssh:offline1',
        environment_label: 'offline-demo-host',
        trajectory_id: 'traj-ssh-2',
        execution: 'exec-ssh-3',
        model: 'm2-ortho-model',
        input_tokens: 100_000,
        output_tokens: 0,
        cached_tokens: 0,
        total_tokens: 100_000,
        timestamp_seconds: now - 2,
        account_email: 'bob@example.invalid',
        account_confidence: 'inferred',
      },
    ];
    const environments = [
      { id: 'ssh:online01', kind: 'ssh', host_label: 'demo-ssh-host', online: true, last_synced_at: now },
    ];

    await ledger.save(events, {
      billingPrices: prices,
      receipts: [
        {
          source_id: 'ssh-src-1',
          environment_id: 'ssh:online01',
          cursor_offset: 2,
          step_offset: 4,
          last_modified_sec: now,
          step_count: 4,
          committed_at: now,
        },
        {
          source_id: 'ssh-src-2',
          environment_id: 'ssh:offline1',
          cursor_offset: 1,
          step_offset: 2,
          last_modified_sec: now - 100,
          step_count: 2,
          committed_at: now - 100,
        },
      ],
    });

    // 1. 测试中文与英文回退文案及全量统计
    setActiveLocale('en');
    const aggEn = await ledger.aggregate({
      prices,
      accountId: 'all',
      environmentId: 'all',
      environments,
      remoteSyncRevision: 7,
      accounts,
      now,
    });
    assert.equal(aggEn.available_environments?.[0]?.label, 'All Environments');
    assert.equal(aggEn.available_environments?.[1]?.label, 'Local');

    setActiveLocale('zh-Hans');
    const aggAll = await ledger.aggregate({
      prices,
      accountId: 'all',
      environmentId: 'all',
      environments,
      remoteSyncRevision: 7,
      accounts,
      now,
    });
    assert.equal(aggAll.remote_sync_revision, 7);
    assert.equal(aggAll.selected_environment_id, 'all');
    assert.equal(aggAll.selected_account_id, 'all');
    assert.equal(aggAll.all_time.totals.total_tokens, 2_000_000);
    assert.equal(aggAll.all_time.estimated_usd, 2.0);
    assert.deepEqual(aggAll.environment_breakdown, {
      local_tokens: 1_500_000,
      ssh_tokens: 500_000,
      local_requests: 2,
      ssh_requests: 3,
      local_usd: 1.5,
      ssh_usd: 0.5,
      local_share_pct: 75,
      ssh_share_pct: 25,
      has_ssh_data: true,
      offline_ssh_hosts: ['offline-demo-host'],
    });
    assert.equal(aggAll.available_environments?.map(e => e.id).join(','), 'all,local,ssh:online01,ssh:offline1');
    assert.equal(aggAll.available_environments?.[0]?.label, '全部环境');
    assert.equal(aggAll.available_environments?.[1]?.label, '本机');
    assert.equal(aggAll.available_environments?.[2]?.online, true);
    assert.equal(aggAll.available_environments?.[3]?.online, false);

    // 2. 正交交叉筛选：(ssh:online01, acc-a) 与 (local, acc-b) 与 (all, acc-b)
    const aggSsh1Alice = await ledger.aggregate({
      prices,
      accountId: 'acc-a',
      environmentId: 'ssh:online01',
      environments,
      accounts,
      now,
    });
    assert.equal(aggSsh1Alice.all_time.totals.total_tokens, 300_000);
    assert.equal(aggSsh1Alice.all_time.totals.request_count, 1);
    assert.equal(aggSsh1Alice.all_time.estimated_usd, 0.3);
    assert.equal(aggSsh1Alice.selected_environment_id, 'ssh:online01');
    assert.equal(aggSsh1Alice.selected_account_id, 'acc-a');
    assert.equal(aggSsh1Alice.available_environments?.find(e => e.id === 'local')?.total_tokens, 1_000_000);
    assert.equal(aggSsh1Alice.available_environments?.find(e => e.id === 'ssh:online01')?.total_tokens, 300_000);
    assert.equal(aggSsh1Alice.available_accounts?.find(a => a.id === 'acc-a')?.total_tokens, 300_000);
    assert.equal(aggSsh1Alice.available_accounts?.find(a => a.id === 'acc-b')?.total_tokens, 0);

    // 3. ledgerEventPage 脱敏投影与正交分页验证
    const pageSsh1 = await ledger.events({
      snapshot: aggAll.ledger_snapshot,
      period: 'all',
      query: '',
      offset: 0,
      limit: 20,
      environmentId: 'ssh:online01',
    });
    assert.equal(pageSsh1.total, 2);
    for (const row of pageSsh1.rows) {
      assert.equal('event_key' in row, false, '必须剥离 event_key');
      assert.equal('source_id' in row, false, '必须剥离 source_id');
      assert.equal('legacy_event_key' in row, false, '必须剥离 legacy_event_key');
      assert.equal('db_file' in row, false, '必须剥离 db_file');
      assert.equal('trajectory_id' in row, false, '必须剥离 trajectory_id');
      assert.equal('execution' in row, false, '必须剥离 execution');
      assert.equal(row.environment_kind, 'ssh');
      assert.equal(row.environment_id, 'ssh:online01');
      assert.equal(row.environment_label, 'demo-ssh-host');
      assert.equal(Object.hasOwn(row, 'account_email'), true);
      assert.ok(['observed', 'inferred', 'unknown', 'legacy'].includes(row.account_confidence));
    }

    const pageLocal = await ledger.events({
      snapshot: aggAll.ledger_snapshot,
      period: 'all',
      query: '',
      offset: 0,
      limit: 20,
      environmentId: 'local',
    });
    assert.equal(pageLocal.total, 2);
    for (const row of pageLocal.rows) {
      assert.equal(row.environment_kind, 'local');
      assert.equal(row.environment_id, 'local');
      assert.equal(row.environment_label, '');
    }

    const pageSsh1Alice = await ledger.events({
      snapshot: aggSsh1Alice.ledger_snapshot,
      period: 'all',
      query: '',
      offset: 0,
      limit: 20,
    });
    assert.equal(pageSsh1Alice.total, 1);
    assert.equal(pageSsh1Alice.rows[0].account_email, 'alice@example.invalid');
    assert.equal(pageSsh1Alice.rows[0].account_confidence, 'observed');

    // 4. 验证小账本 buildUsageSummaryReport 与大账本 aggregateLedger 口径 100% 对齐
    const rateLocks = await ledger.locks();
    const buildSmall = (envId, accId) => {
      const accountMap = new Map([
        ['all', { id: 'all', label: '全部账号', type: 'all', total_tokens: 0, request_count: 0 }],
        ...accounts.map(a => [a.id, { ...a, label: a.email, type: 'account', total_tokens: 0, request_count: 0 }]),
      ]);
      for (const ev of events) {
        accountMap.get('all').total_tokens += ev.total_tokens;
        accountMap.get('all').request_count++;
        const ownerId = ev.account_id ?? accounts.find(a => a.email === ev.account_email)?.id;
        if (ownerId && accountMap.has(ownerId)) {
          accountMap.get(ownerId).total_tokens += ev.total_tokens;
          accountMap.get(ownerId).request_count++;
        }
      }
      return buildUsageSummaryReport({
        allEvents: events,
        effectiveEvents: events,
        knownReceiptKeys: new Set(events.map(e => e.event_key)),
        unattributedRequests: 1,
        unattributedTokens: 100_000,
        accountMap,
        accountId: accId,
        accKey: accId,
        now,
        rawPricing: prices,
        pricing: { 'm2-ortho-model': prices['m2-ortho-model'] },
        calKey: '2026-11-20',
        rateLocks,
        resolvePricing: (table, mName, ts) => resolvePricingFromTable(table, resolveDatabaseModelFullName(mName, null), ts),
        lockedCost: (ev, p) => calculateLockedEventUsd(ev, rateLocks[ev.event_key]?.price ?? p),
        dbPathsCount: 2,
        archivedDbCount: 0,
        lastDiscoveredDatabaseCount: 2,
        cachedDatabasesCount: 0,
        liveEventsCount: events.length,
        generationsScanned: events.length,
        skippedLargeRecords: 0,
        failedDatabasesCount: 0,
        diagnostics: [],
        ledgerCorrupt: false,
        archivedUnavailable: false,
        storageWarnings: new Set(),
        pricingWarnings: [],
        environmentId: envId,
        environments,
        remoteSyncRevision: 7,
      });
    };

    const normTotals = (t) => ({ ...t, cache_write_tokens: t.cache_write_tokens ?? 0 });
    const smallAll = buildSmall('all', 'all');
    assert.deepEqual(normTotals(smallAll.all_time.totals), normTotals(aggAll.all_time.totals));
    assert.equal(smallAll.all_time.estimated_usd, aggAll.all_time.estimated_usd);
    assert.deepEqual(smallAll.environment_breakdown, aggAll.environment_breakdown);
    assert.equal(smallAll.remote_sync_revision, 7);
    assert.deepEqual(
      smallAll.available_environments?.map(e => ({ id: e.id, total_tokens: e.total_tokens, online: e.online })),
      aggAll.available_environments?.map(e => ({ id: e.id, total_tokens: e.total_tokens, online: e.online }))
    );

    const smallSsh1Alice = buildSmall('ssh:online01', 'acc-a');
    assert.deepEqual(normTotals(smallSsh1Alice.all_time.totals), normTotals(aggSsh1Alice.all_time.totals));
    assert.equal(smallSsh1Alice.all_time.estimated_usd, aggSsh1Alice.all_time.estimated_usd);
    assert.equal(smallSsh1Alice.available_accounts?.find(a => a.id === 'acc-a')?.total_tokens, 300_000);
    assert.equal(smallSsh1Alice.available_accounts?.find(a => a.id === 'acc-b')?.total_tokens, 0);
  });
});

test('M2-8: accountId="unattributed" 正交筛选与 Worker WeakMap 缓存一致性验证', async t => {
  await withTempDir(t, async dir => {
    const now = Math.floor(Date.now() / 1000) - 60;
    const ledger = new UsageLedger(dir);
    const prices = {
      'm2-unattr-model': { model: 'M2 Unattr Model', input: 1, output: 2, cached: 0.1 },
    };
    const billingPrices = {
      'm2-unattr-model': [{ ...prices['m2-unattr-model'], validFrom: '2025-01-01T00:00:00Z', validUntil: '2099-01-01T00:00:00Z' }],
    };
    const environments = [
      { id: 'local', kind: 'local', label: '', online: true },
      { id: 'ssh:online01', kind: 'ssh', label: 'demo-ssh-host', online: true },
    ];
    const accounts = [
      { id: 'acc-a', email: 'alice@example.invalid' },
      { id: 'acc-b', email: 'bob@example.invalid' },
    ];
    const evLocalObs = {
      event_key: shaKey('m2-8-local-obs'),
      source_id: 'src-m2-8-local',
      environment_kind: 'local',
      environment_id: 'local',
      environment_label: '',
      model: 'm2-unattr-model',
      input_tokens: 1_000_000,
      output_tokens: 0,
      cached_tokens: 0,
      total_tokens: 1_000_000,
      timestamp_seconds: now,
      account_id: 'acc-a',
      account_email: 'alice@example.invalid',
      account_confidence: 'observed',
    };
    const evSshObs = {
      event_key: shaKey('m2-8-ssh-obs'),
      source_id: 'src-m2-8-ssh',
      environment_kind: 'ssh',
      environment_id: 'ssh:online01',
      environment_label: 'demo-ssh-host',
      model: 'm2-unattr-model',
      input_tokens: 500_000,
      output_tokens: 0,
      cached_tokens: 0,
      total_tokens: 500_000,
      timestamp_seconds: now - 5,
      account_id: 'acc-a',
      account_email: 'alice@example.invalid',
      account_confidence: 'observed',
    };
    const evSshUnattr = {
      event_key: shaKey('m2-8-ssh-unattr'),
      source_id: 'src-m2-8-ssh',
      environment_kind: 'ssh',
      environment_id: 'ssh:online01',
      environment_label: 'demo-ssh-host',
      model: 'm2-unattr-model',
      input_tokens: 200_000,
      output_tokens: 0,
      cached_tokens: 0,
      total_tokens: 200_000,
      timestamp_seconds: now - 10,
      account_id: null,
      account_email: null,
      account_confidence: 'unknown',
    };

    const initialEvents = [evLocalObs, evSshObs, evSshUnattr];
    await ledger.save(initialEvents, { billingPrices });

    const aggAll = await ledger.aggregate({ prices, accountId: 'all', environmentId: 'all', environments, accounts, now });
    assert.equal(aggAll.all_time.totals.total_tokens, 1_700_000);
    assert.equal(aggAll.available_accounts?.some(a => a.id === 'unattributed'), false);

    // 1. aggregateLedger 支持 accountId = 'unattributed' 精确筛选
    const aggUnattr = await ledger.aggregate({
      prices,
      accountId: 'unattributed',
      environmentId: 'ssh:online01',
      environments,
      accounts,
      now,
    });
    assert.equal(aggUnattr.selected_account_id, 'unattributed');
    assert.equal(aggUnattr.selected_environment_id, 'ssh:online01');
    assert.equal(aggUnattr.all_time.totals.request_count, 1);
    assert.equal(aggUnattr.all_time.totals.total_tokens, 200_000);
    assert.equal(aggUnattr.all_time.estimated_usd, 0.2);
    assert.equal(aggUnattr.unattributed_requests, 1);
    assert.equal(aggUnattr.unattributed_tokens, 200_000);
    assert.equal(aggUnattr.available_accounts?.some(a => a.id === 'unattributed'), false);

    // 2. ledgerEventPage 支持 accountId = 'unattributed'（含从 all snapshot 正交切换）
    const pageUnattr = await ledger.events({
      snapshot: aggAll.ledger_snapshot,
      period: 'all',
      query: '',
      offset: 0,
      limit: 20,
      environmentId: 'ssh:online01',
      accountId: 'unattributed',
    });
    assert.equal(pageUnattr.total, 1);
    assert.equal(pageUnattr.rows[0].account_confidence, 'unknown');
    assert.equal(pageUnattr.rows[0].environment_id, 'ssh:online01');

    // 3. 小账本 buildUsageSummaryReport 与大账本 'unattributed' 口径一致
    const rateLocks = await ledger.locks();
    const accountMap = new Map([
      ['all', { id: 'all', label: '全部账号', type: 'all', total_tokens: 0, request_count: 0 }],
      ...accounts.map(a => [a.id, { ...a, label: a.email, type: 'account', total_tokens: 0, request_count: 0 }]),
    ]);
    const smallUnattr = buildUsageSummaryReport({
      allEvents: initialEvents,
      effectiveEvents: initialEvents,
      knownReceiptKeys: new Set(),
      unattributedRequests: 1,
      unattributedTokens: 200_000,
      accountMap,
      accountId: 'unattributed',
      accKey: 'unattributed',
      now,
      rawPricing: prices,
      pricing: prices,
      calKey: new Date(now * 1000).toISOString().slice(0, 10),
      rateLocks,
      resolvePricing: (table, mName, ts) => resolvePricingFromTable(table, resolveDatabaseModelFullName(mName, null), ts),
      lockedCost: (ev, p) => calculateLockedEventUsd(ev, rateLocks[ev.event_key]?.price ?? p),
      dbPathsCount: 1,
      archivedDbCount: 0,
      lastDiscoveredDatabaseCount: 1,
      cachedDatabasesCount: 0,
      liveEventsCount: initialEvents.length,
      generationsScanned: initialEvents.length,
      skippedLargeRecords: 0,
      failedDatabasesCount: 0,
      diagnostics: [],
      ledgerCorrupt: false,
      archivedUnavailable: false,
      storageWarnings: new Set(),
      pricingWarnings: [],
      environmentId: 'ssh:online01',
      environments,
    });
    assert.equal(smallUnattr.selected_account_id, 'unattributed');
    assert.equal(smallUnattr.all_time.totals.request_count, 1);
    assert.equal(smallUnattr.all_time.totals.total_tokens, 200_000);
    assert.equal(smallUnattr.all_time.estimated_usd, 0.2);

    // 4. Worker WeakMap 缓存一致性：新增事件（revision 变更）与 saveLocks（rateRevision 变更）后必须立即失效重算
    const evSshExtra = {
      event_key: shaKey('m2-8-ssh-extra'),
      source_id: 'src-m2-8-ssh',
      environment_kind: 'ssh',
      environment_id: 'ssh:online01',
      environment_label: 'demo-ssh-host',
      model: 'm2-unattr-model',
      input_tokens: 300_000,
      output_tokens: 0,
      cached_tokens: 0,
      total_tokens: 300_000,
      timestamp_seconds: now - 2,
      account_id: 'acc-b',
      account_email: 'bob@example.invalid',
      account_confidence: 'observed',
    };
    await ledger.save([evSshExtra], { billingPrices });
    const aggAfterSave = await ledger.aggregate({ prices, accountId: 'all', environmentId: 'all', environments, accounts, now });
    assert.equal(aggAfterSave.all_time.totals.request_count, 4);
    assert.equal(aggAfterSave.all_time.totals.total_tokens, 2_000_000);
    assert.equal(aggAfterSave.all_time.estimated_usd, 2.0);

    const updatedLocks = await ledger.locks();
    updatedLocks[evLocalObs.event_key] = {
      usd: 10,
      price: { model: 'm2-unattr-model', input: 10, output: 20, cached: 1 },
    };
    await ledger.saveLocks(updatedLocks);
    const aggAfterLocks = await ledger.aggregate({ prices, accountId: 'all', environmentId: 'all', environments, accounts, now });
    assert.equal(aggAfterLocks.all_time.estimated_usd, 11.0);
  });
});
