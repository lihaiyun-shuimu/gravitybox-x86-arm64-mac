import { type ApplicationChannel, type ApplicationTarget, applicationTarget } from './application-target.js';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdir, lstat, unlink, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { atomicJson, atomicText, sanitizeError } from './files.js';
import { withProcessLease } from './process-lock.js';
import { AccountsManager, SystemKeychainAdapter, buildGoOauthPayload, decodeKeychainOauthPayload, syncAccountToKeychain, type KeychainAdapter, type Account } from './accounts.js';
import { ProtobufWriter as Writer } from './protobuf.js';
import { removeTopicRow, replaceTopicRow } from './account-state.js';
export { removeTopicRow, replaceTopicRow } from './account-state.js';
import { bt } from './i18n.js';
import {
  appProcesses,
  defaultAntigravityInstallDirs,
  defaultGravityBoxStateDir,
  isOwnedByCurrentUser,
  isPathUnder,
  isWindows,
  pathsEqual,
} from './platform/index.js';

const run = promisify(execFile);
const TOKEN = 'antigravityUnifiedStateSync.oauthToken';
const USER = 'antigravityUnifiedStateSync.userStatus';
const INIT = 'jetskiStateSync.agentManagerInitState';
const PROJECT = 'antigravityUnifiedStateSync.enterprisePreferences';
const KEYS = [TOKEN, USER, INIT, PROJECT, 'antigravityOnboarding'];
const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;
type Rows = Record<string, string>;
type SavedFile = { path: string; before: string; after: string; afterDigest?: string };
type CliSnapshot = {
  path: string;
  existedBefore: boolean;
  before: string | null;
  afterDigest?: string;
  afterEmail?: string;
  afterRefreshDigest?: string;
};
type Journal = {
  version: 1;
  status: string;
  before: Rows;
  after: Rows;
  afterDigest?: string;
  files: SavedFile[];
  cliSnapshots?: CliSnapshot[];
  keychainBefore: string | null;
  keychainAfter: string;
  keychainAfterDigest?: string;
  at: string;
};
type RollbackRecord = {
  version: 1;
  phase: 'prepared' | 'committed';
  databasePath: string;
  hadDatabase: boolean;
  rowsBefore: Rows;
  rowsAfter: Rows;
  files: SavedFile[];
  cliSnapshots?: CliSnapshot[];
  keychainBefore: string | null;
  keychainAfter: string | null;
  originalJournal: Journal;
};

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
function rowsDigest(rows: Rows): string {
  return sha256(JSON.stringify(Object.entries(rows || {}).sort()));
}

const requireForSqlite = createRequire(import.meta.url);
let cachedDatabaseSyncCtor: (new (location: string) => DatabaseSyncType) | null = null;
function loadDatabaseSync(): new (location: string) => DatabaseSyncType {
  if (!cachedDatabaseSyncCtor) {
    const mod = requireForSqlite('node:sqlite') as { DatabaseSync: new (location: string) => DatabaseSyncType };
    cachedDatabaseSyncCtor = mod.DatabaseSync;
  }
  return cachedDatabaseSyncCtor;
}

interface DatabaseTransactionBackend {
  sql?(sql: string): Promise<string>;
  begin(): Promise<void>;
  rows(): Promise<Rows>;
  replace(rows: Rows): Promise<void>;
  finish(commit: boolean): Promise<void>;
  close(): Promise<void>;
}

// macOS / POSIX path: unchanged upstream sqlite3 CLI transaction.
// sqlite3 stays in BEGIN IMMEDIATE while the other resources are committed. SQL goes through
// stdin, so neither tokens nor database values appear in command arguments or diagnostics.
class PosixSqliteCliTransaction implements DatabaseTransactionBackend {
  private child;
  private output = '';
  private pending?: { marker: string; resolve: (s: string) => void; reject: (e: Error) => void };
  private failed = false;
  private exited: Promise<void>;
  constructor(path: string) {
    this.child = spawn('/usr/bin/sqlite3', ['-batch', '-bail', path], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.exited = new Promise(resolve => this.child.once('close', () => resolve()));
    this.child.stdin.on('error', () => this.fail());
    this.child.stderr.on('data', () => this.fail());
    this.child.on('error', () => this.fail());
    this.child.on('exit', () => this.fail());
    this.child.stdout.on('data', chunk => {
      this.output += chunk.toString();
      if (this.output.length > 4_000_000) return this.fail();
      const marker = this.pending?.marker;
      if (marker && this.output.includes(marker)) {
        const reply = this.output.slice(0, this.output.indexOf(marker)).trim();
        this.output = this.output.slice(this.output.indexOf(marker) + marker.length).trimStart();
        const pending = this.pending!; this.pending = undefined; pending.resolve(reply);
      }
    });
  }
  private fail() { this.failed = true; this.pending?.reject(new Error(bt('switch.err.db_tx_failed'))); this.pending = undefined; }
  async sql(sql: string): Promise<string> {
    if (this.failed) throw new Error(bt('switch.err.db_closed'));
    const marker = `GB_${randomUUID()}`;
    const response = new Promise<string>((resolve, reject) => { this.pending = { marker, resolve, reject }; });
    this.child.stdin.write(`${sql}\n.print ${marker}\n`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([response, new Promise<never>((_, reject) => { timer = setTimeout(() => { this.child.kill(); reject(new Error(bt('switch.err.db_busy'))); }, 6000); })]); }
    finally { clearTimeout(timer); }
  }
  async begin() { await this.sql('.timeout 3000\n.mode json\nBEGIN IMMEDIATE;'); }
  async rows(): Promise<Rows> {
    const raw = await this.sql(`SELECT key,value FROM ItemTable WHERE key IN (${KEYS.map(quote).join(',')});`);
    return Object.fromEntries((JSON.parse(raw || '[]') as { key: string; value: string }[]).map(r => [r.key, r.value]));
  }
  async replace(rows: Rows) {
    await this.sql(`DELETE FROM ItemTable WHERE key IN (${KEYS.map(quote).join(',')});\n${Object.entries(rows).map(([k, v]) => `INSERT INTO ItemTable(key,value) VALUES(${quote(k)},${quote(v)});`).join('\n')}`);
  }
  async finish(commit: boolean) { try { await this.sql(commit ? 'COMMIT;' : 'ROLLBACK;'); } finally { this.child.stdin.end(); } }
  async close() {
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill(), 1500);
    try { await this.exited; } finally { clearTimeout(timer); }
  }
}

// Windows path: in-process node:sqlite BEGIN IMMEDIATE write transaction (loaded lazily so macOS
// never loads node:sqlite or emits ExperimentalWarning on stderr).
class WindowsNodeSqliteTransaction implements DatabaseTransactionBackend {
  private db: DatabaseSyncType | null = null;
  private inTransaction = false;
  private closed = false;
  private initError: Error | null = null;

  constructor(private readonly dbPath: string) {
    try {
      const DatabaseSync = loadDatabaseSync();
      this.db = new DatabaseSync(this.dbPath);
      this.db.exec('PRAGMA busy_timeout = 3000;');
    } catch (error) {
      this.initError = this.wrapError(error);
      this.closed = true;
    }
  }

  private wrapError(error: unknown): Error {
    const msg = error instanceof Error ? error.message : String(error ?? '');
    if (/SQLITE_BUSY|database is locked|locked/i.test(msg)) {
      return new Error(bt('switch.err.db_busy'));
    }
    return new Error(bt('switch.err.db_tx_failed'));
  }

  private requireDb(): DatabaseSyncType {
    if (this.initError) throw this.initError;
    if (this.closed || !this.db) throw new Error(bt('switch.err.db_closed'));
    return this.db;
  }

  private closeSync(): void {
    if (this.closed) return;
    this.closed = true;
    const conn = this.db;
    this.db = null;
    if (!conn) return;
    if (this.inTransaction) {
      try { conn.exec('ROLLBACK;'); } catch {}
      this.inTransaction = false;
    }
    try { conn.close(); } catch {}
  }

  async begin(): Promise<void> {
    const db = this.requireDb();
    try {
      db.exec('BEGIN IMMEDIATE;');
      this.inTransaction = true;
    } catch (error) {
      throw this.wrapError(error);
    }
  }

  async rows(): Promise<Rows> {
    const db = this.requireDb();
    try {
      const placeholders = KEYS.map(() => '?').join(',');
      const rawRows = db
        .prepare(`SELECT key, value FROM ItemTable WHERE key IN (${placeholders})`)
        .all(...KEYS) as Array<{ key?: unknown; value?: unknown }>;
      const result: Rows = {};
      for (const row of rawRows) {
        if (typeof row.key === 'string' && typeof row.value === 'string') {
          result[row.key] = row.value;
        }
      }
      return result;
    } catch (error) {
      throw this.wrapError(error);
    }
  }

  async replace(rows: Rows): Promise<void> {
    const db = this.requireDb();
    try {
      const placeholders = KEYS.map(() => '?').join(',');
      db.prepare(`DELETE FROM ItemTable WHERE key IN (${placeholders})`).run(...KEYS);
      const insertStmt = db.prepare('INSERT INTO ItemTable(key, value) VALUES(?, ?)');
      for (const [k, v] of Object.entries(rows)) {
        insertStmt.run(k, v);
      }
    } catch (error) {
      throw this.wrapError(error);
    }
  }

  async finish(commit: boolean): Promise<void> {
    const db = this.requireDb();
    try {
      if (this.inTransaction) {
        db.exec(commit ? 'COMMIT;' : 'ROLLBACK;');
        this.inTransaction = false;
      }
    } catch (error) {
      throw this.wrapError(error);
    } finally {
      this.closeSync();
    }
  }

  async close(): Promise<void> {
    this.closeSync();
  }
}

export class DatabaseTransaction {
  private readonly backend: DatabaseTransactionBackend;

  constructor(path: string) {
    this.backend = isWindows()
      ? new WindowsNodeSqliteTransaction(path)
      : new PosixSqliteCliTransaction(path);
  }

  async sql(sql: string): Promise<string> {
    if (!this.backend.sql) throw new Error(bt('switch.err.db_tx_failed'));
    return await this.backend.sql(sql);
  }

  async begin(): Promise<void> {
    await this.backend.begin();
  }

  async rows(): Promise<Rows> {
    return await this.backend.rows();
  }

  async replace(rows: Rows): Promise<void> {
    await this.backend.replace(rows);
  }

  async finish(commit: boolean): Promise<void> {
    await this.backend.finish(commit);
  }

  async close(): Promise<void> {
    await this.backend.close();
  }
}


function nextRows(before: Rows, acc: Account): Rows {
  const token = acc.token;
  const personal = /@(gmail|outlook|hotmail|qq|163)\.com$/i.test(acc.email);
  const accessToken = token.access_token && token.access_token !== 'pending_refresh' ? token.access_token : '';
  const expirySec = Number.isFinite(token.expiry_timestamp) && token.expiry_timestamp > 0 ? Math.floor(token.expiry_timestamp) : 0;
  const payload = Buffer.concat([
    Writer.encodeString(1, accessToken), Writer.encodeString(2, 'Bearer'), Writer.encodeString(3, token.refresh_token),
    Writer.encodeLengthDelimited(4, Buffer.concat([Writer.encodeVarintField(1, expirySec), Writer.encodeVarintField(2, 0)])),
    ...(token.id_token ? [Writer.encodeString(5, token.id_token)] : []),
    Writer.encodeVarintField(6, !personal && token.is_gcp_tos ? 1 : 0),
  ]);
  const after: Rows = { ...before,
    [TOKEN]: replaceTopicRow(before[TOKEN], 'oauthTokenInfoSentinelKey', payload),
    [USER]: replaceTopicRow(undefined, 'userStatusSentinelKey', Buffer.concat([Writer.encodeString(3, acc.name || acc.email), Writer.encodeString(7, acc.email)])),
    antigravityOnboarding: 'true',
  };
  if (token.project_id) {
    after[PROJECT] = replaceTopicRow(before[PROJECT], 'enterpriseGcpProjectId', Writer.encodeString(3, token.project_id));
  } else if (before[PROJECT] !== undefined) {
    let nextProject: string | null = null;
    try {
      nextProject = removeTopicRow(before[PROJECT], 'enterpriseGcpProjectId');
    } catch {
      // Legacy non-protobuf fixture values fall back to deleting the row on personal switch.
      nextProject = null;
    }
    if (nextProject === null) delete after[PROJECT];
    else after[PROJECT] = nextProject;
  }
  delete after[INIT];
  return after;
}

const NON_SENSITIVE_STATE_ROW_KEYS = new Set<string>(['antigravityOnboarding']);

function sanitizeJournalRows(rows: Rows): Rows {
  const result: Rows = {};
  for (const [k, v] of Object.entries(rows || {})) {
    if (NON_SENSITIVE_STATE_ROW_KEYS.has(k)) {
      result[k] = v;
    } else if (k === TOKEN || k.toLowerCase().includes('token') || k.toLowerCase().includes('oauth')) {
      result[k] = '[REDACTED_OAUTH_TOKEN]';
    } else {
      result[k] = '[REDACTED_STATE_ROW]';
    }
  }
  return result;
}

/**
 * 白名单制文件脱敏：除 accounts.json 仅含非敏感索引摘要外，任何其它文件路径（无论是否有 .json 后缀）
 * 一律视为可能包含 OAuth 凭据并彻底脱敏。
 */
function isNonSensitiveIndexFile(filePath: string): boolean {
  return basename(filePath.replaceAll('\\', '/')) === 'accounts.json';
}

function sanitizeJournalFiles(files: SavedFile[]): SavedFile[] {
  return (files || []).map(f => {
    if (!isNonSensitiveIndexFile(f.path)) {
      return {
        path: f.path,
        before: '[REDACTED_ACCOUNT]',
        after: '[REDACTED_ACCOUNT]',
      };
    }
    return f;
  });
}

function sanitizeJournalCliSnapshots(snapshots?: CliSnapshot[]): CliSnapshot[] | undefined {
  if (!snapshots) return undefined;
  return snapshots.map(s => ({
    path: s.path,
    existedBefore: s.existedBefore,
    before: s.before !== null ? '[REDACTED_CLI]' : null,
  }));
}

function tryParseJsonRecord(raw: string): Record<string, any> | null {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function resolveManagedFileTarget(
  file: SavedFile,
  currentContent: string,
  targetDirection: 'before' | 'after'
): string | null {
  const matchesBefore = currentContent === file.before;
  const matchesAfter = (file.afterDigest ? sha256(currentContent) === file.afterDigest : false) || currentContent === file.after;
  if (matchesBefore || matchesAfter) {
    return targetDirection === 'before' ? file.before : file.after;
  }

  const curObj = tryParseJsonRecord(currentContent);
  const beforeObj = tryParseJsonRecord(file.before);
  if (!curObj || !beforeObj) return null;

  if (isNonSensitiveIndexFile(file.path)) {
    const afterObj = tryParseJsonRecord(file.after);
    const matchesIndexBefore =
      (curObj.current_account_id ?? null) === (beforeObj.current_account_id ?? null) &&
      (curObj.current_target_ide ?? null) === (beforeObj.current_target_ide ?? null);
    const matchesIndexAfter = Boolean(
      afterObj &&
      (curObj.current_account_id ?? null) === (afterObj.current_account_id ?? null) &&
      (curObj.current_target_ide ?? null) === (afterObj.current_target_ide ?? null)
    );
    if (!matchesIndexBefore && !matchesIndexAfter) return null;
    if (targetDirection === 'after') return afterObj ? file.after : null;

    const merged: Record<string, any> = { ...curObj };
    if ('current_account_id' in beforeObj) merged.current_account_id = beforeObj.current_account_id;
    else delete merged.current_account_id;
    if ('current_target_ide' in beforeObj) merged.current_target_ide = beforeObj.current_target_ide;
    else delete merged.current_target_ide;

    const targetAccountId = typeof afterObj?.current_account_id === 'string' ? afterObj.current_account_id : null;
    if (targetAccountId && Array.isArray(curObj.accounts) && Array.isArray(beforeObj.accounts)) {
      const prevEntry = beforeObj.accounts.find((a: any) => a && typeof a === 'object' && a.id === targetAccountId);
      if (prevEntry) {
        merged.accounts = curObj.accounts.map((a: any) => {
          if (!a || typeof a !== 'object' || a.id !== targetAccountId) return a;
          const nextEntry = { ...a };
          if ('last_used' in prevEntry) nextEntry.last_used = prevEntry.last_used;
          else delete nextEntry.last_used;
          return nextEntry;
        });
      }
    }
    return JSON.stringify(merged, null, 2) + '\n';
  }

  if (
    curObj.id !== beforeObj.id ||
    curObj.email !== beforeObj.email ||
    Boolean(curObj.disabled) !== Boolean(beforeObj.disabled) ||
    Boolean(curObj.validation_blocked) !== Boolean(beforeObj.validation_blocked) ||
    (curObj.token?.refresh_token ?? null) !== (beforeObj.token?.refresh_token ?? null) ||
    (curObj.token?.project_id ?? null) !== (beforeObj.token?.project_id ?? null)
  ) {
    return null;
  }
  if (targetDirection === 'after') return file.after;
  const mergedAccount: Record<string, any> = { ...curObj };
  if ('last_used' in beforeObj) mergedAccount.last_used = beforeObj.last_used;
  else delete mergedAccount.last_used;
  return JSON.stringify(mergedAccount, null, 2) + '\n';
}

export class AccountSwitchService {
  private keychain: KeychainAdapter;
  private journalPath: string;
  private target: ApplicationTarget;
  constructor(private manager: AccountsManager, private options: {
    stateDir: string; profile: string; keychain?: KeychainAdapter; channel?: ApplicationChannel; target?: ApplicationTarget;
    homeDir?: string; geminiDir?: string;
    isRunning?: () => Promise<boolean>; // Isolated tests only; never accepted over IPC.
    databaseFactory?: (path: string) => DatabaseTransaction; // Fault injection, never accepted over IPC.
  }) {
    this.keychain = options.keychain ?? new SystemKeychainAdapter();
    this.target = options.target ?? applicationTarget(options.channel ?? 'stable', undefined, { profile: options.profile });
    this.journalPath = join(options.stateDir, 'account-switch-journal-stable.json');
  }

  private getCliCredentialPaths(): string[] {
    const baseGeminiDir = this.options.geminiDir
      ?? (this.options.homeDir ? join(this.options.homeDir, '.gemini') : undefined)
      ?? (pathsEqual(this.options.stateDir, defaultGravityBoxStateDir()) ? join(homedir(), '.gemini') : undefined);
    if (!baseGeminiDir) return [];
    return [
      join(baseGeminiDir, 'antigravity-cli', 'antigravity-oauth-token'),
      join(baseGeminiDir, 'jetski-standalone-oauth-token'),
    ];
  }

  /**
   * 附属同步本机已存在的同源 agy CLI 凭据文件（非侵入：文件不存在绝不创建；不进入 journal.files 严格摘要锁）。
   */
  private async syncExistingCliCredentials(payloadJson: string | null): Promise<{ syncedPaths: string[]; warnings: string[] }> {
    const syncedPaths: string[] = [];
    const warnings: string[] = [];
    if (!payloadJson) return { syncedPaths, warnings };
    for (const cliPath of this.getCliCredentialPaths()) {
      try {
        const info = await lstat(cliPath).catch((err: NodeJS.ErrnoException) => {
          if (err?.code === 'ENOENT') return null;
          throw err;
        });
        if (!info) continue;
        if (!info.isFile() || info.isSymbolicLink() || !isOwnedByCurrentUser(info)) {
          warnings.push(`${cliPath}: skipped non-regular or non-user file`);
          continue;
        }
        await atomicText(cliPath, payloadJson.endsWith('\n') ? payloadJson : `${payloadJson}\n`);
        syncedPaths.push(cliPath);
      } catch (error) {
        warnings.push(sanitizeError((error as Error)?.message ?? String(error)));
      }
    }
    return { syncedPaths, warnings };
  }

  private async resolveRollbackCliPayload(journal: Journal): Promise<string | null> {
    const decodedBefore = decodeKeychainOauthPayload(journal.keychainBefore);
    if (decodedBefore) {
      try {
        const parsed = JSON.parse(decodedBefore);
        if (parsed && typeof parsed === 'object' && parsed.token && typeof parsed.token.refresh_token === 'string' && parsed.token.refresh_token) {
          return JSON.stringify(parsed);
        }
      } catch {}
    }
    const indexSnapshot = (journal.files || []).find(f => isNonSensitiveIndexFile(f.path));
    if (indexSnapshot?.before) {
      try {
        const prevIndex = JSON.parse(indexSnapshot.before) as { current_account_id?: string | null };
        const prevId = prevIndex?.current_account_id;
        if (typeof prevId === 'string' && prevId) {
          const prevAcc = await this.manager.getAccount(prevId).catch(() => null);
          if (prevAcc?.token?.refresh_token) {
            return buildGoOauthPayload(prevAcc);
          }
        }
      } catch {}
    }
    return null;
  }

  setTarget(target: ApplicationTarget) {
    this.target = target;
    this.options.channel = target.channel;
    this.options.profile = target.profile;
    this.journalPath = join(this.options.stateDir, 'account-switch-journal-stable.json');
  }

  private get rollbackPath() { return this.journalPath + '.rollback.json'; }
  private database(path: string) { return this.options.databaseFactory?.(path) ?? new DatabaseTransaction(path); }

  private async snapshotExistingCliCredentials(payloadJson: string | null, acc: Account): Promise<CliSnapshot[]> {
    const snapshots: CliSnapshot[] = [];
    const afterText = payloadJson ? (payloadJson.endsWith('\n') ? payloadJson : `${payloadJson}\n`) : null;
    const afterDigest = afterText ? sha256(afterText) : undefined;
    const afterRefreshDigest = acc.token?.refresh_token ? sha256(acc.token.refresh_token) : undefined;
    for (const cliPath of this.getCliCredentialPaths()) {
      const info = await lstat(cliPath).catch((err: NodeJS.ErrnoException) => {
        if (err?.code === 'ENOENT') return null;
        throw err;
      });
      if (!info) continue;
      if (!info.isFile() || info.isSymbolicLink() || !isOwnedByCurrentUser(info)) continue;
      const before = await readFile(cliPath, 'utf8');
      snapshots.push({
        path: cliPath,
        existedBefore: true,
        before,
        ...(afterDigest ? { afterDigest } : {}),
        ...(acc.email ? { afterEmail: acc.email } : {}),
        ...(afterRefreshDigest ? { afterRefreshDigest } : {}),
      });
    }
    return snapshots;
  }

  private async restoreCliSnapshots(
    snapshots: CliSnapshot[] | undefined,
    fallbackJournal?: Journal
  ): Promise<{ syncedPaths: string[]; warnings: string[] }> {
    if (!snapshots || snapshots.length === 0) {
      if (fallbackJournal) {
        const fallbackPayload = await this.resolveRollbackCliPayload(fallbackJournal);
        return await this.syncExistingCliCredentials(fallbackPayload);
      }
      return { syncedPaths: [], warnings: [] };
    }
    const syncedPaths: string[] = [];
    const warnings: string[] = [];
    for (const snap of snapshots) {
      if (!snap.existedBefore || snap.before === null || snap.before === '[REDACTED_CLI]') continue;
      try {
        const info = await lstat(snap.path).catch((err: NodeJS.ErrnoException) => {
          if (err?.code === 'ENOENT') return null;
          throw err;
        });
        if (!info) {
          warnings.push(`${snap.path}: skipped restore (file missing)`);
          continue;
        }
        if (!info.isFile() || info.isSymbolicLink() || !isOwnedByCurrentUser(info)) {
          warnings.push(`${snap.path}: skipped non-regular or non-user file`);
          continue;
        }
        const current = await readFile(snap.path, 'utf8');
        if (current === snap.before) {
          syncedPaths.push(snap.path);
          continue;
        }
        const matchesAfterDigest = Boolean(snap.afterDigest && sha256(current) === snap.afterDigest);
        let matchesSameAccountRefresh = false;
        if (!matchesAfterDigest && snap.afterEmail) {
          const parsed = tryParseJsonRecord(current);
          const curEmail = parsed?.token?.email ?? parsed?.id_token_email;
          const curRefresh = parsed?.token?.refresh_token;
          if (
            typeof curEmail === 'string' &&
            curEmail.toLowerCase() === snap.afterEmail.toLowerCase() &&
            (!snap.afterRefreshDigest || (typeof curRefresh === 'string' && sha256(curRefresh) === snap.afterRefreshDigest))
          ) {
            matchesSameAccountRefresh = true;
          }
        }
        if (!matchesAfterDigest && !matchesSameAccountRefresh) {
          warnings.push(`${snap.path}: skipped restore due to external CLI credential change`);
          continue;
        }
        await atomicText(snap.path, snap.before);
        syncedPaths.push(snap.path);
      } catch (error) {
        warnings.push(sanitizeError((error as Error)?.message ?? String(error)));
      }
    }
    return { syncedPaths, warnings };
  }

  private completedRollback(journal: Journal): Journal {
    return { ...journal, before: sanitizeJournalRows(journal.before), after: sanitizeJournalRows(journal.after),
      afterDigest: undefined, files: sanitizeJournalFiles(journal.files),
      ...(journal.cliSnapshots ? { cliSnapshots: sanitizeJournalCliSnapshots(journal.cliSnapshots) } : {}),
      keychainBefore: null,
      keychainAfter: '', keychainAfterDigest: undefined, status: 'rolled-back' };
  }

  /** Reconcile an interrupted undo using the committed database as the decision point.
   * All resources are compared against both recorded states before any overwrite.
   * The durable record survives a compensation failure and can be retried after restart.
   */
  private async reconcileRollback(): Promise<'none' | 'restored' | 'rolled-back'> {
    let record: RollbackRecord;
    try { await this.regular(this.rollbackPath); record = JSON.parse(await readFile(this.rollbackPath, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'none'; throw error; }
    const dbPath = join(this.options.profile, 'User', 'globalStorage', 'state.vscdb');
    const accountsIndexPath = join(this.options.stateDir, 'accounts.json');
    const accountsDirPath = join(this.options.stateDir, 'accounts');
    const isAllowedRollbackFile = (filePath: string): boolean => {
      if (pathsEqual(filePath, accountsIndexPath)) return true;
      if (!isPathUnder(filePath, accountsDirPath)) return false;
      const name = basename(filePath.replaceAll('\\', '/'));
      return /^[a-zA-Z0-9_-]+\.json$/.test(name) && pathsEqual(filePath, join(accountsDirPath, name));
    };
    if (record.version !== 1 || !['prepared', 'committed'].includes(record.phase) || !pathsEqual(record.databasePath, dbPath) ||
        !Array.isArray(record.files) || record.files.some(f => !isAllowedRollbackFile(f.path))) {
      throw new Error(bt('switch.err.rollback_identity'));
    }
    const currentJournal = JSON.parse(await readFile(this.journalPath, 'utf8')) as Journal;
    const original = record.originalJournal;
    const knownJournals = [original, { ...original, status: 'rolling-back' }, this.completedRollback(original)];
    if (!knownJournals.some(value => JSON.stringify(value) === JSON.stringify(currentJournal))) throw new Error(bt('switch.err.journal_modified'));
    if (await this.optionalRegular(dbPath) !== record.hadDatabase) throw new Error(bt('switch.err.db_changed_rollback_kept'));
    const tx = record.hadDatabase ? this.database(dbPath) : undefined;
    try {
      await tx?.begin();
      const rows = tx ? await tx.rows() : {};
      const isBefore = rowsDigest(rows) === rowsDigest(record.rowsBefore), isAfter = rowsDigest(rows) === rowsDigest(record.rowsAfter);
      if (!isBefore && !isAfter) throw new Error(bt('switch.err.db_external_modified'));
      const committed = isAfter && (!isBefore || record.phase === 'committed' || currentJournal.status === 'rolled-back');
      for (const file of record.files) {
        await this.regular(file.path);
        const value = await readFile(file.path, 'utf8');
        if (value !== file.before && value !== file.after && !resolveManagedFileTarget(file, value, committed ? 'after' : 'before')) {
          throw new Error(bt('switch.err.account_file_external'));
        }
      }
      const password = await this.keychain.readPassword('gemini', 'antigravity');
      if (password !== record.keychainBefore && password !== record.keychainAfter) throw new Error(bt('switch.err.keychain_external'));
      for (const file of record.files) {
        const current = await readFile(file.path, 'utf8');
        const desired = committed
          ? (current === file.after ? file.after : (resolveManagedFileTarget(file, current, 'after') ?? file.after))
          : (current === file.before ? file.before : (resolveManagedFileTarget(file, current, 'before') ?? file.before));
        if (current !== desired) await atomicText(file.path, desired);
      }
      const desiredPassword = committed ? record.keychainAfter : record.keychainBefore;
      if (password !== desiredPassword) {
        if (desiredPassword === null) await this.keychain.deletePassword('gemini', 'antigravity');
        else await this.keychain.writePassword('gemini', 'antigravity', desiredPassword);
      }
      // No database rewrite: its observed committed state selected which file/keychain state to keep.
      await tx?.finish(false);
      await atomicJson(this.journalPath, committed ? this.completedRollback(original) : original);
      await unlink(this.rollbackPath);
      this.manager.invalidateRuntimeCaches?.();
      if (committed) {
        const cliSnapshots = record.cliSnapshots ?? original.cliSnapshots;
        await this.restoreCliSnapshots(cliSnapshots, original);
      }
      return committed ? 'rolled-back' : 'restored';
    } finally { await tx?.close(); }
  }
  private async guardStopped() {
    if (this.options.isRunning) {
      if (await this.options.isRunning()) throw new Error(bt('switch.err.stop_app_first'));
      return;
    }
    if (isWindows()) {
      const candidateRoots = new Set<string>([this.target.appPath]);
      for (const dir of defaultAntigravityInstallDirs()) {
        candidateRoots.add(join(dir, 'Antigravity'));
        candidateRoots.add(join(dir, 'Antigravity - Insiders'));
        candidateRoots.add(join(dir, 'Antigravity Insiders'));
        candidateRoots.add(join(dir, 'Antigravity-Insiders'));
      }
      const procs = await appProcesses(Array.from(candidateRoots));
      if (procs.length > 0) throw new Error(bt('switch.err.stop_app_first'));
      return;
    }
    const candidatePrefixes = Array.from(
      // Insiders shares official credentials: block switching while it runs, without managing it.
      new Set([this.target.appPath, '/Applications/Antigravity.app', '/Applications/Antigravity - Insiders.app']),
    ).map(p => p + '/Contents/');
    const running = (await run('/bin/ps', ['-ax', '-ww', '-o', 'args='], { timeout: 3000 })).stdout.split('\n').some(line => {
      const trimmed = line.trim();
      return candidatePrefixes.some(prefix => trimmed.startsWith(prefix));
    });
    if (running) throw new Error(bt('switch.err.stop_app_first'));
  }
  private async archivePreviousJournal(previous: Journal) {
    const backupsDir = join(this.options.stateDir, 'account-switch-backups');
    const sanitized: Journal = {
      ...previous,
      before: sanitizeJournalRows(previous.before),
      after: sanitizeJournalRows(previous.after),
      keychainBefore: previous.keychainBefore ? '[REDACTED]' : null,
      keychainAfter: previous.keychainAfter ? '[REDACTED]' : '',
      files: sanitizeJournalFiles(previous.files),
      ...(previous.cliSnapshots ? { cliSnapshots: sanitizeJournalCliSnapshots(previous.cliSnapshots) } : {}),
    };
    const now = Date.now();
    await atomicJson(join(backupsDir, `${now}_${randomUUID().slice(0, 8)}.json`), sanitized);
    // 最多保留最近 3 份历史切号归档，按确凿时间戳排序清理早期记录
    const list = (await readdir(backupsDir).catch(() => [] as string[])).filter(n => n.endsWith('.json'));
    if (list.length > 3) {
      const filesWithTime = await Promise.all(list.map(async name => {
        const p = join(backupsDir, name);
        const match = name.match(/^(\d+)_/);
        if (match) return { path: p, time: Number(match[1]) };
        const st = await lstat(p).catch(() => null);
        return { path: p, time: st?.mtimeMs ?? 0 };
      }));
      filesWithTime.sort((a, b) => a.time - b.time);
      for (const item of filesWithTime.slice(0, filesWithTime.length - 3)) {
        await unlink(item.path).catch(() => {});
      }
    }
  }

  private async regular(path: string) {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || !isOwnedByCurrentUser(info)) throw new Error(bt('switch.err.invalid_login_file'));
  }
  private async optionalRegular(path: string): Promise<boolean> {
    try {
      await this.regular(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
  private async locked<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(this.options.stateDir, { recursive: true, mode: 0o700 });
    const path = join(this.options.stateDir, 'account-switch.lock');
    return withProcessLease(
      path,
      () => this.manager.runExclusive(operation),
      { timeoutMs: 0, busyMessage: bt('switch.err.busy') }
    );
  }
  private async restoreFiles(files: SavedFile[], keychainBefore: string | null, keychainAfter: string, keychainAfterDigest?: string) {
    const resolvedTargets: Array<{ path: string; target: string }> = [];
    for (const file of files) {
      const value = await readFile(file.path, 'utf8');
      const target = resolveManagedFileTarget(file, value, 'before');
      if (target === null) throw new Error(bt('switch.err.files_changed_after'));
      resolvedTargets.push({ path: file.path, target });
    }
    const current = await this.keychain.readPassword('gemini', 'antigravity');
    const matchesKeychainBefore = current === keychainBefore;
    const matchesKeychainAfter = (keychainAfter && keychainAfter !== '[REDACTED]' && current === keychainAfter) || (keychainAfterDigest && current !== null && sha256(current) === keychainAfterDigest);
    if (!matchesKeychainBefore && !matchesKeychainAfter) throw new Error(bt('switch.err.keychain_updated'));
    for (const item of resolvedTargets) await atomicText(item.path, item.target);
    if (keychainBefore === null) await this.keychain.deletePassword('gemini', 'antigravity');
    else await this.keychain.writePassword('gemini', 'antigravity', keychainBefore);
  }
  async switchAccount(id: string, target = 'all') {
    if (!['all', 'app'].includes(target)) throw new Error(bt('switch.err.desktop_only'));
    return this.locked(async () => {
      await this.guardStopped();
      await this.reconcileRollback();
      let previous: Journal | undefined;
      try { previous = JSON.parse(await readFile(this.journalPath, 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(bt('switch.err.journal_unreadable')); }
      if (previous && !['complete', 'rolled-back', 'cleared'].includes(previous.status)) throw new Error(bt('switch.err.previous_incomplete'));
      const acc = await this.manager.getAccount(id);
      if (!acc || acc.disabled || acc.validation_blocked) throw new Error(bt('switch.err.account_unavailable'));
      if (!acc.token?.refresh_token) throw new Error(bt('switch.err.refresh_credentials_first'));
      // Best-effort harvest of outgoing account's fresher local session token before overwriting host credentials.
      const preHarvestIndex = await this.manager.loadIndex().catch(() => null);
      const outgoingId = preHarvestIndex?.current_account_id;
      if (outgoingId && outgoingId !== id && typeof this.manager.harvestTokenForAccountId === 'function') {
        await this.manager.harvestTokenForAccountId(outgoingId, {
          keychain: this.keychain,
          homeDir: this.options.homeDir,
          profileDir: this.options.profile,
        }).catch(() => {});
      }
      const db = join(this.options.profile, 'User', 'globalStorage', 'state.vscdb');
      const hasDb = await this.optionalRegular(db);
      const transaction = hasDb ? this.database(db) : undefined;
      let journal: Journal | undefined, committed = false;
      try {
        let before: Rows = {}, after: Rows = {};
        if (transaction) {
          await transaction.begin();
          before = await transaction.rows();
          after = nextRows(before, acc);
        }
        const index = await this.manager.loadIndex();
        const stamp = Math.floor(Date.now() / 1000);
        const accountNext = { ...acc, last_used: stamp };
        const indexNext = { ...index, current_account_id: id, current_target_ide: 'app', accounts: index.accounts.map(a => a.id === id ? { ...a, last_used: stamp } : a) };
        const files: SavedFile[] = [];
        const snapshot = async (path: string, value: unknown) => { await this.regular(path); files.push({ path, before: await readFile(path, 'utf8'), after: JSON.stringify(value, null, 2) + '\n' }); };
        await snapshot(join(this.options.stateDir, 'accounts', `${id}.json`), accountNext);
        await snapshot(join(this.options.stateDir, 'accounts.json'), indexNext);
        const keychainBefore = await this.keychain.readPassword('gemini', 'antigravity');
        // Build the exact intended value with an in-memory adapter; no system write yet.
        let keychainAfter = '';
        await syncAccountToKeychain(acc, { payloadEncoding: this.keychain.payloadEncoding, readPassword: async () => null, deletePassword: async () => {}, writePassword: async (_s, _a, value) => { keychainAfter = value; } });
        const afterDigest = rowsDigest(after);
        const keychainAfterDigest = sha256(keychainAfter);
        const filesWithDigest: SavedFile[] = files.map(f => ({ ...f, afterDigest: sha256(f.after) }));
        const cliPayload = buildGoOauthPayload(acc);
        const cliSnapshots = await this.snapshotExistingCliCredentials(cliPayload, acc);
        journal = { version: 1, status: 'pending', before, after, afterDigest, files: filesWithDigest, ...(cliSnapshots.length ? { cliSnapshots } : {}), keychainBefore, keychainAfter, keychainAfterDigest, at: new Date().toISOString() };
        if (previous) await this.archivePreviousJournal(previous);
        await atomicJson(this.journalPath, journal);
        await this.guardStopped();
        if (transaction) await transaction.replace(after);
        await this.keychain.writePassword('gemini', 'antigravity', keychainAfter);
        for (const file of files) {
          if (await readFile(file.path, 'utf8') !== file.before) throw new Error(bt('switch.err.record_changed_retry'));
          await atomicText(file.path, file.after);
        }
        await this.guardStopped();
        if (transaction) await transaction.finish(true);
        committed = true;
        this.manager.invalidateRuntimeCaches?.();
        await this.manager.recordAutoSwitchChoice(acc.id).catch(() => {});
        await atomicJson(this.journalPath, {
          ...journal,
          status: 'complete',
          after: sanitizeJournalRows(after),
          keychainAfter: '[REDACTED]',
          files: filesWithDigest.map(f => ({
            path: f.path,
            before: f.before,
            after: !isNonSensitiveIndexFile(f.path) ? '[REDACTED_ACCOUNT]' : f.after,
            afterDigest: f.afterDigest,
          })),
        });
        const cliSync = await this.syncExistingCliCredentials(cliPayload);
        return {
          switchedTo: acc.email,
          message: bt('switch.msg.switched'),
          ...(cliSync.syncedPaths.length ? { cliSynced: cliSync.syncedPaths.length } : {}),
          ...(cliSync.warnings.length ? { cliWarnings: cliSync.warnings } : {}),
        };
      } catch (error) {
        if (!committed) {
          await transaction?.finish(false).catch(() => {});
          if (journal) {
            try { await this.restoreFiles(journal.files, journal.keychainBefore, journal.keychainAfter, journal.keychainAfterDigest); await atomicJson(this.journalPath, this.completedRollback(journal)); }
            catch { throw new Error(bt('switch.err.restore_blocked')); }
          }
          throw new Error(error instanceof Error ? error.message : bt('switch.err.switch_failed_restored'));
        }
        throw new Error(bt('switch.err.committed_journal_unsaved'));
      } finally { await transaction?.close(); }
    });
  }
  async recoveryInfo() {
    try {
      const raw=await readFile(this.journalPath,'utf8'), journal=JSON.parse(raw) as Journal;
      const at=Date.parse(journal.at), expiresAt=Number.isFinite(at)?new Date(at+7*86400000).toISOString():null;
      const interruptedUndo = await this.optionalRegular(this.rollbackPath);
      const pending=interruptedUndo||!['complete','rolled-back','cleared'].includes(journal.status);
      const hasCliCreds = Boolean(journal.cliSnapshots?.some(s => s.existedBefore && s.before !== null && s.before !== '[REDACTED_CLI]'));
      return {available:journal.status!=='cleared'||interruptedUndo,status:interruptedUndo?'rollback-pending':journal.status,createdAt:journal.at,expiresAt,pending,expired:!pending&&(!expiresAt||Date.parse(expiresAt)<Date.now()),digest:sha256(raw),containsCredentials:interruptedUndo||!!Object.keys(journal.before??{}).length||!!journal.keychainBefore||hasCliCreds};
    } catch(error) {if((error as NodeJS.ErrnoException).code==='ENOENT')return{available:false}; throw new Error(bt('switch.err.recovery_unreadable'));}
  }
  async clearRecovery(expectedDigest: string) {
    return this.locked(async()=>{
      if (await this.optionalRegular(this.rollbackPath)) throw new Error(bt('switch.err.rollback_unfinished_clear'));
      const raw=await readFile(this.journalPath,'utf8'), journal=JSON.parse(raw) as Journal;
      if(sha256(raw)!==expectedDigest)throw new Error(bt('switch.err.recovery_changed_repreview'));
      if(!['complete','rolled-back'].includes(journal.status))throw new Error(bt('switch.err.incomplete_clear_forbidden'));
      await atomicJson(this.journalPath,{version:1,status:'cleared',at:journal.at,clearedAt:new Date().toISOString(),before:{},after:{},files:[],cliSnapshots:[],keychainBefore:null,keychainAfter:''});
      return {message:bt('switch.msg.recovery_cleared')};
    });
  }
  async rollback() {
    return this.locked(async () => {
      await this.guardStopped();
      if (await this.reconcileRollback() === 'rolled-back') return { message: bt('switch.msg.interrupted_restored') };
      const journal = JSON.parse(await readFile(this.journalPath, 'utf8')) as Journal;
      if (journal.status === 'rolled-back') throw new Error(bt('switch.err.already_rolled_back'));
      if (journal.status === 'cleared') throw new Error(bt('switch.err.already_cleared'));
      if (journal.status === 'complete' && (!Number.isFinite(Date.parse(journal.at)) || Date.now()-Date.parse(journal.at)>7*86400000)) throw new Error(bt('switch.err.expired_7d'));
      const db = join(this.options.profile, 'User', 'globalStorage', 'state.vscdb');
      const hasDb = await this.optionalRegular(db);
      const transaction = hasDb ? this.database(db) : undefined;
      let record: RollbackRecord | undefined;
      try {
        let rows: Rows = {};
        if (transaction) {
          await transaction.begin();
          rows = await transaction.rows();
          const currentCanonical = JSON.stringify(Object.entries(rows).sort());
          const beforeCanonical = JSON.stringify(Object.entries(journal.before).sort());
          const matchesBefore = currentCanonical === beforeCanonical;
          const currentDigest = rowsDigest(rows);
          const matchesAfterDigest = journal.afterDigest ? currentDigest === journal.afterDigest : false;
          const matchesAfterRows = journal.after ? currentCanonical === JSON.stringify(Object.entries(journal.after).sort()) : false;
          if (!matchesBefore && !matchesAfterDigest && !matchesAfterRows) throw new Error(bt('switch.err.db_changed_abort_rollback'));
        } else {
          if (Object.keys(journal.before || {}).length > 0) throw new Error(bt('switch.err.db_changed_abort_rollback'));
        }
        const snapshots: SavedFile[] = [];
        for (const file of journal.files) {
          await this.regular(file.path);
          const current = await readFile(file.path, 'utf8');
          const resolved = resolveManagedFileTarget(file, current, 'before');
          if (resolved === null) throw new Error(bt('switch.err.files_changed_after'));
          snapshots.push({ path: file.path, before: current, after: resolved });
        }
        record = { version: 1, phase: 'prepared', databasePath: db, hadDatabase: hasDb, rowsBefore: rows, rowsAfter: journal.before,
          files: snapshots, ...(journal.cliSnapshots ? { cliSnapshots: journal.cliSnapshots } : {}), keychainBefore: await this.keychain.readPassword('gemini', 'antigravity'), keychainAfter: journal.keychainBefore, originalJournal: journal };
        await atomicJson(this.rollbackPath, record);
        await atomicJson(this.journalPath, { ...journal, status: 'rolling-back' });
        await this.restoreFiles(journal.files, journal.keychainBefore, journal.keychainAfter, journal.keychainAfterDigest);
        if (transaction) await transaction.replace(journal.before);
        await this.guardStopped();
        if (transaction) await transaction.finish(true);
        this.manager.invalidateRuntimeCaches?.();
        record.phase = 'committed'; await atomicJson(this.rollbackPath, record);
        await atomicJson(this.journalPath, this.completedRollback(journal));
        await unlink(this.rollbackPath);
        const cliSync = await this.restoreCliSnapshots(journal.cliSnapshots, journal);
        return {
          message: bt('switch.msg.restored_previous'),
          ...(cliSync.syncedPaths.length ? { cliSynced: cliSync.syncedPaths.length } : {}),
          ...(cliSync.warnings.length ? { cliWarnings: cliSync.warnings } : {}),
        };
      } catch (error) {
        await transaction?.finish(false).catch(() => {});
        await transaction?.close();
        if (record) {
          try {
            if (await this.reconcileRollback() === 'rolled-back') {
              return { message: bt('switch.msg.restored_previous') };
            }
          } catch {
            throw new Error(bt('switch.err.rollback_blocked'));
          }
        }
        throw error;
      } finally { await transaction?.close(); }
    });
  }
}
