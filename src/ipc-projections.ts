import {
  computeAccountRevision,
  mergeSubscriptionTier,
  type AccountsManager,
  type Account,
  type AccountSummary,
  type QuotaBucket,
  type QuotaData,
  type QuotaGroup,
  type QuotaOverview,
  projectAccountForIpc,
} from './accounts.js';
import { classifyFamily, classifyWindow, normalizeResetTime } from './quota.js';
import type {
  EnvironmentLifecycleState,
  EnvironmentNode,
  EnvironmentQuotaFreshness,
  ModelTokenUsage,
  TokenUsagePeriod,
  TokenUsageSummary,
} from './usage-types.js';
import { localizePricingProvenance } from './pricing.js';
import { bt, getActiveLocale } from './i18n.js';
import { cleanHostLabel } from './ssh-context.js';
import { buildRemoteEnvironmentId } from './remote-usage-sync.js';
import type { RemoteSessionState } from './controller.js';

/** 套餐枚举统一收口；空值/未知值一律回落到“待确认”，空串不得穿透 IPC。 */
export function normalizeSubscriptionTier(value: unknown): string {
  const pending = bt('quota.tier.pending');
  if (typeof value !== 'string') return pending;
  const raw = value.trim();
  if (!raw) return pending;
  const upper = raw.toUpperCase();
  if (upper === 'FREE') return 'FREE';
  if (upper === 'PRO') return 'PRO';
  if (upper === 'ULTRA') return 'ULTRA';
  if (upper === 'ENTERPRISE') return 'ENTERPRISE';
  if (upper === 'TEAM' || upper === 'TEAMS' || upper === 'BUSINESS' || upper === 'WORKSPACE') return 'TEAM';
  if (upper === 'PLUS') return 'PLUS';
  if (/\bULTRA\b/i.test(raw)) return 'ULTRA';
  if (/\bENTERPRISE\b/i.test(raw)) return 'ENTERPRISE';
  if (/\b(?:TEAM|TEAMS|BUSINESS|WORKSPACE)\b/i.test(raw)) return 'TEAM';
  if (/\bPLUS\b/i.test(raw)) return 'PLUS';
  if (/\bPRO\b/i.test(raw) || /\bAI\s+PREMIUM\b/i.test(raw)) return 'PRO';
  if (/\b(?:FREE|STARTER|TRIAL)\b/i.test(raw)) return 'FREE';
  return pending;
}

/** Single contract for dashboard, account cards, menu and refresh replies. No credentials. */
export function projectQuotaContract(overview: {
  familyWindows?: unknown;
  familyModelQuota?: unknown;
  argonStatus?: unknown;
  carbonStatus?: unknown;
  standaloneModels?: unknown[];
  projectedQuotaGroups?: unknown[];
  quotaGroups?: unknown[];
  refreshState?: unknown;
  quotaWarnings?: unknown;
  quotaWarningCodes?: unknown;
}): Record<string, unknown> {
  const projectedGroups = Array.isArray(overview.projectedQuotaGroups)
    ? overview.projectedQuotaGroups
    : (Array.isArray(overview.quotaGroups)
      && overview.quotaGroups.every(item => item && typeof item === 'object' && Array.isArray((item as { windows?: unknown }).windows)))
      ? overview.quotaGroups
      : [];
  return {
    familyWindows: overview.familyWindows,
    familyModelQuota: overview.familyModelQuota,
    argonStatus: overview.argonStatus,
    carbonStatus: overview.carbonStatus ?? null,
    standaloneModels: overview.standaloneModels ?? [],
    quotaGroups: projectedGroups,
    refreshState: overview.refreshState,
    quotaWarnings: overview.quotaWarnings,
    quotaWarningCodes: overview.quotaWarningCodes,
  };
}

export interface ProjectAccountIpcOptions {
  overview?: QuotaOverview;
  nowMs?: number;
  isActive?: boolean;
  isRemoteActive?: boolean;
  hasLocalOAuthClient?: boolean;
  includeOverviewFields?: boolean;
  formatResetTime?: (resetTime: number | null | undefined) => string;
  revisionWithReadiness?: boolean;
  persistedQuotaLastUpdated?: number;
  quotaSourceEnvironmentId?: string | null;
  activeRemoteEnvIds?: string[];
}

export function projectAccountForIpcNormalized(
  account: Parameters<typeof projectAccountForIpc>[0],
  accountsManager: Pick<AccountsManager, 'getAccountQuotaOverview'>,
  options?: ProjectAccountIpcOptions,
): Record<string, unknown> | null {
  if (!account) return null;
  const overview = options?.overview ?? accountsManager.getAccountQuotaOverview(
    account,
    options?.nowMs !== undefined ? { nowMs: options.nowMs } : undefined,
  );
  const hasRemoteActive = Boolean(
    options?.isRemoteActive
    || (Array.isArray(options?.activeRemoteEnvIds) && options.activeRemoteEnvIds.length > 0)
    || (typeof options?.quotaSourceEnvironmentId === 'string'
      && options.quotaSourceEnvironmentId.trim().length > 0
      && options.quotaSourceEnvironmentId.trim() !== 'local'),
  );
  const projected = projectAccountForIpc(account, {
    isActive: options?.isActive,
    isRemoteActive: hasRemoteActive,
    hasLocalOAuthClient: options?.hasLocalOAuthClient,
    nowMs: options?.nowMs,
    overview,
  }) as Record<string, unknown> | null;
  if (!projected) return projected;
  const normalizedTier = normalizeSubscriptionTier(
    options?.includeOverviewFields ? overview.subscriptionTier : projected.subscription_tier,
  );
  const contract = projectQuotaContract(overview);
  const normalized: Record<string, unknown> = {
    ...projected,
    subscription_tier: normalizedTier,
    ...contract,
  };
  if (options?.revisionWithReadiness) {
    const revBase = computeAccountRevision(account as Account | AccountSummary);
    const readinessState = (projected.credentialReadiness as { state?: string } | undefined)?.state ?? 'ready';
    const standbyMode = (projected.standbyRefreshStatus as { mode?: string } | undefined)?.mode ?? 'snapshot_cooling';
    normalized.revision = `${revBase}:${readinessState}:${standbyMode}`;
  }
  if (projected.quota && typeof projected.quota === 'object') {
    const quotaObj = projected.quota as Record<string, unknown>;
    normalized.quota = {
      ...quotaObj,
      subscription_tier: normalizeSubscriptionTier(quotaObj.subscription_tier ?? normalizedTier),
      ...contract,
    };
  }
  if (options?.includeOverviewFields) {
    const lastUp = Number(projected.quota_last_updated ?? (projected.quota as { last_updated?: unknown } | null)?.last_updated ?? 0);
    const persistedLastUp =
      typeof options.persistedQuotaLastUpdated === 'number' && Number.isFinite(options.persistedQuotaLastUpdated)
        ? options.persistedQuotaLastUpdated
        : lastUp;
    const resetTimeStr = options.formatResetTime
      ? options.formatResetTime(overview.resetTime)
      : (overview.resetTime !== null && overview.resetTime !== undefined ? String(overview.resetTime) : '');
    Object.assign(normalized, {
      quota_last_updated: lastUp,
      persisted_quota_last_updated: persistedLastUp,
      quotaLastUpdated: lastUp,
      fiveHourRemaining: overview.fiveHourRemaining,
      weeklyRemaining: overview.weeklyRemaining,
      geminiFiveHourRemaining: overview.geminiFiveHourRemaining,
      geminiWeeklyRemaining: overview.geminiWeeklyRemaining,
      geminiFiveHourResetCountdown: overview.geminiFiveHourResetCountdown ?? '',
      geminiWeeklyResetCountdown: overview.geminiWeeklyResetCountdown ?? '',
      geminiResetCountdown: overview.geminiResetCountdown,
      claudeFiveHourRemaining: overview.claudeFiveHourRemaining,
      claudeWeeklyRemaining: overview.claudeWeeklyRemaining,
      claudeFiveHourResetCountdown: overview.claudeFiveHourResetCountdown ?? '',
      claudeWeeklyResetCountdown: overview.claudeWeeklyResetCountdown ?? '',
      claudeResetCountdown: overview.claudeResetCountdown,
      argonWeeklyRemaining: overview.argonWeeklyRemaining,
      argonWeeklyResetCountdown: overview.argonWeeklyResetCountdown ?? '',
      argonResetCountdown: overview.argonResetCountdown,
      carbonWeeklyRemaining: overview.carbonWeeklyRemaining,
      carbonWeeklyResetCountdown: overview.carbonWeeklyResetCountdown ?? '',
      carbonResetCountdown: overview.carbonResetCountdown,
      staleGroups: overview.staleGroups,
      stale_groups: overview.staleGroups,
      resetTime: resetTimeStr,
      resetCountdown: overview.resetCountdown,
      models: overview.models,
    });
    const baseQuota = (normalized.quota && typeof normalized.quota === 'object')
      ? (normalized.quota as Record<string, unknown>)
      : {};
    normalized.quota = {
      ...baseQuota,
      five_hour_remaining: overview.fiveHourRemaining,
      weekly_remaining: overview.weeklyRemaining,
      subscription_tier: normalizedTier,
      reset_time: overview.resetTime ?? null,
      reset_countdown: overview.resetCountdown,
      quota_groups: overview.quotaGroups,
      stale_groups: overview.staleGroups,
      models: overview.models,
      ...contract,
    };
  }
  if (options?.quotaSourceEnvironmentId !== undefined) {
    normalized.quotaSourceEnvironmentId = options.quotaSourceEnvironmentId;
  }
  if (options?.activeRemoteEnvIds !== undefined) {
    normalized.activeRemoteEnvIds = options.activeRemoteEnvIds;
  }
  return normalized;
}

export interface UsageProjectionEnvironmentsSnapshot {
  environments: EnvironmentNode[];
  environmentsRevision: number;
  remoteSyncRevision?: number;
  focusedEnvironmentId: string;
}

export function projectSingleUsagePeriod(
  usage: TokenUsageSummary,
  periodInput: unknown,
  environmentsSnapshot?: UsageProjectionEnvironmentsSnapshot
) {
  const periodKey: 'today' | 'last_7_days' | 'last_30_days' | 'all_time' =
    periodInput === 'today' ? 'today' : periodInput === '7d' ? 'last_7_days' : periodInput === '30d' ? 'last_30_days' : 'all_time';
  const p: TokenUsagePeriod = usage[periodKey] ?? usage.all_time;
  const byModel = p.by_model.map((m: ModelTokenUsage) => ({
    model: m.model,
    promptTokens: m.input_tokens,
    candidatesTokens: m.output_tokens,
    cachedTokens: m.cached_tokens,
    cacheWriteTokens: m.cache_write_tokens ?? 0,
    totalTokens: m.total_tokens,
    requestCount: m.request_count,
    estimatedUsd: m.estimated_usd,
    priced: m.priced === true,
    partiallyPriced: m.partiallyPriced === true,
    unpricedTokens: m.unpriced_tokens ?? 0,
    pricingKey: m.pricingKey,
    pricingStatus: m.pricingStatus,
    pricingProvenance: localizePricingProvenance(m.pricingProvenance) ?? null,
    input_tokens: m.input_tokens,
    output_tokens: m.output_tokens,
    cached_tokens: m.cached_tokens,
    cache_write_tokens: m.cache_write_tokens ?? 0,
    total_tokens: m.total_tokens,
    request_count: m.request_count,
    estimated_usd: m.estimated_usd,
  }));
  const cacheDenom = p.totals.input_tokens + p.totals.cached_tokens + (p.totals.cache_write_tokens ?? 0);
  const cacheHitRate = cacheDenom > 0 ? Math.round((p.totals.cached_tokens / cacheDenom) * 1000) / 10 : 0;
  const lastScannedAt = (usage.availability === 'cached'
    ? usage.generated_at
    : (usage.last_attempt_at ?? usage.generated_at)) ?? 0;
  const selectedAccountId = usage.selected_account_id ?? 'all';
  const availableAccounts = usage.available_accounts ?? [];
  const selectedEnvironmentId = usage.selected_environment_id ?? 'all';
  const availableEnvironments = usage.available_environments ?? [];
  const environmentBreakdown = p.environment_breakdown ?? usage.environment_breakdown;
  const offlineSshHosts = environmentBreakdown?.offline_ssh_hosts ?? usage.environment_breakdown?.offline_ssh_hosts ?? [];
  const remoteSyncRevision = environmentsSnapshot?.remoteSyncRevision ?? usage.remote_sync_revision ?? 0;
  const environments = environmentsSnapshot?.environments ?? usage.environments;
  const environmentsRevision = environmentsSnapshot?.environmentsRevision ?? usage.environments_revision;
  const focusedEnvironmentId = environmentsSnapshot?.focusedEnvironmentId ?? usage.focused_environment_id;
  const periodSummary = {
    ...usage,
    totalTokens: p.totals.total_tokens,
    promptTokens: p.totals.input_tokens,
    candidatesTokens: p.totals.output_tokens,
    cachedTokens: p.totals.cached_tokens,
    cacheWriteTokens: p.totals.cache_write_tokens ?? 0,
    requestCount: p.totals.request_count,
    estimatedUsd: p.estimated_usd,
    cacheHitRate,
    total_tokens: p.totals.total_tokens,
    input_tokens: p.totals.input_tokens,
    output_tokens: p.totals.output_tokens,
    cached_tokens: p.totals.cached_tokens,
    cache_write_tokens: p.totals.cache_write_tokens ?? 0,
    request_count: p.totals.request_count,
    estimated_usd: p.estimated_usd,
    databasesScanned: usage.databases_scanned,
    databasesDiscovered: usage.databases_discovered,
    scanScopeDescription: usage.scan_scope_description,
    pricedModels: p.priced_models ?? usage.priced_models ?? 0,
    unpricedModels: p.unpriced_models ?? usage.unpriced_models ?? 0,
    failedDatabasesCount: usage.failed_databases_count ?? 0,
    skippedLargeRecords: usage.skipped_large_records ?? 0,
    lastScannedAt,
    hasError: usage.has_error === true,
    availability: usage.availability ?? 'complete',
    unknownTimeRecords: usage.unknown_time_records ?? 0,
    unknownTimeTokens: usage.unknown_time_tokens ?? 0,
    databaseDiagnostics: usage.database_diagnostics ?? [],
    selectedAccountId,
    selected_account_id: selectedAccountId,
    availableAccounts,
    available_accounts: availableAccounts,
    selectedEnvironmentId,
    selected_environment_id: selectedEnvironmentId,
    availableEnvironments,
    available_environments: availableEnvironments,
    ...(environmentBreakdown ? { environmentBreakdown, environment_breakdown: environmentBreakdown } : {}),
    remoteSyncRevision,
    remote_sync_revision: remoteSyncRevision,
    ...(environments !== undefined ? { environments } : {}),
    ...(environmentsRevision !== undefined ? { environmentsRevision } : {}),
    ...(focusedEnvironmentId !== undefined ? { focusedEnvironmentId } : {}),
    offlineSshHosts,
    offline_ssh_hosts: offlineSshHosts,
    unattributedRequests: usage.unattributed_requests ?? 0,
    unattributed_requests: usage.unattributed_requests ?? 0,
    unattributedTokens: usage.unattributed_tokens ?? 0,
    unattributed_tokens: usage.unattributed_tokens ?? 0,
  };
  const { today: _t, last_7_days: _w, last_30_days: _m, all_time: _a, daily_trends, today_hourly, ...selectedSummary } = periodSummary;
  const safeDailyTrends = Array.isArray(daily_trends) ? daily_trends : [];
  const safeTodayHourly = Array.isArray(today_hourly) ? today_hourly : [];
  const days = periodInput === 'today' ? 1 : periodInput === '7d' ? 7 : periodInput === '30d' ? 30 : null;
  const selectedTrends = days ? safeDailyTrends.slice(-days) : safeDailyTrends;
  return {
    ok: true,
    period: typeof periodInput === 'string' ? periodInput : 'all',
    snapshotId: usage.snapshot_id,
    selectedAccountId,
    selected_account_id: selectedAccountId,
    availableAccounts,
    available_accounts: availableAccounts,
    selectedEnvironmentId,
    selected_environment_id: selectedEnvironmentId,
    availableEnvironments,
    available_environments: availableEnvironments,
    ...(environmentBreakdown ? { environmentBreakdown, environment_breakdown: environmentBreakdown } : {}),
    remoteSyncRevision,
    remote_sync_revision: remoteSyncRevision,
    ...(environments !== undefined ? { environments } : {}),
    ...(environmentsRevision !== undefined ? { environmentsRevision } : {}),
    ...(focusedEnvironmentId !== undefined ? { focusedEnvironmentId } : {}),
    offlineSshHosts,
    offline_ssh_hosts: offlineSshHosts,
    unattributedRequests: usage.unattributed_requests ?? 0,
    unattributed_requests: usage.unattributed_requests ?? 0,
    unattributedTokens: usage.unattributed_tokens ?? 0,
    unattributed_tokens: usage.unattributed_tokens ?? 0,
    summary: selectedSummary,
    byModel,
    models: byModel,
    dailyTrends: selectedTrends,
    todayHourly: periodInput === 'today' ? safeTodayHourly : [],
  };
}

export function projectAllUsagePeriodSummaries(
  usage: TokenUsageSummary,
  environmentsSnapshot?: UsageProjectionEnvironmentsSnapshot
) {
  return {
    today: projectSingleUsagePeriod(usage, 'today', environmentsSnapshot),
    '7d': projectSingleUsagePeriod(usage, '7d', environmentsSnapshot),
    '30d': projectSingleUsagePeriod(usage, '30d', environmentsSnapshot),
    all: projectSingleUsagePeriod(usage, 'all', environmentsSnapshot),
  };
}

export function projectUsagePeriodSummary(
  usage: TokenUsageSummary,
  periodInput: unknown,
  options?: { includeAllPeriods?: boolean; environmentsSnapshot?: UsageProjectionEnvironmentsSnapshot }
) {
  const projected = projectSingleUsagePeriod(usage, periodInput, options?.environmentsSnapshot);
  const isUnfiltered =
    (usage.selected_account_id ?? 'all') === 'all' &&
    (usage.selected_environment_id ?? 'all') === 'all';
  if (options?.includeAllPeriods && isUnfiltered) {
    return {
      ...projected,
      periods: projectAllUsagePeriodSummaries(usage, options?.environmentsSnapshot),
    };
  }
  return projected;
}

function isFutureResetIso(resetTime: unknown, nowMs: number): boolean {
  const iso = normalizeResetTime(resetTime);
  if (!iso) return false;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && ms > nowMs;
}

function isExpiredResetIso(resetTime: unknown, nowMs: number): boolean {
  const iso = normalizeResetTime(resetTime);
  if (!iso) return false;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && ms <= nowMs;
}

/**
 * 合并基准配额与最新观测配额（本地 LS 或在线 SSH），保留缺失分组与未过期窗口。
 */
export function mergeLiveQuotaWithSaved(
  savedQuota: QuotaData | null | undefined,
  liveQuota: QuotaData | null | undefined,
  nowMs: number = Date.now(),
): QuotaData | null | undefined {
  if (!liveQuota) return savedQuota;
  if (!savedQuota) return liveQuota;
  const savedGroups = savedQuota.quota_groups ?? [];
  const liveGroups = liveQuota.quota_groups ?? [];
  const hasLiveGroups = liveGroups.length > 0;
  const hasSavedGroups = savedGroups.length > 0;
  const hasKnownLiveModels = Array.isArray(liveQuota.models) && liveQuota.models.some(m => m?.percentage_known || m?.own_percentage_known);
  const hasSavedModels = Array.isArray(savedQuota.models) && savedQuota.models.length > 0;
  const liveComplete = liveQuota.refresh_state?.complete === true;
  const mergedStaleGroups = liveQuota.stale_groups?.length
    ? liveQuota.stale_groups
    : (hasLiveGroups && liveComplete ? undefined : savedQuota.stale_groups);

  let mergedGroups: QuotaGroup[];
  if (!hasLiveGroups) {
    mergedGroups = savedGroups;
  } else if (!hasSavedGroups) {
    mergedGroups = liveGroups;
  } else {
    const savedBucketsBySemantic = new Map<string, QuotaBucket>();
    for (const sg of savedGroups) {
      const fam = sg.family ?? classifyFamily({
        groupName: sg.display_name,
        description: sg.description,
        bucketId: sg.buckets?.[0]?.bucket_id,
      });
      for (const sb of sg.buckets ?? []) {
        if (sb.stale === true || sb.remaining_fraction_known === false) continue;
        const win = sb.window ?? classifyWindow(undefined, sb.bucket_id, sb.display_name);
        if (win === 'unspecified') continue;
        if (isFutureResetIso(sb.reset_time, nowMs)) {
          savedBucketsBySemantic.set(`${fam}:${win}`, sb);
        }
      }
    }
    mergedGroups = liveGroups.map(lg => {
      const fam = lg.family ?? classifyFamily({
        groupName: lg.display_name,
        description: lg.description,
        bucketId: lg.buckets?.[0]?.bucket_id,
      });
      const nextBuckets = (lg.buckets ?? []).map(lb => {
        const win = lb.window ?? classifyWindow(undefined, lb.bucket_id, lb.display_name);
        if (win !== 'unspecified' && isExpiredResetIso(lb.reset_time, nowMs)) {
          const fresherSaved = savedBucketsBySemantic.get(`${fam}:${win}`);
          if (fresherSaved) {
            return { ...fresherSaved };
          }
        }
        return lb;
      });
      return { ...lg, buckets: nextBuckets };
    });
  }

  const effectiveLastUpdated =
    !hasLiveGroups && hasSavedGroups && typeof savedQuota.last_updated === 'number' && savedQuota.last_updated > 0
      ? savedQuota.last_updated
      : liveQuota.last_updated;

  const merged: QuotaData = {
    ...savedQuota,
    ...liveQuota,
    last_updated: effectiveLastUpdated,
    quota_groups: mergedGroups,
    models: (hasLiveGroups || hasKnownLiveModels || !hasSavedModels) ? liveQuota.models : savedQuota.models,
    subscription_tier: mergeSubscriptionTier(liveQuota.subscription_tier, savedQuota.subscription_tier, {
      allowFreeDowngrade: hasLiveGroups || liveComplete || !savedQuota.subscription_tier,
    }),
  };
  if (mergedStaleGroups?.length) merged.stale_groups = mergedStaleGroups;
  else delete merged.stale_groups;
  return merged;
}

export function computeQuotaFreshness(params: {
  lifecycleState: EnvironmentLifecycleState;
  hasQuota: boolean;
  lastError?: string | null;
  lastQuotaObservedAtSec?: number | null;
  isStale?: boolean;
  staleAfterSeconds?: number;
  nowMs?: number;
}): EnvironmentQuotaFreshness {
  if (params.lifecycleState === 'auth_expired') return 'auth_expired';
  if (params.lifecycleState === 'offline_recent' || params.lifecycleState === 'historical_only') {
    return 'offline_snapshot';
  }
  if (params.lastError && String(params.lastError).trim()) {
    return 'error_fallback';
  }
  if (!params.hasQuota || !params.lastQuotaObservedAtSec || params.lastQuotaObservedAtSec <= 0) {
    return 'stale';
  }
  if (params.isStale === true) return 'stale';
  const staleAfter = Math.max(60, params.staleAfterSeconds ?? 900);
  const nowSec = Math.floor((params.nowMs ?? Date.now()) / 1000);
  if (nowSec - params.lastQuotaObservedAtSec > staleAfter) {
    return 'stale';
  }
  return 'fresh';
}

export interface RemoteQuotaCandidate {
  environmentId: string;
  email: string;
  lifecycleState: EnvironmentLifecycleState;
  quota?: QuotaData | null;
  observedAtMs?: number | null;
}

export interface FusedAccountQuotaResult {
  quota: QuotaData | null;
  quotaSourceEnvironmentId: string | null;
  activeRemoteEnvIds: string[];
  freshestObservedAtSec: number | null;
}

function isValidQuotaPayload(quota: QuotaData | null | undefined): quota is QuotaData {
  if (!quota || quota.is_forbidden) return false;
  return (Array.isArray(quota.quota_groups) && quota.quota_groups.length > 0) ||
    (Array.isArray(quota.models) && quota.models.length > 0);
}

/**
 * 同账号跨机配额新鲜度融合：
 * 按 observedAt 在本机保存/LS 配额与所有在线 SSH 节点间取最新鲜有效配额，不修改本地持久化账号。
 */
export function fuseAccountQuotaAcrossEnvironments(params: {
  email?: string | null;
  savedQuota?: QuotaData | null;
  liveLocalQuota?: QuotaData | null;
  remoteSessions?: ReadonlyArray<RemoteQuotaCandidate>;
  nowMs?: number;
}): FusedAccountQuotaResult {
  const nowMs = params.nowMs ?? Date.now();
  const emailLower = typeof params.email === 'string' ? params.email.trim().toLowerCase() : '';
  const activeRemoteEnvSet = new Set<string>();

  if (emailLower && Array.isArray(params.remoteSessions)) {
    for (const r of params.remoteSessions) {
      if (!r || !r.environmentId) continue;
      if (r.lifecycleState !== 'online') continue;
      if ((r.email || '').trim().toLowerCase() !== emailLower) continue;
      activeRemoteEnvSet.add(r.environmentId);
    }
  }
  const activeRemoteEnvIds = [...activeRemoteEnvSet].sort();

  const savedQuota = params.savedQuota ?? null;
  const liveLocalQuota = params.liveLocalQuota ?? null;
  const savedObservedMs = (savedQuota?.last_updated ?? 0) * 1000;
  const liveLocalUsable = Boolean(
    liveLocalQuota &&
    !liveLocalQuota.is_forbidden &&
    (
      isValidQuotaPayload(liveLocalQuota) ||
      Object.keys(liveLocalQuota as Record<string, unknown>).some(
        key => !['last_updated', 'is_forbidden', 'model_forwarding_rules', 'refresh_state'].includes(key),
      )
    ),
  );
  const localLiveObservedMs = liveLocalQuota && typeof liveLocalQuota.last_updated === 'number' && liveLocalQuota.last_updated > 0
    ? liveLocalQuota.last_updated * 1000
    : 0;

  let bestQuota: QuotaData | null = null;
  let bestObservedMs = 0;
  let bestSourceEnvId: string | null = null;

  if (liveLocalQuota && liveLocalUsable && (localLiveObservedMs === 0 || localLiveObservedMs >= savedObservedMs)) {
    bestQuota = mergeLiveQuotaWithSaved(savedQuota, liveLocalQuota, nowMs) ?? liveLocalQuota;
    bestObservedMs = localLiveObservedMs > 0 ? localLiveObservedMs : ((bestQuota?.last_updated ?? 0) * 1000);
    bestSourceEnvId = 'local';
  } else if (savedQuota) {
    bestQuota = savedQuota;
    bestObservedMs = savedObservedMs;
    bestSourceEnvId = 'local';
  }

  if (emailLower && Array.isArray(params.remoteSessions)) {
    for (const r of params.remoteSessions) {
      if (!r || !r.environmentId || r.lifecycleState !== 'online') continue;
      if ((r.email || '').trim().toLowerCase() !== emailLower) continue;
      if (!isValidQuotaPayload(r.quota)) continue;
      const candidateObsMs = Math.max(r.observedAtMs ?? 0, (r.quota.last_updated ?? 0) * 1000);
      const isPreferOnlineOverPassiveSaved =
        !liveLocalUsable && bestSourceEnvId === 'local' && candidateObsMs >= bestObservedMs;
      if (candidateObsMs > bestObservedMs || isPreferOnlineOverPassiveSaved || !bestQuota) {
        const candidateLastUpdatedSec = candidateObsMs > 0
          ? Math.max(r.quota.last_updated ?? 0, Math.floor(candidateObsMs / 1000))
          : (r.quota.last_updated ?? 0);
        const normalizedCandidate: QuotaData = candidateLastUpdatedSec !== r.quota.last_updated
          ? { ...r.quota, last_updated: candidateLastUpdatedSec }
          : r.quota;
        bestQuota = mergeLiveQuotaWithSaved(bestQuota, normalizedCandidate, nowMs) ?? normalizedCandidate;
        bestObservedMs = candidateObsMs;
        bestSourceEnvId = r.environmentId;
      }
    }
  }

  const freshestObservedAtSec = bestObservedMs > 0
    ? Math.floor(bestObservedMs / 1000)
    : (bestQuota?.last_updated && bestQuota.last_updated > 0 ? bestQuota.last_updated : null);

  return {
    quota: bestQuota,
    quotaSourceEnvironmentId: bestSourceEnvId,
    activeRemoteEnvIds,
    freshestObservedAtSec,
  };
}

export interface EnvironmentRegistryLocalAccountInput {
  email?: string | null;
  name?: string | null;
  tier?: string | null;
  quota?: QuotaData | null;
  observedAtSec?: number | null;
  lastError?: string | null;
  lastSyncedAtSec?: number | null;
}

export interface EnvironmentRegistryHistoricalInput {
  environmentId: string;
  hostLabel?: string;
  lastSyncedAtSec?: number | null;
}

export interface EnvironmentRegistryBuildInput {
  nowMs?: number;
  localWindowCount: number;
  localFocusedAt: number;
  focusedEnvironmentId: string;
  localAccount?: EnvironmentRegistryLocalAccountInput | null;
  remoteSessions: RemoteSessionState[];
  windowCountsByEnvId?: ReadonlyMap<string, number>;
  historicalEnvironments?: ReadonlyArray<EnvironmentRegistryHistoricalInput>;
  receiptSyncTimes?: ReadonlyMap<string, number>;
  remoteSyncRevision: number;
  staleAfterSeconds?: number;
  matchAccountId?: (email: string) => string | null;
  getQuotaOverview?: (quota: QuotaData, nowMs: number) => QuotaOverview | null;
  formatResetTime?: (resetTime: number | null | undefined) => string;
  resolveUnsavedTier?: (
    live: { tier?: string | null; accountType?: 'consumer' | 'enterprise_vertex' | 'unknown' | null },
    overview: QuotaOverview | null | undefined
  ) => string;
  localLabel?: string;
}

export interface EnvironmentRegistrySnapshot {
  environments: EnvironmentNode[];
  environmentsRevision: number;
  remoteSyncRevision: number;
  focusedEnvironmentId: string;
  remoteSessions: Record<string, unknown>[];
}

function lifecycleSortPriority(state: EnvironmentLifecycleState): number {
  switch (state) {
    case 'online':
      return 3;
    case 'auth_expired':
      return 2;
    case 'offline_recent':
      return 1;
    case 'historical_only':
      return 0;
  }
}

function buildProjectedQuotaPayload(
  quota: QuotaData | null | undefined,
  overview: QuotaOverview | null | undefined,
  resolvedTier: string,
  formatResetTime?: (resetTime: number | null | undefined) => string,
): Record<string, unknown> | null {
  if (!quota && !overview) return null;
  const contract = projectQuotaContract(overview ?? {
    familyWindows: null,
    argonStatus: null,
    carbonStatus: null,
    standaloneModels: [],
    projectedQuotaGroups: [],
    refreshState: quota?.refresh_state ?? { complete: false },
    quotaWarnings: quota?.quota_warnings ?? [],
    quotaWarningCodes: [],
  });
  const resetTimeStr = formatResetTime
    ? formatResetTime(overview?.resetTime ?? null)
    : (overview?.resetTime !== null && overview?.resetTime !== undefined ? String(overview.resetTime) : '');
  return {
    ...(quota ?? {}),
    subscription_tier: resolvedTier || normalizeSubscriptionTier(overview?.subscriptionTier),
    last_updated: quota?.last_updated ?? overview?.lastUpdated ?? null,
    five_hour_remaining: overview?.fiveHourRemaining ?? null,
    weekly_remaining: overview?.weeklyRemaining ?? null,
    fiveHourRemaining: overview?.fiveHourRemaining ?? null,
    weeklyRemaining: overview?.weeklyRemaining ?? null,
    resetTime: resetTimeStr,
    reset_time: overview?.resetTime ?? null,
    resetCountdown: overview?.resetCountdown ?? '',
    reset_countdown: overview?.resetCountdown ?? '',
    staleGroups: overview?.staleGroups ?? [],
    stale_groups: overview?.staleGroups ?? [],
    models: overview?.models ?? quota?.models ?? [],
    ...contract,
  };
}

/**
 * 后端统一主机环境注册表（SSOT）：
 * 聚合本机、在线/近期离线 SSH 与历史归档 SSH 节点，保证 status / status.json / dashboard_summary / usage_summary 同源一致。
 */
export class EnvironmentRegistry {
  private revision = 0;
  private lastSignature = '';

  getRevision(): number {
    return this.revision;
  }

  buildSnapshot(input: EnvironmentRegistryBuildInput): EnvironmentRegistrySnapshot {
    const nowMs = input.nowMs ?? Date.now();
    const staleAfterSeconds = Math.max(60, input.staleAfterSeconds ?? 900);

    type GroupedRemote = {
      envId: string;
      machineId?: string;
      hostLabel: string;
      lifecycleState: EnvironmentLifecycleState;
      windowCount: number;
      probing: boolean;
      session: RemoteSessionState;
      lastFocusedAt: number;
      observedAtMs: number;
    };

    const groupedByEnvId = new Map<string, GroupedRemote>();
    for (const s of input.remoteSessions) {
      const hostLabel = cleanHostLabel(s.hostLabel) || s.hostLabel || 'ssh-host';
      const envId = s.environmentId || buildRemoteEnvironmentId(hostLabel);
      const lifecycleState: EnvironmentLifecycleState =
        s.state === 'disconnected'
          ? 'offline_recent'
          : s.state === 'auth_expired'
            ? 'auth_expired'
            : 'online';
      const observedAtMs = s.observedAt ?? (s.quota?.last_updated ? s.quota.last_updated * 1000 : 0);
      const lastFocusedAt = s.lastFocusedAt ?? 0;
      const existing = groupedByEnvId.get(envId);
      if (!existing) {
        const winCount =
          lifecycleState === 'offline_recent'
            ? 0
            : (input.windowCountsByEnvId?.get(envId) ?? Math.max(s.windowCount ?? 0, 1));
        groupedByEnvId.set(envId, {
          envId,
          machineId: s.machineId,
          hostLabel,
          lifecycleState,
          windowCount: winCount,
          probing: lifecycleState === 'online' ? Boolean(s.probing) : false,
          session: s,
          lastFocusedAt,
          observedAtMs,
        });
        continue;
      }

      const nextPriority = lifecycleSortPriority(lifecycleState);
      const prevPriority = lifecycleSortPriority(existing.lifecycleState);
      const shouldReplace =
        nextPriority > prevPriority ||
        (nextPriority === prevPriority && lastFocusedAt > existing.lastFocusedAt) ||
        (nextPriority === prevPriority && lastFocusedAt === existing.lastFocusedAt && observedAtMs > existing.observedAtMs);
      if (shouldReplace) {
        existing.session = s;
        existing.lifecycleState = lifecycleState;
        existing.hostLabel = hostLabel;
        if (s.machineId) existing.machineId = s.machineId;
        existing.probing = lifecycleState === 'online' ? Boolean(s.probing) : false;
        existing.observedAtMs = observedAtMs;
      }
      existing.lastFocusedAt = Math.max(existing.lastFocusedAt, lastFocusedAt);
      if (existing.lifecycleState === 'offline_recent') {
        existing.windowCount = 0;
      } else {
        existing.windowCount =
          input.windowCountsByEnvId?.get(envId) ??
          Math.max(existing.windowCount, s.windowCount ?? 1);
      }
    }

    const remoteCandidates: RemoteQuotaCandidate[] = [];
    for (const grp of groupedByEnvId.values()) {
      if (grp.session.email) {
        remoteCandidates.push({
          environmentId: grp.envId,
          email: grp.session.email,
          lifecycleState: grp.lifecycleState,
          quota: grp.session.quota,
          observedAtMs: grp.session.observedAt,
        });
      }
    }

    const sshNodes: EnvironmentNode[] = [];
    const remoteSessionsPayload: Array<{ sortPriority: number; lastFocusedAt: number; payload: Record<string, unknown> }> = [];

    for (const grp of groupedByEnvId.values()) {
      const s = grp.session;
      const matchedId = s.email && input.matchAccountId
        ? input.matchAccountId(s.email)
        : s.matchedLocalAccountId;
      const overview = s.quota
        ? ((s.quotaOverview as QuotaOverview | null) ?? input.getQuotaOverview?.(s.quota, nowMs) ?? null)
        : null;
      const contract = projectQuotaContract(overview ?? {
        familyWindows: null,
        argonStatus: null,
        carbonStatus: null,
        standaloneModels: [],
        projectedQuotaGroups: [],
        refreshState: s.quota?.refresh_state ?? { complete: false },
        quotaWarnings: [],
        quotaWarningCodes: [],
      });
      const resolvedTier = s.tier || overview?.subscriptionTier
        ? normalizeSubscriptionTier(
            input.resolveUnsavedTier
              ? input.resolveUnsavedTier({ tier: s.tier, accountType: s.accountType }, overview)
              : (overview?.subscriptionTier ?? s.tier)
          )
        : '';
      const lastQuotaObservedAt = s.quota?.last_updated ?? (s.observedAt ? Math.floor(s.observedAt / 1000) : null);
      const lastUsageSyncedAt = input.receiptSyncTimes?.get(grp.envId) ?? null;
      const quotaFreshness = computeQuotaFreshness({
        lifecycleState: grp.lifecycleState,
        hasQuota: Boolean(s.quota),
        lastError: s.lastError,
        lastQuotaObservedAtSec: lastQuotaObservedAt,
        isStale: overview?.isStale,
        staleAfterSeconds,
        nowMs,
      });
      const projectedQuota = buildProjectedQuotaPayload(
        s.quota,
        overview,
        resolvedTier,
        input.formatResetTime
      );
      const resetTimeStr = input.formatResetTime
        ? input.formatResetTime(overview?.resetTime ?? null)
        : (overview?.resetTime !== null && overview?.resetTime !== undefined ? String(overview.resetTime) : '');

      sshNodes.push({
        environmentId: grp.envId,
        ...(grp.machineId ? { machineId: grp.machineId } : {}),
        kind: 'ssh',
        hostLabel: grp.hostLabel,
        lifecycleState: grp.lifecycleState,
        windowCount: grp.windowCount,
        focused: false,
        probing: grp.probing,
        accountEmail: s.email || '',
        accountName: s.name ?? '',
        tier: resolvedTier || s.tier || '',
        quota: projectedQuota,
        quotaFreshness,
        lastFocusedAt: grp.lastFocusedAt,
        lastQuotaObservedAt,
        lastUsageSyncedAt,
        lastError: s.lastError || '',
      });

      remoteSessionsPayload.push({
        sortPriority: lifecycleSortPriority(grp.lifecycleState),
        lastFocusedAt: grp.lastFocusedAt,
        payload: {
          remoteKey: s.remoteKey,
          environmentId: grp.envId,
          ...(grp.machineId ? { machineId: grp.machineId } : {}),
          hostLabel: grp.hostLabel,
          targetId: s.targetId,
          state: s.state,
          lifecycleState: grp.lifecycleState,
          windowCount: grp.windowCount,
          probing: grp.probing,
          quotaFreshness,
          email: s.email,
          name: s.name ?? '',
          tier: resolvedTier || s.tier,
          subscription_tier: resolvedTier,
          activeTier: resolvedTier,
          accountType: s.accountType,
          matchedLocalAccountId: matchedId ?? null,
          observedAt: s.observedAt,
          quotaLastUpdated: lastQuotaObservedAt,
          disconnectedAt: s.disconnectedAt,
          lastError: s.lastError,
          lastFocusedAt: grp.lastFocusedAt,
          fiveHourRemaining: overview?.fiveHourRemaining ?? null,
          weeklyRemaining: overview?.weeklyRemaining ?? null,
          resetTime: resetTimeStr,
          resetCountdown: overview?.resetCountdown ?? '',
          staleGroups: overview?.staleGroups ?? [],
          stale_groups: overview?.staleGroups ?? [],
          models: overview?.models ?? [],
          ...contract,
        },
      });
    }

    if (Array.isArray(input.historicalEnvironments)) {
      for (const hist of input.historicalEnvironments) {
        if (!hist || !hist.environmentId || hist.environmentId === 'local') continue;
        if (groupedByEnvId.has(hist.environmentId)) continue;
        const hostLabel = cleanHostLabel(hist.hostLabel) || hist.hostLabel || hist.environmentId;
        const lastUsageSyncedAt = hist.lastSyncedAtSec ?? input.receiptSyncTimes?.get(hist.environmentId) ?? null;
        sshNodes.push({
          environmentId: hist.environmentId,
          kind: 'ssh',
          hostLabel,
          lifecycleState: 'historical_only',
          windowCount: 0,
          focused: false,
          probing: false,
          accountEmail: '',
          accountName: '',
          tier: '',
          quota: null,
          quotaFreshness: 'offline_snapshot',
          lastFocusedAt: 0,
          lastQuotaObservedAt: null,
          lastUsageSyncedAt: lastUsageSyncedAt && lastUsageSyncedAt > 0 ? lastUsageSyncedAt : null,
          lastError: '',
        });
      }
    }

    const localEmail = input.localAccount?.email?.trim() || '';
    const fusedLocal = fuseAccountQuotaAcrossEnvironments({
      email: localEmail,
      savedQuota: input.localAccount?.quota ?? null,
      liveLocalQuota: null,
      remoteSessions: remoteCandidates,
      nowMs,
    });
    const localEffectiveQuota = fusedLocal.quota;
    const localOverview = localEffectiveQuota
      ? (input.getQuotaOverview?.(localEffectiveQuota, nowMs) ?? null)
      : null;
    const localTierRaw = localEffectiveQuota?.subscription_tier || input.localAccount?.tier || localOverview?.subscriptionTier || '';
    const localResolvedTier = localTierRaw
      ? normalizeSubscriptionTier(
          input.resolveUnsavedTier
            ? input.resolveUnsavedTier({ tier: localTierRaw, accountType: 'consumer' }, localOverview)
            : localTierRaw
        )
      : (localEmail ? normalizeSubscriptionTier('') : 'FREE');
    const localLastQuotaObservedAt =
      fusedLocal.freshestObservedAtSec ??
      localEffectiveQuota?.last_updated ??
      input.localAccount?.observedAtSec ??
      null;
    const localLastError = input.localAccount?.lastError ?? '';
    const localQuotaFreshness = computeQuotaFreshness({
      lifecycleState: 'online',
      hasQuota: Boolean(localEffectiveQuota),
      lastError: localLastError,
      lastQuotaObservedAtSec: localLastQuotaObservedAt,
      isStale: localOverview?.isStale,
      staleAfterSeconds,
      nowMs,
    });
    const localProjectedQuota = buildProjectedQuotaPayload(
      localEffectiveQuota,
      localOverview,
      localResolvedTier,
      input.formatResetTime
    );
    const localDisplayLabel =
      input.localLabel ?? (getActiveLocale() === 'en' ? 'Local' : '本机');
    const localLastUsageSyncedAt =
      input.localAccount?.lastSyncedAtSec ??
      input.receiptSyncTimes?.get('local') ??
      null;

    const localNode: EnvironmentNode = {
      environmentId: 'local',
      kind: 'local',
      hostLabel: localDisplayLabel,
      lifecycleState: 'online',
      windowCount: Math.max(0, input.localWindowCount),
      focused: false,
      probing: false,
      accountEmail: localEmail,
      accountName: input.localAccount?.name?.trim() || '',
      tier: localResolvedTier,
      quota: localProjectedQuota,
      quotaFreshness: localQuotaFreshness,
      lastFocusedAt: input.localFocusedAt ?? 0,
      lastQuotaObservedAt: localLastQuotaObservedAt,
      lastUsageSyncedAt: localLastUsageSyncedAt && localLastUsageSyncedAt > 0 ? localLastUsageSyncedAt : null,
      lastError: localLastError,
    };

    sshNodes.sort((a, b) => {
      const pDiff = lifecycleSortPriority(b.lifecycleState) - lifecycleSortPriority(a.lifecycleState);
      if (pDiff !== 0) return pDiff;
      if (b.lastFocusedAt !== a.lastFocusedAt) return b.lastFocusedAt - a.lastFocusedAt;
      return a.hostLabel.localeCompare(b.hostLabel);
    });

    const environments = [localNode, ...sshNodes];
    const requestedFocus = input.focusedEnvironmentId || 'local';
    const focusCandidate = environments.find(
      n => n.environmentId === requestedFocus && (n.lifecycleState === 'online' || n.lifecycleState === 'auth_expired')
    );
    const resolvedFocusedEnvironmentId = focusCandidate ? focusCandidate.environmentId : 'local';
    for (const node of environments) {
      node.focused = node.environmentId === resolvedFocusedEnvironmentId;
    }

    remoteSessionsPayload.sort((a, b) => {
      if (b.sortPriority !== a.sortPriority) return b.sortPriority - a.sortPriority;
      return b.lastFocusedAt - a.lastFocusedAt;
    });

    const signature = JSON.stringify([
      resolvedFocusedEnvironmentId,
      environments.map(n => ({
        environmentId: n.environmentId,
        machineId: n.machineId ?? null,
        kind: n.kind,
        hostLabel: n.hostLabel,
        lifecycleState: n.lifecycleState,
        windowCount: n.windowCount,
        focused: n.focused,
        probing: n.probing,
        accountEmail: n.accountEmail,
        accountName: n.accountName,
        tier: n.tier,
        quotaFreshness: n.quotaFreshness,
        lastFocusedAt: n.lastFocusedAt,
        lastQuotaObservedAt: n.lastQuotaObservedAt,
        lastUsageSyncedAt: n.lastUsageSyncedAt,
        lastError: n.lastError,
        quotaLastUpdated: (n.quota as Record<string, unknown> | null)?.last_updated ?? null,
        fiveHour: (n.quota as Record<string, unknown> | null)?.fiveHourRemaining ?? null,
        weekly: (n.quota as Record<string, unknown> | null)?.weeklyRemaining ?? null,
      })),
    ]);
    if (signature !== this.lastSignature) {
      this.lastSignature = signature;
      this.revision += 1;
    }

    return {
      environments,
      environmentsRevision: this.revision,
      remoteSyncRevision: input.remoteSyncRevision,
      focusedEnvironmentId: resolvedFocusedEnvironmentId,
      remoteSessions: remoteSessionsPayload.map(item => item.payload),
    };
  }
}
