import { DatabaseSync } from 'node:sqlite';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { aggregateLedger, isUnpricedZeroSentinel, safeRollback, type AggregateOptions } from './usage-aggregate.js';
import { matchPricingKeys, resolveContextTierPricing, resolvePricingForTimestamp, type ApiPricing } from './pricing.js';
import { resolveDatabaseModelFullName } from './usage-types.js';
import { bt } from './i18n.js';
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function feesDigest(db: DatabaseSync): string {
    const hash = createHash('sha256');
    for (const row of db.prepare('SELECT event_key,unit_price,usd FROM rate_locks ORDER BY event_key').iterate())
        hash.update(JSON.stringify([row.event_key, row.unit_price, row.usd])).update('\n');
    return hash.digest('hex');
}
function revision(db: DatabaseSync): number { return Number(db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM event_revisions').get()?.n); }
export function writeRateLocksJsonMirror(db: DatabaseSync, ratesPath: string): void {
    const profiles: unknown[] = [];
    const profileMap = new Map<string, number>();
    const entries: Record<string, { usd: number; p: number }> = Object.create(null);
    for (const row of db.prepare('SELECT event_key, unit_price, usd FROM rate_locks ORDER BY event_key').iterate() as Iterable<any>) {
        const unitRaw = String(row.unit_price);
        let idx = profileMap.get(unitRaw);
        if (idx === undefined) {
            idx = profiles.length;
            profileMap.set(unitRaw, idx);
            profiles.push(JSON.parse(unitRaw));
        }
        entries[String(row.event_key)] = { usd: Number(row.usd), p: idx };
    }
    const tmpRates = `${ratesPath}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmpRates, JSON.stringify({ version: 1, profiles, entries }) + '\n', { mode: 0o600 });
    chmodSync(tmpRates, 0o600);
    renameSync(tmpRates, ratesPath);
}

export function revalueLedger(db: DatabaseSync, path: string, options: AggregateOptions & {
    action: 'preview' | 'apply' | 'restore';
    mode?: 'force_all' | 'unpriced_only';
    previewId?: string;
    confirmed?: boolean;
}) {
    const reviews = join(dirname(path), 'ledger-reviews');
    if (options.action === 'preview') {
        mkdirSync(reviews, { recursive: true, mode: 0o700 });
        try {
            const previewReceipts = readdirSync(reviews)
                .filter(name => /^[0-9a-f-]{36}\.json$/i.test(name))
                .map(name => {
                    const receiptFile = join(reviews, name);
                    try {
                        const parsed = JSON.parse(readFileSync(receiptFile, 'utf8'));
                        if (parsed?.phase && parsed.phase !== 'preview') return null;
                        const mtime = lstatSync(receiptFile).mtimeMs;
                        return { id: name.slice(0, -5), mtime };
                    } catch {
                        return null;
                    }
                })
                .filter((item): item is { id: string; mtime: number } => item !== null)
                .sort((a, b) => a.mtime - b.mtime);
            if (previewReceipts.length >= 5) {
                for (const stale of previewReceipts.slice(0, previewReceipts.length - 4)) {
                    for (const suffix of ['.json', '-before.sqlite', '-candidate.sqlite', '-rates-before.json']) {
                        try { unlinkSync(join(reviews, stale.id + suffix)); } catch {}
                    }
                }
            }
        } catch {}
        const id = randomUUID(), backup = join(reviews, id + '-before.sqlite'), candidate = join(reviews, id + '-candidate.sqlite');
        const sourceRevision = revision(db), sourceFeesDigest = feesDigest(db);
        const ratesPath = join(dirname(path), 'usage-rate-locks.json');
        const rateBytes = existsSync(ratesPath) ? readFileSync(ratesPath) : null;
        const rateDigest = rateBytes ? createHash('sha256').update(rateBytes).digest('hex') : null;
        if (rateBytes)
            writeFileSync(join(reviews, id + '-rates-before.json'), rateBytes, { mode: 0o600 });
        // 仅构建轻量级 rate_locks 快照库（不复制全量 events/event_revisions），保持与 ATTACH 还原契约完全兼容
        const backupLocks = new Map<string, { unit_price: string; usd: number }>();
        const baseline = new DatabaseSync(backup);
        try {
            baseline.exec('CREATE TABLE IF NOT EXISTS rate_locks(event_key TEXT PRIMARY KEY,unit_price TEXT NOT NULL,usd REAL NOT NULL);');
            baseline.exec('BEGIN IMMEDIATE');
            const insert = baseline.prepare('INSERT OR IGNORE INTO rate_locks VALUES(?,?,?)');
            for (const row of db.prepare('SELECT event_key,unit_price,usd FROM rate_locks').iterate() as Iterable<any>) {
                const key = String(row.event_key);
                const unitPrice = String(row.unit_price);
                const usd = Number(row.usd);
                insert.run(key, unitPrice, usd);
                backupLocks.set(key, { unit_price: unitPrice, usd });
            }
            if (rateBytes) {
                const rates = JSON.parse(rateBytes.toString());
                if (rates.version !== 1 || !rates.entries)
                    throw Error(bt('revalue.err.rate_ledger_unverified'));
                for (const [key, value] of Object.entries<any>(rates.entries)) {
                    const price = value.price ?? rates.profiles?.[value.p];
                    if (!price || !Number.isFinite(value.usd) || value.usd < 0)
                        throw Error(bt('revalue.err.rate_entry_invalid'));
                    const unitPrice = JSON.stringify(price);
                    const inserted = insert.run(key, unitPrice, value.usd);
                    if (inserted.changes > 0 && !backupLocks.has(key)) {
                        backupLocks.set(key, { unit_price: unitPrice, usd: Number(value.usd) });
                    }
                }
            }
            baseline.exec('COMMIT');
        }
        finally {
            baseline.close();
        }
        chmodSync(backup, 0o600);
        const liveFileSet = options.liveFiles ? new Set(options.liveFiles) : null;
        const extraPriceKeys = Object.keys(options.prices);
        const candidateLocks = new Map(backupLocks);
        let before = 0, unknown = 0;
        for (const row of db.prepare('SELECT e.event_key,e.payload FROM events e LEFT JOIN event_aliases a ON a.legacy_key=e.event_key WHERE a.legacy_key IS NULL').iterate() as Iterable<any>) {
            const event = JSON.parse(String(row.payload));
            if (event.db_file === 'recovered_session.db' || event.db_file === 'recovered_enterprise_session.db' || (!event.source_id && event.db_file && liveFileSet?.has(event.db_file))) {
                continue;
            }
            const eventKey = String(row.event_key);
            const lock = backupLocks.get(eventKey) ?? (event.legacy_event_key ? backupLocks.get(event.legacy_event_key) : undefined);
            const locked = lock ? JSON.parse(lock.unit_price) as ApiPricing : null;
            const cw = event.cache_write_tokens ?? 0;
            const lockedMissingCw = Boolean(
                locked &&
                cw > 0 &&
                (() => {
                    const eff = resolveContextTierPricing(locked, event.input_tokens + event.cached_tokens + cw);
                    return !Number.isFinite(eff.cacheWrite) || eff.cacheWrite! < 0;
                })()
            );
            const zeroSentinel = isUnpricedZeroSentinel(locked);
            if (lock && !zeroSentinel && !lockedMissingCw && event.timestamp_seconds > 0) {
                before += lock.usd;
            }
            const normalizedModel = resolveDatabaseModelFullName(event.model, null);
            const price = resolvePricingForTimestamp(
                options.prices[normalizedModel] ?? options.prices[matchPricingKeys(normalizedModel, extraPriceKeys)],
                event.timestamp_seconds,
                normalizedModel
            );
            const effectiveNewPrice = price ? resolveContextTierPricing(price, event.input_tokens + event.cached_tokens + cw) : null;
            if (!price || !effectiveNewPrice) {
                unknown++;
                continue;
            } // Current prices are never invented for an unsupported historical interval.
            const newPriceMissingCw = cw > 0 && (!Number.isFinite(effectiveNewPrice.cacheWrite) || effectiveNewPrice.cacheWrite! < 0);
            if (newPriceMissingCw) {
                unknown++;
                if (options.mode === 'unpriced_only') continue;
            }
            const unpriced = !lock || zeroSentinel || lockedMissingCw;
            if (options.mode !== 'unpriced_only' || unpriced) {
                candidateLocks.delete(eventKey);
                if (typeof event.legacy_event_key === 'string' && event.legacy_event_key) {
                    candidateLocks.delete(event.legacy_event_key);
                }
            }
        }
        const after = aggregateLedger(db, {
            ...options,
            accountId: 'all',
            environmentId: 'all',
            accounts: [],
            ignoreLegacyRates: true,
            dryRunRateLocks: candidateLocks,
        }).all_time.estimated_usd;
        const candidateDb = new DatabaseSync(candidate);
        try {
            candidateDb.exec('CREATE TABLE IF NOT EXISTS rate_locks(event_key TEXT PRIMARY KEY,unit_price TEXT NOT NULL,usd REAL NOT NULL);');
            candidateDb.exec('BEGIN IMMEDIATE');
            const put = candidateDb.prepare('INSERT INTO rate_locks VALUES(?,?,?)');
            for (const [key, lock] of candidateLocks) {
                put.run(key, lock.unit_price, lock.usd);
            }
            candidateDb.exec('COMMIT');
        }
        finally {
            candidateDb.close();
        }
        chmodSync(candidate, 0o600);
        const changes: {
            key: string;
            before: number | null;
            after: number | null;
        }[] = [];
        let changedCount = 0;
        for (const [key, row] of candidateLocks) {
            const old = backupLocks.get(key);
            if (!old || Number(old.usd) !== Number(row.usd)) {
                changedCount++;
                if (changes.length < 100)
                    changes.push({ key, before: old ? Number(old.usd) : null, after: Number(row.usd) });
            }
        }
        for (const [key, old] of backupLocks) {
            if (!candidateLocks.has(key)) {
                changedCount++;
                if (changes.length < 100)
                    changes.push({ key, before: Number(old.usd), after: null });
            }
        }
        if (revision(db) !== sourceRevision || feesDigest(db) !== sourceFeesDigest)
            throw Error(bt('revalue.err.usage_changed'));
        const receipt = { schema: 1, previewId: id, sourceRevision, sourceFeesDigest, rateDigest, priceDigest: digest(options.prices), backup, candidate, mode: options.mode ?? 'force_all', before: Math.round(before * 1e8) / 1e8, after, changedCount, unverifiableCount: unknown, samples: changes, requiresConfirmation: true };
        writeFileSync(join(reviews, id + '.json'), JSON.stringify(receipt, null, 2), { mode: 0o600, flag: 'wx' });
        return receipt;
    }
    if (!options.confirmed || !options.previewId || !/^[a-f0-9-]{36}$/.test(options.previewId))
        throw Error(bt('revalue.err.confirm_required'));
    const receiptPath = join(reviews, options.previewId + '.json');
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    const ratesPath = join(dirname(path), 'usage-rate-locks.json');
    if (receipt.schema !== 1 || receipt.sourceRevision !== revision(db) || (options.action === 'apply' && receipt.priceDigest !== digest(options.prices)))
        throw Error(bt('revalue.err.changed_after_preview'));
    if (options.action === 'restore' && (receipt.phase !== 'applied' || receipt.appliedFeesDigest !== feesDigest(db)))
        throw Error(bt('revalue.err.rates_changed_after_confirm'));
    if (options.action === 'apply' && receipt.sourceFeesDigest !== feesDigest(db))
        throw Error(bt('revalue.err.history_changed_after_preview'));
    const selected = options.action === 'restore' ? receipt.backup : receipt.candidate;
    if (selected !== join(reviews, options.previewId + (options.action === 'restore' ? '-before.sqlite' : '-candidate.sqlite')))
        throw Error(bt('revalue.err.restore_path_invalid'));
    db.exec(`ATTACH DATABASE '${selected.replace(/'/g, "''")}' AS reviewed`);
    try {
        db.exec('BEGIN IMMEDIATE; DELETE FROM rate_locks; INSERT INTO rate_locks SELECT * FROM reviewed.rate_locks; INSERT INTO rate_changes VALUES((SELECT COALESCE(MAX(version),0)+1 FROM rate_changes),0); COMMIT;');
    }
    catch (error) {
        safeRollback(db);
        throw error;
    }
    finally {
        try {
            db.exec('DETACH DATABASE reviewed');
        } catch {
            // 忽略 DETACH 二次异常，避免掩盖原始事务错误
        }
    }
    if (options.action === 'restore') {
        const beforeRatesPath = join(reviews, options.previewId + '-rates-before.json');
        if (existsSync(beforeRatesPath)) {
            const tmpRates = `${ratesPath}.${process.pid}.${randomUUID()}.tmp`;
            writeFileSync(tmpRates, readFileSync(beforeRatesPath), { mode: 0o600 });
            renameSync(tmpRates, ratesPath);
        } else if (receipt.rateDigest === null && existsSync(ratesPath)) {
            unlinkSync(ratesPath);
        }
    } else if (existsSync(ratesPath)) {
        writeRateLocksJsonMirror(db, ratesPath);
    }
    writeFileSync(receiptPath, JSON.stringify({ ...receipt, phase: options.action === 'restore' ? 'restored' : 'applied', appliedFeesDigest: feesDigest(db), completedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    return { before: receipt.before, after: options.action === 'restore' ? receipt.before : receipt.after, previewId: receipt.previewId, backupPath: receipt.backup,
        message: options.action === 'restore' ? bt('revalue.msg.restored') : bt('revalue.msg.applied') };
}
