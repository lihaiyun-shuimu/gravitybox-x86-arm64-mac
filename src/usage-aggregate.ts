import type { LedgerEvent } from './usage-ledger.js';
import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import {
    normalizeEventEnvironment,
    resolveDatabaseModelFullName,
    type AvailableAccountUsageOption,
    type AvailableEnvironmentUsageOption,
    type EnvironmentShareBreakdown,
    type KnownEnvironmentContext,
    type TokenUsagePeriod,
    type TokenUsageSummary,
} from './usage-types.js';
import { getEffectiveModelAliasKeys } from './model-catalog.js';
import { normalizeModelId, THINKING_EFFORT_OR_LATEST_SUFFIX_RE } from './model-identity.js';
import { DEFAULT_API_PRICES, resolveContextTierPricing, resolvePricingForTimestamp, matchPricingKeys, calculateEstimatedUsd, priceStatus, type ApiPricing, type ApiPricingEntry } from './pricing.js';
import { bt, getActiveLocale } from './i18n.js';
import { cleanHostLabel } from './ssh-context.js';

export function envDisplayLabel(
    key: 'usage.all_environments' | 'usage.env.local' | 'usage.env.ssh',
    params?: Record<string, string>
): string {
    const isEn = getActiveLocale() === 'en';
    const fallbackMap: Record<'usage.all_environments' | 'usage.env.local' | 'usage.env.ssh', string> = isEn
        ? {
            'usage.all_environments': 'All Environments',
            'usage.env.local': 'Local',
            'usage.env.ssh': 'SSH: {host}',
        }
        : {
            'usage.all_environments': '全部环境',
            'usage.env.local': '本机',
            'usage.env.ssh': 'SSH: {host}',
        };
    return bt(key, params, fallbackMap[key]);
}

export interface EnvAggregateCounters {
    kind: 'local' | 'ssh';
    hostLabel: string;
    totalTokens: number;
    requestCount: number;
    estimatedUsd: number;
    lastSyncedAt?: number;
}

export function buildPeriodEnvironmentBreakdown(
    localTokens: number,
    sshTokens: number,
    localRequests: number,
    sshRequests: number,
    localUsd: number,
    sshUsd: number,
    offlineSshHosts: readonly string[]
): EnvironmentShareBreakdown {
    const totalTokens = localTokens + sshTokens;
    const totalReqs = localRequests + sshRequests;
    let localSharePct = 0;
    let sshSharePct = 0;
    if (totalTokens > 0) {
        localSharePct = Math.round((localTokens / totalTokens) * 1000) / 10;
        sshSharePct = Math.round((100 - localSharePct) * 10) / 10;
    } else if (totalReqs > 0) {
        localSharePct = Math.round((localRequests / totalReqs) * 1000) / 10;
        sshSharePct = Math.round((100 - localSharePct) * 10) / 10;
    }
    return {
        local_tokens: localTokens,
        ssh_tokens: sshTokens,
        local_requests: localRequests,
        ssh_requests: sshRequests,
        local_usd: Math.round(localUsd * 1e8) / 1e8,
        ssh_usd: Math.round(sshUsd * 1e8) / 1e8,
        local_share_pct: localSharePct,
        ssh_share_pct: sshSharePct,
        has_ssh_data: sshTokens > 0 || sshRequests > 0,
        offline_ssh_hosts: [...offlineSshHosts],
    };
}

export function buildAvailableEnvironments(
    envStats: ReadonlyMap<string, EnvAggregateCounters>,
    allSshEnvsSeen: ReadonlyMap<string, string>,
    knownEnvironments?: readonly KnownEnvironmentContext[],
    receiptSyncTimes?: ReadonlyMap<string, number>
): { availableEnvironments: AvailableEnvironmentUsageOption[]; offlineSshHosts: string[] } {
    const knownMap = new Map<string, KnownEnvironmentContext>();
    if (Array.isArray(knownEnvironments)) {
        for (const item of knownEnvironments) {
            if (item && typeof item.id === 'string' && item.id.trim()) {
                knownMap.set(item.id.trim(), item);
            }
        }
    }

    const sshEnvIds = new Set<string>(allSshEnvsSeen.keys());
    for (const [id, meta] of knownMap.entries()) {
        if (meta.kind === 'ssh') sshEnvIds.add(id);
    }

    const localStat = envStats.get('local') ?? {
        kind: 'local' as const,
        hostLabel: '',
        totalTokens: 0,
        requestCount: 0,
        estimatedUsd: 0,
    };

    let allTokens = localStat.totalTokens;
    let allRequests = localStat.requestCount;
    let allUsd = localStat.estimatedUsd;
    const sshOptions: AvailableEnvironmentUsageOption[] = [];
    const offlineSshHosts: string[] = [];
    const offlineSet = new Set<string>();

    for (const envId of sshEnvIds) {
        const st = envStats.get(envId);
        const known = knownMap.get(envId);
        const online = known ? known.online !== false : false;
        const rawHostLabel =
            known?.host_label?.trim() ||
            known?.label?.trim() ||
            (st?.hostLabel && st.hostLabel !== envId ? st.hostLabel : '') ||
            allSshEnvsSeen.get(envId) ||
            envId;
        const hostLabel = cleanHostLabel(rawHostLabel) || rawHostLabel;
        const lifecycleState = known?.lifecycle_state ?? (online ? 'online' : 'historical_only');
        const windowCount = typeof known?.window_count === 'number' ? known.window_count : (online ? 1 : 0);
        const totalTokens = st?.totalTokens ?? 0;
        const requestCount = st?.requestCount ?? 0;
        const estimatedUsd = Math.round((st?.estimatedUsd ?? 0) * 1e8) / 1e8;
        const lastSyncedAt = known?.last_synced_at ?? st?.lastSyncedAt ?? receiptSyncTimes?.get(envId);

        allTokens += totalTokens;
        allRequests += requestCount;
        allUsd += st?.estimatedUsd ?? 0;

        if (!online && !offlineSet.has(hostLabel)) {
            offlineSet.add(hostLabel);
            offlineSshHosts.push(hostLabel);
        }

        sshOptions.push({
            id: envId,
            kind: 'ssh',
            label: envDisplayLabel('usage.env.ssh', { host: hostLabel }),
            host_label: hostLabel,
            total_tokens: totalTokens,
            request_count: requestCount,
            estimated_usd: estimatedUsd,
            online,
            lifecycle_state: lifecycleState,
            window_count: windowCount,
            ...(lastSyncedAt !== undefined && lastSyncedAt > 0 ? { last_synced_at: lastSyncedAt } : {}),
        });
    }

    sshOptions.sort((a, b) => {
        const onlineDiff = (b.online ? 1 : 0) - (a.online ? 1 : 0);
        if (onlineDiff !== 0) return onlineDiff;
        return (a.host_label ?? a.label).localeCompare(b.host_label ?? b.label);
    });

    const allOption: AvailableEnvironmentUsageOption = {
        id: 'all',
        kind: 'all',
        label: envDisplayLabel('usage.all_environments'),
        total_tokens: allTokens,
        request_count: allRequests,
        estimated_usd: Math.round(allUsd * 1e8) / 1e8,
    };

    const localKnown = knownMap.get('local');
    const localOption: AvailableEnvironmentUsageOption = {
        id: 'local',
        kind: 'local',
        label: envDisplayLabel('usage.env.local'),
        total_tokens: localStat.totalTokens,
        request_count: localStat.requestCount,
        estimated_usd: Math.round(localStat.estimatedUsd * 1e8) / 1e8,
        online: localKnown ? localKnown.online !== false : true,
        lifecycle_state: localKnown?.lifecycle_state ?? 'online',
        ...(typeof localKnown?.window_count === 'number' ? { window_count: localKnown.window_count } : {}),
        ...(localKnown?.last_synced_at ? { last_synced_at: localKnown.last_synced_at } : {}),
    };

    const availableEnvironments: AvailableEnvironmentUsageOption[] =
        sshOptions.length > 0 ? [allOption, localOption, ...sshOptions] : [allOption, localOption];

    return { availableEnvironments, offlineSshHosts };
}

export function safeRollback(db: DatabaseSync): void {
    try {
        db.exec('ROLLBACK');
    } catch {
        // 事务可能已由 SQLite 自动回滚或未开启，吞掉二次异常以保留原始错误
    }
}

export function isUnpricedZeroSentinel(price: ApiPricing | null | undefined): boolean {
    return Boolean(
        price &&
        !['user', 'confirmed'].includes(price.provenance?.verification ?? '') &&
        [price.input, price.output, price.cached, price.cacheWrite ?? 0].every(value => value === 0)
    );
}

export function calculateLockedEventUsd(
    event: Pick<LedgerEvent, 'input_tokens' | 'output_tokens' | 'cached_tokens' | 'cache_write_tokens'>,
    price: ApiPricing | null | undefined
): number | null {
    if (!price || isUnpricedZeroSentinel(price)) return null;
    const cw = event.cache_write_tokens ?? 0;
    const effective = resolveContextTierPricing(price, event.input_tokens + event.cached_tokens + cw);
    if (cw > 0 && (!Number.isFinite(effective.cacheWrite) || effective.cacheWrite! < 0)) return null;
    return calculateEstimatedUsd(event.input_tokens, event.output_tokens, event.cached_tokens, price, cw);
}

export function formatLocalDate(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}
export interface AggregateOptions {
    prices: Record<string, ApiPricingEntry>;
    accountId?: string;
    environmentId?: string;
    environments?: KnownEnvironmentContext[];
    remoteSyncRevision?: number;
    accounts: Array<{
        id: string;
        email: string;
        name?: string | null;
    }>;
    now: number;
    liveFiles?: string[];
    ignoreLegacyRates?: boolean;
    dryRunRateLocks?: Map<string, { unit_price: string; usd: number }>;
    cacheKey?: string;
}
export interface LedgerSnapshot {
    revision: number;
    generatedAt: number;
    accountId: string;
    environmentId?: string;
    rateRevision: number;
    snapshotId?: string;
}
function period(): TokenUsagePeriod {
    return { totals: { input_tokens: 0, output_tokens: 0, cached_tokens: 0, cache_write_tokens: 0, total_tokens: 0, request_count: 0 }, estimated_usd: 0, by_model: [] };
}

interface IndexedLedgerRow {
    event: LedgerEvent;
    evEnv: ReturnType<typeof normalizeEventEnvironment>;
    isSynthetic: boolean;
    lockedPrice: ApiPricing | null;
    lockedUsd: number | null;
    hasRawLock: boolean;
}

interface CachedLedgerIndex {
    revision: number;
    rateRevision: number;
    ignoreLegacyRates: boolean;
    locale: string;
    rows: IndexedLedgerRow[];
}

const MAX_AGGREGATE_INDEX_CACHE_ENTRIES = 2;
const aggregateIndexCache = new Map<string, CachedLedgerIndex>();
const memoryDbCacheIds = new WeakMap<DatabaseSync, number>();
let nextMemoryDbCacheId = 1;
let aggregateModelCatalogEpoch = 0;
let aggregateIndexCacheHits = 0;
let aggregateIndexCacheMisses = 0;

export function bumpAggregateModelCatalogEpoch(): number {
    aggregateModelCatalogEpoch += 1;
    aggregateIndexCache.clear();
    return aggregateModelCatalogEpoch;
}

export function invalidateAggregateIndexCache(dbIdentityPrefix?: string): void {
    if (!dbIdentityPrefix) {
        aggregateIndexCache.clear();
        return;
    }
    for (const key of aggregateIndexCache.keys()) {
        if (key === dbIdentityPrefix || key.startsWith(`${dbIdentityPrefix}|`)) {
            aggregateIndexCache.delete(key);
        }
    }
}

export function getAggregateIndexCacheStats(): {
    size: number;
    maxSize: number;
    epoch: number;
    hits: number;
    misses: number;
    keys: string[];
} {
    return {
        size: aggregateIndexCache.size,
        maxSize: MAX_AGGREGATE_INDEX_CACHE_ENTRIES,
        epoch: aggregateModelCatalogEpoch,
        hits: aggregateIndexCacheHits,
        misses: aggregateIndexCacheMisses,
        keys: [...aggregateIndexCache.keys()],
    };
}

function resolveAggregateIndexCacheKey(db: DatabaseSync, explicitCacheKey?: string): string {
    const cleanExplicit = typeof explicitCacheKey === 'string' ? explicitCacheKey.trim() : '';
    if (cleanExplicit) {
        return `${cleanExplicit}|ep=${aggregateModelCatalogEpoch}`;
    }
    try {
        const list = db.prepare('PRAGMA database_list').all() as Array<{ name?: string; file?: string }>;
        const main = list.find(entry => entry.name === 'main') ?? list[0];
        const filePath = typeof main?.file === 'string' ? main.file.trim() : '';
        if (filePath) {
            const stat = existsSync(filePath) ? lstatSync(filePath) : null;
            const identity = stat ? `${filePath}|${stat.dev}:${stat.ino}` : filePath;
            return `${identity}|ep=${aggregateModelCatalogEpoch}`;
        }
    } catch {
        // fallback to in-memory database id
    }
    let memId = memoryDbCacheIds.get(db);
    if (!memId) {
        memId = nextMemoryDbCacheId++;
        memoryDbCacheIds.set(db, memId);
    }
    return `memory:${memId}|ep=${aggregateModelCatalogEpoch}`;
}

function loadOrBuildLedgerIndex(
    db: DatabaseSync,
    cacheKey: string,
    revision: number,
    rateRevision: number,
    ignoreLegacyRates: boolean
): CachedLedgerIndex {
    const locale = getActiveLocale();
    const existing = aggregateIndexCache.get(cacheKey);
    if (
        existing &&
        existing.revision === revision &&
        existing.rateRevision === rateRevision &&
        existing.ignoreLegacyRates === ignoreLegacyRates &&
        existing.locale === locale
    ) {
        // Refresh MRU insertion order
        aggregateIndexCache.delete(cacheKey);
        aggregateIndexCache.set(cacheKey, existing);
        aggregateIndexCacheHits += 1;
        return existing;
    }
    aggregateIndexCacheMisses += 1;
    const priceJsonCache = new Map<string, ApiPricing>();
    const parseUnitPrice = (raw: string): ApiPricing => {
        const hit = priceJsonCache.get(raw);
        if (hit) return hit;
        const parsed = JSON.parse(raw) as ApiPricing;
        priceJsonCache.set(raw, parsed);
        return parsed;
    };
    const selectLock = db.prepare('SELECT unit_price,usd FROM rate_locks WHERE event_key=?');
    const rows: IndexedLedgerRow[] = [];
    for (const row of db.prepare('SELECT e.payload,l.unit_price,l.usd FROM events e LEFT JOIN rate_locks l ON l.event_key=e.event_key LEFT JOIN event_aliases a ON a.legacy_key=e.event_key WHERE a.legacy_key IS NULL').iterate()) {
        const event = JSON.parse(String(row.payload)) as LedgerEvent;
        event.model = resolveDatabaseModelFullName(event.model, null);
        const isSynthetic = event.db_file === 'recovered_session.db' || event.db_file === 'recovered_enterprise_session.db';
        const evEnv = normalizeEventEnvironment(event);
        const hasRawLock = Boolean(row.unit_price);
        let lockPriceStr: string | null = hasRawLock ? String(row.unit_price) : null;
        if (!ignoreLegacyRates && !hasRawLock && event.legacy_event_key) {
            const legacyRow = selectLock.get(event.legacy_event_key);
            if (legacyRow && legacyRow.unit_price !== null && legacyRow.unit_price !== undefined) {
                lockPriceStr = String(legacyRow.unit_price);
            }
        }
        const lockedPrice = lockPriceStr ? parseUnitPrice(lockPriceStr) : null;
        const lockedUsd = hasRawLock && row.usd !== null && row.usd !== undefined ? Number(row.usd) : null;
        rows.push({ event, evEnv, isSynthetic, lockedPrice, lockedUsd, hasRawLock });
    }
    const next: CachedLedgerIndex = { revision, rateRevision, ignoreLegacyRates, locale, rows };
    aggregateIndexCache.delete(cacheKey);
    while (aggregateIndexCache.size >= MAX_AGGREGATE_INDEX_CACHE_ENTRIES) {
        const oldestKey = aggregateIndexCache.keys().next().value;
        if (oldestKey === undefined) break;
        aggregateIndexCache.delete(oldestKey);
    }
    aggregateIndexCache.set(cacheKey, next);
    return next;
}

/** Streams indexed ledger rows on the worker. No full-history array reaches the UI process. */
export function aggregateLedger(db: DatabaseSync, options: AggregateOptions): TokenUsageSummary & {
    ledger_snapshot: LedgerSnapshot;
    healed_unpriced_count?: number;
} {
    const now = options.now, today = new Date(now * 1000);
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const seven = new Date(today);
    seven.setDate(seven.getDate() - 6);
    const thirty = new Date(today);
    thirty.setDate(thirty.getDate() - 29);
    const periods = [period(), period(), period(), period()];
    const periodEnvCounters = periods.map(() => ({
        localTokens: 0,
        sshTokens: 0,
        localRequests: 0,
        sshRequests: 0,
        localUsd: 0,
        sshUsd: 0,
    }));
    const models = periods.map(() => new Map<string, any>());
    const daily = new Map<string, any>(), hourly = new Map<string, any>();
    const accounts = new Map<string, AvailableAccountUsageOption>();
    accounts.set('all', { id: 'all', label: bt('usage.all_accounts'), type: 'all', total_tokens: 0, request_count: 0 });
    for (const account of options.accounts)
        accounts.set(account.id, { ...account, label: account.email, type: 'account', total_tokens: 0, request_count: 0 });
    const selectedAccountId = options.accountId && options.accountId.trim() ? options.accountId.trim() : 'all';
    const selectedEnvId = options.environmentId && options.environmentId.trim() ? options.environmentId.trim() : 'all';
    const targetEmail = options.accounts.find(account => account.id === selectedAccountId)?.email.toLowerCase()
        ?? (selectedAccountId.includes('@') ? selectedAccountId.toLowerCase() : '');
    let unknownCount = 0, unknownTokens = 0, unattributedRequests = 0, unattributedTokens = 0;
    const dryRunLocks = options.dryRunRateLocks;
    const extraPriceKeys = Object.keys(options.prices);
    const priceEntries = new Map<string, ApiPricingEntry | undefined>();
    const saveLock = dryRunLocks ? null : db.prepare('INSERT INTO rate_locks(event_key,unit_price,usd) VALUES(?,?,?) ON CONFLICT(event_key) DO UPDATE SET usd=excluded.usd,unit_price=excluded.unit_price');
    const liveFileSet = options.liveFiles ? new Set(options.liveFiles) : null;
    const knownById = new Map(options.accounts.map(acc => [acc.id, acc]));
    const knownByEmail = new Map(options.accounts.map(acc => [acc.email.toLowerCase(), acc]));
    const envStats = new Map<string, EnvAggregateCounters>();
    const allSshEnvsSeen = new Map<string, string>();
    let minPositiveTs = Infinity;
    let changedRateMinSeq = Number.POSITIVE_INFINITY;
    let healedUnpricedCount = 0;
    const firstSequence = dryRunLocks ? null : db.prepare('SELECT MIN(seq) AS seq FROM event_revisions WHERE event_key=?');
    let writeTxOpened = false;
    const ensureWriteTx = () => {
        if (!dryRunLocks && !writeTxOpened) {
            db.exec('BEGIN IMMEDIATE');
            writeTxOpened = true;
        }
    };
    const resolveIndexedCost = (
        rowItem: IndexedLedgerRow,
        allowWriteLock: boolean
    ): number | null => {
        const event = rowItem.event;
        if (event.timestamp_seconds <= 0 || !event.event_key) return null;
        let locked: ApiPricing | null = rowItem.lockedPrice;
        let existingUsd: number | null = rowItem.lockedUsd;
        let hasRawLock = rowItem.hasRawLock;
        if (dryRunLocks) {
            const dry = dryRunLocks.get(event.event_key);
            if (dry) {
                locked = JSON.parse(dry.unit_price) as ApiPricing;
                existingUsd = dry.usd;
                hasRawLock = true;
            } else if (!options.ignoreLegacyRates && event.legacy_event_key) {
                const legacyDry = dryRunLocks.get(event.legacy_event_key);
                if (legacyDry) {
                    locked = JSON.parse(legacyDry.unit_price) as ApiPricing;
                }
            }
        }
        const key = event.model;
        if (!priceEntries.has(key))
            priceEntries.set(key, options.prices[key] ?? options.prices[matchPricingKeys(key, extraPriceKeys)]);
        const zeroSentinel = isUnpricedZeroSentinel(locked);
        const cw = event.cache_write_tokens ?? 0;
        const lockedMissingCw = Boolean(
            locked &&
            cw > 0 &&
            (() => {
                const eff = resolveContextTierPricing(locked, event.input_tokens + event.cached_tokens + cw);
                return !Number.isFinite(eff.cacheWrite) || eff.cacheWrite! < 0;
            })()
        );
        const canReuseLocked = Boolean(locked && !zeroSentinel && !lockedMissingCw);
        const price = canReuseLocked ? locked : resolvePricingForTimestamp(priceEntries.get(key), event.timestamp_seconds, key);
        const effectivePrice = price ? resolveContextTierPricing(price, event.input_tokens + event.cached_tokens + cw) : null;
        if (!price || !effectivePrice || (cw > 0 && (!Number.isFinite(effectivePrice.cacheWrite) || effectivePrice.cacheWrite! < 0))) {
            return null;
        }
        const cost = canReuseLocked && !event.source_id && existingUsd !== null && existingUsd !== undefined
            ? Number(existingUsd)
            : calculateEstimatedUsd(event.input_tokens, event.output_tokens, event.cached_tokens, price, cw);
        if (allowWriteLock && (!hasRawLock || zeroSentinel || lockedMissingCw || existingUsd === null || Number(existingUsd) !== cost)) {
            const { intervals: _intervals, ...compactPrice } = price as any;
            const compactJson = JSON.stringify(compactPrice);
            if (dryRunLocks) {
                dryRunLocks.set(event.event_key, { unit_price: compactJson, usd: cost });
            } else {
                ensureWriteTx();
                saveLock!.run(event.event_key, compactJson, cost);
                rowItem.hasRawLock = true;
                rowItem.lockedPrice = compactPrice as ApiPricing;
                rowItem.lockedUsd = cost;
                if (!hasRawLock || zeroSentinel || lockedMissingCw)
                    changedRateMinSeq = Math.min(changedRateMinSeq, Number(firstSequence!.get(event.event_key)?.seq ?? 0));
            }
            if (!hasRawLock || zeroSentinel || lockedMissingCw) healedUnpricedCount++;
        }
        return cost;
    };

    const revision = Number(db.prepare('SELECT COALESCE(MAX(seq),0) AS revision FROM event_revisions').get()?.revision);
    let rateRevision = Number(db.prepare('SELECT COALESCE(MAX(version),0) AS version FROM rate_changes').get()?.version);
    const resolvedCacheKey = dryRunLocks ? null : resolveAggregateIndexCacheKey(db, options.cacheKey);
    const indexedCache: CachedLedgerIndex | null = resolvedCacheKey
        ? loadOrBuildLedgerIndex(db, resolvedCacheKey, revision, rateRevision, Boolean(options.ignoreLegacyRates))
        : null;

    const buildDryRowsIterable = (): Iterable<IndexedLedgerRow> => {
        const list: IndexedLedgerRow[] = [];
        for (const row of db.prepare('SELECT e.payload FROM events e LEFT JOIN event_aliases a ON a.legacy_key=e.event_key WHERE a.legacy_key IS NULL').iterate()) {
            const event = JSON.parse(String(row.payload)) as LedgerEvent;
            event.model = resolveDatabaseModelFullName(event.model, null);
            const isSynthetic = event.db_file === 'recovered_session.db' || event.db_file === 'recovered_enterprise_session.db';
            const evEnv = normalizeEventEnvironment(event);
            const dryEntry = event.event_key ? dryRunLocks?.get(event.event_key) : undefined;
            const hasRawLock = Boolean(dryEntry);
            let lockedPrice: ApiPricing | null = dryEntry ? JSON.parse(dryEntry.unit_price) as ApiPricing : null;
            if (!lockedPrice && !options.ignoreLegacyRates && event.legacy_event_key) {
                const lr = dryRunLocks?.get(event.legacy_event_key);
                if (lr && lr.unit_price) lockedPrice = JSON.parse(lr.unit_price) as ApiPricing;
            }
            const lockedUsd = dryEntry && dryEntry.usd !== null && dryEntry.usd !== undefined ? Number(dryEntry.usd) : null;
            list.push({
                event,
                evEnv,
                isSynthetic,
                lockedPrice,
                lockedUsd,
                hasRawLock,
            });
        }
        return list;
    };

    const rowSource = indexedCache ? indexedCache.rows : buildDryRowsIterable();

    try {
        for (const rowItem of rowSource) {
            const event = rowItem.event;
            if (rowItem.isSynthetic || (!event.source_id && event.db_file && liveFileSet?.has(event.db_file)))
                continue;

            const evEnv = rowItem.evEnv;
            if (evEnv.kind === 'ssh') {
                const prevLabel = allSshEnvsSeen.get(evEnv.id);
                if (!prevLabel || (prevLabel === evEnv.id && evEnv.label !== evEnv.id)) {
                    allSshEnvsSeen.set(evEnv.id, evEnv.label);
                }
            }

            const matchesEnv = selectedEnvId === 'all' || evEnv.id === selectedEnvId;
            const matchesAccount =
                selectedAccountId === 'all' ||
                (selectedAccountId === 'unattributed'
                    ? (!event.account_id && !event.account_email)
                    : (event.account_id === selectedAccountId ||
                       (Boolean(targetEmail) && event.account_email?.toLowerCase() === targetEmail)));

            if (event.account_id || event.account_email) {
                const owner = (event.account_id ? knownById.get(event.account_id) : undefined)
                    ?? (event.account_email ? knownByEmail.get(event.account_email.toLowerCase()) : undefined);
                const id = owner?.id ?? event.account_id ?? event.account_email!;
                const account = accounts.get(id) ?? { id, label: event.account_email ?? id, email: event.account_email, type: 'account' as const, total_tokens: 0, request_count: 0 };
                if (matchesEnv) {
                    account.total_tokens! += event.total_tokens;
                    account.request_count!++;
                }
                accounts.set(id, account);
            }
            if (matchesEnv) {
                if (!event.account_id && !event.account_email) { unattributedRequests++; unattributedTokens += event.total_tokens; }
                const all = accounts.get('all')!;
                all.total_tokens! += event.total_tokens;
                all.request_count!++;
            }

            if (!matchesAccount)
                continue;

            const cost = resolveIndexedCost(rowItem, matchesEnv);

            const prevEnvStat = envStats.get(evEnv.id) ?? {
                kind: evEnv.kind,
                hostLabel: evEnv.label,
                totalTokens: 0,
                requestCount: 0,
                estimatedUsd: 0,
            };
            if (evEnv.label && (!prevEnvStat.hostLabel || prevEnvStat.hostLabel === evEnv.id)) {
                prevEnvStat.hostLabel = evEnv.label;
            }
            prevEnvStat.totalTokens += event.total_tokens;
            prevEnvStat.requestCount += 1;
            prevEnvStat.estimatedUsd += cost ?? 0;
            envStats.set(evEnv.id, prevEnvStat);

            if (!matchesEnv)
                continue;

            const tomorrowStartSeconds = tomorrow.getTime() / 1000;
            const flags = [event.timestamp_seconds >= today.getTime() / 1000 && event.timestamp_seconds < tomorrowStartSeconds,
                event.timestamp_seconds >= seven.getTime() / 1000 && event.timestamp_seconds < tomorrowStartSeconds,
                event.timestamp_seconds >= thirty.getTime() / 1000 && event.timestamp_seconds < tomorrowStartSeconds, true];
            for (let index = 0; index < 4; index++)
                if (flags[index]) {
                    const result = periods[index]!;
                    for (const key of ['input_tokens', 'output_tokens', 'cached_tokens', 'cache_write_tokens', 'total_tokens'] as const)
                        result.totals[key] = (result.totals[key] ?? 0) + (event[key] ?? 0);
                    result.totals.request_count++;
                    result.estimated_usd += cost ?? 0;
                    const envBucket = periodEnvCounters[index]!;
                    if (evEnv.kind === 'ssh') {
                        envBucket.sshTokens += event.total_tokens;
                        envBucket.sshRequests += 1;
                        envBucket.sshUsd += cost ?? 0;
                    } else {
                        envBucket.localTokens += event.total_tokens;
                        envBucket.localRequests += 1;
                        envBucket.localUsd += cost ?? 0;
                    }
                    const model = models[index]!.get(event.model) ?? { model: event.model, input_tokens: 0, output_tokens: 0, cached_tokens: 0, cache_write_tokens: 0, total_tokens: 0, request_count: 0, estimated_usd: 0, unpriced_tokens: 0 };
                    for (const key of ['input_tokens', 'output_tokens', 'cached_tokens', 'cache_write_tokens', 'total_tokens'] as const)
                        model[key] += event[key] ?? 0;
                    model.request_count++;
                    model.estimated_usd += cost ?? 0;
                    if (cost === null)
                        model.unpriced_tokens += event.total_tokens;
                    models[index]!.set(event.model, model);
                }
            if (event.timestamp_seconds <= 0) {
                unknownCount++;
                unknownTokens += event.total_tokens;
                continue;
            }
            // 次日零点之后的轻微未来时钟偏移事件仍保留在 all_time 中，但不写入 daily_trends，防止 7/30 天趋势切片右移一天
            if (event.timestamp_seconds < tomorrowStartSeconds) {
                if (event.timestamp_seconds < minPositiveTs) minPositiveTs = event.timestamp_seconds;
                const date = new Date(event.timestamp_seconds * 1000), day = formatLocalDate(date);
                const addTrend = (map: Map<string, any>, key: string, attribute: string) => {
                    const value = map.get(key) ?? { [attribute]: key, input_tokens: 0, output_tokens: 0, cached_tokens: 0, cache_write_tokens: 0, total_tokens: 0, request_count: 0 };
                    for (const column of ['input_tokens', 'output_tokens', 'cached_tokens', 'cache_write_tokens', 'total_tokens'] as const)
                        value[column] += event[column] ?? 0;
                    value.request_count++;
                    map.set(key, value);
                };
                addTrend(daily, day, 'date');
                if (flags[0])
                    addTrend(hourly, `${day} ${String(date.getHours()).padStart(2, '0')}:00`, 'hour');
            }
        }
        if (writeTxOpened) {
            if (Number.isFinite(changedRateMinSeq)) {
                db.prepare('INSERT INTO rate_changes VALUES((SELECT COALESCE(MAX(version),0)+1 FROM rate_changes),?)').run(changedRateMinSeq);
            }
            db.exec('COMMIT');
            rateRevision = Number(db.prepare('SELECT COALESCE(MAX(version),0) AS version FROM rate_changes').get()?.version);
            if (indexedCache) {
                indexedCache.rateRevision = rateRevision;
            }
        }
    }
    catch (error) {
        if (writeTxOpened) {
            safeRollback(db);
            if (resolvedCacheKey) aggregateIndexCache.delete(resolvedCacheKey);
        }
        throw error;
    }

    const receiptSyncTimes = new Map<string, number>();
    const hasSyncReceipts = Boolean(
        db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='sync_receipts'").get()?.ok
    );
    if (hasSyncReceipts) {
        for (const r of db.prepare('SELECT environment_id, MAX(committed_at) AS committed_at FROM sync_receipts GROUP BY environment_id').all() as Array<{ environment_id: string; committed_at: number }>) {
            if (typeof r.environment_id === 'string' && r.environment_id && Number(r.committed_at) > 0) {
                receiptSyncTimes.set(r.environment_id, Number(r.committed_at));
            }
        }
    }

    const { availableEnvironments, offlineSshHosts } = buildAvailableEnvironments(
        envStats,
        allSshEnvsSeen,
        options.environments,
        receiptSyncTimes
    );

    for (let index = 0; index < 4; index++) {
        const result = periods[index]!;
        const envCounter = periodEnvCounters[index]!;
        result.by_model = [...models[index]!.values()].map(model => {
            const isPriced = model.unpriced_tokens === 0;
            const isPartial = model.unpriced_tokens > 0 && model.unpriced_tokens < model.total_tokens;
            const matchedPricingKey = matchPricingKeys(model.model, extraPriceKeys);
            const entry = options.prices[model.model] ?? options.prices[matchedPricingKey];
            const price = resolvePricingForTimestamp(entry, now, model.model);
            return {
                ...model,
                estimated_usd: Math.round(model.estimated_usd * 1e8) / 1e8,
                priced: isPriced,
                ...(isPartial ? { partiallyPriced: true } : {}),
                ...(isPriced || isPartial ? {
                    pricingKey: matchedPricingKey,
                    pricingStatus: price ? priceStatus(price, now * 1000) : 'historical',
                    pricingProvenance: price?.provenance ?? null,
                } : {}),
            };
        }).sort((a, b) => b.total_tokens - a.total_tokens);
        result.priced_models = result.by_model.filter(model => model.priced).length;
        result.unpriced_models = result.by_model.length - result.priced_models;
        result.estimated_usd = Math.round(result.estimated_usd * 1e8) / 1e8;
        result.environment_breakdown = buildPeriodEnvironmentBreakdown(
            envCounter.localTokens,
            envCounter.sshTokens,
            envCounter.localRequests,
            envCounter.sshRequests,
            envCounter.localUsd,
            envCounter.sshUsd,
            offlineSshHosts
        );
    }
    let earliestStartDate = new Date(thirty);
    if (Number.isFinite(minPositiveTs)) {
        const minDate = new Date(minPositiveTs * 1000);
        minDate.setHours(0, 0, 0, 0);
        const maxHistoryCap = new Date(today);
        maxHistoryCap.setDate(maxHistoryCap.getDate() - 365);
        const boundedMin = minDate < maxHistoryCap ? maxHistoryCap : minDate;
        if (boundedMin < earliestStartDate) earliestStartDate = boundedMin;
    }
    for (const date = new Date(earliestStartDate); date <= today; date.setDate(date.getDate() + 1)) {
        const key = formatLocalDate(date);
        if (!daily.has(key))
            daily.set(key, { date: key, input_tokens: 0, output_tokens: 0, cached_tokens: 0, cache_write_tokens: 0, total_tokens: 0, request_count: 0 });
    }
    const accountId = selectedAccountId;
    const snapshot: LedgerSnapshot = { revision, generatedAt: now, accountId, environmentId: selectedEnvId, rateRevision };
    const hashInput = selectedEnvId === 'all'
        ? [revision, accountId, formatLocalDate(today), options.prices]
        : [revision, accountId, selectedEnvId, formatLocalDate(today), options.prices];
    const hash = createHash('sha256').update(JSON.stringify(hashInput)).digest('hex').slice(0, 20);
    snapshot.snapshotId = hash;
    if (!dryRunLocks) {
        db.prepare('INSERT INTO snapshot_pins VALUES(?,?,?) ON CONFLICT(snapshot_id) DO UPDATE SET expires=excluded.expires').run(hash, revision, Date.now() + 600000);
    }
    const receipts = db.prepare('SELECT COUNT(*) AS count,COALESCE(SUM(l.usd),0) AS usd FROM rate_locks l LEFT JOIN events e ON e.event_key=l.event_key LEFT JOIN event_aliases a ON a.legacy_key=l.event_key WHERE e.event_key IS NULL AND a.legacy_key IS NULL').get();
    return { unattributed_requests: unattributedRequests, unattributed_tokens: unattributedTokens, historical_amount_receipts: { unmatchedCount: Number(receipts?.count ?? 0), unmatchedUsd: Number(receipts?.usd ?? 0) }, today: periods[0]!, last_7_days: periods[1]!, last_30_days: periods[2]!, all_time: periods[3]!, daily_trends: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)), today_hourly: [...hourly.values()].sort((a, b) => a.hour.localeCompare(b.hour)),
        available_accounts: [...accounts.values()], selected_account_id: accountId,
        available_environments: availableEnvironments, selected_environment_id: selectedEnvId,
        environment_breakdown: periods[3]!.environment_breakdown,
        ...(options.remoteSyncRevision !== undefined ? { remote_sync_revision: options.remoteSyncRevision } : {}),
        unknown_time_records: unknownCount, unknown_time_tokens: unknownTokens,
        databases_scanned: 0, generations_scanned: 0, skipped_large_records: 0, generated_at: now, snapshot_id: hash,
        availability: unknownCount ? 'partial' : 'complete', ledger_snapshot: snapshot, healed_unpriced_count: healedUnpricedCount };
}
export function createModelQueryMatcher(rawQuery: string): (candidate: string) => boolean {
    const qLower = rawQuery.trim().toLowerCase();
    const qNorm = qLower ? normalizeModelId(rawQuery) : '';
    const qCleanNorm = qNorm.replace(THINKING_EFFORT_OR_LATEST_SUFFIX_RE, '');
    return (candidate: string): boolean => {
        if (!qLower) return true;
        const candLower = candidate.toLowerCase();
        const resolvedLower = resolveDatabaseModelFullName(candidate, null).toLowerCase();
        const candNorm = normalizeModelId(candidate);
        const resolvedNorm = normalizeModelId(resolvedLower);
        if (candLower.includes(qLower) || resolvedLower.includes(qLower)) return true;
        if (qNorm && (candNorm.includes(qNorm) || resolvedNorm.includes(qNorm))) return true;
        if (qCleanNorm && (candNorm.includes(qCleanNorm) || resolvedNorm.includes(qCleanNorm))) return true;
        return false;
    };
}

export function ledgerEventPage(db: DatabaseSync, options: {
    snapshot: LedgerSnapshot;
    period: string;
    query: string;
    offset: number;
    limit: number;
    targetEmail?: string;
    accountId?: string;
    environmentId?: string;
}) {
    const { snapshot } = options;
    if (!snapshot.snapshotId || !db.prepare('SELECT 1 AS pinned FROM snapshot_pins WHERE snapshot_id=? AND expires>=?').get(snapshot.snapshotId, Date.now()))
        throw Error(bt('usage.err.snapshot_expired'));
    db.prepare('UPDATE snapshot_pins SET expires=? WHERE snapshot_id=?').run(Date.now() + 600000, snapshot.snapshotId);
    if (db.prepare('SELECT 1 AS changed FROM rate_changes WHERE version>? AND min_event_seq<=? LIMIT 1').get(snapshot.rateRevision, snapshot.revision))
        throw Error(bt('usage.err.rates_changed_reexport'));
    const snapshotAccId = snapshot.accountId && snapshot.accountId.trim() ? snapshot.accountId.trim() : 'all';
    const requestedAccId = options.accountId && options.accountId.trim() ? options.accountId.trim() : undefined;
    if (snapshotAccId !== 'all' && requestedAccId && requestedAccId !== snapshotAccId) {
        throw Error(bt('usage.err.snapshot_account_mismatch'));
    }
    const effectiveAccountId = requestedAccId ?? snapshotAccId;
    const snapshotEnvId = snapshot.environmentId && snapshot.environmentId.trim() ? snapshot.environmentId.trim() : 'all';
    const requestedEnvId = options.environmentId && options.environmentId.trim() ? options.environmentId.trim() : undefined;
    if (snapshotEnvId !== 'all' && requestedEnvId && requestedEnvId !== snapshotEnvId) {
        throw Error(bt('usage.err.snapshot_account_mismatch'));
    }
    const effectiveEnvId = requestedEnvId ?? snapshotEnvId;
    const start = new Date(snapshot.generatedAt * 1000);
    start.setHours(0, 0, 0, 0);
    if (options.period === '7d')
        start.setDate(start.getDate() - 6);
    if (options.period === '30d')
        start.setDate(start.getDate() - 29);
    const end = new Date(snapshot.generatedAt * 1000);
    end.setHours(24, 0, 0, 0);
    const rawQuery = options.query ?? '';
    const qLower = rawQuery.trim().toLowerCase();
    const qNorm = qLower ? normalizeModelId(rawQuery) : '';
    const qCleanNorm = qNorm.replace(THINKING_EFFORT_OR_LATEST_SUFFIX_RE, '');
    const modelMatchesQuery = createModelQueryMatcher(rawQuery);
    const aliasMatchSet = new Set<string>();
    if (qLower) {
        for (const candidate of [...getEffectiveModelAliasKeys(), ...Object.keys(DEFAULT_API_PRICES)]) {
            if (modelMatchesQuery(candidate)) {
                aliasMatchSet.add(candidate.toLowerCase());
                aliasMatchSet.add(resolveDatabaseModelFullName(candidate, null).toLowerCase());
                const norm = normalizeModelId(candidate);
                if (norm) aliasMatchSet.add(norm);
            }
        }
        if (modelMatchesQuery('未知模型') || modelMatchesQuery('Unknown Model')) {
            aliasMatchSet.add('未知模型');
            aliasMatchSet.add('unknown model');
        }
        for (const row of db.prepare("SELECT DISTINCT json_extract(payload,'$.model') AS m FROM event_revisions WHERE seq<=?").all(snapshot.revision)) {
            if (typeof row.m === 'string' && row.m && modelMatchesQuery(row.m)) {
                aliasMatchSet.add(row.m.toLowerCase());
                if (aliasMatchSet.size >= 500) break;
            }
        }
    }
    const aliasMatches = [...aliasMatchSet];
    const likePatterns = ['%' + rawQuery.replace(/[\\%_]/g, '\\$&') + '%'];
    if (qCleanNorm && qCleanNorm !== qLower) {
        likePatterns.push('%' + qCleanNorm.replace(/[\\%_]/g, '\\$&') + '%');
    }
    const likeClauses = likePatterns.map(() => "json_extract(r.payload,'$.model') LIKE ? ESCAPE '\\'").join(' OR ');
    const modelClause = aliasMatches.length > 0
        ? `(${likeClauses} OR lower(json_extract(r.payload,'$.model')) IN (${aliasMatches.map(() => '?').join(',')}))`
        : `(${likeClauses})`;
    const conditions = [
        'r.seq<=?',
        'NOT EXISTS(SELECT 1 FROM event_revisions n WHERE n.event_key=r.event_key AND n.seq>r.seq AND n.seq<=?)',
        'NOT EXISTS(SELECT 1 FROM event_aliases a WHERE a.legacy_key=r.event_key)',
        "COALESCE(json_extract(r.payload,'$.db_file'),'') NOT IN ('recovered_session.db','recovered_enterprise_session.db')",
        modelClause,
    ];
    const params: Array<string | number> = [
        snapshot.revision,
        snapshot.revision,
        ...likePatterns,
        ...aliasMatches,
    ];
    if (options.period !== 'all') {
        conditions.push('r.timestamp>=? AND r.timestamp<?');
        params.push(start.getTime() / 1000, end.getTime() / 1000);
    }
    if (effectiveAccountId === 'unattributed') {
        conditions.push("NULLIF(TRIM(COALESCE(json_extract(r.payload,'$.account_id'),'')),'') IS NULL");
        conditions.push("NULLIF(TRIM(COALESCE(json_extract(r.payload,'$.account_email'),'')),'') IS NULL");
    } else if (effectiveAccountId !== 'all') {
        conditions.push("(json_extract(r.payload,'$.account_id')=? OR lower(json_extract(r.payload,'$.account_email'))=?)");
        params.push(effectiveAccountId, options.targetEmail?.toLowerCase() || effectiveAccountId.toLowerCase());
    }
    if (effectiveEnvId === 'local') {
        conditions.push("COALESCE(json_extract(r.payload,'$.environment_kind'),'local')='local'");
    } else if (effectiveEnvId !== 'all') {
        conditions.push("json_extract(r.payload,'$.environment_kind')='ssh'");
        conditions.push(
            "COALESCE(NULLIF(TRIM(json_extract(r.payload,'$.environment_id')),''), CASE WHEN NULLIF(TRIM(json_extract(r.payload,'$.environment_label')),'') IS NOT NULL THEN 'ssh:' || TRIM(json_extract(r.payload,'$.environment_label')) ELSE 'ssh' END)=?"
        );
        params.push(effectiveEnvId);
    }
    const where = conditions.join(' AND ');
    const total = Number(db.prepare(`SELECT COUNT(*) AS count FROM event_revisions r WHERE ${where}`).get(...params)?.count);
    const rows = db.prepare(`SELECT r.payload,l.unit_price FROM event_revisions r LEFT JOIN rate_locks l ON l.event_key=r.event_key WHERE ${where} ORDER BY r.timestamp DESC,r.seq DESC LIMIT ? OFFSET ?`).all(...params, options.limit, options.offset).map(row => {
        const event = JSON.parse(String(row.payload)) as LedgerEvent;
        event.model = resolveDatabaseModelFullName(event.model, null);
        const price = row.unit_price ? JSON.parse(String(row.unit_price)) as ApiPricing : null;
        const cost = event.timestamp_seconds > 0 ? calculateLockedEventUsd(event, price) : null;
        const env = normalizeEventEnvironment(event);
        const {
            event_key: _key,
            source_id: _source,
            legacy_event_key: _legacy,
            db_file: _dbFile,
            trajectory_id: _traj,
            execution: _exec,
            ...publicEvent
        } = event;
        return {
            ...publicEvent,
            environment_kind: env.kind,
            environment_id: env.id,
            environment_label: env.label,
            account_email: event.account_email ?? null,
            account_confidence: event.account_confidence ?? 'unknown',
            estimated_usd: cost,
            priced: cost !== null,
        };
    });
    return { rows, total, offset: options.offset, limit: options.limit };
}
