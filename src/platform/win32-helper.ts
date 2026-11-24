import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Win32HelperOptions {
  helperPath?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface Win32LsProcess {
  pid: number;
  exePath: string;
  cmdLine: string;
  ports: number[];
  csrfToken: string | null;
}

export interface Win32PortOwner {
  pid: number;
  exePath: string;
  localAddress: string;
  port: number;
}

export interface Win32AppProcess {
  pid: number;
  exePath: string;
  cmdLine: string;
}

export type Win32GracefulCloseReason =
  | 'clean_exit'
  | 'background_terminated'
  | 'visible_window_open'
  | 'timeout'
  | (string & {});

export interface Win32GracefulCloseResult {
  closed: boolean;
  remainingPids: number[];
  reason?: Win32GracefulCloseReason;
}

export interface Win32GracefulCloseOptions extends Win32HelperOptions {
  closeTimeoutMs?: number;
  terminateBackground?: boolean;
  graceMs?: number;
}

export interface Win32PeVersion {
  fileVersion: string;
  productVersion: string;
  productName: string;
  companyName: string;
}

export class Win32HelperError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'Win32HelperError';
    this.code = code;
  }
}

const HELPER_BINARY_NAME = 'gravitybox-win-helper.exe';
const MAX_HELPER_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_HELPER_TIMEOUT_MS = 8_000;

/**
 * Candidate search order for `gravitybox-win-helper.exe`:
 * 1. Explicit `explicitPath` option
 * 2. `process.env.GRAVITYBOX_WIN_HELPER_PATH`
 * 3. `windows/win-helper/target/release/gravitybox-win-helper.exe`
 * 4. `windows/win-helper/target/debug/gravitybox-win-helper.exe`
 * 5. Packaged relative `resources/gravitybox-win-helper.exe` locations
 */
function stripVerbatimPrefix(filePath: string): string {
  if (/^\\\\\?\\UNC\\/i.test(filePath)) return '\\\\' + filePath.slice(8);
  if (/^\\\\\?\\/.test(filePath)) return filePath.slice(4);
  return filePath;
}

export function resolveWin32HelperCandidates(explicitPath?: string): string[] {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(moduleDir, '..', '..');
  const execDir = dirname(process.execPath);

  const raw = [
    explicitPath?.trim(),
    process.env.GRAVITYBOX_WIN_HELPER_PATH?.trim(),
    join(repoRoot, 'windows', 'win-helper', 'target', 'release', HELPER_BINARY_NAME),
    join(repoRoot, 'windows', 'win-helper', 'target', 'debug', HELPER_BINARY_NAME),
    join(repoRoot, 'resources', HELPER_BINARY_NAME),
    // Packaged layout: <app>/resources/core/dist/platform/win32-helper.js -> <app>/resources/gravitybox-win-helper.exe
    join(moduleDir, '..', '..', '..', HELPER_BINARY_NAME),
    // Packaged runtime layout: <app>/resources/runtime/node.exe -> <app>/resources/gravitybox-win-helper.exe
    join(execDir, '..', HELPER_BINARY_NAME),
    join(execDir, 'resources', HELPER_BINARY_NAME),
    join(execDir, HELPER_BINARY_NAME),
  ];

  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const item of raw) {
    if (!item) continue;
    const normalized = stripVerbatimPrefix(item);
    const key = normalized.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      candidates.push(normalized);
    }
  }
  return candidates;
}

export function resolveWin32HelperPath(
  explicitPath?: string,
  existsFn: (path: string) => boolean = existsSync,
): string | null {
  for (const candidate of resolveWin32HelperCandidates(explicitPath)) {
    if (existsFn(candidate)) return candidate;
  }
  return null;
}

interface RawHelperErrorResponse {
  ok: false;
  code?: unknown;
  error?: unknown;
}

interface InvokeOptions extends Win32HelperOptions {
  stdinJson?: unknown;
  /** Suppress echoing stdout details in error messages for commands handling credentials/tokens. */
  sensitiveOutput?: boolean;
}

function sanitizeHelperMessage(text: unknown, fallback: string): string {
  if (typeof text !== 'string') return fallback;
  const cleaned = text.replace(/[\r\n]+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, 240) : fallback;
}

async function invokeWin32Helper<T extends Record<string, unknown>>(
  args: string[],
  options: InvokeOptions = {},
): Promise<T> {
  const helperPath = resolveWin32HelperPath(options.helperPath);
  if (!helperPath) {
    throw new Win32HelperError(
      'HELPER_NOT_FOUND',
      `Unable to locate ${HELPER_BINARY_NAME}. Build windows/win-helper or set GRAVITYBOX_WIN_HELPER_PATH.`,
    );
  }

  options.signal?.throwIfAborted();

  const timeoutMs = Math.max(500, options.timeoutMs ?? DEFAULT_HELPER_TIMEOUT_MS);
  const stdinPayload = options.stdinJson !== undefined ? JSON.stringify(options.stdinJson) + '\n' : undefined;

  return new Promise<T>((resolveResult, reject) => {
    const child = spawn(helperPath, args, {
      stdio: [stdinPayload !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let settled = false;
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    const stderrChunks: Buffer[] = [];
    let stderrBytes = 0;

    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const succeed = (val: T) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveResult(val);
    };

    const killChild = () => {
      try {
        child.kill();
      } catch {
        // ignore kill failures
      }
    };

    const onAbort = () => {
      killChild();
      fail(new Win32HelperError('HELPER_ABORTED', `win32-helper command aborted: ${args[0] ?? 'unknown'}`));
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(() => {
      killChild();
      fail(new Win32HelperError('HELPER_TIMEOUT', `win32-helper timed out after ${timeoutMs}ms (${args[0] ?? 'unknown'})`));
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_HELPER_OUTPUT_BYTES) {
        killChild();
        fail(new Win32HelperError('HELPER_OUTPUT_TOO_LARGE', `win32-helper output exceeded ${MAX_HELPER_OUTPUT_BYTES} bytes`));
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBytes < 8192) {
        stderrChunks.push(chunk);
        stderrBytes += chunk.length;
      }
    });

    child.once('error', (error: NodeJS.ErrnoException) => {
      const code = error?.code === 'ENOENT' ? 'HELPER_NOT_FOUND' : 'HELPER_SPAWN_ERROR';
      fail(new Win32HelperError(code, `Failed to spawn ${HELPER_BINARY_NAME}: ${sanitizeHelperMessage(error?.message, code)}`));
    });

    child.once('close', (exitCode) => {
      if (settled) return;
      const stdoutText = Buffer.concat(stdoutChunks).toString('utf8').trim();
      const stderrText = Buffer.concat(stderrChunks).toString('utf8').trim();
      let parsed: unknown;
      if (stdoutText) {
        try {
          parsed = JSON.parse(stdoutText);
        } catch {
          const lastLine = stdoutText.split(/\r?\n/).filter((line) => line.trim()).pop();
          if (lastLine) {
            try {
              parsed = JSON.parse(lastLine);
            } catch {
              parsed = undefined;
            }
          }
        }
      }

      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        if (record.ok === true) {
          succeed(record as T);
          return;
        }
        if (record.ok === false) {
          const errResp = record as unknown as RawHelperErrorResponse;
          const code = typeof errResp.code === 'string' && errResp.code.trim() ? errResp.code.trim() : 'HELPER_ERROR';
          const fallbackMsg = `win32-helper failed with code ${code}`;
          const message = options.sensitiveOutput
            ? fallbackMsg
            : sanitizeHelperMessage(errResp.error, fallbackMsg);
          fail(new Win32HelperError(code, message));
          return;
        }
      }

      const detail = options.sensitiveOutput
        ? `exit=${exitCode ?? 'null'}`
        : sanitizeHelperMessage(stderrText || `exit=${exitCode ?? 'null'}`, `exit=${exitCode ?? 'null'}`);
      fail(new Win32HelperError('HELPER_INVALID_RESPONSE', `win32-helper (${args[0] ?? 'unknown'}) returned invalid JSON (${detail})`));
    });

    if (stdinPayload !== undefined && child.stdin) {
      child.stdin.on('error', () => {
        // EPIPE is handled by close/error listeners
      });
      child.stdin.end(stdinPayload, 'utf8');
    }
  });
}

/**
 * Read a generic credential from Windows Credential Manager (`${service}:${account}`).
 * Returns `null` when not found.
 */
export async function credRead(
  service: string,
  account: string,
  options?: Win32HelperOptions,
): Promise<string | null> {
  const res = await invokeWin32Helper<{ ok: true; found?: boolean; value?: string | null }>(
    ['cred-read', '--service', service, '--account', account],
    { ...options, sensitiveOutput: true },
  );
  if (!res.found) return null;
  return typeof res.value === 'string' ? res.value : null;
}

/**
 * Write a generic credential to Windows Credential Manager (`${service}:${account}`).
 * Secret payload is strictly transmitted over stdin JSON, never in argv.
 */
export async function credWrite(
  service: string,
  account: string,
  value: string,
  options?: Win32HelperOptions,
): Promise<void> {
  await invokeWin32Helper<{ ok: true }>(
    ['cred-write'],
    { ...options, stdinJson: { service, account, value }, sensitiveOutput: true },
  );
}

/**
 * Delete a generic credential from Windows Credential Manager (`${service}:${account}`).
 */
export async function credDelete(
  service: string,
  account: string,
  options?: Win32HelperOptions,
): Promise<{ deleted: boolean }> {
  const res = await invokeWin32Helper<{ ok: true; deleted?: boolean }>(
    ['cred-delete', '--service', service, '--account', account],
    options,
  );
  return { deleted: res.deleted === true };
}

/**
 * Inspect running Antigravity language server processes, listening 127.0.0.1 ports,
 * command line, and CSRF token (from CLI flag or PEB environment block).
 */
export async function lsInspect(
  options?: Win32HelperOptions & { exeFilter?: string },
): Promise<Win32LsProcess[]> {
  const args = ['ls-inspect'];
  if (options?.exeFilter) {
    args.push('--exe-filter', options.exeFilter);
  }
  const res = await invokeWin32Helper<{ ok: true; processes?: unknown }>(args, {
    ...options,
    sensitiveOutput: true,
  });
  if (!Array.isArray(res.processes)) return [];
  return res.processes
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item) => ({
      pid: Number(item.pid) || 0,
      exePath: typeof item.exePath === 'string' ? item.exePath : '',
      cmdLine: typeof item.cmdLine === 'string' ? item.cmdLine : '',
      ports: Array.isArray(item.ports)
        ? item.ports.map((p) => Number(p)).filter((p) => Number.isInteger(p) && p > 0 && p <= 65535)
        : [],
      csrfToken: typeof item.csrfToken === 'string' && item.csrfToken.length > 0 ? item.csrfToken : null,
    }))
    .filter((item) => item.pid > 0);
}

/**
 * Find processes listening on a specific TCP port (IPv4 and IPv6).
 */
export async function portOwner(
  port: number,
  options?: Win32HelperOptions,
): Promise<Win32PortOwner[]> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Win32HelperError('INVALID_PORT', `Invalid TCP port: ${String(port)}`);
  }
  const res = await invokeWin32Helper<{ ok: true; owners?: unknown }>(
    ['port-owner', '--port', String(port)],
    options,
  );
  if (!Array.isArray(res.owners)) return [];
  return res.owners
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item) => ({
      pid: Number(item.pid) || 0,
      exePath: typeof item.exePath === 'string' ? item.exePath : '',
      localAddress: typeof item.localAddress === 'string' ? item.localAddress : '',
      port: Number(item.port) || port,
    }))
    .filter((item) => item.pid > 0);
}

/**
 * Enumerate running processes whose executable path matches any of the given prefixes.
 */
export async function appProcesses(
  prefixes: string[] = [],
  options?: Win32HelperOptions,
): Promise<Win32AppProcess[]> {
  const args = ['app-processes'];
  for (const prefix of prefixes) {
    if (typeof prefix === 'string' && prefix.trim()) {
      args.push('--prefix', prefix);
    }
  }
  const res = await invokeWin32Helper<{ ok: true; processes?: unknown }>(args, options);
  if (!Array.isArray(res.processes)) return [];
  return res.processes
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item) => ({
      pid: Number(item.pid) || 0,
      exePath: typeof item.exePath === 'string' ? item.exePath : '',
      cmdLine: typeof item.cmdLine === 'string' ? item.cmdLine : '',
    }))
    .filter((item) => item.pid > 0);
}

/**
 * Gracefully close all processes under `prefix` using progressive staged shutdown:
 * 1. Send WM_CLOSE to visible top-level windows (never force-kills while any visible window remains open).
 * 2. Once no visible windows remain, send WM_CLOSE to hidden/tray top-level windows and wait `graceMs`.
 * 3. Only when `terminateBackground` is explicitly enabled and 0 visible windows are re-confirmed,
 *    terminate remaining headless/background processes under `prefix`.
 */
export async function appGracefulClose(
  prefix: string,
  options?: Win32GracefulCloseOptions,
): Promise<Win32GracefulCloseResult> {
  const closeTimeoutMs = Math.max(200, Math.floor(options?.closeTimeoutMs ?? 8_000));
  const args = ['app-graceful-close', '--prefix', prefix, '--timeout-ms', String(closeTimeoutMs)];
  if (options?.terminateBackground === true) {
    args.push('--terminate-background');
  }
  const graceMs =
    typeof options?.graceMs === 'number' && Number.isFinite(options.graceMs)
      ? Math.max(100, Math.floor(options.graceMs))
      : undefined;
  if (graceMs !== undefined) {
    args.push('--grace-ms', String(graceMs));
  }
  const stageOverheadMs = (options?.terminateBackground === true ? 8_000 : 4_000) + (graceMs ?? 0);
  const processTimeoutMs = Math.max(options?.timeoutMs ?? 0, closeTimeoutMs + stageOverheadMs);
  const res = await invokeWin32Helper<{
    ok: true;
    closed?: boolean;
    remainingPids?: unknown;
    reason?: unknown;
  }>(args, {
    ...options,
    timeoutMs: processTimeoutMs,
  });
  const remainingPids = Array.isArray(res.remainingPids)
    ? res.remainingPids.map((pid) => Number(pid)).filter((pid) => Number.isInteger(pid) && pid > 0)
    : [];
  const reason = typeof res.reason === 'string' && res.reason.trim().length > 0
    ? (res.reason.trim() as Win32GracefulCloseReason)
    : undefined;
  return {
    closed: res.closed === true,
    remainingPids,
    ...(reason !== undefined ? { reason } : {}),
  };
}

/**
 * Move files or directories to the Windows Recycle Bin via SHFileOperationW.
 * Paths are passed over stdin JSON.
 */
export async function trashMove(
  paths: string[],
  options?: Win32HelperOptions,
): Promise<{ moved: string[] }> {
  const cleaned = paths.filter((p): p is string => typeof p === 'string' && p.trim().length > 0);
  if (cleaned.length === 0) return { moved: [] };
  const res = await invokeWin32Helper<{ ok: true; moved?: unknown }>(
    ['trash-move'],
    {
      ...options,
      timeoutMs: options?.timeoutMs ?? 15_000,
      stdinJson: { paths: cleaned },
    },
  );
  const moved = Array.isArray(res.moved)
    ? res.moved.filter((item): item is string => typeof item === 'string')
    : [];
  return { moved };
}

/**
 * Read PE version info (`FileVersion`, `ProductVersion`, `ProductName`, `CompanyName`)
 * from a Windows executable or DLL.
 */
export async function peVersion(
  exePath: string,
  options?: Win32HelperOptions,
): Promise<Win32PeVersion> {
  const res = await invokeWin32Helper<{
    ok: true;
    fileVersion?: unknown;
    productVersion?: unknown;
    productName?: unknown;
    companyName?: unknown;
  }>(['pe-version', '--path', exePath], options);
  return {
    fileVersion: typeof res.fileVersion === 'string' ? res.fileVersion : '',
    productVersion: typeof res.productVersion === 'string' ? res.productVersion : '',
    productName: typeof res.productName === 'string' ? res.productName : '',
    companyName: typeof res.companyName === 'string' ? res.companyName : '',
  };
}
