import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { antigravityLayout } from '../dist/platform/index.js';
const OPENSSL_BIN = process.platform === 'win32'
  ? (process.env.OPENSSL_BIN || (existsSync('C:\\Program Files\\Git\\usr\\bin\\openssl.exe') ? 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe' : 'openssl'))
  : '/usr/bin/openssl';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  clearObservedIdeModelsForTest,
  getEffectiveModelDisplayName,
  getEffectiveModelPriceAlias,
  registerObservedIdeModels,
  resetAndRegisterRemoteModelMetadata,
  resolveObservedModelByEnum,
  resolveObservedModelByIdOrAlias,
} from '../dist/model-catalog.js';
import {
  resolveDatabaseModelFullName,
  resolveDynamicOrchestratorModel,
} from '../dist/usage-types.js';
import {
  DEFAULT_API_PRICES,
  canonicalActivePricingKeys,
  matchPricingKeys,
  resolvePricingCatalogSnapshot,
} from '../dist/pricing.js';
import {
  readValidLiveIdeModelsSnapshot,
  sanitizeLiveIdeModelsSnapshot,
} from '../dist/pricing-catalog-runtime.js';
import { resolveLinkedStepTimestamp } from '../dist/usage-scanner.js';
import { UsageStatsManager } from '../dist/usage.js';
import { ProtobufWriter as W } from '../dist/protobuf.js';
import { BundleCache } from '../dist/bundle-cache.js';
import {
  computeBundleDictionaryCoverage,
  extractUiStrings,
  looksLikeNoise,
} from '../dist/bundle.js';
import { Controller } from '../dist/controller.js';
import { dictionaryFromEntries } from '../dist/dictionary.js';

const execFileAsync = promisify(execFile);

test('ObservedIdeModelEntry 动态注册表：M532/1532 自动推导、多键检索与优先级（remote > observed > static）', (t) => {
  t.after(() => {
    clearObservedIdeModelsForTest();
    resetAndRegisterRemoteModelMetadata({});
  });
  clearObservedIdeModelsForTest();
  resetAndRegisterRemoteModelMetadata({});

  registerObservedIdeModels([
    {
      modelId: 'gemini-4-neon-high',
      displayName: 'Gemini 4 Neon (High)',
      modelOrAlias: 'MODEL_PLACEHOLDER_M532',
      maxTokens: 1_048_576,
      maxOutputTokens: 65_536,
      modelProvider: 'MODEL_PROVIDER_GOOGLE',
      inModelSelector: true,
    },
    {
      modelId: 'gemini-5-aurora-xhigh',
      displayName: 'Gemini 5 Aurora (XHigh)',
      modelOrAlias: 'MODEL_PLACEHOLDER_M712',
      maxTokens: 1_000_000,
      modelProvider: 'MODEL_PROVIDER_GOOGLE',
      inModelSelector: true,
    },
  ]);

  const byEnum = resolveObservedModelByEnum(1532);
  assert.ok(byEnum);
  assert.equal(byEnum.modelId, 'gemini-4-neon-high');
  assert.equal(byEnum.modelEnum, 1532);
  assert.equal(byEnum.displayName, 'Gemini 4 Neon (High)');
  assert.equal(byEnum.maxTokens, 1_048_576);
  assert.equal(byEnum.maxOutputTokens, 65_536);

  const byAlias = resolveObservedModelByIdOrAlias('MODEL_PLACEHOLDER_M532');
  assert.equal(byAlias?.modelId, 'gemini-4-neon-high');
  assert.equal(resolveObservedModelByIdOrAlias('gemini-4-neon')?.modelId, 'gemini-4-neon-high');
  assert.equal(resolveObservedModelByIdOrAlias('Gemini 4 Neon (High)')?.modelEnum, 1532);

  // 新未知模型自动别名与展示名
  assert.equal(getEffectiveModelPriceAlias('MODEL_PLACEHOLDER_M712'), 'gemini-5-aurora');
  assert.equal(getEffectiveModelDisplayName('gemini-5-aurora'), 'Gemini 5 Aurora');
  assert.equal(resolveDatabaseModelFullName('MODEL_PLACEHOLDER_M712', null, 1712), 'gemini-5-aurora');
  assert.equal(resolveDatabaseModelFullName('', '', 1532), 'gemini-4-neon');

  // 远端 pricing-feed 优先级高于 live observed
  resetAndRegisterRemoteModelMetadata({
    aliases: { MODEL_PLACEHOLDER_M712: 'gemini-5-aurora-remote' },
    models: { 'gemini-5-aurora': { displayName: 'Gemini 5 Aurora Remote' } },
  });
  assert.equal(getEffectiveModelPriceAlias('MODEL_PLACEHOLDER_M712'), 'gemini-5-aurora-remote');
  assert.equal(getEffectiveModelDisplayName('gemini-5-aurora'), 'Gemini 5 Aurora Remote');
});

test('Orchestrator 与 gemini-flash-worker-agy 归因修复：动态解析任意底层模型且不伪造 gemini-4-opus', (t) => {
  t.after(() => {
    clearObservedIdeModelsForTest();
  });
  clearObservedIdeModelsForTest();

  // 1. gemini-flash-worker-agy / modelEnum=1669
  assert.equal(
    resolveDatabaseModelFullName('gemini-flash-worker-agy', 'Gemini 4 Hydrogen (Orchestrator)', 1669),
    'gemini-4-hydrogen'
  );
  assert.equal(
    resolveDatabaseModelFullName('gemini-flash-worker-agy', 'Gemini 4 Neon (Orchestrator)', 1669),
    'gemini-4-neon'
  );
  assert.equal(
    resolveDatabaseModelFullName('gemini-flash-worker-agy', 'Claude Sonnet 5.5 (Orchestrator)', 1669),
    'claude-sonnet-5-5'
  );
  assert.equal(
    resolveDatabaseModelFullName('gemini-flash-worker-agy', 'Gemini 5 Nova (Orchestrator)', 1669),
    'gemini-5-nova'
  );
  assert.equal(
    resolveDatabaseModelFullName('gemini-flash-worker-agy', 'Gemini Flash', 1669),
    'gemini-3.8-flash'
  );
  assert.equal(
    resolveDatabaseModelFullName('gemini-flash-worker-agy', null, 1669),
    'gemini-3.8-flash'
  );

  // 2. gemini-pro-orchestrator* 支持三种格式，不盲归 gemini-4-argon，绝不伪造 gemini-4-opus
  assert.equal(
    resolveDatabaseModelFullName('gemini-pro-orchestrator', 'Orchestrator Gemini 4 Neon High'),
    'gemini-4-neon'
  );
  assert.equal(
    resolveDatabaseModelFullName('gemini-pro-orchestrator', 'Gemini 4 Neon (Orchestrator)'),
    'gemini-4-neon'
  );
  assert.equal(
    resolveDatabaseModelFullName('gemini-pro-orchestrator', 'Orchestrator Claude Opus 5.5 Medium'),
    'claude-opus-5-5'
  );
  assert.equal(
    resolveDatabaseModelFullName('', 'Orchestrator Claude Opus 5.5 Medium'),
    'claude-opus-5-5'
  );
  assert.equal(resolveDynamicOrchestratorModel('', 'Orchestrator (Opus)'), null);
  assert.equal(resolveDynamicOrchestratorModel('Orchestrator (Opus)', ''), null);
  const unknownOpusOrch = resolveDatabaseModelFullName('gemini-pro-orchestrator', 'Orchestrator (Opus)');
  assert.notEqual(unknownOpusOrch, 'gemini-4-opus');
  assert.notEqual(unknownOpusOrch, 'gemini-4-argon');

  // 3. 当 observed registry 将 gemini-pro-orchestrator (M667) 标记为 Carbon 时，无标签调用也优先归因 Carbon
  registerObservedIdeModels([
    {
      modelId: 'gemini-pro-orchestrator',
      displayName: 'Orchestrator (Carbon)',
      modelOrAlias: 'MODEL_PLACEHOLDER_M667',
    },
  ]);
  assert.equal(resolveDatabaseModelFullName('gemini-pro-orchestrator', null, 1667), 'gemini-4-carbon');
  assert.equal(resolveDatabaseModelFullName('gemini-pro-orchestrator', null), 'gemini-4-carbon');
});

test('pricing.ts 上游元数据过滤 + -tiered 活跃不误杀 + -extra 折叠', () => {
  // 1. 上游权威元数据拦截内部/弃用/非选择器模型（如 gemini-4-hydrogen-sonar）
  const snap = resolvePricingCatalogSnapshot({
    rawPricingTable: DEFAULT_API_PRICES,
    live: {
      tier: 'ULTRA',
      models: [
        { model_id: 'gemini-4-neon-tiered-high', display_name: 'Gemini 4 Neon (High)', disabled: false, quota_source: 'live', in_model_selector: true },
        { model_id: 'gemini-4-hydrogen-sonar', display_name: null, disabled: false, quota_source: 'live', is_internal: true, in_model_selector: false },
        { model_id: 'gemini-4-secret-nonselector', display_name: null, disabled: false, quota_source: 'live', in_model_selector: false },
        { model_id: 'gemini-4-old-deprecated', display_name: 'Gemini 4 Old', disabled: false, quota_source: 'live', deprecated: true },
        { model_id: 'gemini-4-audio-specialized', display_name: 'Gemini 4 Audio', disabled: false, quota_source: 'live', non_chat_specialized: true },
        { model_id: 'gemini-5-vega-high', display_name: 'Gemini 5 Vega (High)', disabled: false, quota_source: 'live', in_model_selector: true },
        { model_id: 'gemini-5-vega-extra', display_name: 'Gemini 5 Vega (Extra)', disabled: false, quota_source: 'live', in_model_selector: true },
        { model_id: 'gemini-5-vega-tiered-xhigh', display_name: 'Gemini 5 Vega (XHigh)', disabled: false, quota_source: 'live', in_model_selector: true },
      ],
    },
  });

  // gemini-4-neon-tiered-high 必须激活 gemini-4-neon，不能被 isInternalNonChatModelId 误杀
  assert.ok(snap.prices['gemini-4-neon'], '仅通过 -tiered-* 下发的活跃模型必须保留');
  assert.equal(snap.modelCatalogState['gemini-4-neon']?.availability, 'available');

  // 所有内部/弃用/非选择器模型均不得泄漏到 unpricedLiveModels
  assert.deepEqual(snap.unpricedLiveModels, [
    {
      key: 'gemini-5-vega',
      displayName: 'Gemini 5 Vega',
      disabled: false,
      variants: ['High', 'XHigh', 'Extra'],
    },
  ]);

  // 2. canonicalActivePricingKeys 检查解别名后的 active key，放行 -tiered 变体，继续拦截 -trial
  const activeTiered = canonicalActivePricingKeys(['gemini-4-neon-tiered-high', 'gemini-4-argon-trial']);
  assert.deepEqual([...activeTiered], ['gemini-4-neon']);

  // 3. matchPricingKeys 自动剥离未来模型的 -tiered-* 后缀，无需手写 7 条别名
  assert.equal(matchPricingKeys('gemini-5-vega-tiered-high', ['gemini-5-vega']), 'gemini-5-vega');
  assert.equal(matchPricingKeys('gemini-5-vega-tiered-extra', ['gemini-5-vega']), 'gemini-5-vega');
  assert.equal(matchPricingKeys('gemini-5-vega-tiered', ['gemini-5-vega']), 'gemini-5-vega');
});

test('live-ide-models.json schema 2 持久化扩展字段并保持 v1 读取兼容', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gb-live-models-v2-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const snap = sanitizeLiveIdeModelsSnapshot(
    {
      tier: 'ULTRA',
      quota: {
        last_updated: 1790000000,
        is_forbidden: false,
        subscription_tier: 'ULTRA',
        model_forwarding_rules: {},
        models: [
          {
            name: 'gemini-4-neon-high',
            model_id: 'gemini-4-neon-high',
            display_name: 'Gemini 4 Neon (High)',
            model_or_alias: 'MODEL_PLACEHOLDER_M532',
            disabled: false,
            max_tokens: 1_048_576,
            max_output_tokens: 65_536,
            model_provider: 'MODEL_PROVIDER_GOOGLE',
            in_model_selector: true,
            percentage: 100,
            reset_time: '',
            quota_source: 'live',
            stale: false,
          },
          {
            name: 'gemini-4-hydrogen-sonar',
            model_id: 'gemini-4-hydrogen-sonar',
            display_name: null,
            model_or_alias: 'MODEL_PLACEHOLDER_M578',
            disabled: false,
            is_internal: true,
            non_chat_specialized: true,
            in_model_selector: false,
            percentage: 100,
            reset_time: '',
            quota_source: 'live',
            stale: false,
          },
        ],
      },
    },
    '2.34.0'
  );
  assert.ok(snap);
  assert.equal(snap.schema, 2);
  assert.equal(snap.models[0].maxTokens, 1_048_576);
  assert.equal(snap.models[0].maxOutputTokens, 65_536);
  assert.equal(snap.models[0].modelProvider, 'MODEL_PROVIDER_GOOGLE');
  assert.equal(snap.models[0].inModelSelector, true);
  assert.equal(snap.models[1].isInternal, true);
  assert.equal(snap.models[1].nonChatSpecialized, true);
  assert.equal(snap.models[1].inModelSelector, false);

  const filePath = join(dir, 'live-ide-models.json');
  await writeFile(filePath, JSON.stringify(snap));
  const readV2 = await readValidLiveIdeModelsSnapshot(filePath, '2.34.0');
  assert.equal(readV2?.schema, 2);
  assert.equal(readV2?.models[0].maxTokens, 1_048_576);
  assert.equal(readV2?.models[1].isInternal, true);
});

test('usage-scanner 时间戳回查回退：支持多步链接与 usage protobuf 字段演进（拒绝错配）', async (t) => {
  const execA = Buffer.from('exec-id-alpha');
  const execB = Buffer.from('exec-id-beta');
  const usageBase = Buffer.concat([
    W.encodeVarintField(1, 1532),
    W.encodeVarintField(2, 2200),
    W.encodeVarintField(3, 800),
    W.encodeVarintField(4, 150),
    W.encodeVarintField(5, 69000),
  ]);
  // 模拟未来 2.35 在 step.metadata.9 中新增字段 f12，导致 raw bytes 不等但四元组一致
  const usageEvolved = Buffer.concat([
    usageBase,
    W.encodeVarintField(12, 999),
  ]);
  const usageDifferentTokens = Buffer.concat([
    W.encodeVarintField(1, 1532),
    W.encodeVarintField(2, 9999),
    W.encodeVarintField(3, 800),
    W.encodeVarintField(4, 150),
    W.encodeVarintField(5, 69000),
  ]);

  // 1) 主路径单步字节全等
  assert.equal(
    resolveLinkedStepTimestamp([{ timestamp: 1790000100, execution: execA, usage: usageBase }], execA, usageBase),
    1790000100
  );
  // 2) 多步链接（含无效 0 时间戳步或非匹配步）唯一命中有效匹配步
  assert.equal(
    resolveLinkedStepTimestamp(
      [
        { timestamp: 0, execution: execA, usage: usageBase },
        { timestamp: 1790000150, execution: execB, usage: usageBase },
        { timestamp: 1790000200, execution: execA, usage: usageBase },
      ],
      execA,
      usageBase
    ),
    1790000200
  );
  // 3) protobuf 字段演进：usage 字节不等但 executionId + 四元组一致
  assert.equal(
    resolveLinkedStepTimestamp([{ timestamp: 1790000300, execution: execA, usage: usageEvolved }], execA, usageBase),
    1790000300
  );
  // 4) 负例：executionId 不等、token 四元组不等或存在歧义双匹配步一律返回 0
  assert.equal(
    resolveLinkedStepTimestamp([{ timestamp: 1790000300, execution: execB, usage: usageEvolved }], execA, usageBase),
    0
  );
  assert.equal(
    resolveLinkedStepTimestamp([{ timestamp: 1790000300, execution: execA, usage: usageDifferentTokens }], execA, usageBase),
    0
  );
  assert.equal(
    resolveLinkedStepTimestamp(
      [
        { timestamp: 1790000300, execution: execA, usage: usageEvolved },
        { timestamp: 1790000305, execution: execA, usage: usageEvolved },
      ],
      execA,
      usageBase
    ),
    0
  );

  // 5) 端到端 SQLite 扫描验证（无内联时间戳 + 演进字段 + 多步链接含非匹配步）
  const dir = await mkdtemp(join(tmpdir(), 'gb-scanner-fallback-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const convDir = join(dir, 'antigravity', 'conversations');
  await mkdir(convDir, { recursive: true });
  const dbPath = join(convDir, 'evolved.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE steps(idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB); CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY, data BLOB);');

  const nowSec = Math.floor(Date.now() / 1000) - 60;
  const stepMeta1 = Buffer.concat([
    W.encodeLengthDelimited(1, W.encodeVarintField(1, nowSec)),
    W.encodeLengthDelimited(9, usageEvolved),
    W.encodeLengthDelimited(12, execA),
  ]);
  const stepMeta2 = Buffer.concat([
    W.encodeLengthDelimited(1, W.encodeVarintField(1, nowSec + 5)),
    W.encodeLengthDelimited(9, usageDifferentTokens),
    W.encodeLengthDelimited(12, execA),
  ]);
  db.prepare('INSERT INTO steps VALUES(?,?,?)').run(10, 15, stepMeta1);
  db.prepare('INSERT INTO steps VALUES(?,?,?)').run(11, 15, stepMeta2);

  const wrapped = Buffer.concat([
    W.encodeVarintField(3, 1532),
    W.encodeLengthDelimited(4, usageBase),
    W.encodeString(19, 'gemini-4-neon'),
  ]);
  // field 2 (step_indices) links both step 10 and 11; field 4 is executionId
  const genBlob = Buffer.concat([
    W.encodeLengthDelimited(1, wrapped),
    W.encodeVarintField(2, 10),
    W.encodeVarintField(2, 11),
    W.encodeLengthDelimited(4, execA),
  ]);
  db.prepare('INSERT INTO gen_metadata VALUES(?,?)').run(0, genBlob);
  db.close();

  const mgr = new UsageStatsManager({ geminiDir: dir, stateDir: dir });
  const scan = await mgr.scanDatabaseEvents(dbPath);
  assert.equal(scan.events.length, 1);
  assert.equal(scan.events[0].timestamp_seconds, nowSec);
});

test('BundleCache.key 包含 Contents/Resources/bin/language_server，噪声过滤拦截 clamp 与 object-cover/block 而不误伤真词条', async (t) => {
  // 1. BundleCache.key() 感知 language_server 变化
  const dir = await mkdtemp(join(tmpdir(), 'gb-cache-ls-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const layout = antigravityLayout(dir);
  await mkdir(dirname(layout.languageServerPath), { recursive: true });
  await writeFile(layout.asarPath, 'same-asar');
  await writeFile(layout.languageServerPath, 'ls-v1');

  let reads = 0;
  const fetcher = async () => ({ hash: `h-${++reads}`, source: 'body', bytes: 4 });
  const cache = new BundleCache();
  await cache.read(dir, 100, '2.34.0', 'https://127.0.0.1:443', fetcher);
  assert.equal(reads, 1);
  // 同文件命中缓存
  await cache.read(dir, 100, '2.34.0', 'https://127.0.0.1:443', fetcher);
  assert.equal(reads, 1);
  // 仅更新 language_server（app.asar 未变）必须使缓存失效
  await writeFile(layout.languageServerPath, 'ls-v2-updated-payload');
  await cache.read(dir, 100, '2.34.0', 'https://127.0.0.1:443', fetcher);
  assert.equal(reads, 2);

  // 2. looksLikeNoise 拦截 2.34.0 新噪声且保留真实英文界面词条
  assert.equal(looksLikeNoise('clamp(72px, calc(32vh - 66px), 264px)'), true);
  assert.equal(looksLikeNoise('block h-full w-full object-cover'), true);
  assert.equal(looksLikeNoise('block object-contain w-full'), true);
  assert.equal(looksLikeNoise('Fold code block'), false);
  assert.equal(looksLikeNoise('Unfold code block'), false);
  assert.equal(looksLikeNoise('Block all browser JavaScript execution.'), false);
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

test('Controller 未收录高覆盖率版本（>=85%）自动启用全量翻译模式，同时保留 unverifiedVersion 与 pending 导出', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gb-adaptive-full-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const fakeAppDir = join(dir, 'Antigravity.app');
  await mkdir(join(fakeAppDir, 'Contents/Resources/bin'), { recursive: true });
  await writeFile(join(fakeAppDir, 'Contents/Resources/app.asar'), 'mock-asar');
  await writeFile(join(fakeAppDir, 'Contents/Resources/bin/language_server'), 'mock-ls');

  const knownStrings = [
    'Settings', 'History', 'Customizations', 'Reasoning effort', 'Orchestrator Settings',
    'Customize Sidebar', 'Workspace', 'Extensions', 'Account', 'Billing',
    'Usage Summary', 'Model Selector', 'Keyboard Shortcuts', 'Appearance', 'Notifications',
    'Privacy Policy', 'Reload Window', 'Open Terminal', 'Check for Updates',
  ];
  const unmappedString = 'Brand New Feature';
  // 19 / 20 = 95% coverage (>= 85% and >= 10 strings)
  const bundleSource = [...knownStrings, unmappedString]
    .map((label, i) => `const item${i} = { label: ${JSON.stringify(label)} };`)
    .join('\n');

  const dictEntries = Object.fromEntries(knownStrings.map((s) => [s, `译:${s}`]));
  const dictionary = dictionaryFromEntries(dictEntries);
  const extracted = extractUiStrings(bundleSource, { includeJsxRuntime: true });
  const cov = computeBundleDictionaryCoverage(extracted, dictionary);
  assert.equal(cov.total, 20);
  assert.equal(cov.matched, 19);
  assert.ok(cov.coverage >= 0.85);

  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  await execFileAsync(OPENSSL_BIN, [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=127.0.0.1',
  ]);
  const [key, cert] = await Promise.all([readFile(keyPath), readFile(certPath)]);
  const httpsServer = createHttpsServer({ key, cert }, (req, res) => {
    if (req.url === '/main.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end(bundleSource);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><html><body></body></html>');
  });
  await new Promise((resolve) => httpsServer.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => httpsServer.close(() => resolve())));
  const pageUrl = `https://127.0.0.1:${httpsServer.address().port}/`;

  const bootConfigs = [];
  const sockets = new Set();
  const cdpServer = createHttpServer((req, res) => {
    const port = cdpServer.address().port;
    if (req.url === '/json/version') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/mock` }));
      return;
    }
    if (req.url === '/json/list') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([
        { id: 'page-1', type: 'page', url: pageUrl, webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/page-1` },
      ]));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  cdpServer.on('upgrade', (req, socket) => {
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sockets.add(socket);
    let buf = Buffer.alloc(0);
    let booted = false;
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 2) {
        const opcode = buf[0] & 0x0f;
        const masked = (buf[1] & 0x80) !== 0;
        let len = buf[1] & 0x7f;
        let offset = 2;
        if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); offset = 4; }
        else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); offset = 10; }
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
            let result = {};
            if (msg.method === 'Page.getFrameTree') {
              result = { frameTree: { frame: { id: 'f1', url: pageUrl } } };
            } else if (msg.method === 'Page.createIsolatedWorld') {
              result = { executionContextId: 1 };
            } else if (msg.method === 'Page.addScriptToEvaluateOnNewDocument') {
              result = { identifier: 'reg-1' };
            } else if (msg.method === 'Runtime.evaluate') {
              const expr = String(msg.params?.expression || '');
              const bootMatch = expr.match(/globalThis\.__GRAVITYBOX_BOOT__=(\{.*?\});/);
              if (bootMatch) {
                booted = true;
                bootConfigs.push(JSON.parse(bootMatch[1]));
                result = { result: { type: 'undefined' } };
              } else if (expr.includes('document.querySelector')) {
                result = { result: { type: 'boolean', value: true } };
              } else if (expr === 'globalThis.__GRAVITYBOX_ENGINE_V1__?.state()') {
                result = booted
                  ? { result: { type: 'object', value: { active: true, version: dictionary.version, languageMode: 'zh', runtimeId: 'mock' } } }
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
  await new Promise((resolve) => cdpServer.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const s of sockets) s.destroy();
    await new Promise((resolve) => cdpServer.close(() => resolve()));
  });
  const cdpPort = cdpServer.address().port;

  const ctrl = new Controller({
    appPath: fakeAppDir,
    profile: dir,
    stateDir: dir,
    dictionary,
    hudEnabled: false,
    discoverEndpoint: async () => ({
      port: cdpPort,
      pid: process.pid,
      browserURL: `ws://127.0.0.1:${cdpPort}/devtools/browser/mock`,
      appVersion: '2.99.0',
      legacyPatch: false,
    }),
    verifyPage: async () => true,
    onStatus: () => {},
  });
  t.after(() => ctrl.stop());

  await ctrl.start();
  // 等待后台 inspectBundleInBackground 完成并自动升级至全量模式 (conservative: false)
  for (let i = 0; i < 100; i++) {
    if (bootConfigs.some((cfg) => cfg.conservative === false) && ctrl.status.pendingListPath) break;
    await new Promise((r) => setTimeout(r, 30));
  }

  assert.equal(ctrl.status.unverifiedVersion, true, '仍必须明确报告 unverifiedVersion: true');
  assert.equal(ctrl.status.newStringsCount, 1);
  assert.ok(ctrl.status.pendingListPath, '仍必须导出 pending-2.99.0.json');
  const pendingJson = JSON.parse(await readFile(ctrl.status.pendingListPath, 'utf8'));
  assert.equal(pendingJson.entries[0].key, unmappedString);
  assert.equal(
    bootConfigs.at(-1)?.conservative,
    false,
    '高覆盖率未收录官方版本通过 DOM 契约后必须自动升级为 conservative: false 全量翻译模式'
  );
});

test('UsageStatsManager 持久化缓存校验拒绝任意 MODEL_PLACEHOLDER_M*，且 ledger worker 同步加载 live-ide-models.json', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gb-cache-placeholder-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const convDir = join(dir, 'antigravity', 'conversations');
  await mkdir(convDir, { recursive: true });
  const dbPath = join(convDir, 'placeholder.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE steps(idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB); CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY, data BLOB);');

  const nowSec = Math.floor(Date.now() / 1000) - 30;
  const usageMsg = Buffer.concat([
    W.encodeVarintField(1, 1532),
    W.encodeVarintField(2, 1000),
    W.encodeVarintField(3, 500),
  ]);
  const timingInner = W.encodeLengthDelimited(4, W.encodeVarintField(1, nowSec));
  const wrapped = Buffer.concat([
    W.encodeVarintField(3, 1532),
    W.encodeLengthDelimited(4, usageMsg),
    W.encodeLengthDelimited(9, timingInner),
    W.encodeString(19, 'MODEL_PLACEHOLDER_M532'),
  ]);
  db.prepare('INSERT INTO gen_metadata VALUES(?,?)').run(0, W.encodeLengthDelimited(1, wrapped));
  db.close();

  // 写入 live-ide-models.json (schema 2) 供主线程与 ledger worker 同步加载
  await writeFile(
    join(dir, 'live-ide-models.json'),
    JSON.stringify({
      schema: 2,
      appVersion: '2.34.0',
      tier: 'ULTRA',
      observedAt: nowSec,
      models: [
        {
          id: 'gemini-4-neon-high',
          displayName: 'Gemini 4 Neon (High)',
          modelOrAlias: 'MODEL_PLACEHOLDER_M532',
          disabled: false,
          maxTokens: 1_048_576,
          inModelSelector: true,
        },
      ],
    })
  );

  // 构造一个被旧未解析 MODEL_PLACEHOLDER_M532 污染的持久化缓存文件，验证启动加载时自动丢弃该条缓存
  const cachePath = join(dir, 'usage-db-cache-v3.json');
  const { statSync } = await import('node:fs');
  const st = statSync(dbPath);
  await writeFile(
    cachePath,
    JSON.stringify({
      version: 3,
      entries: {
        [dbPath]: {
          mtimeMs: st.mtimeMs,
          size: st.size,
          walMtimeMs: 0,
          walSize: 0,
          generationsScanned: 1,
          skippedLargeRecords: 0,
          events: [
            {
              event_key: 'stale-placeholder-key',
              model: 'MODEL_PLACEHOLDER_M532',
              input_tokens: 1000,
              output_tokens: 500,
              cached_tokens: 0,
              total_tokens: 1500,
              timestamp_seconds: nowSec,
            },
          ],
        },
      },
    })
  );

  registerObservedIdeModels([
    {
      modelId: 'gemini-4-neon-high',
      displayName: 'Gemini 4 Neon (High)',
      modelOrAlias: 'MODEL_PLACEHOLDER_M532',
      maxTokens: 1_048_576,
    },
  ]);
  t.after(() => clearObservedIdeModelsForTest());

  const mgr = new UsageStatsManager({ geminiDir: dir, stateDir: dir });
  // 注入自定义 persistCachePath 测试 loadPersistentFileCache 对任意 MODEL_PLACEHOLDER_M* 的拒收
  mgr.persistCachePath = cachePath;
  const summary = await mgr.getUsageSummary(false);
  assert.ok(
    summary.today.by_model.some((m) => m.model === 'gemini-4-neon' && m.priced === true),
    '被污染的 MODEL_PLACEHOLDER_M532 缓存应失效并重扫为已计价的 gemini-4-neon'
  );
  assert.equal(
    summary.today.by_model.some((m) => m.model === 'MODEL_PLACEHOLDER_M532'),
    false
  );
});

test('HUD resolveModelCapacity 对未入库 -tiered-high 动态模型与 enum 归一保持一致', async (t) => {
  const { resolveModelCapacity } = await import('../dist/hud.js');
  registerObservedIdeModels([
    {
      modelId: 'gemini-4-nova-tiered-high',
      displayName: 'Gemini 4 Nova',
      modelOrAlias: 'MODEL_PLACEHOLDER_M901',
      maxTokens: 256_000,
    },
  ]);
  t.after(() => clearObservedIdeModelsForTest());

  const byStr = resolveModelCapacity('gemini-4-nova-tiered-high');
  const byEnum = resolveModelCapacity('MODEL_PLACEHOLDER_M901');
  assert.equal(byStr.modelId, 'gemini-4-nova', '-tiered-high 必须剥离 -tiered 与 -high 归并到基础模型');
  assert.equal(byStr.modelId, byEnum.modelId, '字符串解析与占位符枚举解析必须得出一致 modelId');
  assert.equal(byStr.capacityTokens, 256_000);
});

test('P1-7 #1: extractCatalogModels 在无 agentModelSorts (in_model_selector === undefined) 时保留全新未定价 -tiered 聊天模型并继续拦截内部非聊天模型', () => {
  const snap = resolvePricingCatalogSnapshot({
    rawPricingTable: DEFAULT_API_PRICES,
    live: {
      tier: 'ULTRA',
      models: [
        // 上游未下发 agentModelSorts，in_model_selector 缺失
        { model_id: 'gemini-5-nova-tiered-high', display_name: 'Gemini 5 Nova (High)', disabled: false, quota_source: 'live' },
        { model_id: 'gemini-5-orbit-tiered', display_name: 'Gemini 5 Orbit', disabled: false, quota_source: 'live' },
        // 剥离 -tiered 后仍属于内部非聊天模型 -> 必须继续拦截
        { model_id: 'gemini-5-image-tiered', display_name: 'Gemini 5 Image', disabled: false, quota_source: 'live' },
        { model_id: 'gemini-5-control-tiered', display_name: 'Gemini 5 Control', disabled: false, quota_source: 'live' },
        { model_id: 'gemini-5-exp-ab12-tiered', display_name: 'Gemini 5 Exp', disabled: false, quota_source: 'live' },
        { model_id: 'tiered-high', display_name: 'Tiered High', disabled: false, quota_source: 'live' },
        // 显式被 selector 排除 -> 必须拦截
        { model_id: 'gemini-5-hidden-tiered-high', display_name: 'Gemini 5 Hidden (High)', disabled: false, quota_source: 'live', in_model_selector: false },
      ],
    },
  });

  assert.deepEqual(snap.unpricedLiveModels, [
    {
      key: 'gemini-5-nova',
      displayName: 'Gemini 5 Nova',
      disabled: false,
      variants: ['High'],
    },
    {
      key: 'gemini-5-orbit',
      displayName: 'Gemini 5 Orbit',
      disabled: false,
    },
  ]);
});

test('P1-7 #2: resolveDynamicOrchestratorModel 动态提取最高 Gemini 主版本号替代硬编码 gemini-4-', (t) => {
  t.after(() => {
    clearObservedIdeModelsForTest();
    resetAndRegisterRemoteModelMetadata({});
  });
  clearObservedIdeModelsForTest();
  resetAndRegisterRemoteModelMetadata({});

  // 1. 从 siblingModelIds 提取最高主版本号 5
  assert.equal(
    resolveDynamicOrchestratorModel('gemini-pro-orchestrator-quasar', 'Orchestrator (Quasar)', [
      'gemini-4-neon-high',
      'gemini-5-aurora-high',
    ]),
    'gemini-5-quasar'
  );

  // 2. 从 getEffectiveModelAliasKeys()（含 observed 模型）提取最高主版本号 6
  registerObservedIdeModels([
    {
      modelId: 'gemini-6-orion-high',
      displayName: 'Gemini 6 Orion (High)',
      modelOrAlias: 'MODEL_PLACEHOLDER_M950',
    },
  ]);
  assert.equal(
    resolveDynamicOrchestratorModel('gemini-pro-orchestrator-quasar', 'Orchestrator (Quasar)'),
    'gemini-6-quasar'
  );

  // 3. 当远端与别名仅有 4 代时回退到 4
  clearObservedIdeModelsForTest();
  assert.equal(
    resolveDynamicOrchestratorModel('gemini-pro-orchestrator-quasar', 'Orchestrator (Quasar)'),
    'gemini-4-quasar'
  );
});
