import test from 'node:test';
import assert from 'node:assert/strict';
import { CdpHudBridge, buildConversationHudMetrics } from '../dist/hud.js';

test('bridge targets physical slots and drops A→B→A late results', async () => {
  const pending = [], sent = [];
  const engine = { getConversationMetrics: options => new Promise(resolve => pending.push({ options, resolve })), clearCache() {} };
  const bridge = new CdpHudBridge({ engine, pollIntervalMs: 0 });
  await bridge.attachToTarget('target', { send: async () => ({}), evaluate: async expression => sent.push(expression) }, () => 1);
  const attach = (id, revision, slot = 'left') => bridge.handleRawBindingPayload('target', JSON.stringify({
    type: 'SESSION_ATTACHED', cascadeId: id, paneSlotId: slot, conversationId: id, sessionRevision: revision,
    isStreaming: false, isSubagentRunning: false, modelId: 'gemini-3.8-flash', timestamp: Date.now(),
  }));
  attach('A', 1); attach('B', 2); attach('A', 3); attach('A', 4, 'right');
  for (const request of pending) request.resolve(buildConversationHudMetrics({ ...request.options, steps: [] }));
  await new Promise(r => setImmediate(r));
  assert.equal(sent.length, 2);
  assert.ok(sent.some(x => x.includes('"paneSlotId":"left"') && x.includes('"sessionRevision":3')));
  assert.ok(sent.some(x => x.includes('"paneSlotId":"right"') && x.includes('"sessionRevision":4')));
  assert.equal(bridge.getActivePanes().length, 2);
  bridge.dispose();
});

test('foreground idle plus running child keeps activityPhase idle while preserving isSubagentRunning and no cross-conversation fallback', async () => {
  const calls = [];
  const bridge = new CdpHudBridge({ pollIntervalMs: 0, engine: {
    getConversationMetrics: async options => { calls.push(options); return buildConversationHudMetrics({ ...options, steps: [] }); }, clearCache() {},
  } });
  const event = data => bridge.handleRawBindingPayload('t', JSON.stringify({ type: 'REQUEST_REFRESH', cascadeId: 'pane', timestamp: Date.now(), ...data }));
  event({ conversationId: 'A', sessionRevision: 1, modelId: 'claude-opus-5-5', isStreaming: true, activityPhase: 'generating' });
  event({ conversationId: 'A', sessionRevision: 1, isStreaming: false, isSubagentRunning: true, activityPhase: 'idle' });
  event({ conversationId: 'B', sessionRevision: 2 });
  await new Promise(r => setImmediate(r));
  assert.equal(calls[1].activityPhase, 'idle');
  assert.equal(calls[1].isSubagentRunning, true);
  assert.equal(calls[2].isStreaming, false);
  assert.notEqual(calls[2].modelId, 'claude-opus-5-5');
  bridge.dispose();
});

test('bridge fingerprint suppresses wall-clock ticking while streaming and pushes on state change', async () => {
  const sent = [];
  let inFlightModel = 10.1;
  let turnDuration = 10.1;
  let activeModelCount = 1;
  let streaming = true;
  const engine = {
    getConversationMetrics: async options => {
      const m = buildConversationHudMetrics({ ...options, observedAt: 1_700_000_000_000, steps: [] });
      m.isStreaming = streaming;
      m.session.currentTurnDurationSeconds = turnDuration;
      m.session.inFlightModelDurationSeconds = inFlightModel;
      m.session.activeModelStepCount = activeModelCount;
      return m;
    },
    clearCache() {},
  };
  const bridge = new CdpHudBridge({ engine, pollIntervalMs: 0 });
  await bridge.attachToTarget('t', { send: async () => ({}), evaluate: async expr => sent.push(expr) }, () => 1);
  bridge.handleRawBindingPayload('t', JSON.stringify({
    type: 'SESSION_ATTACHED', cascadeId: 'p', paneSlotId: 'left', conversationId: 'conv-1', sessionRevision: 1,
    isStreaming: true, activityPhase: 'generating', timestamp: Date.now(),
  }));
  await new Promise(r => setImmediate(r));
  assert.equal(sent.length, 1);

  // 流式运行期间仅挂钟秒数递增（前端本地 250ms 定时器自走表），不触发冗余跨进程 CDP Runtime.evaluate
  inFlightModel = 10.4;
  turnDuration = 10.4;
  await bridge.pollActiveSessions(true);
  assert.equal(sent.length, 1);

  inFlightModel = 24.8;
  turnDuration = 24.8;
  await bridge.pollActiveSessions(true);
  assert.equal(sent.length, 1);

  // 一旦步骤活跃计数或流式状态发生真实变更，立即推送权威指标包
  activeModelCount = 0;
  streaming = false;
  await bridge.pollActiveSessions(true);
  assert.equal(sent.length, 2);
  bridge.dispose();
});

test('P1-2 回归：SSH 远程模式仅采信 allSummaries 中归属当前会话（含传递闭包）的严格子智能体，拦截无关 DOM 提示与 BTW', async () => {
  const pushed = [];
  const fetchedStepIds = [];
  const mainId = '11111111-1111-4111-8111-111111111111';
  const childId = '22222222-2222-4222-8222-222222222222';
  const grandChildId = '33333333-3333-4333-8333-333333333333';
  const strayOtherSubId = '44444444-4444-4444-8444-444444444444';
  const btwId = '55555555-5555-4555-8555-555555555555';
  const otherMainId = '66666666-6666-4666-8666-666666666666';

  const rpcClient = {
    getAllCascadeTrajectories: async () => ({
      ok: true,
      latencyMs: 1,
      data: [
        { cascadeId: mainId, trajectoryType: 0, stepCount: 2 },
        { cascadeId: childId, trajectoryType: 1, parentConversationId: mainId, stepCount: 1 },
        { cascadeId: grandChildId, trajectoryType: 1, parentConversationId: childId, stepCount: 1 },
        { cascadeId: strayOtherSubId, trajectoryType: 1, parentConversationId: otherMainId, stepCount: 1 },
        { cascadeId: btwId, trajectoryType: 22, parentConversationId: mainId, stepCount: 1 },
      ],
    }),
    getTrajectorySteps: async (cid) => {
      fetchedStepIds.push(cid);
      return {
        ok: true,
        latencyMs: 1,
        data: [
          {
            idx: 0,
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            status: 'CORTEX_STEP_STATUS_DONE',
            metadata: {
              createdAt: '2026-11-22T08:00:00Z',
              completedAt: '2026-11-22T08:00:01Z',
              modelUsage: { inputTokens: '100', outputTokens: cid === mainId ? '50' : '25' },
            },
          },
        ],
      };
    },
    getGeneratorMetadata: async () => ({ ok: true, latencyMs: 1, data: [] }),
    getExecutorMetadata: async () => ({ ok: true, latencyMs: 1, data: null }),
  };

  const bridge = new CdpHudBridge({ pollIntervalMs: 0 });
  await bridge.attachToTarget(
    'ssh-target',
    {
      send: async () => ({}),
      evaluate: async (expr) => {
        const match = expr.match(/\)\((.*)\)$/);
        if (match) pushed.push(JSON.parse(match[1]));
        return true;
      },
    },
    () => 1,
    'GRAVITYBOX-localization-v1',
    {
      sourceKind: 'remote',
      remoteKey: 'ssh-box',
      hostLabel: 'ssh-box',
      origin: 'https://ssh-box.local',
      rpcClient,
    }
  );

  bridge.handleRawBindingPayload(
    'ssh-target',
    JSON.stringify({
      type: 'SESSION_ATTACHED',
      cascadeId: 'pane-1',
      paneSlotId: 'slot-1',
      conversationId: mainId,
      sessionRevision: 1,
      isStreaming: false,
      childConversationIds: [strayOtherSubId, btwId, '77777777-7777-4777-8777-777777777777'],
      timestamp: Date.now(),
    })
  );
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(pushed.length, 1);
  assert.ok(fetchedStepIds.includes(childId), '直接子智能体应被拉取');
  assert.ok(fetchedStepIds.includes(grandChildId), '多层嵌套子智能体应通过传递闭包被拉取');
  assert.equal(fetchedStepIds.includes(strayOtherSubId), false, '其他主会话残留 DOM 提示子智能体必须被拦截');
  assert.equal(fetchedStepIds.includes(btwId), false, 'BTW 轨迹必须被拦截');
  assert.equal(fetchedStepIds.includes('77777777-7777-4777-8777-777777777777'), false, '未在 allSummaries 验证的裸 DOM ID 必须被拦截');
  assert.equal(pushed[0].session.subagentCount, 2, '仅应计入属于当前会话的 2 个子智能体');
  assert.equal(pushed[0].tokens.outputTokens, 100, '总输出应为 main(50) + child(25) + grandChild(25) = 100');
  bridge.dispose();
});

test('P1-20: SSH 超过 32 个子轨迹跨轮完整采集、终态复用且单侧失败标为 partial', async () => {
  const mainId = 'aaaa1111-1111-4111-8111-111111111111';
  const childIds = Array.from({ length: 33 }, (_, i) => `bbbb${String(i).padStart(4, '0')}-2222-4222-8222-222222222222`);
  const pushed = [];
  const fetchedChildren = new Map();
  let failSingleSideChild0 = false;

  const rpcClient = {
    getAllCascadeTrajectories: async () => ({
      ok: true,
      latencyMs: 1,
      data: [
        { cascadeId: mainId, trajectoryType: 0, status: 'CASCADE_RUN_STATUS_IDLE', stepCount: 1 },
        ...childIds.map(cid => ({
          cascadeId: cid,
          trajectoryType: 1,
          parentConversationId: mainId,
          status: 'CASCADE_RUN_STATUS_IDLE',
          stepCount: 1,
          lastModifiedTime: '2026-11-22T08:00:00Z',
        })),
      ],
    }),
    getTrajectorySteps: async (cid) => {
      fetchedChildren.set(cid, (fetchedChildren.get(cid) ?? 0) + 1);
      return {
        ok: true,
        latencyMs: 1,
        data: [
          {
            idx: 0,
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            status: 'CORTEX_STEP_STATUS_DONE',
            metadata: {
              createdAt: '2026-11-22T08:00:00Z',
              completedAt: '2026-11-22T08:00:01Z',
              modelUsage: cid === mainId ? { inputTokens: '10', outputTokens: '5' } : { inputTokens: '10', outputTokens: '1' },
            },
          },
        ],
      };
    },
    getGeneratorMetadata: async (cid) => {
      if (failSingleSideChild0 && cid === childIds[0]) {
        return { ok: false, reason: 'http_error', authExpired: false, status: 503 };
      }
      return { ok: true, latencyMs: 1, data: [] };
    },
    getExecutorMetadata: async () => ({ ok: true, latencyMs: 1, data: null }),
  };

  const bridge = new CdpHudBridge({ pollIntervalMs: 0 });
  await bridge.attachToTarget(
    'ssh-33',
    {
      send: async () => ({}),
      evaluate: async (expr) => {
        const match = expr.match(/\)\((.*)\)$/);
        if (match) pushed.push(JSON.parse(match[1]));
        return true;
      },
    },
    () => 1,
    'GRAVITYBOX-localization-v1',
    { sourceKind: 'remote', remoteKey: 'ssh-33', hostLabel: 'ssh-33', origin: 'https://ssh-33.local', rpcClient }
  );

  bridge.handleRawBindingPayload('ssh-33', JSON.stringify({
    type: 'SESSION_ATTACHED',
    cascadeId: 'pane-33',
    paneSlotId: 'slot-33',
    conversationId: mainId,
    sessionRevision: 1,
    isStreaming: false,
    timestamp: Date.now(),
  }));
  await new Promise(r => setTimeout(r, 40));

  // 第 1 轮最多抓取 32 个子轨迹，未收齐前必须标为 partial
  assert.equal(pushed.at(-1).availability, 'partial');
  assert.equal(pushed.at(-1).session.subagentCount, 32);

  // 第 2 轮收齐第 33 个并复用前 32 个终态缓存，转为 ready 且 33 个全部计入
  await bridge.pollActiveSessions(true);
  assert.equal(pushed.at(-1).availability, 'ready');
  assert.equal(pushed.at(-1).session.subagentCount, 33);
  assert.equal(pushed.at(-1).tokens.outputTokens, 5 + 33);
  assert.equal(fetchedChildren.get(childIds[0]), 1, '已缓存终态子轨迹在第 2 轮不应重复请求 RPC');

  // 单侧失败验证：主链重新拉取新未缓存子轨迹时单侧失败计入 failedChildCount 并标 partial
  failSingleSideChild0 = true;
  // 清空旧会话缓存，强制重拉并触发 child0 单侧 gen 失败
  bridge.dispose();

  const pushedSingle = [];
  const bridge2 = new CdpHudBridge({ pollIntervalMs: 0 });
  const rpcSingleFail = {
    ...rpcClient,
    getAllCascadeTrajectories: async () => ({
      ok: true,
      latencyMs: 1,
      data: [
        { cascadeId: mainId, trajectoryType: 0, status: 'CASCADE_RUN_STATUS_IDLE', stepCount: 1 },
        { cascadeId: childIds[0], trajectoryType: 1, parentConversationId: mainId, status: 'CASCADE_RUN_STATUS_IDLE', stepCount: 1 },
      ],
    }),
  };
  await bridge2.attachToTarget(
    'ssh-single-fail',
    {
      send: async () => ({}),
      evaluate: async (expr) => {
        const match = expr.match(/\)\((.*)\)$/);
        if (match) pushedSingle.push(JSON.parse(match[1]));
        return true;
      },
    },
    () => 1,
    'GRAVITYBOX-localization-v1',
    { sourceKind: 'remote', remoteKey: 'ssh-sf', hostLabel: 'ssh-sf', origin: 'https://ssh-sf.local', rpcClient: rpcSingleFail }
  );
  bridge2.handleRawBindingPayload('ssh-single-fail', JSON.stringify({
    type: 'SESSION_ATTACHED',
    cascadeId: 'pane-sf',
    paneSlotId: 'slot-sf',
    conversationId: mainId,
    sessionRevision: 1,
    isStreaming: false,
    timestamp: Date.now(),
  }));
  await new Promise(r => setTimeout(r, 30));
  assert.equal(pushedSingle.at(-1).availability, 'partial', '单侧 RPC 失败必须标记 partial');
  assert.ok((pushedSingle.at(-1).failedChildCount ?? 0) >= 1, '单侧 RPC 失败必须计入 failedChildCount');
  bridge2.dispose();
});
