import { CloudQuotaAuthorityError, mergeSubscriptionTier, type CloudProviderContext } from './account-probe.js';
import { bt } from './i18n.js';
import { normalizeCatalogTierLabel } from './pricing.js';
import { resolveOutboundFetch } from './proxy.js';
import {
  CodedAccountError,
  accountErrorCode,
  endpointHost,
  endpointPriority,
  familyLabel,
  groupToQuotaGroup,
  modelQuotaFromNormalized,
  normalizedModelFromStored,
  type Account,
  type QuotaRefreshState,
} from './account-quota.js';
import {
  applyFamilyWindows,
  buildArgonStatus,
  buildCarbonStatus,
  buildStandaloneModels,
  familyWindowsFromGroups,
  isExcludedFromStandaloneModelPool,
  isGroupAllDisabled,
  matchModelToSharedPool,
  mergeGroupSets,
  mergeGroupsWithPrevious,
  mergeModelCatalogues,
  mergeModelsWithPrevious,
  normalizeCloudGroups,
  normalizeCloudModels,
  normalizeIndependentArgonQuota,
  normalizeStoredGroups,
  resolveModelsWithGroupDescriptions,
  type Family,
  type NormalizedGroup,
  type NormalizedModel,
  type QuotaSource,
  type WindowKind,
} from './quota.js';

export function getGoogleClientId(): string {
  return process.env.GRAVITYBOX_GOOGLE_CLIENT_ID || '';
}
export function getGoogleClientSecret(): string {
  return process.env.GRAVITYBOX_GOOGLE_CLIENT_SECRET || '';
}

export const CLOUD_CODE_LOAD_PROJECT_ENDPOINTS = [
  'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:loadCodeAssist',
  'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
  'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
];

export const QUOTA_API_ENDPOINTS = [
  'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels',
  'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
  'https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
];

export const QUOTA_SUMMARY_ENDPOINTS = [
  'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
  'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
  'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary',
];


export async function fetchCloudQuotaForAccount(params: {
  account: Account;
  providerContext: CloudProviderContext | null;
  fetchImpl: typeof globalThis.fetch;
  signal?: AbortSignal;
  onTokenRefreshed: (account: Account, previousRefresh: string) => Promise<void>;
}): Promise<Account> {
  const { account, providerContext, fetchImpl, signal } = params;
  const outboundFetch = resolveOutboundFetch(fetchImpl);
  const endpointSet=(method:string,legacy:string[])=>providerContext?[providerContext.origin+'/v1internal:'+method]:legacy;
  const providerAgent=providerContext?.userAgent??'Antigravity/0.9.0';
  account.quota_refresh_error = null;
  account.quota_refresh_error_code = null;
  const nowSec = Math.floor(Date.now() / 1000);
  const needTokenRefresh =
    !account.token.access_token ||
    account.token.access_token === 'pending_refresh' ||
    !Number.isFinite(account.token.expiry_timestamp) ||
    account.token.expiry_timestamp - nowSec < 300;

  // 整体预算：所有已配置端点默认都查一遍；阶段内 3 并发；整体 12s 上限；用户 signal 可取消。
  const budget = new AbortController();
  let deadlineFired = false;
  const deadline = setTimeout(() => {
    deadlineFired = true;
    budget.abort(new Error(bt('account_cloud.err.budget_timeout')));
  }, 12_000);
  const parentSignal = signal ? AbortSignal.any([signal, budget.signal]) : budget.signal;
  const requestSignal = (timeoutMs: number) => AbortSignal.any([parentSignal, AbortSignal.timeout(timeoutMs)]);
  const ordered = (endpoints: string[]) => [...endpoints].sort((left, right) => endpointPriority(left) - endpointPriority(right));
  let projectContextRecovered = false;
  let projectObserved = false;
  const attempted: string[] = [];
  const succeeded: string[] = [];
  const note = (kind: string, endpoint: string, ok: boolean) => {
    const tag = `${kind}:${endpointHost(endpoint)}`;
    attempted.push(tag);
    if (ok) succeeded.push(tag);
  };
  const userAborted = (): boolean => signal?.aborted === true;
  const throwIfUserAborted = () => {
    if (userAborted()) throw signal?.reason ?? new Error(bt('account_cloud.err.aborted'));
  };

  try {
    if (needTokenRefresh) {
      const previousRefresh = account.token.refresh_token;
      if (!account.token.refresh_token) throw new CodedAccountError('missing_refresh_token', bt('account_cloud.err.missing_refresh_token'));
      const clientId = getGoogleClientId(), clientSecret = getGoogleClientSecret();
      if (fetchImpl === globalThis.fetch && (!clientId || !clientSecret)) {
        throw new CodedAccountError('missing_oauth_client', bt('account_cloud.err.missing_oauth_client'));
      }
      try {
        const response = await outboundFetch('https://oauth2.googleapis.com/token', {
          method: 'POST', signal: requestSignal(10000),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret,
            refresh_token: account.token.refresh_token, grant_type: 'refresh_token' }).toString(),
        });
        if (!response.ok) {
          let oauthError = '';
          try {
            const rawErr: any = typeof response.json === 'function'
              ? await response.json()
              : JSON.parse(await (response as any).text());
            if (typeof rawErr?.error === 'string') oauthError = rawErr.error.trim().toLowerCase();
          } catch {}
          if (response.status === 429) {
            throw new CodedAccountError('oauth_rate_limited', bt('account_cloud.err.oauth_rate_limited'));
          }
          if (response.status >= 500) {
            throw new CodedAccountError('oauth_server_error', bt('account_cloud.err.oauth_server_error'));
          }
          if (oauthError === 'invalid_client' || oauthError === 'unauthorized_client') {
            throw new CodedAccountError('oauth_client_error', bt('account_cloud.err.oauth_client_error'));
          }
          throw new CodedAccountError('refresh_failed', bt('account_cloud.err.refresh_failed'));
        }
        const data: any = typeof response.json === 'function'
          ? await response.json()
          : JSON.parse(await (response as any).text());
        if (typeof data.access_token !== 'string' || !data.access_token) throw new CodedAccountError('no_access_token', bt('account_cloud.err.no_access_token'));
        account.token.access_token = data.access_token;
        account.token.expires_in = Number(data.expires_in) || 3600;
        account.token.expiry_timestamp = nowSec + account.token.expires_in;
        if (data.refresh_token) account.token.refresh_token = data.refresh_token;
        signal?.throwIfAborted();
        await params.onTokenRefreshed(account, previousRefresh);
      } catch (error) {
        if (userAborted()) throw error;
        if (accountErrorCode(error)) throw error;
        if (error instanceof Error && /凭据|credential|已移除|已被删除|冲突|removed|deleted|conflict/i.test(error.message)) throw error;
        throw new CodedAccountError('network', bt('account_cloud.err.network'), { cause: error });
      }
    }

    type EndpointResult<T> = { endpoint: string; ok: boolean; data?: T; error?: string };
    const httpFailure=async(response:Response):Promise<string>=>{
      if(response.status===403){
        try {const data:any=await response.json();if(data?.error?.status==='PERMISSION_DENIED'&&/\(#3501\)/.test(String(data?.error?.message??'')))return bt('account_cloud.err.http_3501');}catch{}
      }
      return `HTTP ${response.status}`;
    };
    let projectId = account.token.project_id || null;
    const savedSubscriptionTier: string | null = account.quota?.subscription_tier || null;
    let observedSubscriptionTier: string | null = null;
    let subscriptionTier: string | null = savedSubscriptionTier;
    let tierObserved = false;
    let loadReady: Promise<void> = Promise.resolve();
    const queryAll = async <T>(endpoints: string[], body: (projectId: string | null) => unknown): Promise<EndpointResult<T>[]> => {
      return Promise.all(ordered(endpoints).map(async endpoint => {
        if (parentSignal.aborted) return { endpoint, ok: false, error: bt('account_cloud.err.aborted') };
        try {
          const response = await outboundFetch(endpoint, {
            method: 'POST', signal: requestSignal(6000),
            headers: {
              Authorization: `Bearer ${account.token.access_token}`,
              'Content-Type': 'application/json',
              'User-Agent': providerAgent,
            },
            body: JSON.stringify(body(projectId)),
          });
          if (!response.ok) {
            const failure = await httpFailure(response);
            if (providerContext && endpoint.endsWith(':retrieveUserQuotaSummary') && failure.includes('3501')) {
              await loadReady;
              if (projectObserved && projectId) {
                const retry = await outboundFetch(endpoint,{method:'POST',signal:requestSignal(6000),headers:{Authorization:`Bearer ${account.token.access_token}`,'Content-Type':'application/json','User-Agent':providerAgent},body:JSON.stringify({project:projectId})});
                if(!retry.ok)return {endpoint,ok:false,error:await httpFailure(retry)};
                const data=await retry.json() as T;
                if(!normalizeCloudGroups(data,nowSec).some(group=>group.buckets.some(bucket=>bucket.remaining_fraction_known)))return{endpoint,ok:false,error:bt('account_cloud.err.project_no_verifiable_quota')};
                projectContextRecovered=true;return{endpoint,ok:true,data};
              }
            }
            if (!projectId || JSON.stringify(body(projectId))===JSON.stringify(body(null))) return { endpoint, ok: false, error: failure };
            // 403/权限受阻时按官方惯例去掉 project 再试一次（同端点内重试）。
            const retry = await outboundFetch(endpoint, {
              method: 'POST', signal: requestSignal(6000),
              headers: {
                Authorization: `Bearer ${account.token.access_token}`,
                'Content-Type': 'application/json',
                'User-Agent': providerAgent,
              },
              body: JSON.stringify(body(null)),
            });
            if (!retry.ok) return { endpoint, ok: false, error: await httpFailure(retry) };
            return { endpoint, ok: true, data: await retry.json() as T };
          }
          return { endpoint, ok: true, data: await response.json() as T };
        } catch (error) {
          return { endpoint, ok: false, error: error instanceof Error ? error.message : bt('account_cloud.reason.read_failed') };
        }
      }));
    };

    // 2-4) 并行发起 loadCodeAssist、fetchAvailableModels 与 retrieveUserQuotaSummary，消除 3 阶段串行 RTT 等待。
    const loadPromise = queryAll<any>(endpointSet('loadCodeAssist',CLOUD_CODE_LOAD_PROJECT_ENDPOINTS), () => ({ metadata: { ideType: 'ANTIGRAVITY' } })).then(results => {
      for (const result of results) {
        if (!result.ok) continue;
        const data = result.data ?? {};
        const project = data.cloudaicompanionProject;
        if (!projectObserved && (typeof project === 'string' || typeof project?.id === 'string')) {
          projectId = typeof project === 'string' ? project : project.id;
          account.token.project_id = projectId;
          projectObserved = true;
        }
        const tierCandidates = [
          data.paidTier?.name,
          data.paidTier?.id,
          data.paid_tier?.name,
          data.paid_tier?.id,
          data.userTier?.name,
          data.userTier?.id,
          data.user_tier?.name,
          data.user_tier?.id,
          data.g1Tier,
          data.g1_tier,
          data.currentTier?.name,
          data.currentTier?.id,
          data.current_tier?.name,
          data.current_tier?.id,
        ].filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
        const ultraTier = tierCandidates.find(v => /ultra/i.test(v));
        const rawTier = ultraTier ?? tierCandidates[0];
        if (typeof rawTier === 'string' && rawTier.trim()) {
          if (!tierObserved || (ultraTier && !/ultra/i.test(observedSubscriptionTier ?? ''))) {
            observedSubscriptionTier = String(rawTier);
            subscriptionTier = observedSubscriptionTier;
            tierObserved = true;
          }
        }
      }
      return results;
    });
    loadReady = loadPromise.then(() => undefined, () => undefined);
    const [loadResults, modelResults, summaryResults] = await Promise.all([
      loadPromise,
      queryAll<any>(endpointSet('fetchAvailableModels',QUOTA_API_ENDPOINTS), () => ({})),
      queryAll<any>(endpointSet('retrieveUserQuotaSummary',QUOTA_SUMMARY_ENDPOINTS), () => ({})),
    ]);
    for (const result of loadResults) {
      note('load', result.endpoint, result.ok);
    }
    throwIfUserAborted();

    // 3) fetchAvailableModels：全部端点各查一次，按优先级合并模型目录（prod 已知值不被 daily 覆盖）。
    const modelCatalogues: NormalizedModel[][] = [];
    let forwarding: Record<string, string> = {};
    const deprecatedAll = new Set<string>();
    for (const result of modelResults) {
      note('models', result.endpoint, result.ok);
      if (!result.ok) continue;
      modelCatalogues.push(normalizeCloudModels(result.data ?? {}, nowSec));
      const deprecated = result.data?.deprecatedModelIds ?? result.data?.deprecated_model_ids
        ?? result.data?.response?.deprecatedModelIds ?? result.data?.response?.deprecated_model_ids;
      if (deprecated && typeof deprecated === 'object') {
        for (const [oldId, info] of Object.entries<any>(deprecated)) {
          deprecatedAll.add(oldId);
          const nextId = info?.newModelId ?? info?.new_model_id;
          if (nextId && !forwarding[oldId]) forwarding[oldId] = String(nextId);
        }
      }
    }
    throwIfUserAborted();
    let freshModels = mergeModelCatalogues(modelCatalogues);
    if (deprecatedAll.size > 0) {
      freshModels = freshModels.map(m => (deprecatedAll.has(m.model_id) || deprecatedAll.has(m.name)) ? { ...m, deprecated: true } : m);
    }

    // 4) retrieveUserQuotaSummary：全部端点各查一次，语义合并 family+window。
    const groupSets: NormalizedGroup[][] = [];
    for (const result of summaryResults) {
      note('summary', result.endpoint, result.ok);
      if (!result.ok) continue;
      groupSets.push(normalizeCloudGroups(result.data ?? {}, nowSec));
    }
    throwIfUserAborted();
    const freshGroups = mergeGroupSets(groupSets);
    freshModels = resolveModelsWithGroupDescriptions(freshModels, freshGroups);
    const hasStandaloneOwnQuota = freshModels.some(model =>
      (model.family === 'argon' || model.family === 'carbon' || model.family === 'other')
      && !isExcludedFromStandaloneModelPool(model)
      && model.own_percentage_known && !model.own_stale);
    if(providerContext&&!freshGroups.some(group=>group.buckets.some(bucket=>bucket.disabled!==true&&bucket.remaining_fraction_known)) && !hasStandaloneOwnQuota) {
      const reason=summaryResults.map(row=>row.error||(!row.ok?bt('account_cloud.reason.read_failed'):bt('account_cloud.reason.no_window'))).join(bt('common.sentence_separator'));
      throw new CloudQuotaAuthorityError(bt('account_cloud.err.authority_empty', { reason }));
    }

    if (freshModels.length === 0 && freshGroups.length === 0) {
      throw new Error(bt('account_cloud.err.no_quota_kept'));
    }

    const freshWindows = familyWindowsFromGroups(freshGroups, Date.now());
    const freshArgon = buildArgonStatus(freshModels, freshGroups, freshWindows, Date.now(), subscriptionTier);
    const freshCarbon = buildCarbonStatus(freshModels, freshGroups, freshWindows, Date.now(), freshArgon, subscriptionTier);
    const freshStandalone = buildStandaloneModels(
      freshModels,
      freshGroups,
      freshWindows,
      Date.now(),
      freshArgon,
      freshCarbon,
      subscriptionTier,
    );
    // 当官方 RetrieveUserQuotaSummary 已返回权威 groups[] 时，不再为 'other' 或编排器模型额外探测 :retrieveUserQuota。
    const needOtherStandaloneQuota = freshGroups.length === 0 && (
      freshStandalone.some(
        item => item.key !== 'argon' && item.key !== 'carbon' && item.availability !== 'disabled' && item.quotaState !== 'known'
      ) ||
      freshModels.some(
        m =>
          m.family === 'other' &&
          !isExcludedFromStandaloneModelPool(m) &&
          !m.own_percentage_known &&
          matchModelToSharedPool(m, freshWindows, freshGroups, subscriptionTier, freshModels) === null
      )
    );
    const normalizedSubscriptionTier = normalizeCatalogTierLabel(subscriptionTier);
    const missingIndependentModelIds = new Set<string>();
    for (const item of freshStandalone) {
      if (item.availability !== 'disabled' && item.quotaState !== 'known' && item.key) {
        missingIndependentModelIds.add(item.key);
      }
    }
    for (const m of freshModels) {
      if (isExcludedFromStandaloneModelPool(m) || m.own_percentage_known) continue;
      const isMissingOther =
        m.family === 'other' &&
        matchModelToSharedPool(m, freshWindows, freshGroups, subscriptionTier, freshModels) === null;
      const isMissingStandaloneFamily =
        (m.family === 'argon' && freshArgon.mode !== 'unified' && freshArgon.mode !== 'disabled') ||
        (m.family === 'carbon' && freshCarbon.mode !== 'unified' && freshCarbon.mode !== 'disabled');
      if (isMissingOther || isMissingStandaloneFamily) {
        if (m.model_id) missingIndependentModelIds.add(m.model_id);
        if (m.name) missingIndependentModelIds.add(m.name);
      }
    }
    const needIndependentQuota = providerContext !== null && (needOtherStandaloneQuota || (['argon', 'carbon'] as const).some(family => {
      const status = family === 'argon' ? freshArgon : freshCarbon;
      if (status.mode === 'unified' || status.mode === 'disabled') return false;
      const familyModels = freshModels.filter(m => m.family === family && !isExcludedFromStandaloneModelPool(m));
      const hasFamilyGroup = freshGroups.some(g => g.family === family && !isGroupAllDisabled(g));
      if (hasFamilyGroup || familyModels.some(m => m.own_percentage_known)) return false;
      if (family === 'argon') {
        if (familyModels.length === 0 && freshGroups.length > 0 && (normalizedSubscriptionTier === 'FREE' || normalizedSubscriptionTier === 'ULTRA')) {
          return false;
        }
        return true;
      }
      return familyModels.length > 0;
    }));
    if (needIndependentQuota && providerContext) {
      const independent=await queryAll<any>([providerContext.origin+'/v1internal:retrieveUserQuota'],()=>projectContextRecovered&&projectObserved&&projectId?{project:projectId}:{});
      const independentOpts = missingIndependentModelIds.size > 0 ? { allowedModelIds: missingIndependentModelIds } : undefined;
      for(const result of independent) {note('independent-quota',result.endpoint,result.ok);if(result.ok)freshModels=mergeModelCatalogues([freshModels,normalizeIndependentArgonQuota(result.data,nowSec,independentOpts)]);}
      freshModels = resolveModelsWithGroupDescriptions(freshModels, freshGroups);
    }

    // 5) 与上一次快照做语义 carryover：fresh 覆盖同 family+window，旧桶/旧模型单独标 stale。
    const previousSource: QuotaSource = account.quota?.source === 'live' ? 'live' : 'cloud';
    const matchingScope=!providerContext||account.quota?.source==='live'||(account.quota?.refresh_state?.providerOrigin===providerContext.origin&&account.quota?.refresh_state?.providerUserAgent===providerContext.userAgent&&account.quota?.refresh_state?.requestScope==='account');
    const previousGroups = normalizeStoredGroups(matchingScope?account.quota?.quota_groups ?? []:[], account.quota?.last_updated ?? nowSec, previousSource);
    const previousModels = (matchingScope?account.quota?.models ?? []:[]).map(model => normalizedModelFromStored(model, previousSource, previousGroups));
    const { groups: mergedGroups, staleGroups } = mergeGroupsWithPrevious(freshGroups, previousGroups, Date.now());
    const { models: mergedModels, carriedCount } = mergeModelsWithPrevious(freshModels, previousModels);
    const windows = familyWindowsFromGroups(mergedGroups, Date.now());
    const applied = applyFamilyWindows(mergedModels, windows);
    const mergedArgon = buildArgonStatus(applied, mergedGroups, windows, Date.now(), subscriptionTier);
    const mergedCarbon = buildCarbonStatus(applied, mergedGroups, windows, Date.now(), mergedArgon, subscriptionTier);
    const isIgnoredStandaloneFamily = (family: Family): boolean =>
      (family === 'argon' && (mergedArgon.mode === 'unified' || mergedArgon.mode === 'disabled'))
      || (family === 'carbon' && (mergedCarbon.mode === 'unified' || mergedCarbon.mode === 'disabled'));

    // 6) 完整性：缺 family / 缺已知窗口 / 生产端点失败 / 预算超时 → complete=false，并保留原因。
    const expectedFamilies = new Set<Family>();
    const mergedGroupPresent = (group: NormalizedGroup): boolean => mergedGroups.some(item =>
      item.family === group.family
      && (item.family !== 'other'
        || (Boolean(item.group_id && group.group_id) && item.group_id === group.group_id)
        || item.display_name.toLowerCase() === group.display_name.toLowerCase()));
    for (const group of previousGroups) {
      if (group.family === 'other' || isIgnoredStandaloneFamily(group.family)) continue;
      if (group.family === 'gemini' || group.family === 'claude' || mergedGroupPresent(group)) {
        expectedFamilies.add(group.family);
      }
    }
    for (const model of freshModels) {
      if (model.family !== 'other' && !isExcludedFromStandaloneModelPool(model) && !isIgnoredStandaloneFamily(model.family)) {
        expectedFamilies.add(model.family);
      }
    }
    const presentFamilies = new Set(mergedGroups.filter(group => group.buckets.some(bucket => bucket.disabled !== true && bucket.remaining_fraction_known && !bucket.stale)).map(group => group.family));
    for (const model of applied) if ((model.family === 'argon' || model.family === 'carbon') && !isExcludedFromStandaloneModelPool(model) && model.own_percentage_known && !model.own_stale) presentFamilies.add(model.family);
    const missingFamilies = [...expectedFamilies].filter(family => !presentFamilies.has(family));
    const missingWindows: { family: Family; window: WindowKind }[] = [];
    for (const previous of previousGroups) {
      if (isIgnoredStandaloneFamily(previous.family)) continue;
      const isCoreGroup = previous.family === 'gemini' || previous.family === 'claude';
      if (!isCoreGroup && !mergedGroupPresent(previous)) continue;
      for (const bucket of previous.buckets) {
        if (bucket.disabled === true || bucket.window === 'unspecified') continue;
        const present = mergedGroups.some(group => group.family === previous.family
          && group.buckets.some(item => item.disabled !== true && item.window === bucket.window && item.remaining_fraction_known && !item.stale));
        if (!present) missingWindows.push({ family: previous.family, window: bucket.window });
      }
    }
    const production = (endpoint: string) => providerContext ? new URL(endpoint).origin===providerContext.origin : endpointPriority(endpoint) === 0;
    const productionSucceeded = summaryResults.some(result => result.ok && production(result.endpoint)
      && (normalizeCloudGroups(result.data ?? {}, nowSec).length > 0 || hasStandaloneOwnQuota))
      && modelResults.some(result => result.ok && production(result.endpoint)
        && normalizeCloudModels(result.data ?? {}, nowSec).length > 0);
    const usedFallbackEndpoint = !productionSucceeded;
    const hasFreshKnownBucket = hasStandaloneOwnQuota || mergedGroups.some(group => group.buckets.some(bucket => bucket.remaining_fraction_known && !bucket.stale));
    const complete = !deadlineFired && !userAborted() && missingFamilies.length === 0 && missingWindows.length === 0
      && freshModels.length > 0 && hasFreshKnownBucket && !usedFallbackEndpoint;

    const warnings: string[] = [];
    if (deadlineFired) warnings.push(bt('account_cloud.warn.budget_timeout'));
    if (usedFallbackEndpoint) warnings.push(bt('account_cloud.warn.fallback_endpoint'));
    for (const family of missingFamilies) warnings.push(bt('account_cloud.warn.missing_family', { family, label: familyLabel(family) }));
    for (const item of missingWindows) warnings.push(bt('account_cloud.warn.missing_window', { family: item.family, window: item.window, label: familyLabel(item.family) }));
    for (const stale of staleGroups.slice(0, 12)) warnings.push(bt('account_cloud.warn.carried', { name: stale.name, iso: new Date(stale.observed_at * 1000).toISOString() }));
    if (mergedArgon.mode !== 'unified' && applied.some(model => model.family === 'argon' && model.disabled === true)) warnings.push(bt('account_cloud.warn.argon_disabled'));
    if (mergedArgon.mode !== 'unified' && mergedArgon.mode !== 'disabled' && !mergedGroups.some(g => g.family === 'argon') && applied.some(model => model.family === 'argon' && model.disabled === null && model.own_percentage_known)) warnings.push(bt('account_cloud.warn.argon_model_quota'));

    const missingLabels = missingFamilies.map(familyLabel);
    account.quota_refresh_error = missingLabels.length > 0 ? bt('account_cloud.refresh_err.missing_families', { labels: missingLabels.join(bt('common.list_separator')) }) : null;
    account.quota_refresh_error_code = null;

    const groupObservations = mergedGroups
      .map(group => group.observed_at)
      .filter((value): value is number => typeof value === 'number');
    const lastUpdated = groupObservations.length > 0 ? Math.min(...groupObservations) : nowSec;
    const refreshState: QuotaRefreshState = {
      complete,
      endpointsAttempted: attempted,
      endpointsSucceeded: succeeded,
      missingFamilies,
      missingWindows,
      carriedGroups: staleGroups.length,
      carriedModels: carriedCount,
      refreshedAt: nowSec,
      usedFallbackEndpoint,
      ...(providerContext?{providerOrigin:providerContext.origin,providerUserAgent:providerContext.userAgent,requestScope:'account' as const,projectContextRecovered}:{}),
      ...(deadlineFired ? { error: bt('account_cloud.refresh_state.budget_timeout') } : {}),
    };

    const resolvedSubscriptionTier = mergeSubscriptionTier(
      tierObserved ? observedSubscriptionTier : '',
      savedSubscriptionTier,
      { allowFreeDowngrade: complete && tierObserved }
    ) ?? null;

    account.quota = {
      models: applied.map(modelQuotaFromNormalized),
      quota_groups: mergedGroups.map(groupToQuotaGroup),
      is_forbidden: false,
      subscription_tier: resolvedSubscriptionTier,
      last_updated: lastUpdated,
      model_forwarding_rules: forwarding,
      source: 'cloud',
      ...(staleGroups.length > 0 ? { stale_groups: staleGroups } : {}),
      refresh_state: refreshState,
      ...(warnings.length > 0 ? { quota_warnings: warnings } : {}),
    };

    signal?.throwIfAborted();
    return account;
  } finally {
    clearTimeout(deadline);
  }
}
