import {
  normalizeModelId,
  stripModelProviderPrefix,
  TIERED_OR_THINKING_EFFORT_SUFFIX_RE,
} from './model-identity.js';
import {
  MODEL_PRICES,
  getEffectiveModelPriceAlias,
  getEffectiveFeedModelKeys,
  CATALOG_PRICING_VERSION,
  CATALOG_PRICING_UPDATED_AT,
  getEffectiveActiveModelKeys,
  getEffectiveModelDisplayName,
} from './model-catalog.js';
import { bt, getActiveLocale } from './i18n.js';
import { resolveDynamicOrchestratorModel } from './usage-types.js';

export interface ApiPricingContextTier {
  /** 单步总输入规模阈值（promptTokens > thresholdTokens 触发；inclusive=true 时为 >=） */
  thresholdTokens: number;
  inclusive?: boolean;
  input: number;  // 每 1M Tokens 美元
  output: number; // 每 1M Tokens 美元
  cached: number; // 每 1M Tokens 美元
  cacheWrite?: number;
}

export interface ApiPricing {
  model: string;
  input: number;  // 每 1M Tokens 美元
  output: number; // 每 1M Tokens 美元
  cached: number; // 每 1M Tokens 美元
  cacheWrite?: number;
  /** 可选长上下文阶梯定价（如 >200k Tokens），未配置时沿用平铺单价 */
  contextTiers?: ApiPricingContextTier[];
  provenance?: {
    sourceUrl?: string;
    platform?: string;
    platformEn?: string;
    conditions?: string;
    conditionsEn?: string;
    checkedAt?: string | null;
    validFrom?: string | null;
    validUntil?: string | null;
    verification?: 'confirmed' | 'historical' | 'user';
  };
  intervals?: ApiPricingInterval[];
}

export interface ApiPricingInterval {
  model?: string;
  validFrom?: string | null;
  validUntil?: string | null;
  input: number;
  output: number;
  cached: number;
  cacheWrite?: number;
  contextTiers?: ApiPricingContextTier[];
  provenance?: {
    sourceUrl?: string;
    platform?: string;
    platformEn?: string;
    conditions?: string;
    conditionsEn?: string;
    checkedAt?: string | null;
    validFrom?: string | null;
    validUntil?: string | null;
    verification?: 'confirmed' | 'historical' | 'user';
  };
}

export type ApiPricingEntry = ApiPricing | ApiPricingInterval[];

export const DEFAULT_PRICING_FEED_URLS = [
  'https://raw.githubusercontent.com/Enzoo404/gravitybox/main/assets/pricing-feed.json',
  'https://cdn.jsdelivr.net/gh/Enzoo404/gravitybox@main/assets/pricing-feed.json',
  'https://api.github.com/repos/Enzoo404/gravitybox/contents/assets/pricing-feed.json?ref=main',
];

export const PRICING_METADATA = {
  version: CATALOG_PRICING_VERSION || '2026-11-13',
  updatedAt: CATALOG_PRICING_UPDATED_AT || '',
  sourceUrl: 'https://cloud.google.com/vertex-ai/pricing',
  effectiveDate: '2026-11-01',
  currency: 'USD',
  conditions: 'List prices for standard context tier, input caching enabled, per million tokens',
};

export const DEFAULT_API_PRICES: Record<string, ApiPricingEntry> = MODEL_PRICES;

function mergeIntervalProvenance(
  iv: ApiPricingInterval,
  baseProv?: ApiPricing['provenance']
): ApiPricing['provenance'] | undefined {
  if (!baseProv) return iv.provenance;
  const mergedProv: NonNullable<ApiPricing['provenance']> = {
    ...baseProv,
    ...(iv.provenance ?? {}),
  };
  if (!iv.provenance?.validUntil) {
    if (iv.validUntil) mergedProv.validUntil = iv.validUntil;
    else delete mergedProv.validUntil;
  }
  if (!iv.provenance?.validFrom) {
    if (iv.validFrom) mergedProv.validFrom = iv.validFrom;
    else delete mergedProv.validFrom;
  }
  return mergedProv;
}

export function isTemporalPricingEntry(entry: ApiPricingEntry | undefined): boolean {
  if (!entry) return false;
  if (Array.isArray(entry)) return entry.length > 0;
  return Boolean(
    (Array.isArray(entry.intervals) && entry.intervals.length > 0) ||
      entry.provenance?.validFrom ||
      entry.provenance?.validUntil
  );
}

export function resolveContextTierPricing(pricing: ApiPricing, promptTokens: number): ApiPricing {
  if (!pricing.contextTiers?.length || !Number.isFinite(promptTokens) || promptTokens < 0) {
    return pricing;
  }
  let matched: ApiPricingContextTier | null = null;
  for (const tier of pricing.contextTiers) {
    const hit = tier.inclusive ? promptTokens >= tier.thresholdTokens : promptTokens > tier.thresholdTokens;
    if (hit && (!matched || tier.thresholdTokens >= matched.thresholdTokens)) {
      matched = tier;
    }
  }
  if (!matched) return pricing;
  return {
    ...pricing,
    input: matched.input,
    output: matched.output,
    cached: matched.cached,
    ...(matched.cacheWrite !== undefined ? { cacheWrite: matched.cacheWrite } : {}),
  };
}

export function resolvePricingForTimestamp(
  entry: ApiPricingEntry | undefined,
  timestampSeconds: number,
  fallbackModelName = ''
): ApiPricing | null {
  if (!entry || !Number.isFinite(timestampSeconds) || timestampSeconds <= 0) return null;
  const intervals: ApiPricingInterval[] | null = Array.isArray(entry)
    ? entry
    : (entry.intervals && Array.isArray(entry.intervals) && entry.intervals.length > 0)
    ? entry.intervals
    : null;

  if (!intervals) {
    if (Array.isArray(entry)) return null;
    return entry;
  }
  if (intervals.length === 0) return null;

  const eventMs = timestampSeconds * 1000;

  let match: ApiPricingInterval | null = null;
  for (const interval of intervals) {
    const fromMs = interval.validFrom ? Date.parse(interval.validFrom) : Number.NEGATIVE_INFINITY;
    const untilMs = interval.validUntil ? Date.parse(interval.validUntil) : Number.POSITIVE_INFINITY;
    if (eventMs >= fromMs && eventMs < untilMs) {
      match = interval;
      break;
    }
  }

  // 缝隙容错保护：若刚好落在相邻两区间之间不超过 1000ms（1秒）的跨度（例如 23:59:59 到次日 00:00:00）
  if (!match) {
    for (const interval of intervals) {
      if (interval.validUntil) {
        const untilMs = Date.parse(interval.validUntil);
        const fromMs = interval.validFrom ? Date.parse(interval.validFrom) : Number.NEGATIVE_INFINITY;
        if (eventMs >= fromMs && eventMs >= untilMs && eventMs <= untilMs + 1000) {
          match = interval;
          break;
        }
      }
    }
  }

  if (!match) return null;

  const baseProv = !Array.isArray(entry) ? entry.provenance : undefined;
  const mergedProvenance = mergeIntervalProvenance(match, baseProv);
  const tierSource = match.contextTiers !== undefined
    ? match.contextTiers
    : !Array.isArray(entry) && entry.contextTiers !== undefined
      ? entry.contextTiers
      : undefined;

  return {
    model: match.model ?? fallbackModelName ?? (!Array.isArray(entry) ? entry.model : ''),
    input: match.input,
    output: match.output,
    cached: match.cached,
    ...(match.cacheWrite !== undefined ? { cacheWrite: match.cacheWrite } : {}),
    ...(tierSource !== undefined ? { contextTiers: tierSource } : {}),
    provenance: mergedProvenance,
    ...(entry && !Array.isArray(entry) && entry.intervals ? { intervals: entry.intervals } : {}),
  };
}

export function priceStatus(price: ApiPricing | ApiPricingInterval[], now = Date.now()) {
  const p = Array.isArray(price) ? resolvePricingForTimestamp(price, Math.floor(now / 1000)) : price;
  if (!p) return 'historical';
  if (p.provenance?.validUntil && Date.parse(p.provenance.validUntil) < now) return 'expired';
  return p.provenance?.verification === 'confirmed' ? 'confirmed' : p.provenance?.verification === 'user' ? 'user' : 'historical';
}

const SORTED_DEFAULT_PRICE_KEYS = Object.keys(DEFAULT_API_PRICES).sort((a, b) => b.length - a.length);
const PRICING_TABLE_SORTED_KEYS_CACHE = new WeakMap<object, readonly string[]>();
const SUFFIX_VARIANT_RE = /^(?:tiered(?:-(?:extra-high|extra-low|xhigh|extra|high|medium|low|minimal|max|thinking|latest|preview|trial))?|(?:extra-high|extra-low|xhigh|extra|high|medium|low|minimal|max|thinking|latest|preview|trial|\d{8}|\d{4}-\d{2}-\d{2}|\d{3}))(?:-thinking)?(?:-(?:\d{8}|\d{4}-\d{2}-\d{2}|\d{2}-\d{2}))?$/;

function getSortedPricingTableKeys(pricingTable: Record<string, ApiPricingEntry>): readonly string[] {
  if (pricingTable === DEFAULT_API_PRICES) return SORTED_DEFAULT_PRICE_KEYS;
  let cached = PRICING_TABLE_SORTED_KEYS_CACHE.get(pricingTable);
  if (!cached) {
    const union = new Set<string>(SORTED_DEFAULT_PRICE_KEYS);
    for (const k of Object.keys(pricingTable)) {
      const norm = normalizeModelId(k);
      if (norm) union.add(norm);
    }
    cached = [...union].sort((a, b) => b.length - a.length);
    PRICING_TABLE_SORTED_KEYS_CACHE.set(pricingTable, cached);
  }
  return cached;
}

function matchPricingKeysWithCandidates(modelName: string, sortedCandidateKeys: readonly string[]): string {
  if (!modelName || modelName.includes('未知模型') || modelName.toLowerCase().includes('unknown')) {
    return '';
  }
  const directAlias = getEffectiveModelPriceAlias(modelName);
  if (directAlias) return directAlias;
  // Only audited suffixes may inherit a base model price. Custom/experimental suffixes stay unknown.
  const lower = normalizeModelId(modelName);
  const lowerAlias = getEffectiveModelPriceAlias(lower);
  if (lowerAlias) return lowerAlias;
  for (const key of sortedCandidateKeys) {
    if (lower === key) return key;
    if (lower.startsWith(key + '-') && SUFFIX_VARIANT_RE.test(lower.slice(key.length + 1))) return key;
  }
  return lower;
}

/**
 * 模型价格归一化匹配算法（支持叠加远端/自定义价格表候选键）
 */
export function matchPricingKeys(modelName: string, extraKeys?: Iterable<string>): string {
  if (!extraKeys) {
    return matchPricingKeysWithCandidates(modelName, SORTED_DEFAULT_PRICE_KEYS);
  }
  const union = new Set<string>(SORTED_DEFAULT_PRICE_KEYS);
  for (const rawKey of extraKeys) {
    const norm = normalizeModelId(String(rawKey));
    if (norm) union.add(norm);
  }
  const sorted = union.size === SORTED_DEFAULT_PRICE_KEYS.length
    ? SORTED_DEFAULT_PRICE_KEYS
    : [...union].sort((a, b) => b.length - a.length);
  return matchPricingKeysWithCandidates(modelName, sorted);
}

function isValidRateValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 500.0;
}

function validateContextTiers(tiers: unknown, key: string): void {
  if (!Array.isArray(tiers)) throw Error(bt('pricing.err.interval_entry_invalid', { key }));
  for (const tier of tiers) {
    if (!tier || typeof tier !== 'object' || Array.isArray(tier)) throw Error(bt('pricing.err.interval_entry_invalid', { key }));
    const rec = tier as unknown as Record<string, unknown>;
    if (typeof rec.thresholdTokens !== 'number' || !Number.isSafeInteger(rec.thresholdTokens) || rec.thresholdTokens <= 0) {
      throw Error(bt('pricing.err.interval_entry_invalid', { key }));
    }
    if (!['input', 'output', 'cached'].every(k => isValidRateValue(rec[k]))) {
      throw Error(bt('pricing.err.interval_rate_invalid', { key }));
    }
    if (rec.cacheWrite !== undefined && !isValidRateValue(rec.cacheWrite)) {
      throw Error(bt('pricing.err.interval_cache_write_invalid', { key }));
    }
  }
}

export function calculateEstimatedUsd(
  inputTokens: number,
  outputTokens: number,
  cachedTokens: number,
  pricing: ApiPricing | ApiPricingInterval[],
  cacheWriteTokens = 0
): number {
  let resolvedPricing: ApiPricing;
  if (Array.isArray(pricing)) {
    const r = resolvePricingForTimestamp(pricing, Math.floor(Date.now() / 1000));
    if (!r) throw Error(bt('pricing.err.usage_or_rate_invalid'));
    resolvedPricing = r;
  } else {
    resolvedPricing = pricing;
  }
  if (![inputTokens, outputTokens, cachedTokens, cacheWriteTokens].every(n => Number.isFinite(n) && n >= 0)) {
    throw Error(bt('pricing.err.usage_or_rate_invalid'));
  }
  const effectivePricing = resolveContextTierPricing(resolvedPricing, inputTokens + cachedTokens + cacheWriteTokens);
  if (cacheWriteTokens > 0 && (!Number.isFinite(effectivePricing.cacheWrite) || effectivePricing.cacheWrite! < 0)) {
    throw new Error(bt('pricing.err.cache_write_unconfigured'));
  }
  if (![effectivePricing.input, effectivePricing.output, effectivePricing.cached].every(n => Number.isFinite(n) && n >= 0)) {
    throw Error(bt('pricing.err.usage_or_rate_invalid'));
  }
  const cost =
    (inputTokens * effectivePricing.input +
      outputTokens * effectivePricing.output +
      cachedTokens * effectivePricing.cached +
      cacheWriteTokens * (effectivePricing.cacheWrite ?? 0)) /
    1_000_000;
  return Math.round(cost * 1e8) / 1e8;
}

export function validatePricingIntervals(value: ApiPricingInterval[], key: string): void {
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw Error(bt('pricing.err.interval_entry_invalid', { key }));
    if (!['input', 'output', 'cached'].every(k => isValidRateValue((item as unknown as Record<string, unknown>)[k]))) {
      throw Error(bt('pricing.err.interval_rate_invalid', { key }));
    }
    if (item.cacheWrite !== undefined && !isValidRateValue(item.cacheWrite)) {
      throw Error(bt('pricing.err.interval_cache_write_invalid', { key }));
    }
    if (item.contextTiers !== undefined) {
      validateContextTiers(item.contextTiers, key);
    }
    if (item.validFrom !== undefined && item.validFrom !== null && (typeof item.validFrom !== 'string' || isNaN(Date.parse(item.validFrom)))) {
      throw Error(bt('pricing.err.valid_from_invalid', { key }));
    }
    if (item.validUntil !== undefined && item.validUntil !== null && (typeof item.validUntil !== 'string' || isNaN(Date.parse(item.validUntil)))) {
      throw Error(bt('pricing.err.valid_until_invalid', { key }));
    }
  }
}

export function validateRawPrices(table: unknown): Record<string, ApiPricingEntry> {
  if (!table || typeof table !== 'object' || Array.isArray(table)) throw Error(bt('pricing.err.table_invalid'));
  const result: Record<string, ApiPricingEntry> = {};
  for (const [key, value] of Object.entries(table)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw Error(bt('pricing.err.illegal_entry_name', { key }));
    if (Array.isArray(value)) {
      if (value.length === 0) throw Error(bt('pricing.err.interval_array_empty', { key }));
      validatePricingIntervals(value, key);
      result[key] = value as ApiPricingInterval[];
    } else {
      const price = value as ApiPricing;
      const priceRec = price as unknown as Record<string, unknown>;
      if (!price || typeof price !== 'object' || typeof price.model !== 'string' || !['input', 'output', 'cached'].every(k => isValidRateValue(priceRec[k])) || (price.cacheWrite !== undefined && !isValidRateValue(price.cacheWrite))) {
        throw Error(bt('pricing.err.entry_rate_invalid', { key }));
      }
      if (price.contextTiers !== undefined) {
        validateContextTiers(price.contextTiers, key);
      }
      if (price.intervals !== undefined) {
        if (!Array.isArray(price.intervals) || price.intervals.length === 0) {
          throw Error(bt('pricing.err.interval_array_empty', { key }));
        }
        validatePricingIntervals(price.intervals, key);
      }
      result[key] = price;
    }
  }
  return result;
}

export function mergePricingEntries(
  merged: Record<string, ApiPricingEntry>,
  entries: object,
  warningPrefix: string,
  warnings: string[],
  acceptedKeys?: Set<string>
): void {
  for (const [key, value] of Object.entries(entries)) {
    try {
      const validated = validateRawPrices({ [key]: value });
      const incoming = validated[key];
      const base = merged[key];
      const baseProv = base && !Array.isArray(base) ? base.provenance : undefined;
      if (incoming && baseProv) {
        if (Array.isArray(incoming)) {
          for (const iv of incoming) {
            iv.provenance = mergeIntervalProvenance(iv, baseProv);
          }
        } else {
          if (incoming.provenance) {
            incoming.provenance = { ...baseProv, ...incoming.provenance };
          } else {
            incoming.provenance = { ...baseProv };
          }
          if (Array.isArray(incoming.intervals)) {
            for (const iv of incoming.intervals) {
              iv.provenance = mergeIntervalProvenance(iv, baseProv);
            }
          }
        }
      }
      Object.assign(merged, validated);
      if (acceptedKeys) acceptedKeys.add(key);
    } catch {
      warnings.push(warningPrefix + key);
    }
  }
}

const LEGACY_INTERNAL_TRIAL_LITE_IDS = new Set([
  'gemini-3.1-flash-lite',
  'gemini-4-argon-trial',
]);

function buildKnownPricedKeys(
  rawPricingTable?: Record<string, ApiPricingEntry> | null,
  extraPricingKeys?: Iterable<string>
): Set<string> {
  const known = new Set<string>();
  for (const k of getEffectiveFeedModelKeys()) {
    const norm = normalizeModelId(k);
    if (norm) known.add(norm);
  }
  if (rawPricingTable) {
    for (const k of Object.keys(rawPricingTable)) {
      const norm = normalizeModelId(k);
      if (norm) known.add(norm);
    }
  }
  if (extraPricingKeys) {
    for (const rawKey of extraPricingKeys) {
      const norm = normalizeModelId(String(rawKey));
      if (norm) known.add(norm);
    }
  }
  return known;
}

function isPricedCatalogFlashLiteModel(
  rawId: string,
  canonicalKey: string,
  knownPricedKeys: ReadonlySet<string>
): boolean {
  const id = stripModelProviderPrefix(String(rawId ?? '')).trim();
  if (!id) return false;
  if (
    /^(?:chat_|tab_|model_placeholder_)/i.test(id) ||
    /(?:^|[-_])(?:image|tiered|safety[-_]le|control|exp[-_][a-z0-9]+|trial)(?:$|[-_])/i.test(id)
  ) {
    return false;
  }
  const normId = normalizeModelId(id);
  const normKey = normalizeModelId(canonicalKey);
  if (
    !normId ||
    LEGACY_INTERNAL_TRIAL_LITE_IDS.has(normId) ||
    (normKey && LEGACY_INTERNAL_TRIAL_LITE_IDS.has(normKey))
  ) {
    return false;
  }
  if (!/(?:^|[-_])flash[-_]lite(?:$|[-_])/i.test(id)) {
    return false;
  }
  return knownPricedKeys.has(normId) || (Boolean(normKey) && knownPricedKeys.has(normKey));
}

function isTieredVariantModelId(rawId: string): boolean {
  const id = stripModelProviderPrefix(String(rawId ?? '')).trim();
  if (!id) return false;
  if (
    /^(?:chat_|tab_)/i.test(id) ||
    /(?:^|[-_])(?:image|flash[-_]lite|safety[-_]le|control|exp[-_][a-z0-9]+|trial)(?:$|[-_])/i.test(id)
  ) {
    return false;
  }
  return /(?:^|[-_])tiered(?:$|[-_])/i.test(id);
}

export function isInternalNonChatModelId(rawId: string): boolean {
  const id = stripModelProviderPrefix(String(rawId ?? '')).trim();
  if (!id) return false;
  return (
    /^(?:chat_|tab_)/i.test(id) ||
    /(?:^|[-_])(?:image|flash[-_]lite|tiered|safety[-_]le|control|exp[-_][a-z0-9]+|trial)(?:$|[-_])/i.test(id)
  );
}

export function canonicalActivePricingKeys(
  modelIds: Iterable<string> | null | undefined,
  extraPricingKeys?: Iterable<string>
): Set<string> {
  const source = modelIds ? Array.from(modelIds) : [];
  const effectiveActive = new Set(Array.from(getEffectiveActiveModelKeys(), (k) => normalizeModelId(k)));
  const knownPricedKeys = buildKnownPricedKeys(DEFAULT_API_PRICES, extraPricingKeys);
  const keys = new Set<string>();
  for (const rawId of source) {
    const trimmed = String(rawId).trim();
    if (!trimmed) continue;
    const baseId = trimmed.replace(/(?:^|[-_])disabled$/i, '').trim();
    const normBase = normalizeModelId(baseId);
    const matched = matchPricingKeys(baseId, extraPricingKeys);
    const isPricedFlashLite = isPricedCatalogFlashLiteModel(baseId, matched, knownPricedKeys);
    const isActiveTieredVariant = isTieredVariantModelId(baseId) && effectiveActive.has(matched);
    if (!baseId || (!effectiveActive.has(normBase) && !isActiveTieredVariant && !isPricedFlashLite && isInternalNonChatModelId(baseId))) continue;
    if (matched) keys.add(matched);
  }
  if (keys.size === 0) {
    for (const key of getEffectiveActiveModelKeys()) keys.add(key);
  }
  return keys;
}

export type ModelAvailabilityKind =
  | 'available'
  | 'tier_locked'
  | 'other_tier_only'
  | 'unpriced_live'
  | 'retired';

export interface ModelCatalogEntryMeta {
  availability: ModelAvailabilityKind;
  displayName: string;
  hostOrder?: number;
  availableInTiers?: string[];
  activeTier?: string;
}

export interface UnpricedLiveModelEntry {
  key: string;
  displayName: string;
  disabled: boolean;
  variants?: string[];
}

export interface PricingCatalogModelInput {
  id?: string | null;
  name?: string | null;
  model_id?: string | null;
  displayName?: string | null;
  display_name?: string | null;
  modelOrAlias?: string | null;
  model_or_alias?: string | null;
  disabled?: boolean | null;
  stale?: boolean | null;
  quota_source?: string | null;
  is_internal?: boolean | null;
  isInternal?: boolean | null;
  deprecated?: boolean | null;
  non_chat_specialized?: boolean | null;
  nonChatSpecialized?: boolean | null;
  in_model_selector?: boolean | null;
  inModelSelector?: boolean | null;
  model_provider?: string | null;
  modelProvider?: string | null;
  max_tokens?: number | null;
  maxTokens?: number | null;
  max_output_tokens?: number | null;
  maxOutputTokens?: number | null;
}

export interface PricingCatalogSourceInput {
  tier?: string | null;
  source?: string | null;
  models?: readonly PricingCatalogModelInput[] | null;
}

export interface ResolvePricingCatalogSnapshotInput {
  rawPricingTable?: Record<string, ApiPricingEntry>;
  timestampSeconds?: number;
  nowMs?: number;
  locale?: string;
  publicPricingKeys?: Iterable<string>;
  activeModelKeys?: Iterable<string>;
  live?: PricingCatalogSourceInput | null;
  snapshot?: PricingCatalogSourceInput | null;
  activeAccount?: PricingCatalogSourceInput | null;
  poolAccounts?: readonly PricingCatalogSourceInput[] | null;
}

export interface PricingCatalogSnapshotResult {
  prices: Record<string, ApiPricing>;
  retiredPrices: Record<string, ApiPricing>;
  pricingStatus: Record<string, 'confirmed' | 'historical' | 'expired' | 'user'>;
  modelCatalogState: Record<string, ModelCatalogEntryMeta>;
  unpricedLiveModels: UnpricedLiveModelEntry[];
}

const FORBIDDEN_CATALOG_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const CATALOG_TIER_ORDER: Record<string, number> = {
  ULTRA: 0,
  ENTERPRISE: 1,
  TEAM: 2,
  PRO: 3,
  PLUS: 4,
  FREE: 5,
};

const NON_COMMERCIAL_TIER_SENTINELS_RE =
  /^(?:unknown|none|null|undefined|unspecified|default|n\/a|na|empty|other)$/i;
const INTERNAL_NON_TIER_WORD_RE = /\b(?:prototype|internal|debug|test)\b/i;

export function sanitizeFallbackTierLabel(rawTier: unknown): string {
  const raw = typeof rawTier === 'string' ? rawTier.trim() : '';
  if (!raw || raw.length > 48) return '';
  if (INTERNAL_NON_TIER_WORD_RE.test(raw)) return '';
  const cleaned = raw
    .replace(/^(?:g1|agy|google[\s_-]*ai|google[\s_-]*one|antigravity)[\s_-]+/i, '')
    .replace(/[\s_-]+(?:tier|plan)$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned || cleaned.length > 32 || !/[a-z]/i.test(cleaned)) return '';
  if (cleaned.split(' ').length > 3) return '';
  if (NON_COMMERCIAL_TIER_SENTINELS_RE.test(cleaned) || INTERNAL_NON_TIER_WORD_RE.test(cleaned)) {
    return '';
  }
  return cleaned.toUpperCase();
}

export function normalizeCatalogTierLabel(rawTier: unknown): string {
  const text = typeof rawTier === 'string' ? rawTier.trim() : '';
  if (!text) return '';
  if (/ultra/i.test(text)) return 'ULTRA';
  if (/enterprise/i.test(text)) return 'ENTERPRISE';
  if (/\b(?:team|teams|business|workspace)\b/i.test(text)) return 'TEAM';
  if (/\bplus\b/i.test(text)) return 'PLUS';
  if (/\b(?:pro|ai\s+premium)\b/i.test(text)) return 'PRO';
  if (/\b(?:free|starter|trial)\b/i.test(text)) return 'FREE';
  return sanitizeFallbackTierLabel(text);
}

export function compareCatalogTiers(a: string, b: string): number {
  const ra = CATALOG_TIER_ORDER[a] ?? 99;
  const rb = CATALOG_TIER_ORDER[b] ?? 99;
  return ra !== rb ? ra - rb : a.localeCompare(b);
}

function resolveCatalogDisplayName(
  key: string,
  observedDisplayName?: string,
  previousDisplayName?: string
): string {
  const catalogName = getEffectiveModelDisplayName(key);
  if (catalogName && catalogName !== key) return catalogName;
  if (observedDisplayName && observedDisplayName.toLowerCase() !== key.toLowerCase()) {
    return observedDisplayName;
  }
  if (previousDisplayName) return previousDisplayName;
  return observedDisplayName || key;
}

type CatalogSourceKind = 'live' | 'snapshot' | 'account_live' | 'account_cloud';

interface ExtractedCatalogCandidate {
  canonicalKey: string;
  resolvedPricing: ApiPricing | null;
  displayName: string;
  disabled: boolean;
  variantLabel?: string;
  isOrchestratorVariant?: boolean;
}

const UNPRICED_THINKING_SUFFIX_LABELS: Record<string, string> = {
  minimal: 'Minimal',
  'extra-low': 'Extra Low',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  extra: 'Extra',
  'extra-high': 'Extra High',
  max: 'Max',
  thinking: 'Thinking',
};

const UNPRICED_VARIANT_ORDER: Record<string, number> = {
  Minimal: -1,
  Low: 0,
  Medium: 1,
  High: 2,
  XHigh: 3,
  Extra: 4,
  'Extra High': 5,
  'Extra Low': 6,
  Max: 7,
  Thinking: 8,
  Orchestrator: 9,
};

function stripDisplayTierSuffix(displayName: string): string {
  const cleaned = displayName
    .replace(/\s*[（(]\s*(?:extra[\s-]*high|extra[\s-]*low|xhigh|extra|high|medium|low|minimal|max|thinking)\s*[）)]\s*$/i, '')
    .replace(/\s+(?:extra[\s-]*high|extra[\s-]*low|xhigh|extra|high|medium|low|minimal|max|thinking)\s*$/i, '')
    .trim();
  return cleaned || displayName;
}

function foldUnpricedLiveCandidate(
  baseId: string,
  canonicalKey: string,
  rawDisplayName: string,
  siblingNormIds: ReadonlySet<string>
): { canonicalKey: string; displayName: string; variantLabel?: string; isOrchestratorVariant?: boolean } {
  const orchestratorTarget = resolveDynamicOrchestratorModel(baseId, rawDisplayName, siblingNormIds);
  if (orchestratorTarget) {
    const isOrchLabel =
      /^(?:Orchestrator\s*[(\uFF08]|Orchestrator\s+)/i.test(rawDisplayName) ||
      /[(\uFF08]\s*Orchestrator\s*[)\uFF09]$/i.test(rawDisplayName);
    return {
      canonicalKey: orchestratorTarget,
      displayName: isOrchLabel ? '' : stripDisplayTierSuffix(rawDisplayName),
      variantLabel: 'Orchestrator',
      isOrchestratorVariant: true,
    };
  }
  if (canonicalKey && !/^(?:chat_|tab_|model_placeholder_)/i.test(canonicalKey)) {
    const suffixMatch = canonicalKey.match(
      /^(.+?)(?:-tiered)?-(extra-high|extra-low|xhigh|extra|high|medium|low|minimal|max|thinking)$/i
    );
    if (suffixMatch) {
      const baseKey = suffixMatch[1]!;
      if (baseKey.length >= 2 && /[a-z0-9]/i.test(baseKey)) {
        const rawSuffix = suffixMatch[2]!.toLowerCase();
        return {
          canonicalKey: baseKey,
          displayName: stripDisplayTierSuffix(rawDisplayName),
          variantLabel: UNPRICED_THINKING_SUFFIX_LABELS[rawSuffix] ?? rawSuffix,
        };
      }
    }
    const bareTieredMatch = canonicalKey.match(/^(.+)-tiered$/i);
    if (bareTieredMatch && bareTieredMatch[1]!.length >= 2 && /[a-z0-9]/i.test(bareTieredMatch[1]!)) {
      return {
        canonicalKey: bareTieredMatch[1]!,
        displayName: stripDisplayTierSuffix(rawDisplayName),
      };
    }
  }
  return { canonicalKey, displayName: rawDisplayName };
}

function isUserVisiblePreviewChatModel(
  sourceKind: CatalogSourceKind,
  baseId: string,
  normBase: string,
  rawDisplayName: string,
  feedModelSet: Set<string>
): boolean {
  if (!normBase || feedModelSet.has(normBase) || LEGACY_INTERNAL_TRIAL_LITE_IDS.has(normBase)) {
    return false;
  }
  const id = stripModelProviderPrefix(baseId).trim();
  if (!id) return false;
  if (
    /^(?:chat_|tab_|model_placeholder_)/i.test(id) ||
    /(?:^|[-_])(?:image|tiered|safety[-_]le|control|exp[-_][a-z0-9]+)(?:$|[-_])/i.test(id)
  ) {
    return false;
  }
  const label = rawDisplayName.trim();
  if (!label || /^model_placeholder_/i.test(label) || label.toLowerCase() === id.toLowerCase()) {
    return false;
  }
  if (sourceKind === 'account_cloud' && !/\s/.test(label)) {
    return false;
  }
  return /(?:^|[-_])(?:flash[-_]lite|trial)(?:$|[-_])/i.test(id);
}

function extractCatalogModels(
  sourceKind: CatalogSourceKind,
  rawModels: readonly PricingCatalogModelInput[] | null | undefined,
  rawPricingTable: Record<string, ApiPricingEntry>,
  extraKeys: Set<string>,
  effectiveActiveSet: Set<string>,
  feedModelSet: Set<string>,
  knownPricedKeys: ReadonlySet<string>,
  timestampSeconds: number
): ExtractedCatalogCandidate[] {
  if (!Array.isArray(rawModels) || rawModels.length === 0) return [];
  const siblingNormIds = new Set<string>();
  for (const m of rawModels) {
    if (!m || typeof m !== 'object') continue;
    if (m.stale === true || m.quota_source === 'carried') continue;
    if (m.is_internal === true || m.isInternal === true || m.deprecated === true || m.non_chat_specialized === true || m.nonChatSpecialized === true) {
      continue;
    }
    const rawId = String(m.model_id ?? m.id ?? m.name ?? m.model_or_alias ?? m.modelOrAlias ?? '').trim();
    if (!rawId) continue;
    const cleaned = normalizeModelId(rawId.replace(/(?:^|[-_])disabled$/i, '').trim())
      .replace(TIERED_OR_THINKING_EFFORT_SUFFIX_RE, '');
    if (cleaned) siblingNormIds.add(cleaned);
  }
  const parsed: ExtractedCatalogCandidate[] = [];
  for (const m of rawModels) {
    if (!m || typeof m !== 'object') continue;
    if (m.stale === true || m.quota_source === 'carried') continue;
    const isUpstreamInternal = m.is_internal === true || m.isInternal === true;
    const isUpstreamDeprecated = m.deprecated === true;
    const isUpstreamNonChat = m.non_chat_specialized === true || m.nonChatSpecialized === true;
    if (isUpstreamInternal || isUpstreamDeprecated || isUpstreamNonChat) continue;
    const rawInSelector = m.in_model_selector ?? m.inModelSelector;
    const explicitlyExcludedFromSelector = rawInSelector === false;
    const explicitlyInSelector = rawInSelector === true;
    const rawId = String(m.model_id ?? m.id ?? m.name ?? m.model_or_alias ?? m.modelOrAlias ?? '').trim();
    if (!rawId) continue;
    const hasDisabledSuffix = /(?:^|[-_])disabled$/i.test(rawId);
    const baseId = rawId.replace(/(?:^|[-_])disabled$/i, '').trim();
    if (!baseId || baseId.includes('未知模型') || baseId.toLowerCase() === 'unknown') continue;
    const normBase = normalizeModelId(baseId);
    const rawDisplayName = typeof (m.display_name ?? m.displayName) === 'string'
      ? String(m.display_name ?? m.displayName).trim()
      : '';
    const foundPricing = lookupPricingEntry(rawPricingTable, baseId);
    const resolvedPricing = foundPricing
      ? resolvePricingForTimestamp(foundPricing.entry, timestampSeconds, foundPricing.key)
      : null;
    const initialKey = foundPricing?.key || matchPricingKeys(baseId, extraKeys) || normBase;
    if (!initialKey || FORBIDDEN_CATALOG_KEYS.has(initialKey)) continue;
    if (explicitlyExcludedFromSelector && !resolvedPricing && !effectiveActiveSet.has(initialKey)) {
      continue;
    }
    const isPricedFlashLite = isPricedCatalogFlashLiteModel(baseId, initialKey, knownPricedKeys);
    const nonTieredBaseId = stripModelProviderPrefix(baseId)
      .trim()
      .replace(/[-_]tiered(?=$|[-_])/gi, '');
    const isFallbackTieredChatModel =
      (rawInSelector === undefined || rawInSelector === null) &&
      Boolean(nonTieredBaseId) &&
      !isInternalNonChatModelId(nonTieredBaseId);
    const isActiveTieredVariant = isTieredVariantModelId(baseId) && (
      effectiveActiveSet.has(initialKey) ||
      Boolean(resolvedPricing) ||
      explicitlyInSelector ||
      isFallbackTieredChatModel
    );
    if (
      !effectiveActiveSet.has(normBase) &&
      !isActiveTieredVariant &&
      !isPricedFlashLite &&
      isInternalNonChatModelId(baseId) &&
      !isUserVisiblePreviewChatModel(sourceKind, baseId, normBase, rawDisplayName, feedModelSet)
    ) {
      continue;
    }
    const disabled = m.disabled === true || hasDisabledSuffix;
    const folded = resolvedPricing
      ? { canonicalKey: initialKey, displayName: rawDisplayName }
      : foldUnpricedLiveCandidate(baseId, initialKey, rawDisplayName, siblingNormIds);
    if (!folded.canonicalKey || FORBIDDEN_CATALOG_KEYS.has(folded.canonicalKey)) continue;

    parsed.push({
      canonicalKey: folded.canonicalKey,
      resolvedPricing,
      displayName: folded.displayName,
      disabled,
      ...(folded.variantLabel ? { variantLabel: folded.variantLabel } : {}),
      ...(folded.isOrchestratorVariant ? { isOrchestratorVariant: true } : {}),
    });
  }

  if (sourceKind !== 'account_cloud') {
    return parsed;
  }

  const isOpenAiFamily = (key: string): boolean =>
    key.startsWith('gpt-') || /^o(?:[1-9]|[1-9]\d+)(?:$|[-_])/.test(key);
  const hasEnabledActiveClaude = parsed.some(
    (c) => !c.disabled && c.canonicalKey.startsWith('claude-') && effectiveActiveSet.has(c.canonicalKey)
  );
  const hasEnabledActiveGemini = parsed.some(
    (c) => !c.disabled && c.canonicalKey.startsWith('gemini-') && effectiveActiveSet.has(c.canonicalKey)
  );
  const hasEnabledActiveOpenAi = parsed.some(
    (c) => !c.disabled && isOpenAiFamily(c.canonicalKey) && effectiveActiveSet.has(c.canonicalKey)
  );

  return parsed.filter((c) => {
    if (effectiveActiveSet.has(c.canonicalKey)) return true;
    // 未出现在官方历史下架名录中的全新模型（如未来新增的 gemini-* / claude-* / gpt-*）在非禁用时直接放行，避免被历史前缀过滤误杀
    if (!feedModelSet.has(c.canonicalKey)) {
      return !c.disabled;
    }
    if (c.canonicalKey.startsWith('claude-')) {
      return !c.disabled && !hasEnabledActiveClaude;
    }
    if (c.canonicalKey.startsWith('gemini-')) {
      return !c.disabled && !hasEnabledActiveGemini;
    }
    if (isOpenAiFamily(c.canonicalKey)) {
      return !c.disabled && !hasEnabledActiveOpenAi;
    }
    return !c.disabled;
  });
}

export function resolvePricingCatalogSnapshot(
  input: ResolvePricingCatalogSnapshotInput = {}
): PricingCatalogSnapshotResult {
  const rawPricingTable = input.rawPricingTable ?? DEFAULT_API_PRICES;
  const effectiveNowMs = input.nowMs ?? (input.timestampSeconds !== undefined ? input.timestampSeconds * 1000 : Date.now());
  const timestampSeconds = input.timestampSeconds ?? Math.floor(effectiveNowMs / 1000);
  const locale = input.locale ?? getActiveLocale();

  const effectiveFeedKeys = getEffectiveFeedModelKeys();
  const publicCandidateKeys = new Set<string>(effectiveFeedKeys);
  if (input.publicPricingKeys) {
    for (const rawKey of input.publicPricingKeys) {
      const k = String(rawKey).trim();
      if (k && !FORBIDDEN_CATALOG_KEYS.has(k)) publicCandidateKeys.add(k);
    }
  }

  const extraKeys = new Set<string>(publicCandidateKeys);
  for (const k of Object.keys(rawPricingTable)) {
    if (k && !FORBIDDEN_CATALOG_KEYS.has(k)) extraKeys.add(k);
  }

  const effectiveActiveList = Array.from(input.activeModelKeys ?? getEffectiveActiveModelKeys())
    .map((k) => String(k).trim())
    .filter((k) => Boolean(k) && !FORBIDDEN_CATALOG_KEYS.has(k));
  const effectiveActiveSet = new Set<string>(effectiveActiveList);
  const feedModelSet = new Set<string>(effectiveFeedKeys);
  const knownPricedKeys = buildKnownPricedKeys(rawPricingTable);

  let primaryKind: CatalogSourceKind | null = null;
  let primaryTier = '';
  let primaryCandidates: ExtractedCatalogCandidate[] = [];

  const liveModelsCount = Array.isArray(input.live?.models) ? input.live.models.length : 0;
  if (liveModelsCount > 0) {
    const extracted = extractCatalogModels(
      'live',
      input.live?.models,
      rawPricingTable,
      extraKeys,
      effectiveActiveSet,
      feedModelSet,
      knownPricedKeys,
      timestampSeconds
    );
    if (extracted.length > 0) {
      primaryKind = 'live';
      primaryTier = normalizeCatalogTierLabel(input.live?.tier);
      primaryCandidates = extracted;
    }
  }

  if (!primaryKind && Array.isArray(input.snapshot?.models) && input.snapshot.models.length > 0) {
    const extracted = extractCatalogModels(
      'snapshot',
      input.snapshot.models,
      rawPricingTable,
      extraKeys,
      effectiveActiveSet,
      feedModelSet,
      knownPricedKeys,
      timestampSeconds
    );
    if (extracted.length > 0) {
      primaryKind = 'snapshot';
      primaryTier = normalizeCatalogTierLabel(input.snapshot.tier);
      primaryCandidates = extracted;
    }
  }

  if (!primaryKind && Array.isArray(input.activeAccount?.models) && input.activeAccount.models.length > 0) {
    const accKind: CatalogSourceKind = input.activeAccount.source === 'live' || input.activeAccount.source === 'account_live'
      ? 'account_live'
      : 'account_cloud';
    const extracted = extractCatalogModels(
      accKind,
      input.activeAccount.models,
      rawPricingTable,
      extraKeys,
      effectiveActiveSet,
      feedModelSet,
      knownPricedKeys,
      timestampSeconds
    );
    if (extracted.length > 0 || accKind === 'account_cloud') {
      primaryKind = accKind;
      primaryTier = normalizeCatalogTierLabel(input.activeAccount.tier);
      primaryCandidates = extracted;
    }
  }

  const primaryPricedMap = new Map<string, { pricing: ApiPricing; enabled: boolean; displayName: string; hostOrder?: number }>();
  const unpricedMap = new Map<string, {
    key: string;
    displayName: string;
    hasNonOrchestratorName: boolean;
    disabled: boolean;
    variants: Set<string>;
  }>();
  const recordUnpricedCandidate = (c: ExtractedCatalogCandidate, disabled: boolean) => {
    const existing = unpricedMap.get(c.canonicalKey);
    const incomingNonOrch = !c.isOrchestratorVariant && Boolean(c.displayName);
    const nextDisplayName = incomingNonOrch || !existing?.hasNonOrchestratorName
      ? resolveCatalogDisplayName(c.canonicalKey, c.displayName, existing?.displayName)
      : existing.displayName;
    const variants = existing?.variants ?? new Set<string>();
    if (c.variantLabel) variants.add(c.variantLabel);
    unpricedMap.set(c.canonicalKey, {
      key: c.canonicalKey,
      displayName: nextDisplayName,
      hasNonOrchestratorName: Boolean(existing?.hasNonOrchestratorName || incomingNonOrch),
      disabled: existing ? (existing.disabled && disabled) : disabled,
      variants,
    });
  };

  const isHostMenuOrdered = primaryKind === 'live' || primaryKind === 'snapshot' || primaryKind === 'account_live';
  if (primaryKind) {
    const allowUnpricedLive = isHostMenuOrdered;
    for (let idx = 0; idx < primaryCandidates.length; idx += 1) {
      const c = primaryCandidates[idx]!;
      if (c.resolvedPricing) {
        const existing = primaryPricedMap.get(c.canonicalKey);
        primaryPricedMap.set(c.canonicalKey, {
          pricing: existing?.pricing ?? c.resolvedPricing,
          enabled: (existing?.enabled ?? false) || !c.disabled,
          displayName: resolveCatalogDisplayName(c.canonicalKey, c.displayName, existing?.displayName),
          ...(existing?.hostOrder !== undefined
            ? { hostOrder: existing.hostOrder }
            : isHostMenuOrdered
              ? { hostOrder: idx }
              : {}),
        });
        unpricedMap.delete(c.canonicalKey);
      } else if (
        !primaryPricedMap.has(c.canonicalKey) &&
        (allowUnpricedLive ||
          (primaryKind === 'account_cloud' && !c.disabled && !feedModelSet.has(c.canonicalKey)))
      ) {
        recordUnpricedCandidate(c, c.disabled);
      }
    }

    if (primaryKind === 'account_cloud') {
      for (const activeKey of effectiveActiveSet) {
        if (primaryPricedMap.has(activeKey)) continue;
        const found = lookupPricingEntry(rawPricingTable, activeKey);
        const resolved = found ? resolvePricingForTimestamp(found.entry, timestampSeconds, found.key) : null;
        if (resolved) {
          primaryPricedMap.set(activeKey, {
            pricing: resolved,
            enabled: false,
            displayName: resolveCatalogDisplayName(activeKey),
          });
        }
      }
    }
  }

  const otherTierMap = new Map<string, { pricing: ApiPricing; displayName: string; tiers: Set<string> }>();
  for (const acc of input.poolAccounts ?? []) {
    if (!acc || !Array.isArray(acc.models) || acc.models.length === 0) continue;
    const accKind: CatalogSourceKind = acc.source === 'live' || acc.source === 'account_live'
      ? 'account_live'
      : 'account_cloud';
    const accTier = normalizeCatalogTierLabel(acc.tier);
    const extracted = extractCatalogModels(
      accKind,
      acc.models,
      rawPricingTable,
      extraKeys,
      effectiveActiveSet,
      feedModelSet,
      knownPricedKeys,
      timestampSeconds
    );
    for (const c of extracted) {
      if (c.disabled || primaryPricedMap.has(c.canonicalKey)) continue;
      if (!c.resolvedPricing) {
        if (!feedModelSet.has(c.canonicalKey)) {
          recordUnpricedCandidate(c, false);
        }
        continue;
      }
      let bucket = otherTierMap.get(c.canonicalKey);
      if (!bucket) {
        bucket = {
          pricing: c.resolvedPricing,
          displayName: resolveCatalogDisplayName(c.canonicalKey, c.displayName),
          tiers: new Set<string>(),
        };
        otherTierMap.set(c.canonicalKey, bucket);
      }
      if (accTier) bucket.tiers.add(accTier);
    }
  }

  // Cold-start fallback when neither Primary nor standby pool has any models
  if (!primaryKind && otherTierMap.size === 0) {
    for (const activeKey of effectiveActiveSet) {
      const found = lookupPricingEntry(rawPricingTable, activeKey);
      const resolved = found ? resolvePricingForTimestamp(found.entry, timestampSeconds, found.key) : null;
      if (resolved) {
        primaryPricedMap.set(activeKey, {
          pricing: resolved,
          enabled: true,
          displayName: resolveCatalogDisplayName(activeKey),
        });
      }
    }
  }

  const rawActivePrices: Record<string, ApiPricing> = {};
  const rawRetiredPrices: Record<string, ApiPricing> = {};
  const pricingStatus: Record<string, 'confirmed' | 'historical' | 'expired' | 'user'> = {};
  const modelCatalogState: Record<string, ModelCatalogEntryMeta> = {};

  for (const [key, info] of primaryPricedMap.entries()) {
    rawActivePrices[key] = info.pricing;
    pricingStatus[key] = priceStatus(info.pricing, effectiveNowMs);
    modelCatalogState[key] = {
      availability: info.enabled ? 'available' : 'tier_locked',
      displayName: info.displayName,
      ...(info.hostOrder !== undefined ? { hostOrder: info.hostOrder } : {}),
      ...(primaryTier ? { activeTier: primaryTier } : {}),
    };
  }

  for (const [key, info] of otherTierMap.entries()) {
    rawActivePrices[key] = info.pricing;
    pricingStatus[key] = priceStatus(info.pricing, effectiveNowMs);
    const tiers = [...info.tiers].sort(compareCatalogTiers);
    modelCatalogState[key] = {
      availability: 'other_tier_only',
      displayName: info.displayName,
      ...(tiers.length > 0 ? { availableInTiers: tiers } : {}),
      ...(primaryTier ? { activeTier: primaryTier } : {}),
    };
  }

  const unpricedLiveModels: UnpricedLiveModelEntry[] = Array.from(unpricedMap.values()).map((u) => {
    const variants = [...u.variants].sort(
      (a, b) => (UNPRICED_VARIANT_ORDER[a] ?? 99) - (UNPRICED_VARIANT_ORDER[b] ?? 99) || a.localeCompare(b)
    );
    return {
      key: u.key,
      displayName: u.displayName,
      disabled: u.disabled,
      ...(variants.length > 0 ? { variants } : {}),
    };
  });
  for (const u of unpricedLiveModels) {
    modelCatalogState[u.key] = {
      availability: 'unpriced_live',
      displayName: u.displayName,
      ...(primaryTier ? { activeTier: primaryTier } : {}),
    };
  }

  for (const key of publicCandidateKeys) {
    if (!key || FORBIDDEN_CATALOG_KEYS.has(key)) continue;
    const isPricedFlashLite = isPricedCatalogFlashLiteModel(key, key, knownPricedKeys);
    if (!effectiveActiveSet.has(key) && !isPricedFlashLite && isInternalNonChatModelId(key)) continue;
    if (Object.hasOwn(rawActivePrices, key)) continue;
    const entry = Object.hasOwn(rawPricingTable, key) ? rawPricingTable[key] : lookupPricingEntry(rawPricingTable, key)?.entry;
    if (!entry) continue;
    const resolved = resolvePricingForTimestamp(entry, timestampSeconds, key);
    if (!resolved) continue;
    rawRetiredPrices[key] = resolved;
    pricingStatus[key] = priceStatus(resolved, effectiveNowMs);
    modelCatalogState[key] = {
      availability: 'retired',
      displayName: getEffectiveModelDisplayName(key),
    };
  }

  return {
    prices: localizePricingTable(rawActivePrices, locale),
    retiredPrices: localizePricingTable(rawRetiredPrices, locale),
    pricingStatus,
    modelCatalogState,
    unpricedLiveModels,
  };
}

export function lookupPricingEntry(
  pricingTable: Record<string, ApiPricingEntry>,
  modelName: string
): { key: string; entry: ApiPricingEntry } | null {
  if (!modelName || modelName.includes('未知模型') || modelName.toLowerCase().includes('unknown')) {
    return null;
  }
  const direct = pricingTable[modelName];
  if (direct) return { key: modelName, entry: direct };
  const normalizedDirect = normalizeModelId(modelName);
  if (normalizedDirect && pricingTable[normalizedDirect]) {
    return { key: normalizedDirect, entry: pricingTable[normalizedDirect]! };
  }
  const canonicalKey = matchPricingKeysWithCandidates(modelName, getSortedPricingTableKeys(pricingTable));
  const matched = pricingTable[canonicalKey];
  if (matched) return { key: canonicalKey, entry: matched };
  return null;
}

export function resolvePricingFromTable(
  pricingTable: Record<string, ApiPricingEntry>,
  modelName: string,
  timestampSeconds: number
): ApiPricing | null {
  const found = lookupPricingEntry(pricingTable, modelName);
  if (!found) return null;
  return resolvePricingForTimestamp(found.entry, timestampSeconds, found.key);
}

const PLATFORM_EN_MAP: Record<string, string> = {
  'Google Cloud 标准 Global API': 'Google Cloud Standard Global API',
  'Anthropic 标准 API': 'Anthropic Standard API',
  'OpenAI 标准 API': 'OpenAI Standard API',
  '开放权重模型 API 参考基准': 'Open-Weight Model API Reference Benchmark',
};

function translateProvenanceConditionsToEn(text: string): string {
  if (!/[\u4e00-\u9fff]/.test(text)) return text;
  return text
    .replace(/Google Cloud 官方推广期标准 Global API 文本基准/g, 'Google Cloud official promotional Global API text benchmark')
    .replace(/Google Cloud 官方 ([A-Za-z0-9 ._-]+) 标准 Global API 文本基准/g, 'Google Cloud official $1 standard Global API text benchmark')
    .replace(/Google Cloud 官方 ([A-Za-z0-9 ._-]+) 高阶推理模型标准基准/g, 'Google Cloud official $1 reasoning model standard benchmark')
    .replace(/Google Cloud 官方 ([A-Za-z0-9 ._-]+) 标准文本基准/g, 'Google Cloud official $1 standard text benchmark')
    .replace(/Google Cloud 官方 ([A-Za-z0-9 ._-]+) 标准定价/g, 'Google Cloud official $1 standard pricing')
    .replace(/Anthropic 官方 ([A-Za-z0-9 ._-]+) 标准文本基准/g, 'Anthropic official $1 standard text benchmark')
    .replace(/Anthropic 官方 ([A-Za-z0-9 ._-]+) 标准 API 最新降价/g, 'Anthropic official $1 standard API updated pricing')
    .replace(/参考 ([A-Za-z0-9 ._-]+) 官方推广期文本基准做等效估算/g, 'Estimated from $1 official promotional text benchmark')
    .replace(/参考 ([A-Za-z0-9 ._-]+) 官方正式定价做等效估算/g, 'Estimated from $1 official standard pricing')
    .replace(/前期参考 ([A-Za-z0-9 ._-]+) 系列标准 API 文本基准估算/g, 'Previously estimated from $1 series standard API text benchmark')
    .replace(/前期参考 ([A-Za-z0-9 ._-]+) 标准 API 文本基准估算/g, 'Previously estimated from $1 standard API text benchmark')
    .replace(/参考同类开放权重 120B 模型公开 API 基准估算/g, 'Estimated from comparable open-weight 120B model public API benchmarks')
    .replace(/参考 ([A-Za-z0-9 ._-]+) 系列公开文本基准估算/g, 'Estimated from $1 series public text benchmark')
    .replace(/参考 ([A-Za-z0-9 ._-]+) 系列文本基准估算/g, 'Estimated from $1 series text benchmark')
    .replace(/参考 ([A-Za-z0-9 ._-]+) 标准 Global API 文本基准估算/g, 'Estimated from $1 standard Global API text benchmark')
    .replace(/参考 ([A-Za-z0-9 ._-]+) 标准文本基准估算/g, 'Estimated from $1 standard text benchmark')
    .replace(/基础 ([A-Za-z0-9 ._-]+) 文本参考价；内部 -n 标识按同系列 Flash 基准估算/g, 'Base $1 text reference rate; internal -n variant estimated from Flash series benchmark')
    .replace(/基础 ([A-Za-z0-9 ._-]+) 标准全量定价/g, 'Base $1 standard list pricing')
    .replace(/Google Cloud 标准文本参考价；(\d{4}-\d{2}-\d{2})为本地核价起点，不代表官方调价日期/g, 'Google Cloud standard text reference rate; $1 marks local audit baseline rather than an official price-change date')
    .replace(/Google Cloud 标准文本参考价（([A-Za-z0-9 ._-]+) 历史基准）/g, 'Google Cloud standard text reference rate ($1 historical benchmark)')
    .replace(/沿用历史基准；不代表所有区域、长上下文或缓存写入单价；需按来源逐项核对/g, 'Historical benchmark; excludes regional, long-context, or cache-write surcharges; verify against official source')
    .replace(/沿用历史基准；缓存读取 (\$[0-9.]+\/MTok)，缓存写入 (\$[0-9.]+\/MTok)/g, 'Historical benchmark; cache read $1, cache write $2')
    .replace(/文本基准；缓存读取 (\$[0-9.]+\/MTok)，缓存写入 (\$[0-9.]+\/MTok)；不含工具费用/g, 'Text benchmark; cache read $1, cache write $2; excludes tool charges')
    .replace(/文本基准；输入\/输出采用限时优惠；缓存采用缓存读取基准，优惠截至(\d{4}-\d{2}-\d{2})/g, 'Text benchmark; promotional input/output rate and cache-read rate through $1')
    .replace(/文本基准；输入\/输出采用限时优惠；优惠截至(\d{4}-\d{2}-\d{2})/g, 'Text benchmark; promotional input/output rate through $1')
    .replace(/文本基准；恢复为标准全量定价/g, 'Text benchmark; reverted to standard list pricing')
    .replace(/标准全量定价/g, 'Standard list pricing')
    .replace(/（优惠截至(\d{4}-\d{2}-\d{2})）/g, ' (promotional through $1)')
    .replace(/；优惠截至(\d{4}-\d{2}-\d{2})/g, '; promotional through $1')
    .replace(/（(\d{4}-\d{2}-\d{2})生效）/g, ' (effective $1)')
    .replace(/（<=200k Tokens；缓存写入 (\$[0-9.]+) 自 (\d{4}-\d{2}-\d{2}) 起生效）/g, ' (<=200k tokens; cache write $1 effective $2)')
    .replace(/（<=200k Tokens；含缓存写入 (\$[0-9.]+)）/g, ' (<=200k tokens; includes cache write $1)')
    .replace(/\(<=200k Tokens\)/g, '(<=200k tokens)')
    .replace(/（含 Medium \/ High \/ Thinking 变体）/g, ' (including Medium / High / Thinking variants)')
    .replace(/；/g, '; ');
}

export function localizePricingProvenance(
  provenance: ApiPricing['provenance'] | null | undefined,
  locale: string = getActiveLocale()
): ApiPricing['provenance'] | null | undefined {
  if (!provenance || locale !== 'en') return provenance;
  const nextPlatform =
    provenance.platformEn ??
    (provenance.platform ? (PLATFORM_EN_MAP[provenance.platform] ?? provenance.platform) : provenance.platform);
  const nextConditions =
    provenance.conditionsEn ??
    (provenance.conditions ? translateProvenanceConditionsToEn(provenance.conditions) : provenance.conditions);
  if (nextPlatform === provenance.platform && nextConditions === provenance.conditions) {
    return provenance;
  }
  return {
    ...provenance,
    ...(nextPlatform !== undefined ? { platform: nextPlatform } : {}),
    ...(nextConditions !== undefined ? { conditions: nextConditions } : {}),
  };
}

export function localizePricingTable(
  prices: Record<string, ApiPricing>,
  locale: string = getActiveLocale()
): Record<string, ApiPricing> {
  if (locale !== 'en') return prices;
  const out: Record<string, ApiPricing> = {};
  for (const [key, entry] of Object.entries(prices)) {
    out[key] = {
      ...entry,
      ...(entry.provenance ? { provenance: localizePricingProvenance(entry.provenance, locale) ?? undefined } : {}),
      ...(Array.isArray(entry.intervals)
        ? {
            intervals: entry.intervals.map((iv) => ({
              ...iv,
              ...(iv.provenance ? { provenance: localizePricingProvenance(iv.provenance, locale) ?? undefined } : {}),
            })),
          }
        : {}),
    };
  }
  return out;
}
