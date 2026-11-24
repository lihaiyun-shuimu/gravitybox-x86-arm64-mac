import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { bt, getActiveLocale, translate } from './i18n.js';
import {
  applyFamilyWindows,
  buildArgonStatus,
  buildCarbonStatus,
  buildStandaloneModels,
  classifyFamily,
  classifyWindow,
  extractGroupWindows,
  extractStandaloneGeminiCodename,
  familyWindowsFromGroups,
  familyModelQuotaFromModels,
  findGroupForModelByDescription,
  isExcludedFromStandaloneModelPool,
  isOrchestratorMetaModel,
  legacyFromFamilyWindows,
  matchModelToSharedPool,
  mergeGroupSets,
  mergeModelCatalogues,
  mergeWindowStatuses,
  normalizeBaseModelKey,
  normalizeCloudGroups,
  normalizeCloudModels,
  normalizeResetTime,
  formatCountdown,
  normalizeStoredGroups,
  normalizeFraction,
  resolveModelsWithGroupDescriptions,
  type ArgonStatus,
  type Availability,
  type StandaloneModelStatus,
  type Family,
  type FamilyWindows,
  type NormalizedGroup,
  type NormalizedModel,
  type QuotaSource,
  type QuotaState,
  type WindowKind,
  type WindowStatus,
} from './quota.js';

/** cloudcode 端点优先级：production(0) > daily(1) > sandbox(2)。 */
export function endpointPriority(url: string): number {
  if (url.includes('daily-cloudcode-pa.sandbox.googleapis.com')) return 2;
  if (url.includes('daily-cloudcode-pa.googleapis.com')) return 1;
  if (url.includes('cloudcode-pa.googleapis.com')) return 0;
  if (url.includes('oauth2.googleapis.com')) return 0;
  return 3;
}

export function endpointHost(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

export function pickNextReset(
  familyWindows: FamilyWindows,
  window: '5h' | 'weekly',
  nowMs: number,
): { family: Family; resetTime: string; resetCountdown: string } | null {
  let best: { family: Family; resetTime: string; resetCountdown: string } | null = null;
  for (const family of ['gemini', 'claude', 'argon', 'carbon'] as const) {
    const pair = familyWindows[family];
    if (!pair) continue;
    const status = window === '5h' ? pair.fiveHour : pair.weekly;
    if (!status?.known || status.stale || !status.resetTime) continue;
    const parsed = Date.parse(status.resetTime);
    if (Number.isNaN(parsed)) continue;
    if (!best || parsed < Date.parse(best.resetTime)) {
      best = { family, resetTime: status.resetTime, resetCountdown: formatResetCountdown(status.resetTime, nowMs) };
    }
  }
  return best;
}

export function familyLabel(family: Family): string {
  return family === 'gemini' ? 'Gemini' : family === 'claude' ? 'Claude/GPT' : family === 'argon' ? 'Argon' : family === 'carbon' ? 'Carbon' : bt('quota.family.other');
}

/**
 * 格式化相对时间倒计时（如 "6天 16小时后重置"、"1小时 25分后重置"、"即将重置"、"重置时间已过"）
 * nowMs 允许同一份载荷使用同一参考时刻，避免同屏倒计时出现多个值。
 */
export function formatResetCountdown(resetTime: string | number | null | undefined, nowMs: number = Date.now()): string {
  return formatCountdown(resetTime, nowMs, { preserveUnparsed: true });
}

/** 供应商英文描述中的倒计时（如 "it will fully refresh in 4 hours, 29 minutes."）统一按 reset_time 现算。 */
function formatResetDurationEn(resetTime: string | number | null | undefined, nowMs: number): string | null {
  if (!resetTime) return null;
  const tsMs = typeof resetTime === 'number'
    ? (resetTime < 1e11 ? resetTime * 1000 : resetTime)
    : Date.parse(resetTime);
  if (isNaN(tsMs)) return null;
  const diffMs = tsMs - nowMs;
  if (diffMs <= 0) return '0 minutes';
  const totalMin = Math.max(0, Math.floor(diffMs / 60000));
  const days = Math.floor(totalMin / (24 * 60));
  const hours = Math.floor((totalMin % (24 * 60)) / 60);
  const mins = totalMin % 60;
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  if (days > 0) return `${plural(days, 'day')}${hours || mins ? `, ${plural(hours, 'hour')}` : ''}`;
  if (hours > 0) return `${plural(hours, 'hour')}${mins ? `, ${plural(mins, 'minute')}` : ''}`;
  return plural(mins, 'minute');
}

/**
 * 把英文配额描述里冻结的倒计时句子替换为按同一参考时刻重算的值，其余英文原文保持不变。
 * 覆盖 "in 4 hours, 29 minutes" / "in 4 hours" / "in 29 minutes" / "in 2 days" 等形态。
 */
export function refreshResetDescription(
  description: string | null | undefined,
  resetTime: string | number | null | undefined,
  nowMs: number = Date.now()
): string | undefined {
  if (!description) return description ?? undefined;
  const fresh = formatResetDurationEn(resetTime, nowMs);
  if (!fresh) return description;
  const duration = '(?:\\d+\\s*(?:days?|hours?|minutes?|seconds?))(?:\\s*(?:,|and)?\\s*\\d+\\s*(?:days?|hours?|minutes?|seconds?))*';
  const pattern = new RegExp(`(\\bin\\s+)${duration}`, 'i');
  if (!pattern.test(description)) return description;
  return description.replace(pattern, `$1${fresh}`);
}

export interface DeviceProfile {
  machine_id: string;
  mac_machine_id: string;
  dev_device_id: string;
  sqm_id: string;
}

export interface TokenData {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  expiry_timestamp: number;
  token_type: string;
  email?: string | null;
  project_id?: string | null;
  oauth_client_key?: string | null;
  session_id?: string | null;
  is_gcp_tos: boolean;
  id_token?: string | null;
}

export interface QuotaBucket {
  bucket_id: string;
  /** 规范窗口：5h | daily | weekly | unspecified（旧数据可能是任意原始字符串） */
  window: string;
  remaining_fraction: number;
  remaining_fraction_known?: boolean;
  percentage?: number | null;
  reset_time: string;
  reset_countdown?: string;
  display_name?: string;
  description?: string;
  disabled?: boolean;
  observed_at?: number;
  last_updated?: number;
  observedAt?: number;
  family?: Family;
  stale?: boolean;
  source?: QuotaSource;
}

export interface QuotaGroup {
  group_id?: string;
  display_name: string;
  description?: string;
  buckets: QuotaBucket[];
  observed_at?: number;
  last_updated?: number;
  observedAt?: number;
  family?: Family;
  stale?: boolean;
  source?: QuotaSource;
}

export interface ModelQuota {
  /** 兼容字段：模型 ID（实际 API id） */
  name: string;
  /** 兼容投影 = effective = min(own, 相关 family 已知新鲜窗口)；不覆盖 own 真值 */
  percentage: number;
  percentage_known?: boolean;
  observed_remaining_fraction?: number;
  quota_bucket_id?: string;
  reset_time: string;
  reset_countdown?: string;
  display_name?: string;
  supports_images?: boolean;
  supports_thinking?: boolean;
  thinking_budget?: number;
  recommended?: boolean;
  max_tokens?: number;
  max_output_tokens?: number;
  supported_mime_types?: Record<string, boolean>;
  // 扩展配额与模型状态字段（均可选，旧数据容错）
  model_id?: string;
  model_or_alias?: string | null;
  quota_bucket_name?: string | null;
  is_internal?: boolean;
  model_provider?: string | null;
  deprecated?: boolean;
  non_chat_specialized?: boolean;
  in_model_selector?: boolean;
  family?: Family;
  is_argon?: boolean;
  is_carbon?: boolean;
  disabled?: boolean | null;
  quota_source?: QuotaSource;
  stale?: boolean;
  own_percentage?: number | null;
  own_percentage_known?: boolean;
  own_reset_time?: string | null;
  own_observed_at?: number | null;
  own_stale?: boolean;
  family_5h?: WindowStatus | null;
  family_weekly?: WindowStatus | null;
  effective_percentage?: number | null;
  effective_known?: boolean;
}

export interface QuotaRefreshState {
  projectContextRecovered?: boolean;
  complete: boolean;
  endpointsAttempted: string[];
  endpointsSucceeded: string[];
  missingFamilies: Family[];
  missingWindows: { family: Family; window: WindowKind }[];
  carriedGroups: number;
  carriedModels?: number;
  refreshedAt: number;
  /** 本轮是否使用了非生产端点（daily/sandbox）作为数据来源 */
  usedFallbackEndpoint?: boolean;
  error?: string;
  providerOrigin?: string;
  providerUserAgent?: string;
  requestScope?: 'account';
  projectId?: string;
}

export interface QuotaData {
  models: ModelQuota[];
  last_updated: number;
  is_forbidden: boolean;
  forbidden_reason?: string | null;
  subscription_tier?: string | null;
  model_forwarding_rules: Record<string, string>;
  quota_groups?: QuotaGroup[];
  source?: 'live' | 'cloud';
  /**
   * 本轮刷新未返回、沿用上次记录的分组：名称 + 该分组最后一次真实采样时间。
   * 存在该字段时顶层 last_updated 不再被刷新时刻覆盖，而是取最旧分组的观察时间。
   */
  stale_groups?: { name: string; observed_at: number }[];
  /** 本轮刷新完整性 / 端点来源 / 缺失 family 与窗口。 */
  refresh_state?: QuotaRefreshState;
  /** 机器可读告警码（前缀 CODE:）。 */
  quota_warnings?: string[];
}

export interface LiveLanguageServerStatus {
  email: string;
  name?: string | null;
  tier: string;
  accountType?: 'consumer' | 'enterprise_vertex' | 'unknown';
  userTierId?: string | null;
  userTierName?: string | null;
  quota: QuotaData;
}

export interface AccountSummary {
  id: string;
  email: string;
  name?: string | null;
  disabled: boolean;
  disabled_reason?: string | null;
  disabled_at?: number | null;
  protected_models: string[];
  created_at: number;
  last_used: number;
  custom_label?: string | null;
  quota?: QuotaData | null;
  quota_refresh_error?: string | null;
  quota_refresh_error_code?: AccountErrorCode | null;
  revision?: string;
  quota_last_updated?: number;
  credentialReadiness?: ReturnType<typeof accountCredentialReadiness>;
}

/** 账号渲染指纹覆盖规范化配额快照（availability/disabled/own/family窗口/refresh_state/warnings）。 */
export function quotaSnapshotForRevision(quota: QuotaData | null | undefined): unknown {
  if (!quota) return null;
  const windowPart = (status: WindowStatus | null | undefined) => status
    ? [status.known ? '1' : '0', status.stale ? '1' : '0', status.remaining ?? '', status.resetTime ?? '', status.observedAt ?? '']
    : null;
  const sourceDefault: QuotaSource = quota.source === 'live' ? 'live' : 'cloud';
  let normalizedGroups: NormalizedGroup[] = [];
  try {
    normalizedGroups = normalizeStoredGroups(quota.quota_groups ?? [], quota.last_updated ?? 0, sourceDefault);
  } catch { /* ignore malformed groups during revision hash */ }
  const models = (quota.models ?? []).map(model => {
    let family: Family = model.family ?? 'other';
    let disabled = model.disabled === undefined ? null : model.disabled;
    let isArgon = model.is_argon === true;
    let ownKnown = model.own_percentage_known === true;
    let own = model.own_percentage ?? null;
    try {
      const normalized = normalizedModelFromStored(model, sourceDefault, normalizedGroups);
      family = normalized.family;
      disabled = normalized.disabled;
      isArgon = normalized.is_argon;
      ownKnown = normalized.own_percentage_known;
      own = normalized.own_percentage;
    } catch { /* 坏模型保持旧字段参与指纹 */ }
    return [
      model.model_id ?? model.name,
      model.display_name ?? model.name,
      family,
      isArgon ? '1' : '0',
      disabled === null ? 'n' : disabled ? 'd' : 'e',
      ownKnown ? '1' : '0', own,
      model.percentage_known ? '1' : '0', model.percentage,
      model.effective_known === true ? '1' : '0', model.effective_percentage ?? '',
      model.own_reset_time ?? '', model.reset_time ?? '', model.reset_countdown ?? '',
      model.own_observed_at ?? '', model.own_stale === true ? '1' : '0',
      windowPart(model.family_5h), windowPart(model.family_weekly),
      model.quota_bucket_name ?? '',
      model.is_internal === true ? '1' : '0',
      model.deprecated === true ? '1' : '0',
      model.non_chat_specialized === true ? '1' : '0',
      model.quota_source ?? '', model.stale === true ? '1' : '0',
    ];
  });
  const groups = (quota.quota_groups ?? []).map(group => [
    group.group_id ?? '',
    group.display_name,
    group.description ?? '',
    group.family ?? '',
    group.observed_at ?? '', group.source ?? '',
    group.stale === true ? '1' : '0',
    ...(group.buckets ?? []).flatMap(bucket => [
      bucket.bucket_id,
      bucket.window,
      bucket.disabled === true ? '1' : '0',
      bucket.remaining_fraction_known === false ? '0' : '1',
      bucket.remaining_fraction,
      bucket.reset_time ?? '',
      bucket.observed_at ?? '', bucket.source ?? '',
      bucket.stale === true ? '1' : '0',
    ]),
  ]);
  const refresh = quota.refresh_state ? [
    quota.refresh_state.complete ? '1' : '0',
    (quota.refresh_state.missingFamilies ?? []).join(','),
    (quota.refresh_state.missingWindows ?? []).map(item => `${item.family}:${item.window}`).join(','),
    quota.refresh_state.carriedGroups,
    quota.refresh_state.carriedModels ?? 0,
    quota.refresh_state.usedFallbackEndpoint ? '1' : '0',
  ] : null;
  return {
    quota_contract_v: 2,
    last_updated: quota.last_updated,
    tier: quota.subscription_tier ?? '',
    source: quota.source ?? '',
    models,
    groups,
    stale_groups: (quota.stale_groups ?? []).map(item => [item.name, item.observed_at]),
    refresh_state: refresh,
    quota_warnings: quota.quota_warnings ?? [],
  };
}

export function computeAccountRevision(account: Account | AccountSummary): string {
  const parts: string[] = [
    account.id,
    account.email,
    account.name ?? '',
    account.custom_label ?? '',
    account.disabled ? '1' : '0',
    account.quota_refresh_error ?? '',
  ];
  const snapshot = quotaSnapshotForRevision(account.quota);
  parts.push(snapshot ? JSON.stringify(snapshot) : '0');
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}

export interface Account {
  id: string;
  email: string;
  name?: string | null;
  token: TokenData;
  device_profile?: DeviceProfile | null;
  quota?: QuotaData | null;
  quota_refresh_error?: string | null;
  quota_refresh_error_code?: AccountErrorCode | null;
  insiders_quota?: QuotaData | null;
  insiders_quota_refresh_error?: string | null;
  disabled: boolean;
  disabled_reason?: string | null;
  disabled_at?: number | null;
  protected_models: string[];
  validation_blocked: boolean;
  validation_blocked_until?: number | null;
  validation_blocked_reason?: string | null;
  validation_url?: string | null;
  created_at: number;
  last_used: number;
  custom_label?: string | null;
}

export type AccountErrorCode =
  | 'oauth_incomplete'
  | 'oauth_no_credentials'
  | 'oauth_verify_failed'
  | 'oauth_unverified_email'
  | 'oauth_network'
  | 'oauth_rate_limited'
  | 'oauth_server_error'
  | 'oauth_client_error'
  | 'missing_refresh_token'
  | 'missing_oauth_client'
  | 'refresh_failed'
  | 'no_access_token'
  | 'token_invalid'
  | 'token_no_access'
  | 'token_network'
  | 'invalid_id'
  | 'corrupt_file'
  | 'conflict_modified'
  | 'credentials_updated'
  | 'deleted_stop_refresh'
  | 'removed_stop_refresh'
  | 'not_found'
  | 'invalid_refresh_token'
  | 'missing_email'
  | 'name_too_long'
  | 'identity_verify_failed'
  | 'email_unverified'
  | 'http_3501'
  | 'network';

const ACCOUNT_ERROR_CODES = new Set<string>([
  'oauth_incomplete', 'oauth_no_credentials', 'oauth_verify_failed', 'oauth_unverified_email',
  'oauth_network', 'oauth_rate_limited', 'oauth_server_error', 'oauth_client_error',
  'missing_refresh_token', 'missing_oauth_client', 'refresh_failed',
  'no_access_token', 'token_invalid', 'token_no_access', 'token_network', 'invalid_id',
  'corrupt_file', 'conflict_modified', 'credentials_updated', 'deleted_stop_refresh',
  'removed_stop_refresh', 'not_found', 'invalid_refresh_token', 'missing_email',
  'name_too_long', 'identity_verify_failed', 'email_unverified', 'http_3501', 'network',
]);

export class CodedAccountError extends Error {
  readonly code: AccountErrorCode;
  constructor(code: AccountErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CodedAccountError';
    this.code = code;
  }
}

export function accountErrorCode(error: unknown): AccountErrorCode | null {
  if (error instanceof CodedAccountError) return error.code;
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && ACCOUNT_ERROR_CODES.has(code)) return code as AccountErrorCode;
  }
  return null;
}

const AUTH_REQUIRED_CODES = new Set<AccountErrorCode>(['refresh_failed', 'missing_refresh_token', 'token_invalid']);
const NON_AUTH_ERROR_CODES = new Set<AccountErrorCode>([
  'network', 'oauth_network', 'token_network', 'http_3501', 'missing_oauth_client',
  'oauth_rate_limited', 'oauth_server_error', 'oauth_client_error',
]);

const MISSING_OAUTH_CLIENT_STANDBY_BODY =
  'Google OAuth credentials are not configured, so standby accounts cannot refresh tokens in the background \\(optional credentials can be set in \\.env\\)'
  + '|未配置 Google OAuth 凭据，备用账号无法后台刷新 Token（可在 \\.env 中配置可选凭据）'
  + '|Credentials expired without background auto-refresh; switch to this account or re-save the current account to refresh quota'
  + '|登录凭据已过期（未配置后台自动续期），请切换至此账号或重新「保存当前账号」刷新配额'
  + '|Quota updates automatically after you switch to this account\\. Until then, refer to the last record and timer\\.'
  + '|切换并使用该账号后会自动更新最新额度；未切换前可参考上次记录和倒计时。';
const MISSING_OAUTH_CLIENT_ACTIVE_LIVE_BODY =
  'Current desktop account credentials expired without background auto-refresh; launch Antigravity and open a workspace so the language service is ready, then retry quota refresh'
  + '|当前桌面账号的登录凭据已过期（未配置后台自动续期），请启动 Antigravity 并打开工作区使语言服务就绪后再刷新配额'
  + '|Open Antigravity and enter any project to refresh the current account\'s quota\\.'
  + '|请先打开 Antigravity 并进入任意项目，即可刷新当前账号额度。';
const MISSING_OAUTH_CLIENT_STANDBY_PATTERN = new RegExp(`^(?:${MISSING_OAUTH_CLIENT_STANDBY_BODY})$`);
const MISSING_OAUTH_CLIENT_ACTIVE_LIVE_PATTERN = new RegExp(`^(?:${MISSING_OAUTH_CLIENT_ACTIVE_LIVE_BODY})$`);
export const MISSING_OAUTH_CLIENT_PATTERN = new RegExp(
  `^(?:${MISSING_OAUTH_CLIENT_STANDBY_BODY}|${MISSING_OAUTH_CLIENT_ACTIVE_LIVE_BODY})$`
);

export function accountCredentialReadiness(account: Account, now = Date.now() / 1000): { state: 'ready' | 'needs_refresh' | 'needs_authorization'; message: string } {
  const rawError = account.quota_refresh_error ?? '';
  const errorCode = account.quota_refresh_error_code ?? null;
  // Keep official HTTP 403 / #3501 license checks in 'ready' unless explicit auth failure also occurred.
  const isHttp403Only = /HTTP\s*403|\b3501\b/i.test(rawError) && !/invalid_grant|HTTP\s*401/i.test(rawError);
  // Missing local OAuth client config only blocks background auto-refresh; switching or re-saving still works.
  const isMissingOAuthClient = errorCode === 'missing_oauth_client' || MISSING_OAUTH_CLIENT_PATTERN.test(rawError.trim());
  const isKnownNonAuthCode = Boolean(errorCode && NON_AUTH_ERROR_CODES.has(errorCode));
  if ((errorCode && AUTH_REQUIRED_CODES.has(errorCode))
    || (!isKnownNonAuthCode && !isHttp403Only && !isMissingOAuthClient && /invalid_grant|授权.*(?:失效|过期)|重新(?:登录|授权|获取)|请重新添加|登录凭据(?:无法刷新|无效|已失效)|缺少登录凭据|re-?authoriz|sign in again|(?:refresh[_\s-]*token|access[_\s-]*token|token|credentials?|auth(?:orization)?|session|grant)[^.;]{0,24}expired|expired\s+(?:token|credentials?|session|grant)|HTTP\s*401|Unable to refresh login credentials|missing login credentials|please add this account again/i.test(rawError))) {
    return { state: 'needs_authorization', message: bt('account_quota.readiness.needs_auth') };
  }
  if (!account.token?.access_token || account.token.access_token === 'pending_refresh' || !Number.isFinite(account.token.expiry_timestamp) || account.token.expiry_timestamp <= now + 30) {
    return { state: 'needs_refresh', message: bt('account_quota.readiness.needs_refresh') };
  }
  return { state: 'ready', message: bt('account_quota.readiness.ready') };
}

const KNOWN_FAMILIES = new Set<Family>(['gemini', 'claude', 'argon', 'carbon', 'other']);

const STORED_QUOTA_ERROR_PATTERNS: Array<[RegExp, string]> = [
  [/^(?:Overall budget timed out; partial results saved|整体预算超时，已保存部分结果)$/, 'account_cloud.refresh_state.budget_timeout'],
  [/^(?:Overall quota refresh budget timed out|配额刷新整体预算超时)$/, 'account_cloud.err.budget_timeout'],
  [/^(?:Unable to retrieve quota for this account; previous record retained|未能取得此账号的配额，已保留上次记录)$/, 'account_cloud.err.no_quota_kept'],
  [/^HTTP 403\s*(?:\(Official product license verification failed, error 3501; check this account in the official app\)|（官方产品许可校验未通过，错误码 3501；请在官方应用核对该账号状态）)$/, 'account_cloud.err.http_3501'],
  [/^(?:Project context returned no verifiable quota|项目上下文未返回可验证配额)$/, 'account_cloud.err.project_no_verifiable_quota'],
  [/^(?:This account is missing login credentials; please add it again|此账号缺少登录凭据，请重新添加)$/, 'account_cloud.err.missing_refresh_token'],
  [MISSING_OAUTH_CLIENT_ACTIVE_LIVE_PATTERN, 'account_cloud.err.missing_oauth_client_active_live'],
  [MISSING_OAUTH_CLIENT_STANDBY_PATTERN, 'account_cloud.err.missing_oauth_client'],
  [/^(?:Unable to refresh login credentials; please add this account again|登录凭据无法刷新，请重新添加此账号)$/, 'account_cloud.err.refresh_failed'],
  [/^(?:Token refresh rate limited; temporarily retaining last quota|Token 刷新触发限流，已暂留上次配额)$/, 'account_cloud.err.oauth_rate_limited'],
  [/^(?:Sign-in service temporarily unavailable; temporarily retaining last quota|登录服务暂不可用，已暂留上次配额)$/, 'account_cloud.err.oauth_server_error'],
  [/^(?:OAuth client configuration error; check client settings|OAuth 客户端配置有误，请核对客户端设置)$/, 'account_cloud.err.oauth_client_error'],
  [/^(?:Sign-in service did not return valid credentials|登录服务未返回有效凭据)$/, 'account_cloud.err.no_access_token'],
  [/^(?:Unable to reach the sign-in service; check your network and try again|无法连接登录服务，请检查网络后重试)$/, 'account_cloud.err.network'],
  [/^(?:Login credentials are invalid or expired; please obtain new ones|登录凭据无效或已失效，请重新获取)$/, 'accounts.err.token_invalid'],
  [/^(?:Unable to confirm Antigravity's live quota service; launch the official app first \(did not fall back to another environment's default quota\)|无法确认 Antigravity 实际配额服务，请先运行官方应用；未采用其他环境的默认配额)$/, 'accounts.err.provider_unverified'],
  [/^(?:Refresh failed; please try again later|刷新失败，请稍后重试)$/, 'accounts.err.refresh_failed_retry'],
  [/^(?:Refresh failed|刷新失败)$/, 'accounts.err.refresh_failed'],
  [/^(?:Local RPC timed out|本地 RPC 超时)$/, 'account_probe.err.rpc_timeout'],
  [/^(?:Read failed|读取失败)$/, 'account_cloud.reason.read_failed'],
  [/^(?:No quota window returned|未返回额度窗口)$/, 'account_cloud.reason.no_window'],
  [/^(?:Cancelled|已取消)$/, 'account_cloud.err.aborted'],
  [/^(?:Google sign-in was not completed; please sign in again|Google 授权未完成，请重新登录)$/, 'oauth.err.incomplete'],
  [/^(?:Unable to obtain saveable login credentials; please re-authorize|未取得可保存的登录凭据，请重新授权)$/, 'oauth.err.no_credentials'],
];

export function localizeStoredQuotaError(error: string): string {
  const trimmed = error.trim();
  for (const [pattern, key] of STORED_QUOTA_ERROR_PATTERNS) {
    if (pattern.test(trimmed)) return bt(key);
  }
  const missingFamMatch = trimmed.match(/^(.+?)\s+(?:quota not returned; previous record retained|配额未返回，已保留上次记录)$/);
  if (missingFamMatch && missingFamMatch[1]) {
    const labels = missingFamMatch[1]
      .split(/(?:,\s*|、)/)
      .map(part => {
        const clean = part.trim();
        return /^(?:其他|Other)$/i.test(clean) ? bt('quota.family.other') : clean;
      })
      .filter(Boolean)
      .join(bt('common.list_separator'));
    return bt('account_cloud.refresh_err.missing_families', { labels });
  }
  const authEmptyMatch = trimmed.match(/^(?:Official quota service returned no verifiable quota:\s*(.+?)\. Did not fall back to a synthetic 100% default|当前官方配额服务未返回可验证额度：(.+?)。未采用其他环境的 100% 默认值)$/);
  if (authEmptyMatch) {
    const rawReason = (authEmptyMatch[1] ?? authEmptyMatch[2] ?? '').trim();
    const localizedReason = rawReason
      .split(/(?:;\s*|；)/)
      .map(part => localizeStoredQuotaError(part.trim()))
      .filter(Boolean)
      .join(bt('common.sentence_separator'));
    return bt('account_cloud.err.authority_empty', { reason: localizedReason });
  }
  return error;
}

export function cleanAndLocalizeRefreshError(error: string | null | undefined): string | null {
  if (!error) return null;
  const trimmed = String(error).trim();
  if (!trimmed || /双周期|dual window/i.test(trimmed)) return null;
  return localizeStoredQuotaError(trimmed);
}

export function resolveStoredQuotaWarning(warning: string): { code: string; text: string } | null {
  if (warning.startsWith('REFRESH_BUDGET_TIMEOUT:')) return { code: 'REFRESH_BUDGET_TIMEOUT', text: bt('account_cloud.warn.budget_timeout') };
  if (warning.startsWith('FALLBACK_ENDPOINT:')) return { code: 'FALLBACK_ENDPOINT', text: bt('account_cloud.warn.fallback_endpoint') };
  if (warning.startsWith('NO_QUOTA:')) return { code: 'NO_QUOTA', text: bt('account_quota.warn.no_quota') };
  if (warning.startsWith('GROUPS_PARSE_FAILED:')) return { code: 'GROUPS_PARSE_FAILED', text: bt('account_quota.warn.groups_parse_failed') };
  if (warning.startsWith('ARGON_DISABLED:')) return { code: 'ARGON_DISABLED', text: bt('account_quota.warn.argon_disabled') };
  if (warning.startsWith('ARGON_MODEL_QUOTA:')) return { code: 'ARGON_MODEL_QUOTA', text: bt('account_cloud.warn.argon_model_quota') };
  if (warning.startsWith('ARGON_QUOTA_NOT_REPORTED:')) return { code: 'ARGON_QUOTA_NOT_REPORTED', text: bt('account_quota.warn.argon_not_reported') };
  if (warning.startsWith('ARGON_STALE:')) return { code: 'ARGON_STALE', text: bt('account_quota.warn.argon_stale') };
  if (warning.startsWith('NO_MODEL_RECORDS:')) return { code: 'NO_MODEL_RECORDS', text: bt('account_probe.warn.no_model_records') };
  if (warning.startsWith('MALFORMED_GROUPS:')) {
    const mg = warning.match(/^MALFORMED_GROUPS:\s*(?:Skipped\s+)?(\d+)\b/i);
    return { code: 'MALFORMED_GROUPS', text: mg?.[1] ? bt('account_quota.warn.malformed_groups', { count: Number(mg[1]) }) : warning };
  }
  if (warning.startsWith('MALFORMED_MODEL:')) {
    const mm = warning.match(/^MALFORMED_MODEL:(\d+):/);
    if (mm?.[1]) return { code: `MALFORMED_MODEL:${mm[1]}`, text: bt('account_quota.warn.malformed_model', { index: Number(mm[1]) }) };
  }
  if (warning.startsWith('MISSING_FAMILY:')) {
    const mf = warning.match(/^MISSING_FAMILY:([a-z0-9_-]+):\s*(.*)$/i);
    if (mf?.[1]) {
      const family = mf[1];
      const rest = mf[2] ?? '';
      const label = KNOWN_FAMILIES.has(family as Family) ? familyLabel(family as Family) : family;
      const key = /本轮未返回|not returned in this cycle/i.test(rest) ? 'account_cloud.warn.missing_family' : 'account_quota.warn.missing_family';
      return { code: `MISSING_FAMILY:${family}`, text: bt(key, { family, label }) };
    }
  }
  if (warning.startsWith('MISSING_WINDOW:')) {
    const mw = warning.match(/^MISSING_WINDOW:([a-z0-9_-]+):([a-z0-9_-]+):\s*(.*)$/i);
    if (mw?.[1] && mw[2]) {
      const family = mw[1];
      const windowName = mw[2];
      const rest = mw[3] ?? '';
      const label = KNOWN_FAMILIES.has(family as Family) ? familyLabel(family as Family) : family;
      const key = /窗口未返回|window not returned/i.test(rest) ? 'account_cloud.warn.missing_window' : 'account_quota.warn.missing_window';
      return { code: `MISSING_WINDOW:${family}:${windowName}`, text: bt(key, { family, window: windowName, label }) };
    }
  }
  if (warning.startsWith('CARRIED_GROUPS:')) {
    const cg = warning.match(/^CARRIED_GROUPS:(\d+):\s*(.+?)\s*(?:carried over from last record|沿用上次记录)\s*$/);
    if (cg?.[1] && cg[2]) {
      const names = cg[2].split(/(?:,\s*|、)/).map(s => s.trim()).filter(Boolean).join(bt('common.list_separator'));
      return { code: 'CARRIED_GROUPS', text: bt('account_quota.warn.carried_groups', { count: Number(cg[1]), names }) };
    }
    return { code: 'CARRIED_GROUPS', text: warning };
  }
  if (warning.startsWith('CARRIED:')) {
    const cr = warning.match(/^CARRIED:(.+?):\s*(?:Carried over from last record\s*\(([^)]+)\)|沿用上次记录（([^）]+)）)\s*$/);
    if (cr?.[1]) {
      const name = cr[1].trim();
      const iso = (cr[2] ?? cr[3] ?? '').trim();
      return { code: `CARRIED:${name}`, text: bt('account_cloud.warn.carried', { name, iso }) };
    }
  }
  if (warning.startsWith('UNVERIFIED_CLOUD_SCOPE:')) {
    const detail = warning.slice('UNVERIFIED_CLOUD_SCOPE:'.length).trim();
    const localizedDetail = detail ? localizeStoredQuotaError(detail) : '';
    return {
      code: 'UNVERIFIED_CLOUD_SCOPE',
      text: localizedDetail ? `UNVERIFIED_CLOUD_SCOPE: ${localizedDetail}` : 'UNVERIFIED_CLOUD_SCOPE',
    };
  }
  return null;
}

export interface AccountIndex {
  version: string;
  accounts: AccountSummary[];
  current_account_id: string | null;
  current_target_ide?: string | null;
  current_ide_account_id?: string | null;
  current_vscode_account_id?: string | null;
}

export type AutoSwitchStrategy = 'priority' | 'round_robin';

export interface AutoSwitchConfig {
  enabled: boolean;
  strategy: AutoSwitchStrategy;
  reserve_percentage: number;       // 触发切号的低额度红线，默认 10%
  reservePercentage?: number;
  candidate_min_percentage: number; // 准入最低额度，默认 30%
  candidateMinPercentage?: number;
  monitored_model: string;          // 默认 "all" 或具体模型
  candidate_account_ids: string[];  // 允许作为轮换目标的账号池
  last_switched_id?: string;        // 游标状态持久化：最近一次轮换选择的账号 ID
}

export function generateDeviceProfile(): DeviceProfile {
  const hex = (len: number) => randomBytes(Math.ceil(len / 2)).toString('hex').slice(0, len);
  return {
    machine_id: hex(64),
    mac_machine_id: hex(64),
    dev_device_id: randomUUID(),
    sqm_id: `{${randomUUID().toUpperCase()}}`,
  };
}

export function sanitizeJsonString(raw: Buffer | string): string {
  let str = typeof raw === 'string' ? raw : raw.toString('utf8');
  // Strip UTF-8 BOM
  if (str.charCodeAt(0) === 0xfeff) {
    str = str.slice(1);
  }
  // Strip leading NUL bytes and control characters
  return str.replace(/^[\u0000\s]+/, '');
}

/** 规范化与持久化配额结构转换（集中在 accounts 边界的适配层）。 */
export function modelQuotaFromNormalized(model: NormalizedModel): ModelQuota {
  return {
    ...model,
    reset_countdown: model.reset_time ? formatResetCountdown(model.reset_time) : '',
  } as ModelQuota;
}

export function groupToQuotaGroup(group: NormalizedGroup): QuotaGroup {
  return {
    ...(group.group_id ? { group_id: group.group_id } : {}),
    display_name: group.display_name,
    description: group.description,
    observed_at: group.observed_at ?? undefined,
    observedAt: group.observed_at ?? undefined,
    last_updated: group.observed_at ?? undefined,
    family: group.family,
    stale: group.stale,
    source: group.source,
    buckets: group.buckets.map(bucket => ({
      bucket_id: bucket.bucket_id,
      window: bucket.window,
      remaining_fraction: bucket.remaining_fraction ?? 0,
      remaining_fraction_known: bucket.remaining_fraction_known,
      percentage: bucket.percentage,
      reset_time: bucket.reset_time ?? '',
      display_name: bucket.display_name,
      description: bucket.description,
      ...(bucket.disabled === true ? { disabled: true } : {}),
      observed_at: bucket.observed_at ?? undefined,
      observedAt: bucket.observed_at ?? undefined,
      last_updated: bucket.observed_at ?? undefined,
      family: group.family,
      stale: bucket.stale,
      source: bucket.source,
    })),
  };
}

/** 已持久化 ModelQuota（旧数据可能没有 own_* 字段）→ NormalizedModel 容错读取。 */
export function normalizedModelFromStored(
  model: ModelQuota,
  fallbackSource: QuotaSource = 'cloud',
  groups: NormalizedGroup[] = [],
): NormalizedModel {
  const known = model.own_percentage_known ?? model.percentage_known === true;
  const ownPercentage = model.own_percentage_known !== undefined
    ? (model.own_percentage ?? null)
    : (model.percentage_known ? Math.round(model.percentage) : null);
  const displayName = model.display_name ?? null;
  const reclassified = classifyFamily({
    modelId: model.model_id ?? model.name,
    displayName,
    modelProvider: model.model_provider,
    modelOrAlias: model.model_or_alias,
  });
  let family: Family = !model.family || model.family === 'other' ? reclassified : model.family;
  if (family === 'other' && groups.length > 0) {
    const matchedGroup = findGroupForModelByDescription(
      { model_id: model.model_id ?? model.name, name: model.name, display_name: displayName },
      groups,
    );
    if (matchedGroup && (matchedGroup.family === 'gemini' || matchedGroup.family === 'claude')) {
      family = matchedGroup.family;
    }
  }
  const ownKnown = (model.own_percentage_known ?? known) && ownPercentage !== null
    && Number.isFinite(ownPercentage) && ownPercentage >= 0 && ownPercentage <= 100;
  const percentage = model.effective_known !== undefined
    ? (model.effective_percentage ?? null)
    : (model.percentage_known ? model.percentage : null);
  return {
    name: model.name,
    model_id: model.model_id ?? model.name,
    display_name: displayName,
    family,
    is_carbon: model.is_carbon ?? family === 'carbon', is_argon: model.is_argon ?? family === 'argon',
    disabled: typeof model.disabled === 'boolean' ? model.disabled
      : /(?:^|[-_])disabled(?:$|[-_])/i.test(model.model_id ?? model.name) ? true : null,
    model_or_alias: model.model_or_alias ?? null,
    ...(model.is_internal === true ? { is_internal: true } : {}),
    ...(model.model_provider ? { model_provider: model.model_provider } : {}),
    ...(model.deprecated === true ? { deprecated: true } : {}),
    ...(model.non_chat_specialized === true ? { non_chat_specialized: true } : {}),
    ...(model.in_model_selector !== undefined ? { in_model_selector: model.in_model_selector } : {}),
    ...(model.quota_bucket_name ? { quota_bucket_name: model.quota_bucket_name } : {}),
    own_percentage: ownKnown ? ownPercentage : null,
    own_percentage_known: ownKnown,
    own_reset_time: normalizeResetTime(model.own_reset_time ?? model.reset_time),
    own_observed_at: model.own_observed_at ?? null,
    own_stale: model.own_stale ?? model.stale === true,
    family_5h: (model.family_5h ?? null) as WindowStatus | null,
    family_weekly: (model.family_weekly ?? null) as WindowStatus | null,
    percentage: percentage ?? 0,
    percentage_known: percentage !== null,
    effective_percentage: percentage,
    effective_known: percentage !== null,
    reset_time: model.reset_time ?? '',
    quota_bucket_id: model.quota_bucket_id,
    quota_source: model.quota_source ?? fallbackSource,
    stale: model.stale === true,
    supports_images: model.supports_images,
    supports_thinking: model.supports_thinking,
    thinking_budget: model.thinking_budget,
    recommended: model.recommended,
    max_tokens: model.max_tokens,
    max_output_tokens: model.max_output_tokens,
    supported_mime_types: model.supported_mime_types,
  };
}

export interface QuotaOverviewWindowStatus extends WindowStatus {
  resetCountdown: string;
}

export interface ProjectedGroupWindow {
  id: string;
  period: string;
  label: string;
  known: boolean;
  remaining: number | null;
  stale: boolean;
  resetCountdown: string;
  resetTime?: string | null;
  observedAt: number | null;
  source: string | null;
}

export interface ProjectedQuotaGroup {
  key: string;
  displayName: string;
  description?: string;
  summaryLabel: string;
  brands: string[];
  isStandalone: boolean;
  availability: Availability;
  quotaState: QuotaState;
  windows: ProjectedGroupWindow[];
  message: string;
}

export interface QuotaOverview {
  // legacy 兼容字段
  fiveHourRemaining: number | null;
  weeklyRemaining: number | null;
  geminiFiveHourRemaining: number | null;
  geminiWeeklyRemaining: number | null;
  geminiFiveHourResetCountdown: string;
  geminiWeeklyResetCountdown: string;
  geminiResetCountdown: string;
  claudeFiveHourRemaining: number | null;
  claudeWeeklyRemaining: number | null;
  claudeFiveHourResetCountdown: string;
  claudeWeeklyResetCountdown: string;
  claudeResetCountdown: string;
  argonWeeklyRemaining: number | null;
  argonWeeklyResetCountdown: string;
  argonResetCountdown: string;
  carbonWeeklyRemaining: number | null;
  carbonWeeklyResetCountdown: string;
  carbonResetCountdown: string;
  /** 5h 优先（任一家族最早）；无 5h 才 weekly；绝不跨周期混取最小。 */
  resetTime: number | null;
  resetCountdown: string;
  subscriptionTier: string;
  quotaGroups: QuotaGroup[];
  staleGroups: { name: string; observed_at: number }[];
  unknownBuckets: { group: string; bucket: string }[];
  models: ModelQuota[];
  lastUpdated: number | null;
  isStale: boolean;
  staleHours: number;
  // 规范化配额详情字段
  argonStatus: ArgonStatus;
  carbonStatus: ArgonStatus;
  standaloneModels: StandaloneModelStatus[];
  projectedQuotaGroups?: ProjectedQuotaGroup[];
  familyWindows: {
    gemini: { fiveHour: QuotaOverviewWindowStatus | null; daily?: QuotaOverviewWindowStatus | null; weekly: QuotaOverviewWindowStatus | null };
    claude: { fiveHour: QuotaOverviewWindowStatus | null; daily?: QuotaOverviewWindowStatus | null; weekly: QuotaOverviewWindowStatus | null };
    argon: { fiveHour: QuotaOverviewWindowStatus | null; daily?: QuotaOverviewWindowStatus | null; weekly: QuotaOverviewWindowStatus | null };
    carbon: { fiveHour: QuotaOverviewWindowStatus | null; daily?: QuotaOverviewWindowStatus | null; weekly: QuotaOverviewWindowStatus | null };
  };
  familyModelQuota: Record<'gemini' | 'claude', QuotaOverviewWindowStatus | null>;
  nextResets: {
    fiveHour: { family: Family; resetTime: string; resetCountdown: string } | null;
    weekly: { family: Family; resetTime: string; resetCountdown: string } | null;
  };
  refreshState: QuotaRefreshState;
  quotaWarnings: string[];
  quotaWarningCodes: string[];
}

export function fuseQuotaData(fetchAvailableModelsData: any, quotaSummaryData?: any): QuotaData {
  const observedAt = Math.floor(Date.now() / 1000);
  const groups = mergeGroupSets([normalizeCloudGroups(quotaSummaryData ?? {}, observedAt)]);
  const models = resolveModelsWithGroupDescriptions(
    mergeModelCatalogues([normalizeCloudModels(fetchAvailableModelsData ?? {}, observedAt)]),
    groups,
  );
  const windows = familyWindowsFromGroups(groups, Date.now());
  const applied = applyFamilyWindows(models, windows);
  const forwarding: Record<string, string> = {};
  const deprecated = fetchAvailableModelsData?.deprecatedModelIds;
  if (deprecated && typeof deprecated === 'object') {
    for (const [oldId, info] of Object.entries<any>(deprecated)) {
      if (info?.newModelId) forwarding[oldId] = String(info.newModelId);
    }
  }
  return {
    models: applied.map(modelQuotaFromNormalized),
    last_updated: observedAt,
    is_forbidden: false,
    model_forwarding_rules: forwarding,
    quota_groups: groups.map(groupToQuotaGroup),
    source: 'cloud',
    refresh_state: {
      complete: models.length > 0,
      endpointsAttempted: ['fuseQuota'],
      endpointsSucceeded: ['fuseQuota'],
      missingFamilies: [],
      missingWindows: [],
      carriedGroups: 0,
      refreshedAt: observedAt,
    },
  };
}

function findMatchingModels<T extends { name: string; model_id?: string; display_name?: string | null }>(models: T[], target: string): T[] {
  const trimmed = target.trim().toLowerCase();
  if (!trimmed) return [];
  const exact = models.filter(item =>
    (item.model_id ?? item.name).toLowerCase() === trimmed
    || (item.display_name ?? '').toLowerCase() === trimmed);
  if (exact.length > 0) return exact;
  const targetBase = normalizeBaseModelKey(trimmed);
  if (targetBase) {
    const byBase = models.filter(item => normalizeBaseModelKey(item.model_id ?? item.name) === targetBase);
    if (byBase.length > 0) return byBase;
  }
  const targetCodename = extractStandaloneGeminiCodename(trimmed)
    ?? (/^[a-z][a-z0-9]{2,24}$/.test(trimmed) && !['all', 'gemini', 'claude', 'gpt', 'openai', '3p', 'gemini_all'].includes(trimmed) ? trimmed : null);
  if (!targetCodename) return [];
  return models.filter(item => {
    const itemText = `${item.model_id ?? item.name} ${item.display_name ?? ''}`;
    return extractStandaloneGeminiCodename(itemText) === targetCodename;
  });
}

function normalizedGroupsFromQuota(quota: QuotaData | null | undefined, nowSec: number): NormalizedGroup[] {
  if (!quota || !Array.isArray(quota.quota_groups)) return [];
  const sourceDefault: QuotaSource = quota.source === 'live' ? 'live' : 'cloud';
  try {
    return normalizeStoredGroups(quota.quota_groups, quota.last_updated ?? nowSec, sourceDefault);
  } catch {
    return [];
  }
}

/**
 * 根据当前正在使用的账号套餐与可用配额结构，将用户配置的监测范围安全解析为当前账号的等效有效监测范围。
 * 不改动持久化配置本身，仅避免切到 Ultra / Free 套餐后因独立模型已并入共享池或无权限而导致推荐静默失效。
 */
export function resolveEffectiveMonitoredModel(account: Account | { quota?: QuotaData | null }, monitoredModel = 'all'): string {
  const trimmed = monitoredModel.trim().toLowerCase();
  if (!trimmed || trimmed === 'all') return 'all';
  if (trimmed === 'gemini' || trimmed === 'claude' || trimmed === '3p' || trimmed === 'claude/gpt') {
    return monitoredModel;
  }
  if (!account.quota) return monitoredModel;

  const overview = buildAccountQuotaOverview(account);
  const hasGeminiCore = overview.models.some(m => m.family === 'gemini' && m.disabled !== true && !m.stale)
    || overview.familyWindows.gemini.fiveHour !== null
    || Boolean(overview.familyWindows.gemini.daily)
    || overview.familyWindows.gemini.weekly !== null;
  const hasClaudeCore = overview.models.some(m => m.family === 'claude' && m.disabled !== true && !m.stale)
    || overview.familyWindows.claude.fiveHour !== null
    || Boolean(overview.familyWindows.claude.daily)
    || overview.familyWindows.claude.weekly !== null;
  if (!hasGeminiCore && !hasClaudeCore) return monitoredModel;

  if (
    trimmed === 'gemini_all'
    || trimmed === 'gemini 全系模型'
    || trimmed === 'all gemini models'
    || trimmed === 'gemini 全系（含 argon）'
    || trimmed === 'all gemini (incl. argon)'
  ) {
    if (!hasGeminiCore) return monitoredModel;
    const hasStandaloneGemini =
      (overview.argonStatus.mode === 'standalone' && overview.argonStatus.availability === 'available')
      || (overview.carbonStatus.mode === 'standalone' && overview.carbonStatus.availability === 'available')
      || (overview.standaloneModels ?? []).some(m =>
        m.availability === 'available'
        && (resolveStandaloneBrands(m.key, m.displayName).includes('gemini')
          || m.key.toLowerCase().includes('gemini')
          || m.displayName.toLowerCase().includes('gemini')));
    return hasStandaloneGemini ? 'gemini_all' : 'gemini';
  }

  if (trimmed === 'argon' || trimmed === 'gemini 4 argon' || trimmed === 'gemini-4-argon') {
    if (!hasGeminiCore) return monitoredModel;
    if (overview.argonStatus.mode === 'unified') {
      return overview.argonStatus.pooledInFamily ?? 'gemini';
    }
    if (overview.argonStatus.availability === 'disabled') {
      return 'gemini';
    }
    return monitoredModel;
  }

  if (trimmed === 'carbon' || trimmed === 'gemini 4 carbon' || trimmed === 'gemini-4-carbon') {
    if (!hasGeminiCore) return monitoredModel;
    if (overview.carbonStatus.mode === 'unified') {
      return overview.carbonStatus.pooledInFamily ?? 'gemini';
    }
    if (overview.carbonStatus.availability === 'disabled') {
      return 'gemini';
    }
    return monitoredModel;
  }

  // 动态新独立模型跨套餐兼容：可用独立项保留，已并入共享池则映射至对应共享池，缺失/禁用则按品牌兜底。
  const standalone = (overview.standaloneModels ?? []).find(item =>
    item.key.toLowerCase() === trimmed || item.displayName.toLowerCase() === trimmed);
  if (standalone) {
    if (standalone.availability === 'available') return monitoredModel;
  } else {
    const matchedModels = findMatchingModels(overview.models, trimmed);
    const activeMatches = matchedModels.filter(m => m.disabled !== true && !m.stale);
    if (activeMatches.length > 0) {
      const nowSec = Math.floor(Date.now() / 1000);
      const sourceDefault: QuotaSource = account.quota?.source === 'live' ? 'live' : 'cloud';
      const groups = normalizedGroupsFromQuota(account.quota, nowSec);
      const normalizedAll = overview.models.map(item => normalizedModelFromStored(item, sourceDefault));
      const poolMatches = activeMatches.map(m =>
        matchModelToSharedPool(normalizedModelFromStored(m, sourceDefault), overview.familyWindows, groups, account.quota?.subscription_tier, normalizedAll));
      if (poolMatches.every((p): p is NonNullable<typeof p> => p !== null)) {
        return poolMatches[0]!.family;
      }
      return monitoredModel;
    }
  }

  const brands = resolveStandaloneBrands(trimmed, trimmed);
  const classified = classifyFamily({ modelId: trimmed, displayName: trimmed });
  if ((brands.includes('gemini') || classified === 'gemini') && hasGeminiCore) return 'gemini';
  if ((brands.includes('claude') || brands.includes('openai') || classified === 'claude') && hasClaudeCore) return 'claude';
  return hasGeminiCore || hasClaudeCore ? 'all' : monitoredModel;
}

export function computeAccountRemaining(
  account: Account,
  monitoredModel = 'all',
  options?: { staleAfterSeconds?: number; nowMs?: number },
): number | null {
  if (account.disabled || account.validation_blocked || account.quota?.is_forbidden) return null;
  const quota = account.quota;
  if (!quota || !Array.isArray(quota.models)) return null;

  const overview = buildAccountQuotaOverview(account, options);
  const nowSec = (options?.nowMs ?? Date.now()) / 1000;
  const FRESH_SECONDS = typeof options?.staleAfterSeconds === 'number' && options.staleAfterSeconds > 0 ? options.staleAfterSeconds : 900;

  const freshFraction = (status: WindowStatus | null | undefined): number | null => {
    if (!status?.known || status.stale || status.remaining === null) return null;
    if (typeof status.observedAt === 'number' && nowSec - status.observedAt > FRESH_SECONDS) return null;
    return status.remaining;
  };
  const familyValues = (family: 'gemini' | 'claude'): number[] => {
    const windows = overview.familyWindows[family];
    const own = overview.models.filter(model => model.family === family
      && model.disabled !== true
      && model.is_internal !== true
      && model.deprecated !== true
      && model.non_chat_specialized !== true
      && !isOrchestratorMetaModel(model.model_id ?? model.name, model.display_name)
      && !(model.quota_bucket_name && classifyFamily({ groupName: model.quota_bucket_name, bucketId: model.quota_bucket_name }) === 'other')
      && model.stale !== true && model.own_stale !== true && model.own_percentage_known === true
      && typeof model.own_percentage === 'number').map(model => model.own_percentage! / 100);
    return [freshFraction(windows.fiveHour), freshFraction(windows.daily), freshFraction(windows.weekly), ...own]
      .filter((value): value is number => value !== null);
  };
  const bounded = (fraction: number): number => Math.max(0, Math.min(100, Math.round(fraction * 100)));
  const modelsOfFamily = (family: 'gemini' | 'claude') => overview.models.filter(model => (model.family ?? classifyFamily({ modelId: model.name, displayName: model.display_name })) === family);
  const familyHasKnownModel = (family: 'gemini' | 'claude') => modelsOfFamily(family).some(model => model.effective_known === true && model.stale !== true);

  const trimmed = monitoredModel.trim().toLowerCase();
  const isArgonTarget = trimmed === 'argon' || trimmed === 'gemini 4 argon' || trimmed === 'gemini-4-argon';
  const isCarbonTarget = trimmed === 'carbon' || trimmed === 'gemini 4 carbon' || trimmed === 'gemini-4-carbon';
  const isClaudeTarget = trimmed === 'claude' || trimmed === '3p' || trimmed === 'claude/gpt' || trimmed === 'gpt';
  const isGeminiTarget = trimmed === 'gemini';
  const isGeminiAllTarget =
    trimmed === 'gemini_all'
    || trimmed === 'gemini 全系模型'
    || trimmed === 'all gemini models'
    || trimmed === 'gemini 全系（含 argon）'
    || trimmed === 'all gemini (incl. argon)';
  const isAllTarget = !trimmed || trimmed === 'all';

  const resolveStandaloneRemaining = (status: ArgonStatus): number | null => {
    if (status.mode === 'unified' && status.pooledInFamily) {
      const poolValues = familyValues(status.pooledInFamily);
      if (poolValues.length > 0) return bounded(Math.min(...poolValues));
    }
    if (status.availability !== 'available') return null;
    if (status.quotaState !== 'known' || status.remaining === null) return null;
    if (typeof status.observedAt === 'number' && nowSec - status.observedAt > FRESH_SECONDS) return null;
    return bounded(status.remaining);
  };

  // 具体模型或动态新增独立模型：优先匹配 standaloneModels，其次使用规范化后的 effective（= min(own, 相关 family 新鲜窗口)）
  if (!isArgonTarget && !isCarbonTarget && !isClaudeTarget && !isGeminiTarget && !isGeminiAllTarget && !isAllTarget) {
    const standalone = (overview.standaloneModels ?? []).find(item =>
      item.key.toLowerCase() === trimmed || item.displayName.toLowerCase() === trimmed);
    if (standalone) {
      if (standalone.availability !== 'available') return null;
      if (standalone.quotaState !== 'known' || standalone.remaining === null) return null;
      if (typeof standalone.observedAt === 'number' && nowSec - standalone.observedAt > FRESH_SECONDS) return null;
      return bounded(standalone.remaining);
    }
    const matchedModels = findMatchingModels(overview.models, trimmed);
    const model = matchedModels.find(m => m.disabled !== true && m.stale !== true) ?? matchedModels[0];
    if (model) {
      if (model.disabled === true || model.stale === true) return null;
      const modelFamily = model.family ?? classifyFamily({ modelId: model.name, displayName: model.display_name });
      let pooledFamily = (model.is_argon || modelFamily === 'argon') && overview.argonStatus.mode === 'unified'
        ? overview.argonStatus.pooledInFamily
        : (model.is_carbon || modelFamily === 'carbon') && overview.carbonStatus.mode === 'unified'
          ? overview.carbonStatus.pooledInFamily
          : null;
      if (!pooledFamily && modelFamily === 'other') {
        const sourceDefault: QuotaSource = account.quota?.source === 'live' ? 'live' : 'cloud';
        const groups = normalizedGroupsFromQuota(account.quota, Math.floor(nowSec));
        const normalizedAll = overview.models.map(item => normalizedModelFromStored(item, sourceDefault));
        pooledFamily = matchModelToSharedPool(
          normalizedModelFromStored(model, sourceDefault),
          overview.familyWindows,
          groups,
          account.quota?.subscription_tier,
          normalizedAll,
        )?.family ?? null;
      }
      if (pooledFamily) {
        const poolValues = familyValues(pooledFamily);
        if (model.effective_known === true && typeof model.effective_percentage === 'number') {
          const observed = [model.family_5h, model.family_weekly].filter(status => status?.known && !status.stale).map(status => status!.observedAt).find(value => typeof value === 'number') ?? (!model.own_stale ? model.own_observed_at : null);
          if (typeof observed !== 'number' || nowSec - observed <= FRESH_SECONDS) {
            poolValues.push(model.effective_percentage / 100);
          }
        }
        return poolValues.length > 0 ? bounded(Math.min(...poolValues)) : null;
      }
      if (model.effective_known !== true || typeof model.effective_percentage !== 'number') return null;
      const observed = [model.family_5h, model.family_weekly].filter(status => status?.known && !status.stale).map(status => status!.observedAt).find(value => typeof value === 'number') ?? (!model.own_stale ? model.own_observed_at : null);
      if (typeof observed === 'number' && nowSec - observed > FRESH_SECONDS) return null;
      return bounded((model.effective_percentage ?? 0) / 100);
    }
    if (trimmed === 'gemini-4-argon') return resolveStandaloneRemaining(overview.argonStatus);
    if (trimmed === 'gemini-4-carbon') return resolveStandaloneRemaining(overview.carbonStatus);
    return null;
  }

  if (isArgonTarget) {
    // 未知/禁用不是“0%”，但也不能作为可切换依据；unified 模式解析到其共享池。
    return resolveStandaloneRemaining(overview.argonStatus);
  }

  if (isCarbonTarget) {
    return resolveStandaloneRemaining(overview.carbonStatus);
  }

  if (isGeminiAllTarget) {
    const values: number[] = [];
    if (familyHasKnownModel('gemini')) {
      values.push(...familyValues('gemini'));
    }
    for (const status of [overview.argonStatus, overview.carbonStatus]) {
      if (
        status.availability === 'available' &&
        status.quotaState === 'known' &&
        status.remaining !== null &&
        (typeof status.observedAt !== 'number' || nowSec - status.observedAt <= FRESH_SECONDS)
      ) {
        values.push(status.remaining);
      }
    }
    for (const extra of overview.standaloneModels ?? []) {
      const keyLower = extra.key.toLowerCase();
      if (keyLower === 'argon' || keyLower === 'carbon') continue;
      const nameLower = extra.displayName.toLowerCase();
      if (
        !resolveStandaloneBrands(extra.key, extra.displayName).includes('gemini') &&
        !keyLower.includes('gemini') &&
        !nameLower.includes('gemini')
      ) continue;
      if (
        extra.availability === 'available' &&
        extra.quotaState === 'known' &&
        extra.remaining !== null &&
        (typeof extra.observedAt !== 'number' || nowSec - extra.observedAt <= FRESH_SECONDS)
      ) {
        values.push(extra.remaining);
      }
    }
    if (values.length === 0) return null;
    if (values.some(value => value <= 0)) return 0;
    return bounded(Math.min(...values));
  }
  if (isGeminiTarget) {
    if (!familyHasKnownModel('gemini')) return null;
    const values = familyValues('gemini');
    return values.length > 0 ? bounded(Math.min(...values)) : null;
  }
  if (isClaudeTarget) {
    if (!familyHasKnownModel('claude')) return null;
    const values = familyValues('claude');
    return values.length > 0 ? bounded(Math.min(...values)) : null;
  }

  // all：优先统计核心主力模型家族（Gemini + Claude/GPT），避免实验性 Argon / Carbon 单项偏低把主力充裕账号误判为耗尽；
  // 仅当账号没有任何已知 Gemini/Claude 模型记录时才回退参考 Argon / Carbon。
  const gemini = familyHasKnownModel('gemini') ? familyValues('gemini') : [];
  const claude = familyHasKnownModel('claude') ? familyValues('claude') : [];
  const argonStatus = overview.argonStatus;
  const argonFresh = argonStatus.availability === 'available'
    && argonStatus.quotaState === 'known'
    && argonStatus.remaining !== null
    && (typeof argonStatus.observedAt !== 'number' || nowSec - argonStatus.observedAt <= FRESH_SECONDS)
    ? [argonStatus.remaining]
    : [];
  const carbonStatus = overview.carbonStatus;
  const carbonFresh = carbonStatus.availability === 'available'
    && carbonStatus.quotaState === 'known'
    && carbonStatus.remaining !== null
    && (typeof carbonStatus.observedAt !== 'number' || nowSec - carbonStatus.observedAt <= FRESH_SECONDS)
    ? [carbonStatus.remaining]
    : [];
  const core = [...gemini, ...claude];
  const all = core.length > 0 ? core : [...argonFresh, ...carbonFresh];
  if (all.length === 0) return null;
  if (all.some(value => value <= 0)) return 0;
  return bounded(Math.min(...all));
}

export function subscriptionTierRank(account: Account | AccountSummary | null | undefined): number {
  if (!account) return 0;
  const raw = String(account.quota?.subscription_tier ?? '').toUpperCase();
  if (raw.includes('ULTRA') || raw.includes('ENTERPRISE')) return 5;
  if (raw.includes('TEAM') || raw.includes('BUSINESS') || raw.includes('WORKSPACE')) return 4;
  if (/\bPRO\b/.test(raw) || raw.includes('AI PREMIUM')) return 3;
  if (raw.includes('PLUS')) return 2.5;
  if (raw.includes('FREE') || raw.includes('STARTER') || raw.includes('TRIAL')) return 1;
  return 2;
}

function quotaPeriodLabel(period: string): string {
  const locale = getActiveLocale();
  const isEn = locale === 'en';
  if (period === '5h') return translate(locale, 'common.period.5h', undefined, { namespace: 'app', fallback: isEn ? '5 Hours' : '5 小时' });
  if (period === 'weekly') return translate(locale, 'common.period.weekly', undefined, { namespace: 'app', fallback: isEn ? 'Weekly' : '每周' });
  if (period === 'daily') return translate(locale, 'common.period.daily', undefined, { namespace: 'app', fallback: isEn ? 'Daily' : '每日' });
  return translate(locale, 'quota.model_quota', undefined, { namespace: 'app', fallback: isEn ? 'Model Quota' : '模型配额' });
}

function toProjectedWindow(
  id: string,
  period: string,
  status: WindowStatus | null | undefined,
  nowMs: number,
): ProjectedGroupWindow | null {
  if (!status) return null;
  return {
    id,
    period,
    label: quotaPeriodLabel(period),
    known: status.known === true,
    remaining: status.known ? status.remaining : null,
    stale: status.stale === true,
    resetCountdown: status.resetTime ? formatResetCountdown(status.resetTime, nowMs) : '',
    resetTime: status.resetTime ?? null,
    observedAt: status.observedAt ?? null,
    source: status.source ?? null,
  };
}

function resolveStandaloneBrands(key: string, displayName: string, description?: string): string[] {
  const text = `${key} ${displayName} ${description ?? ''}`.toLowerCase();
  const brands: string[] = [];
  if (/\bclaude\b|\banthropic\b/.test(text)) brands.push('claude');
  if (/\bgpt\b|\bopenai\b/.test(text)) brands.push('openai');
  if (/\bgemini\b|\bargon\b|\bcarbon\b|\bhydrogen\b/.test(text)) brands.push('gemini');
  return brands.length > 0 ? brands : [key];
}

function buildProjectedQuotaGroups(
  applied: NormalizedModel[],
  groups: NormalizedGroup[],
  familyWindows: FamilyWindows,
  modelQuota: Record<'gemini' | 'claude', WindowStatus | null>,
  standaloneModels: StandaloneModelStatus[],
  nowMs: number,
  staleAfterSeconds: number = 900,
): ProjectedQuotaGroup[] {
  const out: ProjectedQuotaGroup[] = [];
  const coreSpecs: Array<{ family: 'gemini' | 'claude'; displayName: string; summaryLabel: string; brands: string[] }> = [
    { family: 'gemini', displayName: 'Gemini', summaryLabel: 'Gemini', brands: ['gemini'] },
    { family: 'claude', displayName: 'Claude/GPT', summaryLabel: 'Claude/GPT', brands: ['claude', 'gpt'] },
  ];

  for (const spec of coreSpecs) {
    const fw = familyWindows[spec.family];
    const mq = modelQuota[spec.family];
    const famModels = applied.filter(m => m.family === spec.family && !m.stale && !isExcludedFromStandaloneModelPool(m));
    const famGroups = groups.filter(g => g.family === spec.family);
    const hasGroup = famGroups.length > 0;
    const description = famGroups.find(g => typeof g.description === 'string' && g.description.trim())?.description;
    const windows: ProjectedGroupWindow[] = [];
    const fiveHourWin = toProjectedWindow('5h', '5h', fw.fiveHour, nowMs);
    if (fiveHourWin) windows.push(fiveHourWin);
    if (famGroups.length > 0) {
      const dailyEntry = extractGroupWindows(famGroups, nowMs, staleAfterSeconds).find(w => w.period === 'daily');
      if (dailyEntry) {
        const dailyWin = toProjectedWindow(dailyEntry.id, 'daily', dailyEntry.status, nowMs);
        if (dailyWin) windows.push(dailyWin);
      }
    }
    const weeklyWin = toProjectedWindow('weekly', 'weekly', fw.weekly, nowMs);
    if (weeklyWin) windows.push(weeklyWin);
    if (windows.length === 0 && mq) {
      const modelWin = toProjectedWindow('model', 'unspecified', mq, nowMs);
      if (modelWin) windows.push(modelWin);
    }
    if (windows.length === 0 && famModels.length === 0 && !hasGroup) continue;

    const hasKnownWindow = windows.some(w => w.known);
    const hasFreshWindow = windows.some(w => w.known && !w.stale);
    const hasStaleWindow = windows.some(w => w.stale);
    const allDisabled = famModels.length > 0 && famModels.every(m => m.disabled === true) && !hasKnownWindow;
    const availability: Availability = allDisabled
      ? 'disabled'
      : (hasKnownWindow || hasGroup || famModels.some(m => m.disabled !== true))
        ? 'available'
        : 'unknown';
    const quotaState: QuotaState = hasFreshWindow ? 'known' : hasStaleWindow ? 'stale' : 'not_reported';
    out.push({
      key: spec.family,
      displayName: spec.displayName,
      ...(description ? { description } : {}),
      summaryLabel: spec.summaryLabel,
      brands: spec.brands,
      isStandalone: false,
      availability,
      quotaState,
      windows,
      message: '',
    });
  }

  for (const item of standaloneModels) {
    const windows: ProjectedGroupWindow[] = [];
    if (Array.isArray(item.windows) && item.windows.length > 0) {
      for (const entry of item.windows) {
        const projected = toProjectedWindow(entry.id, entry.period, entry.status, nowMs);
        if (projected) windows.push(projected);
      }
    } else if (item.key === 'argon' || item.key === 'carbon') {
      const fw = item.key === 'argon' ? familyWindows.argon : familyWindows.carbon;
      const w5h = toProjectedWindow('5h', '5h', fw.fiveHour, nowMs);
      if (w5h) windows.push(w5h);
      const famGroups = groups.filter(g => g.family === item.key);
      if (famGroups.length > 0) {
        const dailyEntry = extractGroupWindows(famGroups, nowMs, staleAfterSeconds).find(w => w.period === 'daily');
        if (dailyEntry) {
          const wDaily = toProjectedWindow(dailyEntry.id, 'daily', dailyEntry.status, nowMs);
          if (wDaily) windows.push(wDaily);
        }
      }
      const wWeekly = toProjectedWindow('weekly', 'weekly', fw.weekly, nowMs);
      if (wWeekly) windows.push(wWeekly);
    }
    if (windows.length === 0 && (item.period || item.remaining !== null || item.quotaState !== 'not_reported')) {
      const period = item.period ?? 'unspecified';
      windows.push({
        id: period === 'unspecified' ? 'model' : period,
        period,
        label: quotaPeriodLabel(period),
        known: item.quotaState !== 'not_reported' && item.remaining !== null,
        remaining: item.remaining,
        stale: item.quotaState === 'stale',
        resetCountdown: item.resetCountdown,
        resetTime: item.resetTime ?? null,
        observedAt: item.observedAt,
        source: item.source ?? null,
      });
    }
    out.push({
      key: item.key,
      displayName: item.displayName,
      ...(item.description ? { description: item.description } : {}),
      summaryLabel: item.key === 'argon' ? 'Argon' : item.key === 'carbon' ? 'Carbon' : item.displayName,
      brands: resolveStandaloneBrands(item.key, item.displayName, item.description),
      isStandalone: true,
      availability: item.availability,
      quotaState: item.quotaState,
      windows,
      message: item.message,
    });
  }

  return out;
}

export function buildAccountQuotaOverview(
  account: Account | AccountSummary | { quota?: QuotaData | null },
  options?: { nowMs?: number; staleAfterSeconds?: number },
): QuotaOverview {
  const nowMs = options?.nowMs ?? Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const staleAfterSeconds = typeof options?.staleAfterSeconds === 'number' && options.staleAfterSeconds > 0 ? options.staleAfterSeconds : 900;
  const emptyArgon: ArgonStatus = {
    availability: 'unknown',
    quotaState: 'not_reported',
    period: null,
    remaining: null,
    resetCountdown: '',
    message: bt('account_quota.empty'),
    observedAt: null,
    mode: 'unknown',
    pooledInFamily: null,
  };
  const emptyRefresh: QuotaRefreshState = {
    complete: false,
    endpointsAttempted: [],
    endpointsSucceeded: [],
    missingFamilies: [],
    missingWindows: [],
    carriedGroups: 0,
    refreshedAt: 0,
  };
  const quota = account.quota;
  if (!quota) {
    return {
      fiveHourRemaining: null, weeklyRemaining: null,
      geminiFiveHourRemaining: null, geminiWeeklyRemaining: null,
      geminiFiveHourResetCountdown: '', geminiWeeklyResetCountdown: '', geminiResetCountdown: '',
      claudeFiveHourRemaining: null, claudeWeeklyRemaining: null,
      claudeFiveHourResetCountdown: '', claudeWeeklyResetCountdown: '', claudeResetCountdown: '',
      argonWeeklyRemaining: null, argonWeeklyResetCountdown: '', argonResetCountdown: '',
      carbonWeeklyRemaining: null, carbonWeeklyResetCountdown: '', carbonResetCountdown: '',
      resetTime: null, resetCountdown: '',
      subscriptionTier: bt('quota.tier.pending'), quotaGroups: [], staleGroups: [], unknownBuckets: [], models: [],
      lastUpdated: null, isStale: false, staleHours: 0,
      argonStatus: emptyArgon,
      carbonStatus: emptyArgon,
      standaloneModels: [],
      projectedQuotaGroups: [],
      familyWindows: {
        gemini: { fiveHour: null, weekly: null }, claude: { fiveHour: null, weekly: null }, argon: { fiveHour: null, weekly: null }, carbon: { fiveHour: null, weekly: null },
      },
      familyModelQuota: { gemini: null, claude: null },
      nextResets: { fiveHour: null, weekly: null },
      refreshState: emptyRefresh,
      quotaWarnings: [bt('account_quota.warn.no_quota')],
      quotaWarningCodes: ['NO_QUOTA'],
    };
  }

  const warnings: string[] = [];
  const codes: string[] = [];
  const seenCodes = new Set<string>();
  const addWarning = (code: string, text: string) => {
    seenCodes.add(code);
    if (!warnings.includes(text)) warnings.push(text);
    if (!codes.includes(code)) codes.push(code);
  };
  const sourceDefault: QuotaSource = quota.source === 'live' ? 'live' : 'cloud';
  const rawGroups = Array.isArray(quota.quota_groups) ? quota.quota_groups : [];
  let groups: NormalizedGroup[] = [];
  try {
    groups = normalizeStoredGroups(rawGroups, quota.last_updated ?? nowSec, sourceDefault);
    if (rawGroups.length > groups.length) {
      addWarning('MALFORMED_GROUPS', bt('account_quota.warn.malformed_groups', { count: rawGroups.length - groups.length }));
    }
  } catch {
    addWarning('GROUPS_PARSE_FAILED', bt('account_quota.warn.groups_parse_failed'));
    groups = [];
  }

  const rawModels = Array.isArray(quota.models) ? quota.models : [];
  const models: NormalizedModel[] = [];
  for (let index = 0; index < rawModels.length; index++) {
    try {
      const model = normalizedModelFromStored(rawModels[index]!, sourceDefault, groups);
      const observed = model.own_observed_at ?? quota.last_updated;
      model.own_observed_at = observed ?? null;
      model.own_stale = model.own_stale || (typeof observed === 'number' && nowSec - observed > staleAfterSeconds)
        || (!!model.own_reset_time && Date.parse(model.own_reset_time) <= nowMs);
      for (const key of ['family_5h', 'family_weekly'] as const) {
        const status = model[key];
        if (!status) continue;
        const remaining = normalizeFraction(status.remaining);
        model[key] = { ...status, remaining, known: status.known === true && remaining !== null,
          observedAt: status.observedAt ?? observed ?? null,
          stale: status.stale || (typeof (status.observedAt ?? observed) === 'number' && nowSec - (status.observedAt ?? observed)! > staleAfterSeconds)
            || (!!status.resetTime && Date.parse(status.resetTime) <= nowMs) };
      }
      models.push(model);
    } catch {
      seenCodes.add(`MALFORMED_MODEL:${index}`);
      addWarning('MALFORMED_MODEL', bt('account_quota.warn.malformed_model', { index }));
    }
  }

  const familyWindows = familyWindowsFromGroups(groups, nowMs, staleAfterSeconds);
  for (const family of ['gemini', 'claude', 'argon', 'carbon'] as const) {
    const familyModels = models.filter(model => model.family === family);
    if (!familyWindows[family].fiveHour) {
      const merged = mergeWindowStatuses(...familyModels.map(model => model.family_5h ?? null));
      if (merged) familyWindows[family].fiveHour = merged;
    }
    if (!familyWindows[family].weekly) {
      const merged = mergeWindowStatuses(...familyModels.map(model => model.family_weekly ?? null));
      if (merged) familyWindows[family].weekly = merged;
    }
    // A model's own reset time does not identify a family window. Missing periods stay unknown.
  }

  const applied = applyFamilyWindows(models, familyWindows);
  const legacy = legacyFromFamilyWindows(familyWindows, nowMs);
  const argonStatus = buildArgonStatus(applied, groups, familyWindows, nowMs, quota.subscription_tier, staleAfterSeconds);
  const carbonStatus = buildCarbonStatus(applied, groups, familyWindows, nowMs, argonStatus, quota.subscription_tier, staleAfterSeconds);
  const standaloneModels = buildStandaloneModels(applied, groups, familyWindows, nowMs, argonStatus, carbonStatus, quota.subscription_tier, staleAfterSeconds);
  const argonConverged = argonStatus.mode === 'unified' || argonStatus.mode === 'disabled';
  const carbonConverged = carbonStatus.mode === 'unified' || carbonStatus.mode === 'disabled';
  const hasArgonEvidence = applied.some(m => (m.is_argon || m.family === 'argon') && !isOrchestratorMetaModel(m.model_id || m.name, m.display_name)) || groups.some(g => g.family === 'argon');
  const isFamilyConverged = (family: Family): boolean =>
    (family === 'argon' && argonConverged) || (family === 'carbon' && carbonConverged);
  const nextFiveHour = pickNextReset(familyWindows, '5h', nowMs);
  const nextWeekly = pickNextReset(familyWindows, 'weekly', nowMs);
  const resetPick = nextFiveHour ?? nextWeekly;
  const resetTime = resetPick ? Math.floor(Date.parse(resetPick.resetTime) / 1000) : null;
  const resetCountdown = resetPick?.resetCountdown ?? '';

  const staleGroups = (quota.stale_groups ?? []).map(item => ({ name: item.name, observed_at: item.observed_at }));
  const unknownBuckets = groups.flatMap(group => group.buckets
    .filter(bucket => bucket.disabled !== true && !bucket.remaining_fraction_known)
    .map(bucket => ({ group: group.display_name, bucket: bucket.bucket_id || bucket.window })));

  const knownFreshGroups = groups.filter(group => group.buckets.some(bucket => bucket.remaining_fraction_known && !bucket.stale));
  const derivedMissingFamilies = (['gemini', 'claude'] as Family[]).filter(family =>
    models.some(model => model.family === family) && !knownFreshGroups.some(group => group.family === family));
  const storedRefresh = quota.refresh_state;
  const rawMissingFamilies: Family[] = storedRefresh
    ? (Array.isArray(storedRefresh.missingFamilies) ? storedRefresh.missingFamilies : [])
    : derivedMissingFamilies;
  const rawMissingWindows: { family: Family; window: WindowKind }[] = storedRefresh
    ? (Array.isArray(storedRefresh.missingWindows) ? storedRefresh.missingWindows : [])
    : [];
  const refreshState: QuotaRefreshState = storedRefresh
    ? {
      complete: storedRefresh.complete === true,
      projectContextRecovered: storedRefresh.projectContextRecovered === true,
      endpointsAttempted: Array.isArray(storedRefresh.endpointsAttempted) ? storedRefresh.endpointsAttempted : [],
      endpointsSucceeded: Array.isArray(storedRefresh.endpointsSucceeded) ? storedRefresh.endpointsSucceeded : [],
      missingFamilies: rawMissingFamilies.filter(family => !isFamilyConverged(family)),
      missingWindows: rawMissingWindows.filter(item => !isFamilyConverged(item.family)),
      carriedGroups: Number(storedRefresh.carriedGroups) || 0,
      carriedModels: Number(storedRefresh.carriedModels) || 0,
      refreshedAt: Number(storedRefresh.refreshedAt) || 0,
      usedFallbackEndpoint: storedRefresh.usedFallbackEndpoint === true,
      ...(storedRefresh.error ? { error: localizeStoredQuotaError(String(storedRefresh.error)) } : {}),
    }
    : {
      complete: knownFreshGroups.length > 0 && models.length > 0,
      endpointsAttempted: [],
      endpointsSucceeded: [],
      missingFamilies: derivedMissingFamilies,
      missingWindows: [],
      carriedGroups: staleGroups.length,
      refreshedAt: typeof quota.last_updated === 'number' ? quota.last_updated : 0,
    };

  if (argonStatus.availability === 'disabled') {
    addWarning('ARGON_DISABLED', bt('account_quota.warn.argon_disabled'));
  }
  if (argonStatus.availability === 'unknown' && hasArgonEvidence) {
    addWarning('ARGON_UNKNOWN', argonStatus.message);
  }
  if (argonStatus.availability === 'available' && argonStatus.quotaState === 'not_reported' && !argonConverged) {
    addWarning('ARGON_QUOTA_NOT_REPORTED', bt('account_quota.warn.argon_not_reported'));
  }
  if (argonStatus.quotaState === 'stale' && !argonConverged) {
    addWarning('ARGON_STALE', bt('account_quota.warn.argon_stale'));
  }
  for (const family of refreshState.missingFamilies) {
    addWarning(`MISSING_FAMILY:${family}`, bt('account_quota.warn.missing_family', { family, label: familyLabel(family) }));
  }
  for (const item of refreshState.missingWindows) {
    addWarning(`MISSING_WINDOW:${item.family}:${item.window}`, bt('account_quota.warn.missing_window', { family: item.family, window: item.window, label: familyLabel(item.family) }));
  }
  if (staleGroups.length > 0) {
    addWarning('CARRIED_GROUPS', bt('account_quota.warn.carried_groups', { count: staleGroups.length, names: staleGroups.map(item => item.name).join(bt('common.list_separator')) }));
  }
  for (const warning of quota.quota_warnings ?? []) {
    const resolved = resolveStoredQuotaWarning(warning);
    if (resolved) {
      if (resolved.code === 'ARGON_MODEL_QUOTA' && argonConverged) continue;
      if (resolved.code === 'MISSING_FAMILY:argon' && argonConverged) continue;
      if (resolved.code === 'MISSING_FAMILY:carbon' && carbonConverged) continue;
      if (seenCodes.has(resolved.code)) continue;
      addWarning(resolved.code, resolved.text);
    } else if (!warnings.includes(warning)) {
      warnings.push(warning);
    }
  }

  const legacySnapshot = legacy;
  let oldestGroup = typeof quota.last_updated === 'number' ? quota.last_updated : null;
  let oldestBucket: number | null = null;
  for (const group of groups) {
    if (typeof group.observed_at === 'number' && (oldestGroup === null || group.observed_at < oldestGroup)) oldestGroup = group.observed_at;
    for (const bucket of group.buckets) {
      if (typeof bucket.observed_at === 'number' && (oldestBucket === null || bucket.observed_at < oldestBucket)) oldestBucket = bucket.observed_at;
    }
  }
  const oldest = oldestBucket !== null && (oldestGroup === null || oldestBucket < oldestGroup) ? oldestBucket : oldestGroup;
  const isStale = oldest !== null ? nowSec - oldest > staleAfterSeconds : false;
  const staleHours = oldestGroup !== null ? Math.max(0, Math.floor((nowSec - oldestGroup) / 3600)) : 0;

  const windowOut = (status: WindowStatus | null): QuotaOverviewWindowStatus | null => status
    ? { ...status, resetCountdown: status.resetTime ? formatResetCountdown(status.resetTime, nowMs) : '' }
    : null;
  const modelQuota = familyModelQuotaFromModels(models);

  const outModels: ModelQuota[] = applied.map(model => ({
    ...modelQuotaFromNormalized(model),
    reset_countdown: model.reset_time ? formatResetCountdown(model.reset_time, nowMs) : '',
  }));
  const outGroups: QuotaGroup[] = groups.map(group => {
    const mapped = groupToQuotaGroup(group);
    return {
      ...mapped,
      buckets: mapped.buckets.map(bucket => ({
        ...bucket,
        reset_countdown: bucket.reset_time ? formatResetCountdown(bucket.reset_time, nowMs) : '',
        description: refreshResetDescription(bucket.description, bucket.reset_time, nowMs),
      })),
    };
  });

  const projectedQuotaGroups = buildProjectedQuotaGroups(
    applied,
    groups,
    familyWindows,
    modelQuota,
    standaloneModels,
    nowMs,
    staleAfterSeconds,
  );

  return {
    fiveHourRemaining: legacySnapshot.geminiFiveHourRemaining,
    weeklyRemaining: legacySnapshot.geminiWeeklyRemaining,
    geminiFiveHourRemaining: legacySnapshot.geminiFiveHourRemaining,
    geminiWeeklyRemaining: legacySnapshot.geminiWeeklyRemaining,
    geminiFiveHourResetCountdown: legacySnapshot.geminiFiveHourResetCountdown,
    geminiWeeklyResetCountdown: legacySnapshot.geminiWeeklyResetCountdown,
    geminiResetCountdown: legacySnapshot.geminiFiveHourResetCountdown || legacySnapshot.geminiWeeklyResetCountdown,
    claudeFiveHourRemaining: legacySnapshot.claudeFiveHourRemaining,
    claudeWeeklyRemaining: legacySnapshot.claudeWeeklyRemaining,
    claudeFiveHourResetCountdown: legacySnapshot.claudeFiveHourResetCountdown,
    claudeWeeklyResetCountdown: legacySnapshot.claudeWeeklyResetCountdown,
    claudeResetCountdown: legacySnapshot.claudeWeeklyResetCountdown || legacySnapshot.claudeFiveHourResetCountdown,
    argonWeeklyRemaining: legacySnapshot.argonWeeklyRemaining,
    argonWeeklyResetCountdown: legacySnapshot.argonWeeklyResetCountdown,
    argonResetCountdown: legacySnapshot.argonWeeklyResetCountdown,
    carbonWeeklyRemaining: legacySnapshot.carbonWeeklyRemaining,
    carbonWeeklyResetCountdown: legacySnapshot.carbonWeeklyResetCountdown,
    carbonResetCountdown: legacySnapshot.carbonWeeklyResetCountdown,
    resetTime,
    resetCountdown,
    subscriptionTier: !quota.subscription_tier
      ? bt('quota.tier.pending')
      : !/\b(?:ultra|enterprise|teams?|business|workspace|plus|pro|ai\s+premium)\b/i.test(quota.subscription_tier) &&
        /\b(?:free|starter|trial)\b/i.test(quota.subscription_tier)
      ? 'FREE'
      : quota.subscription_tier,
    quotaGroups: outGroups,
    staleGroups,
    unknownBuckets,
    models: outModels,
    lastUpdated: typeof quota.last_updated === 'number' ? quota.last_updated : null,
    isStale,
    staleHours,
    argonStatus,
    carbonStatus,
    standaloneModels,
    projectedQuotaGroups,
    familyWindows: {
      gemini: {
        fiveHour: windowOut(familyWindows.gemini.fiveHour),
        ...(familyWindows.gemini.daily ? { daily: windowOut(familyWindows.gemini.daily) } : {}),
        weekly: windowOut(familyWindows.gemini.weekly),
      },
      claude: {
        fiveHour: windowOut(familyWindows.claude.fiveHour),
        ...(familyWindows.claude.daily ? { daily: windowOut(familyWindows.claude.daily) } : {}),
        weekly: windowOut(familyWindows.claude.weekly),
      },
      argon: {
        fiveHour: windowOut(familyWindows.argon.fiveHour),
        ...(familyWindows.argon.daily ? { daily: windowOut(familyWindows.argon.daily) } : {}),
        weekly: windowOut(familyWindows.argon.weekly),
      },
      carbon: {
        fiveHour: windowOut(familyWindows.carbon.fiveHour),
        ...(familyWindows.carbon.daily ? { daily: windowOut(familyWindows.carbon.daily) } : {}),
        weekly: windowOut(familyWindows.carbon.weekly),
      },
    },
    familyModelQuota: { gemini: windowOut(modelQuota.gemini), claude: windowOut(modelQuota.claude) },
    nextResets: {
      fiveHour: nextFiveHour ? { family: nextFiveHour.family, resetTime: nextFiveHour.resetTime, resetCountdown: nextFiveHour.resetCountdown } : null,
      weekly: nextWeekly ? { family: nextWeekly.family, resetTime: nextWeekly.resetTime, resetCountdown: nextWeekly.resetCountdown } : null,
    },
    refreshState,
    quotaWarnings: warnings,
    quotaWarningCodes: codes,
  };
}

/**
 * IPC 投影：账号对象中只有 token 是敏感字段，原生端不消费 token（仅后端刷新/切号链路使用）。
 * 所有 account_* / quota_refresh / auto_switch_best 的对外返回统一经过此函数，避免 access/refresh/id token
 * 进入原生内存、桥接日志或 `--command` 标准输出。
 */
export function localizeStoredQuotaForIpc(quota: QuotaData | null | undefined): QuotaData | null {
  if (!quota) return null;
  let next: QuotaData = quota;
  if (Array.isArray(quota.quota_warnings) && quota.quota_warnings.length > 0) {
    const seen = new Set<string>();
    const localizedWarnings: string[] = [];
    for (const warning of quota.quota_warnings) {
      const resolved = resolveStoredQuotaWarning(warning);
      if (resolved) {
        if (seen.has(resolved.code)) continue;
        seen.add(resolved.code);
        if (!localizedWarnings.includes(resolved.text)) localizedWarnings.push(resolved.text);
      } else if (!localizedWarnings.includes(warning)) {
        localizedWarnings.push(warning);
      }
    }
    next = { ...next, quota_warnings: localizedWarnings };
  }
  if (quota.refresh_state?.error) {
    next = {
      ...next,
      refresh_state: {
        ...quota.refresh_state,
        error: localizeStoredQuotaError(String(quota.refresh_state.error)),
      },
    };
  }
  return next;
}

export type StandbyRefreshMode =
  | 'live_active'
  | 'cloud_auto'
  | 'snapshot_cooling'
  | 'snapshot_cooldown_elapsed';

export interface StandbyRefreshStatus {
  mode: StandbyRefreshMode;
  hasLocalOAuthClient: boolean;
  canBackgroundRefresh: boolean;
  lastSampledAt: number | null;
  nextResetAt: string | null;
  cooldownElapsedFamilies: Family[];
}

export interface StandbyCandidateEvaluation {
  tier: 'fresh' | 'snapshot' | 'cooldown_elapsed';
  remaining: number | null;
  earliestResetMs: number | null;
}

function collectQuotaWindowTiming(
  quota: QuotaData | null | undefined,
  overview: QuotaOverview | undefined,
  nowMs: number,
): { cooldownElapsedFamilies: Family[]; nextResetAt: string | null } {
  const elapsedSet = new Set<Family>();
  let earliestFutureMs: number | null = null;
  let nextResetAt: string | null = null;

  const consider = (family: Family, resetTime: unknown) => {
    const iso = normalizeResetTime(resetTime);
    if (!iso) return;
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return;
    if (ms <= nowMs) {
      elapsedSet.add(family);
    } else if (earliestFutureMs === null || ms < earliestFutureMs) {
      earliestFutureMs = ms;
      nextResetAt = iso;
    }
  };

  if (overview?.familyWindows) {
    for (const family of ['gemini', 'claude', 'argon', 'carbon'] as const) {
      const pair = overview.familyWindows[family];
      if (!pair) continue;
      if (pair.fiveHour?.known && pair.fiveHour.resetTime) {
        consider(family, pair.fiveHour.resetTime);
      }
      if (pair.daily?.known && pair.daily.resetTime) {
        consider(family, pair.daily.resetTime);
      }
      if (pair.weekly?.known && pair.weekly.resetTime) {
        consider(family, pair.weekly.resetTime);
      }
    }
  }

  if (quota && Array.isArray(quota.quota_groups)) {
    for (const group of quota.quota_groups) {
      if (!group || !Array.isArray(group.buckets)) continue;
      const family = group.family ?? classifyFamily({
        groupName: group.display_name,
        description: group.description,
        bucketId: group.buckets[0]?.bucket_id,
      });
      for (const bucket of group.buckets) {
        if (!bucket || bucket.disabled === true || bucket.remaining_fraction_known === false) continue;
        const win = classifyWindow(bucket.window, bucket.bucket_id, bucket.display_name);
        if (win !== '5h' && win !== 'daily' && win !== 'weekly') continue;
        consider(family, bucket.reset_time);
      }
    }
  }

  if (!overview?.familyWindows && quota && Array.isArray(quota.models)) {
    for (const model of quota.models) {
      if (!model || model.disabled === true) continue;
      const family = model.family ?? classifyFamily({
        modelId: model.model_id ?? model.name,
        displayName: model.display_name,
      });
      if (model.family_5h?.known && model.family_5h.resetTime) {
        consider(family, model.family_5h.resetTime);
      }
      if (model.family_weekly?.known && model.family_weekly.resetTime) {
        consider(family, model.family_weekly.resetTime);
      }
    }
  }

  return {
    cooldownElapsedFamilies: Array.from(elapsedSet),
    nextResetAt,
  };
}

export function computeStandbyRefreshStatus(
  account: Account | AccountSummary | { quota?: QuotaData | null; quota_last_updated?: number | null; token?: Partial<TokenData> | null } | null | undefined,
  options: {
    isActive?: boolean;
    isRemoteActive?: boolean;
    hasLocalOAuthClient: boolean;
    nowMs?: number;
    overview?: QuotaOverview;
  },
): StandbyRefreshStatus {
  const nowMs = options.nowMs ?? Date.now();
  const nowSec = nowMs / 1000;
  const hasLocalOAuthClient = Boolean(options.hasLocalOAuthClient);
  const rawLastUpdated = account?.quota?.last_updated ?? (account as AccountSummary | null | undefined)?.quota_last_updated ?? null;
  const lastSampledAt = typeof rawLastUpdated === 'number' && Number.isFinite(rawLastUpdated) && rawLastUpdated > 0
    ? rawLastUpdated
    : null;
  const { cooldownElapsedFamilies, nextResetAt } = collectQuotaWindowTiming(account?.quota, options.overview, nowMs);

  if (options.isActive === true || options.isRemoteActive === true) {
    return {
      mode: 'live_active',
      hasLocalOAuthClient,
      canBackgroundRefresh: true,
      lastSampledAt,
      nextResetAt,
      cooldownElapsedFamilies: [],
    };
  }

  const token = (account as Account | null | undefined)?.token;
  const hasValidAccessToken = Boolean(
    token?.access_token
    && token.access_token !== 'pending_refresh'
    && typeof token.expiry_timestamp === 'number'
    && Number.isFinite(token.expiry_timestamp)
    && token.expiry_timestamp - nowSec >= 300,
  );
  if (hasLocalOAuthClient || hasValidAccessToken) {
    return {
      mode: 'cloud_auto',
      hasLocalOAuthClient,
      canBackgroundRefresh: true,
      lastSampledAt,
      nextResetAt,
      cooldownElapsedFamilies: [],
    };
  }

  const elapsed = cooldownElapsedFamilies.length > 0 || hasExpiredQuotaWindow(account?.quota, nowMs);
  return {
    mode: elapsed ? 'snapshot_cooldown_elapsed' : 'snapshot_cooling',
    hasLocalOAuthClient,
    canBackgroundRefresh: false,
    lastSampledAt,
    nextResetAt,
    cooldownElapsedFamilies,
  };
}

function resolveTargetFamiliesForCandidate(
  _account: Account,
  overview: QuotaOverview,
  monitoredModel: string,
): { families: Set<Family>; matchedModel: ModelQuota | null } {
  const trimmed = monitoredModel.trim().toLowerCase();
  if (trimmed === 'argon' || trimmed === 'gemini 4 argon' || trimmed === 'gemini-4-argon') {
    if (overview.argonStatus.mode === 'unified' && overview.argonStatus.pooledInFamily) {
      return { families: new Set<Family>([overview.argonStatus.pooledInFamily]), matchedModel: null };
    }
    return { families: new Set<Family>(['argon']), matchedModel: null };
  }
  if (trimmed === 'carbon' || trimmed === 'gemini 4 carbon' || trimmed === 'gemini-4-carbon') {
    if (overview.carbonStatus.mode === 'unified' && overview.carbonStatus.pooledInFamily) {
      return { families: new Set<Family>([overview.carbonStatus.pooledInFamily]), matchedModel: null };
    }
    return { families: new Set<Family>(['carbon']), matchedModel: null };
  }
  if (trimmed === 'claude' || trimmed === '3p' || trimmed === 'claude/gpt' || trimmed === 'gpt') {
    return { families: new Set<Family>(['claude']), matchedModel: null };
  }
  if (trimmed === 'gemini') {
    return { families: new Set<Family>(['gemini']), matchedModel: null };
  }
  if (
    trimmed === 'gemini_all'
    || trimmed === 'gemini 全系模型'
    || trimmed === 'all gemini models'
    || trimmed === 'gemini 全系（含 argon）'
    || trimmed === 'all gemini (incl. argon)'
  ) {
    return { families: new Set<Family>(['gemini', 'argon', 'carbon']), matchedModel: null };
  }
  if (!trimmed || trimmed === 'all') {
    const hasCore = overview.models.some(m => (m.family === 'gemini' || m.family === 'claude') && m.disabled !== true)
      || overview.familyWindows.gemini.fiveHour !== null
      || Boolean(overview.familyWindows.gemini.daily)
      || overview.familyWindows.gemini.weekly !== null
      || overview.familyWindows.claude.fiveHour !== null
      || Boolean(overview.familyWindows.claude.daily)
      || overview.familyWindows.claude.weekly !== null;
    return {
      families: new Set<Family>(hasCore ? ['gemini', 'claude'] : ['argon', 'carbon']),
      matchedModel: null,
    };
  }

  const matchedModels = findMatchingModels(overview.models, trimmed);
  const model = matchedModels.find(m => m.disabled !== true && m.stale !== true) ?? matchedModels[0] ?? null;
  if (model) {
    const modelFamily = model.family ?? classifyFamily({ modelId: model.name, displayName: model.display_name });
    if ((model.is_argon || modelFamily === 'argon') && overview.argonStatus.mode === 'unified' && overview.argonStatus.pooledInFamily) {
      return { families: new Set<Family>([overview.argonStatus.pooledInFamily]), matchedModel: model };
    }
    if ((model.is_carbon || modelFamily === 'carbon') && overview.carbonStatus.mode === 'unified' && overview.carbonStatus.pooledInFamily) {
      return { families: new Set<Family>([overview.carbonStatus.pooledInFamily]), matchedModel: model };
    }
    return { families: new Set<Family>([modelFamily]), matchedModel: model };
  }

  if (trimmed === 'gemini-4-argon') return { families: new Set<Family>(['argon']), matchedModel: null };
  if (trimmed === 'gemini-4-carbon') return { families: new Set<Family>(['carbon']), matchedModel: null };
  const classified = classifyFamily({ modelId: trimmed, displayName: trimmed });
  return {
    families: new Set<Family>(classified === 'other' ? [] : [classified]),
    matchedModel: null,
  };
}

export function evaluateStandbyCandidate(
  account: Account,
  monitoredModel = 'all',
  options?: {
    staleAfterSeconds?: number;
    nowMs?: number;
    minPercentage?: number;
    overview?: QuotaOverview;
  },
): StandbyCandidateEvaluation | null {
  if (!account || account.disabled || account.validation_blocked || account.quota?.is_forbidden) return null;
  const nowMs = options?.nowMs ?? Date.now();
  const nowSec = nowMs / 1000;
  if (accountCredentialReadiness(account, nowSec).state === 'needs_authorization') return null;
  const quota = account.quota;
  if (!quota || !Array.isArray(quota.models)) return null;

  const minPct = typeof options?.minPercentage === 'number' ? options.minPercentage : 0;
  const overview = options?.overview ?? buildAccountQuotaOverview(account, {
    nowMs,
    staleAfterSeconds: options?.staleAfterSeconds,
  });
  const { families: targetFamilies, matchedModel } = resolveTargetFamiliesForCandidate(account, overview, monitoredModel);
  if (matchedModel?.disabled === true) return null;
  if (targetFamilies.size === 0 && !matchedModel) return null;

  const expiredResetMs: number[] = [];
  const unexpiredFractions: number[] = [];

  const inspectWindow = (known: boolean | undefined, remaining: number | null | undefined, resetTime: unknown) => {
    if (!known) return;
    const iso = normalizeResetTime(resetTime);
    const ms = iso ? Date.parse(iso) : Number.NaN;
    if (Number.isFinite(ms) && ms <= nowMs) {
      expiredResetMs.push(ms);
    } else if (typeof remaining === 'number' && Number.isFinite(remaining)) {
      unexpiredFractions.push(remaining);
    }
  };

  for (const family of targetFamilies) {
    if (family === 'gemini' || family === 'claude' || family === 'argon' || family === 'carbon') {
      const fw = overview.familyWindows[family];
      if (fw.fiveHour) inspectWindow(fw.fiveHour.known, fw.fiveHour.remaining, fw.fiveHour.resetTime);
      if (fw.daily) inspectWindow(fw.daily.known, fw.daily.remaining, fw.daily.resetTime);
      if (fw.weekly) inspectWindow(fw.weekly.known, fw.weekly.remaining, fw.weekly.resetTime);
    }
  }

  if (Array.isArray(quota.quota_groups)) {
    for (const group of quota.quota_groups) {
      if (!group || !Array.isArray(group.buckets)) continue;
      const family = group.family ?? classifyFamily({
        groupName: group.display_name,
        description: group.description,
        bucketId: group.buckets[0]?.bucket_id,
      });
      if (!targetFamilies.has(family)) continue;
      for (const bucket of group.buckets) {
        if (!bucket || bucket.disabled === true || bucket.remaining_fraction_known === false) continue;
        inspectWindow(true, bucket.remaining_fraction, bucket.reset_time);
      }
    }
  }

  if (matchedModel) {
    if (matchedModel.own_percentage_known && typeof matchedModel.own_percentage === 'number') {
      inspectWindow(true, matchedModel.own_percentage / 100, matchedModel.own_reset_time ?? matchedModel.reset_time);
    }
    if (matchedModel.family_5h) inspectWindow(matchedModel.family_5h.known, matchedModel.family_5h.remaining, matchedModel.family_5h.resetTime);
    if (matchedModel.family_weekly) inspectWindow(matchedModel.family_weekly.known, matchedModel.family_weekly.remaining, matchedModel.family_weekly.resetTime);
  }

  const freshRem = computeAccountRemaining(account, monitoredModel, {
    staleAfterSeconds: options?.staleAfterSeconds,
    nowMs,
  });
  if (freshRem !== null && expiredResetMs.length === 0) {
    return freshRem > 0 && freshRem >= minPct
      ? { tier: 'fresh', remaining: freshRem, earliestResetMs: null }
      : null;
  }

  if (expiredResetMs.length === 0) {
    const snapshotRem = computeAccountRemaining(account, monitoredModel, {
      staleAfterSeconds: Number.MAX_SAFE_INTEGER,
      nowMs,
    });
    if (snapshotRem !== null && snapshotRem > 0 && snapshotRem >= minPct) {
      return { tier: 'snapshot', remaining: snapshotRem, earliestResetMs: null };
    }
    return null;
  }

  // If any unexpired known window on the target family is depleted or below minPct, do not treat as ready.
  if (unexpiredFractions.some(frac => frac <= 0 || Math.round(frac * 100) < minPct)) {
    return null;
  }

  return {
    tier: 'cooldown_elapsed',
    remaining: null,
    earliestResetMs: Math.min(...expiredResetMs),
  };
}

export function projectAccountForIpc(
  account: Account | AccountSummary | null | undefined,
  options?: {
    isActive?: boolean;
    isRemoteActive?: boolean;
    hasLocalOAuthClient?: boolean;
    nowMs?: number;
    overview?: QuotaOverview;
  },
): Record<string, any> | null {
  if (!account) return null;
  const summary = account as AccountSummary;
  const rawQuota = summary.quota ?? null;
  const quota = localizeStoredQuotaForIpc(rawQuota);
  const hasTokenObject = Boolean((account as Account).token && typeof (account as Account).token === 'object');
  const nowSec = (options?.nowMs ?? Date.now()) / 1000;
  const resolvedReadiness =
    summary.credentialReadiness ??
    (hasTokenObject
      ? accountCredentialReadiness(account as Account, nowSec)
      : accountCredentialReadiness({
          ...(summary as unknown as Account),
          token: {
            access_token: 'summary_projected',
            refresh_token: 'summary_projected',
            expires_in: 3600,
            expiry_timestamp: nowSec + 3600,
            token_type: 'Bearer',
            is_gcp_tos: false,
          },
        }, nowSec));
  const standbyRefreshStatus = computeStandbyRefreshStatus(account, {
    isActive: options?.isActive,
    isRemoteActive: options?.isRemoteActive,
    hasLocalOAuthClient: options?.hasLocalOAuthClient ?? false,
    nowMs: options?.nowMs,
    overview: options?.overview,
  });
  const rawError = typeof summary.quota_refresh_error === 'string' ? summary.quota_refresh_error.trim() : '';
  const isMissingOAuthError =
    summary.quota_refresh_error_code === 'missing_oauth_client'
    || (rawError.length > 0 && MISSING_OAUTH_CLIENT_PATTERN.test(rawError));
  const isStandbySnapshotMode =
    standbyRefreshStatus.mode === 'snapshot_cooling'
    || standbyRefreshStatus.mode === 'snapshot_cooldown_elapsed';
  const projectedError = isStandbySnapshotMode && isMissingOAuthError
    ? null
    : cleanAndLocalizeRefreshError(summary.quota_refresh_error);
  return {
    id: summary.id,
    email: summary.email,
    name: summary.name ?? null,
    custom_label: summary.custom_label ?? null,
    disabled: Boolean(summary.disabled),
    disabled_reason: summary.disabled_reason ?? null,
    disabled_at: summary.disabled_at ?? null,
    protected_models: Array.isArray(summary.protected_models) ? summary.protected_models : [],
    validation_blocked: Boolean((summary as Account).validation_blocked),
    created_at: summary.created_at ?? null,
    last_used: summary.last_used ?? null,
    quota,
    credentialReadiness: resolvedReadiness,
    standbyRefreshStatus,
    quota_refresh_error: projectedError,
    quota_last_updated: summary.quota_last_updated ?? rawQuota?.last_updated ?? 0,
    subscription_tier: rawQuota?.subscription_tier ?? null,
    revision: summary.revision ?? computeAccountRevision(summary),
  };
}

function isExpiredResetIso(resetTime: unknown, nowMs: number): boolean {
  const iso = normalizeResetTime(resetTime);
  if (!iso) return false;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && ms <= nowMs;
}

/**
 * 检测配额快照中是否包含已超过 reset_time 的已知窗口桶。
 */
export function hasExpiredQuotaWindow(quota: QuotaData | null | undefined, nowMs: number = Date.now()): boolean {
  if (!quota || !Array.isArray(quota.quota_groups)) return false;
  for (const group of quota.quota_groups) {
    if (!group || !Array.isArray(group.buckets)) continue;
    for (const bucket of group.buckets) {
      if (!bucket || bucket.disabled === true || bucket.remaining_fraction_known === false) continue;
      if (isExpiredResetIso(bucket.reset_time, nowMs)) return true;
    }
  }
  return false;
}
