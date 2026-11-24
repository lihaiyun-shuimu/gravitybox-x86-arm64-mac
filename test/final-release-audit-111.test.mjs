import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  CdpHudBridge,
  ConversationMetricsEngine,
  buildConversationHudMetrics,
} from '../dist/hud.js';
import { HudInstance } from '../runtime/hud-instance.js';
import {
  evaluateModelConsensus,
  runAutoUpdatePricing,
} from '../tools/auto-update-pricing.mjs';
import { buildAccountQuotaOverview } from '../dist/account-quota.js';
import { resolvePricingCatalogSnapshot } from '../dist/pricing.js';
import { UsageLedger } from '../dist/usage-ledger.js';

function varint(value) {
  let remaining = BigInt(value);
  const bytes = [];
  do {
    const byte = Number(remaining & 127n);
    remaining >>= 7n;
    bytes.push(byte | (remaining ? 128 : 0));
  } while (remaining);
  return bytes;
}
const scalar = (field, value) => [...varint(field * 8), ...varint(value)];
const message = (field, bytes) => [...varint(field * 8 + 2), ...varint(bytes.length), ...bytes];
const string = (field, value) => message(field, Buffer.from(value));
function seconds(field, value) {
  const whole = Math.floor(value);
  return message(field, [...scalar(1, whole), ...scalar(2, Math.round((value - whole) * 1e9))]);
}

const openDbsByTest = new WeakMap();
function trackDb(t, db) {
  let list = openDbsByTest.get(t);
  if (!list) { list = []; openDbsByTest.set(t, list); }
  list.push(db);
  return db;
}
function closeTrackedDbs(t) {
  const list = openDbsByTest.get(t);
  if (!list) return;
  for (const db of list.splice(0)) { try { db.close(); } catch {} }
}

function createConvDb(t, dir, id, parentId) {
  const dbPath = path.join(dir, `${id}.db`);
  const db = trackDb(t, new DatabaseSync(dbPath));
  t.after(() => {
    try {
      db.close();
    } catch {}
  });
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE steps (
      idx INTEGER PRIMARY KEY,
      step_type INTEGER NOT NULL,
      status INTEGER NOT NULL,
      metadata BLOB,
      render_info BLOB,
      step_payload BLOB
    );
    CREATE TABLE gen_metadata (
      idx INTEGER PRIMARY KEY,
      data BLOB,
      size INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE trajectory_meta (
      trajectory_id TEXT PRIMARY KEY,
      cascade_id TEXT,
      trajectory_type INTEGER
    );
    CREATE TABLE trajectory_metadata_blob (
      id TEXT PRIMARY KEY,
      data BLOB
    );
  `);
  db.prepare('INSERT INTO trajectory_meta VALUES (?, ?, ?)').run(id, id, 0);
  if (parentId) {
    const parentBlob = Buffer.from([...string(5, parentId), ...string(6, parentId)]);
    db.prepare('INSERT INTO trajectory_metadata_blob VALUES (?, ?)').run('main', parentBlob);
  }
  return { db, dbPath };
}

test('OPT-01: 子智能体分栏在步间 status=3 空档期借助 conversation_summaries.db RUNNING 保持 HUD 流式计时与父会话活跃计数', async (t) => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-opt01-'));
  t.after(() => { closeTrackedDbs(t); fs.rmSync(baseDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });
  const convDir = path.join(baseDir, 'conversations');
  fs.mkdirSync(convDir, { recursive: true });

  const mainId = '11111111-aaaa-4111-8111-111111111111';
  const childId = '22222222-bbbb-4222-8222-222222222222';

  const summariesDb = trackDb(t, new DatabaseSync(path.join(baseDir, 'conversation_summaries.db')));
  t.after(() => {
    try {
      summariesDb.close();
    } catch {}
  });
  summariesDb.exec(`
    CREATE TABLE conversation_parents (child_id TEXT PRIMARY KEY, parent_id TEXT NOT NULL);
    CREATE TABLE conversation_summaries (id TEXT PRIMARY KEY, status TEXT, updated_at INTEGER);
  `);
  summariesDb.prepare('INSERT INTO conversation_parents VALUES (?, ?)').run(childId, mainId);
  summariesDb
    .prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?)')
    .run(childId, 'CASCADE_RUN_STATUS_RUNNING', 3000);

  const nowSec = Math.floor(Date.now() / 1000);
  const { db: mainDb } = createConvDb(t, convDir, mainId);
  mainDb.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (0, 14, 3, ?)').run(
    Buffer.from(seconds(1, nowSec - 20))
  );
  mainDb.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (1, 132, 3, ?)').run(
    Buffer.from([
      ...seconds(1, nowSec - 19),
      ...message(4, [...string(2, 'invoke_subagent'), ...string(3, JSON.stringify({ id: childId }))]),
      ...seconds(8, nowSec - 18),
    ])
  );

  // 子智能体前序步骤均为 status=3（正处于下一步落库前的步间过渡窗），且无 step_type=2 终结符
  const { db: childDb, dbPath: childDbPath } = createConvDb(t, convDir, childId, mainId);
  childDb.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (0, 14, 3, ?)').run(
    Buffer.from(seconds(1, nowSec - 18))
  );
  childDb.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (1, 15, 3, ?)').run(
    Buffer.from([...seconds(1, nowSec - 17), ...seconds(7, nowSec - 12)])
  );

  const engine = new ConversationMetricsEngine({ conversationsDir: convDir });

  // 1) 父会话即使前端 DOM isSubagentRunning=false，也能从 summaries RUNNING 识别 1 个活跃子代理
  const parentMetrics = await engine.getConversationMetrics({
    conversationId: mainId,
    isStreaming: false,
    isSubagentRunning: false,
  });
  assert.equal(parentMetrics.isSubagentRunning, true);
  assert.equal(parentMetrics.runningSubagentCount, 1);

  // 2) 子智能体独立分栏无停止按钮 (isStreaming=false) 时，借助 summaries selfRunning 保持流式计时不断流
  const subpaneMetrics = await engine.getConversationMetrics({
    conversationId: childId,
    isStreaming: false,
    isSubagentRunning: false,
  });
  assert.equal(subpaneMetrics.session.isSubagentTrajectory, true);
  assert.equal(subpaneMetrics.isStreaming, true);
  assert.equal(subpaneMetrics.session.currentTurnDurationSeconds >= 15, true);

  // 3) P1-17: 超过 60 分钟仍在运行的子智能体不被 recency 阈值截断；INTERRUPTED(12) 或 DONE(stepType=2) 立即停表
  const oldDate = new Date(Date.now() - 75 * 60 * 1000);
  childDb.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  fs.utimesSync(childDbPath, oldDate, oldDate);
  if (fs.existsSync(`${childDbPath}-wal`)) fs.utimesSync(`${childDbPath}-wal`, oldDate, oldDate);
  const staleMtimeEngine = new ConversationMetricsEngine({ conversationsDir: convDir });
  const longRunningSub = await staleMtimeEngine.getConversationMetrics({
    conversationId: childId,
    isStreaming: false,
    isSubagentRunning: false,
  });
  assert.equal(longRunningSub.isStreaming, true, '超过 60 分钟且 summaries 为 RUNNING 的子智能体仍保持运行态');

  const parentWithOldRunningChild = await staleMtimeEngine.getConversationMetrics({
    conversationId: mainId,
    isStreaming: false,
    isSubagentRunning: false,
  });
  assert.equal(parentWithOldRunningChild.runningSubagentCount, 1, '父会话也应保留超过 60 分钟但仍 RUNNING 的子智能体计数');

  // 注入 INTERRUPTED(12) 末步 -> 立即停表
  childDb.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (2, 15, 12, ?)').run(
    Buffer.from([...seconds(1, nowSec - 10), ...seconds(7, nowSec - 5)])
  );
  const interruptedSub = await staleMtimeEngine.getConversationMetrics({
    conversationId: childId,
    isStreaming: false,
    isSubagentRunning: false,
  });
  assert.equal(interruptedSub.isStreaming, false, '子智能体出现 INTERRUPTED=12 末步后必须立即停止流式计时');
});

test('OPT-02 & OPT-05: 多步轮次末步无结束时间中止保留 turnAbortedMissingEnd 高水位，且透明步骤不阻断 awaitingFirstTurnStep', () => {
  // OPT-02: 前序步已完成 5s，末步运行 40s 后被中止 (status=4) 且缺失结束时间戳
  const abortedMissingEnd = buildConversationHudMetrics({
    conversationId: 'conv-opt02',
    isStreaming: false,
    steps: [
      { idx: 0, stepType: 14, status: 3, createdAtSeconds: 1000, completedAtSeconds: 1000, hasUsage: false },
      { idx: 1, stepType: 15, status: 3, startTimeSeconds: 1000, endTimeSeconds: 1005, hasUsage: false },
      { idx: 2, stepType: 15, status: 4, startTimeSeconds: 1006, endTimeSeconds: null, hasUsage: false },
    ],
  });
  assert.equal(abortedMissingEnd.session.turnAborted, true);
  assert.equal(abortedMissingEnd.session.turnAbortedMissingEnd, true);
  assert.equal(abortedMissingEnd.session.currentTurnDurationSeconds, 5);

  // 验证 HudInstance 在 turnAbortedMissingEnd=true 时保留前端 45s 实时高水位不回退到 5s
  const inst = new HudInstance('pane-opt02', { languageMode: 'en' });
  inst.turnHighWaterMark = { convId: 'conv-opt02', turns: 1, seconds: 45, hasSubagent: false };
  inst.currentConvId = 'conv-opt02';
  // 仅调用高水位状态对齐逻辑（无需挂载真实 DOM）
  inst.shadow = {
    querySelector: () => ({
      textContent: '',
      setAttribute() {},
      removeAttribute() {},
      style: {},
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    }),
    querySelectorAll: () => [],
  };
  inst.containerEl = {
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {},
    removeAttribute() {},
    style: {},
  };
  inst.updateMetrics(abortedMissingEnd);
  assert.equal(inst.turnHighWaterMark?.seconds, 45);
  inst.dispose();

  // OPT-05: USER_INPUT (14) 后紧跟 EPHEMERAL_MESSAGE (81) / CONVERSATION_HISTORY (98) 透明步骤时，awaitingFirstTurnStep 仍为 true
  const withTransparentSteps = buildConversationHudMetrics({
    conversationId: 'conv-opt05',
    isStreaming: true,
    activityPhase: 'generating',
    steps: [
      { idx: 0, stepType: 14, status: 3, createdAtSeconds: 1000, completedAtSeconds: 1000, hasUsage: false },
      { idx: 1, stepType: 15, status: 3, startTimeSeconds: 1001, endTimeSeconds: 1015, hasUsage: false },
      { idx: 2, stepType: 14, status: 3, createdAtSeconds: 2000, completedAtSeconds: 2000, hasUsage: false },
      { idx: 3, stepType: 81, status: 3, createdAtSeconds: 2000, completedAtSeconds: 2000, hasUsage: false },
      { idx: 4, stepType: 98, status: 3, createdAtSeconds: 2000, completedAtSeconds: 2000, hasUsage: false },
    ],
  });
  assert.equal(withTransparentSteps.session.awaitingFirstTurnStep, true);
});

test('OPT-06: CdpHudBridge 在收到 SESSION_ATTACHED / REQUEST_REFRESH 或重连 attachToTarget 时重置指纹以强制补发快照', async () => {
  const sent = [];
  const bridge = new CdpHudBridge({
    pollIntervalMs: 0,
    engine: {
      getConversationMetrics: async (options) =>
        buildConversationHudMetrics({
          ...options,
          observedAt: 1_700_000_000_000,
          steps: [
            { idx: 0, stepType: 14, status: 3, createdAtSeconds: 100, completedAtSeconds: 100, hasUsage: false },
          ],
        }),
      clearCache() {},
    },
  });

  const cdpClient = {
    send: async () => ({}),
    evaluate: async (expr) => {
      sent.push(expr);
      return true;
    },
  };

  try {
    await bridge.attachToTarget('t-opt06', cdpClient, () => 1);
    const basePayload = {
      cascadeId: 'pane-opt06',
      paneSlotId: 'main',
      conversationId: 'conv-opt06',
      sessionRevision: 1,
      isStreaming: false,
      activityPhase: 'idle',
    };

    bridge.handleRawBindingPayload(
      't-opt06',
      JSON.stringify({ ...basePayload, type: 'SESSION_ATTACHED', timestamp: 1 })
    );
    await new Promise((r) => setImmediate(r));
    assert.equal(sent.length, 1);

    // 常规轮询在指标未变化时保持幂等不重发
    await bridge.pollActiveSessions(true);
    assert.equal(sent.length, 1);

    // 前端 HUD 重建后再次发送同 conversationId 的 SESSION_ATTACHED，必须突破指纹缓存重新下发
    bridge.handleRawBindingPayload(
      't-opt06',
      JSON.stringify({ ...basePayload, type: 'SESSION_ATTACHED', timestamp: 2 })
    );
    await new Promise((r) => setImmediate(r));
    assert.equal(sent.length, 2);

    // REQUEST_REFRESH 同样必须强制补发最新快照
    bridge.handleRawBindingPayload(
      't-opt06',
      JSON.stringify({ ...basePayload, type: 'REQUEST_REFRESH', timestamp: 3 })
    );
    await new Promise((r) => setImmediate(r));
    assert.equal(sent.length, 3);
  } finally {
    bridge.dispose();
  }
});

test('OPT-03: 价格自动巡检识别 >200k 长上下文阶梯价变动，且仅发现新模型雷达时输出 yellow_needs_review 触发告警 Issue', async (t) => {
  const nowMs = Date.parse('2026-11-18T02:00:00Z');
  const tieredLocal = {
    model: 'gemini-4-carbon',
    input: 2.0,
    output: 12.0,
    cached: 0.2,
    contextTiers: [{ thresholdTokens: 200_000, maxInputTokens: 200_000, input: 4.0, output: 18.0, cached: 0.4 }],
    provenance: { verification: 'confirmed', sourceUrl: 'https://ai.google.dev/pricing' },
  };

  // 基础价完全未变，但官网 >200k 阶梯价从 $4/$18 调整为 $3/$15 -> 必须标记为 yellow
  const tierDrift = evaluateModelConsensus({
    key: 'gemini-4-carbon',
    localEntry: tieredLocal,
    official: {
      officialModelName: 'Gemini 4 Carbon',
      inputPer1M: 2.0,
      outputPer1M: 12.0,
      cachedPer1M: 0.2,
      hasContextTiers: true,
      contextThresholdTokens: 200_000,
      tierInputPer1M: 3.0,
      tierOutputPer1M: 15.0,
      tierCachedPer1M: 0.3,
      confidence: 'high',
      evidenceQuote: 'Gemini 4 Carbon >200k: $3.00 / $15.00',
    },
    litellm: { input: 2.0, output: 12.0, cached: 0.2, hasContextTiers: true },
    nowMs,
  });
  assert.equal(tierDrift.status, 'yellow');
  assert.equal(tierDrift.reasons.some((r) => r.includes('长上下文阶梯价变动')), true);

  // 端到端验证：已入库模型无变动，但官网出现 claude-4-7-sonnet（版本在前命名）新模型 -> decision 为 yellow_needs_review
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-opt03-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const catalogPath = path.join(dir, 'catalog.json');
  const feedPath = path.join(dir, 'feed.json');
  const reportPath = path.join(dir, 'report.json');
  fs.writeFileSync(
    catalogPath,
    JSON.stringify({
      schema: 1,
      names: { 'claude-sonnet-4-6': 'Claude Sonnet 4.6' },
      prices: {
        'claude-sonnet-4-6': {
          model: 'claude-sonnet-4-6',
          input: 3.0,
          output: 15.0,
          cached: 0.3,
          cacheWrite: 3.75,
          provenance: {
            sourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
            verification: 'confirmed',
          },
        },
      },
      activeModels: ['claude-sonnet-4-6'],
      feedModels: ['claude-sonnet-4-6'],
      pricingVersion: '2026-11-17',
    }),
    'utf8'
  );

  const report = await runAutoUpdatePricing({
    write: false,
    nowMs,
    catalogPath,
    feedPath,
    reportPath,
    geminiApiKey: 'fake-key',
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.includes('platform.claude.com')) {
        return new Response(
          '<html><body><h1>Claude API Pricing</h1><p>' +
            'Standard API million tokens pricing table. '.repeat(10) +
            '</p><table><tr><td>Claude Sonnet 4.6</td><td>$3 / MTok</td><td>$15 / MTok</td></tr>' +
            '<tr><td>Claude 4.7 Sonnet</td><td>$3 / MTok</td><td>$15 / MTok</td></tr></table></body></html>',
          { status: 200 }
        );
      }
      if (u.includes('generativelanguage.googleapis.com')) {
        return Response.json({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      pageParsedOk: true,
                      models: [
                        {
                          catalogKey: 'claude-sonnet-4-6',
                          officialModelName: 'Claude Sonnet 4.6',
                          inputPer1M: 3.0,
                          outputPer1M: 15.0,
                          cachedPer1M: 0.3,
                          cacheWritePer1M: 3.75,
                          confidence: 'high',
                          evidenceQuote: 'Claude Sonnet 4.6 $3 / $15',
                        },
                        {
                          officialModelName: 'claude-4-7-sonnet',
                          inputPer1M: 3.0,
                          outputPer1M: 15.0,
                          confidence: 'high',
                          evidenceQuote: 'Claude 4.7 Sonnet $3 / $15',
                        },
                      ],
                    }),
                  },
                ],
              },
            },
          ],
        });
      }
      if (u.includes('litellm')) {
        return Response.json({
          'anthropic/claude-sonnet-4-6': {
            input_cost_per_token: 3e-6,
            output_cost_per_token: 15e-6,
            cache_read_input_token_cost: 0.3e-6,
            cache_creation_input_token_cost: 3.75e-6,
          },
        });
      }
      return Response.json({ data: [] });
    },
  });

  assert.equal(report.newModelsRadar.length, 1);
  assert.equal(report.newModelsRadar[0].model, 'claude-4-7-sonnet');
  assert.equal(report.decision, 'yellow_needs_review');
});

test('OPT-07 & OPT-09 & OPT-10 & OPT-12: Pro Trial/Ultra Trial 不误判为 FREE，云端可读新模型与 o5 家族入选待定价列表，revalue 彻底清理 legacy_event_key 旧锁，且引擎配额模板覆盖 daily/five hour', async (t) => {
  // 1) OPT-07: Google AI Pro Trial / Google AI Ultra Trial 不被 buildAccountQuotaOverview 误归入 FREE，且 IPC 投影归一化为 PRO / ULTRA
  const { normalizeSubscriptionTier } = await import('../dist/ipc-projections.js');
  const proTrialOverview = buildAccountQuotaOverview({
    quota: {
      subscription_tier: 'Google AI Pro Trial',
      last_updated: 1_760_000_000,
      is_forbidden: false,
      model_forwarding_rules: {},
      models: [],
    },
  });
  assert.notEqual(proTrialOverview.subscriptionTier, 'FREE');
  assert.equal(normalizeSubscriptionTier(proTrialOverview.subscriptionTier), 'PRO');

  const ultraTrialOverview = buildAccountQuotaOverview({
    quota: {
      subscription_tier: 'Google AI Ultra Trial',
      last_updated: 1_760_000_000,
      is_forbidden: false,
      model_forwarding_rules: {},
      models: [],
    },
  });
  assert.notEqual(ultraTrialOverview.subscriptionTier, 'FREE');
  assert.equal(normalizeSubscriptionTier(ultraTrialOverview.subscriptionTier), 'ULTRA');

  const starterTrialOverview = buildAccountQuotaOverview({
    quota: {
      subscription_tier: 'Starter Trial',
      last_updated: 1_760_000_000,
      is_forbidden: false,
      model_forwarding_rules: {},
      models: [],
    },
  });
  assert.equal(starterTrialOverview.subscriptionTier, 'FREE');

  // 2) OPT-09: account_cloud 来源的新一代可读模型（含双词可读 Trial 预览版与 o5-mini）均进入 unpricedLiveModels，内部单字标识仍被拦截
  const snap = resolvePricingCatalogSnapshot({
    rawPricingTable: {},
    activeAccount: {
      source: 'cloud',
      tier: 'ULTRA',
      models: [
        { id: 'gemini-5-xenon-trial', displayName: 'Gemini 5 Xenon Trial' },
        { id: 'o5-mini', displayName: 'OpenAI o5-mini' },
        { id: 'internal-exp-99-trial', displayName: 'internal-exp-99-trial' },
      ],
    },
  });
  const unpricedKeys = snap.unpricedLiveModels.map((m) => m.key);
  assert.equal(unpricedKeys.includes('gemini-5-xenon-trial'), true);
  assert.equal(unpricedKeys.includes('o5-mini'), true);
  assert.equal(unpricedKeys.includes('internal-exp-99-trial'), false);

  // 3) OPT-10: revalueLedger 在重估迁移后事件时同步删除 legacy_event_key 下的旧费率锁
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-opt10-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = new UsageLedger(path.join(dir, 'ledger'));
  const now = Math.floor(Date.now() / 1000);
  const newKey = 'a'.repeat(64);
  const legKey = 'b'.repeat(64);

  await ledger.save([
    {
      event_key: newKey,
      legacy_event_key: legKey,
      source_id: 'src-opt10',
      db_file: 'live.db',
      model: 'test-paid',
      input_tokens: 1_000_000,
      output_tokens: 0,
      cached_tokens: 0,
      total_tokens: 1_000_000,
      timestamp_seconds: now - 60,
    },
  ]);
  await ledger.saveLocks({
    [legKey]: { usd: 9.0, price: { model: 'test-paid', input: 9.0, output: 0, cached: 0 } },
  });

  const prices = { 'test-paid': { model: 'test-paid', input: 2.5, output: 0, cached: 0 } };
  const preview = await ledger.revalue({
    action: 'preview',
    mode: 'force_all',
    prices,
    liveFiles: ['live.db'],
    now,
  });
  assert.equal(preview.before, 9.0);
  assert.equal(preview.after, 2.5);
  await ledger.revalue({
    action: 'apply',
    previewId: preview.previewId,
    confirmed: true,
    prices,
    liveFiles: ['live.db'],
    now,
  });
  const aggAfterApply = await ledger.aggregate({ prices, accountId: 'all', accounts: [], liveFiles: ['live.db'], now });
  assert.equal(aggAfterApply.all_time.estimated_usd, 2.5);

  // 4) OPT-12: runtime/engine.js 静态模板规则覆盖 daily / five hour quota limit 句式
  const engineSrc = fs.readFileSync(new URL('../runtime/engine.js', import.meta.url), 'utf8');
  assert.equal(engineSrc.includes("You have (used some of|hit) your (weekly|daily|5-hour|five[- ]hour|"), true);
  assert.equal(engineSrc.includes("'five hour': '5小时'"), true);
});
