import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountsManager } from '../dist/accounts.js';
import {
  accountCredentialReadiness,
  buildAccountQuotaOverview,
  computeAccountRemaining,
  resolveEffectiveMonitoredModel,
  subscriptionTierRank,
} from '../dist/account-quota.js';
import { normalizeCatalogTierLabel } from '../dist/pricing.js';
import { resolveUnsavedLiveSubscriptionTier } from '../dist/main.js';
import {
  projectAccountForIpcNormalized,
  projectQuotaContract,
} from '../dist/ipc-projections.js';
import {
  normalizeCloudModels,
  normalizeLiveModels,
} from '../dist/quota.js';

async function createTempManager(t) {
  const root = await mkdtemp(join(tmpdir(), 'gb-quota-tiers-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = new AccountsManager(root);
  manager.probeLiveLanguageServer = async () => null;
  const acc = await manager.upsertAccount({
    email: 'tier-test@example.test',
    refreshToken: 'synthetic-refresh',
    accessToken: 'synthetic-access',
    expiresIn: 3600,
  });
  return { manager, acc };
}

test('normalizeCloudModels 与 normalizeLiveModels 正确提取 quotaBucketName / quota_bucket_name', () => {
  const nowSec = 1_700_000_000;
  const reset = new Date((nowSec + 3600) * 1000).toISOString();

  const cloudModels = normalizeCloudModels({
    models: {
      'gemini-4-argon': {
        displayName: 'Gemini 4 Argon',
        quotaBucketName: 'Gemini Models',
        quotaInfo: { remainingFraction: 0.85, resetTime: reset },
      },
      'orchestrator-argon': {
        displayName: 'Orchestrator (Argon)',
        quota_bucket_name: 'Gemini Models',
        quotaInfo: { remainingFraction: 0.85, resetTime: reset },
      },
    },
  }, nowSec);
  assert.equal(cloudModels.find(m => m.model_id === 'gemini-4-argon')?.quota_bucket_name, 'Gemini Models');
  assert.equal(cloudModels.find(m => m.model_id === 'orchestrator-argon')?.quota_bucket_name, 'Gemini Models');

  const liveModels = normalizeLiveModels([
    {
      modelId: 'gemini-4-carbon',
      label: 'Gemini 4 Carbon',
      modelOrAlias: { model: 'gemini-4-carbon' },
      quotaBucketName: 'Gemini Models',
      quotaInfo: { remainingFraction: 0.85, resetTime: reset },
    },
  ], nowSec);
  assert.equal(liveModels[0]?.quota_bucket_name, 'Gemini Models');
});

test('Ultra 账号：Argon/Carbon 与 Orchestrator 归并入 Gemini 共享池，不触发 :retrieveUserQuota 与冗余告警，IPC quotaGroups 仅含核心组，智能切换解析到 Gemini 池', async t => {
  const { manager, acc } = await createTempManager(t);
  const nowMs = Date.now();
  const reset5h = new Date(nowMs + 4 * 3600 * 1000).toISOString();
  const resetWeekly = new Date(nowMs + 5 * 86400 * 1000).toISOString();
  const seenUrls = [];

  const cloudFetch = async (url) => {
    seenUrls.push(String(url));
    if (String(url).includes('loadCodeAssist')) {
      return Response.json({ currentTier: { id: 'g1-ultra-tier', name: 'Google AI Ultra' } });
    }
    if (String(url).includes('fetchAvailableModels')) {
      return Response.json({
        models: {
          'gemini-2.5-pro': {
            displayName: 'Gemini 2.5 Pro',
            quotaBucketName: 'Gemini Models',
            quotaInfo: { remainingFraction: 0.85, resetTime: reset5h },
          },
          'gemini-4-argon': {
            displayName: 'Gemini 4 Argon',
            quotaBucketName: 'Gemini Models',
            quotaInfo: { remainingFraction: 0.85, resetTime: reset5h },
          },
          'gemini-4-carbon': {
            displayName: 'Gemini 4 Carbon',
            quotaBucketName: 'Gemini Models',
            quotaInfo: { remainingFraction: 0.85, resetTime: reset5h },
          },
          'orchestrator-argon': {
            displayName: 'Orchestrator (Argon)',
            quotaBucketName: 'Gemini Models',
            quotaInfo: { remainingFraction: 0.85, resetTime: reset5h },
          },
          'orchestrator-carbon': {
            displayName: 'Orchestrator (Carbon)',
            quotaBucketName: 'Gemini Models',
            quotaInfo: { remainingFraction: 0.85, resetTime: reset5h },
          },
          'claude-4-sonnet': {
            displayName: 'Claude 4 Sonnet',
            quotaBucketName: 'Claude/GPT Models',
            quotaInfo: { remainingFraction: 0.9, resetTime: reset5h },
          },
        },
      });
    }
    if (String(url).includes('retrieveUserQuotaSummary')) {
      return Response.json({
        groups: [
          {
            displayName: 'Gemini Models',
            buckets: [
              { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.85, resetTime: reset5h },
              { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.70, resetTime: resetWeekly },
            ],
          },
          {
            displayName: 'Claude/GPT Models',
            buckets: [
              { bucketId: 'claude-5h', window: '5h', remainingFraction: 0.90, resetTime: reset5h },
              { bucketId: 'claude-weekly', window: 'weekly', remainingFraction: 0.80, resetTime: resetWeekly },
            ],
          },
        ],
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const refreshed = await manager.refreshQuota(acc.id, cloudFetch);
  assert.equal(seenUrls.some(u => u.includes('retrieveUserQuota') && !u.includes('Summary')), false);

  const overview = manager.getAccountQuotaOverview(refreshed);
  assert.equal(overview.argonStatus.mode, 'unified');
  assert.equal(overview.argonStatus.pooledInFamily, 'gemini');
  assert.equal(overview.argonStatus.availability, 'available');
  assert.equal(overview.carbonStatus.mode, 'unified');
  assert.equal(overview.carbonStatus.pooledInFamily, 'gemini');
  assert.deepEqual(overview.standaloneModels, []);
  assert.equal(overview.refreshState.missingFamilies.includes('argon'), false);
  assert.equal(overview.refreshState.missingFamilies.includes('carbon'), false);
  for (const forbidden of ['ARGON_MODEL_QUOTA', 'ARGON_UNKNOWN', 'MISSING_FAMILY:argon', 'MISSING_FAMILY:carbon']) {
    assert.equal(overview.quotaWarningCodes.includes(forbidden), false, `unexpected warning ${forbidden}`);
  }

  // 智能切换 remaining 解析
  assert.equal(computeAccountRemaining(refreshed, 'argon'), 70);
  assert.equal(computeAccountRemaining(refreshed, 'carbon'), 70);
  assert.equal(computeAccountRemaining(refreshed, 'gemini-4-argon'), 70);
  assert.equal(computeAccountRemaining(refreshed, 'gemini-4-carbon'), 70);
  assert.equal(computeAccountRemaining(refreshed, 'orchestrator-argon'), 70);
  assert.equal(computeAccountRemaining(refreshed, 'gemini_all'), 70);
  assert.equal(computeAccountRemaining(refreshed, 'gemini'), 70);
  assert.equal(computeAccountRemaining(refreshed, 'claude'), 80);
  assert.equal(computeAccountRemaining(refreshed, 'all'), 70);

  // IPC 动态 quotaGroups 契约
  const ipcContract = projectQuotaContract(overview);
  assert.deepEqual(ipcContract.quotaGroups.map(g => g.key), ['gemini', 'claude']);
  const ipcAccount = projectAccountForIpcNormalized(refreshed, manager, { includeOverviewFields: true });
  assert.deepEqual(ipcAccount.quotaGroups.map(g => g.key), ['gemini', 'claude']);
  assert.equal(ipcAccount.quotaGroups[0].displayName, 'Gemini');
  assert.equal(ipcAccount.quotaGroups[0].summaryLabel, 'Gemini');
  assert.deepEqual(ipcAccount.quotaGroups[0].brands, ['gemini']);
  assert.equal(ipcAccount.quotaGroups[0].isStandalone, false);
  assert.equal(ipcAccount.quotaGroups[0].availability, 'available');
  assert.equal(ipcAccount.quotaGroups[0].quotaState, 'known');
  assert.deepEqual(ipcAccount.quotaGroups[0].windows.map(w => w.period), ['5h', 'weekly']);
  assert.equal(ipcAccount.quotaGroups[1].key, 'claude');
  assert.equal(ipcAccount.quotaGroups[1].displayName, 'Claude/GPT');
  assert.deepEqual(ipcAccount.quotaGroups[1].brands, ['claude', 'gpt']);
  // 原始 stored quota.quota_groups 保持完整兼容
  assert.equal(Array.isArray(ipcAccount.quota.quota_groups), true);
  assert.equal(ipcAccount.quota.quota_groups.length, 2);
});

test('Pro 账号：独立 Gemini 4 Argon 每周组保留为 standalone 与动态 quotaGroups，且不产生虚假 Carbon 行', async t => {
  const { manager, acc } = await createTempManager(t);
  const nowMs = Date.now();
  const reset5h = new Date(nowMs + 3 * 3600 * 1000).toISOString();
  const resetWeekly = new Date(nowMs + 6 * 86400 * 1000).toISOString();

  const cloudFetch = async (url) => {
    if (String(url).includes('loadCodeAssist')) {
      return Response.json({ currentTier: { id: 'g1-pro-tier', name: 'Google AI Pro' } });
    }
    if (String(url).includes('fetchAvailableModels')) {
      return Response.json({
        models: {
          'gemini-2.5-pro': {
            displayName: 'Gemini 2.5 Pro',
            quotaInfo: { remainingFraction: 0.75, resetTime: reset5h },
          },
          'gemini-4-argon': {
            displayName: 'Gemini 4 Argon',
            quotaBucketName: 'Gemini 4 Argon',
            quotaInfo: { remainingFraction: 0.40, resetTime: resetWeekly },
          },
          'claude-4-sonnet': {
            displayName: 'Claude 4 Sonnet',
            quotaInfo: { remainingFraction: 0.90, resetTime: reset5h },
          },
        },
      });
    }
    return Response.json({
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.75, resetTime: reset5h }],
        },
        {
          displayName: 'Claude/GPT Models',
          buckets: [{ bucketId: 'claude-5h', window: '5h', remainingFraction: 0.90, resetTime: reset5h }],
        },
        {
          displayName: 'Gemini 4 Argon',
          buckets: [{ bucketId: 'argon-weekly', window: 'weekly', remainingFraction: 0.40, resetTime: resetWeekly }],
        },
      ],
    });
  };

  const refreshed = await manager.refreshQuota(acc.id, cloudFetch);
  const overview = manager.getAccountQuotaOverview(refreshed);
  assert.equal(overview.argonStatus.mode, 'standalone');
  assert.equal(overview.argonStatus.pooledInFamily, null);
  assert.equal(overview.argonStatus.period, 'weekly');
  assert.equal(overview.argonStatus.remaining, 0.4);
  assert.deepEqual(overview.standaloneModels.map(m => m.key), ['argon']);
  assert.deepEqual(overview.projectedQuotaGroups.map(g => g.key), ['gemini', 'claude', 'argon']);
  const argonGroup = overview.projectedQuotaGroups.find(g => g.key === 'argon');
  assert.equal(argonGroup.isStandalone, true);
  assert.equal(argonGroup.summaryLabel, 'Argon');
  assert.deepEqual(argonGroup.brands, ['gemini']);
  assert.equal(argonGroup.windows[0].period, 'weekly');
  assert.equal(argonGroup.windows[0].remaining, 0.4);

  assert.equal(computeAccountRemaining(refreshed, 'argon'), 40);
  assert.equal(computeAccountRemaining(refreshed, 'gemini'), 75);
});

test('Free / Starter 账号：disabled Argon 隐藏且不触发 :retrieveUserQuota，starter 映射为 FREE', async t => {
  const { manager, acc } = await createTempManager(t);
  const nowMs = Date.now();
  const reset5h = new Date(nowMs + 2 * 3600 * 1000).toISOString();
  const seenUrls = [];

  const cloudFetch = async (url) => {
    seenUrls.push(String(url));
    if (String(url).includes('loadCodeAssist')) {
      return Response.json({ currentTier: { id: 'starter', name: 'Antigravity Starter Quota' } });
    }
    if (String(url).includes('fetchAvailableModels')) {
      return Response.json({
        models: {
          'gemini-2.5-flash': {
            displayName: 'Gemini 2.5 Flash',
            quotaInfo: { remainingFraction: 0.95, resetTime: reset5h },
          },
          'gemini-4-argon-disabled': {
            displayName: 'Gemini 4 Argon',
            disabled: true,
          },
          'orchestrator-argon-disabled': {
            displayName: 'Orchestrator (Argon)',
            disabled: true,
          },
          'claude-4-sonnet': {
            displayName: 'Claude 4 Sonnet',
            quotaInfo: { remainingFraction: 0.5, resetTime: reset5h },
          },
        },
      });
    }
    return Response.json({
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.95, resetTime: reset5h }],
        },
        {
          displayName: 'Claude/GPT Models',
          buckets: [{ bucketId: 'claude-5h', window: '5h', remainingFraction: 0.5, resetTime: reset5h }],
        },
      ],
    });
  };

  const refreshed = await manager.refreshQuota(acc.id, cloudFetch);
  assert.equal(seenUrls.some(u => u.includes('retrieveUserQuota') && !u.includes('Summary')), false);

  const overview = manager.getAccountQuotaOverview(refreshed);
  assert.equal(overview.subscriptionTier, 'FREE');
  assert.equal(overview.argonStatus.availability, 'disabled');
  assert.equal(overview.argonStatus.mode, 'disabled');
  assert.deepEqual(overview.standaloneModels, []);
  assert.deepEqual(overview.projectedQuotaGroups.map(g => g.key), ['gemini', 'claude']);
  for (const forbidden of ['ARGON_MODEL_QUOTA', 'ARGON_UNKNOWN', 'MISSING_FAMILY:argon', 'MISSING_FAMILY:carbon']) {
    assert.equal(overview.quotaWarningCodes.includes(forbidden), false);
  }
  const ipcAccount = projectAccountForIpcNormalized(refreshed, manager, { includeOverviewFields: true });
  assert.equal(ipcAccount.subscription_tier, 'FREE');
  assert.deepEqual(ipcAccount.quotaGroups.map(g => g.key), ['gemini', 'claude']);
});

test('旧快照中遗留的 ARGON_MODEL_QUOTA / MISSING_FAMILY:argon 在 unified 模式下自动收敛，真实独立模型仍保留', () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const reset = new Date((nowSec + 3600) * 1000).toISOString();
  const overview = buildAccountQuotaOverview({
    quota: {
      subscription_tier: 'ULTRA',
      last_updated: nowSec,
      is_forbidden: false,
      model_forwarding_rules: {},
      quota_warnings: [
        'ARGON_MODEL_QUOTA: legacy warning',
        'MISSING_FAMILY:argon: missing argon',
      ],
      quota_groups: [
        {
          display_name: 'Gemini Models',
          family: 'gemini',
          buckets: [{ bucket_id: 'g5h', window: '5h', remaining_fraction: 0.85, remaining_fraction_known: true, reset_time: reset }],
        },
      ],
      models: [
        { name: 'gemini-4-argon', model_id: 'gemini-4-argon', display_name: 'Gemini 4 Argon', family: 'argon', is_argon: true, quota_bucket_name: 'Gemini Models', percentage: 85, percentage_known: true, own_percentage: 85, own_percentage_known: true, own_reset_time: reset, reset_time: reset },
        { name: 'gemini-4-xenon', model_id: 'gemini-4-xenon', display_name: 'Gemini 4 Xenon', family: 'other', quota_bucket_name: 'Gemini 4 Xenon', percentage: 42, percentage_known: true, own_percentage: 42, own_percentage_known: true, own_reset_time: reset, reset_time: reset },
      ],
    },
  });

  assert.equal(overview.argonStatus.mode, 'unified');
  assert.equal(overview.quotaWarningCodes.includes('ARGON_MODEL_QUOTA'), false);
  assert.equal(overview.quotaWarningCodes.includes('MISSING_FAMILY:argon'), false);
  assert.deepEqual(overview.standaloneModels.map(m => m.key), ['gemini-4-xenon']);
  assert.deepEqual(overview.projectedQuotaGroups.map(g => g.key), ['gemini', 'gemini-4-xenon']);
  assert.deepEqual(overview.projectedQuotaGroups.find(g => g.key === 'gemini-4-xenon')?.brands, ['gemini']);
});

test('P1-4 & P1-5: All Gemini Models 策略兼容与 common.period.daily 双语词条完整对齐', async () => {
  const { translate } = await import('../dist/i18n.js');
  assert.equal(translate('en', 'common.period.daily', undefined, { namespace: 'app' }), 'Daily');
  assert.equal(translate('zh-Hans', 'common.period.daily', undefined, { namespace: 'app' }), '每日');

  const nowSec = Math.floor(Date.now() / 1000);
  const reset = new Date((nowSec + 3600) * 1000).toISOString();
  const account = {
    quota: {
      subscription_tier: 'PRO',
      last_updated: nowSec,
      is_forbidden: false,
      model_forwarding_rules: {},
      quota_groups: [
        {
          display_name: 'Gemini Models',
          family: 'gemini',
          buckets: [{ bucket_id: 'g-5h', window: '5h', remaining_fraction: 0.65, remaining_fraction_known: true, reset_time: reset }],
        },
        {
          display_name: 'Gemini 4 Argon',
          family: 'argon',
          buckets: [{ bucket_id: 'a-weekly', window: 'weekly', remaining_fraction: 0.40, remaining_fraction_known: true, reset_time: reset }],
        },
        {
          display_name: 'Claude/GPT Models',
          family: 'claude',
          buckets: [{ bucket_id: 'c-5h', window: '5h', remaining_fraction: 0.25, remaining_fraction_known: true, reset_time: reset }],
        },
      ],
      models: [
        { name: 'gemini-2.5-pro', model_id: 'gemini-2.5-pro', display_name: 'Gemini 2.5 Pro', family: 'gemini', percentage: 65, percentage_known: true, own_percentage: 65, own_percentage_known: true, own_reset_time: reset, reset_time: reset },
        { name: 'gemini-4-argon', model_id: 'gemini-4-argon', display_name: 'Gemini 4 Argon', family: 'argon', is_argon: true, quota_bucket_name: 'Gemini 4 Argon', percentage: 40, percentage_known: true, own_percentage: 40, own_percentage_known: true, own_reset_time: reset, reset_time: reset },
        { name: 'claude-4-sonnet', model_id: 'claude-4-sonnet', display_name: 'Claude 4 Sonnet', family: 'claude', percentage: 25, percentage_known: true, own_percentage: 25, own_percentage_known: true, own_reset_time: reset, reset_time: reset },
      ],
    },
  };
  assert.equal(computeAccountRemaining(account, 'All Gemini Models'), 40);
  assert.equal(computeAccountRemaining(account, 'gemini_all'), 40);
  assert.equal(computeAccountRemaining(account, 'Gemini 全系模型'), 40);
  assert.equal(computeAccountRemaining(account, 'all'), 25);
});

test('Ultra 账号实机双接口漂移回归：120s 满额重置偏移、对话百分比滞后防误吸 Claude、独立模型保真与 Live 套餐防降级', async t => {
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const reset5hModel = new Date(nowMs + 5 * 3600 * 1000).toISOString();
  const reset5hGroup = new Date(nowMs + 5 * 3600 * 1000 + 120_000).toISOString();
  const resetWeekly = new Date(nowMs + 6 * 86400 * 1000).toISOString();
  const reset7d = new Date(nowMs + 7 * 86400 * 1000).toISOString();

  // 场景 A：复刻实机 100% 满额浮动 5h 窗口 120s 重置时间漂移 & quota_bucket_name 为 null
  const driftedFullAccount = {
    quota: {
      subscription_tier: 'ULTRA',
      source: 'live',
      last_updated: nowSec,
      is_forbidden: false,
      model_forwarding_rules: {},
      quota_groups: [
        {
          display_name: 'Gemini Models',
          family: 'gemini',
          source: 'live',
          buckets: [
            { bucket_id: 'gemini-5h', window: '5h', remaining_fraction: 1, remaining_fraction_known: true, reset_time: reset5hGroup, observed_at: nowSec, source: 'live' },
            { bucket_id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.88, remaining_fraction_known: true, reset_time: resetWeekly, observed_at: nowSec, source: 'live' },
          ],
        },
        {
          display_name: 'Claude and GPT models',
          family: 'claude',
          source: 'live',
          buckets: [
            { bucket_id: '3p-5h', window: '5h', remaining_fraction: 1, remaining_fraction_known: true, reset_time: reset5hGroup, observed_at: nowSec, source: 'live' },
            { bucket_id: '3p-weekly', window: 'weekly', remaining_fraction: 1, remaining_fraction_known: true, reset_time: reset7d, observed_at: nowSec, source: 'live' },
          ],
        },
      ],
      models: [
        'gemini-4-argon-high',
        'gemini-4-argon-medium',
        'gemini-4-argon-low',
        'gemini-4-carbon-high',
        'gemini-4-carbon-medium',
        'gemini-4-carbon-low',
        'gemini-pro-orchestrator',
        'gemini-pro-orchestrator-argon',
        'gemini-4-hydrogen-high',
        'gemini-3.8-flash-high',
      ].map(id => ({
        name: id,
        model_id: id,
        display_name: id === 'gemini-pro-orchestrator'
          ? 'Orchestrator (Carbon)'
          : id === 'gemini-pro-orchestrator-argon'
            ? 'Orchestrator (Argon)'
            : id,
        quota_bucket_name: null,
        percentage: 100,
        percentage_known: true,
        own_percentage: 100,
        own_percentage_known: true,
        own_reset_time: reset5hModel,
        own_observed_at: nowSec,
        reset_time: reset5hModel,
        quota_source: 'live',
      })),
    },
  };

  const driftedOverview = buildAccountQuotaOverview(driftedFullAccount, { nowMs });
  assert.equal(driftedOverview.argonStatus.mode, 'unified');
  assert.equal(driftedOverview.carbonStatus.mode, 'unified');
  assert.equal(driftedOverview.argonStatus.pooledInFamily, 'gemini');
  assert.equal(driftedOverview.carbonStatus.pooledInFamily, 'gemini');
  assert.deepEqual(driftedOverview.standaloneModels, []);
  assert.deepEqual(driftedOverview.projectedQuotaGroups.map(g => g.key), ['gemini', 'claude']);

  // 场景 B：对话消耗期间 GetUserStatus 百分比滞后 + 跨品牌防误吸 Claude/GPT
  const reset4hGemini = new Date(nowMs + 4 * 3600 * 1000).toISOString();
  const reset5hClaudeNear = new Date(nowMs + 5 * 3600 * 1000 + 20_000).toISOString();
  const laggedConsumptionAccount = {
    quota: {
      subscription_tier: 'ULTRA',
      source: 'live',
      last_updated: nowSec,
      is_forbidden: false,
      model_forwarding_rules: {},
      quota_groups: [
        {
          display_name: 'Gemini Models',
          family: 'gemini',
          source: 'live',
          buckets: [
            { bucket_id: 'gemini-5h', window: '5h', remaining_fraction: 0.93, remaining_fraction_known: true, reset_time: reset4hGemini, observed_at: nowSec, source: 'live' },
            { bucket_id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.88, remaining_fraction_known: true, reset_time: resetWeekly, observed_at: nowSec, source: 'live' },
          ],
        },
        {
          display_name: 'Claude and GPT models',
          family: 'claude',
          source: 'live',
          buckets: [
            { bucket_id: '3p-5h', window: '5h', remaining_fraction: 1, remaining_fraction_known: true, reset_time: reset5hClaudeNear, observed_at: nowSec, source: 'live' },
            { bucket_id: '3p-weekly', window: 'weekly', remaining_fraction: 1, remaining_fraction_known: true, reset_time: reset7d, observed_at: nowSec, source: 'live' },
          ],
        },
      ],
      models: [
        { name: 'gemini-4-argon-high', model_id: 'gemini-4-argon-high', display_name: 'Gemini 4 Argon (High)', quota_bucket_name: null, percentage: 100, percentage_known: true, own_percentage: 100, own_percentage_known: true, own_reset_time: reset5hModel, own_observed_at: nowSec, reset_time: reset5hModel, quota_source: 'live' },
        { name: 'gemini-4-carbon-high', model_id: 'gemini-4-carbon-high', display_name: 'Gemini 4 Carbon (High)', quota_bucket_name: null, percentage: 100, percentage_known: true, own_percentage: 100, own_percentage_known: true, own_reset_time: reset5hModel, own_observed_at: nowSec, reset_time: reset5hModel, quota_source: 'live' },
        { name: 'gemini-pro-orchestrator', model_id: 'gemini-pro-orchestrator', display_name: 'Orchestrator (Carbon)', quota_bucket_name: null, percentage: 100, percentage_known: true, own_percentage: 100, own_percentage_known: true, own_reset_time: reset5hModel, own_observed_at: nowSec, reset_time: reset5hModel, quota_source: 'live' },
        { name: 'gemini-pro-orchestrator-argon', model_id: 'gemini-pro-orchestrator-argon', display_name: 'Orchestrator (Argon)', quota_bucket_name: null, percentage: 100, percentage_known: true, own_percentage: 100, own_percentage_known: true, own_reset_time: reset5hModel, own_observed_at: nowSec, reset_time: reset5hModel, quota_source: 'live' },
        { name: 'gemini-3.8-flash-high', model_id: 'gemini-3.8-flash-high', display_name: 'Gemini 3.8 Flash (High)', quota_bucket_name: null, percentage: 100, percentage_known: true, own_percentage: 100, own_percentage_known: true, own_reset_time: reset5hModel, own_observed_at: nowSec, reset_time: reset5hModel, quota_source: 'live' },
      ],
    },
  };

  const laggedOverview = buildAccountQuotaOverview(laggedConsumptionAccount, { nowMs });
  assert.equal(laggedOverview.argonStatus.mode, 'unified');
  assert.equal(laggedOverview.carbonStatus.mode, 'unified');
  assert.equal(laggedOverview.argonStatus.pooledInFamily, 'gemini');
  assert.equal(laggedOverview.carbonStatus.pooledInFamily, 'gemini');
  assert.deepEqual(laggedOverview.standaloneModels, []);
  assert.deepEqual(laggedOverview.projectedQuotaGroups.map(g => g.key), ['gemini', 'claude']);
  assert.equal(computeAccountRemaining(laggedConsumptionAccount, 'argon'), 88);
  assert.equal(computeAccountRemaining(laggedConsumptionAccount, 'carbon'), 88);

  // 场景 C：显式独立 quota_bucket_name 与真实独立模型不被误吞并
  const independentUltraAccount = {
    quota: {
      subscription_tier: 'ULTRA',
      source: 'cloud',
      last_updated: nowSec,
      is_forbidden: false,
      model_forwarding_rules: {},
      quota_groups: [
        {
          display_name: 'Gemini Models',
          family: 'gemini',
          source: 'cloud',
          buckets: [
            { bucket_id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.88, remaining_fraction_known: true, reset_time: resetWeekly, observed_at: nowSec, source: 'cloud' },
          ],
        },
      ],
      models: [
        { name: 'gemini-3.8-flash-high', model_id: 'gemini-3.8-flash-high', display_name: 'Gemini 3.8 Flash (High)', family: 'gemini', percentage: 88, percentage_known: true, own_percentage: 88, own_percentage_known: true, own_reset_time: resetWeekly, own_observed_at: nowSec, reset_time: resetWeekly, quota_source: 'cloud' },
        { name: 'gemini-4-argon', model_id: 'gemini-4-argon', display_name: 'Gemini 4 Argon', family: 'argon', is_argon: true, quota_bucket_name: 'Gemini 4 Argon', percentage: 88, percentage_known: true, own_percentage: 88, own_percentage_known: true, own_reset_time: resetWeekly, own_observed_at: nowSec, reset_time: resetWeekly, quota_source: 'cloud' },
        { name: 'gemini-4-carbon', model_id: 'gemini-4-carbon', display_name: 'Gemini 4 Carbon', family: 'carbon', is_carbon: true, quota_bucket_name: null, percentage: 55, percentage_known: true, own_percentage: 55, own_percentage_known: true, own_reset_time: reset7d, own_observed_at: nowSec, reset_time: reset7d, quota_source: 'cloud' },
        { name: 'gemini-4-xenon', model_id: 'gemini-4-xenon', display_name: 'Gemini 4 Xenon', family: 'other', quota_bucket_name: 'Gemini 4 Xenon', percentage: 42, percentage_known: true, own_percentage: 42, own_percentage_known: true, own_reset_time: reset7d, own_observed_at: nowSec, reset_time: reset7d, quota_source: 'cloud' },
      ],
    },
  };

  const independentOverview = buildAccountQuotaOverview(independentUltraAccount, { nowMs });
  assert.equal(independentOverview.argonStatus.mode, 'standalone');
  assert.equal(independentOverview.carbonStatus.mode, 'standalone');
  assert.deepEqual(independentOverview.standaloneModels.map(m => m.key), ['argon', 'carbon', 'gemini-4-xenon']);

  // 场景 D：Live 探测瞬态未返回套餐时，落盘保持已保存的 ULTRA，不降级丢失
  const { manager, acc } = await createTempManager(t);
  acc.quota = {
    ...driftedFullAccount.quota,
    subscription_tier: 'ULTRA',
  };
  await manager.saveAccount(acc);

  manager.probeLiveLanguageServer = async () => ({
    email: acc.email,
    name: 'Ultra User',
    tier: '',
    quota: {
      ...driftedFullAccount.quota,
      subscription_tier: '',
      refresh_state: {
        complete: true,
        endpointsAttempted: ['live:GetUserStatus', 'live:RetrieveUserQuotaSummary'],
        endpointsSucceeded: ['live:GetUserStatus', 'live:RetrieveUserQuotaSummary'],
        missingFamilies: [],
        missingWindows: [],
        carriedGroups: 0,
        refreshedAt: nowSec,
      },
    },
  });

  const refreshed = await manager.refreshQuota(acc.id, async () => {
    throw new Error('unexpected cloud fallback');
  });
  assert.equal(refreshed.quota?.subscription_tier, 'ULTRA');
  const refreshedOverview = manager.getAccountQuotaOverview(refreshed, { nowMs });
  assert.equal(refreshedOverview.subscriptionTier, 'ULTRA');
  assert.equal(refreshedOverview.argonStatus.mode, 'unified');
  assert.equal(refreshedOverview.carbonStatus.mode, 'unified');
  assert.deepEqual(refreshedOverview.standaloneModels, []);
});

test('跨套餐智能切换推荐自适应：配置 argon 时在 Pro 监测独立 Argon，切到 Free 耗尽时自动兜底基础 Gemini 防瘫痪，切到 Ultra 映射共享池', async t => {
  const { manager, acc: ultraAcc } = await createTempManager(t);
  const nowSec = Math.floor(Date.now() / 1000);
  const nowMs = nowSec * 1000;
  const reset5h = new Date(nowMs + 4 * 3600 * 1000).toISOString();
  const resetWeekly = new Date(nowMs + 5 * 86400 * 1000).toISOString();

  // 1) Ultra 账号：Argon 并入 Gemini 共享池 (85%)
  ultraAcc.email = 'ultra-adaptive@example.test';
  ultraAcc.quota = {
    subscription_tier: 'ULTRA',
    source: 'cloud',
    last_updated: nowSec,
    is_forbidden: false,
    model_forwarding_rules: {},
    quota_groups: [
      {
        display_name: 'Gemini Models',
        family: 'gemini',
        buckets: [
          { bucket_id: 'g-5h', window: '5h', remaining_fraction: 0.85, remaining_fraction_known: true, reset_time: reset5h, observed_at: nowSec, source: 'cloud' },
          { bucket_id: 'g-wk', window: 'weekly', remaining_fraction: 0.85, remaining_fraction_known: true, reset_time: resetWeekly, observed_at: nowSec, source: 'cloud' },
        ],
      },
      {
        display_name: 'Claude/GPT Models',
        family: 'claude',
        buckets: [
          { bucket_id: 'c-5h', window: '5h', remaining_fraction: 0.90, remaining_fraction_known: true, reset_time: reset5h, observed_at: nowSec, source: 'cloud' },
        ],
      },
    ],
    models: [
      { name: 'gemini-3.8-flash', model_id: 'gemini-3.8-flash', family: 'gemini', percentage: 85, percentage_known: true, own_percentage: 85, own_percentage_known: true, own_reset_time: reset5h, own_observed_at: nowSec, reset_time: reset5h },
      { name: 'gemini-4-argon', model_id: 'gemini-4-argon', family: 'argon', is_argon: true, percentage: 85, percentage_known: true, own_percentage: 85, own_percentage_known: true, own_reset_time: reset5h, own_observed_at: nowSec, reset_time: reset5h },
    ],
  };
  await manager.saveAccount(ultraAcc);

  // 2) Pro 账号：基础 Gemini 充足 (80%)，独立 Argon 耗尽偏低 (5%)
  const proAcc = await manager.upsertAccount({
    email: 'pro-adaptive@example.test',
    refreshToken: 'synthetic-refresh-pro',
    accessToken: 'synthetic-access-pro',
    expiresIn: 3600,
  });
  proAcc.quota = {
    subscription_tier: 'PRO',
    source: 'cloud',
    last_updated: nowSec,
    is_forbidden: false,
    model_forwarding_rules: {},
    quota_groups: [
      {
        display_name: 'Gemini Models',
        family: 'gemini',
        buckets: [{ bucket_id: 'g-5h', window: '5h', remaining_fraction: 0.80, remaining_fraction_known: true, reset_time: reset5h, observed_at: nowSec, source: 'cloud' }],
      },
      {
        display_name: 'Gemini 4 Argon',
        family: 'argon',
        buckets: [{ bucket_id: 'a-wk', window: 'weekly', remaining_fraction: 0.05, remaining_fraction_known: true, reset_time: resetWeekly, observed_at: nowSec, source: 'cloud' }],
      },
    ],
    models: [
      { name: 'gemini-3.8-flash', model_id: 'gemini-3.8-flash', family: 'gemini', percentage: 80, percentage_known: true, own_percentage: 80, own_percentage_known: true, own_reset_time: reset5h, own_observed_at: nowSec, reset_time: reset5h },
      { name: 'gemini-4-argon', model_id: 'gemini-4-argon', family: 'argon', is_argon: true, quota_bucket_name: 'Gemini 4 Argon', percentage: 5, percentage_known: true, own_percentage: 5, own_percentage_known: true, own_reset_time: resetWeekly, own_observed_at: nowSec, reset_time: resetWeekly },
    ],
  };
  await manager.saveAccount(proAcc);

  // 3) Free 账号：基础 Gemini 耗尽偏低 (5%)，Argon 禁用
  const freeAcc = await manager.upsertAccount({
    email: 'free-adaptive@example.test',
    refreshToken: 'synthetic-refresh-free',
    accessToken: 'synthetic-access-free',
    expiresIn: 3600,
  });
  freeAcc.quota = {
    subscription_tier: 'FREE',
    source: 'cloud',
    last_updated: nowSec,
    is_forbidden: false,
    model_forwarding_rules: {},
    quota_groups: [
      {
        display_name: 'Gemini Models',
        family: 'gemini',
        buckets: [{ bucket_id: 'g-wk', window: 'weekly', remaining_fraction: 0.05, remaining_fraction_known: true, reset_time: resetWeekly, observed_at: nowSec, source: 'cloud' }],
      },
    ],
    models: [
      { name: 'gemini-3.8-flash', model_id: 'gemini-3.8-flash', family: 'gemini', percentage: 5, percentage_known: true, own_percentage: 5, own_percentage_known: true, own_reset_time: resetWeekly, own_observed_at: nowSec, reset_time: resetWeekly },
      { name: 'gemini-4-argon-disabled', model_id: 'gemini-4-argon-disabled', family: 'argon', is_argon: true, disabled: true, percentage: 0, percentage_known: false, reset_time: '' },
    ],
  };
  await manager.saveAccount(freeAcc);

  // 保存策略为 monitored_model: 'argon'
  await manager.setAutoSwitchConfig({
    enabled: true,
    strategy: 'priority',
    reserve_percentage: 10,
    candidate_min_percentage: 30,
    monitored_model: 'argon',
  });

  // 场景 1：当前激活为 Pro -> 保持监测 argon (5%) 并推荐 Ultra 候选（排除 Argon 禁用的 Free）
  assert.equal(resolveEffectiveMonitoredModel(proAcc, 'argon'), 'argon');
  await manager.setCurrentAccount(proAcc.id);
  const proRec = await manager.selectBestAccount();
  assert.equal(proRec.shouldSwitch, true);
  assert.equal(proRec.bestCandidate?.id, ultraAcc.id);

  // 场景 2：切换到 Free -> 自动兜底为 gemini (5%)，仍正常触发推荐而不静默瘫痪
  assert.equal(resolveEffectiveMonitoredModel(freeAcc, 'argon'), 'gemini');
  assert.equal(resolveEffectiveMonitoredModel(freeAcc, 'gemini_all'), 'gemini');
  await manager.setCurrentAccount(freeAcc.id);
  const freeRec = await manager.selectBestAccount();
  assert.equal(freeRec.shouldSwitch, true);
  assert.equal(freeRec.bestCandidate?.id, ultraAcc.id);

  // 场景 3：切换到 Ultra -> 自动映射为 gemini (85%)，充足不误触发切换
  assert.equal(resolveEffectiveMonitoredModel(ultraAcc, 'argon'), 'gemini');
  assert.equal(resolveEffectiveMonitoredModel(ultraAcc, 'gemini_all'), 'gemini');
  await manager.setCurrentAccount(ultraAcc.id);
  const ultraRec = await manager.selectBestAccount();
  assert.equal(ultraRec.shouldSwitch, false);

  // 原持久化的 monitored_model 保持 'argon' 未被破坏性覆写
  assert.equal((await manager.getAutoSwitchConfig()).monitored_model, 'argon');
});

test('Google AI Ultra 账号 ("Ultra User" ultra@example.invalid) 实机 GetUserStatus 与 loadCodeAssist 回归：planInfo.planName="Pro" 不得覆盖 userTier="g1-ultra-tier"', async t => {
  const { resolveProbeSubscriptionTier } = await import('../dist/account-probe.js');

  // 1. GetUserStatus 实机载荷：planStatus.planInfo.planName 为 "Pro"，真实 Ultra 身份在 userTier / g1Tier
  assert.equal(
    resolveProbeSubscriptionTier({
      email: 'ultra@example.invalid',
      name: 'Ultra User',
      planStatus: { planInfo: { planName: 'Pro', teamsTier: 'TEAMS_TIER_PRO' } },
      userTier: { id: 'g1-ultra-tier', name: 'Google AI Ultra', description: 'Google AI Ultra' },
    }),
    'ULTRA'
  );
  assert.equal(
    resolveProbeSubscriptionTier({
      email: 'ultra@example.invalid',
      planStatus: { planInfo: { planName: 'Pro' } },
      g1Tier: 'g1-ultra-tier',
    }),
    'ULTRA'
  );
  // 真实 Pro 账号保持 PRO
  assert.equal(
    resolveProbeSubscriptionTier({
      email: 'pro@example.test',
      planStatus: { planInfo: { planName: 'Pro' } },
      userTier: { id: 'g1-pro-tier', name: 'Google AI Pro' },
    }),
    'PRO'
  );
  // 企业 Vertex AI 账号保持 ENTERPRISE
  assert.equal(
    resolveProbeSubscriptionTier({
      email: 'corp@example.test',
      planStatus: { planInfo: { planName: 'Enterprise' } },
      userTier: { id: 'agy-business-paygo-tier', name: 'Antigravity Agent Platform', usesGcpTos: true },
    }),
    'ENTERPRISE'
  );

  // 2. loadCodeAssist 中 name="Pro" 但 id="g1-ultra-tier" 时仍识别为 ULTRA
  const { manager, acc } = await createTempManager(t);
  const reset5h = new Date(Date.now() + 3600 * 1000).toISOString();
  const refreshed = await manager.refreshQuota(acc.id, async (url) => {
    if (String(url).includes('loadCodeAssist')) {
      return Response.json({
        currentTier: { id: 'g1-ultra-tier', name: 'Pro' },
      });
    }
    if (String(url).includes('fetchAvailableModels')) {
      return Response.json({
        models: {
          'gemini-4-carbon': {
            displayName: 'Gemini 4 Carbon',
            quotaBucketName: 'Gemini Models',
            quotaInfo: { remainingFraction: 1, resetTime: reset5h },
          },
        },
      });
    }
    return Response.json({
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [{ bucketId: 'g-5h', window: '5h', remainingFraction: 1, resetTime: reset5h }],
        },
      ],
    });
  });
  const overview = manager.getAccountQuotaOverview(refreshed);
  assert.equal(overview.carbonStatus.mode, 'unified');
  const ipcAccount = projectAccountForIpcNormalized(refreshed, manager, { includeOverviewFields: true });
  assert.equal(ipcAccount.subscription_tier, 'ULTRA');
  assert.equal(ipcAccount.quota.subscription_tier, 'ULTRA');
});

test('P0-04 & P1-16 & P2-20: 订阅到期 PRO/ULTRA->FREE 真实降级同步、残缺探测防误降级、摘要态凭据就绪与新一代 3P 家族归类', async t => {
  const { mergeSubscriptionTier } = await import('../dist/account-probe.js');
  const { projectAccountForIpc } = await import('../dist/account-quota.js');

  // 1) mergeSubscriptionTier 单元契约
  assert.equal(mergeSubscriptionTier('FREE', 'PRO', true), 'FREE', '完整探测确认降级为 FREE 时必须更新为 FREE');
  assert.equal(mergeSubscriptionTier('FREE', 'ULTRA', true), 'FREE', '完整探测确认 ULTRA 到期降级为 FREE 时必须更新为 FREE');
  assert.equal(mergeSubscriptionTier('FREE', 'PRO', false), 'PRO', '残缺探测临时回落 FREE 时保留已验证历史等级 PRO');
  assert.equal(mergeSubscriptionTier('', 'ULTRA', true), 'ULTRA', '未返回套餐字段时保留历史等级 ULTRA');
  assert.equal(mergeSubscriptionTier('PRO', 'ULTRA', true), 'PRO', 'ULTRA 降为 PRO 时同步更新为 PRO');

  // 2) AccountsManager.refreshQuota 端到端降级验证：曾为 ULTRA 的账号到期变为 Starter/Free 后，徽章与配额视图必须同步为 FREE
  const { manager, acc } = await createTempManager(t);
  const reset5h = new Date(Date.now() + 3600 * 1000).toISOString();
  acc.quota = {
    subscription_tier: 'ULTRA',
    source: 'cloud',
    last_updated: Math.floor(Date.now() / 1000) - 600,
    is_forbidden: false,
    model_forwarding_rules: {},
    models: [],
  };
  await manager.saveAccount(acc);

  const downgraded = await manager.refreshQuota(acc.id, async (url) => {
    if (String(url).includes('loadCodeAssist')) {
      return Response.json({ currentTier: { id: 'g1-free-tier', name: 'Free' } });
    }
    if (String(url).includes('fetchAvailableModels')) {
      return Response.json({
        models: {
          'gemini-3.8-flash': { displayName: 'Gemini 3.8 Flash', quotaInfo: { remainingFraction: 0.8, resetTime: reset5h } },
          'o5-mini': { displayName: 'OpenAI o5-mini', quotaInfo: { remainingFraction: 0.6, resetTime: reset5h } },
          'deepseek-r1': { displayName: 'DeepSeek R1', quotaInfo: { remainingFraction: 0.6, resetTime: reset5h } },
        },
      });
    }
    return Response.json({
      groups: [
        { displayName: 'Gemini Models', buckets: [{ bucketId: 'g-5h', window: '5h', remainingFraction: 0.8, resetTime: reset5h }] },
        { displayName: 'Third-Party Models', buckets: [{ bucketId: '3p-5h', window: '5h', remainingFraction: 0.6, resetTime: reset5h }] },
      ],
    });
  });
  assert.equal(downgraded.quota?.subscription_tier, 'Free');
  const downgradedOverview = manager.getAccountQuotaOverview(downgraded);
  assert.equal(downgradedOverview.subscriptionTier, 'FREE');
  const downgradedIpc = projectAccountForIpcNormalized(downgraded, manager, { includeOverviewFields: true });
  assert.equal(downgradedIpc.subscription_tier, 'FREE');
  assert.equal(downgradedIpc.quota.subscription_tier, 'FREE');
  // o5-mini 与 deepseek-r1 归入共享第三方池 claude，不误拆为 standaloneModels
  assert.deepEqual(downgradedOverview.standaloneModels, []);
  assert.deepEqual(downgradedOverview.projectedQuotaGroups.map(g => g.key), ['gemini', 'claude']);

  // 3) P1-16: 不含 token 字段的 AccountSummary 投影不得误判为 needs_refresh
  const summaryProjected = projectAccountForIpc({
    id: 'summary-only-id',
    email: 'summary@example.test',
    name: 'Summary User',
    created_at: 1700000000,
    last_used: 1700000100,
  });
  assert.equal(summaryProjected.credentialReadiness.state, 'ready');
});

test('1.1.1 终审回归: computeAccountRemaining 含 Argon 别名对齐与云端不完整刷新防套餐误降级', async t => {
  const { manager, acc } = await createTempManager(t);
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const reset5h = new Date(nowMs + 3 * 3600 * 1000).toISOString();
  const resetWeekly = new Date(nowMs + 5 * 86400 * 1000).toISOString();

  acc.quota = {
    subscription_tier: 'PRO',
    source: 'cloud',
    last_updated: nowSec - 120,
    is_forbidden: false,
    model_forwarding_rules: {},
    quota_groups: [
      {
        display_name: 'Gemini Models',
        family: 'gemini',
        buckets: [{ bucket_id: 'g-5h', window: '5h', remaining_fraction: 0.75, remaining_fraction_known: true, reset_time: reset5h, observed_at: nowSec, source: 'cloud' }],
      },
      {
        display_name: 'Gemini 4 Argon',
        family: 'argon',
        buckets: [{ bucket_id: 'a-wk', window: 'weekly', remaining_fraction: 0.35, remaining_fraction_known: true, reset_time: resetWeekly, observed_at: nowSec, source: 'cloud' }],
      },
    ],
    models: [
      { name: 'gemini-3.8-flash', model_id: 'gemini-3.8-flash', family: 'gemini', percentage: 75, percentage_known: true, own_percentage: 75, own_percentage_known: true, own_reset_time: reset5h, own_observed_at: nowSec, reset_time: reset5h },
      { name: 'gemini-4-argon', model_id: 'gemini-4-argon', family: 'argon', is_argon: true, quota_bucket_name: 'Gemini 4 Argon', percentage: 35, percentage_known: true, own_percentage: 35, own_percentage_known: true, own_reset_time: resetWeekly, own_observed_at: nowSec, reset_time: resetWeekly },
    ],
  };
  await manager.saveAccount(acc);

  // 1. P1-12: 含 Argon 的中英文全系别名与 gemini_all 结果严格一致
  assert.equal(computeAccountRemaining(acc, 'Gemini 全系（含 Argon）'), 35);
  assert.equal(computeAccountRemaining(acc, 'All Gemini (incl. Argon)'), 35);

  // 2. P1-9: 云端生产端点失败仅 fallback 端点返回且 loadCodeAssist 临时返回 Starter/Free 时（complete=false），保留原 PRO 不误降级
  const partialRefreshed = await manager.refreshQuota(acc.id, async (url) => {
    const u = String(url);
    if (u.includes('cloudcode-pa.googleapis.com') && !u.includes('daily-cloudcode-pa')) {
      return new Response('Service Unavailable', { status: 503 });
    }
    if (u.includes('loadCodeAssist')) {
      return Response.json({ currentTier: { id: 'starter', name: 'Starter' } });
    }
    if (u.includes('fetchAvailableModels')) {
      return Response.json({
        models: {
          'gemini-3.8-flash': { displayName: 'Gemini 3.8 Flash', quotaInfo: { remainingFraction: 0.70, resetTime: reset5h } },
        },
      });
    }
    return Response.json({
      groups: [
        { displayName: 'Gemini Models', buckets: [{ bucketId: 'g-5h', window: '5h', remainingFraction: 0.70, resetTime: reset5h }] },
      ],
    });
  });
  assert.equal(partialRefreshed.quota?.refresh_state?.complete, false);
  assert.equal(partialRefreshed.quota?.subscription_tier, 'PRO', '不完整云端回退刷新不得把已存 PRO 误降级为 FREE');
});

test('新代号模型归入 Gemini 池（不再凭代号硬踢为 other）、编排器元模型识别与跨套餐动态兜底', async t => {
  const { classifyFamily, isOrchestratorMetaModel } = await import('../dist/quota.js');
  assert.equal(classifyFamily({ modelId: 'gemini-4-neon', displayName: 'Gemini 4 Neon' }), 'gemini');
  assert.equal(classifyFamily({ modelId: 'gemini-5-nova', displayName: 'Gemini 5 Nova' }), 'gemini');
  assert.equal(classifyFamily({ modelId: 'gemini-pro-orchestrator-neon', displayName: 'Orchestrator (Neon)' }), 'gemini');
  assert.equal(classifyFamily({ modelId: 'gemini-pro-orchestrator-neon' }), 'gemini');
  assert.equal(classifyFamily({ modelId: 'opaque-google-id', modelProvider: 'MODEL_PROVIDER_GOOGLE' }), 'gemini');
  assert.equal(classifyFamily({ modelId: 'opaque-anthropic-id', modelProvider: 'MODEL_PROVIDER_ANTHROPIC' }), 'claude');
  assert.equal(classifyFamily({ modelId: 'opaque-openai-id', modelProvider: 'MODEL_PROVIDER_OPENAI' }), 'claude');

  assert.equal(isOrchestratorMetaModel('gemini-pro-coordinator'), true);
  assert.equal(isOrchestratorMetaModel('gemini-pro-orchestrator'), true);
  assert.equal(isOrchestratorMetaModel('gemini-pro-orchestrator-neon', 'Orchestrator (Neon)'), true);
  assert.equal(isOrchestratorMetaModel('any-id', 'Orchestrator (Carbon)'), true);
  assert.equal(isOrchestratorMetaModel('any-id', 'Orchestrator Neon'), true);
  assert.equal(isOrchestratorMetaModel('gemini-4-neon', 'Gemini 4 Neon'), false);

  const nowSec = Math.floor(Date.now() / 1000);
  const reset5h = new Date((nowSec + 3600) * 1000).toISOString();
  const reset7d = new Date((nowSec + 7 * 86400) * 1000).toISOString();

  // 1. Pro 下拥有显式独立 quota_bucket_name: "Gemini 4 Neon" 时仍识别为独立池
  const proWithNeon = {
    id: 'pro-neon',
    email: 'pro-neon@example.invalid',
    disabled: false,
    protected_models: [],
    created_at: nowSec,
    last_used: nowSec,
    quota: {
      subscription_tier: 'PRO',
      source: 'cloud',
      last_updated: nowSec,
      is_forbidden: false,
      model_forwarding_rules: {},
      quota_groups: [
        {
          display_name: 'Gemini Models',
          family: 'gemini',
          buckets: [{ bucket_id: 'g-5h', window: '5h', remaining_fraction: 1, remaining_fraction_known: true, reset_time: '' }],
        },
      ],
      models: [
        { name: 'gemini-3.8-flash', model_id: 'gemini-3.8-flash', family: 'gemini', percentage: 100, percentage_known: true, own_percentage: 100, own_percentage_known: true, own_reset_time: '', reset_time: '' },
        { name: 'gemini-4-neon-high', model_id: 'gemini-4-neon-high', display_name: 'Gemini 4 Neon (High)', quota_bucket_name: 'Gemini 4 Neon', percentage: 100, percentage_known: true, own_percentage: 100, own_percentage_known: true, own_reset_time: '', reset_time: '' },
      ],
    },
  };
  const proOverview = buildAccountQuotaOverview(proWithNeon);
  assert.deepEqual(proOverview.standaloneModels.map(m => m.key), ['gemini-4-neon']);
  assert.equal(resolveEffectiveMonitoredModel(proWithNeon, 'gemini-4-neon'), 'gemini-4-neon');
  assert.equal(computeAccountRemaining(proWithNeon, 'gemini-4-neon'), 100);

  // 2. 切到 Ultra（Neon 已并入 Gemini 池）与 Free（无 Neon 权限）时，运行时自动映射/兜底至 gemini，且编排器绝不生成独立池
  const ultraWithPooledNeon = {
    id: 'ultra-neon',
    email: 'ultra-neon@example.invalid',
    disabled: false,
    protected_models: [],
    created_at: nowSec,
    last_used: nowSec,
    quota: {
      subscription_tier: 'ULTRA',
      source: 'live',
      last_updated: nowSec,
      is_forbidden: false,
      model_forwarding_rules: {},
      quota_groups: [
        {
          display_name: 'Gemini Models',
          description: 'Models within this group: Gemini 4 Neon, Gemini 4 Carbon, Gemini 4 Argon, Gemini 3.8 Flash',
          family: 'gemini',
          buckets: [{ bucket_id: 'g-5h', window: '5h', remaining_fraction: 0.72, remaining_fraction_known: true, reset_time: reset5h }],
        },
      ],
      models: [
        { name: 'gemini-3.8-flash', model_id: 'gemini-3.8-flash', family: 'gemini', percentage: 72, percentage_known: true, own_percentage: 72, own_percentage_known: true, own_reset_time: reset5h, reset_time: reset5h },
        { name: 'gemini-4-neon-high', model_id: 'gemini-4-neon-high', display_name: 'Gemini 4 Neon (High)', percentage: 72, percentage_known: true, own_percentage: 72, own_percentage_known: true, own_reset_time: reset5h, reset_time: reset5h },
        { name: 'gemini-pro-orchestrator-neon', model_id: 'gemini-pro-orchestrator-neon', display_name: 'Orchestrator (Neon)', percentage: 100, percentage_known: true, own_percentage: 100, own_percentage_known: true, own_reset_time: reset7d, reset_time: reset7d },
      ],
    },
  };
  const freeWithoutNeon = {
    id: 'free-no-neon',
    email: 'free@example.invalid',
    disabled: false,
    protected_models: [],
    created_at: nowSec,
    last_used: nowSec,
    quota: {
      subscription_tier: 'FREE',
      source: 'cloud',
      last_updated: nowSec,
      is_forbidden: false,
      model_forwarding_rules: {},
      quota_groups: [
        {
          display_name: 'Gemini Models',
          family: 'gemini',
          buckets: [{ bucket_id: 'g-wk', window: 'weekly', remaining_fraction: 0.05, remaining_fraction_known: true, reset_time: reset7d }],
        },
      ],
      models: [
        { name: 'gemini-3.8-flash', model_id: 'gemini-3.8-flash', family: 'gemini', percentage: 5, percentage_known: true, own_percentage: 5, own_percentage_known: true, own_reset_time: reset7d, reset_time: reset7d },
        { name: 'gemini-4-neon', model_id: 'gemini-4-neon', disabled: true, percentage: 0, percentage_known: false, reset_time: '' },
      ],
    },
  };

  assert.deepEqual(buildAccountQuotaOverview(ultraWithPooledNeon).standaloneModels, []);
  assert.equal(resolveEffectiveMonitoredModel(ultraWithPooledNeon, 'gemini-4-neon'), 'gemini');
  assert.equal(resolveEffectiveMonitoredModel(freeWithoutNeon, 'gemini-4-neon'), 'gemini');
  assert.equal(computeAccountRemaining(ultraWithPooledNeon, 'gemini-4-neon'), 72);
  assert.equal(computeAccountRemaining(freeWithoutNeon, 'gemini-4-neon'), null);
});

test('OPT-03 & OPT-10：错误码透传防超时误判重新授权、PRO 词边界、hydrogen 品牌与未保存层级对称对齐', async (t) => {
  const { manager, acc } = await createTempManager(t);
  acc.quota_refresh_error = 'context deadline expired';
  acc.quota_refresh_error_code = 'network';
  await manager.saveAccount(acc);

  // 验证 saveAccount -> loadIndex -> listAccounts 全链路保留 quota_refresh_error_code 且不误判 needs_authorization
  const listed = await manager.listAccounts();
  const item = listed.accounts.find(a => a.id === acc.id);
  assert.equal(item?.quota_refresh_error_code, 'network');
  assert.notEqual(item?.credentialReadiness?.state, 'needs_authorization');

  // 显式鉴权失败码仍判 needs_authorization
  assert.equal(
    accountCredentialReadiness({
      ...acc,
      quota_refresh_error_code: 'refresh_failed',
      quota_refresh_error: 'transient text',
    }).state,
    'needs_authorization'
  );
  // 无结构化错误码时，TLS 证书过期不误判，refresh token 过期正确判 needs_authorization
  assert.notEqual(
    accountCredentialReadiness({
      ...acc,
      quota_refresh_error_code: null,
      quota_refresh_error: 'TLS certificate has expired',
    }).state,
    'needs_authorization'
  );
  assert.equal(
    accountCredentialReadiness({
      ...acc,
      quota_refresh_error_code: null,
      quota_refresh_error: 'refresh token has expired',
    }).state,
    'needs_authorization'
  );

  // OPT-10：PRO 词边界防护 & hydrogen 品牌映射 & 未保存账号层级对称判定
  assert.equal(normalizeCatalogTierLabel('Prototype Internal'), '');
  assert.equal(normalizeCatalogTierLabel('Google AI Pro'), 'PRO');
  assert.notEqual(subscriptionTierRank({ quota: { subscription_tier: 'Prototype' } }), 3);
  assert.equal(subscriptionTierRank({ quota: { subscription_tier: 'PRO' } }), 3);

  assert.equal(
    resolveUnsavedLiveSubscriptionTier(
      { tier: 'FREE', accountType: 'consumer' },
      { subscriptionTier: 'FREE', models: [{ name: 'gemini-3.8-flash' }] }
    ),
    'FREE'
  );
  assert.equal(
    resolveUnsavedLiveSubscriptionTier(
      { tier: 'FREE', accountType: 'enterprise_vertex' },
      { subscriptionTier: 'FREE', models: [{ name: 'gemini-3.8-flash' }] }
    ),
    '待确认'
  );
});

test('2.34.0 实机污染快照零刷新自愈：Orchestrator (Neon) 与 family:other 的 Gemini 4 Neon 立即收敛为 2 组核心池', async () => {
  const { computeAccountRevision } = await import('../dist/account-quota.js');
  const nowSec = Math.floor(Date.now() / 1000);
  const nowMs = nowSec * 1000;
  const reset5h = new Date(nowMs + 4 * 3600 * 1000 + 25 * 60 * 1000).toISOString();
  const resetWeekly = new Date(nowMs + 4 * 86400 * 1000).toISOString();
  const staleOrchReset = new Date(nowMs + 3 * 3600 * 1000 + 48 * 60 * 1000).toISOString();
  const staleObserved = nowSec - 1200;

  // 精确复现 #5 实机 accounts/<id>.json 污染结构
  const pollutedAccount = {
    id: '2e6ef14c-polluted',
    email: 'ultra-real@example.invalid',
    disabled: false,
    protected_models: [],
    created_at: nowSec - 86400,
    last_used: nowSec,
    quota: {
      subscription_tier: 'ULTRA',
      source: 'cloud',
      last_updated: nowSec,
      is_forbidden: false,
      model_forwarding_rules: {},
      quota_groups: [
        {
          display_name: 'Gemini Models',
          description: 'Models within this group: Gemini 4 Neon, Gemini 4 Carbon, Gemini 4 Argon, Gemini 4 Hydrogen, Gemini 3.8 Flash',
          family: 'gemini',
          observed_at: nowSec,
          source: 'cloud',
          buckets: [
            { bucket_id: 'gemini-5h', window: '5h', remaining_fraction: 0.98, remaining_fraction_known: true, reset_time: reset5h, observed_at: nowSec, source: 'cloud' },
            { bucket_id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.46, remaining_fraction_known: true, reset_time: resetWeekly, observed_at: nowSec, source: 'cloud' },
          ],
        },
        {
          display_name: 'Claude and GPT models',
          description: 'Models within this group: Claude Opus 5.5, Claude Sonnet 5.5, GPT-OSS 120B',
          family: 'claude',
          observed_at: nowSec,
          source: 'cloud',
          buckets: [
            { bucket_id: '3p-5h', window: '5h', remaining_fraction: 1, remaining_fraction_known: true, reset_time: reset5h, observed_at: nowSec, source: 'cloud' },
            { bucket_id: '3p-weekly', window: 'weekly', remaining_fraction: 0.92, remaining_fraction_known: true, reset_time: resetWeekly, observed_at: nowSec, source: 'cloud' },
          ],
        },
      ],
      models: [
        {
          name: 'gemini-pro-orchestrator-neon',
          model_id: 'gemini-pro-orchestrator-neon',
          model_or_alias: 'MODEL_PLACEHOLDER_M537',
          display_name: 'Orchestrator (Neon)',
          family: 'other',
          quota_source: 'carried',
          stale: true,
          own_stale: true,
          recommended: false,
          disabled: null,
          own_percentage: 100,
          own_percentage_known: true,
          percentage: 0,
          percentage_known: false,
          own_observed_at: staleObserved,
          own_reset_time: staleOrchReset,
          reset_time: '',
          family_5h: null,
          family_weekly: null,
        },
        {
          name: 'gemini-4-neon-high',
          model_id: 'gemini-4-neon-high',
          model_or_alias: 'MODEL_PLACEHOLDER_M534',
          display_name: 'Gemini 4 Neon (High)',
          family: 'other',
          quota_source: 'cloud',
          stale: false,
          own_stale: false,
          disabled: false,
          own_percentage: 98,
          own_percentage_known: true,
          percentage: 98,
          percentage_known: true,
          own_observed_at: nowSec,
          own_reset_time: reset5h,
          reset_time: reset5h,
          family_5h: null,
          family_weekly: null,
        },
        {
          name: 'gemini-4-argon-high',
          model_id: 'gemini-4-argon-high',
          display_name: 'Gemini 4 Argon (High)',
          family: 'argon',
          is_argon: true,
          quota_source: 'cloud',
          stale: false,
          own_stale: false,
          disabled: false,
          own_percentage: 98,
          own_percentage_known: true,
          own_observed_at: nowSec,
          own_reset_time: reset5h,
          reset_time: reset5h,
        },
        {
          name: 'gemini-4-carbon-high',
          model_id: 'gemini-4-carbon-high',
          display_name: 'Gemini 4 Carbon (High)',
          family: 'carbon',
          is_carbon: true,
          quota_source: 'cloud',
          stale: false,
          own_stale: false,
          disabled: false,
          own_percentage: 98,
          own_percentage_known: true,
          own_observed_at: nowSec,
          own_reset_time: reset5h,
          reset_time: reset5h,
        },
        {
          name: 'claude-opus-5-5',
          model_id: 'claude-opus-5-5',
          display_name: 'Claude Opus 5.5',
          family: 'claude',
          quota_source: 'cloud',
          stale: false,
          own_stale: false,
          disabled: false,
          own_percentage: 100,
          own_percentage_known: true,
          own_observed_at: nowSec,
          own_reset_time: reset5h,
          reset_time: reset5h,
        },
      ],
    },
  };

  // 不经任何刷新直接读取：立即自愈
  const overview = buildAccountQuotaOverview(pollutedAccount, { nowMs });
  assert.deepEqual(overview.standaloneModels, []);
  assert.deepEqual(overview.projectedQuotaGroups.map(g => g.key), ['gemini', 'claude']);
  assert.match(overview.projectedQuotaGroups[0].description ?? '', /Gemini 4 Neon/);
  assert.equal(overview.argonStatus.mode, 'unified');
  assert.equal(overview.carbonStatus.mode, 'unified');
  const neonModel = overview.models.find(m => m.model_id === 'gemini-4-neon-high');
  assert.equal(neonModel?.family, 'gemini');
  assert.equal(neonModel?.family_5h?.remaining, 0.98);
  assert.equal(neonModel?.family_weekly?.remaining, 0.46);
  assert.equal(neonModel?.effective_percentage, 46);
  const rev = computeAccountRevision(pollutedAccount);
  assert.equal(typeof rev, 'string');
  assert.equal(rev.length, 16);
});

test('下次刷新彻底清除已下线编排器僵尸模型与撤销的非核心独立组，且有权威 groups[] 时不探测 :retrieveUserQuota', async t => {
  const { manager, acc } = await createTempManager(t);
  const nowSec = Math.floor(Date.now() / 1000);
  const nowMs = nowSec * 1000;
  const reset5h = new Date(nowMs + 4 * 3600 * 1000).toISOString();
  const resetWeekly = new Date(nowMs + 5 * 86400 * 1000).toISOString();

  // 预置带历史僵尸模型与历史非核心组的快照
  acc.quota = {
    subscription_tier: 'ULTRA',
    source: 'cloud',
    last_updated: nowSec - 600,
    is_forbidden: false,
    model_forwarding_rules: {},
    quota_groups: [
      {
        display_name: 'Gemini Models',
        family: 'gemini',
        observed_at: nowSec - 600,
        buckets: [{ bucket_id: 'gemini-5h', window: '5h', remaining_fraction: 0.9, remaining_fraction_known: true, reset_time: reset5h, observed_at: nowSec - 600 }],
      },
      {
        display_name: 'Legacy Promo Models',
        family: 'other',
        observed_at: nowSec - 600,
        buckets: [{ bucket_id: 'promo-weekly', window: 'weekly', remaining_fraction: 0.5, remaining_fraction_known: true, reset_time: resetWeekly, observed_at: nowSec - 600 }],
      },
    ],
    models: [
      {
        name: 'gemini-pro-orchestrator-neon',
        model_id: 'gemini-pro-orchestrator-neon',
        display_name: 'Orchestrator (Neon)',
        family: 'other',
        quota_source: 'carried',
        stale: true,
        own_stale: true,
        own_percentage: 100,
        own_percentage_known: true,
        own_observed_at: nowSec - 1200,
        own_reset_time: reset5h,
        percentage: 0,
        percentage_known: false,
        reset_time: '',
      },
      {
        name: 'legacy-vanished-model',
        model_id: 'legacy-vanished-model',
        display_name: 'Legacy Vanished',
        family: 'other',
        quota_source: 'carried',
        stale: true,
        own_stale: true,
        own_percentage: 50,
        own_percentage_known: true,
        own_observed_at: nowSec - 1200,
        own_reset_time: resetWeekly,
        percentage: 0,
        percentage_known: false,
        reset_time: '',
      },
    ],
  };
  await manager.saveAccount(acc);

  const seenUrls = [];
  const refreshed = await manager.refreshQuota(acc.id, async (url) => {
    const u = String(url);
    seenUrls.push(u);
    if (u.includes('loadCodeAssist')) {
      return Response.json({ paidTier: { id: 'g1-ultra-tier', name: 'Google AI Ultra' } });
    }
    if (u.includes('fetchAvailableModels')) {
      return Response.json({
        models: {
          'gemini-4-neon-high': { displayName: 'Gemini 4 Neon (High)', modelProvider: 'MODEL_PROVIDER_GOOGLE', quotaInfo: { remainingFraction: 0.95, resetTime: reset5h } },
          'gemini-3.8-flash': { displayName: 'Gemini 3.8 Flash', modelProvider: 'MODEL_PROVIDER_GOOGLE', quotaInfo: { remainingFraction: 0.95, resetTime: reset5h } },
          'claude-sonnet-5-5': { displayName: 'Claude Sonnet 5.5', modelProvider: 'MODEL_PROVIDER_ANTHROPIC', quotaInfo: { remainingFraction: 0.88, resetTime: resetWeekly } },
          'opaque-unlisted-model': { displayName: 'Opaque Model', quotaInfo: {} },
        },
      });
    }
    return Response.json({
      groups: [
        {
          displayName: 'Gemini Models',
          description: 'Models within this group: Gemini 4 Neon, Gemini 3.8 Flash',
          buckets: [
            { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.95, resetTime: reset5h },
            { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.7, resetTime: resetWeekly },
          ],
        },
        {
          displayName: 'Claude and GPT models',
          description: 'Models within this group: Claude Sonnet 5.5',
          buckets: [
            { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0.88, resetTime: resetWeekly },
          ],
        },
      ],
    });
  });

  assert.equal(seenUrls.some(u => u.endsWith(':retrieveUserQuota')), false, '权威 groups[] 存在时不得为 other/orchestrator 探测 :retrieveUserQuota');
  assert.equal(refreshed.quota.models.some(m => m.model_id === 'gemini-pro-orchestrator-neon'), false);
  assert.equal(refreshed.quota.models.some(m => m.model_id === 'legacy-vanished-model'), false);
  assert.equal(refreshed.quota.refresh_state.carriedModels, 0);
  assert.equal(refreshed.quota.refresh_state.carriedGroups, 0);
  assert.equal(refreshed.quota.quota_groups.some(g => g.display_name === 'Legacy Promo Models'), false);
  assert.equal(refreshed.quota.refresh_state.complete, true);

  const overview = manager.getAccountQuotaOverview(refreshed);
  assert.deepEqual(overview.standaloneModels, []);
  assert.deepEqual(overview.projectedQuotaGroups.map(g => g.key), ['gemini', 'claude']);
});

test('未来未知官方 QuotaSummaryGroup 自动适配：保留全部 5h/daily/weekly 窗口、resetTime 与 description，自动跳过全 disabled 组', async () => {
  const { classifyWindow, normalizeCloudGroups } = await import('../dist/quota.js');
  assert.equal(classifyWindow('daily', 'nova-daily'), 'daily');
  assert.equal(classifyWindow('24h', 'pool-24h'), 'daily');
  assert.equal(classifyWindow('1d', 'pool-1d'), 'daily');

  const nowSec = Math.floor(Date.now() / 1000);
  const nowMs = nowSec * 1000;
  const reset5h = new Date(nowMs + 3 * 3600 * 1000).toISOString();
  const resetDaily = new Date(nowMs + 18 * 3600 * 1000).toISOString();
  const resetWeekly = new Date(nowMs + 5 * 86400 * 1000).toISOString();

  const parsedGroups = normalizeCloudGroups({
    groups: [
      {
        groupId: 'gemini-core',
        displayName: 'Gemini Models',
        description: 'Models within this group: Gemini 4 Neon, Gemini 3.8 Flash',
        buckets: [{ bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.9, resetTime: reset5h }],
      },
      {
        groupId: 'nova-pool',
        displayName: 'Nova Models',
        description: 'Models within this group: Nova 1 Pro, Nova 1 Flash',
        buckets: [
          { bucketId: 'nova-5h', window: '5h', remainingFraction: 0.82, resetTime: reset5h },
          { bucketId: 'nova-weekly', window: 'weekly', remainingFraction: 0.4, resetTime: resetWeekly },
          { bucketId: 'nova-disabled', window: 'daily', remainingFraction: 0, disabled: true, resetTime: resetDaily },
        ],
      },
      {
        groupId: 'pulse-daily',
        displayName: 'Pulse Daily Pool',
        description: 'Models within this group: Pulse 2',
        buckets: [
          { bucketId: 'pulse-24h', window: 'daily', remainingFraction: 0.65, resetTime: resetDaily },
        ],
      },
      {
        groupId: 'gemini-orion',
        displayName: 'Gemini 5 Orion',
        description: 'Models within this group: Gemini 5 Orion',
        buckets: [
          { bucketId: 'orion-weekly', window: 'weekly', remainingFraction: 0.55, resetTime: resetWeekly },
        ],
      },
      {
        groupId: 'disabled-exp',
        displayName: 'Disabled Experimental',
        buckets: [
          { bucketId: 'exp-weekly', window: 'weekly', remainingFraction: 0, disabled: true, resetTime: resetWeekly },
        ],
      },
    ],
  }, nowSec);

  assert.equal(parsedGroups.find(g => g.display_name === 'Nova Models')?.group_id, 'nova-pool');
  assert.equal(parsedGroups.find(g => g.display_name === 'Gemini 5 Orion')?.family, 'other');

  const overview = buildAccountQuotaOverview({
    quota: {
      subscription_tier: 'PRO',
      source: 'cloud',
      last_updated: nowSec,
      is_forbidden: false,
      model_forwarding_rules: {},
      quota_groups: parsedGroups.map(g => ({
        group_id: g.group_id,
        display_name: g.display_name,
        description: g.description,
        family: g.family,
        observed_at: nowSec,
        source: 'cloud',
        buckets: g.buckets.map(b => ({
          bucket_id: b.bucket_id,
          window: b.window,
          remaining_fraction: b.remaining_fraction ?? 0,
          remaining_fraction_known: b.remaining_fraction_known,
          reset_time: b.reset_time ?? '',
          disabled: b.disabled,
          observed_at: nowSec,
          source: 'cloud',
        })),
      })),
      models: [
        { name: 'gemini-4-neon', model_id: 'gemini-4-neon', display_name: 'Gemini 4 Neon', family: 'gemini', percentage: 90, percentage_known: true, own_percentage: 90, own_percentage_known: true, own_reset_time: reset5h, reset_time: reset5h },
        { name: 'nova-1-pro', model_id: 'nova-1-pro', display_name: 'Nova 1 Pro', family: 'other', percentage: 82, percentage_known: true, own_percentage: 82, own_percentage_known: true, own_reset_time: reset5h, reset_time: reset5h },
        { name: 'pulse-2', model_id: 'pulse-2', display_name: 'Pulse 2', family: 'other', percentage: 65, percentage_known: true, own_percentage: 65, own_percentage_known: true, own_reset_time: resetDaily, reset_time: resetDaily },
      ],
    },
  }, { nowMs });

  const keys = overview.projectedQuotaGroups.map(g => g.key);
  assert.deepEqual(keys, ['gemini', 'nova-models', 'pulse-daily-pool', 'gemini-5-orion']);
  assert.equal(keys.includes('disabled-experimental'), false, '全 disabled 桶的官方组应自动跳过');

  const nova = overview.projectedQuotaGroups.find(g => g.key === 'nova-models');
  assert.equal(nova.isStandalone, true);
  assert.equal(nova.description, 'Models within this group: Nova 1 Pro, Nova 1 Flash');
  assert.deepEqual(nova.windows.map(w => w.period), ['5h', 'weekly']);
  assert.equal(nova.windows[0].remaining, 0.82);
  assert.equal(nova.windows[0].resetTime, reset5h);
  assert.equal(nova.windows[1].remaining, 0.4);
  assert.equal(nova.windows[1].resetTime, resetWeekly);

  const pulse = overview.projectedQuotaGroups.find(g => g.key === 'pulse-daily-pool');
  assert.deepEqual(pulse.windows.map(w => w.period), ['daily']);
  assert.equal(pulse.windows[0].remaining, 0.65);
  assert.equal(pulse.windows[0].resetTime, resetDaily);

  const orion = overview.projectedQuotaGroups.find(g => g.key === 'gemini-5-orion');
  assert.deepEqual(orion.windows.map(w => w.period), ['weekly']);
  assert.equal(orion.windows[0].remaining, 0.55);
  assert.equal(orion.windows[0].resetTime, resetWeekly);
});

test('上游元数据过滤：isInternal、deprecatedModelIds、非对话专用清单与编排器元模型绝不成为独立池', async () => {
  const { normalizeIndependentArgonQuota, buildStandaloneModels, familyWindowsFromGroups, applyFamilyWindows } = await import('../dist/quota.js');
  const nowSec = Math.floor(Date.now() / 1000);
  const nowMs = nowSec * 1000;
  const reset = new Date(nowMs + 3600 * 1000).toISOString();

  // 1. normalizeIndependentArgonQuota 拒绝所有编排器条目
  const indRows = normalizeIndependentArgonQuota({
    buckets: [
      { modelId: 'gemini-pro-orchestrator-neon', displayName: 'Orchestrator (Neon)', remainingFraction: 1, resetTime: reset },
      { modelId: 'gemini-pro-orchestrator-argon', displayName: 'Orchestrator (Argon)', remainingFraction: 1, resetTime: reset },
      { modelId: 'gemini-pro-coordinator', displayName: 'Orchestrator', remainingFraction: 1, resetTime: reset },
      { modelId: 'gemini-4-neon', displayName: 'Gemini 4 Neon', remainingFraction: 0.9, resetTime: reset },
      { modelId: 'gemini-4-argon', displayName: 'Gemini 4 Argon', remainingFraction: 0.4, resetTime: reset },
    ],
  }, nowSec);
  assert.deepEqual(indRows.map(r => r.model_id), ['gemini-4-argon']);

  // 2. normalizeCloudModels 提取 isInternal / deprecated / non_chat_specialized / beyondModelInfo / agentModelSorts
  const cloudModels = normalizeCloudModels({
    deprecatedModelIds: { 'legacy-dep-1': { newModelId: 'gemini-4-neon' } },
    tabModelIds: ['tab-autocomplete-v2'],
    imageGenerationModelIds: ['imagen-special-v1'],
    webSearchModelIds: ['web-search-helper'],
    agentModelSorts: [{ groups: [{ modelIds: ['gemini-4-neon', 'custom-user-model'] }] }],
    models: {
      'internal-secret-model': { displayName: 'Internal Secret', isInternal: true, quotaBucketName: 'Internal Bucket', quotaInfo: { remainingFraction: 0.5, resetTime: reset } },
      'legacy-dep-1': { displayName: 'Legacy Dep', quotaBucketName: 'Legacy Bucket', quotaInfo: { remainingFraction: 0.5, resetTime: reset } },
      'tab-autocomplete-v2': { displayName: 'Tab Complete', quotaBucketName: 'Tab Bucket', quotaInfo: { remainingFraction: 0.5, resetTime: reset } },
      'imagen-special-v1': { displayName: 'Imagen Special', quotaBucketName: 'Imagen Bucket', quotaInfo: { remainingFraction: 0.5, resetTime: reset } },
      'web-search-helper': { displayName: 'Web Search', quotaBucketName: 'Search Bucket', quotaInfo: { remainingFraction: 0.5, resetTime: reset } },
      'gemini-pro-coordinator': { displayName: 'Orchestrator', quotaBucketName: 'Orch Bucket', quotaInfo: { remainingFraction: 1, resetTime: reset } },
      'gemini-pro-orchestrator-neon': { displayName: 'Orchestrator (Neon)', quotaBucketName: 'Orch Neon Bucket', quotaInfo: { remainingFraction: 1, resetTime: reset } },
      'custom-user-model': { displayName: 'Custom User Model', beyondModelInfo: { quotaBucketName: 'Custom Beyond Bucket' }, quotaInfo: { remainingFraction: 0.77, resetTime: reset } },
      'gemini-4-neon': { displayName: 'Gemini 4 Neon', modelProvider: 'MODEL_PROVIDER_GOOGLE', quotaInfo: { remainingFraction: 0.9, resetTime: reset } },
    },
  }, nowSec);

  assert.equal(cloudModels.find(m => m.model_id === 'internal-secret-model')?.is_internal, true);
  assert.equal(cloudModels.find(m => m.model_id === 'legacy-dep-1')?.deprecated, true);
  assert.equal(cloudModels.find(m => m.model_id === 'tab-autocomplete-v2')?.non_chat_specialized, true);
  assert.equal(cloudModels.find(m => m.model_id === 'custom-user-model')?.quota_bucket_name, 'Custom Beyond Bucket');
  assert.equal(cloudModels.find(m => m.model_id === 'custom-user-model')?.in_model_selector, true);
  assert.equal(cloudModels.find(m => m.model_id === 'internal-secret-model')?.in_model_selector, false);

  // 即使 groups 为空（最宽松的降级模式），上述内部/废弃/非对话/编排器模型也绝不成为独立池，仅 custom-user-model 保留
  const emptyWin = familyWindowsFromGroups([], nowMs);
  const standalonesEmpty = buildStandaloneModels(applyFamilyWindows(cloudModels, emptyWin), [], emptyWin, nowMs);
  assert.deepEqual(standalonesEmpty.map(s => s.key), ['custom-user-model']);
  assert.equal(standalonesEmpty[0].resetTime, reset);

  // 3. normalizeLiveModels 提取 provider / isInternal / beyondModelInfo / clientModelSorts
  const liveModels = normalizeLiveModels(
    [
      { modelId: 'live-google-m1', label: 'Mystery Google', provider: 'MODEL_PROVIDER_GOOGLE', quotaInfo: { remainingFraction: 0.8, resetTime: reset } },
      { modelId: 'live-internal', label: 'Internal', isInternal: true, quotaInfo: { remainingFraction: 0.5, resetTime: reset } },
    ],
    nowSec,
    { clientModelSorts: [{ groups: [{ modelIds: ['live-google-m1'] }] }] },
  );
  assert.equal(liveModels[0].family, 'gemini');
  assert.equal(liveModels[0].model_provider, 'MODEL_PROVIDER_GOOGLE');
  assert.equal(liveModels[0].in_model_selector, true);
  assert.equal(liveModels[1].is_internal, true);
  assert.equal(liveModels[1].in_model_selector, false);
});

test('Argon/Carbon 独立池遵循动态 staleAfterSeconds 阈值，30 分钟刷新周期下 20 分钟采样不误判 stale', async (t) => {
  const { manager, acc } = await createTempManager(t);
  const nowMs = Date.now();
  const observed20mAgoIso = new Date(nowMs - 20 * 60 * 1000).toISOString();
  const resetIso = new Date(nowMs + 4 * 24 * 3600 * 1000).toISOString();

  acc.subscription_tier = 'PRO';
  acc.quota = manager.fuseQuota(
    {
      models: {
        'gemini-3.8-flash': { displayName: 'Gemini 3.8 Flash', quotaInfo: { remainingFraction: 0.9, resetTime: resetIso } },
        'gemini-4-argon': { displayName: 'Gemini 4 Argon', quotaInfo: { remainingFraction: 0.72, resetTime: resetIso } },
      },
    },
    {
      groups: [
        {
          groupId: 'gemini',
          displayName: 'Gemini',
          observedAt: observed20mAgoIso,
          buckets: [{ window: 'five_hour', remainingFraction: 0.9, resetTime: resetIso }],
        },
        {
          groupId: 'argon',
          displayName: 'Gemini 4 Argon',
          observedAt: observed20mAgoIso,
          buckets: [{ window: 'weekly', remainingFraction: 0.72, resetTime: resetIso }],
        },
      ],
    }
  );
  await manager.saveAccount(acc);

  // staleAfterSeconds = 1920（对应 30 分钟刷新间隔 + 2 分钟）
  const overview = buildAccountQuotaOverview(acc, nowMs, { staleAfterSeconds: 1920 });
  assert.equal(overview.argonStatus?.quotaState, 'known', '20 分钟采样在 1920s 阈值下不得误判为 stale');
  const argonPool = overview.standaloneModels?.find(m => m.key === 'argon');
  assert.equal(argonPool?.quotaState, 'known');
  assert.equal(argonPool?.windows?.[0]?.status?.stale, false);
  assert.equal((overview.quotaWarningCodes ?? []).includes('ARGON_STALE'), false, '不得误报 ARGON_STALE 警告');
  assert.equal(computeAccountRemaining(acc, 'argon', nowMs, 1920), 72, 'Argon 监控范围应返回有效剩余百分比 72');
});

test('P1-8 & P1-9: 独立配额桶移除 argon/carbon 硬编码过滤，未知订阅层级保留清洗后官方原名并确定性排序', async () => {
  const { normalizeIndependentArgonQuota } = await import('../dist/quota.js');
  const { resolveProbeSubscriptionTier } = await import('../dist/account-probe.js');
  const { normalizeCatalogTierLabel, compareCatalogTiers } = await import('../dist/pricing.js');
  const nowSec = Math.floor(Date.now() / 1000);
  const reset = new Date((nowSec + 3600) * 1000).toISOString();

  // P1-8: 非 argon/carbon 独立桶（other）自动保留；显式 allowedModelIds 可补充未来独立 Gemini 代号；编排器与默认核心共享桶仍拒绝
  const defaultRows = normalizeIndependentArgonQuota({
    buckets: [
      { modelId: 'gemini-pro-orchestrator-xenon', displayName: 'Orchestrator (Xenon)', remainingFraction: 1, resetTime: reset },
      { modelId: 'gemini-4-neon', displayName: 'Gemini 4 Neon', remainingFraction: 0.9, resetTime: reset },
      { modelId: 'claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5', remainingFraction: 0.8, resetTime: reset },
      { modelId: 'qwen-3-max', displayName: 'Qwen 3 Max', remainingFraction: 0.55, resetTime: reset },
      { modelId: 'gemini-4-argon', displayName: 'Gemini 4 Argon', remainingFraction: 0.4, resetTime: reset },
    ],
  }, nowSec);
  assert.deepEqual(defaultRows.map(r => r.model_id).sort(), ['gemini-4-argon', 'qwen-3-max']);

  const targetedRows = normalizeIndependentArgonQuota(
    {
      buckets: [
        { modelId: 'gemini-5-xenon', displayName: 'Gemini 5 Xenon', remainingFraction: 0.65, resetTime: reset },
        { modelId: 'gemini-4-neon', displayName: 'Gemini 4 Neon', remainingFraction: 0.9, resetTime: reset },
      ],
    },
    nowSec,
    { allowedModelIds: new Set(['gemini-5-xenon']) },
  );
  assert.deepEqual(targetedRows.map(r => r.model_id), ['gemini-5-xenon']);
  assert.equal(targetedRows[0].own_percentage, 65);

  // P1-9: 未知官方层级剥离 g1-/-tier 前后缀保留清洗原名；哨兵/内部词继续返回空串；排序确定性兜底
  assert.equal(normalizeCatalogTierLabel('g1-max-tier'), 'MAX');
  assert.equal(normalizeCatalogTierLabel('Google AI Education'), 'EDUCATION');
  assert.equal(normalizeCatalogTierLabel('unknown-tier'), '');
  assert.equal(normalizeCatalogTierLabel('Prototype Internal'), '');
  assert.equal(
    resolveProbeSubscriptionTier({ userTier: { id: 'g1-max-tier', name: 'Google AI Max' } }),
    'MAX'
  );
  assert.equal(
    resolveProbeSubscriptionTier({ userTier: { id: 'g1-student-plan', description: 'Includes full access to Gemini models for personal projects' } }),
    'STUDENT'
  );
  assert.deepEqual(
    ['ZETA', 'FREE', 'MAX', 'ULTRA', 'ALPHA'].sort(compareCatalogTiers),
    ['ULTRA', 'FREE', 'ALPHA', 'MAX', 'ZETA']
  );
});

test('P2-8, P2-9 & P2-17: Live 探针缺独立 other 桶计入 missingFamilies；Ultra 官方独立组不被吞并；daily_known 走双语词条', async () => {
  const { buildLiveProbeResultFromRpc } = await import('../dist/account-probe.js');
  const { buildArgonStatus, familyWindowsFromGroups, normalizeStoredGroups } = await import('../dist/quota.js');
  const { getActiveLocale, setActiveLocale } = await import('../dist/i18n.js');
  const nowSec = Math.floor(Date.now() / 1000);
  const nowMs = nowSec * 1000;
  const resetIso = new Date((nowSec + 3600) * 1000).toISOString();

  // P2-8: 带显式 quotaBucketName 的 other 独立模型缺少配额时，Live 探针 missingFamilies 包含 'other'
  const liveProbe = buildLiveProbeResultFromRpc(
    {
      userStatus: {
        email: 'probe-other@example.invalid',
        userTier: { id: 'g1-pro-tier', name: 'Google AI Pro' },
        cascadeModelConfigData: {
          clientModelConfigs: [
            {
              modelId: 'gemini-3.8-flash',
              label: 'Gemini 3.8 Flash',
              modelOrAlias: { model: 'gemini-3.8-flash' },
              quotaInfo: { remainingFraction: 0.9, resetTime: resetIso },
            },
            {
              modelId: 'qwen-3-max',
              label: 'Qwen 3 Max',
              modelOrAlias: { model: 'qwen-3-max' },
              quotaBucketName: 'Qwen Independent Pool',
              quotaInfo: {},
            },
          ],
        },
      },
    },
    {
      groups: [
        {
          displayName: 'Gemini Models',
          buckets: [{ bucketId: 'g-5h', window: '5h', remainingFraction: 0.9, resetTime: resetIso }],
        },
      ],
    },
  );
  assert.ok(liveProbe);
  assert.equal(liveProbe.quota.refresh_state.missingFamilies.includes('other'), true, '带显式独立桶且缺额度的 other 模型应计入 missingFamilies');
  assert.equal(liveProbe.quota.refresh_state.complete, false);

  // P2-9: Ultra 账号若官方 groups[] 显式返回了独立 Argon 分组，不得被兜底吞并入 Gemini 共享池
  const ultraWithStandaloneArgonGroups = normalizeStoredGroups(
    [
      {
        display_name: 'Gemini Models',
        family: 'gemini',
        buckets: [{ bucket_id: 'g-5h', window: '5h', remaining_fraction: 0.9, remaining_fraction_known: true, reset_time: resetIso, observed_at: nowSec }],
      },
      {
        display_name: 'Gemini 4 Argon',
        family: 'argon',
        buckets: [{ bucket_id: 'argon-daily', window: 'daily', remaining_fraction: 0.45, remaining_fraction_known: true, reset_time: resetIso, observed_at: nowSec }],
      },
    ],
    nowSec,
    'live',
  );
  const fw = familyWindowsFromGroups(ultraWithStandaloneArgonGroups, nowMs);
  const argonModels = [
    {
      name: 'gemini-4-argon',
      model_id: 'gemini-4-argon',
      display_name: 'Gemini 4 Argon',
      family: 'argon',
      is_argon: true,
      disabled: false,
      model_or_alias: null,
      own_percentage: null,
      own_percentage_known: false,
      own_reset_time: null,
      own_observed_at: null,
      own_stale: false,
      family_5h: null,
      family_weekly: null,
      percentage: 0,
      percentage_known: false,
      effective_percentage: null,
      effective_known: false,
      reset_time: '',
      quota_source: 'live',
      stale: false,
    },
  ];
  const origLocale = getActiveLocale();
  try {
    setActiveLocale('zh-Hans');
    const zhStatus = buildArgonStatus(argonModels, ultraWithStandaloneArgonGroups, fw, nowMs, 'ULTRA');
    assert.equal(zhStatus.mode, 'standalone', 'Ultra 存在官方独立 Argon 分组时不得被 Gemini 共享池吞并');
    assert.equal(zhStatus.period, 'daily');
    assert.match(zhStatus.message, /每日配额已取得（剩余 45%）/);

    setActiveLocale('en');
    const enStatus = buildArgonStatus(argonModels, ultraWithStandaloneArgonGroups, fw, nowMs, 'ULTRA');
    assert.match(enStatus.message, /daily quota retrieved \(45% remaining\)/);
  } finally {
    setActiveLocale(origLocale);
  }
});






