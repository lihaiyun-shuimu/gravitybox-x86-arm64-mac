import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join, posix, resolve, win32 } from 'node:path';
import { bt } from '../i18n.js';
import { atomicRenameWithRetry, isOwnedByCurrentUser } from './fs.js';

const NAMED_PIPE_RE = /^\\\\[.?]\\pipe\\/i;
const WINDOWS_RANDOM_PIPE_RE = /^\\\\\.\\pipe\\gravitybox-[0-9a-f]{16}-[0-9a-f]{16}$/i;
const AUTH_TOKEN_RE = /^[0-9a-f]{64}$/;

export const IPC_SESSION_FILENAME = 'ipc-session.json';

export interface WindowsIpcSession {
  schema: 1;
  pipeName: string;
  authToken: string;
  pid: number;
  createdAt: string;
}

/**
 * Contract for native Windows pipe peer verification (implemented via
 * GetNamedPipeServerProcessId + OpenProcessToken + EqualSid in win-helper / Tauri shell).
 */
export interface WindowsPipeServerIdentity {
  pipeName: string;
  serverPid: number;
  sameUserSid: boolean;
}

export type WindowsPipeServerIdentityVerifier = (
  session: WindowsIpcSession,
) => Promise<WindowsPipeServerIdentity | null>;

export interface ClientIpcTarget {
  endpoint: string;
  authToken: string | null;
  session: WindowsIpcSession | null;
}

function normalizeWindowsStateDirForHash(stateDir: string): string {
  let resolved = process.platform === 'win32' ? resolve(stateDir) : win32.resolve(stateDir);
  if (/^\\\\\?\\UNC\\/i.test(resolved)) {
    resolved = '\\\\' + resolved.slice(8);
  } else if (/^\\\\\?\\/.test(resolved)) {
    resolved = resolved.slice(4);
  }
  return resolved.toLowerCase();
}

export function computeWindowsStateHash16(stateDir: string): string {
  return createHash('sha256')
    .update(normalizeWindowsStateDirForHash(stateDir), 'utf8')
    .digest('hex')
    .slice(0, 16);
}

/**
 * Check whether an IPC endpoint string refers to a Windows Named Pipe.
 */
export function isNamedPipe(endpoint: string): boolean {
  return NAMED_PIPE_RE.test(endpoint);
}

/**
 * Check whether an endpoint matches the anti-squatting randomized Windows pipe format:
 * `\\.\pipe\gravitybox-<stateHash16>-<random16>`
 */
export function isRandomWindowsPipeName(endpoint: string): boolean {
  return WINDOWS_RANDOM_PIPE_RE.test(endpoint);
}

export function isValidIpcAuthToken(token: unknown): token is string {
  return typeof token === 'string' && AUTH_TOKEN_RE.test(token);
}

/**
 * Return the path to the per-user Windows IPC session descriptor file (`<stateDir>/ipc-session.json`).
 */
export function ipcSessionPath(stateDir: string): string {
  return join(stateDir, IPC_SESSION_FILENAME);
}

/**
 * Generate a fresh per-startup Windows IPC session with an unpredictable random pipe name
 * and a 256-bit CSPRNG session authentication token to defeat global Named Pipe squatting.
 */
export function createWindowsIpcSession(
  stateDir: string,
  pid: number = process.pid,
): WindowsIpcSession {
  const stateHash16 = computeWindowsStateHash16(stateDir);
  const random16 = randomBytes(8).toString('hex');
  const authToken = randomBytes(32).toString('hex');
  return {
    schema: 1,
    pipeName: `\\\\.\\pipe\\gravitybox-${stateHash16}-${random16}`,
    authToken,
    pid,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Atomically write `<stateDir>/ipc-session.json` (0600, refusing symlinks and non-user files).
 */
export async function writeIpcSession(
  stateDir: string,
  session: WindowsIpcSession,
): Promise<string> {
  const expectedPrefix = `\\\\.\\pipe\\gravitybox-${computeWindowsStateHash16(stateDir)}-`;
  if (
    !session ||
    session.schema !== 1 ||
    !isRandomWindowsPipeName(session.pipeName) ||
    !session.pipeName.toLowerCase().startsWith(expectedPrefix) ||
    !isValidIpcAuthToken(session.authToken) ||
    !Number.isInteger(session.pid) ||
    session.pid <= 0
  ) {
    throw new Error(bt('main.socket_mismatch'));
  }

  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const targetPath = ipcSessionPath(stateDir);
  try {
    const existing = await lstat(targetPath);
    if (!existing.isFile() || existing.isSymbolicLink() || !isOwnedByCurrentUser(existing)) {
      throw new Error(bt('files.refuse_non_user_file'));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const tempPath = `${targetPath}.${randomUUID()}.tmp`;
  const payload = JSON.stringify(session, null, 2) + '\n';
  try {
    const handle = await open(tempPath, 'wx', 0o600);
    try {
      await handle.writeFile(payload, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await atomicRenameWithRetry(tempPath, targetPath);
  } finally {
    await unlink(tempPath).catch(() => {});
  }
  return targetPath;
}

/**
 * Read and validate `<stateDir>/ipc-session.json`.
 * - Returns `null` when missing or malformed.
 * - Throws `main.socket_mismatch` if the path is a symlink, non-regular file, or owned by another user.
 * - Verifies the pipe's `<stateHash16>` prefix binds strictly to `stateDir`.
 */
export async function readIpcSession(stateDir: string): Promise<WindowsIpcSession | null> {
  const targetPath = ipcSessionPath(stateDir);
  let info;
  try {
    info = await lstat(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || !isOwnedByCurrentUser(info)) {
    throw new Error(bt('main.socket_mismatch'));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(targetPath, 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const pipeName = typeof record.pipeName === 'string' ? record.pipeName.trim() : '';
  const authToken = record.authToken;
  const pid = record.pid;
  const createdAt = typeof record.createdAt === 'string' ? record.createdAt : '';

  if (record.schema !== 1) return null;
  if (!isRandomWindowsPipeName(pipeName)) return null;
  const expectedPrefix = `\\\\.\\pipe\\gravitybox-${computeWindowsStateHash16(stateDir)}-`;
  if (!pipeName.toLowerCase().startsWith(expectedPrefix)) return null;
  if (!isValidIpcAuthToken(authToken)) return null;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;

  return {
    schema: 1,
    pipeName,
    authToken,
    pid,
    createdAt,
  };
}

/**
 * Clean up `<stateDir>/ipc-session.json`.
 * When `expectedPid` is provided, only deletes the file if it still belongs to `expectedPid`
 * so an exiting process never removes a newer instance's session file.
 */
export async function cleanupIpcSession(stateDir: string, expectedPid?: number): Promise<void> {
  const targetPath = ipcSessionPath(stateDir);
  let info;
  try {
    info = await lstat(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    return;
  }
  if (!info.isFile() || info.isSymbolicLink() || !isOwnedByCurrentUser(info)) return;

  if (expectedPid !== undefined) {
    try {
      const parsed = JSON.parse(await readFile(targetPath, 'utf8')) as { pid?: unknown };
      if (typeof parsed?.pid === 'number' && parsed.pid !== expectedPid) {
        return;
      }
    } catch {
      // Corrupt/stale file — safe to remove below
    }
  }
  await unlink(targetPath).catch(() => {});
}

/**
 * Constant-time authentication token verification using `crypto.timingSafeEqual`.
 */
export function verifyIpcAuthToken(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  if (!provided || !expected) return false;
  const providedBuf = Buffer.from(provided, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}

/**
 * Compute the IPC endpoint for a GravityBox `stateDir`.
 * - macOS / POSIX: `<stateDir>/control.sock`
 * - Windows: deterministic fallback pipe name (production Windows servers use randomized
 *   `createWindowsIpcSession()` + `ipc-session.json` to prevent global pipe squatting).
 */
export function resolveIpcEndpoint(
  stateDir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') {
    const digest = createHash('sha256')
      .update(normalizeWindowsStateDirForHash(stateDir), 'utf8')
      .digest('hex')
      .slice(0, 24);
    return `\\\\.\\pipe\\gravitybox-${digest}`;
  }
  return posix.join(stateDir, 'control.sock');
}

function probeIpcServerAlive(endpoint: string, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolveLive, reject) => {
    const client = createConnection(endpoint);
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    client.once('connect', () => {
      done(() => {
        client.destroy();
        resolveLive(true);
      });
    });
    client.once('error', (error: NodeJS.ErrnoException) => {
      done(() => {
        client.destroy();
        const code = error.code ?? '';
        if (code === 'ECONNREFUSED' || code === 'ENOENT') {
          resolveLive(false);
        } else if (isNamedPipe(endpoint) && (code === 'EBUSY' || code === 'EACCES' || code === 'EPIPE')) {
          reject(new Error(bt('main.socket_busy')));
        } else {
          reject(new Error(bt('main.socket_unconfirmed')));
        }
      });
    });
    client.setTimeout(timeoutMs, () => {
      done(() => {
        client.destroy();
        reject(new Error(bt('main.socket_busy')));
      });
    });
  });
}

/**
 * Check for any already-running Windows instance recorded in `<stateDir>/ipc-session.json`,
 * clean up stale session descriptors, and allocate a fresh randomized Windows IPC session.
 * Callers should `server.listen(session.pipeName)` and then `await writeIpcSession(stateDir, session)`.
 */
export async function prepareWindowsIpcForListen(
  stateDir: string,
  options: { probeTimeoutMs?: number; pid?: number } = {},
): Promise<WindowsIpcSession> {
  const timeoutMs = options.probeTimeoutMs ?? 1500;
  const existing = await readIpcSession(stateDir);
  if (existing) {
    const live = await probeIpcServerAlive(existing.pipeName, timeoutMs);
    if (live) {
      throw new Error(bt('main.assistant_already_running'));
    }
    await cleanupIpcSession(stateDir, existing.pid);
  }
  return createWindowsIpcSession(stateDir, options.pid ?? process.pid);
}

/**
 * Resolve the active client IPC target for `stateDir`.
 * - macOS / POSIX: returns `{ endpoint: '<stateDir>/control.sock', authToken: null, session: null }`.
 * - Windows: reads `<stateDir>/ipc-session.json`, optionally runs `verifyServerIdentity`
 *   (e.g. GetNamedPipeServerProcessId + EqualSid), and returns `{ endpoint, authToken, session }`
 *   or `null` if no active session descriptor exists.
 */
export async function resolveClientIpcTarget(
  stateDir: string,
  options: {
    platform?: NodeJS.Platform;
    verifyServerIdentity?: WindowsPipeServerIdentityVerifier;
  } = {},
): Promise<ClientIpcTarget | null> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') {
    return {
      endpoint: resolveIpcEndpoint(stateDir, platform),
      authToken: null,
      session: null,
    };
  }
  const session = await readIpcSession(stateDir);
  if (!session) return null;
  if (options.verifyServerIdentity) {
    const identity = await options.verifyServerIdentity(session);
    if (!identity || !identity.sameUserSid || identity.serverPid !== session.pid) {
      throw new Error(bt('main.socket_mismatch'));
    }
  }
  return {
    endpoint: session.pipeName,
    authToken: session.authToken,
    session,
  };
}

/**
 * Prepare an IPC endpoint before calling `server.listen(endpoint)`.
 * - Windows Named Pipe: never calls lstat/uid/unlink; probes whether another server is already active.
 * - macOS / POSIX Unix socket: validates socket type & owner, rejects if live, unlinks stale socket safely.
 */
export async function prepareIpcEndpointForListen(
  endpoint: string,
  options: { probeTimeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.probeTimeoutMs ?? 1500;
  if (isNamedPipe(endpoint)) {
    const live = await probeIpcServerAlive(endpoint, timeoutMs);
    if (live) throw new Error(bt('main.assistant_already_running'));
    return;
  }

  try {
    const info = await lstat(endpoint);
    if (!info.isSocket() || !isOwnedByCurrentUser(info)) {
      throw new Error(bt('main.socket_mismatch'));
    }
    const live = await probeIpcServerAlive(endpoint, timeoutMs);
    if (live) throw new Error(bt('main.assistant_already_running'));
    const current = await lstat(endpoint);
    if (current.ino !== info.ino || current.dev !== info.dev) {
      throw new Error(bt('main.socket_changed'));
    }
    await unlink(endpoint);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/**
 * Post-listen endpoint hardening (0600 chmod for Unix sockets; no-op for Windows Named Pipes).
 */
export async function finalizeIpcEndpointAfterListen(endpoint: string): Promise<void> {
  if (isNamedPipe(endpoint)) return;
  await chmod(endpoint, 0o600);
}

/**
 * Clean up IPC endpoint on server shutdown.
 * - Windows Named Pipe: no-op (pipes are kernel-managed and disappear once handles close).
 * - macOS / POSIX Unix socket: unlinks the socket file.
 */
export async function cleanupIpcEndpoint(endpoint: string): Promise<void> {
  if (isNamedPipe(endpoint)) return;
  await unlink(endpoint).catch(() => {});
}

/**
 * Validate an IPC endpoint before a client connects.
 * - Windows Named Pipe: no-op (never calls lstat/uid; connection errors surface as not-running).
 * - macOS / POSIX Unix socket: verifies socket exists, is a non-symlink socket, and belongs to current user.
 */
export async function validateIpcEndpointForClient(endpoint: string): Promise<void> {
  if (isNamedPipe(endpoint)) return;
  const sockInfo = await lstat(endpoint).catch((err: NodeJS.ErrnoException) => {
    if (err?.code === 'ENOENT') throw new Error(bt('main.assistant_not_running'));
    throw err;
  });
  if (!sockInfo.isSocket() || sockInfo.isSymbolicLink() || !isOwnedByCurrentUser(sockInfo)) {
    throw new Error(bt('main.socket_mismatch'));
  }
}
