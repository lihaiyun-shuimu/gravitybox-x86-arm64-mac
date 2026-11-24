import { readFileSync } from 'node:fs';
import type { ApiPricingEntry } from './pricing.js';
import { bt } from './i18n.js';
import {
  normalizeModelId,
  stripModelProviderPrefix,
  TIERED_OR_THINKING_EFFORT_SUFFIX_RE,
} from './model-identity.js';

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MIN_REMOTE_CAPACITY_TOKENS = 4_096;
const MAX_REMOTE_CAPACITY_TOKENS = 10_000_000;
const MIN_OBSERVED_TOKENS = 1_024;
const MAX_OBSERVED_TOKENS = 10_000_000;
const PLACEHOLDER_ENUM_RE = /^MODEL_PLACEHOLDER_M(\d+)$/i;
const AMBIGUOUS_ORCHESTRATOR_WRAPPER_RE = /^(?:gemini-flash-worker(?:-agy)?|gemini-pro-orchestrator(?:-g1-pro)?|orchestrator)$/i;
const DISPLAY_EFFORT_SUFFIX_PAREN_RE =
  /\s*[（(]\s*(?:extra[\s-]*high|extra[\s-]*low|xhigh|extra|high|medium|low|minimal|thinking|max)\s*[）)]\s*$/i;
const DISPLAY_EFFORT_SUFFIX_SPACE_RE =
  /\s+(?:extra[\s-]*high|extra[\s-]*low|xhigh|extra|high|medium|low|minimal|thinking|max)\s*$/i;

export interface RemoteModelMetadataSpec {
  displayName?: string;
  capacityTokens?: number;
}

export interface ObservedIdeModelEntry {
  modelId: string;
  displayName?: string | null;
  modelOrAlias?: string | null;       // e.g. "MODEL_PLACEHOLDER_M532"
  modelEnum?: number | null;          // auto-derived from M(\d+) -> 1000 + parseInt(digits, 10) if omitted
  maxTokens?: number | null;
  maxOutputTokens?: number | null;
  modelProvider?: string | null;
  isInternal?: boolean;
  deprecated?: boolean;
  nonChatSpecialized?: boolean;
  inModelSelector?: boolean | null;
}

function loadBundledModelCatalog(): Record<string, any> {
  const candidates = [
    new URL('../assets/model-catalog.json', import.meta.url),
    new URL('../../model-catalog.json', import.meta.url),
  ];
  for (const url of candidates) {
    try {
      return JSON.parse(readFileSync(url, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    }
  }
  return JSON.parse(readFileSync(candidates[0]!, 'utf8'));
}

const catalog = loadBundledModelCatalog();
if (catalog.schema !== 1 || !catalog.names || !catalog.prices) throw Error(bt('model_catalog.err.invalid'));

export const MODEL_NAMES = Object.assign(Object.create(null), catalog.names) as Record<string, string>;
export const MODEL_CAPACITIES = Object.assign(
  Object.create(null),
  catalog.capacities && typeof catalog.capacities === 'object' ? catalog.capacities : {}
) as Record<string, number>;
export const MODEL_PRICES = Object.assign(Object.create(null), catalog.prices) as Record<string, ApiPricingEntry>;
export const MODEL_PRICE_ALIASES = catalog.aliases as Record<string, string>;
export const FEED_MODEL_KEYS = Object.freeze(Array.isArray(catalog.feedModels) ? [...catalog.feedModels] : []) as readonly string[];
export const ACTIVE_MODEL_KEYS = Object.freeze(Array.isArray(catalog.activeModels) ? [...catalog.activeModels] : [...FEED_MODEL_KEYS]) as readonly string[];
export const CATALOG_PRICING_VERSION = typeof catalog.pricingVersion === 'string' ? catalog.pricingVersion : '';
export const CATALOG_PRICING_UPDATED_AT = typeof catalog.pricingUpdatedAt === 'string' ? catalog.pricingUpdatedAt : '';

const remoteAliases: Record<string, string> = Object.create(null);
const remoteModelSpecs: Record<string, RemoteModelMetadataSpec> = Object.create(null);
let remoteActiveModelKeys: readonly string[] | null = null;
let remoteFeedModelKeys: readonly string[] | null = null;
let remoteAliasesTakeover = false;

function isSafeCatalogKey(raw: unknown): raw is string {
  return typeof raw === 'string' && raw.length > 0 && raw.length <= 128 && !FORBIDDEN_KEYS.has(raw);
}

export function sanitizeRemoteModelMetadata(raw: unknown): {
  aliases?: Record<string, string>;
  models?: Record<string, RemoteModelMetadataSpec>;
  activeModels?: string[];
  feedModels?: string[];
} {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const source = raw as Record<string, unknown>;
  let aliasesOut: Record<string, string> | undefined;
  if (source.aliases && typeof source.aliases === 'object' && !Array.isArray(source.aliases)) {
    aliasesOut = {};
    for (const [aliasKey, targetVal] of Object.entries(source.aliases as Record<string, unknown>)) {
      const cleanAlias = aliasKey.trim();
      const cleanTarget = typeof targetVal === 'string' ? targetVal.trim() : '';
      if (!isSafeCatalogKey(cleanAlias) || !isSafeCatalogKey(cleanTarget)) continue;
      aliasesOut[cleanAlias] = cleanTarget;
    }
  }
  let modelsOut: Record<string, RemoteModelMetadataSpec> | undefined;
  if (source.models && typeof source.models === 'object' && !Array.isArray(source.models)) {
    for (const [modelKey, metaVal] of Object.entries(source.models as Record<string, unknown>)) {
      const cleanKey = modelKey.trim().toLowerCase();
      if (!isSafeCatalogKey(cleanKey) || !metaVal || typeof metaVal !== 'object' || Array.isArray(metaVal)) continue;
      const rec = metaVal as Record<string, unknown>;
      const displayName = typeof rec.displayName === 'string' && rec.displayName.trim().length > 0 && rec.displayName.trim().length <= 128
        ? rec.displayName.trim()
        : undefined;
      const rawCap = rec.capacityTokens;
      const capacityTokens = typeof rawCap === 'number'
        && Number.isSafeInteger(rawCap)
        && rawCap >= MIN_REMOTE_CAPACITY_TOKENS
        && rawCap <= MAX_REMOTE_CAPACITY_TOKENS
        ? rawCap
        : undefined;
      if (!displayName && capacityTokens === undefined) continue;
      modelsOut ??= {};
      modelsOut[cleanKey] = {
        ...(displayName ? { displayName } : {}),
        ...(capacityTokens !== undefined ? { capacityTokens } : {}),
      };
    }
  }
  let activeModelsOut: string[] | undefined;
  if (Array.isArray(source.activeModels)) {
    const seen = new Set<string>();
    for (const item of source.activeModels) {
      const cleanKey = typeof item === 'string' ? item.trim() : '';
      if (!isSafeCatalogKey(cleanKey) || seen.has(cleanKey)) continue;
      seen.add(cleanKey);
      activeModelsOut ??= [];
      activeModelsOut.push(cleanKey);
    }
  }
  let feedModelsOut: string[] | undefined;
  if (Array.isArray(source.feedModels)) {
    const seen = new Set<string>();
    for (const item of source.feedModels) {
      const cleanKey = typeof item === 'string' ? item.trim() : '';
      if (!isSafeCatalogKey(cleanKey) || seen.has(cleanKey)) continue;
      seen.add(cleanKey);
      feedModelsOut ??= [];
      feedModelsOut.push(cleanKey);
    }
  }
  return {
    ...(aliasesOut !== undefined ? { aliases: aliasesOut } : {}),
    ...(modelsOut ? { models: modelsOut } : {}),
    ...(activeModelsOut ? { activeModels: activeModelsOut } : {}),
    ...(feedModelsOut ? { feedModels: feedModelsOut } : {}),
  };
}

export function registerRemoteModelMetadata(
  raw: unknown,
  options?: { onlyNewEntries?: boolean; authoritativeSnapshot?: boolean }
): void {
  const sanitized = sanitizeRemoteModelMetadata(raw);
  const onlyNew = options?.onlyNewEntries === true;
  const authoritative = options?.authoritativeSnapshot === true && !onlyNew;
  if (sanitized.aliases) {
    if (authoritative) {
      remoteAliasesTakeover = true;
    }
    for (const [aliasKey, target] of Object.entries(sanitized.aliases)) {
      if (onlyNew && Object.hasOwn(MODEL_PRICE_ALIASES, aliasKey)) continue;
      remoteAliases[aliasKey] = target;
      remoteAliases[aliasKey.toLowerCase()] = target;
    }
  }
  if (sanitized.models) {
    for (const [modelKey, spec] of Object.entries(sanitized.models)) {
      if (onlyNew && Object.hasOwn(MODEL_NAMES, modelKey)) continue;
      remoteModelSpecs[modelKey] = {
        ...(remoteModelSpecs[modelKey] ?? {}),
        ...spec,
      };
    }
  }
  if (sanitized.activeModels && sanitized.activeModels.length > 0 && !onlyNew) {
    remoteActiveModelKeys = Object.freeze([...sanitized.activeModels]);
  }
  if (sanitized.feedModels && sanitized.feedModels.length > 0 && !onlyNew) {
    remoteFeedModelKeys = Object.freeze([...sanitized.feedModels]);
  }
}

export function resetAndRegisterRemoteModelMetadata(
  raw: unknown,
  options?: { onlyNewEntries?: boolean; authoritativeSnapshot?: boolean }
): void {
  for (const key of Object.keys(remoteAliases)) {
    delete remoteAliases[key];
  }
  for (const key of Object.keys(remoteModelSpecs)) {
    delete remoteModelSpecs[key];
  }
  remoteActiveModelKeys = null;
  remoteFeedModelKeys = null;
  remoteAliasesTakeover = false;
  registerRemoteModelMetadata(raw, options);
}

export function getEffectiveActiveModelKeys(): readonly string[] {
  return remoteActiveModelKeys ?? ACTIVE_MODEL_KEYS;
}

export function getEffectiveFeedModelKeys(): readonly string[] {
  return remoteFeedModelKeys ?? FEED_MODEL_KEYS;
}

const observedByEnum = new Map<number, ObservedIdeModelEntry>();
const observedByExactKey = new Map<string, ObservedIdeModelEntry>();
const observedByBaseKey = new Map<string, ObservedIdeModelEntry>();
const observedByDisplayName = new Map<string, ObservedIdeModelEntry>();
const observedAliases: Record<string, string> = Object.create(null);
const observedDisplayNames: Record<string, string> = Object.create(null);

function deriveModelEnumFromPlaceholder(raw: string | null | undefined): number | null {
  if (typeof raw !== 'string') return null;
  const match = raw.trim().match(PLACEHOLDER_ENUM_RE);
  if (!match?.[1]) return null;
  const digits = Number.parseInt(match[1], 10);
  if (!Number.isSafeInteger(digits) || digits < 0) return null;
  return 1000 + digits;
}

function sanitizeObservedTokenLimit(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  const rounded = Math.trunc(raw);
  if (!Number.isSafeInteger(rounded) || rounded < MIN_OBSERVED_TOKENS || rounded > MAX_OBSERVED_TOKENS) {
    return null;
  }
  return rounded;
}

function stripDisplayEffortSuffix(displayName: string): string {
  let out = displayName.trim();
  for (let i = 0; i < 3; i += 1) {
    const next = out
      .replace(DISPLAY_EFFORT_SUFFIX_PAREN_RE, '')
      .replace(DISPLAY_EFFORT_SUFFIX_SPACE_RE, '')
      .trim();
    if (!next || next === out) break;
    out = next;
  }
  return out || displayName.trim();
}

function isOrchestratorDisplayName(displayName: string): boolean {
  const trimmed = displayName.trim();
  return /^orchestrator(?:\s*\(|\s+)/i.test(trimmed) || /\(\s*orchestrator\s*\)$/i.test(trimmed);
}

function mergeObservedEntry(
  existing: ObservedIdeModelEntry | undefined,
  incoming: ObservedIdeModelEntry
): ObservedIdeModelEntry {
  if (!existing) return incoming;
  return {
    modelId: incoming.modelId || existing.modelId,
    displayName: incoming.displayName ?? existing.displayName ?? null,
    modelOrAlias: incoming.modelOrAlias ?? existing.modelOrAlias ?? null,
    modelEnum: incoming.modelEnum ?? existing.modelEnum ?? null,
    maxTokens: incoming.maxTokens ?? existing.maxTokens ?? null,
    maxOutputTokens: incoming.maxOutputTokens ?? existing.maxOutputTokens ?? null,
    modelProvider: incoming.modelProvider ?? existing.modelProvider ?? null,
    ...(incoming.isInternal !== undefined
      ? { isInternal: incoming.isInternal }
      : existing.isInternal !== undefined
        ? { isInternal: existing.isInternal }
        : {}),
    ...(incoming.deprecated !== undefined
      ? { deprecated: incoming.deprecated }
      : existing.deprecated !== undefined
        ? { deprecated: existing.deprecated }
        : {}),
    ...(incoming.nonChatSpecialized !== undefined
      ? { nonChatSpecialized: incoming.nonChatSpecialized }
      : existing.nonChatSpecialized !== undefined
        ? { nonChatSpecialized: existing.nonChatSpecialized }
        : {}),
    ...(incoming.inModelSelector !== undefined
      ? { inModelSelector: incoming.inModelSelector }
      : existing.inModelSelector !== undefined
        ? { inModelSelector: existing.inModelSelector }
        : {}),
  };
}

function shouldPreferBaseObservedEntry(
  existing: ObservedIdeModelEntry | undefined,
  incoming: ObservedIdeModelEntry
): boolean {
  if (!existing) return true;
  const existingInternal = existing.isInternal === true || existing.nonChatSpecialized === true || existing.deprecated === true;
  const incomingInternal = incoming.isInternal === true || incoming.nonChatSpecialized === true || incoming.deprecated === true;
  if (existingInternal !== incomingInternal) return !incomingInternal;
  const existingInSel = existing.inModelSelector === true;
  const incomingInSel = incoming.inModelSelector === true;
  if (existingInSel !== incomingInSel) return incomingInSel;
  const existingDisabled = /(?:^|[-_])disabled$/i.test(existing.modelId);
  const incomingDisabled = /(?:^|[-_])disabled$/i.test(incoming.modelId);
  if (existingDisabled !== incomingDisabled) return !incomingDisabled;
  if (!existing.displayName && incoming.displayName) return true;
  if (!existing.maxTokens && incoming.maxTokens) return true;
  return false;
}

export function registerObservedIdeModels(entries: readonly ObservedIdeModelEntry[]): void {
  if (!Array.isArray(entries) || entries.length === 0) return;
  for (const raw of entries) {
    if (!raw || typeof raw !== 'object') continue;
    const rawId = typeof raw.modelId === 'string' ? raw.modelId.trim() : '';
    const rawAlias = typeof raw.modelOrAlias === 'string' && raw.modelOrAlias.trim() ? raw.modelOrAlias.trim() : null;
    const modelId = rawId || rawAlias || '';
    if (!isSafeCatalogKey(modelId)) continue;
    const modelOrAlias = rawAlias && isSafeCatalogKey(rawAlias) ? rawAlias : null;
    const explicitEnum = typeof raw.modelEnum === 'number' && Number.isSafeInteger(raw.modelEnum) && raw.modelEnum > 0
      ? raw.modelEnum
      : null;
    const modelEnum = explicitEnum
      ?? deriveModelEnumFromPlaceholder(modelOrAlias)
      ?? deriveModelEnumFromPlaceholder(modelId);
    const displayName = typeof raw.displayName === 'string' && raw.displayName.trim().length > 0 && raw.displayName.trim().length <= 128
      ? raw.displayName.trim()
      : null;
    const maxTokens = sanitizeObservedTokenLimit(raw.maxTokens);
    const maxOutputTokens = sanitizeObservedTokenLimit(raw.maxOutputTokens);
    const modelProvider = typeof raw.modelProvider === 'string' && raw.modelProvider.trim().length > 0 && raw.modelProvider.trim().length <= 128
      ? raw.modelProvider.trim()
      : null;
    const entry: ObservedIdeModelEntry = {
      modelId,
      displayName,
      modelOrAlias: modelOrAlias ?? (modelEnum !== null && modelEnum > 1000 ? `MODEL_PLACEHOLDER_M${modelEnum - 1000}` : null),
      modelEnum,
      maxTokens,
      maxOutputTokens,
      modelProvider,
      ...(typeof raw.isInternal === 'boolean' ? { isInternal: raw.isInternal } : {}),
      ...(typeof raw.deprecated === 'boolean' ? { deprecated: raw.deprecated } : {}),
      ...(typeof raw.nonChatSpecialized === 'boolean' ? { nonChatSpecialized: raw.nonChatSpecialized } : {}),
      ...(typeof raw.inModelSelector === 'boolean' || raw.inModelSelector === null ? { inModelSelector: raw.inModelSelector } : {}),
    };

    const strippedId = stripModelProviderPrefix(modelId) || modelId;
    const withoutDisabled = strippedId.replace(/(?:^|[-_])disabled$/i, '').trim();
    const normWithoutDisabled = withoutDisabled ? normalizeModelId(withoutDisabled) : '';
    const baseModelId = normWithoutDisabled
      ? normWithoutDisabled.replace(TIERED_OR_THINKING_EFFORT_SUFFIX_RE, '')
      : '';

    const mergedByEnum = modelEnum !== null ? mergeObservedEntry(observedByEnum.get(modelEnum), entry) : entry;
    if (modelEnum !== null) {
      observedByEnum.set(modelEnum, mergedByEnum);
    }

    const indexExact = (k: string | null | undefined, overwrite: boolean) => {
      if (!k) return;
      const lower = k.trim().toLowerCase();
      if (!isSafeCatalogKey(lower)) return;
      const prev = observedByExactKey.get(lower);
      if (!prev || overwrite || shouldPreferBaseObservedEntry(prev, mergedByEnum)) {
        observedByExactKey.set(lower, mergeObservedEntry(prev, mergedByEnum));
      }
    };

    const isDisabledId = /(?:^|[-_])disabled$/i.test(strippedId);
    indexExact(modelId, true);
    indexExact(strippedId, true);
    if (withoutDisabled && withoutDisabled !== strippedId) {
      indexExact(withoutDisabled, !isDisabledId);
    }
    if (normWithoutDisabled && normWithoutDisabled !== withoutDisabled.toLowerCase()) {
      indexExact(normWithoutDisabled, !isDisabledId);
    }
    if (mergedByEnum.modelOrAlias) {
      indexExact(mergedByEnum.modelOrAlias, true);
    }

    const isWrapperOrPlaceholder = !baseModelId
      || PLACEHOLDER_ENUM_RE.test(withoutDisabled)
      || AMBIGUOUS_ORCHESTRATOR_WRAPPER_RE.test(withoutDisabled)
      || AMBIGUOUS_ORCHESTRATOR_WRAPPER_RE.test(baseModelId);

    if (!isWrapperOrPlaceholder && isSafeCatalogKey(baseModelId)) {
      const prevBase = observedByBaseKey.get(baseModelId);
      const nextBase = shouldPreferBaseObservedEntry(prevBase, mergedByEnum)
        ? mergeObservedEntry(prevBase, mergedByEnum)
        : mergeObservedEntry(mergedByEnum, prevBase!);
      observedByBaseKey.set(baseModelId, nextBase);
    }

    if (displayName) {
      const lowerDisp = displayName.toLowerCase();
      if (isSafeCatalogKey(lowerDisp)) {
        const prevDisp = observedByDisplayName.get(lowerDisp);
        if (!prevDisp || shouldPreferBaseObservedEntry(prevDisp, mergedByEnum)) {
          observedByDisplayName.set(lowerDisp, mergeObservedEntry(prevDisp, mergedByEnum));
        }
      }
      if (!isOrchestratorDisplayName(displayName)) {
        const strippedDisp = stripDisplayEffortSuffix(displayName);
        const lowerStripped = strippedDisp.toLowerCase();
        if (isSafeCatalogKey(lowerStripped) && lowerStripped !== lowerDisp) {
          const prevStripped = observedByDisplayName.get(lowerStripped);
          if (!prevStripped || shouldPreferBaseObservedEntry(prevStripped, mergedByEnum)) {
            observedByDisplayName.set(lowerStripped, mergeObservedEntry(prevStripped, mergedByEnum));
          }
        }
      }
    }

    // Alias mapping: MODEL_PLACEHOLDER_M* -> canonical base model ID
    const aliasKey = mergedByEnum.modelOrAlias;
    if (aliasKey && isSafeCatalogKey(aliasKey) && !isWrapperOrPlaceholder && isSafeCatalogKey(baseModelId)) {
      const aliasTarget =
        (Object.hasOwn(remoteAliases, baseModelId) ? remoteAliases[baseModelId] : undefined)
        ?? (!remoteAliasesTakeover && Object.hasOwn(MODEL_PRICE_ALIASES, baseModelId) ? MODEL_PRICE_ALIASES[baseModelId] : undefined)
        ?? baseModelId;
      if (aliasTarget && isSafeCatalogKey(aliasTarget) && !PLACEHOLDER_ENUM_RE.test(aliasTarget)) {
        observedAliases[aliasKey] = aliasTarget;
        observedAliases[aliasKey.toLowerCase()] = aliasTarget;
      }
    }

    // Display name mapping (skip raw-id-as-label & internal models)
    if (displayName && entry.isInternal !== true && entry.nonChatSpecialized !== true) {
      if (displayName.toLowerCase() !== modelId.toLowerCase()) {
        observedDisplayNames[modelId] = displayName;
        observedDisplayNames[modelId.toLowerCase()] = displayName;
      }
      if (aliasKey && displayName.toLowerCase() !== aliasKey.toLowerCase()) {
        observedDisplayNames[aliasKey] = displayName;
        observedDisplayNames[aliasKey.toLowerCase()] = displayName;
      }
      if (!isWrapperOrPlaceholder && !isOrchestratorDisplayName(displayName) && isSafeCatalogKey(baseModelId)) {
        const cleanBaseDisp = stripDisplayEffortSuffix(displayName);
        if (cleanBaseDisp && cleanBaseDisp.toLowerCase() !== baseModelId.toLowerCase()) {
          observedDisplayNames[baseModelId] = cleanBaseDisp;
        }
      }
    }
  }
}

export function resolveObservedModelByEnum(modelEnum: number): ObservedIdeModelEntry | null {
  if (typeof modelEnum !== 'number' || !Number.isSafeInteger(modelEnum) || modelEnum <= 0) return null;
  return observedByEnum.get(modelEnum) ?? null;
}

export function resolveObservedModelByIdOrAlias(raw: string): ObservedIdeModelEntry | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (!isSafeCatalogKey(lower)) return null;

  const direct = observedByExactKey.get(lower);
  if (direct) return direct;

  const enumFromRaw = deriveModelEnumFromPlaceholder(trimmed);
  if (enumFromRaw !== null) {
    const byEnum = observedByEnum.get(enumFromRaw);
    if (byEnum) return byEnum;
  }

  const stripped = stripModelProviderPrefix(trimmed) || trimmed;
  const strippedLower = stripped.toLowerCase();
  if (strippedLower !== lower && isSafeCatalogKey(strippedLower)) {
    const byStripped = observedByExactKey.get(strippedLower);
    if (byStripped) return byStripped;
  }

  const withoutDisabled = stripped.replace(/(?:^|[-_])disabled$/i, '').trim();
  const norm = withoutDisabled ? normalizeModelId(withoutDisabled) : '';
  if (norm && isSafeCatalogKey(norm)) {
    const byNorm = observedByExactKey.get(norm);
    if (byNorm) return byNorm;
    const base = norm.replace(TIERED_OR_THINKING_EFFORT_SUFFIX_RE, '');
    if (base && isSafeCatalogKey(base)) {
      const byBase = observedByBaseKey.get(base) ?? observedByExactKey.get(base);
      if (byBase) return byBase;
    }
  }

  const byDisplay = observedByDisplayName.get(lower);
  if (byDisplay) return byDisplay;

  const strippedDisp = stripDisplayEffortSuffix(trimmed).toLowerCase();
  if (strippedDisp && strippedDisp !== lower && isSafeCatalogKey(strippedDisp)) {
    const byStrippedDisp = observedByDisplayName.get(strippedDisp);
    if (byStrippedDisp) return byStrippedDisp;
  }

  return null;
}

export function clearObservedIdeModelsForTest(): void {
  observedByEnum.clear();
  observedByExactKey.clear();
  observedByBaseKey.clear();
  observedByDisplayName.clear();
  for (const key of Object.keys(observedAliases)) {
    delete observedAliases[key];
  }
  for (const key of Object.keys(observedDisplayNames)) {
    delete observedDisplayNames[key];
  }
}

export function getEffectiveModelAliasKeys(): string[] {
  const aliasKeys = remoteAliasesTakeover
    ? Object.keys(remoteAliases)
    : [...Object.keys(MODEL_PRICE_ALIASES), ...Object.keys(remoteAliases)];
  return Array.from(new Set([
    ...Object.keys(MODEL_NAMES),
    ...aliasKeys,
    ...Object.keys(remoteModelSpecs),
    ...Object.keys(observedAliases),
    ...observedByBaseKey.keys(),
  ]));
}

export function getEffectiveModelDisplayName(key: string): string {
  if (!key || FORBIDDEN_KEYS.has(key)) return key;
  const lower = key.toLowerCase();
  return getRemoteModelSpec(key)?.displayName
    ?? (Object.hasOwn(observedDisplayNames, key) ? observedDisplayNames[key] : undefined)
    ?? (Object.hasOwn(observedDisplayNames, lower) ? observedDisplayNames[lower] : undefined)
    ?? MODEL_NAMES[key]
    ?? MODEL_NAMES[lower]
    ?? key;
}

export function getEffectiveModelPriceAlias(key: string): string | undefined {
  if (!key || FORBIDDEN_KEYS.has(key)) return undefined;
  if (Object.hasOwn(remoteAliases, key)) return remoteAliases[key];
  const lower = key.toLowerCase();
  if (Object.hasOwn(remoteAliases, lower)) return remoteAliases[lower];
  const obsAlias = Object.hasOwn(observedAliases, key)
    ? observedAliases[key]
    : Object.hasOwn(observedAliases, lower)
      ? observedAliases[lower]
      : undefined;
  if (obsAlias) {
    const obsLower = obsAlias.toLowerCase();
    if (Object.hasOwn(remoteAliases, obsAlias)) return remoteAliases[obsAlias];
    if (Object.hasOwn(remoteAliases, obsLower)) return remoteAliases[obsLower];
    if (!remoteAliasesTakeover) {
      if (Object.hasOwn(MODEL_PRICE_ALIASES, obsAlias)) return MODEL_PRICE_ALIASES[obsAlias];
      if (Object.hasOwn(MODEL_PRICE_ALIASES, obsLower)) return MODEL_PRICE_ALIASES[obsLower];
    }
    return obsAlias;
  }
  if (remoteAliasesTakeover) return undefined;
  if (Object.hasOwn(MODEL_PRICE_ALIASES, key)) return MODEL_PRICE_ALIASES[key];
  if (Object.hasOwn(MODEL_PRICE_ALIASES, lower)) return MODEL_PRICE_ALIASES[lower];
  return undefined;
}

export function getRemoteModelSpec(normalizedId: string): RemoteModelMetadataSpec | undefined {
  if (!normalizedId || FORBIDDEN_KEYS.has(normalizedId)) return undefined;
  const lower = normalizedId.toLowerCase();
  return Object.hasOwn(remoteModelSpecs, lower) ? remoteModelSpecs[lower] : undefined;
}
