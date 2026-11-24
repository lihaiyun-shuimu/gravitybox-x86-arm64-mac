import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Controller } from '../dist/controller.js';
import { dictionaryFromEntries } from '../dist/dictionary.js';
import { buildRemoteWindowKey } from '../dist/ssh-context.js';
import { buildRemoteEnvironmentId } from '../dist/remote-usage-sync.js';
import {
  EnvironmentRegistry,
  computeQuotaFreshness,
  fuseAccountQuotaAcrossEnvironments,
} from '../dist/ipc-projections.js';
import {
  buildDashboardAggregate,
  refreshStandbyAccountViaRemoteSsh,
} from '../dist/main.js';
import { AccountsManager } from '../dist/accounts.js';
import { resolveClientIpcTarget } from '../dist/platform/ipc.js';
import { stopBackendChild } from './test-ipc.mjs';

function startMockCdpServer({ dictVersion = 'test-dict', onEvaluate } = {}) {
  let targets = [];
  const sockets = new Set();
  const socketByTargetId = new Map();
  const bootedTargets = new Set();

  function encodeWsTextFrame(text) {
    const payload = Buffer.from(text, 'utf8');
    if (payload.length < 126) {
      return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
    }
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }

  function decodeWsFrames(buf, onMessage) {
    let offset = 0;
    while (offset + 2 <= buf.length) {
      const opcode = buf[offset] & 0x0f;
      const masked = (buf[offset + 1] & 0x80) !== 0;
      let len = buf[offset + 1] & 0x7f;
      let pos = offset + 2;
      if (len === 126) {
        if (pos + 2 > buf.length) break;
        len = buf.readUInt16BE(pos);
        pos += 2;
      } else if (len === 127) {
        if (pos + 8 > buf.length) break;
        len = Number(buf.readBigUInt64BE(pos));
        pos += 8;
      }
      const maskStart = pos;
      const dataStart = masked ? pos + 4 : pos;
      if (dataStart + len > buf.length) break;
      const payload = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) {
        payload[i] = masked ? buf[dataStart + i] ^ buf[maskStart + (i % 4)] : buf[dataStart + i];
      }
      offset = dataStart + len;
      if (opcode === 0x8) return Buffer.alloc(0);
      if (opcode === 0x1) onMessage(payload.toString('utf8'));
    }
    return buf.subarray(offset);
  }

  const server = http.createServer((req, res) => {
    if (req.url === '/json/version') {
      const addr = server.address();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${addr.port}/devtools/browser/b1` }));
      return;
    }
    if (req.url === '/json/list') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(targets));
      return;
    }
    res.writeHead(404).end();
  });

  server.on('upgrade', (req, socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    const key = req.headers['sec-websocket-key'];
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    const targetId = req.url?.startsWith('/devtools/page/') ? req.url.split('/').pop() : 'browser';
    if (targetId && targetId !== 'browser') socketByTargetId.set(targetId, socket);
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      buffer = decodeWsFrames(buffer, raw => {
        const msg = JSON.parse(raw);
        let result = {};
        if (msg.method === 'Target.getTargets') {
          result = {
            targetInfos: targets.map(t => ({ targetId: t.id, browserContextId: t.browserContextId || 'ctx-default' })),
          };
        } else if (msg.method === 'Page.getFrameTree') {
          const t = targets.find(x => x.id === targetId) || { url: 'http://127.0.0.1:44139/' };
          result = { frameTree: { frame: { id: `frame-${targetId}`, url: t.url } } };
        } else if (msg.method === 'Page.createIsolatedWorld') {
          result = { executionContextId: 100 };
        } else if (msg.method === 'Page.addScriptToEvaluateOnNewDocument') {
          result = { identifier: `reg-${targetId}` };
        } else if (msg.method === 'Runtime.evaluate') {
          const expr = String(msg.params?.expression || '');
          if (expr.includes('__GRAVITYBOX_BOOT__')) bootedTargets.add(targetId);
          const custom = onEvaluate?.(targetId, expr, msg.params?.contextId);
          if (custom !== undefined) {
            result = { result: { value: custom } };
          } else if (expr.includes('crypto.subtle.digest')) {
            result = {
              result: {
                value: {
                  hash: 'f066a497c9c61198394cb3218e42ff61d85b03910d81282589c3ef066905f347',
                  bytes: 1024,
                },
              },
            };
          } else if (expr.includes('document.querySelector')) {
            result = { result: { value: true } };
          } else if (expr.includes('__GRAVITYBOX_ENGINE_V1__?.state()')) {
            result = {
              result: {
                value: bootedTargets.has(targetId)
                  ? { version: dictVersion, active: true, languageMode: 'zh' }
                  : null,
              },
            };
          } else {
            result = { result: { value: { version: dictVersion, active: true } } };
          }
        }
        socket.write(encodeWsTextFrame(JSON.stringify({ id: msg.id, result })));
      });
    });
  });

  return {
    async start() {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address();
      return {
        port,
        setTargets(next) {
          targets = next.map(t => ({
            ...t,
            webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${t.id}`,
          }));
        },
        emitFocus(targetId, contextId = 100) {
          const targetSocket = socketByTargetId.get(targetId);
          if (!targetSocket) return;
          try {
            targetSocket.write(encodeWsTextFrame(JSON.stringify({
              method: 'Runtime.bindingCalled',
              params: {
                name: '__gravityboxWindowFocus',
                payload: String(Date.now()),
                executionContextId: contextId,
              },
            })));
          } catch {}
        },
        async stop() {
          for (const s of sockets) s.destroy();
          await new Promise(resolve => server.close(resolve));
        },
      };
    },
  };
}

async function exchange(directory, request, { timeout = 8000 } = {}) {
  const target = await resolveClientIpcTarget(directory);
  if (!target) throw new Error('IPC target unavailable');
  const payload = target.authToken ? { ...request, authToken: target.authToken } : request;
  return new Promise((resolve, reject) => {
    const socket = createConnection(target.endpoint);
    let value = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('IPC 超时')); }, timeout);
    const finish = error => { clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(value); };
    socket.on('connect', () => socket.write(JSON.stringify(payload) + '\n'));
    socket.on('data', chunk => { value += chunk; if (value.includes('\n')) finish(); });
    socket.on('error', finish);
  });
}

async function createMockAppPath(t) {
  const root = await mkdtemp(join(tmpdir(), 'gb-ssh-ipc-app-'));
  const appPath = join(root, 'Antigravity.app');
  await mkdir(join(appPath, 'Contents', 'Resources'), { recursive: true });
  await writeFile(join(appPath, 'Contents', 'Resources', 'app.asar'), 'mock-asar');
  t.after(() => rm(root, { recursive: true, force: true }));
  return appPath;
}

test('Controller remoteSessions：30s 缓存、并发去重、10m 断连保留、焦点追踪与 auth_expired 保留旧快照', async (t) => {
  const appPath = await createMockAppPath(t);
  const dict = dictionaryFromEntries({});
  let probeCalls = 0;
  let remoteMode = 'ok';
  const cdpServer = await startMockCdpServer({
    dictVersion: dict.version,
    onEvaluate(targetId, expr) {
      if (targetId === 'remote-1' && expr.includes('GetUserStatus')) {
        probeCalls++;
        if (remoteMode === 'auth_expired') {
          return { ok: false, reason: 'auth_expired', authExpired: true, status: 401 };
        }
        return {
          ok: true,
          latencyMs: 12,
          data: {
            userStatusData: {
              userStatus: {
                email: 'remote-ssh@example.invalid',
                name: 'Remote Dev',
                userTier: { id: 'g1-pro-tier', name: 'Google AI Pro' },
                cascadeModelConfigData: {
                  clientModelConfigs: [
                    { modelOrAlias: { model: 'gemini-3.8-flash' }, label: 'Gemini 3.8 Flash', quotaInfo: { remainingFraction: 0.77, resetTime: '2026-11-20T18:00:00Z' } },
                  ],
                },
              },
            },
            quotaSummaryData: {
              groups: [
                { displayName: 'Gemini Models', buckets: [{ window: 'WINDOW_5_HOUR', remainingFraction: 0.77, resetTime: '2026-11-20T18:00:00Z' }] },
              ],
            },
          },
        };
      }
      if (expr.includes('maintenanceState')) return { busy: false };
      if (expr.includes('draftState')) return { busy: false, checked: true };
      return undefined;
    },
  }).start();

  const remoteKey = buildRemoteWindowKey('demo-ssh-host', 'https://127.0.0.1:44139');
  cdpServer.setTargets([
    { id: 'remote-1', type: 'page', url: 'https://127.0.0.1:44139/', browserContextId: 'ctx-remote-1' },
  ]);

  let lastStatus = null;
  const controller = new Controller({
    appPath,
    profile: '/tmp/nonexistent-profile',
    dictionary: dict,
    hudEnabled: false,
    discoverEndpoint: async () => ({
      port: cdpServer.port,
      browserURL: `ws://127.0.0.1:${cdpServer.port}/devtools/browser/b1`,
      pid: process.pid,
      appVersion: '2.33.0',
      legacyPatch: false,
    }),
    inspectPage: async () => 'unlisted',
    verifyRemoteWindow: async ({ url, browserContextId }) => ({
      status: 'verified',
      identity: {
        kind: 'remote',
        remoteKey: buildRemoteWindowKey('demo-ssh-host', new URL(url).origin),
        hostLabel: 'demo-ssh-host',
        browserContextId: browserContextId || 'ctx-remote-1',
        origin: 'https://127.0.0.1:44139',
        verifiedBy: 'process',
      },
    }),
    onStatus: (s) => { lastStatus = s; },
  });

  await controller.start();
  try {
    // status 快照不包含邮箱等账号字段
    assert.equal(Object.hasOwn(lastStatus, 'remoteSessions'), false);
    assert.equal(lastStatus.sshWindowsCount, 1);
    assert.deepEqual(lastStatus.activeSshHosts, ['demo-ssh-host']);
    assert.deepEqual(controller.getActiveSshWindowsSummary(), { count: 1, hosts: ['demo-ssh-host'] });

    // 并发 probe 去重 + 30s 缓存
    const t0 = Date.now();
    const [r1, r2, r3] = await Promise.all([
      controller.probeRemoteSessions({ nowMs: t0, matchAccountId: e => (e === 'remote-ssh@example.invalid' ? 'local-acc-1' : null) }),
      controller.probeRemoteSessions({ nowMs: t0 }),
      controller.probeRemoteSessions({ nowMs: t0 + 5000 }),
    ]);
    assert.equal(probeCalls, 1, '同 remoteKey 并发及 30s 内复用应只触发 1 次 RPC');
    assert.equal(r1[0].email, 'remote-ssh@example.invalid');
    assert.equal(r1[0].matchedLocalAccountId, 'local-acc-1');
    assert.equal(r2.length, 1);
    assert.equal(r3.length, 1);

    // 超过 30s 或 force=true 触发新探测；auth_expired 保留上次 email 与 quota
    remoteMode = 'auth_expired';
    const expiredRes = await controller.probeRemoteSessions({ force: true, nowMs: t0 + 35_000 });
    assert.equal(probeCalls, 2);
    assert.equal(expiredRes[0].state, 'auth_expired');
    assert.equal(expiredRes[0].email, 'remote-ssh@example.invalid');
    assert.ok(expiredRes[0].quota, 'auth_expired 必须保留上次配额快照');

    // 焦点追踪：远程窗口触发 focus -> remote:<key>
    await new Promise(r => setTimeout(r, 10));
    cdpServer.emitFocus('remote-1');
    await new Promise(r => setTimeout(r, 25));
    assert.equal(controller.getFocusedContextKey(), `remote:${remoteKey}`);

    // maintenancePreflight 返回活跃 SSH 窗口计数与脱敏主机名
    const mPreflight = await controller.maintenancePreflight();
    assert.equal(mPreflight.activeSshWindowsCount, 1);
    assert.deepEqual(mPreflight.activeSshHosts, ['demo-ssh-host']);

    // 远端窗口关闭 -> 标记 disconnected，10 分钟内保留，焦点自动回落 local；满 10 分钟后清理
    cdpServer.setTargets([]);
    await controller.sync();
    assert.equal(controller.getFocusedContextKey(), 'local');
    const within10m = controller.getRemoteSessionsSnapshot(Date.now() + 5 * 60_000);
    assert.equal(within10m.length, 1);
    assert.equal(within10m[0].remoteKey, remoteKey);
    assert.equal(within10m[0].state, 'disconnected');
    assert.equal(within10m[0].email, 'remote-ssh@example.invalid');

    const after10m = controller.getRemoteSessionsSnapshot(Date.now() + 10 * 60_000 + 5000);
    assert.equal(after10m.length, 0);
  } finally {
    await controller.stop();
    await cdpServer.stop();
  }
});

test('dist/main.js IPC 契约：status / dashboard_summary / remote_quota_refresh / preflight 返回完整 SSH 扩展字段且本机账号隔离', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gb-ssh-ipc-'));
  await mkdir(join(dir, '词典'), { recursive: true });
  const child = spawn(process.execPath, [
    fileURLToPath(new URL('../dist/main.js', import.meta.url)),
    '--state-dir', dir,
    '--app', '/nonexistent',
    '--profile', join(dir, 'profile'),
    '--home-dir', join(dir, 'home'),
    '--app-support-dir', join(dir, 'appsupport'),
    '--gemini-dir', join(dir, 'gemini'),
  ], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, GRAVITYBOX_PROBE_LS: 'false' } });

  try {
    const deadline = Date.now() + 15_000;
    let bootStatus = null;
    while (Date.now() < deadline) {
      try {
        const res = JSON.parse((await exchange(dir, { command: 'status', includeTasks: false })).split('\n')[0]);
        if (res.ok) { bootStatus = res; break; }
      } catch {}
      await new Promise(r => setTimeout(r, 80));
    }
    assert.ok(bootStatus?.ok);
    assert.equal(Array.isArray(bootStatus.status.remoteSessions), true);
    assert.equal(bootStatus.status.sshWindowsCount, 0);
    assert.deepEqual(bootStatus.status.activeSshHosts, []);
    assert.equal(bootStatus.status.focusedContextKey, 'local');
    assert.equal(typeof bootStatus.status.remoteObservedVersion, 'number');

    const dash = JSON.parse((await exchange(dir, { command: 'dashboard_summary' })).split('\n')[0]);
    assert.equal(dash.ok, true);
    assert.deepEqual(dash.remoteSessions, []);
    assert.equal(dash.focusedContextKey, 'local');
    assert.equal(dash.sshWindowsCount, 0);
    assert.equal(dash.accounts.total, 0);
    assert.equal(dash.usage.selectedEnvironmentId, 'all');

    const dashLocal = JSON.parse((await exchange(dir, { command: 'dashboard_summary', environmentId: 'local' })).split('\n')[0]);
    assert.equal(dashLocal.ok, true);
    assert.equal(dashLocal.usage.selectedEnvironmentId, 'local');
    assert.equal(dashLocal.usage.periods, undefined);

    const refreshRes = JSON.parse((await exchange(dir, { command: 'remote_quota_refresh', environmentId: 'ssh:nonexistent' })).split('\n')[0]);
    assert.equal(refreshRes.ok, true);
    assert.deepEqual(refreshRes.remoteSessions, []);
    assert.equal(refreshRes.focusedContextKey, 'local');
    assert.equal(typeof refreshRes.remoteObservedVersion, 'number');

    const swPreflight = JSON.parse((await exchange(dir, { command: 'account_switch_preflight', id: 'none' })).split('\n')[0]);
    assert.equal(swPreflight.ok, true);
    assert.equal(swPreflight.activeSshWindowsCount, 0);
    assert.deepEqual(swPreflight.activeSshHosts, []);

    const mPreflight = JSON.parse((await exchange(dir, { command: 'maintenance_preflight' })).split('\n')[0]);
    assert.equal(mPreflight.ok, true);
    assert.equal(mPreflight.activeSshWindowsCount, 0);
    assert.deepEqual(mPreflight.activeSshHosts, []);

    // 验证 status / status.json / dashboard_summary / usage_summary 统一返回 EnvironmentRegistry SSOT 字段
    const statusJson = JSON.parse(await readFile(join(dir, 'status.json'), 'utf8'));
    assert.equal(Object.hasOwn(statusJson, 'activeAccountEmail'), false, 'status.json 不得承载 activeAccountEmail');
    assert.equal(Array.isArray(statusJson.remoteSessions), true);
    assert.equal(Array.isArray(statusJson.environments), true);
    assert.equal(typeof statusJson.environmentsRevision, 'number');
    assert.equal(typeof statusJson.remoteSyncRevision, 'number');
    assert.equal(statusJson.focusedEnvironmentId, 'local');

    assert.deepEqual(bootStatus.status.environments[0].environmentId, 'local');
    assert.equal(bootStatus.status.environments[0].kind, 'local');
    assert.equal(bootStatus.status.environments[0].lifecycleState, 'online');
    assert.equal(bootStatus.status.focusedEnvironmentId, 'local');
    assert.equal(typeof bootStatus.status.environmentsRevision, 'number');

    assert.equal(Array.isArray(dash.environments), true);
    assert.equal(dash.focusedEnvironmentId, 'local');
    assert.equal(typeof dash.environmentsRevision, 'number');
    assert.equal(typeof dash.remoteSyncRevision, 'number');

    const usageRes = JSON.parse((await exchange(dir, { command: 'usage_summary', period: 'today' })).split('\n')[0]);
    assert.equal(usageRes.ok, true);
    assert.equal(Array.isArray(usageRes.environments), true);
    assert.equal(usageRes.environments[0].environmentId, 'local');
    assert.equal(usageRes.focusedEnvironmentId, 'local');
    assert.equal(typeof usageRes.environmentsRevision, 'number');
    assert.equal(typeof usageRes.remoteSyncRevision, 'number');
  } finally {
    try { await exchange(dir, { command: 'stop' }); } catch {}
    await stopBackendChild(child);
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('英文+关HUD（observeOnly）不断开页面发现与SSH观测，且同主机多窗口按environmentId去重优选健康窗口', async (t) => {
  const appPath = await createMockAppPath(t);
  const dict = dictionaryFromEntries({ Settings: '设置' });
  const evalExprs = [];
  const cdpServer = await startMockCdpServer({
    dictVersion: dict.version,
    onEvaluate(targetId, expr) {
      evalExprs.push({ targetId, expr });
      if ((targetId === 'ssh-win-1' || targetId === 'ssh-win-2') && expr.includes('GetUserStatus')) {
        return {
          ok: true,
          latencyMs: 10,
          data: {
            userStatusData: {
              userStatus: {
                email: 'shared-ssh@example.invalid',
                name: 'SSH Dev',
                userTier: { id: 'g1-pro-tier', name: 'Google AI Pro' },
                cascadeModelConfigData: {
                  clientModelConfigs: [
                    { modelOrAlias: { model: 'gemini-3.8-flash' }, label: 'Gemini 3.8 Flash', quotaInfo: { remainingFraction: 0.65, resetTime: '2026-11-22T18:00:00Z' } },
                  ],
                },
              },
            },
            quotaSummaryData: {
              groups: [
                { displayName: 'Gemini Models', buckets: [{ window: 'WINDOW_5_HOUR', remainingFraction: 0.65, resetTime: '2026-11-22T18:00:00Z' }] },
              ],
            },
          },
        };
      }
      return undefined;
    },
  }).start();

  cdpServer.setTargets([
    { id: 'local-win-1', type: 'page', url: 'https://127.0.0.1:44138/', browserContextId: 'ctx-local' },
    { id: 'ssh-win-1', type: 'page', url: 'https://127.0.0.1:44139/', browserContextId: 'ctx-ssh-1' },
    { id: 'ssh-win-2', type: 'page', url: 'https://127.0.0.1:44140/', browserContextId: 'ctx-ssh-2' },
  ]);

  let publishCount = 0;
  const controller = new Controller({
    appPath,
    profile: '/tmp/nonexistent-profile',
    dictionary: dict,
    initiallyPaused: true,
    locale: 'en',
    configuredLanguage: 'en',
    hasTargetDictionary: false,
    hudEnabled: false,
    discoverEndpoint: async () => ({
      port: cdpServer.port,
      browserURL: `ws://127.0.0.1:${cdpServer.port}/devtools/browser/b1`,
      pid: process.pid,
      appVersion: '2.33.0',
      legacyPatch: false,
    }),
    inspectPage: async (url) => (url.includes(':44138') ? 'local' : 'unlisted'),
    verifyRemoteWindow: async ({ url, browserContextId }) => ({
      status: 'verified',
      identity: {
        kind: 'remote',
        remoteKey: buildRemoteWindowKey('SSH: shared-gpu-host', new URL(url).origin),
        hostLabel: 'SSH: shared-gpu-host',
        browserContextId,
        origin: new URL(url).origin,
        verifiedBy: 'process',
      },
    }),
    onStatus: () => { publishCount++; },
  });

  await controller.start();
  try {
    assert.equal(controller.status.mode, 'paused');
    assert.equal(controller.status.windows, 3, '英文+关HUD下必须继续发现本地与SSH页面');
    assert.equal(controller.status.sshWindowsCount, 2);
    assert.deepEqual(controller.status.activeSshHosts, ['shared-gpu-host']);
    assert.equal(evalExprs.some(item => item.expr.includes('__GRAVITYBOX_BOOT__')), false, 'observeOnly 不得注入翻译或HUD引擎');

    const expectedEnvId = buildRemoteEnvironmentId('shared-gpu-host');
    assert.equal(controller.getEnvironmentWindowCounts().get(expectedEnvId), 2);
    assert.equal(controller.getEnvironmentWindowCounts().get('local'), 1);

    // 未 probe 完成前 probing === true
    const preProbeSnap = controller.getRemoteSessionsSnapshot();
    assert.equal(preProbeSnap.every(s => s.probing === true), true);

    // 模拟 ssh-win-1 上下文丢失 (contextId=undefined)，但焦点更高 -> getConnectedRemoteRpcTargets 应优选 contextId != undefined 的 ssh-win-2
    const p1 = controller.pages.get('ssh-win-1');
    const p2 = controller.pages.get('ssh-win-2');
    assert.ok(p1 && p2);
    p1.contextId = undefined;
    p1.lastFocusedAt = Date.now() + 5000;
    p2.lastFocusedAt = Date.now();

    const dedupTargets = controller.getConnectedRemoteRpcTargets();
    assert.equal(dedupTargets.length, 1, '同 environmentId 多窗口必须去重为 1 个 RPC 目标');
    assert.equal(dedupTargets[0].environmentId, expectedEnvId);
    assert.equal(dedupTargets[0].origin, 'https://127.0.0.1:44140', '必须优选 contextId != undefined 的健康窗口');
    assert.equal(dedupTargets[0].windowCount, 2);

    // 完成 probe 后 probing 转为 false
    const probed = await controller.probeRemoteSessions({ force: true });
    assert.equal(probed.some(s => s.email === 'shared-ssh@example.invalid' && s.probing === false), true);

    // 窗口焦点事件节流触发 publish() 且更新 focusedEnvironmentId
    const publishesBeforeFocus = publishCount;
    await new Promise(r => setTimeout(r, 15));
    cdpServer.emitFocus('ssh-win-2');
    await new Promise(r => setTimeout(r, 30));
    assert.equal(controller.getFocusedEnvironmentId(), expectedEnvId);
    assert.ok(publishCount > publishesBeforeFocus, '__gravityboxWindowFocus 必须触发 publish()');
  } finally {
    await controller.stop();
    await cdpServer.stop();
  }
});

test('EnvironmentRegistry 与同账号跨机配额新鲜度融合：统一四态、quotaFreshness、版本递增且不破坏本地存储', () => {
  const registry = new EnvironmentRegistry();
  const nowMs = 1_795_000_500_000;
  const nowSec = Math.floor(nowMs / 1000);
  const sshA = buildRemoteEnvironmentId('gpu-alpha');
  const sshB = buildRemoteEnvironmentId('gpu-beta');
  const sshHist = buildRemoteEnvironmentId('hist-gamma');

  const mkQuota = (pct, lastUpdated) => ({
    models: [{ name: 'gemini-3.8-flash', percentage: pct, percentage_known: true, reset_time: new Date(nowMs + 3_600_000).toISOString() }],
    quota_groups: [{ display_name: 'Gemini', buckets: [{ bucket_id: 'g-5h', window: '5h', remaining_fraction: pct / 100, remaining_fraction_known: true, reset_time: new Date(nowMs + 3_600_000).toISOString() }] }],
    last_updated: lastUpdated,
    is_forbidden: false,
    subscription_tier: 'PRO',
    model_forwarding_rules: {},
  });

  const savedLocalQuota = mkQuota(40, nowSec - 300);
  const fresherSshQuota = mkQuota(85, nowSec - 10);

  // 同账号跨机配额融合：远端更新 -> 取远端并标注来源，不修改原始 savedLocalQuota
  const fused = fuseAccountQuotaAcrossEnvironments({
    email: 'shared@example.invalid',
    savedQuota: savedLocalQuota,
    liveLocalQuota: null,
    remoteSessions: [
      { environmentId: sshA, email: 'shared@example.invalid', lifecycleState: 'online', quota: fresherSshQuota, observedAtMs: (nowSec - 10) * 1000 },
      { environmentId: sshB, email: 'other@example.invalid', lifecycleState: 'auth_expired', quota: null, observedAtMs: null },
    ],
    nowMs,
  });
  assert.equal(fused.quotaSourceEnvironmentId, sshA);
  assert.deepEqual(fused.activeRemoteEnvIds, [sshA]);
  assert.equal(fused.quota?.last_updated, nowSec - 10);
  assert.equal(savedLocalQuota.last_updated, nowSec - 300, '本地持久化配额对象不得被覆写');

  const snap1 = registry.buildSnapshot({
    nowMs,
    localWindowCount: 1,
    localFocusedAt: nowMs - 2000,
    focusedEnvironmentId: sshA,
    localAccount: { email: 'shared@example.invalid', name: 'Shared', tier: 'PRO', quota: savedLocalQuota, observedAtSec: nowSec - 300 },
    remoteSessions: [
      {
        remoteKey: 'rk-a',
        environmentId: sshA,
        hostLabel: 'SSH: gpu-alpha',
        targetId: 't-a',
        origin: 'https://127.0.0.1:44101',
        state: 'connected',
        probing: false,
        email: 'shared@example.invalid',
        name: 'Shared',
        tier: 'PRO',
        accountType: 'consumer',
        matchedLocalAccountId: 'acc-1',
        quota: fresherSshQuota,
        quotaOverview: null,
        observedAt: (nowSec - 10) * 1000,
        lastIdentityVerifiedAt: (nowSec - 10) * 1000,
        disconnectedAt: null,
        lastError: '',
        lastFocusedAt: nowMs - 1000,
      },
      {
        remoteKey: 'rk-b',
        environmentId: sshB,
        hostLabel: 'SSH · gpu-beta',
        targetId: 't-b',
        origin: 'https://127.0.0.1:44102',
        state: 'auth_expired',
        probing: false,
        email: 'other@example.invalid',
        name: 'Other',
        tier: 'FREE',
        accountType: 'consumer',
        matchedLocalAccountId: null,
        quota: mkQuota(20, nowSec - 2000),
        quotaOverview: null,
        observedAt: (nowSec - 2000) * 1000,
        lastIdentityVerifiedAt: null,
        disconnectedAt: null,
        lastError: 'auth_expired',
        lastFocusedAt: nowMs - 5000,
      },
    ],
    windowCountsByEnvId: new Map([[sshA, 2], [sshB, 1], ['local', 1]]),
    historicalEnvironments: [{ environmentId: sshHist, hostLabel: 'SSH: hist-gamma', lastSyncedAtSec: nowSec - 7200 }],
    receiptSyncTimes: new Map([[sshA, nowSec - 5]]),
    remoteSyncRevision: 3,
    staleAfterSeconds: 900,
  });

  assert.equal(snap1.environmentsRevision, 1);
  assert.equal(snap1.remoteSyncRevision, 3);
  assert.equal(snap1.focusedEnvironmentId, sshA);
  assert.equal(snap1.environments.length, 4);

  const [localNode, nodeA, nodeB, nodeHist] = snap1.environments;
  assert.equal(localNode.environmentId, 'local');
  assert.equal(localNode.lastQuotaObservedAt, nowSec - 10, 'local 节点同邮箱也应融合最新鲜配额');
  assert.equal(localNode.quotaFreshness, 'fresh');
  assert.equal(localNode.focused, false);

  assert.equal(nodeA.hostLabel, 'gpu-alpha', 'hostLabel 不含 SSH: 前缀');
  assert.equal(nodeA.lifecycleState, 'online');
  assert.equal(nodeA.windowCount, 2);
  assert.equal(nodeA.focused, true);
  assert.equal(nodeA.probing, false);
  assert.equal(nodeA.quotaFreshness, 'fresh');
  assert.equal(nodeA.lastUsageSyncedAt, nowSec - 5);

  assert.equal(nodeB.hostLabel, 'gpu-beta', 'hostLabel 不含 SSH · 前缀');
  assert.equal(nodeB.lifecycleState, 'auth_expired');
  assert.equal(nodeB.quotaFreshness, 'auth_expired');

  assert.equal(nodeHist.hostLabel, 'hist-gamma');
  assert.equal(nodeHist.lifecycleState, 'historical_only');
  assert.equal(nodeHist.windowCount, 0);
  assert.equal(nodeHist.quotaFreshness, 'offline_snapshot');
  assert.equal(nodeHist.lastUsageSyncedAt, nowSec - 7200);

  // remoteSessions 补齐扩展字段
  assert.equal(snap1.remoteSessions.length, 2);
  assert.equal(snap1.remoteSessions[0].environmentId, sshA);
  assert.equal(snap1.remoteSessions[0].windowCount, 2);
  assert.equal(snap1.remoteSessions[0].lifecycleState, 'online');
  assert.equal(snap1.remoteSessions[0].probing, false);
  assert.equal(snap1.remoteSessions[0].quotaFreshness, 'fresh');

  // 幂等再构建不递增 revision；状态变化立即递增
  const snapSame = registry.buildSnapshot({
    nowMs,
    localWindowCount: 1,
    localFocusedAt: nowMs - 2000,
    focusedEnvironmentId: sshA,
    localAccount: { email: 'shared@example.invalid', name: 'Shared', tier: 'PRO', quota: savedLocalQuota, observedAtSec: nowSec - 300 },
    remoteSessions: [
      {
        remoteKey: 'rk-a',
        environmentId: sshA,
        hostLabel: 'SSH: gpu-alpha',
        targetId: 't-a',
        origin: 'https://127.0.0.1:44101',
        state: 'connected',
        probing: false,
        email: 'shared@example.invalid',
        name: 'Shared',
        tier: 'PRO',
        accountType: 'consumer',
        matchedLocalAccountId: 'acc-1',
        quota: fresherSshQuota,
        quotaOverview: null,
        observedAt: (nowSec - 10) * 1000,
        lastIdentityVerifiedAt: (nowSec - 10) * 1000,
        disconnectedAt: null,
        lastError: '',
        lastFocusedAt: nowMs - 1000,
      },
      {
        remoteKey: 'rk-b',
        environmentId: sshB,
        hostLabel: 'SSH · gpu-beta',
        targetId: 't-b',
        origin: 'https://127.0.0.1:44102',
        state: 'auth_expired',
        probing: false,
        email: 'other@example.invalid',
        name: 'Other',
        tier: 'FREE',
        accountType: 'consumer',
        matchedLocalAccountId: null,
        quota: mkQuota(20, nowSec - 2000),
        quotaOverview: null,
        observedAt: (nowSec - 2000) * 1000,
        lastIdentityVerifiedAt: null,
        disconnectedAt: null,
        lastError: 'auth_expired',
        lastFocusedAt: nowMs - 5000,
      },
    ],
    windowCountsByEnvId: new Map([[sshA, 2], [sshB, 1], ['local', 1]]),
    historicalEnvironments: [{ environmentId: sshHist, hostLabel: 'SSH: hist-gamma', lastSyncedAtSec: nowSec - 7200 }],
    receiptSyncTimes: new Map([[sshA, nowSec - 5]]),
    remoteSyncRevision: 3,
    staleAfterSeconds: 900,
  });
  assert.equal(snapSame.environmentsRevision, 1);

  assert.equal(computeQuotaFreshness({
    lifecycleState: 'online',
    hasQuota: true,
    lastError: 'rpc_timeout',
    lastQuotaObservedAtSec: nowSec - 10,
    nowMs,
  }), 'error_fallback');
  assert.equal(computeQuotaFreshness({
    lifecycleState: 'offline_recent',
    hasQuota: true,
    lastQuotaObservedAtSec: nowSec - 10,
    nowMs,
  }), 'offline_snapshot');
});

test('重连换端口保留 environmentId 并触发 reconnected，buildDashboardAggregate 跨机融合配额', async (t) => {
  const appPath = await createMockAppPath(t);
  const dict = dictionaryFromEntries({});
  let portUrl = 'https://127.0.0.1:44150/';
  let targetId = 'ssh-reconn-1';
  const cdpServer = await startMockCdpServer({ dictVersion: dict.version }).start();

  let currentTargets = [{ id: targetId, type: 'page', url: portUrl, browserContextId: 'ctx-reconn-1' }];
  cdpServer.setTargets(currentTargets);

  const controller = new Controller({
    appPath,
    profile: '/tmp/nonexistent-profile',
    dictionary: dict,
    hudEnabled: false,
    discoverEndpoint: async () => ({
      port: cdpServer.port,
      browserURL: `ws://127.0.0.1:${cdpServer.port}/devtools/browser/b1`,
      pid: process.pid,
      appVersion: '2.33.0',
      legacyPatch: false,
    }),
    inspectPage: async () => 'unlisted',
    verifyRemoteWindow: async ({ url, browserContextId }) => ({
      status: 'verified',
      identity: {
        kind: 'remote',
        remoteKey: buildRemoteWindowKey('reconn-host', new URL(url).origin),
        hostLabel: 'reconn-host',
        browserContextId,
        origin: new URL(url).origin,
        verifiedBy: 'process',
      },
    }),
    onStatus: () => {},
  });

  await controller.start();
  try {
    const envId = buildRemoteEnvironmentId('reconn-host');
    assert.equal(controller.getConnectedRemoteRpcTargets()[0].reconnected, false);

    // 断线再以新端口重连
    cdpServer.setTargets([]);
    await controller.sync();
    assert.equal(controller.getRemoteSessionsSnapshot()[0].state, 'disconnected');

    portUrl = 'https://127.0.0.1:44999/';
    targetId = 'ssh-reconn-2';
    cdpServer.setTargets([{ id: targetId, type: 'page', url: portUrl, browserContextId: 'ctx-reconn-2' }]);
    await controller.sync();

    const targets = controller.getConnectedRemoteRpcTargets();
    assert.equal(targets.length, 1);
    assert.equal(targets[0].environmentId, envId);
    assert.equal(targets[0].origin, 'https://127.0.0.1:44999');
    assert.equal(targets[0].reconnected, true, '断线重连换端口后必须标记 reconnected: true 以校验切号');

    // buildDashboardAggregate 融合最新在线 SSH 配额并附带 quotaSourceEnvironmentId / activeRemoteEnvIds
    const nowSec = Math.floor(Date.now() / 1000);
    const savedAcc = {
      id: 'acc-shared',
      email: 'shared-dash@example.invalid',
      name: 'Shared Dash',
      quota: {
        models: [{ name: 'gemini-3.8-flash', percentage: 30, percentage_known: true, reset_time: new Date((nowSec + 3600) * 1000).toISOString() }],
        quota_groups: [{ display_name: 'Gemini', buckets: [{ bucket_id: 'g5', window: '5h', remaining_fraction: 0.3, remaining_fraction_known: true, reset_time: new Date((nowSec + 3600) * 1000).toISOString() }] }],
        last_updated: nowSec - 600,
        is_forbidden: false,
        subscription_tier: 'PRO',
        model_forwarding_rules: {},
      },
    };
    const remoteQuota = {
      models: [{ name: 'gemini-3.8-flash', percentage: 92, percentage_known: true, reset_time: new Date((nowSec + 3600) * 1000).toISOString() }],
      quota_groups: [{ display_name: 'Gemini', buckets: [{ bucket_id: 'g5', window: '5h', remaining_fraction: 0.92, remaining_fraction_known: true, reset_time: new Date((nowSec + 3600) * 1000).toISOString() }] }],
      last_updated: nowSec - 5,
      is_forbidden: false,
      subscription_tier: 'PRO',
      model_forwarding_rules: {},
    };
    const dashAgg = await buildDashboardAggregate({
      listAccounts: async () => ({ revision: 'rev-1', accounts: [savedAcc], active_account: savedAcc, active_account_id: 'acc-shared' }),
      getAutoSwitchConfig: async () => ({ enabled: false }),
      probeLiveLanguageServer: async () => null,
      getAccount: async () => savedAcc,
      getAccountQuotaOverview: (acc) => ({
        fiveHourRemaining: Math.round((acc.quota?.quota_groups?.[0]?.buckets?.[0]?.remaining_fraction ?? 0) * 100),
        weeklyRemaining: null,
        subscriptionTier: acc.quota?.subscription_tier ?? 'PRO',
        models: acc.quota?.models ?? [],
        quotaGroups: acc.quota?.quota_groups ?? [],
        projectedQuotaGroups: [],
        staleGroups: [],
        lastUpdated: acc.quota?.last_updated ?? null,
        isStale: false,
        staleHours: 0,
        familyWindows: null,
        argonStatus: null,
        carbonStatus: null,
        standaloneModels: [],
        refreshState: { complete: true },
        quotaWarnings: [],
        quotaWarningCodes: [],
      }),
      getUsageSummary: async () => ({
        today: { totals: { total_tokens: 0, request_count: 0 }, estimated_usd: 0, by_model: [] },
        all_time: { totals: { total_tokens: 0, request_count: 0 }, estimated_usd: 0, by_model: [] },
        today_hourly: [],
        selected_environment_id: 'all',
        available_environments: [],
      }),
      getPricingTable: async () => ({}),
      getRemoteSessions: () => [
        {
          environmentId: envId,
          email: 'shared-dash@example.invalid',
          lifecycleState: 'online',
          quota: remoteQuota,
          observedAtMs: (nowSec - 5) * 1000,
        },
      ],
    });
    assert.equal(dashAgg.accounts.fiveHourRemaining, 92);
    assert.equal(dashAgg.accounts.quotaSourceEnvironmentId, envId);
    assert.deepEqual(dashAgg.accounts.activeRemoteEnvIds, [envId]);
    assert.equal(savedAcc.quota.last_updated, nowSec - 600, '本地保存账号对象不得被篡改');
  } finally {
    await controller.stop();
    await cdpServer.stop();
  }
});

test('在线 SSH 已登录备用账号支持随时刷新并安全回写本地配额快照（syncRemoteObservedQuota + refreshStandbyAccountViaRemoteSsh）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gb-remote-standby-refresh-'));
  try {
    const accountsManager = new AccountsManager(dir);
    await accountsManager.init();
    const nowSec = Math.floor(Date.now() / 1000);
    const saved = await accountsManager.upsertAccount({
      email: 'ssh-standby@example.invalid',
      name: 'SSH Standby User',
      custom_label: '用户备注-保留',
      refresh_token: 'keep-refresh-token-123',
      access_token: 'expired-access-token',
      expires_in: -60,
    });
    const staleQuota = {
      models: [{ name: 'gemini-3.8-flash', percentage: 35, percentage_known: true, reset_time: new Date((nowSec + 3600) * 1000).toISOString() }],
      quota_groups: [{ display_name: 'Gemini', buckets: [{ bucket_id: 'g5', window: '5h', remaining_fraction: 0.35, remaining_fraction_known: true, reset_time: new Date((nowSec + 3600) * 1000).toISOString() }] }],
      last_updated: nowSec - 1200,
      is_forbidden: false,
      subscription_tier: 'FREE',
      model_forwarding_rules: {},
    };
    await accountsManager.syncRemoteObservedQuota(saved.id, staleQuota, 'FREE');
    await accountsManager.updateAccount(saved.id, current => {
      current.quota_refresh_error = '切换并使用该账号后会自动更新最新额度；未切换前可参考上次记录和倒计时。';
      current.quota_refresh_error_code = 'missing_oauth_client';
    });

    // 1. 更旧的时间戳不得覆盖现有更新鲜快照
    const ignoredOlder = await accountsManager.syncRemoteObservedQuota(saved.id, {
      ...staleQuota,
      last_updated: nowSec - 3600,
    }, 'PRO');
    assert.equal(ignoredOlder?.quota?.last_updated, nowSec - 1200);
    assert.equal(ignoredOlder?.quota_refresh_error_code, 'missing_oauth_client');

    // 2. 通过 refreshStandbyAccountViaRemoteSsh 走在线 SSH 强制探测并同步落盘
    const envId = buildRemoteEnvironmentId('oracle-phx-agy');
    let probeCalledForEnv = '';
    let snapshotPublished = false;
    let currentRemoteQuota = staleQuota;
    let currentObservedAtMs = (nowSec - 1200) * 1000;

    const fresherRemoteQuota = {
      models: [{ name: 'gemini-3.8-flash', percentage: 97, percentage_known: true, reset_time: new Date((nowSec + 7200) * 1000).toISOString() }],
      quota_groups: [{ display_name: 'Gemini', buckets: [{ bucket_id: 'g5', window: '5h', remaining_fraction: 0.97, remaining_fraction_known: true, reset_time: new Date((nowSec + 7200) * 1000).toISOString() }] }],
      last_updated: nowSec - 2,
      is_forbidden: false,
      subscription_tier: 'PRO',
      model_forwarding_rules: {},
    };

    const res = await refreshStandbyAccountViaRemoteSsh({
      targetAcc: await accountsManager.getAccount(saved.id),
      targetIsLocalActive: false,
      hasLocalOAuthClient: false,
      nowMs: nowSec * 1000,
      getRemoteSessionsSnapshot: () => [
        {
          remoteKey: 'rk-oracle-1',
          environmentId: envId,
          hostLabel: 'oracle-phx-agy',
          origin: 'http://127.0.0.1:44123',
          targetId: 't-1',
          state: 'connected',
          probing: false,
          email: 'ssh-standby@example.invalid',
          name: 'SSH Standby User',
          tier: 'PRO',
          accountType: 'individual',
          quota: currentRemoteQuota,
          quotaOverview: null,
          observedAt: currentObservedAtMs,
          disconnectedAt: null,
          lastFocusedAt: nowSec * 1000,
          matchedLocalAccountId: saved.id,
          lastError: '',
          needsIdentityVerify: false,
        },
      ],
      probeRemoteByEnvironmentId: async targetEnvId => {
        probeCalledForEnv = targetEnvId;
        currentRemoteQuota = fresherRemoteQuota;
        currentObservedAtMs = (nowSec - 2) * 1000;
      },
      syncRemoteObservedQuota: (accountId, quota, tier) => accountsManager.syncRemoteObservedQuota(accountId, quota, tier),
      getAccount: accountId => accountsManager.getAccount(accountId),
      toRemoteCandidates: sessions => sessions.map(s => ({
        environmentId: s.environmentId,
        email: s.email,
        lifecycleState: 'online',
        quota: s.quota,
        observedAtMs: s.observedAt,
      })),
      getAccountQuotaOverview: (acc) => ({
        fiveHourRemaining: 97,
        weeklyRemaining: null,
        subscriptionTier: acc.quota?.subscription_tier ?? 'PRO',
        models: acc.quota?.models ?? [],
        quotaGroups: acc.quota?.quota_groups ?? [],
        projectedQuotaGroups: [],
        staleGroups: [],
        lastUpdated: acc.quota?.last_updated ?? null,
        isStale: false,
        staleHours: 0,
        familyWindows: null,
        argonStatus: null,
        carbonStatus: null,
        standaloneModels: [],
        refreshState: { complete: true },
        quotaWarnings: [],
        quotaWarningCodes: [],
      }),
      projectAccount: (acc, opts) => ({
        id: acc.id,
        email: acc.email,
        quota: acc.quota,
        subscription_tier: acc.quota?.subscription_tier ?? 'FREE',
        quotaSourceEnvironmentId: opts.quotaSourceEnvironmentId,
        activeRemoteEnvIds: opts.activeRemoteEnvIds,
      }),
      buildEnvironmentSnapshot: () => ({
        remoteSessions: [{ environmentId: envId, state: 'connected' }],
        environments: [{ environmentId: 'local' }, { environmentId: envId }],
        environmentsRevision: 2,
        remoteSyncRevision: 1,
        focusedEnvironmentId: 'local',
      }),
      publishSnapshot: () => { snapshotPublished = true; },
      readOkMessage: '配额已更新',
    });

    assert.equal(probeCalledForEnv, envId);
    assert.equal(snapshotPublished, true);
    assert.ok(res && res.ok === true);
    assert.equal(res.standbyDeferred, undefined, '命中在线 SSH 时不得返回 standbyDeferred');
    assert.equal(res.account.quotaSourceEnvironmentId, envId);
    assert.deepEqual(res.account.activeRemoteEnvIds, [envId]);
    assert.equal(res.subscription_tier, 'PRO');
    assert.equal(res.environmentsRevision, 2);

    // 校验已安全回写本地磁盘，且未改动 token 与用户备注
    const diskAfter = await accountsManager.getAccount(saved.id);
    assert.equal(diskAfter?.quota?.last_updated, nowSec - 2);
    assert.equal(diskAfter?.quota?.models?.[0]?.percentage, 97);
    assert.equal(diskAfter?.quota_refresh_error, null);
    assert.equal(diskAfter?.quota_refresh_error_code, null);
    assert.equal(diskAfter?.custom_label, '用户备注-保留');
    assert.equal(diskAfter?.token?.refresh_token, 'keep-refresh-token-123');

    // 3. 当账号已切换为本机活跃账号时，不得截胡走远端刷新（返回 null 交回本机路径）
    const activeBypass = await refreshStandbyAccountViaRemoteSsh({
      targetAcc: diskAfter,
      targetIsLocalActive: true,
      hasLocalOAuthClient: false,
      getRemoteSessionsSnapshot: () => [],
      probeRemoteByEnvironmentId: async () => { throw new Error('should not probe'); },
      syncRemoteObservedQuota: async () => null,
      getAccount: async () => null,
      toRemoteCandidates: () => [],
      getAccountQuotaOverview: () => ({}),
      projectAccount: a => a,
      buildEnvironmentSnapshot: () => ({ remoteSessions: [], environments: [], environmentsRevision: 0, remoteSyncRevision: 0, focusedEnvironmentId: 'local' }),
      publishSnapshot: () => {},
    });
    assert.equal(activeBypass, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('P1-12: SSH 部分配额（RetrieveUserQuotaSummary 超时/失败）保留本地双桶并标陈旧、不清除刷新告警，完整刷新后再更新', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gb-remote-partial-quota-'));
  try {
    const accountsManager = new AccountsManager(dir);
    await accountsManager.init();
    const nowSec = Math.floor(Date.now() / 1000);
    const future5h = new Date((nowSec + 3600) * 1000).toISOString();
    const futureWeek = new Date((nowSec + 5 * 86400) * 1000).toISOString();
    const acc = await accountsManager.upsertAccount({
      email: 'partial-ssh@example.invalid',
      name: 'Partial SSH',
      refresh_token: '1//partial-refresh',
      access_token: 'ya29.partial',
      expires_in: 3600,
    });
    const fullLocalQuota = {
      models: [{ name: 'gemini-3.8-flash', percentage: 60, percentage_known: true, reset_time: future5h }],
      quota_groups: [{
        display_name: 'Gemini',
        family: 'gemini',
        observed_at: nowSec - 600,
        buckets: [
          { bucket_id: 'g5', window: '5h', remaining_fraction: 0.6, remaining_fraction_known: true, reset_time: future5h, observed_at: nowSec - 600 },
          { bucket_id: 'gw', window: 'weekly', remaining_fraction: 0.85, remaining_fraction_known: true, reset_time: futureWeek, observed_at: nowSec - 600 },
        ],
      }],
      last_updated: nowSec - 600,
      is_forbidden: false,
      subscription_tier: 'PRO',
      model_forwarding_rules: {},
      refresh_state: { complete: true, endpointsAttempted: ['live:GetUserStatus', 'live:RetrieveUserQuotaSummary'], endpointsSucceeded: ['live:GetUserStatus', 'live:RetrieveUserQuotaSummary'], missingFamilies: [], missingWindows: [], carriedGroups: 0, refreshedAt: nowSec - 600 },
    };
    await accountsManager.syncRemoteObservedQuota(acc.id, fullLocalQuota, 'PRO');
    await accountsManager.updateAccount(acc.id, cur => {
      cur.quota_refresh_error = '上次刷新提示：部分超时';
      cur.quota_refresh_error_code = 'network';
    });

    // 1. SSH 仅 GetUserStatus 成功、RetrieveUserQuotaSummary 失败（quota_groups 为空且 complete=false）
    const partialRemoteQuota = {
      models: [{ name: 'gemini-3.8-flash', percentage: 60, percentage_known: true, reset_time: future5h }],
      quota_groups: [],
      last_updated: nowSec,
      is_forbidden: false,
      subscription_tier: 'PRO',
      model_forwarding_rules: {},
      refresh_state: { complete: false, endpointsAttempted: ['remote_rpc:GetUserStatus', 'remote_rpc:RetrieveUserQuotaSummary'], endpointsSucceeded: ['remote_rpc:GetUserStatus'], missingFamilies: ['gemini'], missingWindows: [], carriedGroups: 0, refreshedAt: nowSec, error: 'timeout' },
    };
    const afterPartial = await accountsManager.syncRemoteObservedQuota(acc.id, partialRemoteQuota, 'PRO');
    assert.ok(afterPartial);
    const geminiGroup = afterPartial.quota.quota_groups.find(g => g.family === 'gemini');
    assert.ok(geminiGroup && geminiGroup.buckets.length === 2, '部分失败绝不可将双桶归零');
    assert.equal(geminiGroup.buckets.every(b => b.stale === true), true, '沿用的双桶必须标 stale');
    assert.equal(afterPartial.quota_refresh_error, '上次刷新提示：部分超时', '部分成功绝不可清除已有刷新告警');

    // 2. 随后完整刷新成功，恢复新鲜双桶并清除告警
    const completeRemoteQuota = {
      ...partialRemoteQuota,
      last_updated: nowSec + 5,
      quota_groups: [{
        display_name: 'Gemini',
        family: 'gemini',
        observed_at: nowSec + 5,
        buckets: [
          { bucket_id: 'g5', window: '5h', remaining_fraction: 0.92, remaining_fraction_known: true, reset_time: future5h, observed_at: nowSec + 5 },
          { bucket_id: 'gw', window: 'weekly', remaining_fraction: 0.84, remaining_fraction_known: true, reset_time: futureWeek, observed_at: nowSec + 5 },
        ],
      }],
      refresh_state: { complete: true, endpointsAttempted: ['remote_rpc:GetUserStatus', 'remote_rpc:RetrieveUserQuotaSummary'], endpointsSucceeded: ['remote_rpc:GetUserStatus', 'remote_rpc:RetrieveUserQuotaSummary'], missingFamilies: [], missingWindows: [], carriedGroups: 0, refreshedAt: nowSec + 5 },
    };
    const afterFull = await accountsManager.syncRemoteObservedQuota(acc.id, completeRemoteQuota, 'PRO');
    assert.equal(afterFull?.quota_refresh_error, null);
    assert.equal(afterFull?.quota?.refresh_state?.complete, true);
    const freshGemini = afterFull.quota.quota_groups.find(g => g.family === 'gemini');
    assert.equal(freshGemini.buckets[0].remaining_fraction, 0.92);
    assert.equal(freshGemini.buckets.some(b => b.stale === true), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
