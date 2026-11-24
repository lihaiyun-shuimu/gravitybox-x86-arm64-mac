import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { ProtobufWriter } from '../dist/protobuf.js';
import {
  DEFAULT_API_PRICES,
  isInternalNonChatModelId,
  matchPricingKeys,
  normalizeCatalogTierLabel,
  resolvePricingCatalogSnapshot,
} from '../dist/pricing.js';
import {
  ACTIVE_MODEL_KEYS,
  FEED_MODEL_KEYS,
  getEffectiveActiveModelKeys,
  registerRemoteModelMetadata,
  resetAndRegisterRemoteModelMetadata,
  sanitizeRemoteModelMetadata,
} from '../dist/model-catalog.js';
import { UsageStatsManager, resolveDatabaseModelFullName } from '../dist/usage.js';
import { AccountsManager } from '../dist/accounts.js';
import {
  readInstalledAppBundleVersion,
  readValidLiveIdeModelsSnapshot,
  sanitizeLiveIdeModelsSnapshot,
} from '../dist/main.js';
import { sendBackendRpc, stopBackendChild } from './test-ipc.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rpc(directory, payload, timeoutMs = 8000) {
  return sendBackendRpc(directory, payload, { timeoutMs });
}

async function startBackend(directory, appPath) {
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('../dist/main.js', import.meta.url)),
      '--state-dir', directory,
      '--app', appPath,
      '--profile', join(directory, 'profile'),
      '--home-dir', join(directory, 'home'),
      '--app-support-dir', join(directory, 'appsupport'),
      '--gemini-dir', join(directory, 'gemini'),
    ],
    {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, GRAVITYBOX_PROBE_LS: 'false' },
    }
  );
  let stderr = '';
  child.stderr.on('data', (b) => { stderr += String(b); });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await rpc(directory, { command: 'status', includeTasks: false }, 2000);
      if (res.ok) return { child, stderr: () => stderr };
    } catch {}
    await sleep(80);
  }
  child.kill();
  throw new Error(`后台启动超时: ${stderr.slice(0, 400)}`);
}

test('资产与别名映射：ACTIVE_MODEL_KEYS / FEED_MODEL_KEYS 结构不变式，新增 orchestrator-neon/argon 与 M681 别名及内部模型过滤', () => {
  const BASELINE_ACTIVE_MODELS = [
    'gemini-4-carbon',
    'gemini-4-argon',
    'gemini-4-neon',
    'gemini-4-hydrogen',
    'gemini-3.8-flash',
    'claude-opus-5-5',
    'claude-sonnet-5-5',
  ];
  assert.ok(ACTIVE_MODEL_KEYS.length >= BASELINE_ACTIVE_MODELS.length);
  assert.equal(new Set(ACTIVE_MODEL_KEYS).size, ACTIVE_MODEL_KEYS.length, 'ACTIVE_MODEL_KEYS 不得包含重复项');
  assert.equal(new Set(FEED_MODEL_KEYS).size, FEED_MODEL_KEYS.length, 'FEED_MODEL_KEYS 不得包含重复项');
  assert.ok(FEED_MODEL_KEYS.length >= ACTIVE_MODEL_KEYS.length && FEED_MODEL_KEYS.length >= 20);
  assert.equal(ACTIVE_MODEL_KEYS.includes('gpt-oss-120b'), false, '无官方统一来源的 gpt-oss-120b 不得作为默认已定价活跃模型');
  assert.equal(DEFAULT_API_PRICES['gpt-oss-120b'], undefined, 'DEFAULT_API_PRICES 不得包含无来源的 gpt-oss-120b 默认费率');
  for (const baseKey of BASELINE_ACTIVE_MODELS) {
    assert.ok(ACTIVE_MODEL_KEYS.includes(baseKey), `ACTIVE_MODEL_KEYS 必须包含基线模型 ${baseKey}`);
  }
  for (const activeKey of ACTIVE_MODEL_KEYS) {
    assert.ok(FEED_MODEL_KEYS.includes(activeKey), `ACTIVE_MODEL_KEYS 中的 ${activeKey} 必须存在于 FEED_MODEL_KEYS`);
    assert.ok(DEFAULT_API_PRICES[activeKey], `ACTIVE_MODEL_KEYS 中的 ${activeKey} 必须存在定价`);
  }
  for (const feedKey of FEED_MODEL_KEYS) {
    assert.ok(DEFAULT_API_PRICES[feedKey], `FEED_MODEL_KEYS 中的 ${feedKey} 必须存在定价`);
  }
  assert.equal(matchPricingKeys('gemini-pro-orchestrator-argon'), 'gemini-4-argon');
  assert.equal(matchPricingKeys('gemini-pro-orchestrator-neon'), 'gemini-4-neon');
  assert.equal(matchPricingKeys('Orchestrator (Neon)'), 'gemini-4-neon');
  assert.equal(matchPricingKeys('gemini-4-neon-xhigh'), 'gemini-4-neon');
  assert.equal(matchPricingKeys('gemini-4-neon-tiered-high'), 'gemini-4-neon');
  assert.equal(matchPricingKeys('MODEL_PLACEHOLDER_M681'), 'gemini-4-argon');
  assert.equal(matchPricingKeys('gemini-4-hydrogen-tiered-high'), 'gemini-4-hydrogen');
  assert.equal(matchPricingKeys('gemini-4-hydrogen-tiered-xhigh'), 'gemini-4-hydrogen');

  for (const internalId of [
    'chat_20706',
    'tab_flash_lite_preview',
    'gemini-3.1-flash-lite',
    'gemini-3.8-flash-exp-a',
    'gemini-3.7-flash-safety-le',
    'gemini-4-argon-trial',
    'gemini-3.8-flash-control',
    'gemini-3.8-flash-tiered',
    'gemini-4-hydrogen-tiered-high',
    'gemini-4-neon-tiered-high',
    'gemini-2.5-flash-image',
  ]) {
    assert.equal(isInternalNonChatModelId(internalId), true, `${internalId} 必须判定为内部非对话模型`);
  }
  assert.equal(isInternalNonChatModelId('gemini-4-argon'), false);
  assert.equal(isInternalNonChatModelId('gemini-4-neon'), false);
  assert.equal(isInternalNonChatModelId('claude-opus-5-5'), false);

  assert.equal(normalizeCatalogTierLabel('Google AI Ultra'), 'ULTRA');
  assert.equal(normalizeCatalogTierLabel('Enterprise'), 'ENTERPRISE');
  assert.equal(normalizeCatalogTierLabel('Google Workspace Business'), 'TEAM');
  assert.equal(normalizeCatalogTierLabel('Google AI Plus'), 'PLUS');
  assert.equal(normalizeCatalogTierLabel('Google AI Pro'), 'PRO');
  assert.equal(normalizeCatalogTierLabel('Starter'), 'FREE');
  assert.equal(normalizeCatalogTierLabel('unknown-tier'), '');
});

test('Live ULTRA：活跃模型与已下架模型随目录不变式归类 + orchestrator 别名归并，严禁泄露内部实验键', () => {
  const baselineCovered = new Set([
    'gemini-4-carbon',
    'gemini-4-argon',
    'gemini-4-neon',
    'gemini-4-hydrogen',
    'gemini-3.8-flash',
    'claude-opus-5-5',
    'claude-sonnet-5-5',
  ]);
  const extraActiveModels = ACTIVE_MODEL_KEYS.filter((k) => !baselineCovered.has(k)).map((id) => ({
    model_id: id,
    disabled: false,
    quota_source: 'live',
  }));

  const snap = resolvePricingCatalogSnapshot({
    rawPricingTable: DEFAULT_API_PRICES,
    live: {
      tier: 'Google AI Ultra',
      models: [
        { model_id: 'gemini-4-carbon', display_name: 'Gemini 4 Carbon', disabled: false, quota_source: 'live' },
        { model_id: 'gemini-4-argon', display_name: 'Gemini 4 Argon', disabled: false, quota_source: 'live' },
        { model_id: 'gemini-4-neon-high', display_name: 'Gemini 4 Neon', disabled: false, quota_source: 'live' },
        { model_id: 'gemini-4-neon-xhigh', display_name: 'Gemini 4 Neon', disabled: false, quota_source: 'live' },
        { model_id: 'gemini-pro-orchestrator-neon', display_name: 'Orchestrator (Neon)', disabled: false, quota_source: 'live' },
        { model_id: 'gemini-pro-orchestrator-argon', display_name: 'Orchestrator (Argon)', disabled: false, quota_source: 'live' },
        { model_id: 'MODEL_PLACEHOLDER_M681', display_name: 'Orchestrator Placeholder', disabled: false, quota_source: 'live' },
        { model_id: 'gemini-4-hydrogen-xhigh', display_name: 'Gemini 4 Hydrogen', disabled: false, quota_source: 'live' },
        { model_id: 'gemini-3.8-flash', display_name: 'Gemini 3.8 Flash', disabled: false, quota_source: 'live' },
        { model_id: 'claude-opus-5-5-thinking', display_name: 'Claude Opus 5.5', disabled: false, quota_source: 'live' },
        { model_id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5', disabled: false, quota_source: 'live' },
        { model_id: 'gpt-oss-120b', display_name: 'GPT-OSS 120B', disabled: false, quota_source: 'live' },
        ...extraActiveModels,
        { model_id: 'chat_20706', disabled: false, quota_source: 'live' },
        { model_id: 'tab_flash_lite_preview', disabled: false, quota_source: 'live' },
        { model_id: 'gemini-3.8-flash-exp-a', disabled: false, quota_source: 'live' },
        { model_id: 'gemini-3.7-flash-safety-le', disabled: false, quota_source: 'live' },
        { model_id: 'gemini-4-argon-trial', disabled: false, quota_source: 'live' },
      ],
    },
  });

  assert.equal(Object.keys(snap.prices).length, ACTIVE_MODEL_KEYS.length);
  assert.equal(Object.keys(snap.retiredPrices).length, FEED_MODEL_KEYS.length - ACTIVE_MODEL_KEYS.length);
  assert.equal(snap.prices['gpt-oss-120b'], undefined, '无来源 gpt-oss-120b 不得进入已定价集合');
  assert.deepEqual(snap.unpricedLiveModels.map(m => m.key), ['gpt-oss-120b']);
  assert.equal(snap.unpricedLiveModels[0].displayName, 'GPT-OSS 120B');
  for (const activeKey of ACTIVE_MODEL_KEYS) {
    assert.ok(snap.prices[activeKey], `prices 应包含 ${activeKey}`);
    assert.equal(snap.retiredPrices[activeKey], undefined, `retiredPrices 不得重复包含 ${activeKey}`);
    assert.equal(snap.modelCatalogState[activeKey]?.availability, 'available');
    assert.equal(snap.modelCatalogState[activeKey]?.activeTier, 'ULTRA');
  }
  assert.equal(snap.modelCatalogState['gemini-4-argon']?.displayName, 'Gemini 4 Argon');
  assert.equal(snap.modelCatalogState['gemini-4-neon']?.displayName, 'Gemini 4 Neon');

  for (const retiredKey of Object.keys(snap.retiredPrices)) {
    assert.equal(snap.modelCatalogState[retiredKey]?.availability, 'retired');
  }
  for (const forbidden of ['gemini-3.8-flash-exp-a', 'gemini-3.7-flash-safety-le', 'gemini-4-argon-trial', 'chat_20706', 'tab_flash_lite_preview']) {
    assert.equal(snap.prices[forbidden], undefined);
    assert.equal(snap.retiredPrices[forbidden], undefined);
    assert.equal(snap.modelCatalogState[forbidden], undefined);
  }
  const allPriceKeys = [...Object.keys(snap.prices), ...Object.keys(snap.retiredPrices)];
  assert.equal(Object.keys(snap.pricingStatus).length, allPriceKeys.length);
  assert.equal(Object.keys(snap.modelCatalogState).length, allPriceKeys.length + snap.unpricedLiveModels.length);
  assert.equal(snap.pricingStatus['gpt-oss-120b'], undefined);
  assert.equal(snap.modelCatalogState['gpt-oss-120b']?.availability, 'unpriced_live');
});

test('PRO 套餐：gemini-4-carbon-disabled 归类为 tier_locked；account_cloud 缺失活跃模型同样判定 tier_locked', () => {
  const livePro = resolvePricingCatalogSnapshot({
    rawPricingTable: DEFAULT_API_PRICES,
    live: {
      tier: 'PRO',
      models: ACTIVE_MODEL_KEYS.map((id) =>
        id === 'gemini-4-carbon'
          ? { model_id: 'gemini-4-carbon-disabled', display_name: 'Gemini 4 Carbon', disabled: true, quota_source: 'live' }
          : { model_id: id, disabled: false, quota_source: 'live' }
      ),
    },
  });
  assert.equal(Object.keys(livePro.prices).length, ACTIVE_MODEL_KEYS.length);
  assert.equal(livePro.modelCatalogState['gemini-4-carbon']?.availability, 'tier_locked');
  assert.equal(livePro.modelCatalogState['gemini-4-carbon']?.activeTier, 'PRO');
  assert.equal(livePro.modelCatalogState['gemini-4-carbon']?.hostOrder, ACTIVE_MODEL_KEYS.indexOf('gemini-4-carbon'));
  assert.equal(livePro.modelCatalogState['gemini-4-argon']?.availability, 'available');
  assert.equal(livePro.modelCatalogState['gemini-4-argon']?.hostOrder, ACTIVE_MODEL_KEYS.indexOf('gemini-4-argon'));
  assert.equal(livePro.modelCatalogState['gemini-4-neon']?.availability, 'available');
  assert.equal(livePro.modelCatalogState['gemini-4-neon']?.hostOrder, ACTIVE_MODEL_KEYS.indexOf('gemini-4-neon'));

  const cloudPro = resolvePricingCatalogSnapshot({
    rawPricingTable: DEFAULT_API_PRICES,
    activeAccount: {
      source: 'cloud',
      tier: 'Google AI Pro',
      models: ACTIVE_MODEL_KEYS.filter((k) => k !== 'gemini-4-carbon').map((name) => ({
        name,
        disabled: false,
        quota_source: 'cloud',
      })),
    },
  });
  assert.equal(cloudPro.modelCatalogState['gemini-4-carbon']?.availability, 'tier_locked');
  assert.equal(cloudPro.modelCatalogState['gemini-4-carbon']?.activeTier, 'PRO');
  assert.equal(cloudPro.modelCatalogState['gemini-4-carbon']?.hostOrder, undefined);
  assert.equal(cloudPro.modelCatalogState['gemini-4-argon']?.availability, 'available');
  assert.equal(cloudPro.modelCatalogState['gemini-4-neon']?.availability, 'available');
});

test('多账号池：ULTRA 当前 + FREE 备用补充 claude-opus-4-6 / claude-sonnet-4-6 为 other_tier_only 并剔除云端噪声与 carried/stale', () => {
  const snap = resolvePricingCatalogSnapshot({
    rawPricingTable: DEFAULT_API_PRICES,
    live: {
      tier: 'ULTRA',
      models: ACTIVE_MODEL_KEYS.map((id) => ({ model_id: id, disabled: false, quota_source: 'live' })),
    },
    poolAccounts: [
      {
        source: 'cloud',
        tier: 'Free',
        models: [
          { name: 'gemini-3.8-flash', disabled: false, quota_source: 'cloud' },
          { name: 'gemini-4-hydrogen', disabled: false, quota_source: 'cloud' },
          { name: 'claude-opus-4-6', disabled: false, quota_source: 'cloud' },
          { name: 'claude-sonnet-4-6', disabled: false, quota_source: 'cloud' },
          // 云端噪声：同账号已有启用 gemini-* 活跃模型时，gemini-2.5-pro 必须被剔除
          { name: 'gemini-2.5-pro', disabled: false, quota_source: 'cloud' },
          // 内部非对话模型噪声
          { name: 'chat_20706', disabled: false, quota_source: 'cloud' },
          { name: 'tab_flash_lite_preview', disabled: false, quota_source: 'cloud' },
          { name: 'gemini-3.1-flash-lite', disabled: false, quota_source: 'cloud' },
          // stale 与 carried 必须严格跳过
          { name: 'gemini-3.8-pro', disabled: false, stale: true, quota_source: 'cloud' },
          { name: 'claude-3-5-sonnet', disabled: false, quota_source: 'carried' },
        ],
      },
    ],
  });

  const extraRetiredCount = ['claude-opus-4-6', 'claude-sonnet-4-6'].filter((k) => !ACTIVE_MODEL_KEYS.includes(k)).length;
  assert.equal(Object.keys(snap.prices).length, ACTIVE_MODEL_KEYS.length + extraRetiredCount);
  assert.equal(Object.keys(snap.retiredPrices).length, FEED_MODEL_KEYS.length - ACTIVE_MODEL_KEYS.length - extraRetiredCount);
  for (const extra of ['claude-opus-4-6', 'claude-sonnet-4-6']) {
    assert.ok(snap.prices[extra], `${extra} 应通过 FREE 备用池进入 prices`);
    assert.equal(snap.modelCatalogState[extra]?.availability, 'other_tier_only');
    assert.deepEqual(snap.modelCatalogState[extra]?.availableInTiers, ['FREE']);
    assert.equal(snap.modelCatalogState[extra]?.activeTier, 'ULTRA');
    assert.equal(snap.retiredPrices[extra], undefined);
  }
  for (const noise of ['gemini-2.5-pro', 'gemini-3.8-pro', 'claude-3-5-sonnet']) {
    assert.equal(snap.prices[noise], undefined, `噪声/陈旧模型 ${noise} 不得进入 active prices`);
    assert.ok(snap.retiredPrices[noise], `${noise} 应保留在 retiredPrices`);
  }
  for (const internalNoise of ['chat_20706', 'tab_flash_lite_preview', 'gemini-3.1-flash-lite']) {
    assert.equal(snap.prices[internalNoise], undefined);
    assert.equal(snap.retiredPrices[internalNoise], undefined);
  }
});

test('全新未定价实时模型 unpricedLiveModels 与 UsageStatsManager.modelCount 同步计数', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gb-unpriced-live-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const snap = resolvePricingCatalogSnapshot({
    rawPricingTable: DEFAULT_API_PRICES,
    live: {
      tier: 'ULTRA',
      models: [
        ...ACTIVE_MODEL_KEYS.map((id) => ({ model_id: id, disabled: false, quota_source: 'live' })),
        { model_id: 'gemini-5-nova', display_name: 'Gemini 5 Nova', disabled: false, quota_source: 'live' },
        { model_id: 'claude-next-alpha-disabled', display_name: 'Claude Next Alpha', disabled: true, quota_source: 'live' },
      ],
    },
  });

  assert.equal(Object.keys(snap.prices).length, ACTIVE_MODEL_KEYS.length);
  assert.equal(snap.unpricedLiveModels.length, 2);
  assert.deepEqual(snap.unpricedLiveModels, [
    { key: 'gemini-5-nova', displayName: 'Gemini 5 Nova', disabled: false },
    { key: 'claude-next-alpha', displayName: 'Claude Next Alpha', disabled: true },
  ]);
  assert.equal(snap.modelCatalogState['gemini-5-nova']?.availability, 'unpriced_live');
  assert.equal(snap.modelCatalogState['claude-next-alpha']?.availability, 'unpriced_live');
  assert.equal(snap.pricingStatus['gemini-5-nova'], undefined);

  const manager = new UsageStatsManager({ stateDir: dir, geminiDir: join(dir, 'gemini') });
  manager.setActiveOfficialModels(
    Object.keys(snap.prices),
    snap.unpricedLiveModels.map((m) => m.key)
  );
  const status = await manager.getPricingSyncStatus();
  assert.equal(status.modelCount, Object.keys(snap.prices).length + snap.unpricedLiveModels.length);
  assert.equal(status.modelCount, ACTIVE_MODEL_KEYS.length + 2);

  // 未定价新模型同族思考档位 (-low/-medium/-high/-xhigh) 与 Orchestrator 在 live 快照中自动折叠为 1 组且精确计数
  const foldedSnap = resolvePricingCatalogSnapshot({
    rawPricingTable: DEFAULT_API_PRICES,
    live: {
      tier: 'ULTRA',
      models: [
        ...ACTIVE_MODEL_KEYS.map((id) => ({ model_id: id, disabled: false, quota_source: 'live' })),
        { model_id: 'gemini-5-nova-high', display_name: 'Gemini 5 Nova (High)', disabled: false, quota_source: 'live' },
        { model_id: 'gemini-5-nova-xhigh', display_name: 'Gemini 5 Nova (XHigh)', disabled: false, quota_source: 'live' },
        { model_id: 'gemini-5-nova-medium', display_name: 'Gemini 5 Nova (Medium)', disabled: false, quota_source: 'live' },
        { model_id: 'gemini-5-nova-low', display_name: 'Gemini 5 Nova (Low)', disabled: false, quota_source: 'live' },
        { model_id: 'gemini-pro-orchestrator-nova', display_name: 'Orchestrator (Nova)', disabled: false, quota_source: 'live' },
      ],
    },
  });
  assert.deepEqual(foldedSnap.unpricedLiveModels, [
    {
      key: 'gemini-5-nova',
      displayName: 'Gemini 5 Nova',
      disabled: false,
      variants: ['Low', 'Medium', 'High', 'XHigh', 'Orchestrator'],
    },
  ]);
  const foldedMgr = new UsageStatsManager({ stateDir: dir, geminiDir: join(dir, 'gemini') });
  foldedMgr.setActiveOfficialModels(
    Object.keys(foldedSnap.prices),
    foldedSnap.unpricedLiveModels.map((m) => m.key)
  );
  const foldedStatus = await foldedMgr.getPricingSyncStatus();
  assert.equal(foldedStatus.modelCount, ACTIVE_MODEL_KEYS.length + 1);

  // 未登记新代号 Orchestrator 自动归并至同代号基底模型，绝不伪造价格
  assert.equal(resolveDatabaseModelFullName('gemini-pro-orchestrator-krypton', 'Orchestrator (Krypton)'), 'gemini-4-krypton');
  assert.equal(resolveDatabaseModelFullName('gemini-pro-orchestrator-nova', 'Orchestrator (Nova)', undefined, { siblingModelIds: ['gemini-5-nova-high'] }), 'gemini-5-nova');
  assert.equal(matchPricingKeys('gemini-4-krypton'), 'gemini-4-krypton');
});

test('远端缓存与用户自定义价格追踪 publicPricingKeys，同时屏蔽内部实验键', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gb-public-keys-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(
    join(dir, 'remote_pricing.json'),
    JSON.stringify({
      version: 1,
      feedVersion: '2026-11-16',
      prices: {
        'remote-retired-model': { model: 'remote-retired-model', input: 1.1, output: 4.4, cached: 0.11 },
        'gemini-3.8-flash-exp-a': { model: 'gemini-3.8-flash-exp-a', input: 0.75, output: 3.75, cached: 0.075 },
      },
    })
  );

  const manager = new UsageStatsManager({ stateDir: dir, geminiDir: join(dir, 'gemini') });
  await manager.savePricingTable({
    'my-custom-retired': {
      model: 'my-custom-retired',
      input: 2.2,
      output: 8.8,
      cached: 0.22,
      provenance: { verification: 'user' },
    },
    'gemini-4-argon-trial': { model: 'gemini-4-argon-trial', input: 2.0, output: 10.0, cached: 0.1 },
  });

  const { raw, publicKeys } = await manager.getRawPricingCatalog();
  assert.ok(publicKeys.has('remote-retired-model'));
  assert.ok(publicKeys.has('my-custom-retired'));

  const snap = resolvePricingCatalogSnapshot({
    rawPricingTable: raw,
    publicPricingKeys: publicKeys,
  });
  assert.equal(Object.keys(snap.prices).length, ACTIVE_MODEL_KEYS.length);
  assert.ok(snap.retiredPrices['remote-retired-model']);
  assert.ok(snap.retiredPrices['my-custom-retired']);
  assert.equal(snap.pricingStatus['my-custom-retired'], 'user');
  assert.equal(snap.retiredPrices['gemini-3.8-flash-exp-a'], undefined);
  assert.equal(snap.retiredPrices['gemini-4-argon-trial'], undefined);
});

test('live-ide-models.json 脱敏持久化、appVersion 失效判定与 main.js IPC 端到端契约', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gb-catalog-ipc-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  const appDir = join(dir, 'MockAntigravity.app');
  await mkdir(join(appDir, 'Contents'), { recursive: true });
  await mkdir(join(dir, '词典'), { recursive: true });
  await mkdir(join(dir, 'profile'), { recursive: true });
  await mkdir(join(dir, 'home'), { recursive: true });
  await mkdir(join(dir, 'appsupport'), { recursive: true });
  await mkdir(join(dir, 'gemini'), { recursive: true });

  const writePlist = (ver) =>
    writeFile(
      join(appDir, 'Contents', 'Info.plist'),
      `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${ver}</string></dict></plist>`
    );
  await writePlist('2.32.1');
  assert.equal(await readInstalledAppBundleVersion(appDir), '2.32.1');

  // 1) 验证 sanitizeLiveIdeModelsSnapshot 不含 email / name / token 等敏感字段
  const sanitized = sanitizeLiveIdeModelsSnapshot(
    {
      email: 'secret-user@example.invalid',
      name: 'Secret Name',
      tier: 'PRO',
      quota: {
        last_updated: Math.floor(Date.now() / 1000),
        is_forbidden: false,
        subscription_tier: 'PRO',
        model_forwarding_rules: {},
        models: [
          ...ACTIVE_MODEL_KEYS.map((id) =>
            id === 'gemini-4-carbon'
              ? { name: 'gemini-4-carbon-disabled', model_id: 'gemini-4-carbon-disabled', display_name: 'Gemini 4 Carbon', disabled: true, percentage: 0, reset_time: '', quota_source: 'live', stale: false }
              : { name: id, model_id: id, display_name: id, disabled: false, percentage: 100, reset_time: '', quota_source: 'live', stale: false }
          ),
          { name: 'gemini-5-nova', model_id: 'gemini-5-nova', display_name: 'Gemini 5 Nova', model_or_alias: 'MODEL_PLACEHOLDER_M700', disabled: false, percentage: 100, reset_time: '', quota_source: 'live', stale: false },
        ],
      },
    },
    '2.32.1'
  );
  assert.ok(sanitized);
  const serialized = JSON.stringify(sanitized);
  assert.equal(serialized.includes('secret-user@example.invalid'), false);
  assert.equal(serialized.includes('Secret Name'), false);
  assert.equal(sanitized.schema, 2);
  assert.equal(sanitized.appVersion, '2.32.1');
  assert.equal(sanitized.tier, 'PRO');

  const snapshotPath = join(dir, 'live-ide-models.json');
  await writeFile(snapshotPath, serialized);
  assert.ok(await readValidLiveIdeModelsSnapshot(snapshotPath, '2.32.1'));
  assert.equal(await readValidLiveIdeModelsSnapshot(snapshotPath, '2.33.0'), null);
  assert.equal(await readValidLiveIdeModelsSnapshot(snapshotPath, ''), null);
  // 兼容读取旧版 schema 1 快照
  const v1Path = join(dir, 'live-ide-models-v1.json');
  await writeFile(v1Path, JSON.stringify({ ...sanitized, schema: 1 }));
  const v1Read = await readValidLiveIdeModelsSnapshot(v1Path, '2.32.1');
  assert.equal(v1Read?.schema, 1);
  assert.equal(v1Read?.models.length, sanitized.models.length);

  // 2) 配置本地多账号池（ULTRA 主账号 + FREE 备用账号）与本地 mock 价格源
  const accMgr = new AccountsManager(dir);
  const ultraAcc = await accMgr.upsertAccount({
    email: 'ultra@example.invalid',
    refreshToken: 'rt-ultra',
    accessToken: 'at-ultra',
    expiresIn: 3600,
  });
  ultraAcc.quota = {
    source: 'cloud',
    subscription_tier: 'ULTRA',
    last_updated: Math.floor(Date.now() / 1000),
    is_forbidden: false,
    model_forwarding_rules: {},
    models: ACTIVE_MODEL_KEYS.map((id) => ({
      name: id,
      model_id: id,
      percentage: 90,
      reset_time: '',
      disabled: false,
      quota_source: 'cloud',
    })),
  };
  await accMgr.saveAccount(ultraAcc);

  const freeAcc = await accMgr.upsertAccount({
    email: 'free@example.invalid',
    refreshToken: 'rt-free',
    accessToken: 'at-free',
    expiresIn: 3600,
  });
  freeAcc.quota = {
    source: 'cloud',
    subscription_tier: 'FREE',
    last_updated: Math.floor(Date.now() / 1000),
    is_forbidden: false,
    model_forwarding_rules: {},
    models: [
      { name: 'gemini-3.8-flash', model_id: 'gemini-3.8-flash', percentage: 100, reset_time: '', disabled: false, quota_source: 'cloud' },
      { name: 'claude-opus-4-6', model_id: 'claude-opus-4-6', percentage: 100, reset_time: '', disabled: false, quota_source: 'cloud' },
      { name: 'claude-sonnet-4-6', model_id: 'claude-sonnet-4-6', percentage: 100, reset_time: '', disabled: false, quota_source: 'cloud' },
      { name: 'gemini-2.5-pro', model_id: 'gemini-2.5-pro', percentage: 100, reset_time: '', disabled: false, quota_source: 'cloud' },
      { name: 'chat_20706', model_id: 'chat_20706', percentage: 100, reset_time: '', disabled: false, quota_source: 'cloud' },
    ],
  };
  await accMgr.saveAccount(freeAcc);
  await accMgr.setCurrentAccount(ultraAcc.id, 'app');

  const feedServer = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        version: '2026-11-16',
        prices: {
          'gemini-4-carbon': { model: 'gemini-4-carbon', input: 2.0, output: 10.0, cached: 0.1 },
        },
      })
    );
  });
  await new Promise((resolve) => feedServer.listen(0, '127.0.0.1', resolve));
  const port = feedServer.address().port;

  const backend = await startBackend(dir, appDir);
  try {
    const expectedExtra = ['claude-opus-4-6', 'claude-sonnet-4-6'].filter((k) => !ACTIVE_MODEL_KEYS.includes(k)).length;
    // 2a) appVersion=2.32.1 时命中 live-ide-models.json（PRO + gemini-4-carbon tier_locked + gemini-5-nova unpricedLive）
    const resMatch = await rpc(dir, { command: 'api_pricing_get' });
    assert.equal(resMatch.ok, true);
    assert.equal(Object.keys(resMatch.prices).length, ACTIVE_MODEL_KEYS.length + expectedExtra); // 活跃模型 + 备用池 extra
    assert.equal(resMatch.modelCatalogState['gemini-4-carbon']?.availability, 'tier_locked');
    assert.equal(resMatch.modelCatalogState['claude-opus-4-6']?.availability, 'other_tier_only');
    assert.deepEqual(resMatch.modelCatalogState['claude-opus-4-6']?.availableInTiers, ['FREE']);
    assert.equal(resMatch.unpricedLiveModels.length, 1);
    assert.equal(resMatch.unpricedLiveModels[0].key, 'gemini-5-nova');
    assert.equal(resMatch.status.modelCount, Object.keys(resMatch.prices).length + resMatch.unpricedLiveModels.length);
    assert.equal(resMatch.status.modelCount, ACTIVE_MODEL_KEYS.length + expectedExtra + 1);

    // 2b) 模拟 Antigravity 升级至 2.33.0：旧版 2.32.1 快照必须立即失效并回退到当前保存账号 ULTRA + FREE 池
    await writePlist('2.33.0');
    const resUpgraded = await rpc(dir, { command: 'pricing_sync_check', feedUrl: `http://127.0.0.1:${port}/feed.json` });
    assert.equal(resUpgraded.ok, true);
    assert.equal(resUpgraded.synced, true);
    assert.deepEqual(resUpgraded.unpricedLiveModels, []);
    assert.equal(Object.keys(resUpgraded.prices).length, ACTIVE_MODEL_KEYS.length + expectedExtra);
    assert.equal(resUpgraded.modelCatalogState['gemini-4-carbon']?.availability, 'available');
    assert.equal(resUpgraded.modelCatalogState['gemini-4-carbon']?.activeTier, 'ULTRA');
    assert.equal(resUpgraded.modelCatalogState['claude-opus-4-6']?.availability, 'other_tier_only');
    assert.deepEqual(resUpgraded.modelCatalogState['claude-opus-4-6']?.availableInTiers, ['FREE']);
    assert.equal(resUpgraded.prices['gemini-2.5-pro'], undefined);
    assert.ok(resUpgraded.retiredPrices['gemini-2.5-pro']);
    assert.equal(resUpgraded.status.modelCount, ACTIVE_MODEL_KEYS.length + expectedExtra);

    const syncStatusRes = await rpc(dir, { command: 'pricing_sync_status' });
    assert.equal(syncStatusRes.ok, true);
    assert.equal(syncStatusRes.status.modelCount, ACTIVE_MODEL_KEYS.length + expectedExtra);
    assert.equal(backend.stderr(), '');

    await rpc(dir, { command: 'stop' });
    await new Promise((resolve) => {
      if (backend.child.exitCode !== null) resolve();
      else backend.child.once('exit', resolve);
    });
  } finally {
    await stopBackendChild(backend.child);
    await new Promise((resolve) => feedServer.close(resolve));
  }
});

test('sanitizeRemoteModelMetadata 与 registerRemoteModelMetadata 安全校验 activeModels 并在 !onlyNewEntries 时生效', () => {
  const sanitized = sanitizeRemoteModelMetadata({
    activeModels: ['  gemini-4-carbon  ', '__proto__', 'constructor', '', 'x'.repeat(129), 'gemini-4-argon', 'gemini-4-carbon'],
  });
  assert.deepEqual(sanitized.activeModels, ['gemini-4-carbon', 'gemini-4-argon']);

  // onlyNewEntries: true 不得覆盖 activeModels
  registerRemoteModelMetadata({ activeModels: ['gemini-3.8-flash'] }, { onlyNewEntries: true });
  assert.deepEqual([...getEffectiveActiveModelKeys()], [...ACTIVE_MODEL_KEYS]);

  // onlyNewEntries: false 更新 getEffectiveActiveModelKeys()
  registerRemoteModelMetadata({ activeModels: ['gemini-4-carbon', 'gemini-5-aurora'] }, { onlyNewEntries: false });
  assert.deepEqual([...getEffectiveActiveModelKeys()], ['gemini-4-carbon', 'gemini-5-aurora']);
  resetAndRegisterRemoteModelMetadata({});
});

test('P1-1: account_cloud 支持 OpenAI 官方模型族过滤，且远端 activeModels 可显式提升含 lite/exp 后缀的正式模型', (t) => {
  t.after(() => {
    resetAndRegisterRemoteModelMetadata({});
  });

  resetAndRegisterRemoteModelMetadata({
    activeModels: [...ACTIVE_MODEL_KEYS, 'gemini-4.5-flash-lite', 'gpt-5.1-codex'],
    models: {
      'gemini-4.5-flash-lite': { displayName: 'Gemini 4.5 Flash Lite', capacityTokens: 1048576 },
      'gpt-5.1-codex': { displayName: 'GPT-5.1 Codex', capacityTokens: 400000 },
    },
  });

  const customRawPricing = {
    ...DEFAULT_API_PRICES,
    'gemini-4.5-flash-lite': { model: 'gemini-4.5-flash-lite', input: 0.1, output: 0.4, cached: 0.025 },
    'gpt-5.1-codex': { model: 'gpt-5.1-codex', input: 1.5, output: 6.0, cached: 0.375 },
    'gpt-4o': { model: 'gpt-4o', input: 2.5, output: 10.0, cached: 1.25 },
  };

  const snap = resolvePricingCatalogSnapshot({
    rawPricingTable: customRawPricing,
    publicPricingKeys: new Set(['gemini-4.5-flash-lite', 'gpt-5.1-codex', 'gpt-4o']),
    activeAccount: {
      source: 'cloud',
      tier: 'Google AI Ultra',
      models: [
        ...ACTIVE_MODEL_KEYS.map((name) => ({ name, disabled: false, quota_source: 'cloud' })),
        { name: 'gemini-4.5-flash-lite', disabled: false, quota_source: 'cloud' },
        { name: 'gpt-5.1-codex', disabled: false, quota_source: 'cloud' },
        // 同账号已有启用的 OpenAI 活跃模型 gpt-5.1-codex 时，历史 gpt-4o 应归入 retiredPrices 而非混入活跃价格
        { name: 'gpt-4o', disabled: false, quota_source: 'cloud' },
        // 未被列入 activeModels 的内部噪声仍严格屏蔽
        { name: 'tab_flash_lite_preview', disabled: false, quota_source: 'cloud' },
      ],
    },
  });

  assert.ok(snap.prices['gemini-4.5-flash-lite'], '远端显式列入 activeModels 的 flash-lite 正式模型不得被内部正则误杀');
  assert.equal(snap.modelCatalogState['gemini-4.5-flash-lite']?.availability, 'available');
  assert.ok(snap.prices['gpt-5.1-codex'], 'account_cloud 下 OpenAI 官方新模型应正常识别为活跃模型');
  assert.equal(snap.modelCatalogState['gpt-5.1-codex']?.availability, 'available');
  assert.equal(snap.prices['gpt-4o'], undefined, '已有新一代 OpenAI 活跃模型时，旧款 gpt-4o 不得进入活跃列表');
  assert.ok(snap.retiredPrices['gpt-4o'], '旧款已定价 gpt-4o 应保留在 retiredPrices');
  assert.equal(snap.prices['tab_flash_lite_preview'], undefined);
  assert.equal(snap.retiredPrices['tab_flash_lite_preview'], undefined);
});

test('P1-10 & P1-11 & P2-20: 云端新未定价模型透出、IDE 可见 trial/flash-lite 新模型放行与同日热修价格版本比较', async () => {
  const { compareDatedFeedVersion } = await import('../dist/usage-pricing.js');

  // P2-20: 同日修订号自然序比较
  assert.ok(compareDatedFeedVersion('2026-11-16.1', '2026-11-16') > 0);
  assert.ok(compareDatedFeedVersion('2026-11-16-r2', '2026-11-16.1') > 0);
  assert.ok(compareDatedFeedVersion('2026-11-17', '2026-11-16-r9') > 0);
  assert.equal(compareDatedFeedVersion('2026-11-16.2', '2026-11-16-r2'), 0);
  assert.equal(compareDatedFeedVersion('custom-ver', '2026-11-16'), null);

  // P1-10: IDE 未打开时，activeAccount(cloud) 与 poolAccounts(cloud) 发现的全新未定价模型正常进入 unpricedLiveModels
  const cloudNewSnap = resolvePricingCatalogSnapshot({
    rawPricingTable: DEFAULT_API_PRICES,
    activeAccount: {
      source: 'cloud',
      tier: 'Google AI Pro',
      models: [
        ...ACTIVE_MODEL_KEYS.filter(k => k !== 'gemini-4-carbon').map(name => ({ name, disabled: false, quota_source: 'cloud' })),
        { name: 'gemini-5-hyperion', display_name: 'Gemini 5 Hyperion', disabled: false, quota_source: 'cloud' },
      ],
    },
    poolAccounts: [
      {
        source: 'cloud',
        tier: 'Google AI Ultra',
        models: [
          { name: 'claude-opus-6-0', display_name: 'Claude Opus 6.0', disabled: false, quota_source: 'cloud' },
        ],
      },
    ],
  });
  assert.deepEqual(
    cloudNewSnap.unpricedLiveModels.map(m => m.key),
    ['gemini-5-hyperion', 'claude-opus-6-0']
  );
  assert.equal(cloudNewSnap.modelCatalogState['gemini-5-hyperion']?.availability, 'unpriced_live');
  assert.equal(cloudNewSnap.modelCatalogState['claude-opus-6-0']?.availability, 'unpriced_live');

  // P1-11: IDE live 列表中带真实用户可见 display_name 的全新 -trial / flash-lite 对话模型保留，无显示名内部探针仍拦截
  const livePreviewSnap = resolvePricingCatalogSnapshot({
    rawPricingTable: DEFAULT_API_PRICES,
    live: {
      tier: 'ULTRA',
      models: [
        ...ACTIVE_MODEL_KEYS.map(id => ({ model_id: id, display_name: id, disabled: false, quota_source: 'live' })),
        { model_id: 'gemini-5-neon-trial', display_name: 'Gemini 5 Neon (Trial)', disabled: false, quota_source: 'live' },
        { model_id: 'gemini-4.2-flash-lite', display_name: 'Gemini 4.2 Flash Lite', disabled: false, quota_source: 'live' },
        { model_id: 'gemini-4-argon-trial', disabled: false, quota_source: 'live' },
        { model_id: 'tab_flash_lite_preview', display_name: 'Tab Flash Lite', disabled: false, quota_source: 'live' },
      ],
    },
  });
  assert.deepEqual(
    livePreviewSnap.unpricedLiveModels.map(m => m.key),
    ['gemini-5-neon-trial', 'gemini-4.2-flash-lite']
  );
  assert.equal(livePreviewSnap.modelCatalogState['gemini-4-argon-trial'], undefined);
  assert.equal(livePreviewSnap.modelCatalogState['tab_flash_lite_preview'], undefined);
});

test('已定价历史 Flash-Lite（2.5/3.5）在 live 正常计价、在云端残留随活跃 Gemini 折叠进 retiredPrices，同时保留 null display_name 的 unpriced sonar 检测', async () => {
  const { canonicalActivePricingKeys } = await import('../dist/pricing.js');

  // (a) live 中存在 gemini-2.5-flash-lite（含云端误标 display_name）与 gemini-3.5-flash-lite -> 进入 prices 且采用目录标准显示名
  const liveSnap = resolvePricingCatalogSnapshot({
    rawPricingTable: DEFAULT_API_PRICES,
    live: {
      tier: 'ULTRA',
      models: [
        ...ACTIVE_MODEL_KEYS.map((id) => ({ model_id: id, disabled: false, quota_source: 'live' })),
        { model_id: 'gemini-2.5-flash-lite', display_name: 'Gemini 3.5 Flash Lite', disabled: false, quota_source: 'live' },
        { model_id: 'gemini-3.5-flash-lite', display_name: 'Gemini 3.5 Flash Lite', disabled: false, quota_source: 'live' },
        { model_id: 'gemini-3.1-flash-lite', display_name: 'Gemini 3.1 Flash Lite', disabled: false, quota_source: 'live' },
        { model_id: 'tab_flash_lite_preview', display_name: 'Tab Flash Lite', disabled: false, quota_source: 'live' },
        { model_id: 'gemini-4-hydrogen-sonar', display_name: null, disabled: false, quota_source: 'live' },
      ],
    },
  });

  assert.ok(liveSnap.prices['gemini-2.5-flash-lite'], 'live 中已定价 gemini-2.5-flash-lite 应进入 prices');
  assert.ok(liveSnap.prices['gemini-3.5-flash-lite'], 'live 中已定价 gemini-3.5-flash-lite 应进入 prices');
  assert.equal(liveSnap.modelCatalogState['gemini-2.5-flash-lite']?.availability, 'available');
  assert.equal(liveSnap.modelCatalogState['gemini-2.5-flash-lite']?.displayName, 'Gemini 2.5 Flash Lite');
  assert.equal(liveSnap.modelCatalogState['gemini-3.5-flash-lite']?.availability, 'available');
  assert.equal(liveSnap.modelCatalogState['gemini-3.5-flash-lite']?.displayName, 'Gemini 3.5 Flash Lite');
  assert.equal(liveSnap.retiredPrices['gemini-2.5-flash-lite'], undefined);
  assert.equal(liveSnap.retiredPrices['gemini-3.5-flash-lite'], undefined);
  assert.equal(liveSnap.prices['gemini-3.1-flash-lite'], undefined);
  assert.equal(liveSnap.retiredPrices['gemini-3.1-flash-lite'], undefined);
  assert.equal(liveSnap.prices['tab_flash_lite_preview'], undefined);
  assert.deepEqual(liveSnap.unpricedLiveModels, [
    { key: 'gemini-4-hydrogen-sonar', displayName: 'gemini-4-hydrogen-sonar', disabled: false },
  ]);

  const activePricingKeys = canonicalActivePricingKeys(Object.keys(liveSnap.prices), Object.keys(DEFAULT_API_PRICES));
  assert.equal(activePricingKeys.has('gemini-2.5-flash-lite'), true);
  assert.equal(activePricingKeys.has('gemini-3.5-flash-lite'), true);
  assert.equal(activePricingKeys.has('gemini-3.1-flash-lite'), false);
  assert.equal(activePricingKeys.has('tab_flash_lite_preview'), false);

  // (b) & (c) 两者未出现在 IDE live、仅残留在带活跃 Gemini 的 account_cloud 中 -> 折叠入 retiredPrices 且不进 unpricedLiveModels；
  //     未定价的 gemini-4-hydrogen-sonar（display_name: null）继续留在 unpricedLiveModels
  const cloudFoldSnap = resolvePricingCatalogSnapshot({
    rawPricingTable: DEFAULT_API_PRICES,
    live: {
      tier: 'ULTRA',
      models: ACTIVE_MODEL_KEYS.map((id) => ({ model_id: id, disabled: false, quota_source: 'live' })),
    },
    poolAccounts: [
      {
        source: 'cloud',
        tier: 'FREE',
        models: [
          { name: 'gemini-3.8-flash', disabled: false, quota_source: 'cloud' },
          { name: 'gemini-4-hydrogen', disabled: false, quota_source: 'cloud' },
          { name: 'gemini-2.5-flash-lite', display_name: 'Gemini 3.5 Flash Lite', disabled: false, quota_source: 'cloud' },
          { name: 'gemini-3.5-flash-lite', display_name: 'Gemini 3.5 Flash Lite', disabled: false, quota_source: 'cloud' },
          { name: 'gemini-3.1-flash-lite', display_name: 'Gemini 3.1 Flash Lite', disabled: false, quota_source: 'cloud' },
          { name: 'gemini-4-hydrogen-sonar', display_name: null, disabled: false, quota_source: 'cloud' },
        ],
      },
    ],
  });

  assert.equal(cloudFoldSnap.prices['gemini-2.5-flash-lite'], undefined);
  assert.equal(cloudFoldSnap.prices['gemini-3.5-flash-lite'], undefined);
  assert.ok(cloudFoldSnap.retiredPrices['gemini-2.5-flash-lite'], 'cloud 残留已定价 gemini-2.5-flash-lite 应折叠至 retiredPrices');
  assert.ok(cloudFoldSnap.retiredPrices['gemini-3.5-flash-lite'], 'cloud 残留已定价 gemini-3.5-flash-lite 应折叠至 retiredPrices');
  assert.equal(cloudFoldSnap.modelCatalogState['gemini-2.5-flash-lite']?.availability, 'retired');
  assert.equal(cloudFoldSnap.modelCatalogState['gemini-2.5-flash-lite']?.displayName, 'Gemini 2.5 Flash Lite');
  assert.equal(cloudFoldSnap.modelCatalogState['gemini-3.5-flash-lite']?.availability, 'retired');
  assert.equal(cloudFoldSnap.modelCatalogState['gemini-3.5-flash-lite']?.displayName, 'Gemini 3.5 Flash Lite');
  assert.equal(cloudFoldSnap.retiredPrices['gemini-3.1-flash-lite'], undefined);
  assert.equal(cloudFoldSnap.modelCatalogState['gemini-3.1-flash-lite'], undefined);
  assert.deepEqual(cloudFoldSnap.unpricedLiveModels, [
    { key: 'gemini-4-hydrogen-sonar', displayName: 'gemini-4-hydrogen-sonar', disabled: false },
  ]);
  assert.equal(cloudFoldSnap.modelCatalogState['gemini-4-hydrogen-sonar']?.availability, 'unpriced_live');

  // 同步验证 activeAccount 为 account_cloud（含活跃 Gemini 与残留 2.5/3.5 flash-lite）时同样折叠入 retiredPrices
  const activeCloudFoldSnap = resolvePricingCatalogSnapshot({
    rawPricingTable: DEFAULT_API_PRICES,
    activeAccount: {
      source: 'cloud',
      tier: 'Google AI Ultra',
      models: [
        ...ACTIVE_MODEL_KEYS.map((name) => ({ name, disabled: false, quota_source: 'cloud' })),
        { name: 'gemini-2.5-flash-lite', display_name: 'Gemini 3.5 Flash Lite', disabled: false, quota_source: 'cloud' },
        { name: 'gemini-3.5-flash-lite', display_name: 'Gemini 3.5 Flash Lite', disabled: false, quota_source: 'cloud' },
        { name: 'gemini-3.1-flash-lite', display_name: 'Gemini 3.1 Flash Lite', disabled: false, quota_source: 'cloud' },
        { name: 'gemini-4-hydrogen-sonar', display_name: null, disabled: false, quota_source: 'cloud' },
      ],
    },
  });

  assert.equal(activeCloudFoldSnap.prices['gemini-2.5-flash-lite'], undefined);
  assert.equal(activeCloudFoldSnap.prices['gemini-3.5-flash-lite'], undefined);
  assert.ok(activeCloudFoldSnap.retiredPrices['gemini-2.5-flash-lite']);
  assert.ok(activeCloudFoldSnap.retiredPrices['gemini-3.5-flash-lite']);
  assert.equal(activeCloudFoldSnap.modelCatalogState['gemini-2.5-flash-lite']?.displayName, 'Gemini 2.5 Flash Lite');
  assert.equal(activeCloudFoldSnap.modelCatalogState['gemini-3.5-flash-lite']?.displayName, 'Gemini 3.5 Flash Lite');
  assert.equal(activeCloudFoldSnap.retiredPrices['gemini-3.1-flash-lite'], undefined);
  assert.deepEqual(activeCloudFoldSnap.unpricedLiveModels, [
    { key: 'gemini-4-hydrogen-sonar', displayName: 'gemini-4-hydrogen-sonar', disabled: false },
  ]);
});

test('远端完整目录热更新：全权接管公开 feedModels/aliases/activeModels/capacityTokens 并保留内部兜底条目', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gb-remote-takeover-'));
  t.after(async () => {
    resetAndRegisterRemoteModelMetadata({});
    await rm(dir, { recursive: true, force: true });
  });

  const {
    executeRemotePricingSync,
    loadRawPricingTable,
    loadPricingSyncState,
    compareFeedFreshness,
  } = await import('../dist/usage-pricing.js');
  const { getEffectiveFeedModelKeys, getEffectiveModelPriceAlias, getEffectiveModelDisplayName } = await import('../dist/model-catalog.js');
  const { resolveModelCapacity } = await import('../dist/hud.js');

  assert.equal(compareFeedFreshness(
    { version: '2026-11-19-r2', updatedAt: '2026-11-19T08:00:00Z' },
    { version: '2026-11-19-r2', updatedAt: '2026-11-19T05:00:00Z' }
  ), 1);
  assert.equal(compareFeedFreshness(
    { version: '2026-11-19-r2', updatedAt: '2026-11-19T04:00:00Z' },
    { version: '2026-11-19-r2', updatedAt: '2026-11-19T05:00:00Z' }
  ), -1);

  const remoteCachePath = join(dir, 'remote_pricing.json');
  const customCachePath = join(dir, 'api_pricing.json');
  const syncStatePath = join(dir, 'pricing-sync-status.json');

  // 1) 兼容老格式缓存（无 feedModels / feedUpdatedAt / sha256）
  await writeFile(remoteCachePath, JSON.stringify({
    version: 1,
    syncedAt: '2026-11-18T00:00:00Z',
    sourceUrl: 'https://raw.githubusercontent.com/Enzoo404/gravitybox/main/assets/pricing-feed.json',
    feedVersion: '2026-11-18',
    prices: { 'legacy-only-model': { model: 'legacy-only-model', input: 1, output: 2, cached: 0.1 } },
  }));
  await writeFile(syncStatePath, JSON.stringify({
    lastCheckAt: Date.parse('2026-11-18T00:00:00Z'),
    lastCheckSuccess: true,
    lastSyncError: null,
  }));

  const state = {
    lastRemoteSyncAt: 0,
    lastSyncSuccess: false,
    lastCheckAt: 0,
    lastCheckSuccess: false,
    nextAutoSyncAt: 0,
    lastSyncError: null,
    lastSyncedSourceUrl: '',
    lastSyncedVersion: '',
    lastSyncedUpdatedAt: '',
    lastSyncedEtag: '',
    lastSyncedSha256: '',
  };
  await loadPricingSyncState(remoteCachePath, syncStatePath, state);
  assert.equal(state.lastSyncedVersion, '2026-11-18');
  assert.equal(state.lastSyncSuccess, true);

  // 2) 远端全权接管快照：新增 gemini-5-omega、新增别名 M999、移除旧别名 M681、下线公开 gpt-4o-mini
  const feedV2 = {
    version: '2026-11-20',
    schema: 1,
    updatedAt: '2026-11-20T06:00:00Z',
    aliases: {
      'MODEL_PLACEHOLDER_M999': 'gemini-5-omega',
    },
    activeModels: ['gemini-4-carbon', 'gemini-5-omega'],
    feedModels: ['gemini-4-carbon', 'gemini-5-omega', 'gemini-3.8-flash'],
    models: {
      'gemini-4-carbon': { displayName: 'Gemini 4 Carbon', capacityTokens: 200000 },
      'gemini-5-omega': { displayName: 'Gemini 5 Omega', capacityTokens: 512000 },
      'gemini-3.8-flash': { displayName: 'Gemini 3.8 Flash', capacityTokens: 200000 },
    },
    prices: {
      'gemini-4-carbon': { model: 'gemini-4-carbon', input: 2.0, output: 10.0, cached: 0.1 },
      'gemini-5-omega': { model: 'gemini-5-omega', input: 1.8, output: 9.0, cached: 0.18 },
      'gemini-3.8-flash': { model: 'gemini-3.8-flash', input: 0.75, output: 3.75, cached: 0.075 },
    },
  };
  const staleFeedV1 = {
    version: '2026-11-19-r2',
    schema: 1,
    updatedAt: '2026-11-19T05:00:00Z',
    prices: { 'gemini-4-carbon': { model: 'gemini-4-carbon', input: 2.0, output: 10.0, cached: 0.1 } },
  };
  let mode = 'normal';
  let hits = { stale: 0, main: 0, ghApi: 0 };
  const srv = createServer((req, res) => {
    if (req.url === '/stale-cdn') {
      hits.stale += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(staleFeedV1));
      return;
    }
    if (req.url === '/gh-api') {
      hits.ghApi += 1;
      const body = JSON.stringify(feedV2);
      res.writeHead(200, { 'Content-Type': 'application/json', ETag: '"etag-v2"' });
      res.end(JSON.stringify({ encoding: 'base64', content: Buffer.from(body, 'utf8').toString('base64') }));
      return;
    }
    hits.main += 1;
    if (mode === '304' && req.headers['if-none-match'] === '"etag-v2"') {
      res.writeHead(304, { ETag: '"etag-v2"' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json', ETag: '"etag-v2"' });
    res.end(JSON.stringify(feedV2));
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = srv.address().port;

  try {
    // 2a) 先通过 GitHub Contents API base64 包络同步 feedV2
    const sync1 = await executeRemotePricingSync({
      candidateUrls: [`http://127.0.0.1:${port}/gh-api`],
      remotePricingCachePath: remoteCachePath,
      pricingSyncStatePath: syncStatePath,
      state,
      now: Date.parse('2026-11-20T06:10:00Z'),
    });
    assert.equal(sync1.synced, true);
    assert.equal(sync1.unchanged, false);
    assert.equal(sync1.version, '2026-11-20');
    assert.equal(state.lastSyncedEtag, '"etag-v2"');

    // 验证远端全权接管
    assert.deepEqual([...getEffectiveFeedModelKeys()], ['gemini-4-carbon', 'gemini-5-omega', 'gemini-3.8-flash']);
    assert.deepEqual([...getEffectiveActiveModelKeys()], ['gemini-4-carbon', 'gemini-5-omega']);
    assert.equal(getEffectiveModelPriceAlias('MODEL_PLACEHOLDER_M999'), 'gemini-5-omega');
    assert.equal(getEffectiveModelPriceAlias('MODEL_PLACEHOLDER_M681'), undefined, '被远端撤回的内置别名必须失效');
    assert.equal(getEffectiveModelDisplayName('gemini-5-omega'), 'Gemini 5 Omega');
    assert.equal(resolveModelCapacity('MODEL_PLACEHOLDER_M999').capacityTokens, 512000);

    const { merged, billingPrices, publicKeys } = await loadRawPricingTable(remoteCachePath, customCachePath);
    assert.ok(merged['gemini-5-omega']);
    assert.ok(merged['gemini-3.8-flash-control'], '内置内部衍生条目必须继续兜底保留');
    assert.equal(merged['gpt-4o-mini'], undefined, '被远端移除出 feedModels 的旧公开模型应退出公开表');
    assert.ok(billingPrices['gpt-4o-mini'], 'billingPrices 必须保留内置历史定价供未落盘账本回溯计价');
    assert.equal(publicKeys.has('gpt-4o-mini'), false);
    assert.ok(publicKeys.has('gemini-5-omega'));

    const snap = resolvePricingCatalogSnapshot({
      rawPricingTable: merged,
      publicPricingKeys: publicKeys,
    });
    assert.deepEqual(Object.keys(snap.prices).sort(), ['gemini-4-carbon', 'gemini-5-omega']);
    assert.deepEqual(Object.keys(snap.retiredPrices), ['gemini-3.8-flash']);

    // 2b) 命中陈旧 CDN 镜像时应拒绝并自动回退到后续最新源；同时验证 SHA-256 去重返回 unchanged: true
    const sync2 = await executeRemotePricingSync({
      candidateUrls: [`http://127.0.0.1:${port}/stale-cdn`, `http://127.0.0.1:${port}/main`],
      remotePricingCachePath: remoteCachePath,
      pricingSyncStatePath: syncStatePath,
      state,
      now: Date.parse('2026-11-20T07:00:00Z'),
    });
    assert.equal(sync2.synced, true);
    assert.equal(sync2.unchanged, true);
    assert.equal(hits.stale, 1);
    assert.equal(hits.main, 1);

    // 2c) 命中 ETag 304 Not Modified 时直接返回 unchanged: true
    mode = '304';
    const sync3 = await executeRemotePricingSync({
      candidateUrls: [`http://127.0.0.1:${port}/main`],
      remotePricingCachePath: remoteCachePath,
      pricingSyncStatePath: syncStatePath,
      state,
      now: Date.parse('2026-11-20T08:00:00Z'),
    });
    assert.equal(sync3.synced, true);
    assert.equal(sync3.unchanged, true);
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
});

test('P2-C: 远端移出旧公开模型时 UI 公开表同步剔除，但历史未落锁 SQLite 用量仍按内置历史费率准确计价', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gb-billing-fallback-'));
  t.after(async () => {
    resetAndRegisterRemoteModelMetadata({});
    await rm(dir, { recursive: true, force: true });
  });

  await writeFile(
    join(dir, 'remote_pricing.json'),
    JSON.stringify({
      version: 1,
      syncedAt: '2026-11-20T00:00:00Z',
      sourceUrl: 'https://raw.githubusercontent.com/Enzoo404/gravitybox/main/assets/pricing-feed.json',
      feedVersion: '2026-11-20',
      feedUpdatedAt: '2026-11-20T00:00:00Z',
      activeModels: ['gemini-4-carbon'],
      feedModels: ['gemini-4-carbon'],
      models: {
        'gemini-4-carbon': { displayName: 'Gemini 4 Carbon', capacityTokens: 200000 },
      },
      prices: {
        'gemini-4-carbon': { model: 'gemini-4-carbon', input: 1.8, output: 9.0, cached: 0.09 },
      },
    })
  );

  const convDir = join(dir, 'antigravity', 'conversations');
  await mkdir(convDir, { recursive: true });
  const dbPath = join(convDir, 'legacy-gpt4o-mini.db');
  const novSec = Math.floor(Date.parse('2026-11-18T12:00:00Z') / 1000);
  const mkBlob = (modelId, inputTok, outputTok, cachedTok, stamp) => {
    const usageMsg = Buffer.concat([
      ProtobufWriter.encodeVarintField(2, inputTok),
      ProtobufWriter.encodeVarintField(3, outputTok),
      ProtobufWriter.encodeVarintField(5, cachedTok),
    ]);
    const timing = ProtobufWriter.encodeLengthDelimited(4, ProtobufWriter.encodeVarintField(1, stamp));
    return ProtobufWriter.encodeLengthDelimited(
      1,
      Buffer.concat([
        ProtobufWriter.encodeString(19, modelId),
        ProtobufWriter.encodeLengthDelimited(4, usageMsg),
        ProtobufWriter.encodeLengthDelimited(9, timing),
      ])
    );
  };

  const db = new DatabaseSync(dbPath);
  try {
    db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB, status INTEGER, step_payload BLOB);');
    db.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);');
    db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(1, mkBlob('gpt-4o-mini', 1_000_000, 0, 0, novSec));
    db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(2, mkBlob('gemini-4-carbon', 1_000_000, 0, 0, novSec));
  } finally {
    db.close();
  }

  const manager = new UsageStatsManager({ stateDir: dir, geminiDir: dir });
  const { raw, publicKeys } = await manager.getRawPricingCatalog();
  assert.equal(raw['gpt-4o-mini'], undefined);
  assert.equal(publicKeys.has('gpt-4o-mini'), false);

  const billing = await manager.getBillingPricingTable();
  assert.ok(billing['gpt-4o-mini']);
  assert.equal(billing['gemini-4-carbon']?.input, 1.8);

  const summary = await manager.getUsageSummary(true);
  assert.equal(summary.all_time.unpriced_models, 0);
  assert.equal(summary.all_time.priced_models, 2);
  const byModel = new Map(summary.all_time.by_model.map((r) => [r.model, r]));
  assert.equal(byModel.get('gpt-4o-mini')?.estimated_usd, 0.15);
  assert.equal(byModel.get('gemini-4-carbon')?.estimated_usd, 1.8);
  assert.equal(summary.all_time.estimated_usd, 1.95);
});

test('main.js 后端启动预热 remote_pricing.json、默认关闭静默外联，并在同步更新后推进 pricingRevision', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gb-pricing-rev-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  const appDir = join(dir, 'MockAntigravity.app');
  await mkdir(join(appDir, 'Contents'), { recursive: true });
  await mkdir(join(dir, '词典'), { recursive: true });
  await mkdir(join(dir, 'profile'), { recursive: true });
  await mkdir(join(dir, 'home'), { recursive: true });
  await mkdir(join(dir, 'appsupport'), { recursive: true });
  await mkdir(join(dir, 'gemini'), { recursive: true });
  await writeFile(
    join(appDir, 'Contents', 'Info.plist'),
    '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>2.34.0</string></dict></plist>'
  );

  // 预先写入一份较新的 remote_pricing.json，验证冷启动即完成模型元数据预热
  await writeFile(join(dir, 'remote_pricing.json'), JSON.stringify({
    version: 1,
    syncedAt: '2026-11-20T00:00:00Z',
    sourceUrl: 'http://127.0.0.1:1/feed.json',
    feedVersion: '2026-11-20',
    feedUpdatedAt: '2026-11-20T00:00:00Z',
    aliases: { 'MODEL_PLACEHOLDER_M888': 'gemini-5-aurora' },
    activeModels: ['gemini-4-carbon', 'gemini-5-aurora'],
    feedModels: ['gemini-4-carbon', 'gemini-5-aurora'],
    models: {
      'gemini-4-carbon': { displayName: 'Gemini 4 Carbon', capacityTokens: 200000 },
      'gemini-5-aurora': { displayName: 'Gemini 5 Aurora', capacityTokens: 256000 },
    },
    prices: {
      'gemini-4-carbon': { model: 'gemini-4-carbon', input: 2.0, output: 10.0, cached: 0.1 },
      'gemini-5-aurora': { model: 'gemini-5-aurora', input: 1.5, output: 7.5, cached: 0.15 },
    },
  }));

  const updatedFeed = {
    version: '2026-11-21',
    schema: 1,
    updatedAt: '2026-11-21T00:00:00Z',
    aliases: { 'MODEL_PLACEHOLDER_M888': 'gemini-5-aurora' },
    activeModels: ['gemini-4-carbon', 'gemini-5-aurora'],
    feedModels: ['gemini-4-carbon', 'gemini-5-aurora'],
    models: {
      'gemini-4-carbon': { displayName: 'Gemini 4 Carbon', capacityTokens: 200000 },
      'gemini-5-aurora': { displayName: 'Gemini 5 Aurora', capacityTokens: 256000 },
    },
    prices: {
      'gemini-4-carbon': { model: 'gemini-4-carbon', input: 1.8, output: 9.0, cached: 0.09 },
      'gemini-5-aurora': { model: 'gemini-5-aurora', input: 1.5, output: 7.5, cached: 0.15 },
    },
  };
  let requestCount = 0;
  const feedServer = createServer((_req, res) => {
    requestCount += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(updatedFeed));
  });
  await new Promise((resolve) => feedServer.listen(0, '127.0.0.1', resolve));
  const port = feedServer.address().port;

  const backend = await startBackend(dir, appDir);
  try {
    const status1 = await rpc(dir, { command: 'status', includeTasks: false });
    assert.equal(status1.ok, true);
    assert.match(status1.status.pricingRevision, /^2026-11-20\|/);
    assert.equal(requestCount, 0, '默认关闭自动同步时不得静默发起外部请求');

    const syncRes = await rpc(dir, { command: 'pricing_sync_check', feedUrl: `http://127.0.0.1:${port}/feed.json` });
    assert.equal(syncRes.ok, true);
    assert.equal(syncRes.synced, true);
    assert.equal(syncRes.prices['gemini-4-carbon']?.input, 1.8);
    assert.equal(syncRes.prices['gemini-5-aurora']?.input, 1.5);

    const status2 = await rpc(dir, { command: 'status', includeTasks: false });
    assert.equal(status2.ok, true);
    assert.match(status2.status.pricingRevision, /^2026-11-21\|/);
    assert.notEqual(status2.status.pricingRevision, status1.status.pricingRevision);

    // 再次拉取相同内容（SHA-256 一致）时 pricingRevision 保持稳定不抖动
    const syncRepeat = await rpc(dir, { command: 'pricing_sync_check', feedUrl: `http://127.0.0.1:${port}/feed.json` });
    assert.equal(syncRepeat.ok, true);
    assert.equal(syncRepeat.synced, true);
    assert.equal(syncRepeat.unchanged, true);
    const status3 = await rpc(dir, { command: 'status', includeTasks: false });
    assert.equal(status3.status.pricingRevision, status2.status.pricingRevision);

    await rpc(dir, { command: 'stop' });
    await new Promise((resolve) => {
      if (backend.child.exitCode !== null) resolve();
      else backend.child.once('exit', resolve);
    });
  } finally {
    await stopBackendChild(backend.child);
    await new Promise((resolve) => feedServer.close(resolve));
  }
});

test('autoHealUnpricedHistory 仅计入实际获得有效新定价的记录，不把仍未定价的 $0 哨兵计入 healedCount', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gb-heal-count-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  const convDir = join(dir, 'antigravity', 'conversations');
  await mkdir(convDir, { recursive: true });
  const nowSec = Math.floor(Date.now() / 1000) - 60;
  const mkBlob = (modelId, inputTok, outputTok) => ProtobufWriter.encodeLengthDelimited(
    1,
    Buffer.concat([
      ProtobufWriter.encodeString(19, modelId),
      ProtobufWriter.encodeLengthDelimited(4, Buffer.concat([
        ProtobufWriter.encodeVarintField(2, inputTok),
        ProtobufWriter.encodeVarintField(3, outputTok),
      ])),
      ProtobufWriter.encodeLengthDelimited(9, ProtobufWriter.encodeLengthDelimited(4, ProtobufWriter.encodeVarintField(1, nowSec))),
    ])
  );
  const db = new DatabaseSync(join(convDir, 'heal-mixed.db'));
  try {
    db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB, status INTEGER, step_payload BLOB);');
    db.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);');
    db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(1, mkBlob('unpriced-future-alpha', 1_000_000, 0));
    db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(2, mkBlob('unpriced-future-beta', 1_000_000, 0));
  } finally {
    db.close();
  }

  const mgr = new UsageStatsManager({ geminiDir: dir, stateDir: dir });
  const before = await mgr.getUsageSummary(true);
  assert.equal(before.all_time.unpriced_models, 2);

  // 仅更新 alpha 的价格，beta 依然未定价；autoHealUnpricedHistory 应返回 1（而非 2）
  await mgr.savePricingTable({
    'unpriced-future-alpha': { model: 'unpriced-future-alpha', input: 2.0, output: 8.0, cached: 0.2 },
  });
  const healed = await mgr.autoHealUnpricedHistory();
  assert.equal(healed, 1, '仅 1 条记录真正获得有效费率锁，不得把仍未定价的 beta $0 哨兵计入 healedCount');

  // 再次执行时无新定价落锁，应精确返回 0
  const healedAgain = await mgr.autoHealUnpricedHistory();
  assert.equal(healedAgain, 0, '仍未定价模型不得重复虚报补齐数量');
});

test('P1-7 #3: syncRemotePricing 在 unchanged: true 时按 force/首次检查触发历史自愈，有补齐才刷新 revision 与 hook', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gb-sync-unchanged-heal-'));
  t.after(async () => {
    resetAndRegisterRemoteModelMetadata({});
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const convDir = join(dir, 'antigravity', 'conversations');
  await mkdir(convDir, { recursive: true });
  const nowSec = Math.floor(Date.now() / 1000) - 60;
  const mkBlob = (modelId, inputTok, outputTok) => ProtobufWriter.encodeLengthDelimited(
    1,
    Buffer.concat([
      ProtobufWriter.encodeString(19, modelId),
      ProtobufWriter.encodeLengthDelimited(4, Buffer.concat([
        ProtobufWriter.encodeVarintField(2, inputTok),
        ProtobufWriter.encodeVarintField(3, outputTok),
      ])),
      ProtobufWriter.encodeLengthDelimited(9, ProtobufWriter.encodeLengthDelimited(4, ProtobufWriter.encodeVarintField(1, nowSec))),
    ])
  );
  const db = new DatabaseSync(join(convDir, 'unchanged-heal.db'));
  try {
    db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB, status INTEGER, step_payload BLOB);');
    db.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);');
    db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(1, mkBlob('unpriced-future-gamma', 1_000_000, 0));
  } finally {
    db.close();
  }

  const feedBody = {
    version: '2026-11-22',
    updatedAt: '2026-11-22T00:00:00Z',
    prices: {
      'unpriced-future-gamma': { model: 'unpriced-future-gamma', input: 4.0, output: 16.0, cached: 0.4 },
    },
  };
  const srv = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', ETag: '"etag-gamma-1"' });
    res.end(JSON.stringify(feedBody));
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const feedUrl = `http://127.0.0.1:${srv.address().port}/feed.json`;
  t.after(() => new Promise((resolve) => srv.close(resolve)));

  // 1) 先在无远端定价时扫描历史 DB，使账本存在 1 条未定价历史记录
  const mgrBeforeSync = new UsageStatsManager({ geminiDir: dir, stateDir: dir, remotePricingUrl: feedUrl, fallbackPricingUrls: [] });
  const before = await mgrBeforeSync.getUsageSummary(true);
  assert.equal(before.all_time.estimated_usd, 0);
  assert.equal(before.all_time.unpriced_models, 1);

  // 2) 在隔离目录完成一次远端同步，将 remote_pricing.json 与 pricing-sync-status.json 复制到 dir，
  //    模拟“远端缓存与状态已同步、但历史账本尚未触发自愈”的边界场景（后续请求必命中 unchanged: true）
  const syncSeedDir = join(dir, 'sync-seed');
  await mkdir(syncSeedDir, { recursive: true });
  const mgrSeed = new UsageStatsManager({ geminiDir: syncSeedDir, stateDir: syncSeedDir, remotePricingUrl: feedUrl, fallbackPricingUrls: [] });
  const seedRes = await mgrSeed.syncRemotePricing(feedUrl, true);
  assert.equal(seedRes.synced, true);
  assert.equal(seedRes.unchanged, false);
  const remoteCache = JSON.parse(await readFile(join(syncSeedDir, 'remote_pricing.json'), 'utf8'));
  remoteCache.syncedAt = new Date(Date.now() - 86_400_001).toISOString();
  await writeFile(join(dir, 'remote_pricing.json'), JSON.stringify(remoteCache));
  const syncStatus = JSON.parse(await readFile(join(syncSeedDir, 'pricing-sync-status.json'), 'utf8'));
  syncStatus.lastCheckAt = Date.now() - 86_400_001;
  await writeFile(join(dir, 'pricing-sync-status.json'), JSON.stringify(syncStatus));

  const mgr = new UsageStatsManager({ geminiDir: dir, stateDir: dir, remotePricingUrl: feedUrl, fallbackPricingUrls: [] });
  const hookEvents = [];
  mgr.setOnPricingUpdated((info) => hookEvents.push(info));
  const revBefore = mgr.getPricingRevision();

  // 3) 首次非强制检查命中 unchanged: true，应执行首次自愈并更新 revision 与 hook
  const firstUnchanged = await mgr.syncRemotePricing(feedUrl, false);
  assert.equal(firstUnchanged.synced, true);
  assert.equal(firstUnchanged.unchanged, true);
  assert.equal(firstUnchanged.healedCount, 1);
  assert.notEqual(mgr.getPricingRevision(), revBefore);
  assert.equal(hookEvents.length, 1);
  assert.equal(hookEvents[0].healedCount, 1);
  const summaryAfterFirst = await mgr.getUsageSummary(false);
  assert.equal(summaryAfterFirst.all_time.estimated_usd, 4.0);
  assert.equal(summaryAfterFirst.all_time.unpriced_models, 0);

  // 4) 非首次且非强制检查即使恢复冷却窗口也直接跳过重复自愈（不递增 revision、不触发 hook）
  const revAfterFirst = mgr.getPricingRevision();
  const lockKeys = Object.keys(mgr.rateLocks);
  assert.equal(lockKeys.length, 1);
  mgr.nextAutoSyncAt = 0;
  mgr.rateLocks[lockKeys[0]] = {
    usd: 0,
    price: { model: 'unpriced-future-gamma', input: 0, output: 0, cached: 0 },
  };
  const secondNonForced = await mgr.syncRemotePricing(feedUrl, false);
  assert.equal(secondNonForced.synced, true);
  assert.equal(secondNonForced.unchanged, true);
  assert.equal(secondNonForced.healedCount, 0);
  assert.equal(mgr.getPricingRevision(), revAfterFirst);
  assert.equal(hookEvents.length, 1);

  // 5) 同一实例在 unchangedHealChecked 已为 true 后，force === true 仍会执行自愈并更新 revision 与 hook
  const forcedHealRes = await mgr.syncRemotePricing(feedUrl, true);
  assert.equal(forcedHealRes.synced, true);
  assert.equal(forcedHealRes.unchanged, true);
  assert.equal(forcedHealRes.healedCount, 1);
  assert.notEqual(mgr.getPricingRevision(), revAfterFirst);
  assert.equal(hookEvents.length, 2);

  // 6) 全部已落锁后再次 force === true 且 unchanged: true，healedCount 为 0 且 revision 不再变化
  const revAfterForced = mgr.getPricingRevision();
  const forcedNoop = await mgr.syncRemotePricing(feedUrl, true);
  assert.equal(forcedNoop.synced, true);
  assert.equal(forcedNoop.unchanged, true);
  assert.equal(forcedNoop.healedCount, 0);
  assert.equal(mgr.getPricingRevision(), revAfterForced);
  assert.equal(hookEvents.length, 2);
});

test('P1-11 & P1-15: 损坏远端价格缓存自动跳过 ETag/SHA-256 自愈重写；2 位数 Claude 版本、10M 容量与非四大族变体折叠', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gb-p1-11-cache-heal-'));
  t.after(async () => {
    resetAndRegisterRemoteModelMetadata({});
    await rm(dir, { recursive: true, force: true });
  });

  const feedBody = JSON.stringify({
    version: '2026-11-22',
    updatedAt: '2026-11-22T12:00:00Z',
    prices: {
      'gemini-4-carbon': { model: 'gemini-4-carbon', input: 2.0, output: 10.0, cached: 0.2 },
    },
  });
  const seenIfNoneMatch = [];
  const srv = createServer((req, res) => {
    seenIfNoneMatch.push(req.headers['if-none-match'] ?? null);
    if (req.headers['if-none-match'] === '"v-heal"') {
      res.writeHead(304, { etag: '"v-heal"' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json', etag: '"v-heal"' });
    res.end(feedBody);
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => srv.close(resolve)));
  const port = srv.address().port;
  const feedUrl = `http://127.0.0.1:${port}/feed.json`;

  const { executeRemotePricingSync } = await import('../dist/usage-pricing.js');
  const { normalizeModelId } = await import('../dist/model-identity.js');
  const { getRemoteModelSpec } = await import('../dist/model-catalog.js');
  const remoteCachePath = join(dir, 'remote_pricing.json');
  const syncStatePath = join(dir, 'pricing-sync.json');
  const state = {
    lastRemoteSyncAt: 0,
    lastSyncSuccess: false,
    lastCheckAt: 0,
    lastCheckSuccess: false,
    nextAutoSyncAt: 0,
    lastSyncError: null,
    lastSyncedVersion: '',
    lastSyncedUpdatedAt: '',
    lastSyncedSourceUrl: '',
    lastSyncedEtag: '',
    lastSyncedSha256: '',
  };

  // 1) 首次同步写入有效缓存
  const first = await executeRemotePricingSync({
    candidateUrls: [feedUrl],
    remotePricingCachePath: remoteCachePath,
    pricingSyncStatePath: syncStatePath,
    state,
    now: Date.parse('2026-11-22T12:00:00Z'),
  });
  assert.equal(first.synced, true);
  assert.equal(first.unchanged, false);

  // 2) 模拟磁盘缓存损坏（截断 JSON），下次非强制同步不得发送 If-None-Match 也不得走 SHA-256 跳过，应自动重写自愈
  await writeFile(remoteCachePath, '{"version":1,"prices":INVALID', 'utf8');
  const healed = await executeRemotePricingSync({
    candidateUrls: [feedUrl],
    remotePricingCachePath: remoteCachePath,
    pricingSyncStatePath: syncStatePath,
    state,
    now: Date.parse('2026-11-22T13:00:00Z'),
    force: false,
  });
  assert.equal(seenIfNoneMatch[1], null, '缓存损坏时不得发送 If-None-Match');
  assert.equal(healed.synced, true);
  assert.equal(healed.unchanged, false, '损坏缓存自愈重写后 unchanged 应为 false');
  const repaired = JSON.parse(await readFile(remoteCachePath, 'utf8'));
  assert.equal(repaired.prices['gemini-4-carbon'].input, 2.0);

  // 3) 缓存含非法 prices 结构时同样视为无效并自愈
  await writeFile(remoteCachePath, JSON.stringify({ version: 1, prices: { bad: { model: 'bad', input: -1, output: 1, cached: 0 } } }), 'utf8');
  const healedBadPrices = await executeRemotePricingSync({
    candidateUrls: [feedUrl],
    remotePricingCachePath: remoteCachePath,
    pricingSyncStatePath: syncStatePath,
    state,
    now: Date.parse('2026-11-22T14:00:00Z'),
    force: false,
  });
  assert.equal(seenIfNoneMatch[2], null, 'prices 非法时不得发送 If-None-Match');
  assert.equal(healedBadPrices.unchanged, false);

  // 4) force: true 不发 If-None-Match 且重刷磁盘，同时对有效且同 SHA-256 缓存仍保留 unchanged: true 语义
  const forced = await executeRemotePricingSync({
    candidateUrls: [feedUrl],
    remotePricingCachePath: remoteCachePath,
    pricingSyncStatePath: syncStatePath,
    state,
    now: Date.parse('2026-11-22T15:00:00Z'),
    force: true,
  });
  assert.equal(seenIfNoneMatch[3], null, 'force 刷新不得发送 If-None-Match');
  assert.equal(forced.synced, true);
  assert.equal(forced.unchanged, true);

  // P1-15: 2 位数 Claude 版本归一化、10M 远端容量上限、非四大族未定价思考变体折叠
  assert.equal(normalizeModelId('claude-10.0-sonnet'), 'claude-sonnet-10-0');
  resetAndRegisterRemoteModelMetadata({
    models: { 'gemini-10-nova': { displayName: 'Gemini 10 Nova', capacityTokens: 5_000_000 } },
  });
  assert.equal(getRemoteModelSpec('gemini-10-nova')?.capacityTokens, 5_000_000);

  const snap = resolvePricingCatalogSnapshot({
    rawPricingTable: {},
    live: {
      tier: 'PRO',
      models: [
        { model_id: 'deepseek-r2-high', display_name: 'DeepSeek R2 (High)' },
        { model_id: 'deepseek-r2-low', display_name: 'DeepSeek R2 (Low)' },
      ],
    },
  });
  const deepseekEntry = snap.unpricedLiveModels.find((m) => m.key === 'deepseek-r2');
  assert.ok(deepseekEntry, '非四大族未定价思考变体应折叠归并至基模型 deepseek-r2');
  assert.deepEqual(deepseekEntry.variants, ['Low', 'High']);

  // P2-5: 远端 pricing-feed.json 显式拒收不兼容 schema（如 schema: 2）
  const badSchemaSrv = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      schema: 2,
      version: '2026-11-23',
      prices: { 'gemini-4-carbon': { model: 'gemini-4-carbon', input: 2.0, output: 10.0, cached: 0.2 } },
    }));
  });
  await new Promise((resolve) => badSchemaSrv.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => badSchemaSrv.close(resolve)));
  const badSchemaRes = await executeRemotePricingSync({
    candidateUrls: [`http://127.0.0.1:${badSchemaSrv.address().port}/bad-schema.json`],
    remotePricingCachePath: join(dir, 'bad-schema-cache.json'),
    pricingSyncStatePath: join(dir, 'bad-schema-state.json'),
    state: { ...state, lastSyncedVersion: '', lastSyncedSha256: '', lastSyncedEtag: '' },
    now: Date.parse('2026-11-23T00:00:00Z'),
  });
  assert.equal(badSchemaRes.synced, false, '不兼容 schema !== 1 的远端定价包必须被显式拒收');
});

test('P0-06 & P1-14: gpt-oss-120b 新事件保持未定价且旧锁价保留原出处；gemini-2.5-pro 在 200K 边界精确触发长上下文阶梯', async (t) => {
  const { resolvePricingFromTable, calculateEstimatedUsd } = await import('../dist/pricing.js');
  const { UsageLedger } = await import('../dist/usage-ledger.js');
  const { MODEL_NAMES, MODEL_CAPACITIES } = await import('../dist/model-catalog.js');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');

  assert.equal(MODEL_NAMES['gpt-oss-120b'], 'GPT-OSS 120B');
  assert.equal(MODEL_CAPACITIES['gpt-oss-120b'], 128000);
  assert.equal(resolvePricingFromTable(DEFAULT_API_PRICES, 'gpt-oss-120b', 1_760_000_000), null);

  const dir = await mkdtemp(join(tmpdir(), 'gb-oss-unpriced-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ledger = new UsageLedger(dir);
  const nowSec = Math.floor(Date.now() / 1000);

  // 1) 新事件保留 Token 且不生成默认美元金额
  await ledger.save([{
    event_key: 'ev-oss-new-1',
    source_id: 'src-oss',
    generation_index: 0,
    model: 'gpt-oss-120b',
    input_tokens: 10000,
    output_tokens: 2000,
    cached_tokens: 5000,
    total_tokens: 17000,
    timestamp_seconds: nowSec,
  }], { billingPrices: DEFAULT_API_PRICES });
  const agg = await ledger.aggregate({ prices: DEFAULT_API_PRICES, accounts: [], now: nowSec });
  assert.equal(agg.all_time.totals.total_tokens, 17000);
  assert.equal(agg.all_time.estimated_usd, 0);
  assert.equal(agg.all_time.unpriced_models, 1);

  // 2) 旧锁价保留原 provenance（不会随默认目录移除而丢出处）
  const legacyProv = { sourceUrl: 'https://custom.local/oss', platform: 'Self-hosted', verification: 'user' };
  await ledger.save([{
    event_key: 'ev-oss-legacy-lock',
    source_id: 'src-oss-old',
    generation_index: 0,
    model: 'gpt-oss-120b',
    input_tokens: 1_000_000,
    output_tokens: 0,
    cached_tokens: 0,
    total_tokens: 1_000_000,
    timestamp_seconds: nowSec - 100,
  }], { billingPrices: { 'gpt-oss-120b': { model: 'gpt-oss-120b', input: 0.15, output: 0.6, cached: 0.075, provenance: legacyProv } } });
  const { DatabaseSync } = await import('node:sqlite');
  const dbCheck = new DatabaseSync(ledger.path, { readOnly: true });
  try {
    const row = dbCheck.prepare('SELECT unit_price, usd FROM rate_locks WHERE event_key = ?').get('ev-oss-legacy-lock');
    assert.ok(row);
    const unitPrice = JSON.parse(row.unit_price);
    assert.equal(unitPrice.input, 0.15);
    assert.deepEqual(unitPrice.provenance, legacyProv);
    assert.ok(Math.abs(row.usd - 0.15) < 1e-9);
  } finally {
    dbCheck.close();
  }

  // 3) gemini-2.5-pro 200000 vs 200001 Token 边界
  const baseCost = calculateEstimatedUsd(200_000, 100_000, 0, DEFAULT_API_PRICES['gemini-2.5-pro']);
  // 200K * 1.25/1M + 100K * 10/1M = 0.25 + 1.0 = 1.25
  assert.ok(Math.abs(baseCost - 1.25) < 1e-9, `<=200000 token 应走基础费率 1.25，实际 ${baseCost}`);

  const tierCost = calculateEstimatedUsd(200_001, 100_000, 0, DEFAULT_API_PRICES['gemini-2.5-pro']);
  // 200001 * 2.5/1M + 100K * 15/1M = 0.5000025 + 1.5 = 2.0000025
  assert.ok(Math.abs(tierCost - 2.0000025) < 1e-9, `200001 token 应触发 >200K 阶梯费率，实际 ${tierCost}`);
});
