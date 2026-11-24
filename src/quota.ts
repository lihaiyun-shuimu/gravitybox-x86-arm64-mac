/**
 * 配额规范化 / 窗口融合纯 helper（无 I/O、无网络）。
 *
 * 配额规范化与熔合设计原则：
 * - live（language_server RPC）与 cloud（cloudcode REST）共用同一套规范化。
 * - 模型自身 quotaInfo 与 family（Gemini/Claude/GPT/Argon/Carbon）窗口分离保存；legacy 字段
 *   percentage 仅作为 "effective=min(own, 相关 family 已知窗口)" 的兼容投影，own_* 保留真值。
 * - fraction 仅 finite 且 0..1 视为 known；null/缺值/越界一律 unknown，不造 100%。
 * - 窗口明确区分 5h / weekly / unspecified，不再用 "else=weekly"。
 * - 端点合并按优先级（production > daily > sandbox），高优先级有效值不被低优先级覆盖，
 *   低优先级只补缺项。
 * - carryover 按语义 family+window 匹配，fresh 覆盖；旧值单独带 observedAt/stale，不冒充新采样。
 */

import { bt } from './i18n.js';

export type WindowKind = '5h' | 'daily' | 'weekly' | 'unspecified';
export type Family = 'gemini' | 'claude' | 'argon' | 'carbon' | 'other';
export type QuotaSource = 'cloud' | 'live' | 'carried';
export type Availability = 'available' | 'disabled' | 'unknown';
export type QuotaState = 'known' | 'not_reported' | 'stale';
export type ArgonPeriod = '5h' | 'daily' | 'weekly' | 'unspecified' | null;
export type StandaloneMode = 'unified' | 'standalone' | 'disabled' | 'unknown';

export interface WindowStatus {
  remaining: number | null;
  known: boolean;
  stale: boolean;
  resetTime: string | null;
  observedAt: number | null;
  source: QuotaSource;
}

export interface GroupWindowEntry {
  id: string;
  period: WindowKind;
  status: WindowStatus;
}

export interface FamilyWindowSet {
  fiveHour: WindowStatus | null;
  daily?: WindowStatus | null;
  weekly: WindowStatus | null;
}

export interface FamilyWindows {
  gemini: FamilyWindowSet;
  claude: FamilyWindowSet;
  argon: FamilyWindowSet;
  carbon: FamilyWindowSet;
}

export interface ArgonStatus {
  availability: Availability;
  quotaState: QuotaState;
  period: ArgonPeriod;
  remaining: number | null;
  resetCountdown: string;
  resetTime?: string | null;
  message: string;
  observedAt: number | null;
  source?: QuotaSource;
  mode?: StandaloneMode;
  pooledInFamily?: 'gemini' | 'claude' | null;
}

export interface StandaloneModelStatus extends ArgonStatus {
  key: string;
  displayName: string;
  description?: string;
  windows?: GroupWindowEntry[];
  fromOfficialGroup?: boolean;
  groupId?: string;
}

export interface NormalizedBucket {
  bucket_id: string;
  window: WindowKind;
  raw_window: string;
  remaining_fraction: number | null;
  remaining_fraction_known: boolean;
  percentage: number | null;
  reset_time: string | null;
  display_name?: string;
  description?: string;
  disabled?: boolean;
  observed_at: number | null;
  stale: boolean;
  source: QuotaSource;
}

export interface NormalizedGroup {
  group_id?: string;
  display_name: string;
  description?: string;
  family: Family;
  observed_at: number | null;
  buckets: NormalizedBucket[];
  stale: boolean;
  source: QuotaSource;
}

export interface NormalizedModel {
  name: string;
  model_id: string;
  display_name: string | null;
  family: Family;
  is_argon: boolean;
  is_carbon?: boolean;
  disabled: boolean | null;
  model_or_alias: string | null;
  /** 上游权威元数据（透传与过滤用） */
  is_internal?: boolean;
  model_provider?: string | null;
  deprecated?: boolean;
  non_chat_specialized?: boolean;
  in_model_selector?: boolean;
  /** 模型自身 quotaInfo（唯一真值，不被 family 窗口覆写）。 */
  own_percentage: number | null;
  own_percentage_known: boolean;
  own_reset_time: string | null;
  own_observed_at: number | null;
  own_stale: boolean;
  /** family 窗口引用（applyFamilyWindows 后填充）。 */
  family_5h: WindowStatus | null;
  family_weekly: WindowStatus | null;
  /** 兼容投影：min(own, family 已知新鲜窗口)；own 与窗口都 unknown 时为 null。 */
  percentage: number;
  percentage_known: boolean;
  effective_percentage: number | null;
  effective_known: boolean;
  reset_time: string;
  quota_bucket_id?: string;
  quota_bucket_name?: string | null;
  reset_countdown?: string;
  quota_source: QuotaSource;
  stale: boolean;
  // 透传元数据（native/详情用）
  supports_images?: boolean;
  supports_thinking?: boolean;
  thinking_budget?: number;
  recommended?: boolean;
  max_tokens?: number;
  max_output_tokens?: number;
  supported_mime_types?: Record<string, boolean>;
}

export interface StaleGroup {
  name: string;
  observed_at: number;
}

const numOrNull = (value: unknown): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
};

/** fraction 合法范围 0..1；越界/非数值一律 unknown。 */
export function normalizeFraction(value: unknown): number | null {
  const n = numOrNull(value);
  if (n === null) return null;
  if (n < 0 || n > 1) return null;
  return n;
}

export function normalizeResetTime(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() && !Number.isNaN(Date.parse(value))) return value;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const ms = value < 1e11 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  return null;
}

export function classifyWindow(rawWindow: unknown, bucketId?: unknown, displayName?: unknown): WindowKind {
  const raw = `${String(rawWindow ?? '')} ${String(bucketId ?? '')} ${String(displayName ?? '')}`.toLowerCase();
  const text = raw.replace(/[_-]+/g, ' ');
  if (/5\s*h(?:our)?s?\b|\bfive\s*hours?\b|fivehour/.test(text)) return '5h';
  if (/\bdaily\b|\b24\s*h(?:our)?s?\b|\b1\s*d(?:ay)?\b|\bper\s*day\b/.test(text)) return 'daily';
  if (/week|7\s*d|seven\s*day/.test(text)) return 'weekly';
  return 'unspecified';
}

const SHARED_GEMINI_CODENAMES = new Set([
  'pro', 'flash', 'ultra', 'nano', 'lite', 'default', 'exp', 'preview', 'trial', 'hydrogen',
]);

/**
 * 判断模型是否为 Antigravity 编排器元模型（对齐 2.34.0 main.js:jW）。
 * 编排器是复合代理模式（planModel + executionModel），绝不是独立配额池。
 */
export function isOrchestratorMetaModel(id?: unknown, displayName?: unknown): boolean {
  const normId = String(id ?? '').trim().toLowerCase();
  if (
    normId === 'gemini-pro-coordinator'
    || normId === 'gemini-pro-orchestrator'
    || normId.startsWith('gemini-pro-orchestrator-')
    || normId === 'orchestrator'
    || normId.startsWith('orchestrator-')
    || normId.startsWith('orchestrator_')
  ) {
    return true;
  }
  const normName = String(displayName ?? '').trim();
  if (normName && /^orchestrator(?:\s*\([^)]*\)|\s+\S+)?$/i.test(normName)) {
    return true;
  }
  return false;
}

/**
 * 从官方 QuotaSummaryGroup.description 解析 "Models within this group: ..." 成员列表。
 */
export function extractGroupMemberLabels(description?: unknown): string[] {
  if (typeof description !== 'string' || !description.trim()) return [];
  const match = description.match(/models?\s+(?:within|in)\s+this\s+group\s*:\s*([^\n\r]+)/i);
  if (!match || !match[1]) return [];
  const rawList = match[1].replace(/\.\s+.*$/, '').replace(/\.+$/, '').trim();
  if (!rawList) return [];
  return rawList
    .split(/[,，、]/)
    .map(item => item.trim())
    .filter(Boolean);
}

const GROUP_MEMBER_TIER_PAREN_RE =
  /\s*\((?:extra\s+high|extra\s+low|xhigh|extra|high|medium|low|minimal|max|thinking|disabled|trial|preview|exp|tiered|latest)\)\s*$/i;
const GROUP_MEMBER_TIER_SUFFIX_RE =
  /(?:[\s_-]+(?:extra[\s_-]+high|extra[\s_-]+low|xhigh|extra|high|medium|low|minimal|max|thinking|disabled|trial|preview|exp|tiered|latest))+$/i;

export function normalizeGroupMemberKey(raw: string): string {
  let text = raw.trim().toLowerCase();
  if (!text) return '';
  let prev = '';
  while (text !== prev) {
    prev = text;
    text = text.replace(GROUP_MEMBER_TIER_PAREN_RE, '').replace(GROUP_MEMBER_TIER_SUFFIX_RE, '').trim();
  }
  return text.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function findGroupForModelByDescription(
  model: { model_id?: string; name?: string; display_name?: string | null },
  groups: NormalizedGroup[],
): NormalizedGroup | null {
  if (!groups.length) return null;
  const candidateKeys = new Set<string>();
  for (const raw of [model.model_id, model.name, model.display_name]) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const key = normalizeGroupMemberKey(raw);
    if (key) candidateKeys.add(key);
  }
  if (candidateKeys.size === 0) return null;
  for (const group of groups) {
    const labels = extractGroupMemberLabels(group.description);
    if (labels.length === 0) continue;
    for (const label of labels) {
      const normLabel = normalizeGroupMemberKey(label);
      if (normLabel && candidateKeys.has(normLabel)) {
        return group;
      }
    }
  }
  return null;
}

/**
 * 使用官方 QuotaSummaryGroup.description 补全/自愈模型的归属 family（保留 argon/carbon 兼容契约）。
 */
export function resolveModelsWithGroupDescriptions(
  models: NormalizedModel[],
  groups: NormalizedGroup[],
): NormalizedModel[] {
  if (!groups.length || !models.length) return models;
  return models.map(model => {
    if (model.family !== 'other') return model;
    const matchedGroup = findGroupForModelByDescription(model, groups);
    if (matchedGroup && (matchedGroup.family === 'gemini' || matchedGroup.family === 'claude')) {
      return { ...model, family: matchedGroup.family };
    }
    return model;
  });
}

export function isExcludedFromStandaloneModelPool(model: NormalizedModel): boolean {
  if (model.disabled === true) return true;
  if (model.is_internal === true) return true;
  if (model.deprecated === true) return true;
  if (model.non_chat_specialized === true) return true;
  if (isOrchestratorMetaModel(model.model_id || model.name, model.display_name)) return true;
  return false;
}

export function extractStandaloneGeminiCodename(raw: string): string | null {
  const text = raw.trim().toLowerCase();
  if (!text) return null;
  const geminiMatch = text.match(/\bgemini[\s_-]*[4-9](?:\.\d+)?[\s_-]+([a-z][a-z0-9]*)\b/i);
  if (geminiMatch) {
    const codename = geminiMatch[1]!.toLowerCase();
    if (!SHARED_GEMINI_CODENAMES.has(codename)) return codename;
  }
  const orchMatch = text.match(/\borchestrator(?:[\s_-]+|\s*\(\s*)([a-z][a-z0-9]*)\b/i);
  if (orchMatch) {
    const codename = orchMatch[1]!.toLowerCase();
    if (!SHARED_GEMINI_CODENAMES.has(codename) && codename !== 'g1') return codename;
  }
  return null;
}

export function classifyFamily(input: {
  groupName?: unknown;
  description?: unknown;
  bucketId?: unknown;
  modelId?: unknown;
  displayName?: unknown;
  modelProvider?: unknown;
  modelOrAlias?: unknown;
}): Family {
  // A reset description can mention other pools. Identity fields take precedence.
  const identity = [input.bucketId, input.modelId, input.displayName, input.modelOrAlias]
    .map(value => String(value ?? '').toLowerCase()).join(' ');
  const provider = String(input.modelProvider ?? '').toLowerCase();
  const groupNameStr = String(input.groupName ?? '').trim().toLowerCase();
  const text = (identity.includes('argon') || identity.includes('carbon'))
    ? identity
    : [groupNameStr, identity, provider].map(value => String(value ?? '').toLowerCase()).join(' ');
  if (text.includes('argon')) return 'argon';
  if (text.includes('carbon')) return 'carbon';
  // 仅当输入代表官方独立配额分组/桶（显式带 groupName 且不含 modelId）且命名为具体 Gemini 4+ 独立池时，
  // 归为 'other' 以免与核心 "Gemini Models" 组冲突；普通模型绝不凭代号踢出 'gemini'。
  const isGroupOrBucketClassification = Boolean(groupNameStr) && !String(input.modelId ?? '').trim();
  if (
    isGroupOrBucketClassification
    && /^gemini[\s_-]*[4-9](?:\.\d+)?[\s_-]+[a-z][a-z0-9]*/i.test(groupNameStr)
    && !/^gemini[\s_-]*[4-9](?:\.\d+)?[\s_-]+(?:models?|pro|flash|ultra|nano|lite|default|exp|preview|trial)\b/i.test(groupNameStr)
  ) {
    return 'other';
  }
  if (
    /claude|gpt|openai|anthropic|grok|xai|deepseek|mistral|llama|third[_-]?party|3p\b|\bo[1-9]\d*(?:$|[-_\s]|-(?:mini|pro|preview|high|low|medium))\b/.test(text)
    || (Boolean(provider.trim()) && !/google|gemini|vertex|antigravity|unspecified|unknown/.test(provider) && /provider/.test(provider))
  ) {
    return 'claude';
  }
  if (/gemini|google/.test(text)) return 'gemini';
  return 'other';
}

function modelDisabled(record: any, id: string): boolean | null {
  if (typeof record.disabled === 'boolean') return record.disabled;
  if (typeof record.isDisabled === 'boolean') return record.isDisabled;
  // The official client also uses an explicit disabled model identifier.
  return /(?:^|[-_])disabled(?:$|[-_])/i.test(id) ? true : null;
}

export function formatCountdown(
  resetTime: string | number | null | undefined,
  nowMs: number = Date.now(),
  options?: { preserveUnparsed?: boolean }
): string {
  if (!resetTime) return '';
  const normalized = normalizeResetTime(resetTime);
  if (!normalized) return options?.preserveUnparsed ? String(resetTime) : '';
  const tsMs = Date.parse(normalized);
  const diffMs = tsMs - nowMs;
  if (diffMs <= 0) return bt('quota.countdown.overdue');
  if (diffMs <= 60000) return bt('quota.countdown.soon');
  const totalMin = Math.floor(diffMs / 60000);
  const days = Math.floor(totalMin / (24 * 60));
  const hours = Math.floor((totalMin % (24 * 60)) / 60);
  const mins = totalMin % 60;
  if (days > 0) return bt('quota.countdown.days_hours', { days, hours });
  if (hours > 0) return bt('quota.countdown.hours_mins', { hours, mins });
  return bt('quota.countdown.mins', { mins });
}

// ---------------------------------------------------------------------------
// 云端 models（fetchAvailableModels）
// ---------------------------------------------------------------------------

function cloudModelEntries(payload: any): { id: string; info: any }[] {
  const rows: { id: string; info: any }[] = [];
  const raw = payload?.models ?? payload?.response?.models;
  if (!raw) return rows;
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const id = String(item.id ?? item.name ?? item.modelId ?? '');
      if (id) rows.push({ id, info: item });
    }
    return rows;
  }
  if (typeof raw === 'object') {
    for (const [id, info] of Object.entries<any>(raw)) {
      if (id) rows.push({ id, info: info && typeof info === 'object' ? info : {} });
    }
  }
  return rows;
}

function collectStringSet(raw: unknown): Set<string> {
  const out = new Set<string>();
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === 'string' && item.trim()) out.add(item.trim());
    }
  } else if (raw && typeof raw === 'object') {
    for (const key of Object.keys(raw as Record<string, unknown>)) {
      if (key.trim()) out.add(key.trim());
    }
  }
  return out;
}

function collectModelSelectorSets(rawSorts: unknown): { ids: Set<string>; labels: Set<string>; present: boolean } {
  const ids = new Set<string>();
  const labels = new Set<string>();
  if (!Array.isArray(rawSorts) || rawSorts.length === 0) {
    return { ids, labels, present: false };
  }
  for (const sort of rawSorts) {
    if (!sort || typeof sort !== 'object') continue;
    const groups = (sort as any).groups;
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!group || typeof group !== 'object') continue;
      for (const id of [
        ...(Array.isArray(group.modelIds) ? group.modelIds : []),
        ...(Array.isArray(group.model_ids) ? group.model_ids : []),
      ]) {
        if (typeof id === 'string' && id.trim()) ids.add(id.trim());
      }
      for (const label of [
        ...(Array.isArray(group.modelLabels) ? group.modelLabels : []),
        ...(Array.isArray(group.model_labels) ? group.model_labels : []),
      ]) {
        if (typeof label === 'string' && label.trim()) labels.add(label.trim().toLowerCase());
      }
    }
  }
  return { ids, labels, present: ids.size > 0 || labels.size > 0 };
}

const NON_CHAT_SPECIALIZED_KEYS = [
  'tabModelIds', 'tab_model_ids',
  'commandModelIds', 'command_model_ids',
  'imageGenerationModelIds', 'image_generation_model_ids',
  'mqueryModelIds', 'mquery_model_ids',
  'webSearchModelIds', 'web_search_model_ids',
  'commitMessageModelIds', 'commit_message_model_ids',
  'audioTranscriptionModelIds', 'audio_transcription_model_ids',
] as const;

export function normalizeCloudModels(payload: any, observedAt: number): NormalizedModel[] {
  const root = payload?.response && typeof payload.response === 'object' ? payload.response : payload;
  const deprecatedIds = new Set<string>([
    ...collectStringSet(payload?.deprecatedModelIds ?? payload?.deprecated_model_ids),
    ...collectStringSet(root?.deprecatedModelIds ?? root?.deprecated_model_ids),
  ]);
  const nonChatIds = new Set<string>();
  for (const key of NON_CHAT_SPECIALIZED_KEYS) {
    for (const id of collectStringSet(payload?.[key])) nonChatIds.add(id);
    if (root !== payload) {
      for (const id of collectStringSet(root?.[key])) nonChatIds.add(id);
    }
  }
  const selector = collectModelSelectorSets(
    payload?.agentModelSorts ?? payload?.agent_model_sorts
    ?? payload?.clientModelSorts ?? payload?.client_model_sorts
    ?? root?.agentModelSorts ?? root?.agent_model_sorts
    ?? root?.clientModelSorts ?? root?.client_model_sorts,
  );

  const models: NormalizedModel[] = [];
  for (const { id, info } of cloudModelEntries(payload)) {
    const displayName = typeof (info.displayName ?? info.display_name ?? info.label) === 'string'
      ? String(info.displayName ?? info.display_name ?? info.label)
      : null;
    const metadata = info.metadata && typeof info.metadata === 'object' ? info.metadata : {};
    const alias = info.modelOrAlias?.model ?? info.model_or_alias ?? metadata.model ?? info.model;
    const modelOrAlias = typeof alias === 'string' ? alias : null;
    const rawProvider = info.modelProvider ?? info.model_provider ?? info.provider
      ?? metadata.modelProvider ?? metadata.model_provider ?? metadata.provider ?? '';
    const modelProvider = typeof rawProvider === 'string' && rawProvider.trim() ? rawProvider.trim() : null;
    const rawBucketName =
      info.quotaBucketName ?? info.quota_bucket_name
      ?? info.beyondModelInfo?.quotaBucketName ?? info.beyond_model_info?.quota_bucket_name
      ?? metadata.quotaBucketName ?? metadata.quota_bucket_name
      ?? metadata.beyondModelInfo?.quotaBucketName ?? metadata.beyond_model_info?.quota_bucket_name;
    const quotaBucketName = typeof rawBucketName === 'string' && rawBucketName.trim() ? rawBucketName.trim() : null;
    const isInternal = info.isInternal === true || info.is_internal === true
      || metadata.isInternal === true || metadata.is_internal === true;
    const deprecated = deprecatedIds.has(id) || info.deprecated === true || info.isDeprecated === true;
    const nonChatSpecialized = nonChatIds.has(id);
    const inModelSelector = selector.present
      ? (selector.ids.has(id)
        || (modelOrAlias !== null && selector.ids.has(modelOrAlias))
        || (displayName !== null && selector.labels.has(displayName.trim().toLowerCase())))
      : undefined;
    const quotaInfo = info.quotaInfo ?? info.quota_info ?? {};
    const fraction = normalizeFraction(quotaInfo?.remainingFraction ?? quotaInfo?.remaining_fraction);
    const family = classifyFamily({ modelId: id, displayName, modelProvider: modelProvider ?? '', modelOrAlias });
    const disabled = modelDisabled(info, id);
    models.push({
      name: id,
      model_id: id,
      display_name: displayName,
      family,
      is_argon: family === 'argon',
      is_carbon: family === 'carbon',
      disabled,
      model_or_alias: modelOrAlias,
      ...(isInternal ? { is_internal: true } : {}),
      ...(modelProvider ? { model_provider: modelProvider } : {}),
      ...(deprecated ? { deprecated: true } : {}),
      ...(nonChatSpecialized ? { non_chat_specialized: true } : {}),
      ...(inModelSelector !== undefined ? { in_model_selector: inModelSelector } : {}),
      ...(quotaBucketName ? { quota_bucket_name: quotaBucketName } : {}),
      own_percentage: fraction === null ? null : Math.round(fraction * 100),
      own_percentage_known: fraction !== null,
      own_reset_time: normalizeResetTime(quotaInfo?.resetTime ?? quotaInfo?.reset_time),
      own_observed_at: observedAt,
      own_stale: false,
      family_5h: null,
      family_weekly: null,
      percentage: 0,
      percentage_known: false,
      effective_percentage: null,
      effective_known: false,
      reset_time: '',
      quota_source: 'cloud',
      stale: false,
      supports_images: info.supportsImages ?? info.supports_images,
      supports_thinking: info.supportsThinking ?? info.supports_thinking,
      thinking_budget: numOrNull(info.thinkingBudget ?? info.thinking_budget) ?? undefined,
      recommended: info.recommended === true,
      max_tokens: numOrNull(info.maxTokens ?? info.max_tokens) ?? undefined,
      max_output_tokens: numOrNull(info.maxOutputTokens ?? info.max_output_tokens) ?? undefined,
      supported_mime_types: info.supportedMimeTypes ?? info.supported_mime_types,
    });
  }
  return models;
}

/** live GetUserStatus.cascadeModelConfigData.clientModelConfigs */
export function normalizeLiveModels(
  clientConfigs: any,
  observedAt: number,
  options?: { clientModelSorts?: unknown },
): NormalizedModel[] {
  const selector = collectModelSelectorSets(options?.clientModelSorts);
  const models: NormalizedModel[] = [];
  for (const cfg of Array.isArray(clientConfigs) ? clientConfigs : []) {
    if (!cfg || typeof cfg !== 'object') continue;
    const modelOrAlias = typeof cfg.modelOrAlias?.model === 'string' && cfg.modelOrAlias.model.trim()
      ? cfg.modelOrAlias.model.trim()
      : null;
    const id = String(cfg.modelId ?? cfg.id ?? modelOrAlias ?? '').trim();
    if (!id) continue;
    const displayName = typeof (cfg.label ?? cfg.displayName) === 'string' ? String(cfg.label ?? cfg.displayName) : null;
    const rawProvider = cfg.modelProvider ?? cfg.model_provider ?? cfg.provider ?? '';
    const modelProvider = typeof rawProvider === 'string' && rawProvider.trim() ? rawProvider.trim() : null;
    const rawBucketName =
      cfg.quotaBucketName ?? cfg.quota_bucket_name
      ?? cfg.beyondModelInfo?.quotaBucketName ?? cfg.beyond_model_info?.quota_bucket_name;
    const quotaBucketName = typeof rawBucketName === 'string' && rawBucketName.trim() ? rawBucketName.trim() : null;
    const isInternal = cfg.isInternal === true || cfg.is_internal === true;
    const deprecated = cfg.deprecated === true || cfg.isDeprecated === true;
    const inModelSelector = selector.present
      ? (selector.ids.has(id)
        || (modelOrAlias !== null && selector.ids.has(modelOrAlias))
        || (displayName !== null && selector.labels.has(displayName.trim().toLowerCase())))
      : undefined;
    const quotaInfo = cfg.quotaInfo ?? {};
    const fraction = normalizeFraction(quotaInfo?.remainingFraction ?? quotaInfo?.remaining_fraction);
    const family = classifyFamily({ modelId: id, displayName, modelProvider: modelProvider ?? '', modelOrAlias });
    const disabled = modelDisabled(cfg, id);
    models.push({
      name: id,
      model_id: id,
      display_name: displayName,
      family,
      is_argon: family === 'argon',
      is_carbon: family === 'carbon',
      disabled,
      model_or_alias: modelOrAlias,
      ...(isInternal ? { is_internal: true } : {}),
      ...(modelProvider ? { model_provider: modelProvider } : {}),
      ...(deprecated ? { deprecated: true } : {}),
      ...(inModelSelector !== undefined ? { in_model_selector: inModelSelector } : {}),
      ...(quotaBucketName ? { quota_bucket_name: quotaBucketName } : {}),
      own_percentage: fraction === null ? null : Math.round(fraction * 100),
      own_percentage_known: fraction !== null,
      own_reset_time: normalizeResetTime(quotaInfo?.resetTime ?? quotaInfo?.reset_time),
      own_observed_at: observedAt,
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
      supports_images: cfg.supportsImages ?? cfg.supports_images,
      supports_thinking: cfg.supportsThinking ?? cfg.supports_thinking,
      thinking_budget: numOrNull(cfg.thinkingBudget ?? cfg.thinking_budget) ?? undefined,
      recommended: cfg.isRecommended === true || cfg.recommended === true,
      max_tokens: numOrNull(cfg.maxTokens ?? cfg.max_tokens) ?? undefined,
      max_output_tokens: numOrNull(cfg.maxOutputTokens ?? cfg.max_output_tokens) ?? undefined,
      supported_mime_types: cfg.supportedMimeTypes ?? cfg.supported_mime_types,
    });
  }
  return models;
}

// ---------------------------------------------------------------------------
// 分组 / 桶（retrieveUserQuotaSummary）
// ---------------------------------------------------------------------------

function normalizeBuckets(rawBuckets: any, observedAt: number, source: QuotaSource): NormalizedBucket[] {
  const buckets: NormalizedBucket[] = [];
  for (const raw of Array.isArray(rawBuckets) ? rawBuckets : []) {
    if (!raw || typeof raw !== 'object') continue;
    const bucketId = String(raw.bucketId ?? raw.bucket_id ?? '');
    const window = classifyWindow(raw.window, bucketId, raw.displayName ?? raw.display_name);
    const fraction = normalizeFraction(raw.remainingFraction ?? raw.remaining_fraction);
    const explicitKnown = raw.remaining_fraction_known ?? raw.remainingFractionKnown;
    const known = explicitKnown === false ? false : fraction !== null;
    const disabled = raw.disabled === true || raw.isDisabled === true;
    buckets.push({
      bucket_id: bucketId,
      window,
      raw_window: String(raw.window ?? ''),
      remaining_fraction: known ? fraction : null,
      remaining_fraction_known: known,
      percentage: known && fraction !== null ? Math.round(fraction * 100) : null,
      reset_time: normalizeResetTime(raw.resetTime ?? raw.reset_time),
      display_name: typeof (raw.displayName ?? raw.display_name) === 'string' ? String(raw.displayName ?? raw.display_name) : undefined,
      description: typeof raw.description === 'string' ? raw.description : undefined,
      ...(disabled ? { disabled: true } : {}),
      observed_at: numOrNull(raw.observedAt ?? raw.observed_at ?? raw.last_updated) ?? observedAt,
      stale: raw.stale === true,
      source: (raw.source === 'carried' || raw.source === 'live' || raw.source === 'cloud') ? raw.source : source,
    });
  }
  return buckets;
}

function normalizeGroupEntries(rawGroups: any, observedAt: number, source: QuotaSource): NormalizedGroup[] {
  const groups: NormalizedGroup[] = [];
  for (const raw of Array.isArray(rawGroups) ? rawGroups : []) {
    if (!raw || typeof raw !== 'object') continue;
    const rawGroupId = raw.groupId ?? raw.group_id ?? raw.id;
    const groupId = typeof rawGroupId === 'string' && rawGroupId.trim() ? rawGroupId.trim() : undefined;
    const displayName = String(raw.displayName ?? raw.display_name ?? '');
    if (!displayName && !Array.isArray(raw.buckets)) continue;
    const description = typeof raw.description === 'string' ? raw.description : undefined;
    const declaredFamily = raw.family === 'gemini' || raw.family === 'claude' || raw.family === 'argon' || raw.family === 'carbon' || raw.family === 'other' ? raw.family as Family : null;
    const family = declaredFamily ?? classifyFamily({ groupName: displayName, description, bucketId: (raw.buckets ?? [])[0]?.bucketId ?? (raw.buckets ?? [])[0]?.bucket_id });
    const groupObserved = numOrNull(raw.observedAt ?? raw.observed_at ?? raw.last_updated) ?? observedAt;
    const buckets = normalizeBuckets(raw.buckets, groupObserved, source);
    groups.push({
      ...(groupId ? { group_id: groupId } : {}),
      display_name: displayName,
      description,
      family,
      observed_at: groupObserved,
      buckets,
      stale: raw.stale === true || (buckets.length > 0 && buckets.every(bucket => bucket.stale)),
      source: (raw.source === 'carried' || raw.source === 'live' || raw.source === 'cloud') ? raw.source : source,
    });
  }
  return groups;
}

export function normalizeCloudGroups(payload: any, observedAt: number): NormalizedGroup[] {
  return normalizeGroupEntries(payload?.groups ?? payload?.response?.groups ?? [], observedAt, 'cloud');
}

export function normalizeLiveGroups(quotaSummary: any, observedAt: number): NormalizedGroup[] {
  return normalizeGroupEntries(quotaSummary?.groups ?? quotaSummary?.response?.groups ?? [], observedAt, 'live');
}

/** 已持久化/外部同步/legacy snake_case 或 camelCase 分组 → 规范化（可容忍坏组）。 */
export function normalizeStoredGroups(rawGroups: any, observedAt: number, source: QuotaSource = 'cloud'): NormalizedGroup[] {
  return normalizeGroupEntries(rawGroups ?? [], observedAt, source);
}

/**
 * 多端点分组合并（输入按优先级从高到低）。键 = family + window（当 family === 'other' 时按 display_name 区分独立组）；
 * 高优先级有效值不被覆盖，低优先级只补缺项。
 */
export function mergeGroupSets(groupSets: NormalizedGroup[][]): NormalizedGroup[] {
  interface BucketAcc { bucket: NormalizedBucket; priority: number }
  const bucketAcc = new Map<string, BucketAcc>();
  const groupMeta = new Map<string, { groupId?: string; family: Family; name: string; description?: string; priority: number; observedAt: number | null }>();
  const groupOrder: string[] = [];
  groupSets.forEach((groups, priority) => {
    for (const group of groups) {
      const groupKey = group.family === 'other'
        ? `other:${(group.display_name || group.group_id || 'other').toLowerCase()}`
        : group.family;
      if (!groupOrder.includes(groupKey)) groupOrder.push(groupKey);
      const current = groupMeta.get(groupKey);
      if (!current || priority < current.priority) {
        groupMeta.set(groupKey, { groupId: group.group_id, family: group.family, name: group.display_name, description: group.description, priority, observedAt: group.observed_at });
      } else {
        if (!current.description && group.description) current.description = group.description;
        if (!current.groupId && group.group_id) current.groupId = group.group_id;
      }
      for (const bucket of group.buckets) {
        const bucketSubKey = bucket.bucket_id || bucket.window;
        const key = `${groupKey}:${bucketSubKey}`;
        const existing = bucketAcc.get(key);
        const usable = bucket.disabled !== true && (bucket.remaining_fraction_known || bucket.reset_time !== null);
        if (!existing) {
          bucketAcc.set(key, { bucket: { ...bucket }, priority });
          continue;
        }
        // 高优先级优先（input index 0 > 1 > 2）；同优先级取更小/更保守的已知值；低优先级绝不覆盖已 known 的高优先级值。
        if (priority < existing.priority) {
          if (usable) bucketAcc.set(key, { bucket: { ...bucket }, priority });
          continue;
        }
        if (priority > existing.priority) {
          if ((existing.bucket.disabled === true || !existing.bucket.remaining_fraction_known) && usable) {
            bucketAcc.set(key, { bucket: { ...bucket }, priority });
          }
          continue;
        }
        if (existing.bucket.disabled !== true && existing.bucket.remaining_fraction_known && !usable) continue;
        if ((existing.bucket.disabled === true || !existing.bucket.remaining_fraction_known) && usable) {
          bucketAcc.set(key, { bucket: { ...bucket }, priority: existing.priority });
          continue;
        }
        if (
          existing.bucket.disabled !== true &&
          bucket.disabled !== true &&
          existing.bucket.remaining_fraction_known &&
          bucket.remaining_fraction_known &&
          bucket.remaining_fraction !== null &&
          existing.bucket.remaining_fraction !== null &&
          bucket.remaining_fraction < existing.bucket.remaining_fraction
        ) {
          bucketAcc.set(key, { bucket: { ...bucket }, priority: existing.priority });
        }
      }
    }
  });
  const result: NormalizedGroup[] = [];
  for (const groupKey of groupOrder) {
    const meta = groupMeta.get(groupKey);
    const buckets: NormalizedBucket[] = [];
    for (const [key, entry] of bucketAcc) {
      if (!key.startsWith(`${groupKey}:`)) continue;
      buckets.push(entry.bucket);
    }
    if (buckets.length === 0 && !meta) continue;
    buckets.sort((a, b) => windowRank(a.window) - windowRank(b.window) || a.bucket_id.localeCompare(b.bucket_id));
    const observedAt = meta?.observedAt ?? buckets[0]?.observed_at ?? null;
    const source: QuotaSource = buckets[0]?.source ?? 'cloud';
    result.push({
      ...(meta?.groupId ? { group_id: meta.groupId } : {}),
      display_name: meta?.name ?? groupKey,
      description: meta?.description,
      family: meta?.family ?? 'other',
      observed_at: observedAt,
      buckets,
      stale: false,
      source,
    });
  }
  return result;
}

function windowRank(window: WindowKind): number {
  if (window === '5h') return 0;
  if (window === 'daily') return 1;
  if (window === 'weekly') return 2;
  return 3;
}

function isGroupAbsorbedByFreshDescriptions(oldGroup: NormalizedGroup, freshGroups: NormalizedGroup[]): boolean {
  const candidates = new Set<string>();
  for (const raw of [oldGroup.display_name, oldGroup.group_id, oldGroup.family === 'argon' ? 'gemini-4-argon' : oldGroup.family === 'carbon' ? 'gemini-4-carbon' : '']) {
    if (!raw) continue;
    const norm = normalizeGroupMemberKey(raw);
    if (norm) candidates.add(norm);
  }
  if (candidates.size === 0) return false;
  for (const fg of freshGroups) {
    for (const label of extractGroupMemberLabels(fg.description)) {
      const normLabel = normalizeGroupMemberKey(label);
      if (normLabel && candidates.has(normLabel)) return true;
    }
  }
  return false;
}

/**
 * 语义 carryover：fresh 覆盖 previous 中同 family+window；previous 独有核心组（gemini/claude）及其桶以 stale 追加。
 * 当 freshGroups 已返回权威核心组（或新组 description 已吸收该模型）时，不再永久 carryover 已撤销/合并的非核心独立组。
 */
export function mergeGroupsWithPrevious(
  freshGroups: NormalizedGroup[],
  previousGroups: NormalizedGroup[],
  nowMs: number,
): { groups: NormalizedGroup[]; staleGroups: StaleGroup[] } {
  const result = freshGroups.map(group => ({
    ...group,
    buckets: group.buckets.map(bucket => ({ ...bucket, stale: false })),
  }));
  const staleGroups: StaleGroup[] = [];
  const hasFreshCoreGroups = freshGroups.some(g => g.family === 'gemini' || g.family === 'claude');
  for (const oldGroup of previousGroups) {
    const target = result.find(group =>
      group.family === oldGroup.family &&
      (group.family !== 'other'
        || (Boolean(group.group_id && oldGroup.group_id) && group.group_id === oldGroup.group_id)
        || group.display_name.toLowerCase() === oldGroup.display_name.toLowerCase())
    );
    if (!target) {
      if (isOrchestratorMetaModel(oldGroup.group_id, oldGroup.display_name)) continue;
      const isCoreGroup = oldGroup.family === 'gemini' || oldGroup.family === 'claude';
      if (!isCoreGroup && (hasFreshCoreGroups || isGroupAbsorbedByFreshDescriptions(oldGroup, freshGroups))) {
        continue;
      }
      staleGroups.push({ name: oldGroup.display_name, observed_at: oldGroup.observed_at ?? nowMs / 1000 });
      result.push({ ...oldGroup, stale: true, source: 'carried',
        buckets: oldGroup.buckets.map(bucket => ({ ...bucket, stale: true, source: 'carried' as const })) });
      continue;
    }
    for (const oldBucket of oldGroup.buckets) {
      if (oldBucket.disabled === true) continue;
      const exists = target.buckets.some(bucket => bucket.window === oldBucket.window && bucket.bucket_id === oldBucket.bucket_id)
        || target.buckets.some(bucket => bucket.window === oldBucket.window && bucket.window !== 'unspecified');
      if (exists) continue;
      const observedAt = oldBucket.observed_at ?? oldGroup.observed_at ?? Math.floor(nowMs / 1000);
      target.buckets.push({ ...oldBucket, stale: true, source: 'carried', observed_at: observedAt });
      staleGroups.push({ name: `${oldGroup.display_name} · ${oldBucket.bucket_id || oldBucket.window}`.trim(), observed_at: observedAt });
    }
  }
  for (const group of result) {
    group.buckets.sort((a, b) => windowRank(a.window) - windowRank(b.window) || a.bucket_id.localeCompare(b.bucket_id));
  }
  return { groups: result, staleGroups };
}

// ---------------------------------------------------------------------------
// 模型合并 / carryover
// ---------------------------------------------------------------------------

export function mergeModelCatalogues(catalogues: NormalizedModel[][]): NormalizedModel[] {
  const byId = new Map<string, { model: NormalizedModel; priority: number }>();
  const order: string[] = [];
  catalogues.forEach((models, priority) => {
    for (const model of models) {
      const key = (model.model_id || model.name).toLowerCase();
      if (!key) continue;
      const existing = byId.get(key);
      if (!existing) {
        byId.set(key, { model: { ...model }, priority });
        order.push(key);
        continue;
      }
      // 高优先级元数据优先，缺项用低优先级补；own quota 已知值优先。
      const merged = existing.model;
      if (!merged.display_name && model.display_name) merged.display_name = model.display_name;
      if (merged.disabled === null && model.disabled !== null) merged.disabled = model.disabled;
      if (!merged.model_or_alias && model.model_or_alias) merged.model_or_alias = model.model_or_alias;
      if (!merged.quota_bucket_name && model.quota_bucket_name) merged.quota_bucket_name = model.quota_bucket_name;
      if (!merged.model_provider && model.model_provider) merged.model_provider = model.model_provider;
      if (model.is_internal === true) merged.is_internal = true;
      if (model.deprecated === true) merged.deprecated = true;
      if (model.non_chat_specialized === true) merged.non_chat_specialized = true;
      if (merged.in_model_selector === undefined && model.in_model_selector !== undefined) merged.in_model_selector = model.in_model_selector;
      if (merged.max_tokens === undefined && model.max_tokens !== undefined) merged.max_tokens = model.max_tokens;
      if (merged.max_output_tokens === undefined && model.max_output_tokens !== undefined) merged.max_output_tokens = model.max_output_tokens;
      if (!merged.own_percentage_known && model.own_percentage_known) {
        merged.own_percentage = model.own_percentage;
        merged.own_percentage_known = true;
        merged.own_reset_time = model.own_reset_time;
        merged.own_observed_at = model.own_observed_at;
      }
      if (priority < existing.priority) existing.priority = priority;
    }
  });
  return order.map(key => byId.get(key)!.model);
}

export function mergeModelsWithPrevious(
  freshModels: NormalizedModel[],
  previousModels: NormalizedModel[],
): { models: NormalizedModel[]; carriedCount: number } {
  const result = freshModels.map(model => ({ ...model, stale: false }));
  // 本轮返回了有效模型目录时以 freshModels 为权威目录，不再把已下线/改名的历史模型永久 carryover。
  if (result.length > 0) {
    return { models: result, carriedCount: 0 };
  }
  const seen = new Set<string>();
  let carriedCount = 0;
  for (const old of previousModels) {
    if (
      old.is_internal === true
      || old.deprecated === true
      || old.non_chat_specialized === true
      || isOrchestratorMetaModel(old.model_id || old.name, old.display_name)
    ) {
      continue;
    }
    const key = (old.model_id || old.name).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push({
      ...old,
      quota_source: 'carried',
      stale: true,
      own_stale: true,
      percentage: 0,
      percentage_known: false,
      effective_percentage: null,
      effective_known: false,
      reset_time: '',
      own_observed_at: old.own_observed_at ?? null,
    });
    carriedCount++;
  }
  return { models: result, carriedCount };
}

// ---------------------------------------------------------------------------
// family 窗口 / effective / argonStatus / carbonStatus / standaloneModels
// ---------------------------------------------------------------------------

/** Model quota is independent of family periods; never infer a 5h window from its reset time. */
export function familyModelQuotaFromModels(models: NormalizedModel[]): Record<'gemini' | 'claude', WindowStatus | null> {
  const result: Record<'gemini' | 'claude', WindowStatus | null> = { gemini: null, claude: null };
  for (const family of ['gemini', 'claude'] as const) {
    const eligible = models.filter(model => model.family === family
      && !isExcludedFromStandaloneModelPool(model)
      && !(model.quota_bucket_name && classifyFamily({ groupName: model.quota_bucket_name, bucketId: model.quota_bucket_name }) === 'other')
      && model.own_percentage_known && model.own_percentage !== null
      && Number.isFinite(model.own_percentage) && model.own_percentage >= 0 && model.own_percentage <= 100);
    const fresh = eligible.filter(model => !model.own_stale);
    const pool = fresh.length ? fresh : eligible;
    const chosen = [...pool].sort((left, right) => left.own_percentage! - right.own_percentage!
      || (Date.parse(left.own_reset_time ?? '') || Infinity) - (Date.parse(right.own_reset_time ?? '') || Infinity)
      || left.name.localeCompare(right.name))[0];
    if (chosen) result[family] = {
      remaining: chosen.own_percentage! / 100, known: true, stale: chosen.own_stale,
      resetTime: chosen.own_reset_time, observedAt: chosen.own_observed_at, source: chosen.quota_source,
    };
  }
  return result;
}

export function resolveQuotaStaleSeconds(quotaRefreshMinutes?: number | null): number {
  const mins = typeof quotaRefreshMinutes === 'number' && Number.isFinite(quotaRefreshMinutes) ? Math.floor(quotaRefreshMinutes) : 0;
  return mins > 15 ? mins * 60 + 120 : 900;
}

export function isGroupAllDisabled(group: NormalizedGroup): boolean {
  return group.buckets.length > 0 && group.buckets.every(bucket => bucket.disabled === true);
}

/**
 * 从一个或多个官方 QuotaSummaryGroup 中提取全部非禁用窗口（保留 5h / daily / weekly / unspecified 及 resetTime）。
 */
export function extractGroupWindows(
  groupOrGroups: NormalizedGroup | NormalizedGroup[],
  nowMs: number,
  staleAfterSeconds: number = 900,
): GroupWindowEntry[] {
  const threshold = Number.isFinite(staleAfterSeconds) && staleAfterSeconds > 0 ? staleAfterSeconds : 900;
  const groups = Array.isArray(groupOrGroups) ? groupOrGroups : [groupOrGroups];
  const activeBuckets = groups
    .flatMap(group => group.buckets)
    .filter(bucket => bucket.disabled !== true)
    .map(bucket => ({
      ...bucket,
      stale: bucket.stale
        || (bucket.observed_at !== null && nowMs / 1000 - bucket.observed_at > threshold)
        || (bucket.reset_time !== null && Date.parse(bucket.reset_time) <= nowMs),
    }));

  const collapseBucketPool = (candidates: typeof activeBuckets): WindowStatus => {
    const fresh = candidates.filter(bucket => !bucket.stale && bucket.remaining_fraction_known);
    const pool = fresh.length > 0 ? fresh : candidates.filter(bucket => bucket.remaining_fraction_known);
    if (pool.length === 0) {
      const any = candidates[0]!;
      return {
        remaining: null,
        known: false,
        stale: candidates.every(bucket => bucket.stale),
        resetTime: any.reset_time,
        observedAt: any.observed_at,
        source: any.source,
      };
    }
    const chosen = pool.reduce((left, right) => (left.remaining_fraction! <= right.remaining_fraction! ? left : right));
    return {
      remaining: chosen.remaining_fraction,
      known: true,
      stale: chosen.stale,
      resetTime: chosen.reset_time,
      observedAt: chosen.observed_at,
      source: chosen.source,
    };
  };

  const entries: GroupWindowEntry[] = [];
  for (const period of ['5h', 'daily', 'weekly'] as const) {
    const candidates = activeBuckets.filter(bucket => bucket.window === period);
    if (candidates.length === 0) continue;
    entries.push({ id: period, period, status: collapseBucketPool(candidates) });
  }

  const unspecByKey = new Map<string, typeof activeBuckets>();
  for (const bucket of activeBuckets) {
    if (bucket.window !== 'unspecified') continue;
    const key = bucket.bucket_id || 'model';
    const existing = unspecByKey.get(key);
    if (existing) existing.push(bucket);
    else unspecByKey.set(key, [bucket]);
  }
  for (const [key, candidates] of unspecByKey.entries()) {
    entries.push({ id: key, period: 'unspecified', status: collapseBucketPool(candidates) });
  }

  entries.sort((a, b) => windowRank(a.period) - windowRank(b.period) || a.id.localeCompare(b.id));
  return entries;
}

export function familyWindowsFromGroups(
  groups: NormalizedGroup[],
  nowMs: number,
  staleAfterSeconds: number = 900,
): FamilyWindows {
  const threshold = Number.isFinite(staleAfterSeconds) && staleAfterSeconds > 0 ? staleAfterSeconds : 900;
  const windows: FamilyWindows = {
    gemini: { fiveHour: null, weekly: null },
    claude: { fiveHour: null, weekly: null },
    argon: { fiveHour: null, weekly: null },
    carbon: { fiveHour: null, weekly: null },
  };
  for (const family of ['gemini', 'claude', 'argon', 'carbon'] as const) {
    for (const window of ['5h', 'daily', 'weekly'] as const) {
      const candidates = groups
        .filter(group => group.family === family)
        .flatMap(group => group.buckets.filter(bucket => bucket.disabled !== true && bucket.window === window))
        .map(bucket => ({ ...bucket, stale: bucket.stale ||
          (bucket.observed_at !== null && nowMs / 1000 - bucket.observed_at > threshold) ||
          (bucket.reset_time !== null && Date.parse(bucket.reset_time) <= nowMs) }));
      if (candidates.length === 0) continue;
      // 新鲜优先；同 window 多桶取更保守（remaining 更小）的已知值。
      const fresh = candidates.filter(bucket => !bucket.stale && bucket.remaining_fraction_known);
      const pool = fresh.length > 0 ? fresh : candidates.filter(bucket => bucket.remaining_fraction_known);
      const targetKey = window === '5h' ? 'fiveHour' : window === 'daily' ? 'daily' : 'weekly';
      if (pool.length === 0) {
        const any = candidates[0]!;
        windows[family][targetKey] = {
          remaining: null,
          known: false,
          stale: candidates.every(bucket => bucket.stale),
          resetTime: any.reset_time,
          observedAt: any.observed_at,
          source: any.source,
        };
        continue;
      }
      const chosen = pool.reduce((left, right) => (left.remaining_fraction! <= right.remaining_fraction! ? left : right));
      windows[family][targetKey] = {
        remaining: chosen.remaining_fraction,
        known: true,
        stale: chosen.stale,
        resetTime: chosen.reset_time,
        observedAt: chosen.observed_at,
        source: chosen.source,
      };
    }
  }
  return windows;
}

function mergeWindowStatus(left: WindowStatus | null, right: WindowStatus | null): WindowStatus | null {
  if (!left) return right;
  if (!right) return left;
  if (left.stale !== right.stale) return left.stale ? right : left;
  if (left.known && !right.known) return left;
  if (!left.known && right.known) return right;
  if (left.known && right.known) {
    return left.remaining !== null && right.remaining !== null && right.remaining < left.remaining ? right : left;
  }
  return left;
}

/** 把 family 窗口写入模型：effective = min(own known fresh, family 已知 fresh 窗口)；legacy 字段=effective。 */
export function applyFamilyWindows(models: NormalizedModel[], windows: FamilyWindows): NormalizedModel[] {
  return models.map(model => {
    const hasNonCoreExplicitBucket = Boolean(
      model.quota_bucket_name
      && classifyFamily({ groupName: model.quota_bucket_name, bucketId: model.quota_bucket_name }) === 'other'
    );
    const family = model.family === 'other' || hasNonCoreExplicitBucket ? null : model.family;
    const familyWindowSet = family ? windows[family] : null;
    const family5h = familyWindowSet ? familyWindowSet.fiveHour : null;
    const familyDaily = familyWindowSet?.daily ?? null;
    const familyWeekly = familyWindowSet ? familyWindowSet.weekly : null;
    const freshWindows = [family5h, familyDaily, familyWeekly].filter((status): status is WindowStatus => !!status && status.known && !status.stale);
    const usable: number[] = [];
    if (!model.disabled && model.own_percentage_known && !model.own_stale && model.own_percentage !== null) usable.push(model.own_percentage / 100);
    if (!model.disabled) for (const status of freshWindows) if (status.remaining !== null) usable.push(status.remaining);
    const effective = usable.length > 0 ? Math.min(...usable) : null;
    let limitingReset: string | null = null;
    let limitingBucket: string | undefined;
    if (effective !== null) {
      if (model.own_percentage_known && !model.own_stale && model.own_percentage !== null && Math.abs(model.own_percentage / 100 - effective) < 1e-9) {
        limitingReset = model.own_reset_time;
        limitingBucket = model.model_id;
      }
      const windowOrder: [WindowStatus | null, string][] = [[family5h, '5h'], [familyDaily, 'daily'], [familyWeekly, 'weekly']];
      for (const [status, name] of windowOrder) {
        if (status?.known && !status.stale && status.remaining !== null && Math.abs(status.remaining - effective) < 1e-9) {
          limitingReset = status.resetTime ?? limitingReset;
          const familyGroup = `${model.family}-${name}`;
          limitingBucket = limitingBucket ?? familyGroup;
        }
      }
    }
    return {
      ...model,
      family_5h: family5h,
      family_weekly: familyWeekly,
      effective_percentage: effective === null ? null : Math.round(effective * 100),
      effective_known: effective !== null,
      percentage: effective === null ? 0 : Math.round(effective * 100),
      percentage_known: effective !== null,
      reset_time: effective === null ? '' : (limitingReset ?? ''),
      quota_bucket_id: effective === null ? model.model_id : (limitingBucket ?? model.model_id),
    };
  });
}

function formatStandaloneKnownMessage(period: ArgonPeriod, shortLabel: string, pct: number): string {
  if (period === 'weekly') return bt('quota.standalone.weekly_known', { shortLabel, pct });
  if (period === '5h') return bt('quota.standalone.5h_known', { shortLabel, pct });
  if (period === 'daily') return bt('quota.standalone.daily_known', { shortLabel, pct });
  return bt('quota.standalone.unspecified_known', { shortLabel, pct });
}

function buildStandaloneFamilyStatus(
  familyModels: NormalizedModel[],
  familyWindowPair: { fiveHour: WindowStatus | null; weekly: WindowStatus | null },
  nowMs: number,
  options: {
    shortLabel: string;
    fullLabel: string;
    inferredDisabled?: boolean;
    allWindows?: GroupWindowEntry[];
  },
): ArgonStatus {
  const eligibleModels = familyModels.filter(model => model.disabled !== true && !model.stale);
  const ownModels = familyModels.filter(model => model.disabled !== true && model.own_percentage_known && model.own_percentage !== null);
  const freshOwn = ownModels.filter(model => !model.own_stale);
  const enabledModel = (freshOwn.length ? freshOwn : ownModels).reduce<NormalizedModel | undefined>(
    (best, model) => !best || model.own_percentage! < best.own_percentage! ? model : best, undefined);

  const windowEntries: Array<{ period: WindowKind; status: WindowStatus }> = options.allWindows
    ? options.allWindows.map(entry => ({ period: entry.period, status: entry.status }))
    : ([
      ...(familyWindowPair.weekly ? [{ period: 'weekly' as const, status: familyWindowPair.weekly }] : []),
      ...(familyWindowPair.fiveHour ? [{ period: '5h' as const, status: familyWindowPair.fiveHour }] : []),
    ]);

  const hasKnownBucket = windowEntries.some(entry => entry.status.known && !entry.status.stale);

  const availability: Availability = (eligibleModels.some(model => model.disabled === false ||
    (model.own_percentage_known && !model.own_stale)) || hasKnownBucket) ? 'available'
    : (familyModels.length > 0 && familyModels.every(model => model.disabled === true && !model.stale)) || (familyModels.length === 0 && options.inferredDisabled === true)
      ? 'disabled'
      : 'unknown';

  let period: ArgonPeriod = null;
  let remaining: number | null = null;
  let stale = false;
  let observedAt: number | null = null;
  let source: QuotaSource | undefined;
  const knownWindows = windowEntries.filter(entry => entry.status.known && entry.status.remaining !== null);
  const freshKnown = knownWindows.filter(entry => !entry.status.stale);
  const selected = (freshKnown.length ? freshKnown : knownWindows).reduce<typeof knownWindows[number] | null>(
    (best, entry) => !best || (entry.status.remaining ?? 1) < (best.status.remaining ?? 1) ? entry : best, null);
  let selectedReset: string | null = null;
  if (selected) {
    period = selected.period;
    remaining = selected.status.remaining;
    stale = selected.status.stale;
    observedAt = selected.status.observedAt;
    source = selected.status.source;
    selectedReset = selected.status.resetTime;
  } else if (windowEntries.length > 0) {
    const first = windowEntries[0]!;
    period = first.period;
    observedAt = first.status.observedAt;
    source = first.status.source;
    stale = first.status.stale;
  }
  if (enabledModel?.own_percentage_known && enabledModel.own_percentage !== null &&
    ((!enabledModel.own_stale && (remaining === null || stale || enabledModel.own_percentage < Math.round(remaining * 100))) ||
      (remaining === null && enabledModel.own_stale))) {
    period = 'unspecified';
    remaining = enabledModel.own_percentage / 100;
    observedAt = enabledModel.own_observed_at;
    source = enabledModel.quota_source;
    stale = enabledModel.own_stale;
    selectedReset = enabledModel.own_reset_time;
  }
  const quotaState: QuotaState = remaining !== null ? (stale ? 'stale' : 'known') : (stale ? 'stale' : 'not_reported');
  const resetSource = selectedReset ?? (remaining === null ? windowEntries[0]?.status.resetTime ?? null : null);
  const resetCountdown = resetSource ? formatCountdown(resetSource, nowMs) : '';

  const { shortLabel, fullLabel } = options;
  let message: string;
  if (availability === 'disabled') {
    message = bt('quota.standalone.backend_no_permission', { fullLabel });
  } else if (availability === 'unknown') {
    message = familyModels.length ? bt('quota.standalone.listed_unknown', { shortLabel })
      : bt('quota.standalone.not_reported', { shortLabel });
  } else if (quotaState === 'known') {
    const pct = Math.round((remaining ?? 0) * 100);
    message = formatStandaloneKnownMessage(period, shortLabel, pct);
  } else if (quotaState === 'stale') {
    message = bt('quota.standalone.stale', { shortLabel });
  } else {
    message = bt('quota.standalone.no_value', { shortLabel });
  }
  return {
    availability,
    quotaState,
    period,
    remaining,
    resetCountdown,
    resetTime: resetSource ?? null,
    message,
    observedAt,
    source,
    mode: availability === 'disabled' ? 'disabled' : availability === 'unknown' ? 'unknown' : 'standalone',
    pooledInFamily: null,
  };
}

interface PoolCandidate {
  family: 'gemini' | 'claude';
  period: ArgonPeriod;
  status: WindowStatus;
}

function collectCorePoolCandidates(
  familyWindows: FamilyWindows,
  groups: NormalizedGroup[],
): PoolCandidate[] {
  const candidates: PoolCandidate[] = [];
  for (const family of ['gemini', 'claude'] as const) {
    const fw = familyWindows[family];
    if (fw.fiveHour?.known && fw.fiveHour.remaining !== null) {
      candidates.push({ family, period: '5h', status: fw.fiveHour });
    }
    if (fw.weekly?.known && fw.weekly.remaining !== null) {
      candidates.push({ family, period: 'weekly', status: fw.weekly });
    }
    for (const group of groups) {
      if (group.family !== family) continue;
      for (const bucket of group.buckets) {
        if (bucket.disabled === true) continue;
        if ((bucket.window !== 'unspecified' && bucket.window !== 'daily') || !bucket.remaining_fraction_known || bucket.remaining_fraction === null) continue;
        candidates.push({
          family,
          period: bucket.window,
          status: {
            remaining: bucket.remaining_fraction,
            known: true,
            stale: bucket.stale,
            resetTime: bucket.reset_time,
            observedAt: bucket.observed_at,
            source: bucket.source,
          },
        });
      }
    }
  }
  return candidates;
}

function matchPoolByBucketName(
  quotaBucketName: string | null | undefined,
  groups: NormalizedGroup[],
): 'gemini' | 'claude' | null {
  if (!quotaBucketName) return null;
  const norm = quotaBucketName.trim().toLowerCase();
  if (!norm) return null;
  for (const group of groups) {
    if (group.family !== 'gemini' && group.family !== 'claude') continue;
    if (group.display_name.toLowerCase() === norm || (group.group_id ?? '').toLowerCase() === norm) return group.family;
    if (group.buckets.some(b => b.bucket_id.toLowerCase() === norm || (b.display_name ?? '').toLowerCase() === norm)) {
      return group.family;
    }
  }
  const bucketFamily = classifyFamily({ groupName: quotaBucketName, bucketId: quotaBucketName });
  if (bucketFamily === 'argon' || bucketFamily === 'carbon' || bucketFamily === 'other') return null;
  if (/claude|anthropic|openai|gpt|grok|xai|deepseek|mistral|llama|third[_-]?party|3p\b|\bo[1-9]\d*(?:$|[-_\s]|-(?:mini|pro|preview|high|low|medium))\b/i.test(norm)) return 'claude';
  if (/gemini|google/i.test(norm)) return 'gemini';
  return null;
}

function resetTimesMatch(left: string | null, right: string | null, allowMissingOnUltra: boolean): boolean {
  if (!left && !right) return true;
  if (!left || !right) return allowMissingOnUltra;
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (Number.isNaN(leftMs) || Number.isNaN(rightMs)) return left === right;
  return Math.abs(leftMs - rightMs) <= 60_000;
}

function isGeminiBrandModel(model: NormalizedModel): boolean {
  if (model.family === 'argon' || model.family === 'carbon' || model.family === 'gemini') return true;
  if (typeof model.model_provider === 'string' && /google|gemini/i.test(model.model_provider)) return true;
  const text = `${model.model_id} ${model.name} ${model.display_name ?? ''} ${model.model_or_alias ?? ''}`.toLowerCase();
  return /\bgemini\b|\bargon\b|\bcarbon\b|\bhydrogen\b/.test(text);
}

function pickBestPoolCandidateForFamily(
  family: 'gemini' | 'claude',
  candidates: PoolCandidate[],
  fallbackModel: NormalizedModel,
): PoolCandidate {
  const familyCandidates = candidates.filter(c => c.family === family);
  const fresh = familyCandidates.find(c => c.status.known && !c.status.stale);
  if (fresh) return fresh;
  if (familyCandidates.length > 0) return familyCandidates[0]!;
  return {
    family,
    period: 'unspecified',
    status: {
      remaining: fallbackModel.own_percentage !== null ? fallbackModel.own_percentage / 100 : null,
      known: fallbackModel.own_percentage_known,
      stale: fallbackModel.own_stale,
      resetTime: fallbackModel.own_reset_time,
      observedAt: fallbackModel.own_observed_at,
      source: fallbackModel.quota_source,
    },
  };
}

function pickBestGeminiPoolCandidate(candidates: PoolCandidate[], fallbackModel: NormalizedModel): PoolCandidate {
  return pickBestPoolCandidateForFamily('gemini', candidates, fallbackModel);
}

export function matchModelToSharedPool(
  model: NormalizedModel,
  familyWindows: FamilyWindows,
  groups: NormalizedGroup[] = [],
  subscriptionTier?: string | null,
  allModels: NormalizedModel[] = [],
): PoolCandidate | null {
  if (model.disabled === true) return null;
  if (model.family === 'argon' || model.family === 'carbon') {
    const familyWindowPair = familyWindows[model.family];
    const hasDedicatedGroup = groups.some(g => g.family === model.family && !isGroupAllDisabled(g))
      || Boolean(familyWindowPair?.fiveHour || familyWindowPair?.weekly);
    if (hasDedicatedGroup) return null;
  }

  const isUltra = typeof subscriptionTier === 'string' && /\bultra\b/i.test(subscriptionTier);
  const candidates = collectCorePoolCandidates(familyWindows, groups);
  const hasGeminiGroup = groups.some(g => g.family === 'gemini') || candidates.some(c => c.family === 'gemini');

  const rawBucketName = typeof model.quota_bucket_name === 'string' ? model.quota_bucket_name.trim() : '';
  if (rawBucketName) {
    const bucketFamily = matchPoolByBucketName(rawBucketName, groups);
    if (!bucketFamily) return null;
    const familyCandidates = candidates.filter(c => c.family === bucketFamily);
    if (familyCandidates.length > 0) {
      const exact = model.own_percentage_known && model.own_percentage !== null
        ? familyCandidates.find(c =>
            Math.abs(Math.round(c.status.remaining! * 100) - Math.round(model.own_percentage!)) <= 1
            && resetTimesMatch(c.status.resetTime, model.own_reset_time, true))
        : null;
      return exact ?? familyCandidates.find(c => c.status.known && !c.status.stale) ?? familyCandidates[0]!;
    }
    if (isUltra && hasGeminiGroup && bucketFamily === 'gemini') {
      return pickBestGeminiPoolCandidate(candidates, model);
    }
    return null;
  }

  // 上游权威信号：官方 QuotaSummaryGroup.description 明确列明该模型归属核心共享池。
  const describedGroup = findGroupForModelByDescription(model, groups);
  if (describedGroup && (describedGroup.family === 'gemini' || describedGroup.family === 'claude')) {
    return pickBestPoolCandidateForFamily(describedGroup.family, candidates, model);
  }

  const geminiBrand = isGeminiBrandModel(model);
  const allowedCandidates = geminiBrand ? candidates.filter(c => c.family === 'gemini') : candidates;

  if (model.own_percentage_known && model.own_percentage !== null) {
    const modelPct = Math.round(model.own_percentage);
    const matched = allowedCandidates.find(c => {
      const candPct = Math.round(c.status.remaining! * 100);
      if (Math.abs(candPct - modelPct) > 1) return false;
      if (!isUltra && model.family === 'other' && !c.status.resetTime && !model.own_reset_time) return false;
      if (resetTimesMatch(c.status.resetTime, model.own_reset_time, isUltra)) return true;
      if (isUltra && (model.family === 'argon' || model.family === 'carbon')
        && modelPct === 100 && candPct === 100
        && c.status.resetTime && model.own_reset_time) {
        const leftMs = Date.parse(c.status.resetTime);
        const rightMs = Date.parse(model.own_reset_time);
        return !Number.isNaN(leftMs) && !Number.isNaN(rightMs) && Math.abs(leftMs - rightMs) <= 15 * 60_000;
      }
      return false;
    });
    if (matched) return matched;
  }

  const coSampledCoreGeminiPeers = (hasGeminiGroup && geminiBrand)
    ? allModels.filter(peer =>
        peer.family === 'gemini'
        && !isExcludedFromStandaloneModelPool(peer)
        && !peer.stale
        && peer.quota_source === model.quota_source
        && peer.own_percentage_known
        && peer.own_percentage !== null
        && (peer.own_observed_at === null || model.own_observed_at === null || Math.abs(peer.own_observed_at - model.own_observed_at) <= 60))
    : [];

  if (hasGeminiGroup && geminiBrand && model.own_percentage_known && model.own_percentage !== null && coSampledCoreGeminiPeers.length > 0) {
    const modelPct = Math.round(model.own_percentage);
    const matchesPeer = coSampledCoreGeminiPeers.some(peer =>
      Math.abs(Math.round(peer.own_percentage!) - modelPct) <= 1
      && (isUltra || model.family !== 'other' || Boolean(peer.own_reset_time || model.own_reset_time))
      && resetTimesMatch(peer.own_reset_time, model.own_reset_time, isUltra));
    if (matchesPeer) {
      return pickBestGeminiPoolCandidate(allowedCandidates, model);
    }
  }

  // Ultra 兼容共享池兜底：仅在无显式独立桶名（rawBucketName 已在上方早退）、无官方独立分组且无同采样核心对照冲突时，
  // 将 Ultra 下缺少独立证据的 Argon/Carbon 归并至 Gemini 共享池，避免误吞并真实独立桶或破坏 Ultra 共享池契约。
  const hasOfficialStandaloneGroup = groups.some(g => g.family === model.family && !isGroupAllDisabled(g));
  if (
    isUltra
    && hasGeminiGroup
    && !rawBucketName
    && !hasOfficialStandaloneGroup
    && (model.family === 'argon' || model.family === 'carbon')
  ) {
    if (!model.own_percentage_known || model.own_percentage === null || coSampledCoreGeminiPeers.length === 0) {
      return pickBestGeminiPoolCandidate(allowedCandidates, model);
    }
  }

  return null;
}

export function resolveStandaloneFamilyStatus(
  family: 'argon' | 'carbon',
  models: NormalizedModel[],
  groups: NormalizedGroup[],
  familyWindows: FamilyWindows,
  nowMs: number,
  options: { shortLabel: string; fullLabel: string; subscriptionTier?: string | null; staleAfterSeconds?: number },
): ArgonStatus {
  const familyModels = models.filter(model =>
    (family === 'argon' ? (model.is_argon || model.family === 'argon') : (model.is_carbon || model.family === 'carbon'))
    && model.is_internal !== true
    && model.deprecated !== true
    && model.non_chat_specialized !== true
    && !isOrchestratorMetaModel(model.model_id || model.name, model.display_name));
  const familyWindowPair = family === 'argon' ? familyWindows.argon : (familyWindows.carbon ?? { fiveHour: null, weekly: null });
  const familyGroups = groups.filter(g => g.family === family);
  if (familyGroups.length > 0 && familyGroups.every(isGroupAllDisabled)) {
    const status = buildStandaloneFamilyStatus(familyModels, { fiveHour: null, weekly: null }, nowMs, {
      shortLabel: options.shortLabel,
      fullLabel: options.fullLabel,
      inferredDisabled: true,
    });
    return { ...status, mode: 'disabled', pooledInFamily: null };
  }
  const activeFamilyGroups = familyGroups.filter(g => !isGroupAllDisabled(g));
  const hasDedicatedGroup = activeFamilyGroups.length > 0
    || Boolean(familyWindowPair.fiveHour || familyWindowPair.weekly);

  if (hasDedicatedGroup) {
    const allWindows = activeFamilyGroups.length > 0
      ? extractGroupWindows(activeFamilyGroups, nowMs, options.staleAfterSeconds ?? 900)
      : undefined;
    const status = buildStandaloneFamilyStatus(familyModels, familyWindowPair, nowMs, {
      shortLabel: options.shortLabel,
      fullLabel: options.fullLabel,
      allWindows: allWindows && allWindows.length > 0 ? allWindows : undefined,
    });
    return { ...status, mode: 'standalone', pooledInFamily: null };
  }

  const nonStaleModels = familyModels.filter(m => !m.stale);
  if (nonStaleModels.length > 0 && nonStaleModels.every(m => m.disabled === true)) {
    const status = buildStandaloneFamilyStatus(familyModels, familyWindowPair, nowMs, {
      shortLabel: options.shortLabel,
      fullLabel: options.fullLabel,
      inferredDisabled: true,
    });
    return { ...status, mode: 'disabled', pooledInFamily: null };
  }

  const enabledModels = nonStaleModels.filter(m => m.disabled !== true);
  if (enabledModels.length > 0) {
    const poolMatches = enabledModels.map(m => matchModelToSharedPool(m, familyWindows, groups, options.subscriptionTier, models));
    if (poolMatches.every((match): match is PoolCandidate => match !== null)) {
      const targetFamily = poolMatches[0]!.family;
      const sameFamilyMatches = poolMatches.filter(m => m.family === targetFamily);
      const chosen = sameFamilyMatches.find(m => m.status.known && !m.status.stale) ?? sameFamilyMatches[0]!;
      const resetCountdown = chosen.status.resetTime ? formatCountdown(chosen.status.resetTime, nowMs) : '';
      const quotaState: QuotaState = chosen.status.known && chosen.status.remaining !== null
        ? (chosen.status.stale ? 'stale' : 'known')
        : (chosen.status.stale ? 'stale' : 'not_reported');
      const pct = Math.round((chosen.status.remaining ?? 0) * 100);
      const message = quotaState === 'known'
        ? formatStandaloneKnownMessage(chosen.period, options.shortLabel, pct)
        : bt('quota.standalone.no_value', { shortLabel: options.shortLabel });
      return {
        availability: 'available',
        quotaState,
        period: chosen.period,
        remaining: chosen.status.remaining,
        resetCountdown,
        resetTime: chosen.status.resetTime ?? null,
        message,
        observedAt: chosen.status.observedAt,
        source: chosen.status.source,
        mode: 'unified',
        pooledInFamily: targetFamily,
      };
    }
  }

  const status = buildStandaloneFamilyStatus(familyModels, familyWindowPair, nowMs, {
    shortLabel: options.shortLabel,
    fullLabel: options.fullLabel,
  });
  const mode: StandaloneMode = status.availability === 'disabled'
    ? 'disabled'
    : (status.availability === 'available' || status.quotaState === 'stale')
      ? 'standalone'
      : 'unknown';
  return { ...status, mode, pooledInFamily: null };
}

export function buildArgonStatus(
  models: NormalizedModel[],
  groups: NormalizedGroup[],
  familyWindows: FamilyWindows,
  nowMs: number,
  subscriptionTier?: string | null,
  staleAfterSeconds?: number,
): ArgonStatus {
  return resolveStandaloneFamilyStatus('argon', models, groups, familyWindows, nowMs, {
    shortLabel: 'Argon',
    fullLabel: 'Gemini 4 Argon',
    subscriptionTier,
    staleAfterSeconds,
  });
}

export function buildCarbonStatus(
  models: NormalizedModel[],
  groups: NormalizedGroup[],
  familyWindows: FamilyWindows,
  nowMs: number,
  _argonStatus?: ArgonStatus,
  subscriptionTier?: string | null,
  staleAfterSeconds?: number,
): ArgonStatus {
  return resolveStandaloneFamilyStatus('carbon', models, groups, familyWindows, nowMs, {
    shortLabel: 'Carbon',
    fullLabel: 'Gemini 4 Carbon',
    subscriptionTier,
    staleAfterSeconds,
  });
}

function autoPrettyModelTitle(rawIdOrName: string): string {
  const trimmed = rawIdOrName.trim();
  const geminiMatch = trimmed.match(/^gemini[\s_-]*([4-9](?:\.\d+)?)[\s_-]+([a-z][a-z0-9]*?)(?:[\s_-]+(trial|preview|exp))?$/i);
  if (geminiMatch) {
    const ver = geminiMatch[1]!;
    const code = geminiMatch[2]!.charAt(0).toUpperCase() + geminiMatch[2]!.slice(1).toLowerCase();
    return `Gemini ${ver} ${code}`;
  }
  return trimmed;
}

export function normalizeBaseModelKey(rawId: string): string {
  let baseKey = rawId.trim().toLowerCase();
  while (/-(?:extra-high|extra-low|low|medium|high|xhigh|extra|minimal|max|thinking|trial|preview|exp|disabled|tiered|latest)$/i.test(baseKey)) {
    baseKey = baseKey.replace(/-(?:extra-high|extra-low|low|medium|high|xhigh|extra|minimal|max|thinking|trial|preview|exp|disabled|tiered|latest)$/i, '');
  }
  return baseKey
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * 构建所有独立配额池列表（以官方 RetrieveUserQuotaSummary.groups[] 为单一事实来源）：
 * - 官方非核心配额分组（argon / carbon / 任意未知 'other' 分组）自动映射为独立配额池并保留全部非禁用窗口；
 * - 存在权威 groups[] 时，不从孤立/陈旧/内部/编排器模型凭空捏造独立池（仅接受带显式非核心 quota_bucket_name 的新鲜用户模型）；
 * - groups[] 为空时保留历史降级兼容，同时严格排除编排器、内部、已废弃、非对话专用及陈旧僵尸模型。
 */
export function buildStandaloneModels(
  models: NormalizedModel[],
  groups: NormalizedGroup[],
  familyWindows: FamilyWindows,
  nowMs: number,
  argonStatus?: ArgonStatus,
  carbonStatus?: ArgonStatus,
  subscriptionTier?: string | null,
  staleAfterSeconds: number = 900,
): StandaloneModelStatus[] {
  const resolvedArgon = argonStatus ?? buildArgonStatus(models, groups, familyWindows, nowMs, subscriptionTier, staleAfterSeconds);
  const resolvedCarbon = carbonStatus ?? buildCarbonStatus(models, groups, familyWindows, nowMs, resolvedArgon, subscriptionTier, staleAfterSeconds);

  const list: StandaloneModelStatus[] = [];
  const hasAuthoritativeGroups = groups.length > 0;
  const activeGroupForFamily = (family: 'argon' | 'carbon'): NormalizedGroup | undefined =>
    groups.find(g => g.family === family && !isGroupAllDisabled(g));
  const hasFreshModelForFamily = (family: 'argon' | 'carbon'): boolean =>
    models.some(m =>
      (family === 'argon' ? (m.is_argon || m.family === 'argon') : (m.is_carbon || m.family === 'carbon'))
      && !isExcludedFromStandaloneModelPool(m)
      && !m.stale && m.quota_source !== 'carried');

  if (resolvedArgon.mode === 'standalone') {
    const argonGroup = activeGroupForFamily('argon');
    if (argonGroup || !hasAuthoritativeGroups || hasFreshModelForFamily('argon')) {
      const argonWindows = argonGroup ? extractGroupWindows(argonGroup, nowMs, staleAfterSeconds) : undefined;
      list.push({
        key: 'argon',
        displayName: argonGroup?.display_name ? autoPrettyModelTitle(argonGroup.display_name) : 'Gemini 4 Argon',
        ...(argonGroup?.description ? { description: argonGroup.description } : {}),
        ...(argonWindows && argonWindows.length > 0 ? { windows: argonWindows } : {}),
        ...(argonGroup ? { fromOfficialGroup: true, ...(argonGroup.group_id ? { groupId: argonGroup.group_id } : {}) } : {}),
        ...resolvedArgon,
      });
    }
  }
  if (resolvedCarbon.mode === 'standalone') {
    const carbonGroup = activeGroupForFamily('carbon');
    if (carbonGroup || !hasAuthoritativeGroups || hasFreshModelForFamily('carbon')) {
      const carbonWindows = carbonGroup ? extractGroupWindows(carbonGroup, nowMs, staleAfterSeconds) : undefined;
      list.push({
        key: 'carbon',
        displayName: carbonGroup?.display_name ? autoPrettyModelTitle(carbonGroup.display_name) : 'Gemini 4 Carbon',
        ...(carbonGroup?.description ? { description: carbonGroup.description } : {}),
        ...(carbonWindows && carbonWindows.length > 0 ? { windows: carbonWindows } : {}),
        ...(carbonGroup ? { fromOfficialGroup: true, ...(carbonGroup.group_id ? { groupId: carbonGroup.group_id } : {}) } : {}),
        ...resolvedCarbon,
      });
    }
  }

  const seenKeys = new Set<string>(['argon', 'carbon', 'gemini-4-argon', 'gemini-4-carbon']);
  const officialGroupNames = new Set<string>();
  for (const group of groups) {
    if (group.display_name) officialGroupNames.add(group.display_name.trim().toLowerCase());
    if (group.group_id) officialGroupNames.add(group.group_id.trim().toLowerCase());
    for (const bucket of group.buckets) {
      if (bucket.bucket_id) officialGroupNames.add(bucket.bucket_id.trim().toLowerCase());
      if (bucket.display_name) officialGroupNames.add(bucket.display_name.trim().toLowerCase());
    }
  }

  // 1. 官方非核心 QuotaSummaryGroup（family === 'other'）自动投影为独立多窗口配额池
  for (const group of groups) {
    if (group.family !== 'other') continue;
    if (isOrchestratorMetaModel(group.group_id, group.display_name)) continue;
    if (isGroupAllDisabled(group)) continue;
    const rawName = (group.display_name || group.group_id || '')
      .replace(/(?:[\s_-]+(?:weekly|daily|5h|five[\s_-]*hour|limit|quota))+$/i, '')
      .trim();
    if (!rawName) continue;
    const normKey = rawName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!normKey || seenKeys.has(normKey)) continue;
    seenKeys.add(normKey);

    const memberLabels = extractGroupMemberLabels(group.description);
    const memberKeySet = new Set(memberLabels.map(normalizeGroupMemberKey).filter(Boolean));
    for (const mk of memberKeySet) seenKeys.add(mk);

    const allWindows = extractGroupWindows(group, nowMs, staleAfterSeconds);
    const groupWindowPair = {
      fiveHour: allWindows.find(w => w.period === '5h')?.status ?? null,
      weekly: allWindows.find(w => w.period === 'weekly')?.status ?? null,
    };

    const rawNameLower = rawName.toLowerCase();
    const groupDisplayLower = (group.display_name || '').trim().toLowerCase();
    const matchingModels = models.filter(m => {
      if (m.is_internal === true || m.deprecated === true || m.non_chat_specialized === true) return false;
      if (isOrchestratorMetaModel(m.model_id || m.name, m.display_name)) return false;
      if (memberKeySet.size > 0) {
        for (const raw of [m.model_id, m.name, m.display_name]) {
          if (raw && memberKeySet.has(normalizeGroupMemberKey(raw))) return true;
        }
      }
      if (m.quota_bucket_name && (m.quota_bucket_name.trim().toLowerCase() === groupDisplayLower || m.quota_bucket_name.trim().toLowerCase() === rawNameLower)) {
        return true;
      }
      return m.family === 'other' && (
        (m.display_name || '').toLowerCase().includes(rawNameLower)
        || m.model_id.toLowerCase().includes(normKey)
      );
    });
    const hasFreshKnownBucket = allWindows.some(w => w.status.known && !w.status.stale);
    if (matchingModels.length > 0 && matchingModels.every(m => m.disabled === true) && !hasFreshKnownBucket) continue;

    const displayName = autoPrettyModelTitle(rawName);
    const status = buildStandaloneFamilyStatus(matchingModels, groupWindowPair, nowMs, {
      shortLabel: displayName,
      fullLabel: displayName,
      allWindows,
    });
    list.push({
      key: normKey,
      displayName,
      ...(group.description ? { description: group.description } : {}),
      windows: allWindows,
      fromOfficialGroup: true,
      ...(group.group_id ? { groupId: group.group_id } : {}),
      ...status,
    });
  }

  // 2. 模型级回退（严格门禁：有权威 groups[] 时仅接受带显式非核心 quota_bucket_name 的新鲜用户模型）
  const hasFreshModels = models.some(m => !m.stale && m.quota_source !== 'carried');
  const extraByBaseKey = new Map<string, { displayName: string; items: NormalizedModel[] }>();
  for (const model of models) {
    if (model.is_argon || model.family === 'argon' || model.is_carbon || model.family === 'carbon') continue;
    if (isExcludedFromStandaloneModelPool(model)) continue;

    const rawBucket = typeof model.quota_bucket_name === 'string' ? model.quota_bucket_name.trim() : '';
    const hasExplicitNonCoreBucket = Boolean(
      rawBucket
      && matchPoolByBucketName(rawBucket, groups) === null
      && !officialGroupNames.has(rawBucket.toLowerCase())
    );

    if (hasAuthoritativeGroups) {
      // 有权威 groups[] 时绝不从 carried/stale 或无显式非核心 quota_bucket_name 的孤立模型凭空造池。
      if (model.stale || model.own_stale || model.quota_source === 'carried') continue;
      if (!hasExplicitNonCoreBucket) continue;
      if (findGroupForModelByDescription(model, groups) !== null) continue;
    } else {
      // 无 groups[] 时的旧降级路径：只接受 family === 'other' 或带显式非核心 quota_bucket_name 的用户模型，
      // 且存在新鲜模型时绝不把 carried/stale 僵尸模型抬成独立池。
      if (hasFreshModels && (model.stale || model.quota_source === 'carried')) continue;
      if (model.family !== 'other' && !hasExplicitNonCoreBucket) continue;
    }

    const rawId = (model.model_id || model.name || '').trim();
    if (!rawId) continue;
    const baseKey = normalizeBaseModelKey(rawId);
    if (!baseKey || seenKeys.has(baseKey)) continue;
    const displayName = model.display_name
      ? model.display_name
        .replace(/\s*\((?:Extra\s+High|Extra\s+Low|Low|Medium|High|XHigh|Extra|Minimal|Max|Thinking)\)\s*$/i, '')
        .replace(/\s+(?:Trial|Preview|Exp|Extra\s+High|Extra\s+Low|Low|Medium|High|XHigh|Extra|Minimal|Max|Thinking)$/i, '')
        .trim()
      : autoPrettyModelTitle(baseKey);
    const existing = extraByBaseKey.get(baseKey);
    if (existing) {
      existing.items.push(model);
    } else {
      extraByBaseKey.set(baseKey, { displayName, items: [model] });
    }
  }

  for (const [baseKey, entry] of extraByBaseKey.entries()) {
    if (seenKeys.has(baseKey)) continue;
    if (entry.items.length > 0 && entry.items.every(m => matchModelToSharedPool(m, familyWindows, groups, subscriptionTier, models) !== null)) continue;
    seenKeys.add(baseKey);
    const status = buildStandaloneFamilyStatus(
      entry.items,
      { fiveHour: null, weekly: null },
      nowMs,
      {
        shortLabel: entry.displayName,
        fullLabel: entry.displayName,
      },
    );
    list.push({ key: baseKey, displayName: entry.displayName, ...status });
  }

  return list;
}

/** 从规范化分组重新计算 legacy 字段（供 overview 使用）。 */
export function legacyFromFamilyWindows(familyWindows: FamilyWindows, nowMs: number = Date.now()): {
  geminiFiveHourRemaining: number | null;
  geminiWeeklyRemaining: number | null;
  geminiFiveHourResetCountdown: string;
  geminiWeeklyResetCountdown: string;
  claudeFiveHourRemaining: number | null;
  claudeWeeklyRemaining: number | null;
  claudeFiveHourResetCountdown: string;
  claudeWeeklyResetCountdown: string;
  argonWeeklyRemaining: number | null;
  argonWeeklyResetCountdown: string;
  carbonWeeklyRemaining: number | null;
  carbonWeeklyResetCountdown: string;
} {
  const pct = (status: WindowStatus | null | undefined) => status?.known && !status.stale ? Math.round(status.remaining! * 100) : null;
  const countdown = (status: WindowStatus | null | undefined, nowMs: number) => (status?.known && !status.stale ? formatCountdown(status.resetTime, nowMs) : '');
  return {
    geminiFiveHourRemaining: pct(familyWindows.gemini.fiveHour),
    geminiWeeklyRemaining: pct(familyWindows.gemini.weekly),
    geminiFiveHourResetCountdown: countdown(familyWindows.gemini.fiveHour, nowMs),
    geminiWeeklyResetCountdown: countdown(familyWindows.gemini.weekly, nowMs),
    claudeFiveHourRemaining: pct(familyWindows.claude.fiveHour),
    claudeWeeklyRemaining: pct(familyWindows.claude.weekly),
    claudeFiveHourResetCountdown: countdown(familyWindows.claude.fiveHour, nowMs),
    claudeWeeklyResetCountdown: countdown(familyWindows.claude.weekly, nowMs),
    argonWeeklyRemaining: pct(familyWindows.argon.weekly),
    argonWeeklyResetCountdown: countdown(familyWindows.argon.weekly, nowMs),
    carbonWeeklyRemaining: pct(familyWindows.carbon?.weekly),
    carbonWeeklyResetCountdown: countdown(familyWindows.carbon?.weekly, nowMs),
  };
}

export function mergeWindowStatuses(...statuses: (WindowStatus | null)[]): WindowStatus | null {
  return statuses.reduce<WindowStatus | null>((acc, item) => mergeWindowStatus(acc, item), null);
}

/** Independent quota endpoint buckets are metering evidence, not model-list defaults. */
export function normalizeIndependentArgonQuota(
  payload: any,
  observedAt: number,
  options?: { allowedModelIds?: ReadonlySet<string> }
): NormalizedModel[] {
  const allowedNormalized = options?.allowedModelIds && options.allowedModelIds.size > 0
    ? new Set(
        Array.from(options.allowedModelIds)
          .flatMap(id => {
            const raw = id.trim().toLowerCase();
            const base = normalizeBaseModelKey(id).toLowerCase();
            return [raw, base];
          })
          .filter(Boolean)
      )
    : null;
  const rows = (Array.isArray(payload?.buckets) ? payload.buckets : []).filter((b: any) => {
    if (typeof b?.modelId !== 'string' || normalizeFraction(b.remainingFraction) === null) return false;
    if (isOrchestratorMetaModel(b.modelId, b.displayName)) return false;
    const rawId = b.modelId.trim().toLowerCase();
    const baseKey = normalizeBaseModelKey(b.modelId).toLowerCase();
    if (allowedNormalized && (allowedNormalized.has(rawId) || allowedNormalized.has(baseKey))) {
      return true;
    }
    const family = classifyFamily({ modelId: b.modelId, displayName: b.displayName });
    return family !== 'gemini' && family !== 'claude';
  });
  return normalizeCloudModels(
    {
      models: Object.fromEntries(
        rows.map((b: any) => [
          b.modelId,
          {
            displayName: b.displayName ?? b.modelId,
            quotaInfo: { remainingFraction: b.remainingFraction, resetTime: b.resetTime },
          },
        ])
      ),
    },
    observedAt
  );
}
