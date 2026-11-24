import type { ApiPricing } from './pricing.js';
import {
  normalizeModelId,
  stripModelProviderPrefix,
  THINKING_EFFORT_SUFFIX_RE,
  TIERED_OR_THINKING_EFFORT_SUFFIX_RE,
} from './model-identity.js';
import {
  getEffectiveModelAliasKeys,
  getEffectiveModelPriceAlias,
  resolveObservedModelByEnum,
  resolveObservedModelByIdOrAlias,
} from './model-catalog.js';
import type { LedgerEvent } from './usage-ledger.js';
import { USAGE_PROJECTION_VERSION } from './protobuf-projection.js';
import { bt } from './i18n.js';

export interface TokenUsageTotals {
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cache_write_tokens?: number;
  total_tokens: number;
  request_count: number;
}

export interface ModelTokenUsage {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cache_write_tokens?: number;
  total_tokens: number;
  request_count: number;
  estimated_usd: number;
  priced?: boolean;
  partiallyPriced?: boolean;
  unpriced_tokens?: number;
  pricingKey?: string; pricingStatus?: string; pricingProvenance?: ApiPricing["provenance"] | null;
}

export interface DailyTokenUsage {
  date: string; // YYYY-MM-DD
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cache_write_tokens?: number;
  total_tokens: number;
  request_count: number;
}

export interface HourlyTokenUsage {
  hour: string; // YYYY-MM-DD HH:00
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cache_write_tokens?: number;
  total_tokens: number;
  request_count: number;
}

export interface SyncReceipt {
  source_id: string;
  environment_id: string;
  cursor_offset: number;
  step_offset: number;
  last_modified_sec: number;
  step_count: number;
  committed_at: number;
}

export type EnvironmentKind = 'local' | 'ssh';
export type EnvironmentLifecycleState =
  | 'online'
  | 'auth_expired'
  | 'offline_recent'
  | 'historical_only';
export type EnvironmentQuotaFreshness =
  | 'fresh'
  | 'stale'
  | 'error_fallback'
  | 'auth_expired'
  | 'offline_snapshot';

export interface EnvironmentNode {
  environmentId: string;
  machineId?: string;
  kind: EnvironmentKind;
  hostLabel: string;
  lifecycleState: EnvironmentLifecycleState;
  windowCount: number;
  focused: boolean;
  probing: boolean;
  accountEmail: string;
  accountName: string;
  tier: string;
  quota: Record<string, unknown> | null;
  quotaFreshness: EnvironmentQuotaFreshness;
  lastFocusedAt: number;
  lastQuotaObservedAt: number | null;
  lastUsageSyncedAt: number | null;
  lastError: string;
}

export interface AvailableEnvironmentUsageOption {
  id: string;
  kind: 'all' | 'local' | 'ssh';
  label: string;
  host_label?: string;
  total_tokens?: number;
  request_count?: number;
  estimated_usd?: number;
  online?: boolean;
  last_synced_at?: number;
  lifecycle_state?: EnvironmentLifecycleState;
  window_count?: number;
}

export interface KnownEnvironmentContext {
  id: string;
  kind: 'local' | 'ssh';
  host_label?: string;
  label?: string;
  online?: boolean;
  last_synced_at?: number;
  lifecycle_state?: EnvironmentLifecycleState;
  window_count?: number;
}

export interface EnvironmentShareBreakdown {
  local_tokens: number;
  ssh_tokens: number;
  local_requests: number;
  ssh_requests: number;
  local_usd: number;
  ssh_usd: number;
  local_share_pct: number;
  ssh_share_pct: number;
  has_ssh_data: boolean;
  offline_ssh_hosts: string[];
}

export interface TokenUsagePeriod {
  totals: TokenUsageTotals;
  estimated_usd: number;
  by_model: ModelTokenUsage[];
  priced_models?: number;
  unpriced_models?: number;
  environment_breakdown?: EnvironmentShareBreakdown;
}

export interface TokenUsageSummary {
  today: TokenUsagePeriod;
  last_7_days: TokenUsagePeriod;
  last_30_days: TokenUsagePeriod;
  all_time: TokenUsagePeriod;
  daily_trends: DailyTokenUsage[];
  today_hourly: HourlyTokenUsage[];
  databases_scanned: number;
  databases_discovered?: number;
  scan_scope_description?: string;
  generations_scanned: number;
  skipped_large_records: number;
  generated_at: number;
  priced_models?: number;
  unpriced_models?: number;
  failed_databases_count?: number;
  has_error?: boolean;
  hasError?: boolean;
  availability?: 'complete' | 'partial' | 'cached' | 'unavailable';
  unknown_time_records?: number;
  unknown_time_tokens?: number;
  database_diagnostics?: { id: string; state: string; category: string; lastSuccessAt?: number }[];
  snapshot_id?: string;
  last_attempt_at?: number;
  pricing_warnings?: string[];
  pricing_warning_codes?: string[];
  unattributed_requests?: number;
  unattributed_tokens?: number;
  ledger_review_records?: number;
  historical_amount_receipts?: { unmatchedCount: number; unmatchedUsd: number };
  available_accounts?: AvailableAccountUsageOption[];
  selected_account_id?: string;
  available_environments?: AvailableEnvironmentUsageOption[];
  selected_environment_id?: string;
  environment_breakdown?: EnvironmentShareBreakdown;
  remote_sync_revision?: number;
  environments?: EnvironmentNode[];
  environments_revision?: number;
  focused_environment_id?: string;
}

export interface AvailableAccountUsageOption {
  id: string; // 'all' | accountId | email
  label: string; // '全部账号' | 'account-one@example.invalid' | 'account-two@example.invalid'
  email?: string;
  name?: string | null;
  type?: 'all' | 'account';
  total_tokens?: number;
  request_count?: number;
}

export interface GenerationEvent {
  event_key?: string;
  source_id?: string;
  source_observed_at?: number;
  generation_index?: number;
  legacy_event_key?: string;
  account_confidence?: 'observed' | 'inferred' | 'unknown' | 'legacy';
  environment_kind?: 'local' | 'ssh';
  environment_id?: string;
  environment_label?: string;
  trajectory_id?: string;
  execution?: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cache_write_tokens?: number;
  total_tokens: number;
  timestamp_seconds: number;
  account_id?: string;
  account_email?: string;
  account_type?: 'consumer' | 'enterprise_vertex' | 'unknown';
  project_id?: string;
}

/**
 * 归一化事件的执行环境标签；未携带 `environment_kind` 的 1.1.3 本地历史记录
 * 在内存中默认归为 `{ kind: 'local', id: 'local', label: '' }`，绝不回写改写存量 payload。
 */
export function normalizeEventEnvironment(
  ev?: Pick<GenerationEvent, 'environment_kind' | 'environment_id' | 'environment_label'> | null
): { kind: 'local' | 'ssh'; id: string; label: string } {
  if (ev?.environment_kind === 'ssh') {
    const rawId = typeof ev.environment_id === 'string' ? ev.environment_id.trim() : '';
    const rawLabel = typeof ev.environment_label === 'string' ? ev.environment_label.trim() : '';
    const id = rawId || (rawLabel ? `ssh:${rawLabel}` : 'ssh');
    return {
      kind: 'ssh',
      id,
      label: rawLabel || rawId || 'ssh',
    };
  }
  return {
    kind: 'local',
    id: 'local',
    label: '',
  };
}

/**
 * 基于 Antigravity 数据库 (gen_metadata) 提取真实 Response model 名称（如 "gemini-3.8-flash-n", "gemini-3.8-flash-exp-a"），不包含推理程度 high/medium/low。
 * 针对 Vertex AI / GCP 路径前缀（如 publishers/google/models/gemini-4-carbon）自动解耦并清洗为规范模型名称。
 * 同时对 Orchestrator 双阶段模式（Plan Mode: Argon / Carbon；Execution Mode: gemini-flash-worker-agy / 1669）执行方案 B 归一化合并。
 */
export const CANONICAL_UNKNOWN_MODEL = '未知模型';

export function isUnknownModelName(name: string | null | undefined): boolean {
  const clean = typeof name === 'string' ? name.trim() : '';
  return clean === CANONICAL_UNKNOWN_MODEL || clean.toLowerCase() === 'unknown model';
}

const ORCHESTRATOR_THINKING_SUFFIX_RE = THINKING_EFFORT_SUFFIX_RE;
const NON_GEMINI_ORCHESTRATOR_CODENAMES = new Set([
  'opus', 'sonnet', 'haiku', 'claude', 'gpt', 'openai', 'anthropic',
  'o1', 'o3', 'o4', 'o5', 'llama', 'mistral', 'deepseek', 'qwen', 'grok', 'command',
]);
const EXPLICIT_MODEL_FAMILY_PREFIX_RE =
  /^(?:gemini|claude|gpt|gemma|o[1-9]|deepseek|qwen|llama|mistral|grok|command)-.+$/i;
const PLACEHOLDER_ID_RE = /^MODEL_PLACEHOLDER_M\d+$/i;
const AMBIGUOUS_ORCHESTRATOR_ID_RE =
  /^(?:gemini-pro-orchestrator(?:-g1-pro)?|gemini-flash-worker(?:-agy)?|orchestrator)$/i;

function normalizeDisplayLabelEffort(lbl: string): string {
  let out = lbl.trim();
  for (let i = 0; i < 3; i += 1) {
    const next = out
      .replace(/\s*[（(]\s*(?:extra[\s-]*high|extra[\s-]*low|xhigh|extra|high|medium|low|minimal|thinking|max)\s*[）)]\s*$/i, '')
      .replace(/\s+(?:extra[\s-]*high|extra[\s-]*low|xhigh|extra|high|medium|low|minimal|thinking|max)\s*$/i, '')
      .trim();
    if (!next || next === out) break;
    out = next;
  }
  return out || lbl.trim();
}

function unwrapOrchestratorModelPhrase(raw: string): string {
  let text = raw.trim();
  if (!text) return '';
  // "<Model Name> (Orchestrator)" -> "<Model Name>"
  text = text.replace(/\s*[（(]\s*orchestrator\s*[）)]\s*$/i, '').trim();
  // "Orchestrator (<Model Name>)" -> "<Model Name>"
  const parenMatch = text.match(/^orchestrator\s*[（(]\s*([^）)]+)\s*[）)]\s*$/i);
  if (parenMatch?.[1]) {
    text = parenMatch[1].trim();
  } else {
    // "Orchestrator <Model Name>" -> "<Model Name>"
    const spaceMatch = text.match(/^orchestrator\s+(.+)$/i);
    if (spaceMatch?.[1]) {
      text = spaceMatch[1].trim();
    }
  }
  return normalizeDisplayLabelEffort(text);
}

function resolveUnderlyingModelFromLabel(
  rawLabel: string,
  siblingModelIds?: Iterable<string>
): string | null {
  const trimmed = rawLabel.trim();
  if (!trimmed) return null;
  if (/^gemini\s+flash$/i.test(trimmed) || /^orchestrator$/i.test(trimmed)) return null;

  const phrase = unwrapOrchestratorModelPhrase(trimmed);
  if (!phrase || /^orchestrator$/i.test(phrase) || /^gemini\s+flash$/i.test(phrase) || /^gemini\s+pro$/i.test(phrase)) {
    return null;
  }

  const directAlias =
    getEffectiveModelPriceAlias(phrase) ??
    getEffectiveModelPriceAlias(trimmed);
  if (directAlias && !AMBIGUOUS_ORCHESTRATOR_ID_RE.test(directAlias)) {
    return directAlias;
  }

  const observed = resolveObservedModelByIdOrAlias(phrase) ?? resolveObservedModelByIdOrAlias(trimmed);
  if (observed?.modelId) {
    const obsClean = stripModelProviderPrefix(observed.modelId).replace(/(?:^|[-_])disabled$/i, '').trim();
    if (obsClean && !PLACEHOLDER_ID_RE.test(obsClean) && !AMBIGUOUS_ORCHESTRATOR_ID_RE.test(obsClean)) {
      const obsAlias = getEffectiveModelPriceAlias(obsClean);
      if (obsAlias) return obsAlias;
      const obsNorm = normalizeModelId(obsClean).replace(TIERED_OR_THINKING_EFFORT_SUFFIX_RE, '');
      if (obsNorm) return getEffectiveModelPriceAlias(obsNorm) ?? obsNorm;
    }
  }

  const normPhrase = normalizeModelId(phrase).replace(TIERED_OR_THINKING_EFFORT_SUFFIX_RE, '');
  if (normPhrase) {
    const normAlias = getEffectiveModelPriceAlias(normPhrase);
    if (normAlias && !AMBIGUOUS_ORCHESTRATOR_ID_RE.test(normAlias)) return normAlias;
    if (EXPLICIT_MODEL_FAMILY_PREFIX_RE.test(normPhrase) && normPhrase !== 'gemini-flash' && normPhrase !== 'gemini-pro') {
      return normPhrase;
    }
  }

  // Single-word codename (e.g. "Carbon", "Hydrogen", "Neon", "Nova")
  if (/^[a-z][a-z0-9]*$/i.test(phrase)) {
    const codename = phrase.toLowerCase();
    if (
      codename === 'pro' ||
      codename === 'flash' ||
      codename === 'default' ||
      codename === 'unknown' ||
      codename === 'g1' ||
      NON_GEMINI_ORCHESTRATOR_CODENAMES.has(codename)
    ) {
      return null;
    }
    const cap = codename.charAt(0).toUpperCase() + codename.slice(1);
    const explicitAlias =
      getEffectiveModelPriceAlias(`gemini-pro-orchestrator-${codename}`) ??
      getEffectiveModelPriceAlias(`Orchestrator (${cap})`) ??
      getEffectiveModelPriceAlias(`orchestrator (${codename})`);
    if (explicitAlias) return explicitAlias;

    const versionedRe = new RegExp(`^gemini-(\\d+(?:\\.\\d+)?)-${codename}$`, 'i');
    if (siblingModelIds) {
      for (const raw of siblingModelIds) {
        const cleaned = stripModelProviderPrefix(String(raw ?? ''))
          .trim()
          .replace(/(?:^|[-_])disabled$/i, '')
          .replace(ORCHESTRATOR_THINKING_SUFFIX_RE, '');
        const m = cleaned.match(versionedRe);
        if (m) return `gemini-${m[1]}-${codename}`;
      }
    }
    for (const known of getEffectiveModelAliasKeys()) {
      const m = known.match(versionedRe);
      if (m) return `gemini-${m[1]}-${codename}`;
    }
  }

  return null;
}

/**
 * 动态识别尚未入库的新代号 Orchestrator（如 gemini-pro-orchestrator-<codename>、Orchestrator (<Model>)、
 * Orchestrator <Model Name> 或 <Model Name> (Orchestrator)），仅合并模型身份，绝不自行伪造定价或非 Gemini 模型前缀。
 */
export function resolveDynamicOrchestratorModel(
  strippedId: string,
  cleanLabel: string,
  siblingModelIds?: Iterable<string>
): string | null {
  const idText = String(strippedId ?? '').trim();
  const labelText = String(cleanLabel ?? '').trim();

  // Handle full model names in "Orchestrator <Model Name>", "Orchestrator (<Model Name>)", or "<Model Name> (Orchestrator)"
  for (const candidate of [labelText, idText]) {
    if (!candidate) continue;
    if (/^orchestrator(?:\s*\(|\s+)/i.test(candidate) || /[（(]\s*orchestrator\s*[）)]\s*$/i.test(candidate)) {
      const resolved = resolveUnderlyingModelFromLabel(candidate, siblingModelIds);
      if (resolved) return resolved;
    }
  }

  const idCodename = idText.match(/^gemini-pro-orchestrator-(?!g1(?:-|$)|default$|pro$)([a-z][a-z0-9]*)$/i)?.[1];
  const labelCodename =
    idText.match(/^Orchestrator\s*\(\s*([a-z][a-z0-9]*)\s*\)$/i)?.[1] ??
    labelText.match(/^Orchestrator\s*\(\s*([a-z][a-z0-9]*)\s*\)$/i)?.[1];
  const rawCodename = idCodename ?? labelCodename;
  if (!rawCodename) return null;
  const codename = rawCodename.toLowerCase();
  if (
    codename === 'pro' ||
    codename === 'flash' ||
    codename === 'default' ||
    codename === 'unknown' ||
    codename === 'g1' ||
    NON_GEMINI_ORCHESTRATOR_CODENAMES.has(codename)
  ) {
    return null;
  }
  const cap = codename.charAt(0).toUpperCase() + codename.slice(1);
  const explicitAlias =
    getEffectiveModelPriceAlias(`gemini-pro-orchestrator-${codename}`) ??
    getEffectiveModelPriceAlias(`Orchestrator (${cap})`) ??
    getEffectiveModelPriceAlias(`orchestrator (${codename})`);
  if (explicitAlias) return explicitAlias;

  const versionedRe = new RegExp(`^gemini-(\\d+(?:\\.\\d+)?)-${codename}$`, 'i');
  if (siblingModelIds) {
    for (const raw of siblingModelIds) {
      const cleaned = stripModelProviderPrefix(String(raw ?? ''))
        .trim()
        .replace(/(?:^|[-_])disabled$/i, '')
        .replace(ORCHESTRATOR_THINKING_SUFFIX_RE, '');
      const m = cleaned.match(versionedRe);
      if (m) return `gemini-${m[1]}-${codename}`;
    }
  }
  for (const known of getEffectiveModelAliasKeys()) {
    const m = known.match(versionedRe);
    if (m) return `gemini-${m[1]}-${codename}`;
  }
  // Infer gemini-<highestMajor>-<codename> when the upstream ID itself explicitly starts with gemini-pro-orchestrator-
  if (idCodename) {
    let highestMajor = 0;
    const majorRe = /^gemini-(\d+)-/i;
    const considerMajor = (raw: string) => {
      const cleaned = stripModelProviderPrefix(String(raw ?? '')).trim();
      const match = cleaned.match(majorRe);
      if (match) {
        const major = Number.parseInt(match[1]!, 10);
        if (Number.isSafeInteger(major) && major > highestMajor) {
          highestMajor = major;
        }
      }
    };
    if (siblingModelIds) {
      for (const raw of siblingModelIds) {
        considerMajor(raw);
      }
    }
    for (const known of getEffectiveModelAliasKeys()) {
      considerMajor(known);
    }
    const major = highestMajor > 0 ? highestMajor : 4;
    return `gemini-${major}-${codename}`;
  }
  return null;
}

export function resolveDatabaseModelFullName(
  modelId: string | null | undefined,
  label: string | null | undefined,
  modelEnum?: number | null,
  options?: { canonicalUnknown?: boolean; siblingModelIds?: Iterable<string> }
): string {
  const rawId = typeof modelId === 'string' ? modelId.trim() : '';
  const cleanId = isUnknownModelName(rawId) ? '' : rawId;
  const strippedId = cleanId ? (stripModelProviderPrefix(cleanId) || cleanId) : '';
  const rawLabel = typeof label === 'string' ? label.trim() : '';
  const cleanLabel = isUnknownModelName(rawLabel) ? '' : rawLabel;

  const observedByEnum = typeof modelEnum === 'number' && Number.isSafeInteger(modelEnum) && modelEnum > 0
    ? resolveObservedModelByEnum(modelEnum)
    : null;
  const observedById = strippedId ? resolveObservedModelByIdOrAlias(strippedId) : null;
  const observedEntry = observedByEnum ?? observedById;

  const resolveFromObservedEntry = (entry: NonNullable<typeof observedEntry>): string | null => {
    const obsId = stripModelProviderPrefix(entry.modelId || '').replace(/(?:^|[-_])disabled$/i, '').trim();
    if (obsId && !PLACEHOLDER_ID_RE.test(obsId) && !AMBIGUOUS_ORCHESTRATOR_ID_RE.test(obsId)) {
      const obsAlias = getEffectiveModelPriceAlias(obsId);
      if (obsAlias) return obsAlias;
      const obsNorm = normalizeModelId(obsId).replace(TIERED_OR_THINKING_EFFORT_SUFFIX_RE, '');
      if (obsNorm) return getEffectiveModelPriceAlias(obsNorm) ?? obsNorm;
    }
    if (entry.displayName) {
      const fromObsLabel = resolveUnderlyingModelFromLabel(entry.displayName, options?.siblingModelIds);
      if (fromObsLabel) return fromObsLabel;
    }
    return null;
  };

  // 1. Execution worker / M669 (gemini-flash-worker-agy / modelEnum=1669):
  //    In Antigravity 2.34.0+, executionModel can be ANY model (Hydrogen, Neon, Carbon, Claude, etc.).
  //    Prefer real underlying model from cleanLabel; fall back to gemini-3.8-flash ONLY when cleanLabel is empty or generic "Gemini Flash".
  const isFlashWorker =
    /^gemini-flash-worker(?:-agy)?$/i.test(strippedId) ||
    /^MODEL_PLACEHOLDER_M669$/i.test(strippedId) ||
    modelEnum === 1669 ||
    (!strippedId && /^Gemini\s+Flash$/i.test(cleanLabel));

  if (isFlashWorker) {
    if (cleanLabel && !/^Gemini\s+Flash$/i.test(cleanLabel)) {
      const fromLabel = resolveUnderlyingModelFromLabel(cleanLabel, options?.siblingModelIds);
      if (fromLabel) return fromLabel;
      const normalizedLabel = normalizeDisplayLabelEffort(unwrapOrchestratorModelPhrase(cleanLabel) || cleanLabel);
      const labelAlias = getEffectiveModelPriceAlias(normalizedLabel);
      if (labelAlias) return labelAlias;
      const normId = normalizeModelId(normalizedLabel).replace(TIERED_OR_THINKING_EFFORT_SUFFIX_RE, '');
      if (normId && normId !== 'gemini-flash') return normId;
    }
    if (!cleanLabel && observedEntry) {
      const fromObs = resolveFromObservedEntry(observedEntry);
      if (fromObs) return fromObs;
    }
    const workerAlias = strippedId
      ? (getEffectiveModelPriceAlias(strippedId) ?? getEffectiveModelPriceAlias(cleanId))
      : undefined;
    return workerAlias ?? getEffectiveModelPriceAlias('MODEL_PLACEHOLDER_M669') ?? 'gemini-3.8-flash';
  }

  // 2. Orchestrator / Planner ambiguous IDs & empty IDs:
  //    Consult cleanLabel & observed registry BEFORE falling back to legacy static aliases.
  const isLegacyAmbiguousOrchestratorId =
    /^gemini-pro-orchestrator(?:-g1-pro)?$/i.test(strippedId) ||
    /^MODEL_PLACEHOLDER_M66[78]$/i.test(strippedId) ||
    /^Orchestrator(?:\s*\(|\s+)/i.test(strippedId);

  if (!strippedId || isLegacyAmbiguousOrchestratorId) {
    if (cleanLabel) {
      const fromLabel = resolveUnderlyingModelFromLabel(cleanLabel, options?.siblingModelIds);
      if (fromLabel) return fromLabel;
    }
    if (strippedId && /^Orchestrator(?:\s*\(|\s+)/i.test(strippedId)) {
      const fromIdLabel = resolveUnderlyingModelFromLabel(strippedId, options?.siblingModelIds);
      if (fromIdLabel) return fromIdLabel;
    }
    if (observedEntry) {
      const fromObs = resolveFromObservedEntry(observedEntry);
      if (fromObs) return fromObs;
    }
    if (/\bcarbon\b/i.test(cleanLabel) || /\bcarbon\b/i.test(strippedId) || modelEnum === 1667 || /M667$/i.test(strippedId)) {
      return getEffectiveModelPriceAlias('MODEL_PLACEHOLDER_M667') ?? 'gemini-4-carbon';
    }
    if (/\bhydrogen\b/i.test(cleanLabel) || /\bhydrogen\b/i.test(strippedId)) {
      return getEffectiveModelPriceAlias(cleanLabel) ?? 'gemini-4-hydrogen';
    }
    if (/\bargon\b/i.test(cleanLabel) || /\bargon\b/i.test(strippedId) || modelEnum === 1668 || /M668$/i.test(strippedId)) {
      return getEffectiveModelPriceAlias('MODEL_PLACEHOLDER_M668') ?? 'gemini-4-argon';
    }
    if (cleanLabel) {
      const labelAlias = getEffectiveModelPriceAlias(cleanLabel);
      if (labelAlias) return labelAlias;
    }
    const dynamicOrchestrator = resolveDynamicOrchestratorModel(strippedId, cleanLabel, options?.siblingModelIds);
    if (dynamicOrchestrator) return dynamicOrchestrator;
    // If cleanLabel names an unrecognized model (e.g. "Orchestrator (Opus)" or a new unpriced model),
    // do NOT fall through to legacy bare gemini-pro-orchestrator -> gemini-4-argon alias!
    if (isLegacyAmbiguousOrchestratorId && cleanLabel && !/^orchestrator$/i.test(cleanLabel)) {
      const normalizedLabel = normalizeDisplayLabelEffort(cleanLabel);
      return getEffectiveModelPriceAlias(normalizedLabel) ?? normalizedLabel;
    }
  }

  if (cleanId) {
    const dynamicIdAlias = getEffectiveModelPriceAlias(strippedId) ?? getEffectiveModelPriceAlias(cleanId);
    if (dynamicIdAlias) return dynamicIdAlias;
    if (PLACEHOLDER_ID_RE.test(strippedId) && observedEntry) {
      const fromObs = resolveFromObservedEntry(observedEntry);
      if (fromObs) return fromObs;
    }
    const dynamicOrchestrator = resolveDynamicOrchestratorModel(strippedId, cleanLabel, options?.siblingModelIds);
    if (dynamicOrchestrator) return dynamicOrchestrator;
    if (/^(?:gemini-pro-orchestrator|gemini-pro-orchestrator-g1-pro|gemini-pro-orchestrator-argon)$/i.test(strippedId)) {
      return 'gemini-4-argon';
    }
    if (PLACEHOLDER_ID_RE.test(strippedId) && cleanLabel) {
      const fromLabel = resolveUnderlyingModelFromLabel(cleanLabel, options?.siblingModelIds);
      if (fromLabel) return fromLabel;
      const normalizedLabel = normalizeDisplayLabelEffort(cleanLabel);
      return getEffectiveModelPriceAlias(normalizedLabel) ?? normalizedLabel;
    }
    if (strippedId) return strippedId;
    return cleanId;
  }
  if (cleanLabel) {
    const normalizedLabel = normalizeDisplayLabelEffort(cleanLabel);
    return getEffectiveModelPriceAlias(normalizedLabel) ?? normalizedLabel;
  }
  return options?.canonicalUnknown ? CANONICAL_UNKNOWN_MODEL : bt('usage.unknown_model');
}

export interface FileCacheEntry {
  mtimeMs: number;
  size: number;
  walMtimeMs: number;
  walSize: number;
  events: GenerationEvent[];
  generationsScanned: number;
  skippedLargeRecords: number;
  projectionVersion?: number;
  hasError?: boolean;
  error?: string;
  lastSuccessAt?: number;
}

export function isFileCacheEntryReusable(
  entry: Pick<FileCacheEntry, 'hasError' | 'skippedLargeRecords' | 'size' | 'projectionVersion'> | undefined | null
): boolean {
  if (!entry || entry.hasError) return false;
  if (entry.projectionVersion !== USAGE_PROJECTION_VERSION) {
    if (entry.projectionVersion !== undefined) return false;
    if ((entry.skippedLargeRecords ?? 0) > 0) return false;
    if (entry.size > 16 * 1024 * 1024) return false;
  }
  return true;
}

export function ledgerEventsEqual(a: LedgerEvent, b: LedgerEvent): boolean {
  for (const key of Object.keys(a) as (keyof LedgerEvent)[]) {
    if (a[key] !== b[key]) return false;
  }
  for (const key of Object.keys(b) as (keyof LedgerEvent)[]) {
    if (!(key in a) && b[key] !== undefined) return false;
  }
  return true;
}
