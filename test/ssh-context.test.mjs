import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BundleCache } from '../dist/bundle-cache.js';
import { SUPPORTED_BUNDLES, isSupportedBundleHash } from '../dist/bundle.js';
import { Controller } from '../dist/controller.js';
import { dictionaryFromEntries } from '../dist/dictionary.js';
import { resolveOpensslBin } from './test-ipc.mjs';
import {
  supportsSshRemoteBridge,
  sanitizeHostLabel,
  cleanHostLabel,
  parseSshTunnelProcesses,
  probeMainWorldSshRemote,
  matchMainLogRemotePort,
  verifyRemotePageWindow,
} from '../dist/ssh-context.js';

const execFileAsync = promisify(execFile);

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

function createMultiWindowMockCdpServer(options) {
  const sockets = new Set();
  const bootedByTarget = new Map();
  const evaluatedCalls = [];

  const server = createHttpServer((req, res) => {
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    if (req.url === '/json/version') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/mock` }));
      return;
    }
    if (req.url === '/json/list') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify(
          options.targets().map((t) => ({
            id: t.id,
            type: 'page',
            url: t.url,
            webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${t.id}`,
          }))
        )
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    sockets.add(socket);
    const targetId = String(req.url || '').split('/').pop() || '';
    let buf = Buffer.alloc(0);

    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 2) {
        const opcode = buf[0] & 0x0f;
        const masked = (buf[1] & 0x80) !== 0;
        let len = buf[1] & 0x7f;
        let offset = 2;
        if (len === 126) {
          if (buf.length < 4) break;
          len = buf.readUInt16BE(2);
          offset = 4;
        } else if (len === 127) {
          if (buf.length < 10) break;
          len = Number(buf.readBigUInt64BE(2));
          offset = 10;
        }
        const maskOffset = offset;
        if (masked) offset += 4;
        if (buf.length < offset + len) break;
        const payload = Buffer.from(buf.subarray(offset, offset + len));
        if (masked) {
          const mask = buf.subarray(maskOffset, maskOffset + 4);
          for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        }
        buf = buf.subarray(offset + len);
        if (opcode === 0x8) { socket.end(); break; }
        if (opcode === 0x1) {
          const msg = JSON.parse(payload.toString('utf8'));
          if (typeof msg?.id === 'number') {
            const targetCfg = options.targets().find((t) => t.id === targetId);
            let result = {};
            if (msg.method === 'Target.getTargets') {
              result = {
                targetInfos: options.targets().map((t) => ({
                  targetId: t.id,
                  type: 'page',
                  url: t.url,
                  browserContextId: t.browserContextId,
                })),
              };
            } else if (msg.method === 'Page.getFrameTree') {
              result = { frameTree: { frame: { id: `frame-${targetId}`, url: targetCfg?.url ?? '' } } };
            } else if (msg.method === 'Page.createIsolatedWorld') {
              result = { executionContextId: 100 };
            } else if (msg.method === 'Page.addScriptToEvaluateOnNewDocument') {
              result = { identifier: `reg-${targetId}` };
            } else if (msg.method === 'Runtime.evaluate') {
              const expr = String(msg.params?.expression || '');
              const contextId = msg.params?.contextId;
              evaluatedCalls.push({ targetId, contextId, expr });
              if (contextId === undefined && expr.includes('window.sshRemote')) {
                const probeVal = targetCfg?.mainWorldSshRemote ? targetCfg.mainWorldSshRemote() : { ready: false };
                result = { result: { type: 'object', value: probeVal } };
              } else if (expr.includes("fetch('/main.js'")) {
                const hash = targetCfg?.remoteBundleHash ?? SUPPORTED_BUNDLES.get('2.33.0');
                result = { result: { type: 'object', value: { hash, bytes: 1024 } } };
              } else if (expr.includes('globalThis.__GRAVITYBOX_BOOT__=')) {
                const line = expr.split('\n')[0] || '';
                const jsonStr = line.slice(line.indexOf('globalThis.__GRAVITYBOX_BOOT__=') + 'globalThis.__GRAVITYBOX_BOOT__='.length, -1);
                bootedByTarget.set(targetId, JSON.parse(jsonStr));
                result = { result: { type: 'undefined' } };
              } else if (expr.includes('document.querySelector')) {
                result = { result: { type: 'boolean', value: true } };
              } else if (expr === 'globalThis.__GRAVITYBOX_ENGINE_V1__?.state()') {
                result = bootedByTarget.has(targetId)
                  ? { result: { type: 'object', value: { active: true, version: options.dictVersion, languageMode: 'zh', runtimeId: 'mock' } } }
                  : { result: { type: 'undefined' } };
              } else {
                result = { result: { type: 'undefined' } };
              }
            }
            socket.write(encodeWsTextFrame(JSON.stringify({ id: msg.id, result })));
          }
        }
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });

  return {
    server,
    bootedByTarget,
    evaluatedCalls,
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

test('supportsSshRemoteBridge 严格区分 <2.33.0 与 2.33.0+', () => {
  assert.equal(supportsSshRemoteBridge('2.23.0'), false);
  assert.equal(supportsSshRemoteBridge('2.32.2'), false);
  assert.equal(supportsSshRemoteBridge('2.33.0'), true);
  assert.equal(supportsSshRemoteBridge('2.34.0'), true);
  assert.equal(supportsSshRemoteBridge('fixture'), false);
  assert.equal(supportsSshRemoteBridge(undefined), false);
});

test('sanitizeHostLabel 清理控制字符并限制长度', () => {
  assert.equal(sanitizeHostLabel('  demo-ssh\n\r\t-host  '), 'demo-ssh -host');
  assert.equal(sanitizeHostLabel('\u0000\u001b'), '');
  assert.equal(sanitizeHostLabel('a'.repeat(300)).length, 256);

  assert.equal(cleanHostLabel('SSH: prod-gpu-01'), 'prod-gpu-01');
  assert.equal(cleanHostLabel('SSH · dev-box-02'), 'dev-box-02');
  assert.equal(cleanHostLabel('ssh-demo'), 'ssh-demo');
  assert.equal(cleanHostLabel('demo-ssh-host'), 'demo-ssh-host');
});

test('parseSshTunnelProcesses 仅认准父进程为官方 Antigravity 且带 -D 端口的 ssh 进程', () => {
  const stdout = [
    '  100   1 /Applications/Antigravity.app/Contents/MacOS/Electron',
    '  201 100 /usr/bin/ssh -F /var/folders/xx/agy-ssh-123/config -T -D 127.0.0.1:54321 -- demo-host sh -s',
    '  202 999 /usr/bin/ssh -T -D 127.0.0.1:59999 -- foreign-host sh -s',
    '  203 100 /usr/bin/ssh -T -- demo-host sh -s',
    '  204 100 /opt/custom/ssh -D[::1]:54322 -- ipv6-host sh -s',
  ].join('\n');

  const tunnels = parseSshTunnelProcesses(stdout, 100);
  assert.deepEqual(tunnels, [
    { pid: 201, socksPort: 54321 },
    { pid: 204, socksPort: 54322 },
  ]);
  assert.deepEqual(parseSshTunnelProcesses(stdout, 999), [{ pid: 202, socksPort: 59999 }]);
  assert.deepEqual(parseSshTunnelProcesses(stdout, 0), []);
});

test('probeMainWorldSshRemote 仅在 Main World 执行且不传 contextId', async () => {
  const seenContextIds = [];
  const cdp = {
    async evaluate(_expr, contextId) {
      seenContextIds.push(contextId);
      return { ready: true, kind: 'ssh', currentHost: 'ssh-demo\n\r', connectedCount: 1 };
    },
  };
  const res = await probeMainWorldSshRemote(cdp, 500);
  assert.deepEqual(seenContextIds, [undefined]);
  assert.deepEqual(res, { ready: true, kind: 'ssh', currentHost: 'ssh-demo', connectedCount: 1 });

  const timeoutRes = await probeMainWorldSshRemote(
    { evaluate: () => new Promise(() => {}) },
    30
  );
  assert.deepEqual(timeoutRes, { ready: false });
});

test('matchMainLogRemotePort 读取 main.log 尾部并遵守 sinceMs 时间窗口', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gb-ssh-log-'));
  try {
    const logPath = join(dir, 'main.log');
    const oldTs = '2026-11-19 10:00:00.000';
    const newTs = '2026-11-20 13:50:00.000';
    await writeFile(
      logPath,
      [
        `${oldTs} [info] [SSH] Connected to demo-host at https://127.0.0.1:44001/`,
        `${newTs} [info] [SSH] Connected to demo-host at https://127.0.0.1:44139/`,
      ].join('\n'),
      'utf8'
    );
    const sinceMs = Date.parse('2026-11-20T13:45:00');
    assert.equal(await matchMainLogRemotePort('44139', 'demo-host', { logPath, sinceMs }), true);
    assert.equal(await matchMainLogRemotePort('44001', 'demo-host', { logPath, sinceMs }), false);
    assert.equal(await matchMainLogRemotePort('44139', 'other-host', { logPath, sinceMs }), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('verifyRemotePageWindow 完整覆盖版本、上下文隔离、pending、无隧道与 log 核对', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gb-ssh-verify-'));
  try {
    const logPath = join(dir, 'main.log');
    await writeFile(logPath, '2026-11-20 13:50:00.000 [info] [SSH] Connected to demo-host at https://127.0.0.1:44139/\n');
    const mockPs = async () => ({
      stdout: '  201 100 /usr/bin/ssh -T -D 127.0.0.1:54321 -- demo-host sh -s\n',
    });
    const sshCdp = {
      async evaluate(_expr, ctxId) {
        assert.equal(ctxId, undefined);
        return { ready: true, kind: 'ssh', currentHost: 'demo-host', connectedCount: 1 };
      },
    };

    const oldVer = await verifyRemotePageWindow({
      appVersion: '2.32.2',
      antigravityPid: 100,
      url: 'https://127.0.0.1:44139/',
      cdp: sshCdp,
      deps: { execFile: mockPs, logPath },
    });
    assert.deepEqual(oldVer, { status: 'rejected', reason: 'version_too_old' });

    const sharedCtx = await verifyRemotePageWindow({
      appVersion: '2.33.0',
      antigravityPid: 100,
      url: 'https://127.0.0.1:44139/',
      cdp: sshCdp,
      browserContextId: 'ctx-local',
      localBrowserContextIds: new Set(['ctx-local']),
      deps: { execFile: mockPs, logPath },
    });
    assert.deepEqual(sharedCtx, { status: 'rejected', reason: 'shared_local_context' });

    const pendingRes = await verifyRemotePageWindow({
      appVersion: '2.33.0',
      antigravityPid: 100,
      url: 'https://127.0.0.1:44139/',
      cdp: { async evaluate() { return { ready: false }; } },
      deps: { execFile: mockPs, logPath },
    });
    assert.deepEqual(pendingRes, { status: 'pending', reason: 'bridge_not_ready' });

    const noTunnel = await verifyRemotePageWindow({
      appVersion: '2.33.0',
      antigravityPid: 100,
      url: 'https://127.0.0.1:44139/',
      cdp: sshCdp,
      browserContextId: 'ctx-ssh-1',
      localBrowserContextIds: new Set(['ctx-local']),
      deps: { execFile: async () => ({ stdout: ' 202 999 /usr/bin/ssh -D 127.0.0.1:50000\n' }), logPath },
    });
    assert.deepEqual(noTunnel, { status: 'rejected', reason: 'no_active_ssh_tunnel' });

    const okRes = await verifyRemotePageWindow({
      appVersion: '2.33.0',
      antigravityPid: 100,
      url: 'https://127.0.0.1:44139/c/1234',
      cdp: sshCdp,
      browserContextId: 'ctx-ssh-1',
      localBrowserContextIds: new Set(['ctx-local']),
      deps: { execFile: mockPs, logPath },
    });
    assert.equal(okRes.status, 'verified');
    assert.equal(okRes.identity.kind, 'remote');
    assert.equal(okRes.identity.hostLabel, 'demo-host');
    assert.equal(okRes.identity.origin, 'https://127.0.0.1:44139');
    assert.equal(okRes.identity.verifiedBy, 'process+log');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('BundleCache 按 scopeKey 隔离且容量扩容至 16，多远端不抖动', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gb-bundle-scope-'));
  const appDir = join(dir, 'Test.app');
  try {
    await mkdir(join(appDir, 'Contents/Resources'), { recursive: true });
    await writeFile(join(appDir, 'Contents/Resources/app.asar'), 'asar-bytes');
    let reads = 0;
    const cache = new BundleCache();
    const fetcher = async () => ({ hash: `h-${++reads}`, source: undefined, bytes: 10 });

    await cache.read(appDir, 100, '2.33.0', 'https://127.0.0.1:40001', fetcher, 'local');
    await cache.read(appDir, 100, '2.33.0', 'https://127.0.0.1:40001', fetcher, 'remote-a');
    await cache.read(appDir, 100, '2.33.0', 'https://127.0.0.1:40002', fetcher, 'remote-b');
    await cache.read(appDir, 100, '2.33.0', 'https://127.0.0.1:40003', fetcher, 'remote-c');
    assert.equal(reads, 4);

    // 二次命中全部 4 个源，不应发生淘汰抖动
    const hitLocal = await cache.read(appDir, 100, '2.33.0', 'https://127.0.0.1:40001', fetcher, 'local');
    const hitA = await cache.read(appDir, 100, '2.33.0', 'https://127.0.0.1:40001', fetcher, 'remote-a');
    const hitB = await cache.read(appDir, 100, '2.33.0', 'https://127.0.0.1:40002', fetcher, 'remote-b');
    const hitC = await cache.read(appDir, 100, '2.33.0', 'https://127.0.0.1:40003', fetcher, 'remote-c');
    assert.equal(reads, 4);
    assert.equal(hitLocal.cacheHit && hitA.cacheHit && hitB.cacheHit && hitC.cacheHit, true);
    assert.notEqual(hitLocal.hash, hitA.hash);

    assert.equal(isSupportedBundleHash('2.33.0', SUPPORTED_BUNDLES.get('2.33.0')), true);
    assert.equal(isSupportedBundleHash('2.33.0', '0'.repeat(64)), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Controller 冷启动：SSH 排 index 0 不阻塞本地窗口、延迟桥就绪重试、拒绝本机异源与独立校验隔离', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gb-ctrl-ssh-'));
  const fakeAppDir = join(dir, 'Antigravity.app');
  await mkdir(join(fakeAppDir, 'Contents/Resources'), { recursive: true });
  await writeFile(join(fakeAppDir, 'Contents/Resources/app.asar'), 'mock-asar');

  const keyPath = join(dir, 'k.pem');
  const certPath = join(dir, 'c.pem');
  await execFileAsync(resolveOpensslBin(), [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=127.0.0.1',
  ]);
  const [key, cert] = await Promise.all([readFile(keyPath), readFile(certPath)]);
  const httpsServer = createHttpsServer({ key, cert }, (req, res) => {
    if (req.url === '/main.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end('console.log("Settings");');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><html><body></body></html>');
  });
  await new Promise((r) => httpsServer.listen(0, '127.0.0.1', r));
  const localOriginPort = httpsServer.address().port;

  let sshBridgeReady = false;
  let currentTargets = [];
  const dictionary = dictionaryFromEntries({ Settings: '设置' });
  const mockServer = createMultiWindowMockCdpServer({
    dictVersion: dictionary.version,
    targets: () => currentTargets,
  });
  await new Promise((r) => mockServer.server.listen(0, '127.0.0.1', r));
  const cdpPort = mockServer.server.address().port;

  const localBundleHash = createHash('sha256').update('console.log("Settings");').digest('hex');
  SUPPORTED_BUNDLES.set('2.99.1-test', localBundleHash);

  let ctrl;
  try {
    // 1) SSH 排 index 0（延迟就绪），本地窗排 index 1，Foreign 本机进程排 index 2
    currentTargets = [
      {
        id: 'ssh-page-0',
        url: 'https://127.0.0.1:44139/',
        browserContextId: 'ctx-ssh-1',
        remoteBundleHash: 'f'.repeat(64), // 远端未收录指纹，不得污染本地窗！
        mainWorldSshRemote: () => (sshBridgeReady ? { ready: true, kind: 'ssh', currentHost: 'ssh-demo', connectedCount: 1 } : { ready: false }),
      },
      {
        id: 'local-page-1',
        url: `https://127.0.0.1:${localOriginPort}/`,
        browserContextId: 'ctx-local',
      },
      {
        id: 'foreign-page-2',
        url: 'https://127.0.0.1:49999/',
        browserContextId: 'ctx-foreign',
      },
    ];

    ctrl = new Controller({
      appPath: fakeAppDir,
      profile: dir,
      dictionary,
      hudEnabled: false,
      discoverEndpoint: async () => ({
        port: cdpPort,
        pid: 100,
        browserURL: `ws://127.0.0.1:${cdpPort}/devtools/browser/mock`,
        appVersion: '2.99.1-test',
        legacyPatch: false,
      }),
      inspectPage: async (url) => {
        if (url.includes(`:${localOriginPort}`)) return 'local';
        if (url.includes(':49999')) return 'foreign';
        return 'unlisted';
      },
      verifyRemoteWindow: async ({ url, cdp, browserContextId, localBrowserContextIds }) => {
        assert.equal(localBrowserContextIds.has('ctx-local'), true);
        assert.notEqual(browserContextId, 'ctx-local');
        const probe = await probeMainWorldSshRemote(cdp, 400);
        if (!probe.ready) return { status: 'pending', reason: 'bridge_not_ready' };
        return {
          status: 'verified',
          identity: {
            kind: 'remote',
            remoteKey: 'rk-demo',
            hostLabel: 'ssh-demo',
            origin: new URL(url).origin,
            browserContextId,
            verifiedBy: 'process',
          },
        };
      },
      onStatus: () => {},
    });

    await ctrl.start();

    // 本地窗立即接管，不被排在前面的 SSH 窗口卡死；foreign-page-2 已被拦截
    assert.equal(ctrl.status.windows, 1);
    assert.equal(ctrl.status.sshWindows, 0);
    assert.equal(mockServer.bootedByTarget.get('local-page-1')?.conservative, false);
    assert.equal(mockServer.bootedByTarget.has('foreign-page-2'), false);

    // 2) 模拟 SSH 窗口稍后完成 preload 挂载，下一次同步接管
    sshBridgeReady = true;
    for (let i = 0; i < 30; i++) {
      if (ctrl.status.windows === 2) break;
      await new Promise((r) => setTimeout(r, 120));
    }

    assert.equal(ctrl.status.windows, 2);
    assert.equal(ctrl.status.sshWindows, 1);
    // 远端未命中指纹仅让 SSH 窗降级 conservative: true，本地窗保持 conservative: false，且本地 status.bundleSha256 不被远端覆写
    assert.equal(mockServer.bootedByTarget.get('ssh-page-0')?.conservative, true);
    assert.equal(mockServer.bootedByTarget.get('local-page-1')?.conservative, false);
    assert.equal(ctrl.status.bundleSha256, localBundleHash);
    assert.equal(mockServer.bootedByTarget.has('foreign-page-2'), false);
  } finally {
    SUPPORTED_BUNDLES.delete('2.99.1-test');
    await ctrl?.stop();
    await mockServer.close();
    await new Promise((r) => httpsServer.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  }
});
