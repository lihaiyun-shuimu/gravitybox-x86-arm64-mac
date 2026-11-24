import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { UsageStatsManager } from '../dist/usage.js';
import { UsageLedger } from '../dist/usage-ledger.js';
import { projectUsagePeriodSummary } from '../dist/ipc-projections.js';
import {
  RemoteUsageSyncCoordinator,
  buildRemoteEnvironmentId,
  buildRemoteEventKey,
  buildRemoteTrajectorySourceId,
} from '../dist/remote-usage-sync.js';

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

async function createIsolatedWorkspace(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const geminiDir = join(root, 'gemini');
  const stateDir = join(root, 'state');
  await mkdir(geminiDir, { recursive: true, mode: 0o700 });
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  t.after(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });
  return { root, geminiDir, stateDir };
}

function makeLocalEvent({
  id,
  ts,
  model = 'claude-sonnet-4-5',
  input = 600,
  output = 300,
  cached = 100,
  accountId = 'acc-a',
  accountEmail = 'local-a@example.invalid',
  confidence = 'observed',
}) {
  const total = input + output + cached;
  return {
    event_key: sha256(`local:${id}`),
    source_id: sha256(`local-source:${id}`),
    source_observed_at: ts,
    model,
    input_tokens: input,
    output_tokens: output,
    cached_tokens: cached,
    total_tokens: total,
    timestamp_seconds: ts,
    account_id: accountId,
    account_email: accountEmail,
    account_confidence: confidence,
    account_type: 'consumer',
  };
}

function makeRemoteRpcTarget({
  remoteKey,
  hostLabel,
  email,
  matchedLocalAccountId = null,
  trajectories,
}) {
  const envId = buildRemoteEnvironmentId(hostLabel);
  return {
    remoteKey,
    hostLabel,
    environmentId: envId,
    origin: 'https://127.0.0.1:44901',
    email,
    name: hostLabel,
    accountType: 'consumer',
    matchedLocalAccountId,
    state: 'connected',
    rpcClient: {
      async getAllCascadeTrajectories() {
        return {
          ok: true,
          data: trajectories.map(tr => ({
            cascadeId: tr.cascadeId,
            trajectoryId: tr.trajectoryId,
            stepCount: tr.stepCount,
            lastModifiedTime: tr.lastModifiedTime,
          })),
        };
      },
      async getGeneratorMetadata(cascadeId) {
        const found = trajectories.find(tr => tr.cascadeId === cascadeId);
        return { ok: true, data: found ? found.generators : [] };
      },
      async getTrajectorySteps(cascadeId) {
        const found = trajectories.find(tr => tr.cascadeId === cascadeId);
        return { ok: true, data: found ? found.steps : [] };
      },
    },
  };
}

function createWiredCoordinator({ stateDir, usageManager, getTargets, resolveMatchedLocalAccountId }) {
  return new RemoteUsageSyncCoordinator({
    stateDir,
    getTargets,
    ledger: {
      receipts: () => usageManager.getSyncReceipts(),
      save: (events, options) =>
        usageManager.ingestRemoteUsageBatch(events, options?.receipts ?? [], {
          billingPrices: options?.billingPrices,
        }),
    },
    resolveMatchedLocalAccountId,
    getBillingPrices: () => usageManager.getBillingPricingTable(),
  });
}

test('M2-E2E-1: 本地账号A + 远端SSH账号B混账并账、默认加总占比、离线主机提示与IPC投影', async t => {
  const { geminiDir, stateDir } = await createIsolatedWorkspace(t, 'gb-m2-e2e-1-');
  const nowSec = Math.floor(Date.now() / 1000) - 60;
  const ledger = new UsageLedger(stateDir);
  await ledger.save([
    makeLocalEvent({ id: 'a1', ts: nowSec - 120, input: 3000, output: 1000, cached: 0 }),
    makeLocalEvent({ id: 'a2', ts: nowSec - 60, input: 1500, output: 500, cached: 0 }),
  ]);

  const usageManager = new UsageStatsManager({ geminiDir, stateDir });
  usageManager.setKnownAccounts([
    { id: 'acc-a', email: 'local-a@example.invalid', name: 'Local A' },
  ]);

  const sshEnvId = buildRemoteEnvironmentId('demo-ssh-host');
  let onlineTargets = [
    makeRemoteRpcTarget({
      remoteKey: 'rk-demo-1',
      hostLabel: 'demo-ssh-host',
      email: 'remote-b@example.invalid',
      trajectories: [
        {
          cascadeId: 'casc-1',
          trajectoryId: 'traj-demo-host-1',
          stepCount: 2,
          lastModifiedTime: new Date((nowSec - 30) * 1000).toISOString(),
          generators: [
            {
              stepIndices: [1],
              executionId: 'exec-r1',
              model: 'gemini-2.5-pro',
              usage: { inputTokens: '2500', outputTokens: '1000', cacheReadTokens: '500' },
            },
          ],
          steps: [
            {
              idx: 1,
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'CORTEX_STEP_STATUS_DONE',
              metadata: {
                createdAt: new Date((nowSec - 30) * 1000).toISOString(),
                executionId: 'exec-r1',
              },
            },
          ],
        },
      ],
    }),
  ];

  const coordinator = createWiredCoordinator({
    stateDir,
    usageManager,
    getTargets: () => onlineTargets,
  });

  const round = await coordinator.syncNow({ nowMs: nowSec * 1000 });
  assert.equal(round.ok, true);
  assert.equal(round.eventsSaved, 1);
  assert.equal(round.receiptsUpdated, 1);
  assert.equal(usageManager.getRemoteSyncRevision(), 1);

  const receipts = await usageManager.getSyncReceipts();
  const expectedSourceId = buildRemoteTrajectorySourceId('traj-demo-host-1');
  assert.equal(receipts[expectedSourceId]?.environment_id, sshEnvId);

  usageManager.setOnlineRemoteEnvironments([
    { id: sshEnvId, kind: 'ssh', host_label: 'demo-ssh-host', online: true },
  ]);

  const summary = await usageManager.getUsageSummary(false, 'all', 'all');
  assert.equal(summary.all_time.totals.total_tokens, 10000);
  assert.equal(summary.all_time.totals.request_count, 3);
  assert.equal(summary.remote_sync_revision, 1);
  assert.equal(summary.selected_environment_id, 'all');
  assert.equal(summary.environment_breakdown?.local_tokens, 6000);
  assert.equal(summary.environment_breakdown?.ssh_tokens, 4000);
  assert.equal(summary.environment_breakdown?.local_share_pct, 60);
  assert.equal(summary.environment_breakdown?.ssh_share_pct, 40);
  assert.equal(summary.environment_breakdown?.has_ssh_data, true);
  assert.deepEqual(summary.environment_breakdown?.offline_ssh_hosts, []);

  const sshOpt = summary.available_environments?.find(e => e.id === sshEnvId);
  assert.ok(sshOpt);
  assert.equal(sshOpt.online, true);
  assert.equal(sshOpt.total_tokens, 4000);
  assert.ok((sshOpt.last_synced_at ?? 0) > 0);

  const ipcAll = projectUsagePeriodSummary(summary, 'all', { includeAllPeriods: true });
  assert.equal(ipcAll.remoteSyncRevision, 1);
  assert.equal(ipcAll.remote_sync_revision, 1);
  assert.equal(ipcAll.selectedEnvironmentId, 'all');
  assert.equal(ipcAll.selected_environment_id, 'all');
  assert.deepEqual(ipcAll.offlineSshHosts, []);
  assert.deepEqual(ipcAll.summary.offline_ssh_hosts, []);
  assert.ok(ipcAll.periods);

  // 远端下线：无需 forceRefresh，TTL 缓存应立即失效并露出离线提示
  onlineTargets = [];
  usageManager.setOnlineRemoteEnvironments([]);
  const offlineSummary = await usageManager.getUsageSummary(false, 'all', 'all');
  assert.deepEqual(offlineSummary.environment_breakdown?.offline_ssh_hosts, ['demo-ssh-host']);
  assert.equal(offlineSummary.available_environments?.find(e => e.id === sshEnvId)?.online, false);

  const ipcOffline = projectUsagePeriodSummary(offlineSummary, 'today', { includeAllPeriods: true });
  assert.deepEqual(ipcOffline.offlineSshHosts, ['demo-ssh-host']);
  assert.deepEqual(ipcOffline.summary.offlineSshHosts, ['demo-ssh-host']);
});

test('M2-E2E-2: 小账本与大账本双路径正交 environmentId × accountId 筛选、缓存隔离与 IPC periods 约束', async t => {
  const { geminiDir, stateDir } = await createIsolatedWorkspace(t, 'gb-m2-e2e-2-');
  const nowSec = Math.floor(Date.now() / 1000) - 120;
  const ledger = new UsageLedger(stateDir);
  await ledger.save([
    makeLocalEvent({ id: 'la', ts: nowSec - 10, input: 700, output: 200, cached: 100, accountId: 'acc-a', accountEmail: 'local-a@example.invalid' }),
    makeLocalEvent({ id: 'lb', ts: nowSec - 5, input: 300, output: 150, cached: 50, accountId: 'acc-b', accountEmail: 'remote-b@example.invalid' }),
  ]);

  const ssh1Id = buildRemoteEnvironmentId('demo-ssh-host');
  const ssh2Id = buildRemoteEnvironmentId('demo-ssh-host-b');
  const usageManager = new UsageStatsManager({ geminiDir, stateDir });
  usageManager.setKnownAccounts([
    { id: 'acc-a', email: 'local-a@example.invalid' },
    { id: 'acc-b', email: 'remote-b@example.invalid' },
  ]);

  const coordinator = createWiredCoordinator({
    stateDir,
    usageManager,
    resolveMatchedLocalAccountId: email =>
      email === 'local-a@example.invalid' ? 'acc-a' : email === 'remote-b@example.invalid' ? 'acc-b' : null,
    getTargets: () => [
      makeRemoteRpcTarget({
        remoteKey: 'rk-h1',
        hostLabel: 'demo-ssh-host',
        email: 'remote-b@example.invalid',
        matchedLocalAccountId: 'acc-b',
        trajectories: [
          {
            cascadeId: 'c-h1',
            trajectoryId: 'traj-h1',
            stepCount: 1,
            lastModifiedTime: new Date(nowSec * 1000).toISOString(),
            generators: [
              { stepIndices: [0], executionId: 'e-h1', model: 'claude-sonnet-4-5', usage: { inputTokens: '1500', outputTokens: '500', cacheReadTokens: '0' } },
            ],
            steps: [
              { idx: 0, metadata: { createdAt: new Date(nowSec * 1000).toISOString(), executionId: 'e-h1' } },
            ],
          },
        ],
      }),
      makeRemoteRpcTarget({
        remoteKey: 'rk-h2',
        hostLabel: 'demo-ssh-host-b',
        email: 'local-a@example.invalid',
        matchedLocalAccountId: 'acc-a',
        trajectories: [
          {
            cascadeId: 'c-h2',
            trajectoryId: 'traj-h2',
            stepCount: 1,
            lastModifiedTime: new Date(nowSec * 1000).toISOString(),
            generators: [
              { stepIndices: [0], executionId: 'e-h2', model: 'gemini-2.5-pro', usage: { inputTokens: '200', outputTokens: '100', cacheReadTokens: '0' } },
            ],
            steps: [
              { idx: 0, metadata: { createdAt: new Date(nowSec * 1000).toISOString(), executionId: 'e-h2' } },
            ],
          },
        ],
      }),
    ],
  });

  await coordinator.syncNow({ nowMs: nowSec * 1000 });
  usageManager.setOnlineRemoteEnvironments([
    { id: ssh1Id, kind: 'ssh', host_label: 'demo-ssh-host', online: true },
    { id: ssh2Id, kind: 'ssh', host_label: 'demo-ssh-host-b', online: true },
  ]);

  // 先查询 ssh1 筛选，验证缓存不会串给后续 all / local
  const sSsh1 = await usageManager.getUsageSummary(false, 'all', ssh1Id);
  assert.equal(sSsh1.all_time.totals.total_tokens, 2000);
  assert.equal(sSsh1.selected_environment_id, ssh1Id);

  const sAll = await usageManager.getUsageSummary(false, 'all', 'all');
  const sLocal = await usageManager.getUsageSummary(false, 'all', 'local');
  const sAccBAll = await usageManager.getUsageSummary(false, 'acc-b', 'all');
  const sAccBLocal = await usageManager.getUsageSummary(false, 'acc-b', 'local');
  const sAccBSsh1 = await usageManager.getUsageSummary(false, 'acc-b', ssh1Id);
  const sAccASsh1 = await usageManager.getUsageSummary(false, 'acc-a', ssh1Id);

  assert.equal(sAll.all_time.totals.total_tokens, 3800);
  assert.equal(sLocal.all_time.totals.total_tokens, 1500);
  assert.equal(sAccBAll.all_time.totals.total_tokens, 2500);
  assert.equal(sAccBLocal.all_time.totals.total_tokens, 500);
  assert.equal(sAccBSsh1.all_time.totals.total_tokens, 2000);
  assert.equal(sAccASsh1.all_time.totals.total_tokens, 0);

  // 非 all+all 筛选时 IPC 投影不附带 periods
  const ipcFiltered = projectUsagePeriodSummary(sAccBSsh1, 'all', { includeAllPeriods: true });
  assert.equal(ipcFiltered.selectedEnvironmentId, ssh1Id);
  assert.equal(ipcFiltered.selectedAccountId, 'acc-b');
  assert.equal('periods' in ipcFiltered, false);

  // 切换至大账本路径（> 50,000 行）并验证双路径对齐
  const { geminiDir: lgGemini, stateDir: lgState } = await createIsolatedWorkspace(t, 'gb-m2-e2e-2-lg-');
  const lgLedger = new UsageLedger(lgState);
  await lgLedger.save([
    makeLocalEvent({ id: 'lg-init', ts: nowSec - 20, input: 700, output: 200, cached: 100, accountId: 'acc-a', accountEmail: 'local-a@example.invalid' }),
  ]);
  const dbPath = lgLedger.path;
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('BEGIN IMMEDIATE');
    const insEvt = db.prepare('INSERT INTO events(event_key,timestamp,account_id,model,payload,observed_at) VALUES(?,?,?,?,?,?)');
    const insRev = db.prepare('INSERT INTO event_revisions(event_key,timestamp,payload) VALUES(?,?,?)');
    for (let i = 0; i < 50_005; i++) {
      const ek = sha256(`lg-bulk:${i}`);
      const acc = i % 2 === 0 ? 'acc-a' : 'acc-b';
      const email = acc === 'acc-a' ? 'local-a@example.invalid' : 'remote-b@example.invalid';
      const payload = JSON.stringify({
        event_key: ek,
        source_id: sha256(`lg-bulk-src:${i}`),
        source_observed_at: nowSec - 1000,
        model: 'claude-sonnet-4-5',
        input_tokens: 1,
        output_tokens: 0,
        cached_tokens: 0,
        total_tokens: 1,
        timestamp_seconds: nowSec - 1000,
        account_id: acc,
        account_email: email,
        account_confidence: 'observed',
      });
      insEvt.run(ek, nowSec - 1000, acc, 'claude-sonnet-4-5', payload, nowSec - 1000);
      insRev.run(ek, nowSec - 1000, payload);
    }
    db.exec('COMMIT');
  } finally {
    db.close();
  }

  const lgManager = new UsageStatsManager({ geminiDir: lgGemini, stateDir: lgState });
  lgManager.setKnownAccounts([
    { id: 'acc-a', email: 'local-a@example.invalid' },
    { id: 'acc-b', email: 'remote-b@example.invalid' },
  ]);
  const lgCoordinator = createWiredCoordinator({
    stateDir: lgState,
    usageManager: lgManager,
    resolveMatchedLocalAccountId: email => (email === 'remote-b@example.invalid' ? 'acc-b' : null),
    getTargets: () => [
      makeRemoteRpcTarget({
        remoteKey: 'rk-lg',
        hostLabel: 'demo-ssh-host',
        email: 'remote-b@example.invalid',
        matchedLocalAccountId: 'acc-b',
        trajectories: [
          {
            cascadeId: 'c-lg',
            trajectoryId: 'traj-lg-1',
            stepCount: 1,
            lastModifiedTime: new Date(nowSec * 1000).toISOString(),
            generators: [
              { stepIndices: [0], executionId: 'e-lg', model: 'claude-sonnet-4-5', usage: { inputTokens: '1500', outputTokens: '500', cacheReadTokens: '0' } },
            ],
            steps: [
              { idx: 0, metadata: { createdAt: new Date(nowSec * 1000).toISOString(), executionId: 'e-lg' } },
            ],
          },
        ],
      }),
    ],
  });
  await lgCoordinator.syncNow({ nowMs: nowSec * 1000 });
  lgManager.setOnlineRemoteEnvironments([
    { id: ssh1Id, kind: 'ssh', host_label: 'demo-ssh-host', online: true },
  ]);

  const lgSsh = await lgManager.getUsageSummary(false, 'acc-b', ssh1Id);
  const lgLocalA = await lgManager.getUsageSummary(false, 'acc-a', 'local');
  const lgAll = await lgManager.getUsageSummary(false, 'all', 'all');
  assert.equal(lgSsh.all_time.totals.total_tokens, 2000);
  assert.equal(lgSsh.all_time.totals.request_count, 1);
  assert.equal(lgLocalA.all_time.totals.total_tokens, 1000 + 25003);
  assert.equal(lgAll.all_time.totals.total_tokens, 50005 + 1000 + 2000);

  await assert.rejects(
    lgManager.getUsageEvents('all', '', 0, 50, lgSsh.snapshot_id, false, false, 'acc-b', 'local'),
    /不匹配|mismatch/i
  );
});

test('M2-E2E-3: usage_events 小账本与大账本脱敏字段与环境/置信度字段对齐', async t => {
  const { geminiDir, stateDir } = await createIsolatedWorkspace(t, 'gb-m2-e2e-3-');
  const nowSec = Math.floor(Date.now() / 1000) - 90;
  const ledger = new UsageLedger(stateDir);
  await ledger.save([
    {
      ...makeLocalEvent({ id: 'loc-1', ts: nowSec - 20, input: 100, output: 50, cached: 0 }),
      db_file: 'conv-local.db',
    },
  ]);

  const sshEnvId = buildRemoteEnvironmentId('demo-ssh-host');
  const usageManager = new UsageStatsManager({ geminiDir, stateDir });
  usageManager.setKnownAccounts([{ id: 'acc-a', email: 'local-a@example.invalid' }]);
  const coordinator = createWiredCoordinator({
    stateDir,
    usageManager,
    getTargets: () => [
      makeRemoteRpcTarget({
        remoteKey: 'rk-ev',
        hostLabel: 'demo-ssh-host',
        email: 'remote-b@example.invalid',
        trajectories: [
          {
            cascadeId: 'c-ev',
            trajectoryId: 'traj-ev-secret',
            stepCount: 1,
            lastModifiedTime: new Date(nowSec * 1000).toISOString(),
            generators: [
              { stepIndices: [0], executionId: 'exec-ev-secret', model: 'claude-sonnet-4-5', usage: { inputTokens: '400', outputTokens: '100', cacheReadTokens: '0' } },
            ],
            steps: [
              { idx: 0, metadata: { createdAt: new Date(nowSec * 1000).toISOString(), executionId: 'exec-ev-secret' } },
            ],
          },
        ],
      }),
    ],
  });
  await coordinator.syncNow({ nowMs: nowSec * 1000 });
  usageManager.setOnlineRemoteEnvironments([
    { id: sshEnvId, kind: 'ssh', host_label: 'demo-ssh-host', online: true },
  ]);

  const pageAll = await usageManager.getUsageEvents('all', '', 0, 50);
  assert.equal(pageAll.total, 2);
  for (const row of pageAll.rows) {
    for (const forbidden of ['event_key', 'source_id', 'legacy_event_key', 'db_file', 'trajectory_id', 'execution']) {
      assert.equal(Object.hasOwn(row, forbidden), false, `禁止泄漏字段 ${forbidden}`);
    }
  }
  const sshRow = pageAll.rows.find(r => r.environment_kind === 'ssh');
  const localRow = pageAll.rows.find(r => r.environment_kind === 'local');
  assert.ok(sshRow);
  assert.ok(localRow);
  assert.equal(sshRow.environment_id, sshEnvId);
  assert.equal(sshRow.environment_label, 'demo-ssh-host');
  assert.equal(sshRow.account_email, 'remote-b@example.invalid');
  assert.equal(sshRow.account_confidence, 'observed');
  assert.equal(localRow.environment_id, 'local');
  assert.equal(localRow.environment_label, '');
  assert.equal(localRow.account_confidence, 'observed');

  const pageSshOnly = await usageManager.getUsageEvents('all', '', 0, 50, undefined, false, false, undefined, sshEnvId);
  assert.equal(pageSshOnly.total, 1);
  assert.equal(pageSshOnly.rows[0].environment_id, sshEnvId);

  const pageLocalAccA = await usageManager.getUsageEvents('all', '', 0, 50, undefined, false, false, 'acc-a', 'local');
  assert.equal(pageLocalAccA.total, 1);
  assert.equal(pageLocalAccA.rows[0].environment_kind, 'local');
});

test('M2-E2E-4: 混合账本 usage-revalue preview/apply/restore 与 save 互斥', async t => {
  const { geminiDir, stateDir } = await createIsolatedWorkspace(t, 'gb-m2-e2e-4-');
  const nowSec = Math.floor(Date.now() / 1000) - 100;
  const usageManager = new UsageStatsManager({ geminiDir, stateDir });
  await usageManager.savePricingTable({
    'claude-sonnet-4-5': { model: 'Claude Sonnet 4.5', input: 3, output: 15, cached: 0.3, cacheWrite: 3.75 },
    'gemini-2.5-pro': { model: 'Gemini 2.5 Pro', input: 1.25, output: 10, cached: 0.125 },
  });

  const ledger = new UsageLedger(stateDir);
  await ledger.save([
    makeLocalEvent({ id: 'rev-local', ts: nowSec - 10, model: 'claude-sonnet-4-5', input: 1_000_000, output: 0, cached: 0 }),
  ], { billingPrices: await usageManager.getBillingPricingTable() });

  const coordinator = createWiredCoordinator({
    stateDir,
    usageManager,
    getTargets: () => [
      makeRemoteRpcTarget({
        remoteKey: 'rk-rev',
        hostLabel: 'demo-ssh-host',
        email: 'remote-b@example.invalid',
        trajectories: [
          {
            cascadeId: 'c-rev',
            trajectoryId: 'traj-rev-1',
            stepCount: 1,
            lastModifiedTime: new Date(nowSec * 1000).toISOString(),
            generators: [
              { stepIndices: [0], executionId: 'e-rev', model: 'gemini-2.5-pro', usage: { inputTokens: '1000000', outputTokens: '0', cacheReadTokens: '0' } },
            ],
            steps: [
              { idx: 0, metadata: { createdAt: new Date(nowSec * 1000).toISOString(), executionId: 'e-rev' } },
            ],
          },
        ],
      }),
    ],
  });
  await coordinator.syncNow({ nowMs: nowSec * 1000 });
  const sshEnvId = buildRemoteEnvironmentId('demo-ssh-host');
  usageManager.setOnlineRemoteEnvironments([
    { id: sshEnvId, kind: 'ssh', host_label: 'demo-ssh-host', online: true },
  ]);

  const beforeSummary = await usageManager.getUsageSummary(true, 'all', 'all');
  // 1M claude-sonnet-4-5 ($3) + 1M gemini-2.5-pro ($1.25) = $4.25
  assert.ok(Math.abs(beforeSummary.all_time.estimated_usd - 4.25) < 1e-6);
  assert.ok(Math.abs((beforeSummary.environment_breakdown?.local_usd ?? 0) - 3) < 1e-6);
  assert.ok(Math.abs((beforeSummary.environment_breakdown?.ssh_usd ?? 0) - 1.25) < 1e-6);

  // 修改价格表并执行混合账本 preview -> apply -> restore 全流程
  await usageManager.savePricingTable({
    'claude-sonnet-4-5': { model: 'Claude Sonnet 4.5', input: 6, output: 30, cached: 0.6, cacheWrite: 7.5 },
    'gemini-2.5-pro': { model: 'Gemini 2.5 Pro', input: 2.5, output: 20, cached: 0.25 },
  });
  const preview = await usageManager.previewRevalueHistory('force_all');
  assert.ok(Math.abs(preview.before - 4.25) < 1e-6);
  assert.ok(Math.abs(preview.after - 8.5) < 1e-6);

  const applied = await usageManager.revalueHistory(true, { mode: 'force_all', previewId: preview.previewId });
  assert.ok(Math.abs(applied.after - 8.5) < 1e-6);
  const appliedSummary = await usageManager.getUsageSummary(true, 'all', 'all');
  assert.ok(Math.abs(appliedSummary.all_time.estimated_usd - 8.5) < 1e-6);
  assert.ok(Math.abs((appliedSummary.environment_breakdown?.local_usd ?? 0) - 6) < 1e-6);
  assert.ok(Math.abs((appliedSummary.environment_breakdown?.ssh_usd ?? 0) - 2.5) < 1e-6);

  await usageManager.restoreRevalueHistory(preview.previewId, true);
  const restoredSummary = await usageManager.getUsageSummary(true, 'all', 'all');
  assert.ok(Math.abs(restoredSummary.all_time.estimated_usd - 4.25) < 1e-6);
  assert.ok(Math.abs((restoredSummary.environment_breakdown?.local_usd ?? 0) - 3) < 1e-6);
  assert.ok(Math.abs((restoredSummary.environment_breakdown?.ssh_usd ?? 0) - 1.25) < 1e-6);

  // 验证 revalueHistory 与 ingestRemoteUsageBatch 并发互斥序列化（先启动的重估先完成，后到的远端入账排队按新价落锁）
  const preview2 = await usageManager.previewRevalueHistory('force_all');
  const [applied2, concurrentSave] = await Promise.all([
    usageManager.revalueHistory(true, { mode: 'force_all', previewId: preview2.previewId }),
    usageManager.ingestRemoteUsageBatch(
      [
        {
          event_key: buildRemoteEventKey(buildRemoteTrajectorySourceId('traj-rev-extra'), 0, 'e-extra'),
          source_id: buildRemoteTrajectorySourceId('traj-rev-extra'),
          source_observed_at: nowSec,
          environment_kind: 'ssh',
          environment_id: sshEnvId,
          environment_label: 'demo-ssh-host',
          trajectory_id: 'traj-rev-extra',
          execution: 'e-extra',
          model: 'gemini-2.5-pro',
          input_tokens: 1_000_000,
          output_tokens: 0,
          cached_tokens: 0,
          total_tokens: 1_000_000,
          timestamp_seconds: nowSec,
          account_email: 'remote-b@example.invalid',
          account_confidence: 'observed',
        },
      ],
      []
    ),
  ]);
  assert.ok(Math.abs(applied2.after - 8.5) < 1e-6);
  assert.equal(concurrentSave.saved, 1);

  const afterSummary = await usageManager.getUsageSummary(true, 'all', 'all');
  // 8.5 (重估后) + 2.5 (互斥排队后按新价锁定的 extra) = 11.0
  assert.ok(Math.abs(afterSummary.all_time.estimated_usd - 11.0) < 1e-6);
});

test('M2-E2E-5: 断线重连后尾重叠 10 -> 12 流式修订锁价不漂移与重放幂等', async t => {
  const { geminiDir, stateDir } = await createIsolatedWorkspace(t, 'gb-m2-e2e-5-');
  const t0 = Math.floor(Date.now() / 1000) - 300;
  const usageManager = new UsageStatsManager({ geminiDir, stateDir });
  await usageManager.savePricingTable({
    'claude-sonnet-4-5': { model: 'Claude Sonnet 4.5', input: 3, output: 15, cached: 0.3, cacheWrite: 3.75 },
  });

  const sshEnvId = buildRemoteEnvironmentId('demo-ssh-host');
  let stepCount = 10;
  let outputTokens = 100;
  let lastModifiedIso = new Date(t0 * 1000).toISOString();

  const coordinator = createWiredCoordinator({
    stateDir,
    usageManager,
    getTargets: () => [
      makeRemoteRpcTarget({
        remoteKey: 'rk-stream',
        hostLabel: 'demo-ssh-host',
        email: 'remote-b@example.invalid',
        trajectories: [
          {
            cascadeId: 'c-stream',
            trajectoryId: 'traj-stream-10-12',
            stepCount,
            lastModifiedTime: lastModifiedIso,
            generators: [
              {
                stepIndices: [0],
                executionId: 'exec-stream-1',
                model: 'claude-sonnet-4-5',
                usage: { inputTokens: '1000000', outputTokens: String(outputTokens), cacheReadTokens: '0' },
              },
            ],
            steps: [
              { idx: 0, metadata: { createdAt: new Date(t0 * 1000).toISOString(), executionId: 'exec-stream-1' } },
            ],
          },
        ],
      }),
    ],
  });

  // 第 1 轮同步（10 步，output=100）
  const r1 = await coordinator.syncNow({ nowMs: t0 * 1000 });
  assert.equal(r1.ok, true);
  assert.equal(r1.eventsSaved, 1);
  usageManager.setOnlineRemoteEnvironments([
    { id: sshEnvId, kind: 'ssh', host_label: 'demo-ssh-host', online: true },
  ]);

  const s1 = await usageManager.getUsageSummary(true, 'all', 'all');
  // 1M * $3 + 100 * $15 / 1M = 3.0015
  assert.ok(Math.abs(s1.all_time.estimated_usd - 3.0015) < 1e-7);

  // 断线 + 期间后台价格表涨价 10 倍，随后重连（12 步，outputTokens -> 100000）
  coordinator.markEnvironmentDisconnected(sshEnvId, t0 + 10);
  await usageManager.savePricingTable({
    'claude-sonnet-4-5': { model: 'Claude Sonnet 4.5', input: 30, output: 150, cached: 3, cacheWrite: 37.5 },
  });

  stepCount = 12;
  outputTokens = 100_000;
  lastModifiedIso = new Date((t0 + 60) * 1000).toISOString();
  const r2 = await coordinator.syncNow({ nowMs: (t0 + 65) * 1000 });
  assert.equal(r2.ok, true);
  assert.equal(r2.eventsSaved, 1);

  const s2 = await usageManager.getUsageSummary(true, 'all', 'all');
  // 仍只计 1 条请求（零双计），且保留原锁定单价 $3/$15：1M * $3 + 100k * $15 / 1M = 3 + 1.5 = 4.5
  assert.equal(s2.all_time.totals.request_count, 1);
  assert.equal(s2.all_time.totals.total_tokens, 1_100_000);
  assert.ok(Math.abs(s2.all_time.estimated_usd - 4.5) < 1e-6);

  const evPage = await usageManager.getUsageEvents('all', '', 0, 10);
  assert.equal(evPage.total, 1);
  // 原先 observed 归属不可被降级
  assert.equal(evPage.rows[0].account_confidence, 'observed');

  // 再次幂等重放（lastModifiedTime/stepCount 未变）
  const r3 = await coordinator.syncNow({ nowMs: (t0 + 120) * 1000 });
  assert.equal(r3.eventsSaved, 0);
  const s3 = await usageManager.getUsageSummary(false, 'all', 'all');
  assert.equal(s3.all_time.totals.request_count, 1);
  assert.ok(Math.abs(s3.all_time.estimated_usd - 4.5) < 1e-6);
});

test('M2-E2E-6: SSH 未关联归属精确筛选、单账号提示计数透传与 receipt-only 不抬升 remoteSyncRevision', async t => {
  const { geminiDir, stateDir } = await createIsolatedWorkspace(t, 'gb-m2-e2e-6-');
  const nowSec = Math.floor(Date.now() / 1000) - 60;
  const ledger = new UsageLedger(stateDir);
  await ledger.save([
    makeLocalEvent({ id: 'e6-local', ts: nowSec - 120, input: 100_000, output: 0, cached: 0 }),
  ]);

  const usageManager = new UsageStatsManager({ geminiDir, stateDir });
  usageManager.setKnownAccounts([
    { id: 'acc-a', email: 'local-a@example.invalid', name: 'Local A' },
    { id: 'acc-remote', email: 'remote-b@example.invalid', name: 'Remote B' },
  ]);
  await usageManager.savePricingTable({
    'claude-sonnet-4-5': { model: 'Claude Sonnet 4.5', input: 3, output: 15, cached: 0.3, cacheWrite: 3.75 },
  });

  const sshEnvId = buildRemoteEnvironmentId('demo-ssh-host');
  usageManager.setOnlineRemoteEnvironments([
    { id: sshEnvId, kind: 'ssh', host_label: 'demo-ssh-host', online: true },
  ]);

  const billingPrices = await usageManager.getBillingPricingTable();
  const initialSave = await usageManager.ingestRemoteUsageBatch(
    [
      {
        event_key: buildRemoteEventKey(buildRemoteTrajectorySourceId('traj-e6-obs'), 0, 'e-obs'),
        source_id: buildRemoteTrajectorySourceId('traj-e6-obs'),
        source_observed_at: nowSec,
        environment_kind: 'ssh',
        environment_id: sshEnvId,
        environment_label: 'demo-ssh-host',
        trajectory_id: 'traj-e6-obs',
        execution: 'e-obs',
        model: 'claude-sonnet-4-5',
        input_tokens: 1_000_000,
        output_tokens: 0,
        cached_tokens: 0,
        total_tokens: 1_000_000,
        timestamp_seconds: nowSec,
        account_id: 'acc-remote',
        account_email: 'remote-b@example.invalid',
        account_confidence: 'observed',
      },
      {
        event_key: buildRemoteEventKey(buildRemoteTrajectorySourceId('traj-e6-unattr'), 0, 'e-unattr'),
        source_id: buildRemoteTrajectorySourceId('traj-e6-unattr'),
        source_observed_at: nowSec - 10,
        environment_kind: 'ssh',
        environment_id: sshEnvId,
        environment_label: 'demo-ssh-host',
        trajectory_id: 'traj-e6-unattr',
        execution: 'e-unattr',
        model: 'claude-sonnet-4-5',
        input_tokens: 500_000,
        output_tokens: 0,
        cached_tokens: 0,
        total_tokens: 500_000,
        timestamp_seconds: nowSec - 10,
        account_id: null,
        account_email: null,
        account_confidence: 'unknown',
      },
    ],
    [
      {
        source_id: buildRemoteTrajectorySourceId('traj-e6-obs'),
        environment_id: sshEnvId,
        cursor_offset: 1,
        step_offset: 2,
        last_modified_sec: nowSec,
        step_count: 2,
        committed_at: nowSec,
      },
    ],
    { billingPrices }
  );
  assert.equal(initialSave.saved, 2);

  // 1. SSH + 具体单账号（当前无记录）时：summary 返回 0，同时 IPC 透传 unattributedRequests/Tokens 且 availableAccounts 不含 unattributed 哨兵
  const sumLocalAccInSsh = await usageManager.getUsageSummary(true, 'acc-a', sshEnvId);
  const ipcAccA = projectUsagePeriodSummary(sumLocalAccInSsh, 'today');
  assert.equal(ipcAccA.summary.requestCount, 0);
  assert.equal(ipcAccA.summary.totalTokens, 0);
  assert.equal(ipcAccA.unattributedRequests, 1);
  assert.equal(ipcAccA.unattributedTokens, 500_000);
  assert.equal(ipcAccA.availableAccounts.some(a => a.id === 'unattributed'), false);
  const initialRev = sumLocalAccInSsh.remote_sync_revision ?? 0;
  assert.equal(initialRev, 1);

  // 2. accountId = 'unattributed' 精确拉取未关联事件（汇总 + 明细分页）
  const sumUnattr = await usageManager.getUsageSummary(false, 'unattributed', sshEnvId);
  const ipcUnattr = projectUsagePeriodSummary(sumUnattr, 'today');
  assert.equal(ipcUnattr.selectedAccountId, 'unattributed');
  assert.equal(ipcUnattr.summary.requestCount, 1);
  assert.equal(ipcUnattr.summary.totalTokens, 500_000);

  const evUnattr = await usageManager.getUsageEvents('all', '', 0, 10, undefined, false, false, 'unattributed', sshEnvId);
  assert.equal(evUnattr.total, 1);
  assert.equal(evUnattr.rows[0].account_confidence, 'unknown');
  assert.equal(evUnattr.rows[0].account_email, null);

  // 3. 仅推进 sync receipt 且零新增事件时：绝不抬升 remoteSyncRevision
  const noopRes = await usageManager.ingestRemoteUsageBatch(
    [],
    [
      {
        source_id: buildRemoteTrajectorySourceId('traj-e6-obs'),
        environment_id: sshEnvId,
        cursor_offset: 1,
        step_offset: 3,
        last_modified_sec: nowSec + 5,
        step_count: 3,
        committed_at: nowSec + 5,
      },
    ],
    { billingPrices }
  );
  assert.equal(noopRes.saved, 0);
  const sumAfterNoop = await usageManager.getUsageSummary(false, 'acc-a', sshEnvId);
  assert.equal(sumAfterNoop.remote_sync_revision, initialRev);

  // 4. 真正保存新远端事件时，remoteSyncRevision 才顺次递增
  const extraSave = await usageManager.ingestRemoteUsageBatch(
    [
      {
        event_key: buildRemoteEventKey(buildRemoteTrajectorySourceId('traj-e6-extra'), 0, 'e-extra'),
        source_id: buildRemoteTrajectorySourceId('traj-e6-extra'),
        source_observed_at: nowSec + 10,
        environment_kind: 'ssh',
        environment_id: sshEnvId,
        environment_label: 'demo-ssh-host',
        trajectory_id: 'traj-e6-extra',
        execution: 'e-extra',
        model: 'claude-sonnet-4-5',
        input_tokens: 100_000,
        output_tokens: 0,
        cached_tokens: 0,
        total_tokens: 100_000,
        timestamp_seconds: nowSec + 10,
        account_id: 'acc-remote',
        account_email: 'remote-b@example.invalid',
        account_confidence: 'observed',
      },
    ],
    [],
    { billingPrices }
  );
  assert.equal(extraSave.saved, 1);
  const sumAfterExtra = await usageManager.getUsageSummary(false, 'all', 'all');
  assert.equal(sumAfterExtra.remote_sync_revision, initialRev + 1);
});
