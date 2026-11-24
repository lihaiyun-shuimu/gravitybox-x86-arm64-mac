import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { openAsarSync } from './asar.js';
import { bt } from './i18n.js';
import {
  antigravityLayout,
  defaultAntigravityAppPath,
  defaultAntigravityInstallDirs,
  defaultAntigravityProfileDir,
  isWindows,
  normalizePathForCompare,
  pathsEqual,
  type AntigravityLayout,
} from './platform/index.js';

export type ApplicationChannel = 'stable';
export type ApplicationArchitecture = 'legacy-hub' | 'wcv-hub';

export const ALLOWED_DATA_DIRECTORY_NAMES = ['antigravity'] as const;
export type DataDirectoryName = (typeof ALLOWED_DATA_DIRECTORY_NAMES)[number];

export interface InstalledChannelsInfo {
  channels: ApplicationChannel[];
  bothInstalled: boolean;
  effectiveChannel: ApplicationChannel;
}

export interface BundleCapabilities {
  architecture: ApplicationArchitecture;
  version: string;
  productName: string;
  dataDirectoryName: DataDirectoryName;
  supportsAccountSwitch: boolean;
}

const capabilityCache = new Map<string, { value: BundleCapabilities; expiresAt: number }>();

/** Resolve bundle layout; honours explicit macOS `.app` or Windows drive paths regardless of host OS. */
export function resolveBundleLayout(appPath: string): AntigravityLayout {
  if (appPath.toLowerCase().endsWith('.app')) {
    return antigravityLayout(appPath, 'darwin');
  }
  if (/^[a-zA-Z]:[\\/]/.test(appPath)) {
    return antigravityLayout(appPath, 'win32');
  }
  return antigravityLayout(appPath);
}

/** Inspect the supported stable bundle without changing the official application. */
export function probeBundleCapabilities(
  appPath: string,
  channel: ApplicationChannel = 'stable',
): BundleCapabilities {
  applicationChannel(channel);
  assertStablePaths(appPath);
  const now = Date.now();
  const cached = capabilityCache.get(appPath);
  if (cached && cached.expiresAt > now) return cached.value;

  const fallback: BundleCapabilities = {
    architecture: 'wcv-hub',
    version: '',
    productName: 'Antigravity',
    dataDirectoryName: 'antigravity',
    supportsAccountSwitch: true,
  };

  const asarPath = resolveBundleLayout(appPath).asarPath;
  let archive: ReturnType<typeof openAsarSync> | undefined;
  try {
    if (!existsSync(asarPath)) return fallback;
    archive = openAsarSync(asarPath, 16_000_000);
    const distFiles = archive.header.files?.dist?.files ?? {};
    const hasWcvArchitecture = Boolean(
      distFiles['wcvBrowserRegistry.js'] ||
      distFiles['wcvIpcHandlers.js'] ||
      distFiles['browserEngine'] ||
      distFiles['windowState.js'],
    );

    let version = '';
    let productName = fallback.productName;
    const pkgBuf = archive.readEntryBuffer(archive.header.files?.['package.json'], 256_000, 1);
    if (pkgBuf) {
      const pkg = JSON.parse(pkgBuf.toString('utf8'));
      if (typeof pkg?.version === 'string') version = pkg.version.trim();
      if (typeof pkg?.productName === 'string' && pkg.productName.trim()) productName = pkg.productName.trim();
    }

    const architecture: ApplicationArchitecture = hasWcvArchitecture
      ? 'wcv-hub'
      : 'legacy-hub';
    const dataDirectoryName: DataDirectoryName = 'antigravity';

    const resolved: BundleCapabilities = {
      architecture,
      version,
      productName,
      dataDirectoryName,
      supportsAccountSwitch: true,
    };
    capabilityCache.set(appPath, { value: resolved, expiresAt: now + 30_000 });
    return resolved;
  } catch {
    return fallback;
  } finally {
    archive?.close();
  }
}

export function applicationChannel(value: unknown): ApplicationChannel {
  if (value === undefined || value === 'stable') return 'stable';
  if (value === 'insiders') throw new Error(bt('app_target.stable_only'));
  throw new Error(bt('app_target.invalid_channel'));
}

/** Only persisted legacy configuration is migrated; explicit channel requests are rejected. */
export function savedApplicationChannel(value: unknown): ApplicationChannel {
  return value === 'insiders' ? 'stable' : applicationChannel(value);
}

function isInsidersDirectoryName(name: string): boolean {
  const lower = name.trim().toLowerCase();
  return (
    lower === 'antigravity - insiders.app' ||
    lower === 'antigravity - insiders' ||
    lower === 'antigravity insiders' ||
    lower === 'antigravity-insiders'
  );
}

function assertStablePaths(appPath: string, profile?: string): void {
  if (
    isInsidersDirectoryName(basename(appPath.replaceAll('\\', '/'))) ||
    (profile && isInsidersDirectoryName(basename(profile.replaceAll('\\', '/'))))
  ) {
    throw new Error(bt('app_target.stable_only'));
  }
}

export function detectInstalledChannels(
  preferredChannel: ApplicationChannel = 'stable',
  applicationsDir?: string,
): InstalledChannelsInfo {
  applicationChannel(preferredChannel);
  let hasStable = false;
  if (applicationsDir !== undefined) {
    if (isWindows()) {
      hasStable =
        existsSync(join(applicationsDir, 'Antigravity', 'Antigravity.exe')) ||
        existsSync(join(applicationsDir, 'Antigravity.app'));
    } else {
      hasStable = existsSync(join(applicationsDir, 'Antigravity.app'));
    }
  } else if (isWindows()) {
    const dirs = defaultAntigravityInstallDirs();
    hasStable = dirs.some((dir) => existsSync(join(dir, 'Antigravity', 'Antigravity.exe')));
  } else {
    hasStable = existsSync(join('/Applications', 'Antigravity.app'));
  }
  return {
    channels: hasStable ? ['stable'] : [],
    bothInstalled: false,
    effectiveChannel: 'stable',
  };
}

/** Keep identity, executable, profile, and conversation storage bound to the target while unifying user-facing label and full feature support. */
export function applicationTarget(
  channel: ApplicationChannel = 'stable',
  home = homedir(),
  options?: { appPath?: string; profile?: string; applicationsDir?: string },
) {
  applicationChannel(channel);
  const name = 'Antigravity';
  const envForHome = home !== homedir() ? {} : process.env;
  const appPath =
    options?.appPath ??
    (options?.applicationsDir
      ? isWindows()
        ? join(options.applicationsDir, name)
        : join(options.applicationsDir, `${name}.app`)
      : defaultAntigravityAppPath(home, envForHome));
  assertStablePaths(appPath, options?.profile);
  const layout = resolveBundleLayout(appPath);
  const capabilities = probeBundleCapabilities(appPath, channel);
  return {
    channel,
    name,
    label: 'Antigravity',
    bundleId: 'com.google.antigravity',
    appPath,
    executable: layout.executableName,
    profile: options?.profile ?? defaultAntigravityProfileDir(home, envForHome, process.platform, name),
    dataDirectoryName: capabilities.dataDirectoryName,
    architecture: capabilities.architecture,
    supportsAccountSwitch: true,
  };
}

export type ApplicationTarget = ReturnType<typeof applicationTarget>;

export function allApplicationTargets(home = homedir(), applicationsDir?: string): ApplicationTarget[] {
  return [
    applicationTarget('stable', home, applicationsDir ? { applicationsDir } : undefined),
  ];
}

export function targetForApp(appPath: string, home = homedir()): ApplicationTarget {
  return applicationTarget('stable', home, { appPath });
}

function commandStartsWithExecutable(command: string, expectedExecutable: string, winMode: boolean): boolean {
  const trimmed = command.trimStart();
  if (!trimmed || !expectedExecutable) return false;
  const platform: NodeJS.Platform = winMode ? 'win32' : 'darwin';
  if (trimmed.startsWith('"')) {
    const closeIdx = trimmed.indexOf('"', 1);
    if (closeIdx <= 1) return false;
    const afterQuote = trimmed.slice(closeIdx + 1);
    if (afterQuote.length > 0 && !/^\s/.test(afterQuote)) return false;
    const exe = trimmed.slice(1, closeIdx);
    return pathsEqual(exe, expectedExecutable, platform);
  }
  const normExpected = normalizePathForCompare(expectedExecutable, platform);
  if (!normExpected) return false;
  let cleanedCmd = trimmed;
  if (winMode) {
    if (/^\\\\\?\\UNC\\/i.test(cleanedCmd)) {
      cleanedCmd = '\\\\' + cleanedCmd.slice(8);
    } else if (/^\\\\\?\\/.test(cleanedCmd)) {
      cleanedCmd = cleanedCmd.slice(4);
    }
    const normCmd = cleanedCmd.replaceAll('\\', '/').toLowerCase();
    if (!normCmd.startsWith(normExpected)) return false;
    const nextChar = normCmd.charAt(normExpected.length);
    return nextChar === '' || /\s/.test(nextChar);
  }
  if (!cleanedCmd.startsWith(normExpected)) return false;
  const nextChar = cleanedCmd.charAt(normExpected.length);
  return nextChar === '' || /\s/.test(nextChar);
}

/** Check whether a language_server command line belongs to the given application target. */
export function isLanguageServerCommandForTarget(command: string, target: ApplicationTarget): boolean {
  const layout = resolveBundleLayout(target.appPath);
  const winMode = !target.appPath.toLowerCase().endsWith('.app') && (isWindows() || /^[a-zA-Z]:[\\/]/.test(target.appPath));
  if (!commandStartsWithExecutable(command, layout.languageServerPath, winMode)) {
    return false;
  }
  const match = command.match(/(?:^|\s)--app_data_dir(?:=|\s+)(?:"([^"]+)"|([^\s"]+))/);
  const dataDirectory = match?.[1] ?? match?.[2];
  if (dataDirectory && dataDirectory !== target.dataDirectoryName) return false;
  return true;
}

export function matchingTargetForLanguageServerCommand(
  command: string,
  preferredTarget?: ApplicationTarget,
  home = homedir(),
): ApplicationTarget | null {
  const candidates: ApplicationTarget[] = preferredTarget
    ? [preferredTarget, ...allApplicationTargets(home).filter((t) => !pathsEqual(t.appPath, preferredTarget.appPath))]
    : allApplicationTargets(home);

  if (isWindows()) {
    const envForHome = home !== homedir() ? {} : process.env;
    for (const dir of defaultAntigravityInstallDirs(home, envForHome, 'win32')) {
      const candidateAppPath = join(dir, 'Antigravity');
      if (!candidates.some((c) => pathsEqual(c.appPath, candidateAppPath, 'win32'))) {
        candidates.push(targetForApp(candidateAppPath, home));
      }
    }
  }

  for (const candidate of candidates) {
    if (isLanguageServerCommandForTarget(command, candidate)) {
      return candidate;
    }
  }
  return null;
}

export function channelStateDirectory(stateDir: string, _channel?: ApplicationChannel): string {
  return stateDir;
}
