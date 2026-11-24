import test from "node:test";
import { describe as describeContractGroup } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BundleCache } from "../dist/bundle-cache.js";
import { Controller } from "../dist/controller.js";
import { dictionaryFromEntries } from "../dist/dictionary.js";
import { isApplicationRunning } from "../dist/discovery.js";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createConnection } from "node:net";
import { promisify } from "node:util";
import { resolveOpensslBin, sendBackendRpc, stopBackendChild, waitForBackendReady } from "./test-ipc.mjs";

const execFileAsync = promisify(execFile);

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("连接与控制 · evolution", { concurrency: false }, async () => {
test('连接缓存不保留源字符串，同实例复用；文件、进程、版本或来源变化重新计算',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'gravity-cache-'));try{
    const appDir=join(dir,'Antigravity.app');
    await mkdir(join(appDir,'Contents/Resources'),{recursive:true});await writeFile(join(appDir,'Contents/Resources/app.asar'),'first');
    let reads=0;const fetcher=async()=>{await new Promise(r=>setTimeout(r,10));return {hash:`hash-${++reads}`,source:'example',bytes:7};};const cache=new BundleCache();
    const first=await Promise.all([cache.read(appDir,1,'2.23.1','http://127.0.0.1:1',fetcher),cache.read(appDir,1,'2.23.1','http://127.0.0.1:1',fetcher)]);assert.equal(first.filter(r=>!r.cacheHit).length,1);assert.equal(reads,1);
    const hit=await cache.read(appDir,1,'2.23.1','http://127.0.0.1:1',fetcher);assert.equal(hit.source,undefined);assert.equal(reads,1);
    await cache.read(appDir,2,'2.23.1','http://127.0.0.1:1',fetcher);assert.equal(reads,2);
    await cache.read(appDir,2,'2.24.0','http://127.0.0.1:1',fetcher);assert.equal(reads,3);
    await cache.read(appDir,2,'2.24.0','http://127.0.0.1:2',fetcher);assert.equal(reads,4);
    await writeFile(join(appDir,'Contents/Resources/app.asar'),'changed size');await cache.read(appDir,2,'2.24.0','http://127.0.0.1:2',fetcher);assert.equal(reads,5);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('未知指纹仅使用保守页面策略，受验证版本保留完整规则',()=>{
  const c=new Controller({appPath:'/Applications/Antigravity.app',profile:'/tmp/unused',dictionary:dictionaryFromEntries({Settings:'设置'}),onStatus:()=>{}});
  c.status.appVersion='2.23.2';c.status.bundleSha256='new';assert.equal(JSON.parse(c.boot('http://127.0.0.1:1234/').split('\n')[0].split('=')[1].slice(0,-1)).conservative,true);
  c.status.appVersion='2.23.1';c.status.bundleSha256='ad12ecf66061edab6a3835d1360e1bad50787bc7b2f2c9d86568281360864696';assert.match(c.boot('http://127.0.0.1:1234/'),/"conservative":false/);
});
});

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("连接与控制 · optimization-20261022", { concurrency: false }, async () => {
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const fixture=async fn=>{const dir=await mkdtemp(join(tmpdir(),'gb-opt-'));try{return await fn(dir);}finally{await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:50});}};

const stop=(child)=>stopBackendChild(child);
const rpc=(dir,p)=>sendBackendRpc(dir,p);
const ready=(dir)=>waitForBackendReady(dir);

test('已暂停的汉化在重新启动时保持暂停，不为更新自动注入目标应用',()=>fixture(async dir=>{
 await writeFile(join(dir,'runtime-preferences.json'),JSON.stringify({translationEnabled:false,hudEnabled:false}));
 const child=spawn(process.execPath,['dist/main.js','--state-dir',dir,'--app','/nonexistent','--profile',dir,'--home-dir',dir,'--app-support-dir',dir,'--gemini-dir',dir],{stdio:'ignore',env:{...process.env,GRAVITYBOX_PROBE_LS:'false'}});
 try{await ready(dir);let status;for(let i=0;i<100;i++){status=await rpc(dir,{command:'status',includeTasks:false});if(status.status.mode==='paused')break;await pause(20);}assert.equal(status.status.mode,'paused');assert.equal(status.status.windows,0);assert.equal(JSON.parse(await readFile(join(dir,'runtime-preferences.json'),'utf8')).translationEnabled,false);}finally{await stop(child);}
}));

test('P0-01/P1-31：Controller 状态与错误不含未解析 backend 前缀，切语种清空旧错误并串行收敛', async () => {
  const published = [];
  const c = new Controller({
    appPath: '/tmp/gravitybox-nonexistent-app.app',
    profile: '/tmp/gravitybox-nonexistent-profile',
    dictionary: dictionaryFromEntries({ Settings: '设置' }),
    hudEnabled: false,
    locale: 'zh-Hans',
    configuredLanguage: 'zh-Hans',
    onStatus: (s) => published.push(structuredClone(s)),
  });
  try {
    assert.equal(c.status.message.includes('backend.status.'), false);
    assert.notEqual(c.status.message, 'status.starting');
    assert.equal(c.status.locale, 'zh-Hans');

    c.status.errors = ['残留的旧语种错误'];
    await c.setLocale('en', 'en', { hasTargetDictionary: false });
    assert.equal(c.status.locale, 'en');
    assert.equal(c.status.mode, 'paused');
    assert.deepEqual(c.status.errors, []);
    assert.equal(c.status.message.includes('backend.status.'), false);
    assert.notEqual(c.status.message, 'status.paused');
    assert.equal(/[\u3400-\u9fff]/.test(c.status.message), false);

    await Promise.all([
      c.configureShortcut(false),
      c.pause(),
      c.configureHud(false),
      c.setLocale('zh-Hans', 'zh-Hans', { hasTargetDictionary: false }),
      c.setLocale('en', 'en', { hasTargetDictionary: false }),
    ]);
    assert.equal(c.status.locale, 'en');
    assert.equal(c.status.mode, 'paused');
    assert.equal(published.every((s) => !s.message.includes('backend.status.')), true);
  } finally {
    await c.stop();
  }
});
});

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

function createMockCdpBrowserServer(pageUrl, dictVersion) {
  const receivedMethods = [];
  const sockets = new Set();
  const bootedPages = new Set();
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
      res.end(JSON.stringify([
        {
          id: 'page-1',
          type: 'page',
          url: pageUrl,
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/page-1`,
        },
      ]));
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
    socket.on('error', () => {});
    const targetUrl = req.url || '';
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
          if (msg?.method) receivedMethods.push(msg.method);
          if (typeof msg?.id === 'number') {
            let result = {};
            if (msg.method === 'Page.getFrameTree') {
              result = { frameTree: { frame: { id: 'f1', url: pageUrl } } };
            } else if (msg.method === 'Page.createIsolatedWorld') {
              result = { executionContextId: 1 };
            } else if (msg.method === 'Page.addScriptToEvaluateOnNewDocument') {
              result = { identifier: 'reg-1' };
            } else if (msg.method === 'Runtime.evaluate') {
              const expr = String(msg.params?.expression || '');
              if (expr.includes('globalThis.__GRAVITYBOX_BOOT__=')) {
                bootedPages.add(targetUrl);
                result = { result: { type: 'undefined' } };
              } else if (expr.includes('document.querySelector')) {
                result = { result: { type: 'boolean', value: true } };
              } else if (expr === 'globalThis.__GRAVITYBOX_ENGINE_V1__?.state()') {
                result = bootedPages.has(targetUrl)
                  ? { result: { type: 'object', value: { active: true, version: dictVersion, languageMode: 'zh', runtimeId: 'mock' } } }
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
    socket.on('close', () => sockets.delete(socket));
  });
  return {
    server,
    receivedMethods,
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

describeContractGroup("连接与控制 · debug-port-missing", { concurrency: false }, async () => {
  test('isApplicationRunning 拒绝对 Insiders 与无效路径返回 true', async () => {
    assert.equal(await isApplicationRunning(''), false);
    assert.equal(await isApplicationRunning('/Applications/Antigravity - Insiders.app'), false);
    assert.equal(await isApplicationRunning('/tmp/gravitybox-nonexistent-antigravity.app'), false);
  });

  test('未运行时保持 waiting；已运行但无 DevToolsActivePort 时切到 debug-port-missing 并支持中英文与恢复连接', async () => {
    const profileDir = await mkdtemp(join(tmpdir(), 'gb-debug-port-'));
    const fakeAppDir = join(profileDir, 'Antigravity.app');
    await mkdir(join(fakeAppDir, 'Contents/Resources'), { recursive: true });
    await writeFile(join(fakeAppDir, 'Contents/Resources/app.asar'), 'mock-asar');
    const keyPath = join(profileDir, 'mock-key.pem');
    const certPath = join(profileDir, 'mock-cert.pem');
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
    await new Promise((resolve) => httpsServer.listen(0, '127.0.0.1', resolve));
    const httpsPort = httpsServer.address().port;
    const pageUrl = `https://127.0.0.1:${httpsPort}/`;

    const dictionary = dictionaryFromEntries({ Settings: '设置' });
    const mockServer = createMockCdpBrowserServer(pageUrl, dictionary.version);
    await new Promise((resolve) => mockServer.server.listen(0, '127.0.0.1', resolve));
    const port = mockServer.server.address().port;

    let appRunning = false;
    let endpoint = undefined;
    let ctrl;
    try {
      ctrl = new Controller({
        appPath: fakeAppDir,
        profile: profileDir,
        dictionary,
        hudEnabled: true,
        locale: 'zh-Hans',
        configuredLanguage: 'zh-Hans',
        isAppRunning: async () => appRunning,
        discoverEndpoint: async () => endpoint,
        inspectAppBundle: async () => ({ version: '2.33.0', legacyPatch: false }),
        verifyPage: async () => true,
        onStatus: () => {},
      });

      // 1) 未运行时保持 waiting
      await ctrl.start();
      assert.equal(ctrl.status.mode, 'waiting');
      assert.equal(ctrl.status.message, '等待 Antigravity 打开');

      // 2) 已运行但无 DevToolsActivePort 时进入 debug-port-missing（中文）
      appRunning = true;
      await ctrl.resume();
      assert.equal(ctrl.status.mode, 'debug-port-missing');
      assert.equal(ctrl.status.appVersion, '2.33.0');
      assert.equal(
        ctrl.status.message,
        '检测到 Antigravity 已在运行但未开启调试端口（2.33.0 起默认关闭），请安全重启以恢复汉化与 HUD'
      );

      // 3) 切换英文/暂停汉化（保留 HUD）时维持 debug-port-missing 并切换英文提示
      await ctrl.setLocale('en', 'en', { hasTargetDictionary: false });
      assert.equal(ctrl.status.mode, 'debug-port-missing');
      assert.equal(
        ctrl.status.message,
        'Antigravity is running without a debug port (opt-in since 2.33.0). Safe-relaunch via GravityBox to restore localization & HUD'
      );

      // 4) 切换回中文并验证 pause() 不覆盖 debug-port-missing
      await ctrl.setLocale('zh-Hans', 'zh-Hans', { hasTargetDictionary: true });
      assert.equal(ctrl.status.mode, 'debug-port-missing');
      assert.match(ctrl.status.message, /未开启调试端口/);
      await ctrl.pause();
      assert.equal(ctrl.status.mode, 'debug-port-missing');
      await ctrl.resume();
      assert.equal(ctrl.status.mode, 'debug-port-missing');

      // 5) 模拟安全重启后写入 DevToolsActivePort 并提供真实 CDP 端点，验证自动恢复连接
      endpoint = {
        port,
        pid: process.pid,
        browserURL: `ws://127.0.0.1:${port}/devtools/browser/mock`,
        appVersion: '2.33.0',
        legacyPatch: false,
      };
      await writeFile(join(profileDir, 'DevToolsActivePort'), `${port}\n/devtools/browser/mock\n`);
      for (let i = 0; i < 200; i++) {
        if (mockServer.receivedMethods.includes('Target.setDiscoverTargets') && ctrl.status.windows === 1) break;
        await new Promise((r) => setTimeout(r, 30));
      }
      assert.equal(mockServer.receivedMethods.includes('Target.setDiscoverTargets'), true);
      assert.equal(ctrl.status.windows, 1);
      assert.equal(['connected', 'adaptive'].includes(ctrl.status.mode), true);
    } finally {
      await ctrl?.stop();
      await mockServer.close();
      await new Promise((resolve) => httpsServer.close(() => resolve()));
      await rm(profileDir, { recursive: true, force: true });
    }
  });

  test('hasRunningAgentTask 返回 checked 标记，仅认准真实生成/流式信号并排除弹窗 Cancel、后台行 Stop 与残留 codicon-loading', async () => {
    const ctrl = new Controller({
      appPath: '/Applications/Antigravity.app',
      profile: '/tmp/unused',
      dictionary: dictionaryFromEntries({ Settings: '设置' }),
      hudEnabled: false,
      onStatus: () => {},
    });
    // 无已连接页面时返回 { busy: false, checked: false }
    const noPageRes = await ctrl.hasRunningAgentTask();
    assert.deepEqual(noPageRes, { busy: false, checked: false });

    let evaluatedExpr = '';
    ctrl.pages.set('mock-page', {
      targetId: 'mock-page',
      contextId: 1,
      cdp: {
        evaluate: async (expr) => {
          evaluatedExpr = expr;
          return { busy: false, checked: true };
        },
      },
    });
    const idleRes = await ctrl.hasRunningAgentTask();
    assert.deepEqual(idleRes, { busy: false, checked: true });
    assert.equal(evaluatedExpr.includes('.codicon-loading'), false, '不得再将历史残留 .codicon-loading 判为运行中');
    assert.equal(evaluatedExpr.includes('input-cancel-button'), true, '必须认准输入框取消按钮 input-cancel-button');
    assert.equal(evaluatedExpr.includes('running-row'), true, '必须排除后台任务行 running-row 中的普通 Stop 按钮');
  });

  test('自适应全量翻译在词典 reload(update) 变更版本号后仍保持全量翻译而不降级为保守模式', async () => {
    const entries = {};
    for (let i = 1; i <= 15; i += 1) entries[`Label ${i}`] = `标签 ${i}`;
    const bundleSource = Array.from({ length: 15 }, (_, i) => `React.createElement("button", null, "Label ${i + 1}")`).join(';\n');

    const ctrl = new Controller({
      appPath: '/Applications/Antigravity.app',
      profile: '/tmp/unused',
      dictionary: { version: 'dict-v1', entries },
      hudEnabled: false,
      onStatus: () => {},
    });
    ctrl.verifiedBundle = () => false;
    ctrl.refreshRegistration = async () => {};
    let dictVersion = 'dict-v1';
    let lastBootSource = '';
    let updateCalls = 0;
    const mockSession = {
      targetId: 'page-1',
      url: 'https://127.0.0.1:9000/c/_new',
      contextId: 42,
      domContractPassed: true,
      bootedConservative: false,
      bundleSha256: 'adaptive-sha-1',
      updateChain: Promise.resolve(),
      cdp: {
        evaluate: async (expr) => {
          if (typeof expr === 'string') {
            if (expr.includes('document.querySelector')) return true;
            if (expr.includes('__GRAVITYBOX_ENGINE_V1__?.state()')) {
              return { active: true, runtimeId: ctrl.runtimeId, version: dictVersion, languageMode: 'zh' };
            }
            if (expr.includes('__GRAVITYBOX_ENGINE_V1__.update(')) {
              updateCalls += 1;
              dictVersion = 'dict-v2';
            }
            if (expr.includes('__GRAVITYBOX_BOOT__')) {
              lastBootSource = expr;
            }
          }
          return undefined;
        },
        send: async (method, params) => {
          if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'f1', url: 'https://127.0.0.1:9000/c/_new' } } };
          if (method === 'Page.createIsolatedWorld') return { executionContextId: 42 };
          if (method === 'Runtime.evaluate' && typeof params?.expression === 'string') {
            const expr = params.expression;
            if (expr.includes('__GRAVITYBOX_ENGINE_V1__?.state()')) {
              return { result: { value: { active: true, runtimeId: ctrl.runtimeId, version: dictVersion, languageMode: 'zh' } } };
            }
            if (expr.includes('__GRAVITYBOX_ENGINE_V1__.update(')) {
              updateCalls += 1;
              dictVersion = 'dict-v2';
            }
            if (expr.includes('__GRAVITYBOX_BOOT__')) {
              lastBootSource = expr;
            }
          }
          return { result: { value: undefined } };
        },
      },
    };
    ctrl.pages.set('page-1', mockSession);

    await ctrl.inspectBundleInBackground('https://127.0.0.1:9000', '2.34.0', bundleSource);
    const actualSha = ctrl.status.bundleSha256;
    mockSession.bundleSha256 = actualSha;
    assert.equal(ctrl.shouldUseFullTranslation(mockSession), true, '首次自适应分析应开启全量翻译');

    await ctrl.update({ version: 'dict-v2', entries: { ...entries, 'Label Extra': '额外标签' } });
    assert.equal(ctrl.shouldUseFullTranslation(mockSession), true, '词典重载升级版本号后必须继续保持全量翻译');
    assert.equal(mockSession.bootedConservative, false, '重载后不得降级为 conservative 模式');
    assert.equal(updateCalls, 1, '保持全量翻译时应热更新词典而非销毁重建为保守模式');
    assert.equal(lastBootSource, '', '未切换保守模式时不应触发重引导降级');
  });

  test('P1-47: probeRemoteSessions 遇到 RPC 异常时复位 probing 不中断批次；maintenancePreflight 容错已关页', async () => {
    const mockEndpoint = { port: 19222, pid: process.pid, browserURL: 'ws://127.0.0.1:19222', appVersion: '2.34.0', legacyPatch: false };
    const ctrl = new Controller({
      appPath: '/Applications/Antigravity.app',
      profile: '/tmp/gb-p1-47-profile',
      dictionary: dictionaryFromEntries({ Settings: '设置' }),
      discoverEndpoint: async () => mockEndpoint,
      onStatus: () => {},
    });

    let maintenanceEvalCalls = 0;
    const throwingSession = {
      targetId: 'ssh-page-1',
      url: 'https://127.0.0.1:19001/c/_new',
      contextId: 11,
      sourceKind: 'remote',
      remoteKey: 'remote-err-1',
      environmentId: 'ssh:err-host',
      hostLabel: 'err-host',
      detaching: false,
      lastFocusedAt: Date.now(),
      rpcClient: {
        probeUserAndQuota: async () => {
          throw new Error('synthetic rpc transport crash');
        },
      },
      cdp: {
        evaluate: async (expr) => {
          if (String(expr).includes('maintenanceState')) {
            maintenanceEvalCalls += 1;
            throw new Error('target closed');
          }
          return { busy: false, checked: true };
        },
      },
    };
    ctrl.pages.set('ssh-page-1', throwingSession);

    const snapshots = await ctrl.probeRemoteSessions({ force: true });
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].probing, false, 'RPC 抛错后 probing 必须复位为 false');
    assert.equal(snapshots[0].lastError, 'rpc_error');

    // maintenancePreflight: 真正进入逐页 maintenanceState 校验并容错已关闭页面抛错
    ctrl.endpoint = mockEndpoint;
    const preflight = await ctrl.maintenancePreflight();
    assert.equal(preflight.ok, true);
    assert.equal(preflight.pid, process.pid);
    assert.equal(maintenanceEvalCalls, 1, '必须实际调用 maintenanceState 并容错抛错');
  });
});

