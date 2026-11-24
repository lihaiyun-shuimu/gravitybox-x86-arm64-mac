import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildLiveProbeResultFromRpc } from '../dist/account-probe.js';
import { CdpHudBridge, buildConversationHudMetrics } from '../dist/hud.js';
import {
  SshRemoteRpcClient,
  computeRemoteConversationHudMetrics,
  isStrictSubagentSummary,
  mapCortexStepStatusToNumeric,
  mapCortexStepTypeToNumeric,
  mapRemoteRpcToHudInput,
  parseConnectDurationSeconds,
  parseConnectTimestampSeconds,
} from '../dist/ssh-remote-rpc.js';
import { HudInstance } from '../runtime/hud-instance.js';
import { HUD_I18N } from '../runtime/hud-i18n.js';

function createInPageHarness({ token = 'secret-csrf-token-value-123456', routes = {} }) {
  const calls = [];
  const fakeWindow = {
    localStorage: {
      getItem: (key) => (key === 'agy_session_csrf_token' ? token : null),
    },
    fetch: async (url, init) => {
      const method = String(url).split('/').pop();
      calls.push({ url, method, headers: init?.headers, body: init?.body ? JSON.parse(init.body) : {} });
      const handler = routes[method];
      if (!handler) {
        return { ok: false, status: 404, async json() { return {}; } };
      }
      const res = typeof handler === 'function' ? await handler(init) : handler;
      const status = res.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        async json() {
          return res.body;
        },
      };
    },
    AbortController,
    Date,
    Object,
    Array,
    Number,
    String,
    Boolean,
    JSON,
    Math,
    setTimeout,
    clearTimeout,
  };
  const cdp = {
    async evaluate(expression, contextId) {
      assert.equal(contextId, 42);
      return vm.runInNewContext(expression, fakeWindow);
    },
  };
  return { cdp, calls, token };
}

test('buildLiveProbeResultFromRpc 支持 local/remote_rpc 前缀与 Enterprise Vertex 识别', () => {
  const userStatus = {
    email: 'dev@example.invalid',
    name: 'Remote Dev',
    userTier: { id: 'g1-ultra-tier', name: 'Google AI Ultra' },
    cascadeModelConfigData: {
      clientModelConfigs: [
        {
          modelOrAlias: { model: 'MODEL_GEMINI_3_8_FLASH' },
          label: 'Gemini 3.8 Flash',
          quotaInfo: { remainingFraction: 0.85, resetTime: '2026-11-20T18:00:00Z' },
        },
      ],
    },
  };
  const quotaSummary = {
    groups: [
      {
        displayName: 'Gemini Models',
        buckets: [
          {
            bucketId: 'gemini-5h',
            window: 'WINDOW_5_HOUR',
            remainingFraction: 0.85,
            resetTime: '2026-11-20T18:00:00Z',
          },
        ],
      },
    ],
  };

  const remote = buildLiveProbeResultFromRpc(
    { userStatus },
    quotaSummary,
    undefined,
    { sourcePrefix: 'remote_rpc' }
  );
  assert.ok(remote);
  assert.equal(remote.email, 'dev@example.invalid');
  assert.equal(remote.tier, 'ULTRA');
  assert.deepEqual(remote.quota?.refresh_state?.endpointsAttempted, [
    'remote_rpc:GetUserStatus',
    'remote_rpc:RetrieveUserQuotaSummary',
  ]);
  assert.deepEqual(remote.quota?.refresh_state?.endpointsSucceeded, [
    'remote_rpc:GetUserStatus',
    'remote_rpc:RetrieveUserQuotaSummary',
  ]);
  assert.equal(buildLiveProbeResultFromRpc({}, quotaSummary), null);
});

test('SshRemoteRpcClient 在页面内强裁剪 promptSections/tools 且绝不泄露 CSRF token', async () => {
  const hugePrompt = 'X'.repeat(90_000);
  const { cdp, calls, token } = createInPageHarness({
    routes: {
      GetUserStatus: {
        body: {
          userStatus: {
            email: 'ssh-user@example.invalid',
            name: 'SSH User',
            userTier: { id: 'free-tier', name: 'Free' },
            secretExtraBlob: 'DO_NOT_EXFILTRATE',
            cascadeModelConfigData: {
              clientModelConfigs: [
                {
                  modelOrAlias: { model: 'gemini-3.8-flash' },
                  label: 'Gemini 3.8 Flash',
                  quotaInfo: { remainingFraction: 0.9, resetTime: '2026-11-20T18:00:00Z' },
                },
              ],
            },
          },
        },
      },
      RetrieveUserQuotaSummary: {
        body: {
          groups: [
            {
              displayName: 'Gemini Models',
              buckets: [{ window: 'WINDOW_5_HOUR', remainingFraction: 0.9, resetTime: '2026-11-20T18:00:00Z' }],
            },
          ],
        },
      },
      GetAllCascadeTrajectories: {
        body: {
          trajectorySummaries: {
            'conv-main': {
              trajectoryId: 'traj-main-1',
              stepCount: 4,
              summary: 'PRIVATE_CHAT_TITLE_MUST_BE_STRIPPED',
              lastModifiedTime: '2026-11-20T05:43:10Z',
              trajectoryMetadata: { rootConversationId: 'conv-main', workspaceUris: ['/secret/path'] },
            },
          },
        },
      },
      GetCascadeTrajectoryGeneratorMetadata: {
        body: {
          generatorMetadata: [
            {
              stepIndices: [1],
              executionId: 'exec-1',
              chatModel: {
                model: 'MODEL_PLACEHOLDER_M320',
                responseModel: 'gemini-3.8-flash-n',
                timeToFirstToken: '1.25s',
                streamingDuration: '0.75s',
                promptSections: [{ text: hugePrompt }],
                systemPrompt: hugePrompt,
                tools: [{ name: 'run_command', schema: hugePrompt }],
                customMetadata: { privateNote: 'secret' },
                chatStartMetadata: {
                  checkpointIndex: 0,
                  contextWindowMetadata: { estimatedTokensUsed: 15000, maxContextTokens: 256000 },
                },
                usage: {
                  inputTokens: '1200',
                  outputTokens: '300',
                  cacheReadTokens: '800',
                  responseOutputTokens: '300',
                  responseHeader: { secret: 'strip-me' },
                },
              },
            },
          ],
        },
      },
      GetCascadeTrajectorySteps: {
        body: {
          steps: [
            { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE', metadata: { createdAt: '2026-11-20T05:40:00Z' }, userInput: { items: [{ text: 'SECRET_PROMPT' }] } },
            { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE', metadata: { createdAt: '2026-11-20T05:40:01Z', completedAt: '2026-11-20T05:40:03Z', executionId: 'exec-1' }, plannerResponse: { response: 'SECRET_REPLY' } },
          ],
        },
      },
    },
  });

  const client = new SshRemoteRpcClient({ cdp, getContextId: () => 42, timeoutMs: 2000 });
  const quotaRes = await client.probeUserAndQuota();
  const trajRes = await client.getAllCascadeTrajectories();
  const genRes = await client.getGeneratorMetadata('conv-main', 0);
  const stepsRes = await client.getTrajectorySteps('conv-main', 0);

  assert.equal(quotaRes.ok, true);
  assert.equal(quotaRes.data.email, 'ssh-user@example.invalid');
  assert.equal(trajRes.ok, true);
  assert.equal(genRes.ok, true);
  assert.equal(stepsRes.ok, true);
  assert.equal(calls.every(c => c.headers['x-codeium-csrf-token'] === token), true);

  const wireDump = JSON.stringify({ quotaRes, trajRes, genRes, stepsRes });
  assert.equal(wireDump.includes(token), false);
  assert.equal(wireDump.includes('promptSections'), false);
  assert.equal(wireDump.includes('systemPrompt'), false);
  assert.equal(wireDump.includes('PRIVATE_CHAT_TITLE_MUST_BE_STRIPPED'), false);
  assert.equal(wireDump.includes('SECRET_PROMPT'), false);
  assert.equal(wireDump.includes('SECRET_REPLY'), false);
  assert.equal(wireDump.includes('strip-me'), false);
  assert.equal(genRes.data[0].usage?.inputTokens, '1200');
  assert.equal(genRes.data[0].contextWindowMetadata?.maxContextTokens, 256000);
});

test('SshRemoteRpcClient 在缺令牌与 HTTP 401/403 时统一返回 authExpired: true', async () => {
  const missingTokenHarness = createInPageHarness({ token: '', routes: {} });
  const missingClient = new SshRemoteRpcClient({ cdp: missingTokenHarness.cdp, getContextId: () => 42 });
  const missingRes = await missingClient.probeUserAndQuota();
  assert.equal(missingRes.ok, false);
  assert.equal(missingRes.authExpired, true);
  assert.equal(missingRes.reason, 'auth_expired');

  const unauthorizedHarness = createInPageHarness({
    token: 'expired-token',
    routes: {
      GetUserStatus: { status: 403, body: {} },
      RetrieveUserQuotaSummary: { status: 200, body: { groups: [] } },
      GetCascadeTrajectorySteps: { status: 401, body: {} },
    },
  });
  const unauthClient = new SshRemoteRpcClient({ cdp: unauthorizedHarness.cdp, getContextId: () => 42 });
  const r1 = await unauthClient.probeUserAndQuota();
  const r2 = await unauthClient.getTrajectorySteps('conv-1', 0);
  assert.equal(r1.ok, false);
  assert.equal(r1.authExpired, true);
  assert.equal(r2.ok, false);
  assert.equal(r2.authExpired, true);
});

test('Connect RPC 纯映射函数：Duration/Timestamp、stepType/status、严格子智能体判定与 HUD 计算', () => {
  assert.ok(Math.abs((parseConnectDurationSeconds('2.487s') ?? 0) - 2.487) < 1e-6);
  assert.equal(parseConnectDurationSeconds({ seconds: '1', nanos: 500_000_000 }), 1.5);
  assert.ok((parseConnectTimestampSeconds('2026-11-20T05:40:00.500Z') ?? 0) > 1_700_000_000);

  assert.equal(mapCortexStepTypeToNumeric('CORTEX_STEP_TYPE_USER_INPUT'), 14);
  assert.equal(mapCortexStepTypeToNumeric('CORTEX_STEP_TYPE_PLANNER_RESPONSE'), 15);
  assert.equal(mapCortexStepTypeToNumeric('CORTEX_STEP_TYPE_CHECKPOINT'), 23);
  assert.equal(mapCortexStepTypeToNumeric('CORTEX_STEP_TYPE_DONE'), 2);
  assert.equal(mapCortexStepTypeToNumeric('CORTEX_STEP_TYPE_FINISH'), 2);
  assert.equal(mapCortexStepTypeToNumeric('CORTEX_STEP_TYPE_INVOKE_SUBAGENT'), 127);
  assert.equal(mapCortexStepTypeToNumeric('CORTEX_STEP_TYPE_GENERIC'), 81);
  assert.equal(mapCortexStepTypeToNumeric('CORTEX_STEP_TYPE_RUN_COMMAND'), 16);

  assert.equal(mapCortexStepStatusToNumeric('CORTEX_STEP_STATUS_RUNNING'), 2);
  assert.equal(mapCortexStepStatusToNumeric('CORTEX_STEP_STATUS_GENERATING'), 8);
  assert.equal(mapCortexStepStatusToNumeric('CORTEX_STEP_STATUS_WAITING'), 9);
  assert.equal(mapCortexStepStatusToNumeric('CORTEX_STEP_STATUS_DONE'), 3);
  assert.equal(mapCortexStepStatusToNumeric('CORTEX_STEP_STATUS_INVALID'), 4);
  assert.equal(mapCortexStepStatusToNumeric('CORTEX_STEP_STATUS_CLEARED'), 5);
  assert.equal(mapCortexStepStatusToNumeric('CORTEX_STEP_STATUS_CANCELED'), 6);
  assert.equal(mapCortexStepStatusToNumeric('CORTEX_STEP_STATUS_REJECTED'), 6);
  assert.equal(mapCortexStepStatusToNumeric('CORTEX_STEP_STATUS_ERROR'), 7);
  assert.equal(mapCortexStepStatusToNumeric('CORTEX_STEP_STATUS_QUEUED'), 11);
  assert.equal(mapCortexStepStatusToNumeric('CORTEX_STEP_STATUS_INTERRUPTED'), 12);
  assert.equal(mapCortexStepStatusToNumeric('CORTEX_STEP_STATUS_FUTURE_UNKNOWN'), 0);

  // rootConversationId === cascadeId 是主对话，不是子智能体
  assert.equal(
    isStrictSubagentSummary('conv-root', { cascadeId: 'conv-root', stepCount: 10, rootConversationId: 'conv-root' }),
    false
  );
  assert.equal(
    isStrictSubagentSummary('conv-sub', { cascadeId: 'conv-sub', stepCount: 3, rootConversationId: 'conv-root' }),
    true
  );
  assert.equal(
    isStrictSubagentSummary('conv-sub-2', { cascadeId: 'conv-sub-2', stepCount: 2, parentConversationId: 'conv-root' }),
    true
  );

  const hudInput = mapRemoteRpcToHudInput({
    conversationId: 'conv-root',
    summary: { cascadeId: 'conv-root', stepCount: 4, lastModifiedTime: '2026-11-20T05:41:00Z' },
    steps: [
      { idx: 0, type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE', metadata: { createdAt: '2026-11-20T05:40:00Z' } },
      { idx: 1, type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE', metadata: { createdAt: '2026-11-20T05:40:01Z', completedAt: '2026-11-20T05:40:04Z', executionId: 'e1' } },
      { idx: 2, type: 'CORTEX_STEP_TYPE_CHECKPOINT', status: 'CORTEX_STEP_STATUS_DONE', metadata: { createdAt: '2026-11-20T05:40:05Z', executionId: 'e2' } },
      { idx: 3, type: 'CORTEX_STEP_TYPE_RUN_COMMAND', status: 'CORTEX_STEP_STATUS_DONE', metadata: { startedAt: '2026-11-20T05:40:06Z', completedAt: '2026-11-20T05:40:08Z' } },
    ],
    generatorMetadata: [
      {
        stepIndices: [1],
        executionId: 'e1',
        responseModel: 'gemini-3.8-flash-n',
        timeToFirstToken: '1.0s',
        streamingDuration: '2.0s',
        contextWindowMetadata: { estimatedTokensUsed: 18000, maxContextTokens: 256000 },
        usage: { inputTokens: '1000', cachedReadTokens: '4000', outputTokens: '300', responseOutputTokens: '300' },
      },
      {
        stepIndices: [2],
        executionId: 'e2',
        responseModel: 'gemini-3.8-flash-n',
        usage: { inputTokens: '500', outputTokens: '50' },
      },
    ],
  });

  // 压缩步无对应 stepType=15 时进入 extraUsageGenerations 并从 stepIndices[2] 回填时间戳
  assert.equal(hudInput.extraUsageGenerations?.length, 1);
  assert.ok((hudInput.extraUsageGenerations?.[0]?.timestampSeconds ?? 0) > 1_700_000_000);

  const metrics = computeRemoteConversationHudMetrics({
    conversationId: 'conv-root',
    remoteHostLabel: 'demo-ssh-host',
    summary: { cascadeId: 'conv-root', stepCount: 4, lastModifiedTime: '2026-11-20T05:41:00Z' },
    steps: [
      { idx: 0, type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE', metadata: { createdAt: '2026-11-20T05:40:00Z' } },
      { idx: 1, type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE', metadata: { createdAt: '2026-11-20T05:40:01Z', completedAt: '2026-11-20T05:40:04Z', executionId: 'e1' } },
      { idx: 2, type: 'CORTEX_STEP_TYPE_CHECKPOINT', status: 'CORTEX_STEP_STATUS_DONE', metadata: { createdAt: '2026-11-20T05:40:05Z', executionId: 'e2' } },
    ],
    generatorMetadata: [
      {
        stepIndices: [1],
        executionId: 'e1',
        responseModel: 'gemini-3.8-flash-n',
        timeToFirstToken: '1.0s',
        streamingDuration: '2.0s',
        contextWindowMetadata: { estimatedTokensUsed: 18000, maxContextTokens: 256000 },
        usage: { inputTokens: '1000', cachedReadTokens: '4000', outputTokens: '300' },
      },
      {
        stepIndices: [2],
        executionId: 'e2',
        responseModel: 'gemini-3.8-flash-n',
        usage: { inputTokens: '500', outputTokens: '50' },
      },
    ],
  });

  assert.equal(metrics.sourceKind, 'remote');
  assert.equal(metrics.remoteHostLabel, 'demo-ssh-host');
  assert.equal(metrics.tokens.totalTokens, 5850);
  assert.equal(metrics.session.turns, 1);
  assert.equal(metrics.session.compactionCount, 1);
  assert.equal(metrics.context.capacityTokens, 256000);
  assert.ok(Math.abs(metrics.session.averageTtftSeconds - 1.0) < 1e-4);
  assert.ok(Math.abs(metrics.session.outputTps - 100) < 1e-2);
});

test('CdpHudBridge 隔离：慢远端不阻塞本机 P95、同源 remote_stale 保留与跨源清空、broadcast 仅推本机', async () => {
  const localPushed = [];
  const remotePushed = [];
  const engine = {
    async getConversationMetrics(opts) {
      return buildConversationHudMetrics({
        ...opts,
        observedAt: Date.now(),
        steps: [{ idx: 0, stepType: 14, status: 3 }],
      });
    },
    clearCache() {},
    invalidatePricingCache() {},
    async getEffectivePricingTable() { return {}; },
  };
  const bridge = new CdpHudBridge({ engine, pollIntervalMs: 0 });

  let remoteShouldFail = false;
  let remoteAuthExpired = false;
  let remoteDelayMs = 1500;
  const slowRemoteRpc = {
    async probeUserAndQuota() { return { ok: false, reason: 'rpc_error', authExpired: false }; },
    async getAllCascadeTrajectories() {
      await new Promise(r => setTimeout(r, remoteDelayMs));
      if (remoteAuthExpired) return { ok: false, reason: 'auth_expired', authExpired: true };
      if (remoteShouldFail) return { ok: false, reason: 'timeout', authExpired: false };
      return { ok: true, data: [{ cascadeId: 'r-conv-1', stepCount: 2, lastModifiedTime: '2026-11-20T05:40:05Z' }] };
    },
    async getTrajectorySteps() {
      if (remoteAuthExpired) return { ok: false, reason: 'auth_expired', authExpired: true };
      if (remoteShouldFail) return { ok: false, reason: 'timeout', authExpired: false };
      return {
        ok: true,
        data: [
          { idx: 0, type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE', metadata: { createdAt: '2026-11-20T05:40:00Z' } },
          { idx: 1, type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE', metadata: { createdAt: '2026-11-20T05:40:01Z', completedAt: '2026-11-20T05:40:03Z', executionId: 're1' } },
        ],
      };
    },
    async getGeneratorMetadata() {
      if (remoteAuthExpired) return { ok: false, reason: 'auth_expired', authExpired: true };
      if (remoteShouldFail) return { ok: false, reason: 'timeout', authExpired: false };
      return {
        ok: true,
        data: [{
          stepIndices: [1],
          executionId: 're1',
          responseModel: 'gemini-3.8-flash-n',
          usage: { inputTokens: '777', cachedReadTokens: '223', outputTokens: '100' },
        }],
      };
    },
  };

  await bridge.attachToTarget('local-target', {
    send: async () => ({}),
    evaluate: async expr => {
      const m = JSON.parse(expr.slice(expr.indexOf('({') + 1, expr.lastIndexOf(')')));
      localPushed.push(m);
      return true;
    },
  }, () => 1);
  await bridge.attachToTarget('remote-target', {
    send: async () => ({}),
    evaluate: async expr => {
      const m = JSON.parse(expr.slice(expr.indexOf('({') + 1, expr.lastIndexOf(')')));
      remotePushed.push(m);
      return true;
    },
  }, () => 2, 'GRAVITYBOX-localization-v1', {
    sourceKind: 'remote',
    remoteKey: 'rk-demo',
    hostLabel: 'demo-ssh-host',
    origin: 'https://127.0.0.1:44139',
    rpcClient: slowRemoteRpc,
  });

  bridge.handleRawBindingPayload('remote-target', JSON.stringify({
    type: 'SESSION_ATTACHED', cascadeId: 'r-conv-1', paneSlotId: 'r-left', conversationId: 'r-conv-1',
    sessionRevision: 1, isStreaming: false, timestamp: Date.now(),
  }));
  bridge.handleRawBindingPayload('local-target', JSON.stringify({
    type: 'SESSION_ATTACHED', cascadeId: 'l-conv-1', paneSlotId: 'l-left', conversationId: 'l-conv-1',
    sessionRevision: 1, isStreaming: false, timestamp: Date.now(),
  }));

  // 慢远端在途期间连续触发多次本机轮询，验证本机延迟 P95 < 100ms
  const localLatencies = [];
  for (let i = 0; i < 6; i++) {
    const t0 = performance.now();
    await bridge.pollActiveSessions(false);
    localLatencies.push(performance.now() - t0);
  }
  localLatencies.sort((a, b) => a - b);
  assert.ok(localLatencies[Math.floor(localLatencies.length * 0.95)] < 100);
  assert.ok(localPushed.length >= 1);

  // 加快远端响应，获取一次有效指标写入同源缓存
  remoteDelayMs = 1;
  await new Promise(r => setTimeout(r, 1550));
  await bridge.pollActiveSessions(true);
  assert.equal(remotePushed.at(-1)?.availability, 'ready');
  assert.equal(remotePushed.at(-1)?.tokens?.totalTokens, 1100);

  // 同源断连 -> remote_stale（保留上次 tokens 与 lastSuccessAt）
  remoteShouldFail = true;
  await bridge.pollActiveSessions(true);
  const staleSnap = remotePushed.at(-1);
  assert.equal(staleSnap?.availability, 'remote_stale');
  assert.equal(staleSnap?.tokens?.totalTokens, 1100);
  assert.ok(staleSnap?.lastSuccessAt);

  // 语言/定价切换重算 -> 远端仍保持 remote_stale，不降级为 unavailable
  await bridge.refreshAllForLocaleChange();
  assert.equal(remotePushed.at(-1)?.availability, 'remote_stale');
  assert.equal(remotePushed.at(-1)?.tokens?.totalTokens, 1100);

  // broadcastMetrics 只推本机目标，绝不向远端目标广播
  const remoteCountBeforeBroadcast = remotePushed.length;
  await bridge.broadcastMetrics(buildConversationHudMetrics({ conversationId: 'l-conv-1', steps: [] }));
  assert.equal(remotePushed.length, remoteCountBeforeBroadcast);

  // 认证过期 -> 强制退回 remote_unbridged
  remoteAuthExpired = true;
  await bridge.pollActiveSessions(true);
  assert.equal(remotePushed.at(-1)?.availability, 'remote_unbridged');

  // 切换新 origin -> 清空旧 origin 缓存，失败直接返回 remote_unbridged
  remoteAuthExpired = false;
  await bridge.attachToTarget('remote-target', {
    send: async () => ({}),
    evaluate: async expr => {
      const m = JSON.parse(expr.slice(expr.indexOf('({') + 1, expr.lastIndexOf(')')));
      remotePushed.push(m);
      return true;
    },
  }, () => 2, 'GRAVITYBOX-localization-v1', {
    sourceKind: 'remote',
    remoteKey: 'rk-demo',
    hostLabel: 'demo-ssh-host',
    origin: 'https://127.0.0.1:55123',
    rpcClient: slowRemoteRpc,
  });
  await bridge.pollActiveSessions(true);
  assert.equal(remotePushed.at(-1)?.availability, 'remote_unbridged');

  bridge.dispose();
});

test('HudInstance 区分 remote_unbridged（独立走表与 SSH 徽章）与 remote_stale（保留快照与时间戳提示）', () => {
  const els = new Map();
  const makeEl = (sel) => {
    if (els.has(sel)) return els.get(sel);
    const attrs = new Map();
    const classSet = new Set();
    const el = {
      textContent: '',
      classList: {
        add: (...xs) => xs.forEach(x => classSet.add(x)),
        remove: (...xs) => xs.forEach(x => classSet.delete(x)),
        contains: (x) => classSet.has(x),
      },
      style: {},
      setAttribute: (k, v) => attrs.set(k, String(v)),
      getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
      removeAttribute: (k) => attrs.delete(k),
      hasAttribute: (k) => attrs.has(k),
      querySelector: (childSel) => makeEl(`${sel} ${childSel}`),
    };
    els.set(sel, el);
    return el;
  };
  const instance = new HudInstance('ssh-pane', {
    paneSlotId: 'ssh-pane',
    locale: 'zh-Hans',
    languageMode: 'zh',
  });
  instance.host = { isConnected: true, style: {}, hasAttribute: () => false, getAttribute: () => 'light', remove() {} };
  instance.hostMountedInDom = true;
  instance.shadow = {
    querySelector: (sel) => makeEl(sel),
    querySelectorAll: () => [],
  };
  instance.currentConvId = 'conv-ssh-1';
  instance.sessionRevision = 1;
  instance.domIsStreaming = true;
  instance.hasActiveWork = true;
  instance.isStreaming = true;

  const unbridged = buildConversationHudMetrics({
    conversationId: 'conv-ssh-1',
    paneSlotId: 'ssh-pane',
    sessionRevision: 1,
    metricsSequence: 1,
    availability: 'remote_unbridged',
    isStreaming: true,
    activityPhase: 'generating',
    steps: [],
  });
  unbridged.sourceKind = 'remote';
  unbridged.remoteHostLabel = 'demo-ssh-host';
  instance.updateMetrics(unbridged);

  assert.equal(makeEl('#hud-txt-session .hud-turns').textContent.trim(), 'SSH · demo-ssh-host');
  assert.match(makeEl('#hud-txt-session .hud-turn-text').textContent, /已观测/);
  assert.equal(makeEl('#hud-txt-session .hud-turn-dot').textContent, '· ');
  assert.equal(makeEl('#hud-txt-tokens .hud-tok-total').textContent, '—');
  assert.equal(makeEl('#hud-session-status-note').textContent, HUD_I18N['zh-Hans'].remoteUnbridgedNote);
  assert.equal(makeEl('#hud-session-status-note').hasAttribute('hidden'), false);
  assert.ok(instance.turnClockAnchor, 'remote_unbridged 流式期间应启用独立 DOM 走表锚点');

  // 切入 remote_stale，保留历史 Token 与上下文并展示时间戳提示
  instance.domIsStreaming = false;
  instance.hasActiveWork = false;
  instance.isStreaming = false;
  const staleTs = Date.UTC(2026, 10, 20, 6, 30, 0);
  const staleMetrics = computeRemoteConversationHudMetrics({
    conversationId: 'conv-ssh-1',
    paneSlotId: 'ssh-pane',
    sessionRevision: 1,
    metricsSequence: 2,
    availability: 'remote_stale',
    observedAt: staleTs,
    lastSuccessAt: staleTs,
    remoteHostLabel: 'demo-ssh-host',
    steps: [
      { idx: 0, type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE', metadata: { createdAt: '2026-11-20T05:40:00Z' } },
      { idx: 1, type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE', metadata: { createdAt: '2026-11-20T05:40:01Z', completedAt: '2026-11-20T05:40:02Z', executionId: 'e1' } },
    ],
    generatorMetadata: [
      { stepIndices: [1], executionId: 'e1', responseModel: 'gemini-3.8-flash-n', usage: { inputTokens: '2000', outputTokens: '500' } },
    ],
  });
  instance.updateMetrics(staleMetrics);

  assert.notEqual(makeEl('#hud-txt-tokens .hud-tok-total').textContent, '—');
  assert.ok(makeEl('#hud-session-status-note').textContent.startsWith(HUD_I18N['zh-Hans'].remoteStaleNote));
  assert.equal(makeEl('#hud-session-status-note').hasAttribute('hidden'), false);
  instance.dispose();
});

test('SshRemoteRpcClient 分页拉取 steps/gen_metadata、GetCascadeTrajectoryExecutorMetadatas 优雅降级、重试感知挂载与本机刷新去重', async () => {
  const allSteps = Array.from({ length: 5 }, (_, idx) => ({
    idx,
    type: idx === 0 ? 'CORTEX_STEP_TYPE_USER_INPUT' : 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
    status: 'CORTEX_STEP_STATUS_DONE',
    metadata: { createdAt: `2026-11-20T05:40:0${idx}Z`, executionId: `exec-${idx}` },
  }));
  const allGens = [
    { stepIndices: [1], executionId: 'exec-1', responseModel: 'gemini-4-neon', usage: { inputTokens: '100', outputTokens: '0' } },
    { stepIndices: [1], executionId: 'exec-1', responseModel: 'gemini-4-neon', usage: { inputTokens: '50000', outputTokens: '600' }, contextWindowMetadata: { maxContextTokens: 512000 } },
    { stepIndices: [2], executionId: 'exec-2', responseModel: 'gemini-4-neon', usage: { inputTokens: '55000', outputTokens: '400' }, contextWindowMetadata: { maxContextTokens: 512000 } },
  ];

  const { cdp } = createInPageHarness({
    routes: {
      GetCascadeTrajectorySteps: (init) => {
        const body = JSON.parse(init.body);
        const offset = body.stepOffset || 0;
        const page = allSteps.slice(offset, offset + 2);
        return { body: { steps: page, totalSteps: allSteps.length, hasMore: offset + page.length < allSteps.length } };
      },
      GetCascadeTrajectoryGeneratorMetadata: (init) => {
        const body = JSON.parse(init.body);
        const offset = body.generatorMetadataOffset || 0;
        const page = allGens.slice(offset, offset + 2);
        return { body: { generatorMetadata: page, totalCount: allGens.length, hasMore: offset + page.length < allGens.length } };
      },
      GetCascadeTrajectoryExecutorMetadatas: {
        body: {
          executorMetadatas: [
            {
              cascadeConfig: {
                plannerConfig: {
                  planModel: 'MODEL_PLACEHOLDER_M532',
                  planExecuteConfig: { executionModel: 'MODEL_PLACEHOLDER_M528' },
                },
                checkpointConfig: { maxTokenLimit: 512000 },
              },
            },
          ],
        },
      },
    },
  });

  const client = new SshRemoteRpcClient({ cdp, getContextId: () => 42, timeoutMs: 2000 });
  const stepsRes = await client.getTrajectorySteps('conv-paged', 0);
  const genRes = await client.getGeneratorMetadata('conv-paged', 0);
  const execRes = await client.getExecutorMetadata('conv-paged');

  assert.equal(stepsRes.ok, true);
  assert.equal(stepsRes.data.length, 5, '应分页拉齐全部 5 步');
  assert.equal(genRes.ok, true);
  assert.equal(genRes.data.length, 3, '应分页拉齐全部 3 条 gen_metadata');
  assert.equal(execRes.ok, true);
  assert.equal(execRes.data?.planModelEnum, 1532);
  assert.equal(execRes.data?.executionModelEnum, 1528);
  assert.equal(execRes.data?.checkpointMaxTokenLimit, 512000);

  // 旧版远端无 GetCascadeTrajectoryExecutorMetadatas 时优雅返回 ok: true, data: null
  const unsupportedHarness = createInPageHarness({ routes: {} });
  const oldClient = new SshRemoteRpcClient({ cdp: unsupportedHarness.cdp, getContextId: () => 42 });
  const oldExecRes = await oldClient.getExecutorMetadata('conv-old');
  assert.equal(oldExecRes.ok, true);
  assert.equal(oldExecRes.data, null);

  // 重试感知挂载：step[1] 有两次 gen（第 1 次 100/0 失败重试，第 2 次 50000/600 成功），step[1] 应挂载成功那次，失败重试进 extraUsageGenerations；且远端活跃子轨迹推算 runningSubagentCount
  const hud = computeRemoteConversationHudMetrics({
    conversationId: 'conv-retry-and-sub',
    steps: [allSteps[0], allSteps[1]],
    generatorMetadata: [allGens[0], allGens[1]],
    executorMetadata: execRes.data,
    childTrajectories: [
      {
        cascadeId: 'child-running-1',
        summary: { cascadeId: 'child-running-1', status: 'CASCADE_RUN_STATUS_RUNNING', stepCount: 2, parentConversationId: 'conv-retry-and-sub' },
        steps: [
          { idx: 0, type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE' },
          { idx: 1, type: 'CORTEX_STEP_TYPE_RUN_COMMAND', status: 'CORTEX_STEP_STATUS_RUNNING' },
        ],
        generatorMetadata: [],
      },
    ],
  });
  assert.equal(hud.context.usedTokens, 50_000, '重试步应挂载最终成功生成记录，不回缩为 100');
  assert.equal(hud.tokens.totalTokens, 50_700, '失败重试的 100 token 仍计入总消耗账本');
  assert.equal(hud.runningSubagentCount, 1, '应从远端活跃子轨迹计算出 runningSubagentCount=1');

  // 本机 CdpHudBridge.refreshPaneMetrics 并发去重（同时保留排队中的 forcePush）
  let localCallCount = 0;
  let releaseFirst;
  const firstStarted = new Promise((r) => { releaseFirst = r; });
  let resolveGate;
  const gate = new Promise((r) => { resolveGate = r; });
  const bridge = new CdpHudBridge({
    pollIntervalMs: 0,
    engine: {
      async getConversationMetrics(opts) {
        localCallCount++;
        if (localCallCount === 1) {
          releaseFirst();
          await gate;
        }
        return buildConversationHudMetrics({ ...opts, observedAt: Date.now(), steps: [] });
      },
      clearCache() {},
      invalidatePricingCache() {},
      async getEffectivePricingTable() { return {}; },
    },
  });
  await bridge.attachToTarget('local-dedup', { send: async () => ({}), evaluate: async () => true }, () => 1);
  bridge.handleRawBindingPayload('local-dedup', JSON.stringify({
    type: 'SESSION_ATTACHED', cascadeId: 'p1', paneSlotId: 'p1', conversationId: 'c1',
    sessionRevision: 1, isStreaming: false, timestamp: Date.now(),
  }));
  await firstStarted;
  // 并发两次普通刷新会被去重，不并发重入
  await Promise.all([
    bridge.refreshPaneMetrics('local-dedup::p1', false),
    bridge.refreshPaneMetrics('local-dedup::p1', false),
  ]);
  assert.equal(localCallCount, 1, '本机在途刷新期间重复非强制轮询应被去重');
  // 在途期间收到强制刷新（如模型切换），释放首个请求后自动补跑一次
  const forceQueued = bridge.refreshPaneMetrics('local-dedup::p1', true);
  resolveGate();
  await forceQueued;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(localCallCount, 2, '排队中的强制刷新应在首个请求完成后补跑一次');
  bridge.dispose();
});

test('getAllCascadeTrajectories 透传 /btw fork 元数据并拒绝自引用、非法索引与敏感字段泄漏', async () => {
  const { cdp } = createInPageHarness({
    routes: {
      GetAllCascadeTrajectories: {
        status: 200,
        body: {
          trajectorySummaries: {
            'conv-btw-camel': {
              trajectoryId: 'traj-btw-camel',
              trajectoryType: 22,
              stepCount: 6,
              lastModifiedTime: '2026-11-22T09:00:00Z',
              title: 'SECRET_PROMPT_TITLE_SHOULD_NOT_LEAK',
              parentReferences: [
                {
                  parentCascadeId: 'conv-main-1',
                  parentTrajectoryId: 'traj-main-1',
                  forkStepIndex: 2,
                  referenceType: 1,
                  prompt: 'SECRET_REF_PROMPT_LEAK',
                },
                {
                  parentCascadeId: 'conv-main-1',
                  parentTrajectoryId: 'traj-main-1',
                  forkStepIndex: '5',
                  referenceType: 'FORK',
                },
              ],
            },
            'conv-btw-snake': {
              trajectory_id: 'traj-btw-snake',
              trajectory_type: 'CORTEX_TRAJECTORY_TYPE_SIDE_QUESTION',
              stepCount: 4,
              trajectoryMetadata: {
                parent_conversation_id: 'conv-main-2',
                parent_references: [
                  {
                    parent_cascade_id: 'conv-main-2',
                    fork_step_index: 3,
                    reference_type: 2,
                  },
                ],
              },
            },
            'conv-btw-direct': {
              trajectoryId: 'traj-btw-direct',
              trajectoryType: 22,
              stepCount: 4,
              parentConversationId: 'conv-main-3',
              fork_step_index: '7',
            },
            'conv-self-and-invalid': {
              trajectoryId: 'traj-self-invalid',
              trajectoryType: 2,
              stepCount: 10,
              parentReferences: [
                { parentCascadeId: 'conv-self-and-invalid', forkStepIndex: 4 },
                { parentCascadeId: 'traj-self-invalid', forkStepIndex: 6 },
                { parentCascadeId: 'conv-other', forkStepIndex: -1 },
                { parentCascadeId: 'conv-other', forkStepIndex: '18446744073709551615' },
                { parentCascadeId: 'conv-other', forkStepIndex: 10000000 },
              ],
            },
          },
        },
      },
    },
  });

  const client = new SshRemoteRpcClient({ cdp, getContextId: () => 42, timeoutMs: 2000 });
  const res = await client.getAllCascadeTrajectories();
  assert.equal(res.ok, true);
  assert.equal(res.data.length, 4);

  const byId = new Map(res.data.map((item) => [item.cascadeId, item]));
  const camel = byId.get('conv-btw-camel');
  assert.equal(camel.forkStepIndex, 5, '多条有效 parentReferences 应取最大 forkStepIndex');
  assert.equal(camel.forkParentCascadeId, 'conv-main-1');
  assert.equal(camel.parentReferences.length, 2);
  assert.equal(camel.parentReferences[0].forkStepIndex, 2);
  assert.equal(camel.parentReferences[1].forkStepIndex, 5);

  const snake = byId.get('conv-btw-snake');
  assert.equal(snake.trajectoryId, 'traj-btw-snake');
  assert.equal(snake.parentConversationId, 'conv-main-2');
  assert.equal(snake.forkStepIndex, 3);
  assert.equal(snake.forkParentCascadeId, 'conv-main-2');

  const direct = byId.get('conv-btw-direct');
  assert.equal(direct.forkStepIndex, 7);
  assert.equal(direct.forkParentCascadeId, 'conv-main-3');

  const invalid = byId.get('conv-self-and-invalid');
  assert.equal(invalid.forkStepIndex, undefined, '自引用及非法/超大 forkStepIndex 必须全部拒绝');
  assert.equal(invalid.forkParentCascadeId, undefined);

  const serialized = JSON.stringify(res.data);
  assert.equal(serialized.includes('SECRET_PROMPT_TITLE_SHOULD_NOT_LEAK'), false, '禁止透传标题敏感字段');
  assert.equal(serialized.includes('SECRET_REF_PROMPT_LEAK'), false, '禁止透传 parentReference 敏感字段');
});

test('P1-14: getGeneratorMetadata 提取 chatStartMetadata 原生时间戳', async () => {
  const { cdp } = createInPageHarness({
    routes: {
      GetCascadeTrajectoryGeneratorMetadata: {
        status: 200,
        body: {
          generatorMetadata: [
            {
              stepIndices: [0],
              executionId: 'exec-ts-1',
              chatModel: {
                responseModel: 'gemini-3.8-flash',
                usage: { inputTokens: '120', outputTokens: '30' },
                chatStartMetadata: {
                  createdAt: '2026-11-20T08:15:00Z',
                },
              },
            },
            {
              stepIndices: [2],
              executionId: 'exec-ts-2',
              chatModel: {
                responseModel: 'gemini-3.8-flash',
                usage: { inputTokens: '200', outputTokens: '40' },
                chatStartMetadata: {
                  start_time: { seconds: 1795200000, nanos: 0 },
                },
              },
            },
          ],
        },
      },
    },
  });
  const client = new SshRemoteRpcClient({ cdp, getContextId: () => 42, timeoutMs: 2000 });
  const res = await client.getGeneratorMetadata('conv-ts', 0);
  assert.equal(res.ok, true);
  assert.equal(res.data.length, 2);
  assert.equal(res.data[0].createdAt, '2026-11-20T08:15:00Z');
  assert.deepEqual(res.data[1].createdAt, { seconds: 1795200000, nanos: 0 });
});

test('P0-05: CortexStepStatus 数值与字符串双链路同态（GENERATING=8, WAITING=9, INTERRUPTED=12）', () => {
  const nowSec = Math.floor(Date.now() / 1000) - 5;
  const isoStart = new Date(nowSec * 1000).toISOString();

  for (const [label, strStatus, numStatus] of [
    ['GENERATING', 'CORTEX_STEP_STATUS_GENERATING', 8],
    ['WAITING', 'CORTEX_STEP_STATUS_WAITING', 9],
    ['INTERRUPTED', 'CORTEX_STEP_STATUS_INTERRUPTED', 12],
    ['DONE', 'CORTEX_STEP_STATUS_DONE', 3],
  ]) {
    const remoteFromString = computeRemoteConversationHudMetrics({
      conversationId: `conv-p005-${label}`,
      isStreaming: false,
      steps: [
        { idx: 0, type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE', metadata: { createdAt: isoStart } },
        { idx: 1, type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: strStatus, metadata: { createdAt: isoStart } },
      ],
    });
    const remoteFromNumber = computeRemoteConversationHudMetrics({
      conversationId: `conv-p005-${label}`,
      isStreaming: false,
      steps: [
        { idx: 0, type: 14, status: 3, metadata: { createdAt: isoStart } },
        { idx: 1, type: 15, status: numStatus, metadata: { createdAt: isoStart } },
      ],
    });
    assert.equal(remoteFromString.isStreaming, remoteFromNumber.isStreaming, `${label} isStreaming 应一致`);
    assert.equal(remoteFromString.session.activeModelStepCount, remoteFromNumber.session.activeModelStepCount, `${label} activeModelStepCount 应一致`);
    assert.equal(remoteFromString.session.turnAborted, remoteFromNumber.session.turnAborted, `${label} turnAborted 应一致`);
  }

  // 验证明确语义：GENERATING(8) 为生成并计时；WAITING(9) 为等待不活跃；INTERRUPTED(12) 停止计时且置 turnAborted
  const genMetrics = computeRemoteConversationHudMetrics({
    conversationId: 'conv-gen',
    isStreaming: false,
    steps: [
      { idx: 0, type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE', metadata: { createdAt: isoStart } },
      { idx: 1, type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_GENERATING', metadata: { createdAt: isoStart } },
    ],
  });
  assert.equal(genMetrics.isStreaming, true);
  assert.equal(genMetrics.session.activeModelStepCount, 1);

  const waitMetrics = computeRemoteConversationHudMetrics({
    conversationId: 'conv-wait',
    isStreaming: false,
    steps: [
      { idx: 0, type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE', metadata: { createdAt: isoStart } },
      { idx: 1, type: 'CORTEX_STEP_TYPE_RUN_COMMAND', status: 'CORTEX_STEP_STATUS_WAITING', metadata: { startedAt: isoStart } },
    ],
  });
  assert.equal(waitMetrics.isStreaming, false, '等待用户审批 WAITING=9 不应误判为流式执行');
  assert.equal(waitMetrics.session.activeToolStepCount, 0);

  const intMetrics = computeRemoteConversationHudMetrics({
    conversationId: 'conv-int',
    isStreaming: false,
    steps: [
      { idx: 0, type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE', metadata: { createdAt: isoStart } },
      { idx: 1, type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_INTERRUPTED', metadata: { createdAt: isoStart } },
    ],
  });
  assert.equal(intMetrics.isStreaming, false);
  assert.equal(intMetrics.session.turnAborted, true, 'INTERRUPTED=12 必须视为中止终态并停止计时');
  assert.equal(intMetrics.session.activeModelStepCount, 0);
});

test('P1-18: SSH BTW 旁路问答按 forkStepIndex 隔离父会话历史步骤与 Token', () => {
  const btwMetrics = computeRemoteConversationHudMetrics({
    conversationId: 'conv-btw-ssh',
    summary: {
      cascadeId: 'conv-btw-ssh',
      trajectoryType: 22,
      forkParentCascadeId: 'conv-parent-ssh',
      forkStepIndex: 1,
      stepCount: 4,
    },
    steps: [
      { idx: 0, type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE', metadata: { createdAt: '2026-11-20T05:40:00Z' } },
      { idx: 1, type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE', metadata: { createdAt: '2026-11-20T05:40:01Z', completedAt: '2026-11-20T05:40:02Z', executionId: 'e-parent', modelUsage: { inputTokens: '900', outputTokens: '100' } } },
      { idx: 2, type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE', metadata: { createdAt: '2026-11-20T05:41:00Z' } },
      { idx: 3, type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE', metadata: { createdAt: '2026-11-20T05:41:01Z', completedAt: '2026-11-20T05:41:02Z', executionId: 'e-btw', modelUsage: { inputTokens: '15', outputTokens: '5' } } },
    ],
    generatorMetadata: [
      { stepIndices: [1], executionId: 'e-parent', responseModel: 'gemini-3.8-flash-n', usage: { inputTokens: '900', outputTokens: '100' } },
      { stepIndices: [3], executionId: 'e-btw', responseModel: 'gemini-3.8-flash-n', usage: { inputTokens: '15', outputTokens: '5' } },
    ],
  });
  assert.equal(btwMetrics.session.isBtwTrajectory, true);
  assert.equal(btwMetrics.session.steps, 2, '仅统计 BTW 自身的 2 个步骤');
  assert.equal(btwMetrics.tokens.totalTokens, 20, '仅统计 BTW 自身的 20 Tokens，不重复计入父会话 1000 Tokens');
});

test('P1-19: remote_stale 冻结在 lastSuccessAt，断连期间前端走表停止，重连后按新状态收敛', () => {
  const startSec = 1_763_600_000;
  const lastSuccessMs = (startSec + 12) * 1000;
  const staleSnap = computeRemoteConversationHudMetrics({
    conversationId: 'conv-stale-freeze',
    availability: 'remote_stale',
    observedAt: lastSuccessMs,
    lastSuccessAt: lastSuccessMs,
    isStreaming: false,
    allowDbActiveStepInference: false,
    steps: [
      { idx: 0, type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE', metadata: { createdAt: new Date(startSec * 1000).toISOString() } },
      { idx: 1, type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_GENERATING', metadata: { createdAt: new Date(startSec * 1000).toISOString() } },
    ],
  });
  assert.equal(staleSnap.session.currentTurnDurationSeconds, 0, 'remote_stale 冻结活跃外推，不随 Date.now() 增长');
  assert.equal(staleSnap.session.activeModelStepCount, 0);

  const els = new Map();
  const makeEl = (sel) => {
    if (els.has(sel)) return els.get(sel);
    const attrs = new Map();
    const classSet = new Set();
    const el = {
      textContent: '',
      classList: { add: (...xs) => xs.forEach(x => classSet.add(x)), remove: (...xs) => xs.forEach(x => classSet.delete(x)), contains: (x) => classSet.has(x) },
      style: {},
      setAttribute: (k, v) => attrs.set(k, String(v)),
      getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
      removeAttribute: (k) => attrs.delete(k),
      hasAttribute: (k) => attrs.has(k),
      querySelector: (c) => makeEl(`${sel} ${c}`),
    };
    els.set(sel, el);
    return el;
  };
  const inst = new HudInstance('ssh-freeze', { paneSlotId: 'ssh-freeze', locale: 'zh-Hans', languageMode: 'zh' });
  inst.host = { isConnected: true, style: {}, hasAttribute: () => false, getAttribute: () => 'light', remove() {} };
  inst.hostMountedInDom = true;
  inst.shadow = { querySelector: (sel) => makeEl(sel), querySelectorAll: () => [] };
  inst.currentConvId = 'conv-stale-freeze';
  inst.sessionRevision = 1;
  inst.domIsStreaming = true;
  inst.updateMetrics(buildConversationHudMetrics({
    conversationId: 'conv-stale-freeze',
    paneSlotId: 'ssh-freeze',
    sessionRevision: 1,
    metricsSequence: 1,
    availability: 'ready',
    isStreaming: true,
    steps: [{ idx: 0, stepType: 14, status: 3, createdAtSeconds: Date.now() / 1000 - 3 }],
  }));
  assert.ok(inst.turnClockAnchor, '正常流式期间应启动走表锚点');

  // 断连切入 remote_stale：后端不再流式，走表必须立刻停止冻结
  inst.domIsStreaming = false;
  inst.updateMetrics({ ...staleSnap, paneSlotId: 'ssh-freeze', sessionRevision: 1, metricsSequence: 2 });
  assert.equal(inst.turnClockAnchor, null, 'remote_stale 时必须停止走表');
  inst.dispose();
});
