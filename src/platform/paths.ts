import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

export interface AntigravityLayout {
  appPath: string;
  executableName: string;
  executablePath: string;
  resourcesDir: string;
  asarPath: string;
  asarUnpackedPath: string;
  languageServerPath: string;
  infoPlistPath: string | null;
  codeResourcesPath: string | null;
}

export function isWindows(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32';
}

export function isMacOS(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin';
}

function pathFor(platform: NodeJS.Platform): typeof win32 | typeof posix {
  return platform === 'win32' ? win32 : posix;
}

/**
 * Default per-user application support / roaming data root.
 * - macOS: ~/Library/Application Support
 * - Windows: %APPDATA% (fallback: <home>\AppData\Roaming)
 */
export function defaultAppSupportDir(
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const p = pathFor(platform);
  if (platform === 'win32') {
    const appData = env.APPDATA?.trim();
    return appData || p.join(home, 'AppData', 'Roaming');
  }
  return p.join(home, 'Library', 'Application Support');
}

/**
 * Default GravityBox persistent state directory.
 * - macOS: ~/Library/Application Support/GravityBox
 * - Windows: %APPDATA%\GravityBox
 */
export function defaultGravityBoxStateDir(
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  return pathFor(platform).join(defaultAppSupportDir(home, env, platform), 'GravityBox');
}

/**
 * Default GravityBox cache directory.
 * - macOS: ~/Library/Caches/GravityBox
 * - Windows: %LOCALAPPDATA%\GravityBox\Cache
 */
export function defaultGravityBoxCacheDir(
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const p = pathFor(platform);
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA?.trim() || p.join(home, 'AppData', 'Local');
    return p.join(localAppData, 'GravityBox', 'Cache');
  }
  return p.join(home, 'Library', 'Caches', 'GravityBox');
}

/**
 * Default Antigravity profile directory.
 * - macOS: ~/Library/Application Support/<name>
 * - Windows: %APPDATA%\<name>
 */
export function defaultAntigravityProfileDir(
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  name: string = 'Antigravity',
): string {
  return pathFor(platform).join(defaultAppSupportDir(home, env, platform), name);
}

/**
 * Default trash / fallback quarantine directory.
 * - macOS: ~/.Trash
 * - Windows: %LOCALAPPDATA%\GravityBox\Cache\maintenance-trash
 *   (actual Recycle Bin deletion on Windows uses moveToSystemTrash)
 */
export function defaultTrashDir(
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const p = pathFor(platform);
  if (platform === 'win32') {
    return p.join(defaultGravityBoxCacheDir(home, env, platform), 'maintenance-trash');
  }
  return p.join(home, '.Trash');
}

/**
 * Candidate parent directories where Antigravity may be installed.
 * - macOS: ['/Applications']
 * - Windows: [%LOCALAPPDATA%\Programs, %ProgramFiles%]
 */
export function defaultAntigravityInstallDirs(
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform !== 'win32') {
    return ['/Applications'];
  }
  const p = win32;
  const localAppData = env.LOCALAPPDATA?.trim() || p.join(home, 'AppData', 'Local');
  const programFiles = env.ProgramFiles?.trim() || env.PROGRAMFILES?.trim() || 'C:\\Program Files';
  const raw = [p.join(localAppData, 'Programs'), programFiles];
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const dir of raw) {
    if (!dir) continue;
    const key = normalizePathForCompare(dir, 'win32');
    if (!seen.has(key)) {
      seen.add(key);
      dirs.push(dir);
    }
  }
  return dirs;
}

/**
 * Default Antigravity installation path.
 * - macOS: /Applications/Antigravity.app
 * - Windows: probes %LOCALAPPDATA%\Programs\Antigravity -> %ProgramFiles%\Antigravity
 */
export function defaultAntigravityAppPath(
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  existsFn: (path: string) => boolean = existsSync,
): string {
  if (platform !== 'win32') {
    return '/Applications/Antigravity.app';
  }
  const dirs = defaultAntigravityInstallDirs(home, env, 'win32');
  const candidates = dirs.map((dir) => win32.join(dir, 'Antigravity'));
  for (const candidate of candidates) {
    if (existsFn(win32.join(candidate, 'Antigravity.exe'))) {
      return candidate;
    }
  }
  for (const candidate of candidates) {
    if (existsFn(candidate)) {
      return candidate;
    }
  }
  return candidates[0] ?? win32.join(home, 'AppData', 'Local', 'Programs', 'Antigravity');
}

/**
 * Resolve internal Antigravity bundle layout for macOS (.app) or Windows install dir.
 */
export function antigravityLayout(
  appPath: string,
  platform: NodeJS.Platform = process.platform,
): AntigravityLayout {
  if (platform === 'win32') {
    const p = win32;
    const resourcesDir = p.join(appPath, 'resources');
    return {
      appPath,
      executableName: 'Antigravity.exe',
      executablePath: p.join(appPath, 'Antigravity.exe'),
      resourcesDir,
      asarPath: p.join(resourcesDir, 'app.asar'),
      asarUnpackedPath: p.join(resourcesDir, 'app.asar.unpacked'),
      languageServerPath: p.join(resourcesDir, 'bin', 'language_server.exe'),
      infoPlistPath: null,
      codeResourcesPath: null,
    };
  }
  const p = posix;
  const resourcesDir = p.join(appPath, 'Contents', 'Resources');
  return {
    appPath,
    executableName: 'Antigravity',
    executablePath: p.join(appPath, 'Contents', 'MacOS', 'Antigravity'),
    resourcesDir,
    asarPath: p.join(resourcesDir, 'app.asar'),
    asarUnpackedPath: p.join(resourcesDir, 'app.asar.unpacked'),
    languageServerPath: p.join(resourcesDir, 'bin', 'language_server'),
    infoPlistPath: p.join(appPath, 'Contents', 'Info.plist'),
    codeResourcesPath: p.join(appPath, 'Contents', '_CodeSignature', 'CodeResources'),
  };
}

/**
 * Normalize a filesystem path for cross-platform comparisons.
 * - Windows: strips extended-length prefix, normalizes separators to '/', strips trailing slash
 *   (except drive/UNC root), and lowercases.
 * - macOS / POSIX: normalizes with posix semantics and strips trailing slash (except '/').
 */
export function normalizePathForCompare(
  p: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (!p) return '';
  if (platform === 'win32') {
    let cleaned = p;
    if (/^\\\\\?\\UNC\\/i.test(cleaned)) {
      cleaned = '\\\\' + cleaned.slice(8);
    } else if (/^\/\/\?\/UNC\//i.test(cleaned)) {
      cleaned = '//' + cleaned.slice(8);
    } else if (/^\\\\\?\\/.test(cleaned) || /^\/\/\?\//.test(cleaned)) {
      cleaned = cleaned.slice(4);
    }
    let normalized = win32.normalize(cleaned).replaceAll('\\', '/');
    while (normalized.length > 1 && normalized.endsWith('/')) {
      if (/^[a-zA-Z]:\/$/.test(normalized)) break;
      normalized = normalized.slice(0, -1);
    }
    return normalized.toLowerCase();
  }
  let normalized = posix.normalize(p);
  while (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

/**
 * Compare two paths for equality using platform-appropriate normalization.
 */
export function pathsEqual(
  a: string,
  b: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!a || !b) return false;
  return normalizePathForCompare(a, platform) === normalizePathForCompare(b, platform);
}

/**
 * Check whether `child` is strictly inside `parent` (not equal to `parent`).
 * Safe against separator differences, Windows case differences, and prefix collisions.
 */
export function isPathUnder(
  child: string,
  parent: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const normChild = normalizePathForCompare(child, platform);
  const normParent = normalizePathForCompare(parent, platform);
  if (!normChild || !normParent || normChild === normParent) return false;
  const prefix = normParent.endsWith('/') ? normParent : `${normParent}/`;
  return normChild.startsWith(prefix);
}
