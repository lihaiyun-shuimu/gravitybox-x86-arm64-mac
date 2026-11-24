import { constants, renameSync, type Stats } from 'node:fs';
import { trashMove, type Win32HelperOptions } from './win32-helper.js';

const WINDOWS_RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * Check whether a filesystem entry is owned by the current user.
 * - macOS / POSIX: verifies `stat.uid === process.getuid()`.
 * - Windows: returns `true` (Windows does not expose POSIX UIDs; `stat.uid` is 0 while `process.getuid` is undefined).
 */
export function isOwnedByCurrentUser(
  stat: Pick<Stats, 'uid'> | { uid?: number },
  platform: NodeJS.Platform = process.platform,
  currentUid: number | undefined = typeof process.getuid === 'function' ? process.getuid() : undefined,
): boolean {
  if (platform === 'win32') return true;
  if (currentUid === undefined) return false;
  return stat.uid === currentUid;
}

/**
 * Open flags for read-only non-symlink-following open.
 * Callers must still `lstat` and verify `!info.isSymbolicLink()` before opening.
 * - macOS / POSIX: `O_RDONLY | O_NOFOLLOW`
 * - Windows: `O_RDONLY`
 */
export function safeOpenFlagsNoFollow(platform: NodeJS.Platform = process.platform): number {
  if (platform === 'win32') return constants.O_RDONLY;
  return constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
}

export interface AtomicRenameRetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  signal?: AbortSignal;
  platform?: NodeJS.Platform;
  renameFn?: (src: string, dest: string) => void;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new Error('Aborted'));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('Aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Atomically rename `src` over `dest`.
 * - First attempt runs synchronously so callers can keep abort-check + rename in one turn.
 * - On Windows, retries up to `maxRetries` (default 5) with short exponential backoff when
 *   antivirus/indexer briefly locks `dest` with `EPERM`, `EBUSY`, or `EACCES`.
 * - On macOS / POSIX, performs a single `renameSync` with zero retry overhead.
 */
export async function atomicRenameWithRetry(
  src: string,
  dest: string,
  options: AtomicRenameRetryOptions = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const renameFn = options.renameFn ?? renameSync;
  const maxRetries = platform === 'win32' ? Math.max(0, Math.floor(options.maxRetries ?? 5)) : 0;
  const baseDelayMs = Math.max(1, Math.floor(options.baseDelayMs ?? 20));

  for (let attempt = 0; ; attempt++) {
    options.signal?.throwIfAborted();
    try {
      renameFn(src, dest);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (attempt >= maxRetries || !code || !WINDOWS_RETRYABLE_RENAME_CODES.has(code)) {
        throw error;
      }
      await sleep(baseDelayMs * (2 ** attempt), options.signal);
    }
  }
}

/**
 * Move files/directories to the OS system trash (Windows Recycle Bin via win32-helper).
 */
export async function moveToSystemTrash(
  paths: string[],
  options: Win32HelperOptions & { platform?: NodeJS.Platform } = {},
): Promise<{ moved: string[] }> {
  const platform = options.platform ?? process.platform;
  if (paths.length === 0) return { moved: [] };
  if (platform === 'win32') {
    return trashMove(paths, options);
  }
  throw new Error('moveToSystemTrash is only implemented via win32-helper on Windows');
}
