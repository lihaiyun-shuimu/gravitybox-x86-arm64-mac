import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat as fsStat } from 'node:fs/promises';
import { join } from 'node:path';
import { openAsarArchive } from './asar.js';
import { assertLoopback } from './cdp.js';
import { resolveBundleLayout, targetForApp } from './application-target.js';
import { atomicJson } from './files.js';
import { bt } from './i18n.js';
import {
  appProcesses,
  defaultAntigravityAppPath,
  defaultGravityBoxCacheDir,
  isPathUnder,
  isWindows,
  lsInspect,
  pathsEqual,
  peVersion,
  portOwner,
} from './platform/index.js';
const execFileRaw = promisify(execFile);
const execute = (file: string, args: string[], timeout = 3000) => execFileRaw(file, args, { timeout });
export type Endpoint = { port: number; pid: number; browserURL: string; appVersion: string; legacyPatch: boolean; appPath?: string; profile?: string };

function isLoopbackAddress(addr: string): boolean {
  const cleaned = addr.trim().toLowerCase();
  return cleaned === '127.0.0.1' || cleaned === '::1' || cleaned === '[::1]';
}

export function normalizePeVersionString(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const fourPartZero = trimmed.match(/^(\d+\.\d+\.\d+)\.0$/);
  if (fourPartZero?.[1]) return fourPartZero[1];
  return trimmed;
}

export function parseListeners(stdout: string, port: number): { pid: number; names: string[] }[] {
  const results: { pid: number; names: string[] }[] = [];
  let current: { pid: number; names: string[] } | undefined;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) { current = { pid: Number(line.slice(1)), names: [] }; results.push(current); }
    if (line.startsWith('n') && current) current.names.push(line.slice(1));
  }
  for (const owner of results) for (const name of owner.names) {
    if (![`127.0.0.1:${port}`, `[::1]:${port}`].includes(name)) throw new Error(bt('discovery.non_loopback'));
  }
  return results.filter(owner => owner.names.length > 0);
}

type PersistedBundleEntry = {
  value: { version: string; legacyPatch: boolean };
  verifiedAt: number;
  plistMtimeMs: number;
  plistSize: number;
  asarMtimeMs: number;
  asarSize: number;
  execMtimeMs: number;
  execSize: number;
  codeResMtimeMs: number;
  codeResSize: number;
};

const bundleCache = new Map<string, PersistedBundleEntry & { expiresAt: number; hardExpiresAt: number }>();
const inFlightBundleInspect = new Map<string, Promise<{ version: string; legacyPatch: boolean }>>();
const BUNDLE_DISK_CACHE_PATH = join(defaultGravityBoxCacheDir(), 'bundle-verify-cache-v1.json');
let diskBundleCacheLoaded = false;

async function ensureDiskBundleCacheLoaded(): Promise<void> {
  if (diskBundleCacheLoaded) return;
  diskBundleCacheLoaded = true;
  try {
    const parsed = JSON.parse(await readFile(BUNDLE_DISK_CACHE_PATH, 'utf8'));
    if (!parsed || parsed.schema !== 1 || typeof parsed.entries !== 'object' || !parsed.entries) return;
    const now = Date.now();
    for (const [k, raw] of Object.entries<any>(parsed.entries)) {
      if (
        raw?.value &&
        typeof raw.value.version === 'string' &&
        typeof raw.value.legacyPatch === 'boolean' &&
        typeof raw.verifiedAt === 'number' &&
        now - raw.verifiedAt < 24 * 3600_000
      ) {
        bundleCache.set(k, {
          ...raw,
          expiresAt: 0,
          hardExpiresAt: raw.verifiedAt + 24 * 3600_000,
        });
      }
    }
  } catch {}
}

async function saveDiskBundleCache(): Promise<void> {
  try {
    const entries: Record<string, PersistedBundleEntry> = {};
    for (const [k, entry] of bundleCache.entries()) {
      const { expiresAt: _e, hardExpiresAt: _h, ...persisted } = entry;
      entries[k] = persisted;
    }
    await atomicJson(BUNDLE_DISK_CACHE_PATH, { schema: 1, entries }, undefined, { durability: 'relaxed' });
  } catch {}
}

async function readVersionFromAsarArchive(archive: Awaited<ReturnType<typeof openAsarArchive>>): Promise<string> {
  try {
    const pkgEntry = archive.header.files?.['package.json'];
    if (!pkgEntry || pkgEntry.unpacked) return '';
    const pkgBuf = await archive.readEntryBuffer(pkgEntry, 256_000, 1);
    if (!pkgBuf) return '';
    const pkg = JSON.parse(pkgBuf.toString('utf8')) as { version?: unknown };
    return typeof pkg?.version === 'string' ? pkg.version.trim() : '';
  } catch {
    return '';
  }
}

export async function inspectBundle(appPath: string): Promise<{ version: string; legacyPatch: boolean }> {
  const now = Date.now();
  const memCached = bundleCache.get(appPath);
  if (memCached && memCached.expiresAt > now) return memCached.value;

  const inflight = inFlightBundleInspect.get(appPath);
  if (inflight) return inflight;

  const work = (async () => {
    await ensureDiskBundleCacheLoaded();
    const target = targetForApp(appPath);
    const layout = resolveBundleLayout(appPath);
    const cached = bundleCache.get(appPath);

    if (isWindows() && !appPath.toLowerCase().endsWith('.app')) {
      const [execStat, asarStat] = await Promise.all([
        fsStat(layout.executablePath),
        fsStat(layout.asarPath),
      ]);
      if (!execStat.isFile() || !asarStat.isFile()) {
        throw new Error(bt('discovery.app_mismatch'));
      }
      if (
        cached &&
        cached.hardExpiresAt > Date.now() &&
        asarStat.mtimeMs === cached.asarMtimeMs &&
        asarStat.size === cached.asarSize &&
        execStat.mtimeMs === cached.execMtimeMs &&
        execStat.size === cached.execSize
      ) {
        cached.expiresAt = Date.now() + 120_000;
        return cached.value;
      }

      let version = '';
      try {
        const pe = await peVersion(layout.executablePath);
        version = normalizePeVersionString(pe.fileVersion) || normalizePeVersionString(pe.productVersion);
      } catch {
        // Fall back to app.asar package.json when win32-helper is unavailable
      }

      const archive = await openAsarArchive(layout.asarPath, 16_000_000);
      try {
        if (!version) {
          version = await readVersionFromAsarArchive(archive);
        }
        let legacyPatch = false;
        for (const name of ['preload.js', 'main.js', 'utils.js']) {
          const entry = archive.header.files?.dist?.files?.[name];
          if (!entry || entry.unpacked) continue;
          const bytes = await archive.readEntryBuffer(entry, 3_000_000, 1);
          if (!bytes) continue;
          const text = bytes.toString();
          legacyPatch ||= /ANTIGRAVITY CHINESE LOCALIZATION START|injectAntigravityI18n|__ANTIGRAVITY_I18N_DATA__|createI18nEngine|__ag_hanhua_engine__/.test(text);
        }
        const val = { version, legacyPatch };
        const completedAt = Date.now();
        bundleCache.set(appPath, {
          value: val,
          verifiedAt: completedAt,
          expiresAt: completedAt + 120_000,
          hardExpiresAt: completedAt + 24 * 3600_000,
          plistMtimeMs: 0,
          plistSize: 0,
          asarMtimeMs: asarStat.mtimeMs,
          asarSize: archive.fileSize,
          execMtimeMs: execStat.mtimeMs,
          execSize: execStat.size,
          codeResMtimeMs: 0,
          codeResSize: 0,
        });
        void saveDiskBundleCache();
        return val;
      } finally {
        await archive.close();
      }
    }

    const plist = layout.infoPlistPath ?? join(appPath, 'Contents', 'Info.plist');
    const asarPath = layout.asarPath;
    const execPath = layout.executablePath;
    const codeResPath = layout.codeResourcesPath ?? join(appPath, 'Contents', '_CodeSignature', 'CodeResources');
    if (cached && cached.hardExpiresAt > Date.now()) {
      try {
        const [pStat, aStat, eStat, cStat] = await Promise.all([
          fsStat(plist),
          fsStat(asarPath),
          fsStat(execPath),
          fsStat(codeResPath),
        ]);
        if (
          pStat.mtimeMs === cached.plistMtimeMs &&
          pStat.size === cached.plistSize &&
          aStat.mtimeMs === cached.asarMtimeMs &&
          aStat.size === cached.asarSize &&
          eStat.mtimeMs === cached.execMtimeMs &&
          eStat.size === cached.execSize &&
          cStat.mtimeMs === cached.codeResMtimeMs &&
          cStat.size === cached.codeResSize
        ) {
          const sig = await execute('/usr/bin/codesign', ['-dv', appPath]);
          if (sig.stderr.includes('TeamIdentifier=EQHXZ8M8AV')) {
            cached.expiresAt = Date.now() + 120_000;
            return cached.value;
          }
        }
      } catch {}
    }

    const id = (await execute('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', plist])).stdout.trim();
    if (id !== target.bundleId) throw new Error(bt('discovery.app_mismatch'));
    const version = (await execute('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plist])).stdout.trim();
    const signature = await execute('/usr/bin/codesign', ['-dv', appPath]);
    if (!signature.stderr.includes('TeamIdentifier=EQHXZ8M8AV')) throw new Error(bt('discovery.signature_failed'));
    await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], 8000);
    const [plistStat, execStat, codeResStat] = await Promise.all([
      fsStat(plist),
      fsStat(execPath),
      fsStat(codeResPath),
    ]);
    const archive = await openAsarArchive(asarPath, 16_000_000);
    try {
      let legacyPatch = false;
      for (const name of ['preload.js', 'main.js', 'utils.js']) {
        const entry = archive.header.files?.dist?.files?.[name];
        if (!entry || entry.unpacked) continue;
        const bytes = await archive.readEntryBuffer(entry, 3_000_000, 1);
        if (!bytes) continue;
        const text = bytes.toString();
        legacyPatch ||= /ANTIGRAVITY CHINESE LOCALIZATION START|injectAntigravityI18n|__ANTIGRAVITY_I18N_DATA__|createI18nEngine|__ag_hanhua_engine__/.test(text);
      }
      const asarStat = await fsStat(asarPath);
      const val = { version, legacyPatch };
      const completedAt = Date.now();
      bundleCache.set(appPath, {
        value: val,
        verifiedAt: completedAt,
        expiresAt: completedAt + 120_000,
        hardExpiresAt: completedAt + 24 * 3600_000,
        plistMtimeMs: plistStat.mtimeMs,
        plistSize: plistStat.size,
        asarMtimeMs: asarStat.mtimeMs,
        asarSize: archive.fileSize,
        execMtimeMs: execStat.mtimeMs,
        execSize: execStat.size,
        codeResMtimeMs: codeResStat.mtimeMs,
        codeResSize: codeResStat.size,
      });
      void saveDiskBundleCache();
      return val;
    } finally {
      await archive.close();
    }
  })().finally(() => {
    inFlightBundleInspect.delete(appPath);
  });

  inFlightBundleInspect.set(appPath, work);
  return work;
}

async function discoverSingle(appPath: string, profile: string): Promise<Endpoint | undefined> {
  let contents: string;
  try { contents = await readFile(join(profile, 'DevToolsActivePort'), 'utf8'); } catch { return undefined; }
  const port = Number(contents.split(/\r?\n/)[0]?.trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;

  let ownerPid: number;
  if (isWindows()) {
    const layout = resolveBundleLayout(appPath);
    let owners;
    try { owners = await portOwner(port); } catch { return undefined; }
    if (owners.length === 0) return undefined;
    for (const owner of owners) {
      if (!isLoopbackAddress(owner.localAddress)) throw new Error(bt('discovery.non_loopback'));
    }
    const uniquePids = Array.from(new Set(owners.map((o) => o.pid)));
    if (uniquePids.length !== 1) return undefined;
    const matched = owners.find(
      (o) => pathsEqual(o.exePath, layout.executablePath, 'win32') || isPathUnder(o.exePath, appPath, 'win32'),
    );
    if (!matched) return undefined;
    ownerPid = matched.pid;
  } else {
    let listeners: string;
    try { listeners = (await execute('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpfn'])).stdout; } catch { return undefined; }
    const owners = parseListeners(listeners, port);
    if (owners.length !== 1) return undefined;
    const owner = owners[0]!;
    let executable: string;
    try { executable = (await execute('/usr/sbin/lsof', ['-nP', '-a', '-p', String(owner.pid), '-d', 'txt', '-Fn'])).stdout; } catch { return undefined; }
    const expected = join(appPath, 'Contents', 'MacOS', targetForApp(appPath).executable);
    if (!executable.split('\n').includes(`n${expected}`)) return undefined;
    ownerPid = owner.pid;
  }

  const bundle = await inspectBundle(appPath);
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000), redirect: 'error' });
  } catch { return undefined; }
  if (!response.ok) return undefined;
  const version = await response.json() as Record<string, string>;
  if (!version.webSocketDebuggerUrl) return undefined;
  const ws = assertLoopback(version.webSocketDebuggerUrl);
  if (Number(ws.port) !== port) throw new Error(bt('discovery.port_mismatch'));
  return { port, pid: ownerPid, browserURL: ws.href, appVersion: bundle.version, legacyPatch: bundle.legacyPatch, appPath, profile };
}

export async function discover(appPath: string, profile: string): Promise<Endpoint | undefined> {
  return discoverSingle(appPath, profile);
}

/** Read-only check whether the stable desktop application main process is currently running. */
export async function isApplicationRunning(appPath: string): Promise<boolean> {
  if (!appPath) return false;
  let target: ReturnType<typeof targetForApp>;
  try {
    target = targetForApp(appPath);
  } catch {
    return false;
  }
  if (isWindows()) {
    const layout = resolveBundleLayout(appPath);
    try {
      const procs = await appProcesses([appPath]);
      return procs.some((proc) => pathsEqual(proc.exePath, layout.executablePath, 'win32'));
    } catch {
      return false;
    }
  }
  const expectedExecutable = join(appPath, 'Contents', 'MacOS', target.executable);
  try {
    const { stdout } = await execute('/bin/ps', ['-ax', '-ww', '-o', 'comm='], 2000);
    return stdout.split('\n').some(line => line.trim() === expectedExecutable);
  } catch {
    return false;
  }
}

export function allowedTarget(target: { type: string; url: string }, fixtureOrigin?: string): boolean {
  if (target.type !== 'page') return false;
  try {
    const url = new URL(target.url);
    if (fixtureOrigin) return url.origin === fixtureOrigin && url.pathname === '/fixture';
    const blockedPaths = /^\/(?:api|oauth|login|browser|preview)(?:\/|$)/i;
    const pathAllowed = !blockedPaths.test(url.pathname) && (
      url.pathname === '/' ||
      /^\/(?:history|sidecars|customizations|automations|settings|settings-standalone|terminal-standalone|new-project|multi|artifact|s|chatski-connect)(?:\/.*)?$/i.test(url.pathname) ||
      /^\/c(?:\/|\/(?:[0-9a-f-]{36}|_new)(?:\/.*)?)?$/i.test(url.pathname) ||
      /^\/(?:forked|view|battle)\/.*$/i.test(url.pathname)
    );
    return url.protocol === 'https:' && url.hostname === '127.0.0.1' && !!url.port && pathAllowed && !url.username && !url.password;
  } catch { return false; }
}

const verifiedPortCache = new Map<string, { valid: boolean; expiresAt: number }>();

export type PageServiceKind = 'local' | 'unlisted' | 'foreign';

export async function inspectPageService(url: string, appPath: string): Promise<PageServiceKind> {
  if (!allowedTarget({ type: 'page', url })) return 'foreign';
  const port = Number(new URL(url).port);
  const cacheKey = `${appPath}:${port}`;
  const now = Date.now();
  const cached = verifiedPortCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.valid ? 'local' : 'foreign';

  if (isWindows()) {
    try {
      const layout = resolveBundleLayout(appPath);
      const owners = await portOwner(port);
      if (owners.length === 0) {
        verifiedPortCache.delete(cacheKey);
        return 'unlisted';
      }
      if (!owners.every((o) => isLoopbackAddress(o.localAddress))) {
        verifiedPortCache.delete(cacheKey);
        return 'foreign';
      }
      const uniquePids = Array.from(new Set(owners.map((o) => o.pid)));
      if (uniquePids.length !== 1) {
        verifiedPortCache.delete(cacheKey);
        return 'foreign';
      }
      const valid = owners.some(
        (o) => pathsEqual(o.exePath, layout.languageServerPath, 'win32') || isPathUnder(o.exePath, appPath, 'win32'),
      );
      if (valid) {
        verifiedPortCache.set(cacheKey, { valid: true, expiresAt: now + 60_000 });
        return 'local';
      }
      verifiedPortCache.delete(cacheKey);
      return 'foreign';
    } catch {
      verifiedPortCache.delete(cacheKey);
      return 'foreign';
    }
  }

  let listeners = '';
  try {
    listeners = (await execute('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpfn'])).stdout;
  } catch (err: any) {
    // lsof exits with code 1 and empty stdout when no local process listens on that TCP port.
    if (err && typeof err === 'object' && err.code === 1 && !String(err.stdout ?? '').trim()) {
      verifiedPortCache.delete(cacheKey);
      return 'unlisted';
    }
    verifiedPortCache.delete(cacheKey);
    return 'foreign';
  }

  try {
    const owners = parseListeners(listeners, port);
    if (owners.length === 0) {
      verifiedPortCache.delete(cacheKey);
      return 'unlisted';
    }
    if (owners.length !== 1) {
      verifiedPortCache.delete(cacheKey);
      return 'foreign';
    }
    const executable = (await execute('/usr/sbin/lsof', ['-nP', '-a', '-p', String(owners[0]!.pid), '-d', 'txt', '-Fn'])).stdout;
    const lines = executable.split('\n');
    const valid = lines.some(line => {
      if (!line.startsWith('n')) return false;
      const binPath = line.slice(1);
      return binPath === join(appPath, 'Contents', 'Resources', 'bin', 'language_server') ||
        binPath.startsWith(appPath + '/Contents/');
    });
    if (valid) {
      verifiedPortCache.set(cacheKey, { valid: true, expiresAt: now + 60_000 });
      return 'local';
    }
    verifiedPortCache.delete(cacheKey);
    return 'foreign';
  } catch {
    verifiedPortCache.delete(cacheKey);
    return 'foreign';
  }
}

export async function verifyPageService(url: string, appPath: string): Promise<boolean> {
  return (await inspectPageService(url, appPath)) === 'local';
}

const verifiedLsPidPortsCache = new Map<string, { ports: number[]; expiresAt: number }>();

/** Verify the real executable and official bundle before trusting a language-server listener, returning verified loopback IPv4 ports. */
export async function resolveVerifiedLanguageServerPorts(pid: number, appPath = defaultAntigravityAppPath()): Promise<number[] | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const cacheKey = `${pid}:${appPath}`;
  const now = Date.now();
  const cachedPorts = verifiedLsPidPortsCache.get(cacheKey);
  if (cachedPorts && cachedPorts.expiresAt > now) {
    try {
      process.kill(pid, 0);
      return cachedPorts.ports;
    } catch {
      verifiedLsPidPortsCache.delete(cacheKey);
      return null;
    }
  }
  try {
    await inspectBundle(appPath);
    if (isWindows()) {
      const layout = resolveBundleLayout(appPath);
      const lsProcs = await lsInspect();
      const matched = lsProcs.find(
        (proc) => proc.pid === pid && pathsEqual(proc.exePath, layout.languageServerPath, 'win32'),
      );
      if (!matched || matched.ports.length === 0) return null;
      const ports = Array.from(new Set(matched.ports.filter((p) => Number.isInteger(p) && p > 0 && p <= 65535)));
      if (ports.length > 0) {
        verifiedLsPidPortsCache.set(cacheKey, { ports, expiresAt: Date.now() + 15_000 });
      }
      return ports.length > 0 ? ports : null;
    }
    const [execRes, listenerRes] = await Promise.all([
      execute('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), '-d', 'txt', '-Fn']),
      execute('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-Fn']),
    ]);
    if (!execRes.stdout.split('\n').includes('n' + join(appPath, 'Contents/Resources/bin/language_server'))) return null;
    const listenerOut = listenerRes.stdout;
    const listeners = listenerOut.split('\n').filter(line => line.startsWith('n'));
    if (listeners.length === 0 || !listeners.every(line => /^n(?:127\.0\.0\.1|\[::1\]):\d+$/.test(line))) return null;
    const portMatches = Array.from(listenerOut.matchAll(/n127\.0\.0\.1:(\d+)/g)).map(m => parseInt(m[1]!, 10));
    const ports = Array.from(new Set(portMatches));
    if (ports.length > 0) {
      verifiedLsPidPortsCache.set(cacheKey, { ports, expiresAt: Date.now() + 15_000 });
    }
    return ports;
  } catch {
    return null;
  }
}


