import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { atomicJson, readOptionalJson } from './files.js';
import { APP_VERSION } from './version.js';
import {
  FEED_MODEL_KEYS,
  resetAndRegisterRemoteModelMetadata,
  sanitizeRemoteModelMetadata,
} from './model-catalog.js';
import {
  DEFAULT_API_PRICES,
  DEFAULT_PRICING_FEED_URLS,
  PRICING_METADATA,
  isInternalNonChatModelId,
  mergePricingEntries,
  resolvePricingFromTable,
  validateRawPrices,
  type ApiPricing,
  type ApiPricingEntry,
  type ApiPricingInterval,
} from './pricing.js';
import { bt } from './i18n.js';
import { resolveOutboundFetch } from './proxy.js';

export interface PricingSyncMutableState {
  lastRemoteSyncAt: number;
  lastSyncSuccess: boolean;
  lastCheckAt: number;
  lastCheckSuccess: boolean;
  nextAutoSyncAt: number;
  lastSyncError: string | null;
  lastSyncedSourceUrl: string;
  lastSyncedVersion: string;
  lastSyncedUpdatedAt?: string;
  lastSyncedEtag?: string;
  lastSyncedSha256?: string;
}

export function compareDatedFeedVersion(left: string, right: string): number | null {
  const pattern = /^(\d{4}-\d{2}-\d{2})(?:[.-]r?(\d+))?$/i;
  const leftMatch = left.trim().match(pattern);
  const rightMatch = right.trim().match(pattern);
  if (!leftMatch || !rightMatch) return null;
  const dateDiff = leftMatch[1]!.localeCompare(rightMatch[1]!);
  if (dateDiff !== 0) return dateDiff;
  const leftRev = leftMatch[2] ? Number.parseInt(leftMatch[2], 10) : 0;
  const rightRev = rightMatch[2] ? Number.parseInt(rightMatch[2], 10) : 0;
  return leftRev - rightRev;
}

export function compareFeedFreshness(
  incoming: { version?: string | null; updatedAt?: string | null },
  baseline: { version?: string | null; updatedAt?: string | null }
): number | null {
  const verDiff = compareDatedFeedVersion(String(incoming.version ?? ''), String(baseline.version ?? ''));
  if (verDiff === null) return null;
  if (verDiff !== 0) return verDiff;
  const inUpdated = typeof incoming.updatedAt === 'string' ? incoming.updatedAt.trim() : '';
  const baseUpdated = typeof baseline.updatedAt === 'string' ? baseline.updatedAt.trim() : '';
  if (inUpdated && baseUpdated) {
    const inMs = Date.parse(inUpdated);
    const baseMs = Date.parse(baseUpdated);
    if (Number.isFinite(inMs) && Number.isFinite(baseMs) && inMs !== baseMs) {
      return inMs > baseMs ? 1 : -1;
    }
  }
  return 0;
}

export async function loadRawPricingTable(
  remotePricingCachePath: string,
  pricingCachePath: string
): Promise<{
  merged: Record<string, ApiPricingEntry>;
  billingPrices: Record<string, ApiPricingEntry>;
  warnings: string[];
  publicKeys: Set<string>;
}> {
  const warnings: string[] = [];
  const merged: Record<string, ApiPricingEntry> = Object.assign(Object.create(null), DEFAULT_API_PRICES);
  const publicKeys = new Set<string>(FEED_MODEL_KEYS);

  // 1. 尝试合并本地远程缓存（禁止早于内置目录日期的旧远端缓存降级覆盖较新的官方目录）
  resetAndRegisterRemoteModelMetadata({});
  try {
    const rawRemote = await readFile(remotePricingCachePath, 'utf8');
    const parsedRemote = JSON.parse(rawRemote);
    const remotePrices = parsedRemote && typeof parsedRemote === 'object' && parsedRemote.prices ? parsedRemote.prices : parsedRemote;
    const remoteVer = typeof parsedRemote?.feedVersion === 'string' ? parsedRemote.feedVersion.trim() : '';
    const remoteUpdatedAt = typeof parsedRemote?.feedUpdatedAt === 'string'
      ? parsedRemote.feedUpdatedAt.trim()
      : (typeof parsedRemote?.updatedAt === 'string' ? parsedRemote.updatedAt.trim() : '');
    const cmpToBuiltin = compareFeedFreshness(
      { version: remoteVer, updatedAt: remoteUpdatedAt },
      { version: PRICING_METADATA.version, updatedAt: PRICING_METADATA.updatedAt }
    );
    const isOlderDatedFeed = cmpToBuiltin !== null && cmpToBuiltin < 0;
    resetAndRegisterRemoteModelMetadata(parsedRemote, {
      onlyNewEntries: isOlderDatedFeed,
      authoritativeSnapshot: !isOlderDatedFeed,
    });
    const remoteMeta = sanitizeRemoteModelMetadata(parsedRemote);
    const remotePriceObj = remotePrices && typeof remotePrices === 'object' && !Array.isArray(remotePrices)
      ? remotePrices as Record<string, unknown>
      : null;
    if (!isOlderDatedFeed && Array.isArray(remoteMeta.feedModels) && remoteMeta.feedModels.length > 0) {
      const remoteFeedSet = new Set(remoteMeta.feedModels);
      for (const builtinPublicKey of FEED_MODEL_KEYS) {
        if (!remoteFeedSet.has(builtinPublicKey) && (!remotePriceObj || !Object.hasOwn(remotePriceObj, builtinPublicKey))) {
          delete merged[builtinPublicKey];
        }
      }
      publicKeys.clear();
      for (const k of remoteMeta.feedModels) {
        if (!isInternalNonChatModelId(k)) publicKeys.add(k);
      }
    }
    if (remotePriceObj) {
      const filteredRemote = isOlderDatedFeed
        ? Object.fromEntries(Object.entries(remotePriceObj).filter(([k]) => !Object.hasOwn(merged, k)))
        : remotePriceObj;
      const remoteAccepted = new Set<string>();
      mergePricingEntries(merged, filteredRemote, bt('pricing.warn.remote_entry_prefix'), warnings, remoteAccepted);
      for (const k of remoteAccepted) {
        if (!isInternalNonChatModelId(k)) publicKeys.add(k);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      warnings.push(bt('pricing.warn.remote_cache_unreadable'));
    }
  }

  // 2. 尝试合并用户自定义价格缓存（最高优先级）
  try {
    const rawCustom = await readFile(pricingCachePath, 'utf8');
    const cached = JSON.parse(rawCustom);
    if (cached && typeof cached === 'object' && !Array.isArray(cached)) {
      const customAccepted = new Set<string>();
      mergePricingEntries(merged, cached, bt('pricing.warn.custom_entry_prefix'), warnings, customAccepted);
      for (const k of customAccepted) {
        if (!isInternalNonChatModelId(k)) publicKeys.add(k);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      warnings.push(bt('pricing.warn.custom_unreadable'));
    }
  }

  const billingPrices: Record<string, ApiPricingEntry> = Object.assign(
    Object.create(null),
    DEFAULT_API_PRICES,
    merged
  );

  return { merged, billingPrices, warnings, publicKeys };
}

export function resolvePricingTableFromRaw(
  raw: Record<string, ApiPricingEntry>,
  timestampSeconds = Math.floor(Date.now() / 1000),
  allowedKeys?: Set<string>
): Record<string, ApiPricing> {
  const resolved: Record<string, ApiPricing> = Object.create(null);
  for (const key of Object.keys(raw)) {
    if (allowedKeys && !allowedKeys.has(key)) continue;
    const p = resolvePricingFromTable(raw, key, timestampSeconds);
    if (p) resolved[key] = p;
  }
  return resolved;
}

export async function loadPricingSyncState(
  remotePricingCachePath: string,
  pricingSyncStatePath: string,
  state: PricingSyncMutableState
): Promise<void> {
  if (!state.lastRemoteSyncAt) {
    const data = await readOptionalJson<{
      syncedAt?: string;
      sourceUrl?: string;
      feedVersion?: string;
      feedUpdatedAt?: string;
      updatedAt?: string;
      sha256?: string;
    }>(
      remotePricingCachePath,
      'remote-pricing-cache.json'
    );
    if (data?.syncedAt) {
      state.lastRemoteSyncAt = Date.parse(data.syncedAt) || 0;
      state.lastSyncSuccess = true;
      state.lastSyncedSourceUrl = data.sourceUrl ?? '';
      state.lastSyncedVersion = data.feedVersion ?? '';
      state.lastSyncedUpdatedAt = data.feedUpdatedAt ?? data.updatedAt ?? '';
      state.lastSyncedSha256 = typeof data.sha256 === 'string' ? data.sha256 : '';
    }
  }
  const checkData = await readOptionalJson<{
    lastCheckAt?: number;
    lastCheckSuccess?: boolean;
    lastSyncError?: string | null;
    lastSyncedVersion?: string;
    lastSyncedUpdatedAt?: string;
    lastSyncedSourceUrl?: string;
    lastSyncedEtag?: string;
    lastSyncedSha256?: string;
  }>(
    pricingSyncStatePath,
    'pricing-sync-state.json'
  );
  if (checkData && typeof checkData === 'object') {
    if (typeof checkData.lastCheckAt === 'number' && Number.isFinite(checkData.lastCheckAt)) {
      state.lastCheckAt = checkData.lastCheckAt;
    }
    if (typeof checkData.lastCheckSuccess === 'boolean') {
      state.lastCheckSuccess = checkData.lastCheckSuccess;
    }
    if (typeof checkData.lastSyncError === 'string' || checkData.lastSyncError === null) {
      state.lastSyncError = checkData.lastSyncError;
    }
    if (!state.lastSyncedVersion && typeof checkData.lastSyncedVersion === 'string') {
      state.lastSyncedVersion = checkData.lastSyncedVersion;
    }
    if (!state.lastSyncedUpdatedAt && typeof checkData.lastSyncedUpdatedAt === 'string') {
      state.lastSyncedUpdatedAt = checkData.lastSyncedUpdatedAt;
    }
    if (!state.lastSyncedSourceUrl && typeof checkData.lastSyncedSourceUrl === 'string') {
      state.lastSyncedSourceUrl = checkData.lastSyncedSourceUrl;
    }
    if (typeof checkData.lastSyncedEtag === 'string') {
      state.lastSyncedEtag = checkData.lastSyncedEtag;
    }
    if (!state.lastSyncedSha256 && typeof checkData.lastSyncedSha256 === 'string') {
      state.lastSyncedSha256 = checkData.lastSyncedSha256;
    }
  }
  if (!state.nextAutoSyncAt) {
    const lastAttemptAt = Math.max(state.lastCheckAt, state.lastRemoteSyncAt);
    if (lastAttemptAt > 0) {
      const cooldown = state.lastCheckAt > state.lastRemoteSyncAt && !state.lastCheckSuccess ? 300_000 : 86_400_000;
      state.nextAutoSyncAt = lastAttemptAt + cooldown;
    }
  }
}

export function selectRemotePricingCandidateUrls(options: {
  feedUrl?: string;
  customRemoteUrlConfigured: boolean;
  remotePricingUrl: string;
  fallbackPricingUrls: string[];
}): string[] {
  const { feedUrl, customRemoteUrlConfigured, remotePricingUrl, fallbackPricingUrls } = options;
  if (feedUrl) return [feedUrl];
  if (customRemoteUrlConfigured && fallbackPricingUrls === DEFAULT_PRICING_FEED_URLS) return [remotePricingUrl];
  if (remotePricingUrl && !fallbackPricingUrls.includes(remotePricingUrl)) return [remotePricingUrl, ...fallbackPricingUrls];
  return fallbackPricingUrls;
}

const MAX_PRICING_FEED_BYTES = 2 * 1024 * 1024;
const MAX_PRICING_FEED_REDIRECTS = 3;

function isLoopbackHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
}

export function assertAllowedPricingFeedUrl(rawUrl: unknown): string {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) throw new Error(bt('pricing.err.url_invalid'));
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error(bt('pricing.err.url_format_invalid'));
  }
  if (parsed.username || parsed.password) throw new Error(bt('pricing.err.url_credentials_forbidden'));
  if (parsed.protocol === 'https:') return parsed.href;
  if (parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname)) {
    return parsed.href;
  }
  throw new Error(bt('pricing.err.https_trusted_only'));
}

interface FetchedFeedResult {
  notModified: boolean;
  bytes?: Uint8Array;
  etag: string | null;
}

async function fetchBoundedPricingFeed(
  initialUrl: string,
  signal: AbortSignal,
  options?: { etag?: string | null; force?: boolean }
): Promise<FetchedFeedResult> {
  let currentUrl = assertAllowedPricingFeedUrl(initialUrl);
  const initialIsHttps = new URL(currentUrl).protocol === 'https:';
  let res: Response | null = null;
  for (let hop = 0; hop <= MAX_PRICING_FEED_REDIRECTS; hop += 1) {
    const parsedCurrent = new URL(currentUrl);
    const headers: Record<string, string> = {
      'User-Agent': `GravityBox/${APP_VERSION}`,
    };
    if (parsedCurrent.hostname === 'api.github.com') {
      headers['Accept'] = 'application/vnd.github.raw+json';
      headers['X-GitHub-Api-Version'] = '2022-11-28';
    } else {
      headers['Accept'] = 'application/json';
    }
    if (options?.etag) {
      headers['If-None-Match'] = options.etag;
    }
    if (options?.force) {
      headers['Cache-Control'] = 'no-cache';
    }
    const outboundFetch = resolveOutboundFetch(globalThis.fetch);
    res = await outboundFetch(currentUrl, {
      signal,
      redirect: 'manual',
      headers,
    });
    if (res.status >= 300 && res.status < 400 && res.status !== 304) {
      const loc = res.headers?.get?.('location');
      if (!loc) throw new Error(`HTTP ${res.status}`);
      const nextUrl = assertAllowedPricingFeedUrl(new URL(loc, currentUrl).href);
      const parsedNext = new URL(nextUrl);
      if (initialIsHttps && parsedNext.protocol !== 'https:') {
        throw new Error(bt('pricing.err.https_trusted_only'));
      }
      currentUrl = nextUrl;
      continue;
    }
    break;
  }
  if (!res) throw new Error(bt('pricing.err.url_invalid'));
  if (res.status >= 300 && res.status < 400 && res.status !== 304) {
    throw new Error(bt('pricing.err.too_many_redirects'));
  }
  if (res.url) {
    const verifiedFinal = assertAllowedPricingFeedUrl(res.url);
    if (initialIsHttps && new URL(verifiedFinal).protocol !== 'https:') {
      throw new Error(bt('pricing.err.https_trusted_only'));
    }
  }
  const responseEtag = res.headers?.get?.('etag') ?? null;
  if (res.status === 304) {
    return { notModified: true, etag: responseEtag ?? options?.etag ?? null };
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const contentLen = Number(res.headers.get('content-length') ?? 0);
  if (Number.isFinite(contentLen) && contentLen > MAX_PRICING_FEED_BYTES) {
    throw new Error(bt('pricing.err.response_too_large'));
  }
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        totalBytes += value.byteLength;
        if (totalBytes > MAX_PRICING_FEED_BYTES) {
          await reader.cancel().catch(() => {});
          throw new Error(bt('pricing.err.response_too_large'));
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const merged = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { notModified: false, bytes: merged, etag: responseEtag };
  }
  const rawBuf = await res.arrayBuffer();
  if (rawBuf.byteLength > MAX_PRICING_FEED_BYTES) {
    throw new Error(bt('pricing.err.response_too_large'));
  }
  return { notModified: false, bytes: new Uint8Array(rawBuf), etag: responseEtag };
}

function parseFetchedFeedBytes(rawBytes: Uint8Array): { data: any; sha256: string } {
  let effectiveBytes = rawBytes;
  let data = JSON.parse(new TextDecoder('utf-8').decode(effectiveBytes));
  if (
    data &&
    typeof data === 'object' &&
    !Array.isArray(data) &&
    !data.prices &&
    typeof data.content === 'string' &&
    data.encoding === 'base64'
  ) {
    effectiveBytes = new Uint8Array(Buffer.from(data.content, 'base64'));
    if (effectiveBytes.byteLength > MAX_PRICING_FEED_BYTES) {
      throw new Error(bt('pricing.err.response_too_large'));
    }
    data = JSON.parse(new TextDecoder('utf-8').decode(effectiveBytes));
  }
  const sha256 = createHash('sha256').update(effectiveBytes).digest('hex');
  return { data, sha256 };
}

function persistPricingSyncStatus(
  pricingSyncStatePath: string,
  state: PricingSyncMutableState
): Promise<void> {
  return atomicJson(pricingSyncStatePath, {
    lastCheckAt: state.lastCheckAt,
    lastCheckSuccess: state.lastCheckSuccess,
    lastSyncError: state.lastSyncError,
    lastSyncedVersion: state.lastSyncedVersion,
    lastSyncedUpdatedAt: state.lastSyncedUpdatedAt ?? '',
    lastSyncedSourceUrl: state.lastSyncedSourceUrl,
    lastSyncedEtag: state.lastSyncedEtag ?? '',
    lastSyncedSha256: state.lastSyncedSha256 ?? '',
  }).catch(() => {});
}

async function isRemotePricingCacheValid(cachePath: string): Promise<boolean> {
  try {
    const raw = await readFile(cachePath, 'utf8');
    if (!raw.trim()) return false;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const prices = (parsed as Record<string, unknown>).prices;
    if (!prices || typeof prices !== 'object' || Array.isArray(prices)) return false;
    validateRawPrices(prices);
    return true;
  } catch {
    return false;
  }
}

function isCdnMirrorUrl(rawUrl: string): boolean {
  try {
    return new URL(rawUrl).hostname.toLowerCase() === 'cdn.jsdelivr.net';
  } catch {
    return false;
  }
}

export async function executeRemotePricingSync(options: {
  candidateUrls: string[];
  remotePricingCachePath: string;
  pricingSyncStatePath: string;
  state: PricingSyncMutableState;
  now: number;
  force?: boolean;
}): Promise<{ synced: boolean; unchanged?: boolean; error?: string; count?: number; sourceUrl?: string; version?: string; updatedAt?: string }> {
  const { candidateUrls, remotePricingCachePath, pricingSyncStatePath, state, now, force } = options;
  const cacheValid = await isRemotePricingCacheValid(remotePricingCachePath);
  let lastError: any = null;
  let deferredCdnUnchanged:
    | (() => Promise<{ synced: boolean; unchanged?: boolean; count?: number; sourceUrl?: string; version?: string; updatedAt?: string }>)
    | null = null;
  for (let idx = 0; idx < candidateUrls.length; idx++) {
    const targetUrl = candidateUrls[idx]!;
    const shouldProbeNextOnUnchanged = idx + 1 < candidateUrls.length && isCdnMirrorUrl(targetUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const canUseEtag = Boolean(
        cacheValid &&
        !force &&
        state.lastSyncedEtag &&
        (!state.lastSyncedSourceUrl || targetUrl === state.lastSyncedSourceUrl)
      );
      const fetched = await fetchBoundedPricingFeed(targetUrl, controller.signal, {
        etag: canUseEtag ? state.lastSyncedEtag : null,
        force,
      });
      if (fetched.notModified) {
        const finalizeNotModified = async () => {
          state.lastRemoteSyncAt = now;
          state.lastCheckAt = now;
          state.nextAutoSyncAt = now + 86_400_000;
          state.lastSyncSuccess = true;
          state.lastCheckSuccess = true;
          state.lastSyncError = null;
          state.lastSyncedSourceUrl = targetUrl;
          if (fetched.etag) state.lastSyncedEtag = fetched.etag;
          await persistPricingSyncStatus(pricingSyncStatePath, state);
          return {
            synced: true,
            unchanged: true,
            sourceUrl: targetUrl,
            version: state.lastSyncedVersion || PRICING_METADATA.version,
            updatedAt: state.lastSyncedUpdatedAt || PRICING_METADATA.updatedAt,
          };
        };
        if (shouldProbeNextOnUnchanged) {
          deferredCdnUnchanged = finalizeNotModified;
          continue;
        }
        return await finalizeNotModified();
      }
      const { data, sha256 } = parseFetchedFeedBytes(fetched.bytes!);
      if (data && typeof data === 'object' && !Array.isArray(data) && data.schema !== undefined && data.schema !== 1) {
        throw new Error(bt('pricing.err.table_invalid'));
      }
      const prices = data && typeof data === 'object' && data.prices ? data.prices : data;
      const validated = validateRawPrices(prices);
      const remoteMeta = sanitizeRemoteModelMetadata(data);
      const feedVersion = (data && typeof data === 'object' && typeof data.version === 'string') ? data.version.trim() : 'unknown';
      const feedUpdatedAt = (data && typeof data === 'object' && typeof data.updatedAt === 'string') ? data.updatedAt.trim() : '';
      const cmpToSynced = compareFeedFreshness(
        { version: feedVersion, updatedAt: feedUpdatedAt },
        { version: state.lastSyncedVersion, updatedAt: state.lastSyncedUpdatedAt }
      );
      if (cmpToSynced !== null && cmpToSynced < 0) {
        throw new Error(bt('pricing.err.feed_version_older', { feedVersion, syncedVersion: state.lastSyncedVersion }));
      }
      const cmpToBuiltin = compareFeedFreshness(
        { version: feedVersion, updatedAt: feedUpdatedAt },
        { version: PRICING_METADATA.version, updatedAt: PRICING_METADATA.updatedAt }
      );
      const isOlderDatedFeed = cmpToBuiltin !== null && cmpToBuiltin < 0;
      const shaUnchanged = Boolean(
        cacheValid &&
        state.lastSyncedSha256 &&
        sha256 === state.lastSyncedSha256 &&
        (cmpToSynced === null || cmpToSynced === 0)
      );
      if (shaUnchanged && !force) {
        const finalizeShaUnchanged = async () => {
          resetAndRegisterRemoteModelMetadata(remoteMeta, {
            onlyNewEntries: isOlderDatedFeed,
            authoritativeSnapshot: !isOlderDatedFeed,
          });
          state.lastRemoteSyncAt = now;
          state.lastCheckAt = now;
          state.nextAutoSyncAt = now + 86_400_000;
          state.lastSyncSuccess = true;
          state.lastCheckSuccess = true;
          state.lastSyncError = null;
          state.lastSyncedSourceUrl = targetUrl;
          if (fetched.etag) state.lastSyncedEtag = fetched.etag;
          await persistPricingSyncStatus(pricingSyncStatePath, state);
          return {
            synced: true,
            unchanged: true,
            count: Object.keys(validated).length,
            sourceUrl: targetUrl,
            version: feedVersion,
            updatedAt: feedUpdatedAt,
          };
        };
        if (shouldProbeNextOnUnchanged) {
          deferredCdnUnchanged = finalizeShaUnchanged;
          continue;
        }
        return await finalizeShaUnchanged();
      }

      const persistedPrices = isOlderDatedFeed
        ? Object.fromEntries(Object.entries(validated).filter(([k]) => !Object.hasOwn(DEFAULT_API_PRICES, k)))
        : validated;
      const finalizeWrite = async () => {
        resetAndRegisterRemoteModelMetadata(remoteMeta, {
          onlyNewEntries: isOlderDatedFeed,
          authoritativeSnapshot: !isOlderDatedFeed,
        });
        await atomicJson(remotePricingCachePath, {
          version: 1,
          syncedAt: new Date(now).toISOString(),
          sourceUrl: targetUrl,
          feedVersion,
          ...(feedUpdatedAt ? { feedUpdatedAt } : {}),
          sha256,
          ...(remoteMeta.aliases !== undefined ? { aliases: remoteMeta.aliases } : {}),
          ...(remoteMeta.activeModels ? { activeModels: remoteMeta.activeModels } : {}),
          ...(remoteMeta.feedModels ? { feedModels: remoteMeta.feedModels } : {}),
          ...(remoteMeta.models ? { models: remoteMeta.models } : {}),
          prices: persistedPrices,
        });
        state.lastRemoteSyncAt = now;
        state.lastCheckAt = now;
        state.nextAutoSyncAt = now + 86_400_000;
        state.lastSyncSuccess = true;
        state.lastCheckSuccess = true;
        state.lastSyncError = null;
        state.lastSyncedSourceUrl = targetUrl;
        state.lastSyncedVersion = feedVersion;
        state.lastSyncedUpdatedAt = feedUpdatedAt;
        state.lastSyncedEtag = fetched.etag ?? '';
        state.lastSyncedSha256 = sha256;
        await persistPricingSyncStatus(pricingSyncStatePath, state);
        return {
          synced: true,
          unchanged: shaUnchanged,
          count: Object.keys(validated).length,
          sourceUrl: targetUrl,
          version: feedVersion,
          updatedAt: feedUpdatedAt,
        };
      };
      if (shaUnchanged && shouldProbeNextOnUnchanged) {
        deferredCdnUnchanged = finalizeWrite;
        continue;
      }
      return await finalizeWrite();
    } catch (err: any) {
      lastError = err;
      continue;
    } finally {
      clearTimeout(timer);
    }
  }
  if (deferredCdnUnchanged) {
    return await deferredCdnUnchanged();
  }

  // 所有候选源均尝试失败：保留上次成功同步时间，仅推进检查时间戳与 5 分钟重试冷却
  state.nextAutoSyncAt = now + 300_000;
  state.lastCheckAt = now;
  state.lastSyncSuccess = false;
  state.lastCheckSuccess = false;
  state.lastSyncError = lastError?.message ?? String(lastError);
  await persistPricingSyncStatus(pricingSyncStatePath, state);
  return { synced: false, error: state.lastSyncError ?? undefined };
}

export function buildPricingSyncStatus(options: {
  autoSyncEnabled: boolean;
  state: PricingSyncMutableState;
  remotePricingUrl: string;
  modelCount: number;
}) {
  const { autoSyncEnabled, state, remotePricingUrl, modelCount } = options;
  const rawVersion = state.lastSyncedVersion || PRICING_METADATA.version;
  const cmpRawToBuiltin = compareDatedFeedVersion(rawVersion, PRICING_METADATA.version);
  const effectiveVersion = cmpRawToBuiltin !== null && cmpRawToBuiltin < 0
    ? PRICING_METADATA.version
    : rawVersion;
  const effectiveCheckAt = Math.max(state.lastCheckAt, state.lastRemoteSyncAt);
  return {
    autoSyncEnabled,
    lastSyncAt: state.lastRemoteSyncAt,
    lastCheckAt: effectiveCheckAt,
    lastSyncSuccess: state.lastSyncSuccess,
    lastCheckSuccess: state.lastCheckAt ? state.lastCheckSuccess : state.lastSyncSuccess,
    lastSyncError: state.lastSyncError,
    feedVersion: effectiveVersion,
    sourceUrl: state.lastSyncedSourceUrl || remotePricingUrl,
    modelCount,
  };
}

export async function saveCustomPricingCache(
  pricingCachePath: string,
  table: Record<string, ApiPricing | ApiPricingInterval[]>
): Promise<void> {
  await atomicJson(pricingCachePath, validateRawPrices(table));
}
