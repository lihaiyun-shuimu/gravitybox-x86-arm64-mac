import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import { join, win32 as win32Path } from 'node:path';
import * as tls from 'node:tls';
import { promisify } from 'node:util';
import { bt } from './i18n.js';

const execFileAsync = promisify(execFile);

export type ProxyMode = 'off' | 'system' | 'manual';

export interface ProxyRuntimeConfig {
  mode: ProxyMode;
  manualUrl: string;
}

export interface SystemProxySnapshot {
  httpEnabled: boolean;
  httpUrl: string | null;
  httpsEnabled: boolean;
  httpsUrl: string | null;
  socksEnabled: boolean;
  socksUrl: string | null;
  pacEnabled: boolean;
  pacUrl: string | null;
  exceptions: string[];
}

export type EffectiveProxySource =
  | 'off'
  | 'manual'
  | 'system'
  | 'system_unconfigured'
  | 'system_pac_unsupported'
  | 'system_socks_unsupported'
  | 'invalid_manual';

export interface EffectiveProxyResolution {
  mode: ProxyMode;
  manualUrl: string;
  effectiveUrl: string | null;
  httpUrl: string | null;
  httpsUrl: string | null;
  exceptions: string[];
  source: EffectiveProxySource;
}

export interface ProxyFetchFactoryOptions {
  tlsCa?: string | Buffer | Array<string | Buffer>;
  resolveProxy?: () => Promise<EffectiveProxyResolution>;
  directFetch?: typeof globalThis.fetch;
  maxResponseBytes?: number;
  timeoutMs?: number;
}

const SYSTEM_PROXY_CACHE_TTL_MS = 5_000;
const MAX_REDIRECT_HOPS = 5;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const DEFAULT_PROXY_TIMEOUT_MS = 30_000;
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);
const DISALLOWED_BARE_SCHEMES = /^(?:javascript|vbscript|data|file|ftp|mailto|socks|socks4|socks4a|socks5|ws|wss|about|blob):/i;

const EMPTY_SYSTEM_SNAPSHOT: SystemProxySnapshot = {
  httpEnabled: false,
  httpUrl: null,
  httpsEnabled: false,
  httpsUrl: null,
  socksEnabled: false,
  socksUrl: null,
  pacEnabled: false,
  pacUrl: null,
  exceptions: [],
};

let runtimeProxyConfig: ProxyRuntimeConfig = {
  mode: 'off',
  manualUrl: '',
};

let systemProxyCache: { snapshot: SystemProxySnapshot; expiresAt: number } | null = null;
let inFlightSystemProxyRead: Promise<SystemProxySnapshot> | null = null;

function isProxyMode(value: unknown): value is ProxyMode {
  return value === 'off' || value === 'system' || value === 'manual';
}

function formatHostForUrl(host: string): string {
  const trimmed = host.trim();
  if (trimmed.includes(':') && !trimmed.startsWith('[')) {
    return `[${trimmed}]`;
  }
  return trimmed;
}

function buildScutilProxyUrl(
  defaultScheme: 'http' | 'socks5',
  rawHost: string | undefined,
  rawPort: string | undefined
): string | null {
  const host = (rawHost ?? '').trim();
  const portText = (rawPort ?? '').trim();
  if (!host) return null;

  if (/^https?:\/\//i.test(host)) {
    try {
      const parsed = new URL(host);
      if (parsed.port) return `${parsed.protocol}//${parsed.hostname}:${parsed.port}`;
      if (/^\d+$/.test(portText)) {
        const port = Number.parseInt(portText, 10);
        if (port >= 1 && port <= 65535) {
          return `${parsed.protocol}//${parsed.hostname}:${port}`;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  if (!/^\d+$/.test(portText)) return null;
  const port = Number.parseInt(portText, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

  const formattedHost = formatHostForUrl(host);
  const candidate = `${defaultScheme}://${formattedHost}:${port}`;
  try {
    const parsed = new URL(candidate);
    if (!parsed.hostname) return null;
    return `${parsed.protocol}//${parsed.hostname}:${port}`;
  } catch {
    return null;
  }
}

/**
 * Parse macOS `scutil --proxy` output into a structured snapshot.
 * Tracks brace depth so nested blocks (e.g. `Scoped` / `__SCOPED__`) do not override top-level keys.
 */
export function parseScutilProxyOutput(stdout: string): SystemProxySnapshot {
  const topLevel = new Map<string, string>();
  const exceptions: string[] = [];
  const seenExceptions = new Set<string>();

  let depth = 0;
  let inExceptionsList = false;

  for (const rawLine of String(stdout ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line === '}') {
      if (inExceptionsList && depth === 2) {
        inExceptionsList = false;
      }
      depth = Math.max(0, depth - 1);
      continue;
    }

    if (depth === 0) {
      if (line.endsWith('{')) {
        depth = 1;
      }
      continue;
    }

    if (depth === 1) {
      if (/^ExceptionsList\s*:\s*<array>\s*\{$/i.test(line)) {
        inExceptionsList = true;
        depth = 2;
        continue;
      }
      if (line.endsWith('{')) {
        depth += 1;
        continue;
      }
      const sep = line.indexOf(':');
      if (sep > 0) {
        const key = line.slice(0, sep).trim();
        const value = line.slice(sep + 1).trim();
        if (key) topLevel.set(key, value);
      }
      continue;
    }

    if (depth === 2 && inExceptionsList) {
      if (line.endsWith('{')) {
        depth += 1;
        continue;
      }
      const match = line.match(/^\d+\s*:\s*(.+)$/);
      if (match && match[1]) {
        let entry = match[1].trim();
        if (
          (entry.startsWith('"') && entry.endsWith('"')) ||
          (entry.startsWith("'") && entry.endsWith("'"))
        ) {
          entry = entry.slice(1, -1).trim();
        }
        if (entry && !seenExceptions.has(entry)) {
          seenExceptions.add(entry);
          exceptions.push(entry);
        }
      }
      continue;
    }

    if (line.endsWith('{')) {
      depth += 1;
    }
  }

  const isEnabled = (key: string): boolean => {
    const v = topLevel.get(key)?.trim().toLowerCase();
    return v === '1' || v === 'true';
  };

  const httpEnabled = isEnabled('HTTPEnable');
  const httpUrl = httpEnabled
    ? buildScutilProxyUrl('http', topLevel.get('HTTPProxy'), topLevel.get('HTTPPort'))
    : null;

  const httpsEnabled = isEnabled('HTTPSEnable');
  // macOS HTTPSProxy is an HTTP proxy endpoint that tunnels HTTPS via HTTP CONNECT.
  const httpsUrl = httpsEnabled
    ? buildScutilProxyUrl('http', topLevel.get('HTTPSProxy'), topLevel.get('HTTPSPort'))
    : null;

  const socksEnabled = isEnabled('SOCKSEnable');
  const socksUrl = socksEnabled
    ? buildScutilProxyUrl('socks5', topLevel.get('SOCKSProxy'), topLevel.get('SOCKSPort'))
    : null;

  const pacEnabled = isEnabled('ProxyAutoConfigEnable');
  const rawPacUrl = topLevel.get('ProxyAutoConfigURLString')?.trim() ?? '';
  const pacUrl = pacEnabled && rawPacUrl ? rawPacUrl : null;

  return {
    httpEnabled: httpEnabled && httpUrl !== null,
    httpUrl,
    httpsEnabled: httpsEnabled && httpsUrl !== null,
    httpsUrl,
    socksEnabled: socksEnabled && socksUrl !== null,
    socksUrl,
    pacEnabled: pacEnabled && pacUrl !== null,
    pacUrl,
    exceptions,
  };
}

function parseProxyEndpointUrl(
  defaultScheme: 'http' | 'socks5',
  rawValue: string | undefined
): { scheme: 'http' | 'https' | 'socks'; url: string } | null {
  const trimmed = (rawValue ?? '').trim();
  if (!trimmed) return null;
  if (/^socks(?:4a?|5h?)?:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      if (!parsed.hostname || !parsed.port) return null;
      return { scheme: 'socks', url: `${parsed.protocol}//${parsed.hostname}:${parsed.port}` };
    } catch {
      return null;
    }
  }
  const hasHttpScheme = /^https?:\/\//i.test(trimmed);
  const candidate = hasHttpScheme ? trimmed : `${defaultScheme}://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    if (!parsed.hostname) return null;
    const port = parsed.port
      ? Number.parseInt(parsed.port, 10)
      : parsed.protocol === 'https:'
        ? 443
        : parsed.protocol === 'http:'
          ? 80
          : 0;
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    const authPrefix = parsed.username
      ? `${parsed.username}${parsed.password ? `:${parsed.password}` : ''}@`
      : '';
    const url = `${parsed.protocol}//${authPrefix}${parsed.hostname}:${port}`;
    if (parsed.protocol === 'https:') return { scheme: 'https', url };
    if (parsed.protocol === 'http:') return { scheme: 'http', url };
    return { scheme: 'socks', url };
  } catch {
    return null;
  }
}

/**
 * Parse Windows `reg.exe query "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings"` output.
 */
export function parseWindowsInternetSettingsOutput(stdout: string): SystemProxySnapshot {
  const values = new Map<string, string>();
  for (const rawLine of String(stdout ?? '').split(/\r?\n/)) {
    const match = rawLine.match(/^\s*(\S+)\s+REG_[A-Z0-9_]+\s+(.*)$/i);
    if (!match || !match[1]) continue;
    values.set(match[1].toLowerCase(), (match[2] ?? '').trim());
  }

  const rawEnable = (values.get('proxyenable') ?? '').toLowerCase();
  const proxyEnabled = rawEnable === '0x1' || rawEnable === '1';
  const rawServer = (values.get('proxyserver') ?? '').trim();
  const rawOverride = (values.get('proxyoverride') ?? '').trim();
  const rawPacUrl = (values.get('autoconfigurl') ?? '').trim();

  const exceptions: string[] = [];
  const seenExceptions = new Set<string>();
  if (rawOverride) {
    for (const part of rawOverride.split(';')) {
      const entry = part.trim();
      if (entry && !seenExceptions.has(entry)) {
        seenExceptions.add(entry);
        exceptions.push(entry);
      }
    }
  }

  let httpUrl: string | null = null;
  let httpsUrl: string | null = null;
  let socksUrl: string | null = null;

  if (proxyEnabled && rawServer) {
    const entries = rawServer.includes('=')
      ? rawServer.split(';').map(s => s.trim()).filter(Boolean)
      : [rawServer];

    if (rawServer.includes('=')) {
      for (const item of entries) {
        const eqIdx = item.indexOf('=');
        if (eqIdx <= 0) continue;
        const proto = item.slice(0, eqIdx).trim().toLowerCase();
        const target = item.slice(eqIdx + 1).trim();
        if (!target) continue;
        if (proto === 'http') {
          const parsed = parseProxyEndpointUrl('http', target);
          if (parsed && parsed.scheme !== 'socks') httpUrl = parsed.url;
        } else if (proto === 'https') {
          const parsed = parseProxyEndpointUrl('http', target);
          if (parsed && parsed.scheme !== 'socks') httpsUrl = parsed.url;
        } else if (proto === 'socks' || proto === 'socks4' || proto === 'socks5') {
          const parsed = parseProxyEndpointUrl('socks5', target);
          if (parsed) socksUrl = parsed.url;
        }
      }
    } else {
      const parsed = parseProxyEndpointUrl('http', rawServer);
      if (parsed) {
        if (parsed.scheme === 'socks') {
          socksUrl = parsed.url;
        } else {
          httpUrl = parsed.url;
          httpsUrl = parsed.url;
        }
      }
    }
  }

  const pacUrl = rawPacUrl || null;
  return {
    httpEnabled: httpUrl !== null,
    httpUrl,
    httpsEnabled: httpsUrl !== null,
    httpsUrl,
    socksEnabled: socksUrl !== null,
    socksUrl,
    pacEnabled: pacUrl !== null,
    pacUrl,
    exceptions,
  };
}

/**
 * Build a SystemProxySnapshot from standard proxy environment variables (`HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, `NO_PROXY`).
 */
export function parseEnvProxySnapshot(env: NodeJS.ProcessEnv = process.env): SystemProxySnapshot {
  const rawHttp = (env.HTTP_PROXY ?? env.http_proxy ?? '').trim();
  const rawHttps = (env.HTTPS_PROXY ?? env.https_proxy ?? '').trim();
  const rawAll = (env.ALL_PROXY ?? env.all_proxy ?? '').trim();
  const rawNoProxy = (env.NO_PROXY ?? env.no_proxy ?? '').trim();

  let httpUrl: string | null = null;
  let httpsUrl: string | null = null;
  let socksUrl: string | null = null;

  const parsedHttp = parseProxyEndpointUrl('http', rawHttp);
  if (parsedHttp) {
    if (parsedHttp.scheme === 'socks') socksUrl = parsedHttp.url;
    else httpUrl = parsedHttp.url;
  }

  const parsedHttps = parseProxyEndpointUrl('http', rawHttps);
  if (parsedHttps) {
    if (parsedHttps.scheme === 'socks') socksUrl ??= parsedHttps.url;
    else httpsUrl = parsedHttps.url;
  }

  if (!httpUrl && !httpsUrl && !socksUrl && rawAll) {
    const parsedAll = parseProxyEndpointUrl('http', rawAll);
    if (parsedAll) {
      if (parsedAll.scheme === 'socks') {
        socksUrl = parsedAll.url;
      } else {
        httpUrl = parsedAll.url;
        httpsUrl = parsedAll.url;
      }
    }
  }

  const exceptions: string[] = [];
  const seen = new Set<string>();
  if (rawNoProxy) {
    for (const part of rawNoProxy.split(',')) {
      const entry = part.trim();
      if (entry && !seen.has(entry)) {
        seen.add(entry);
        exceptions.push(entry);
      }
    }
  }

  return {
    httpEnabled: httpUrl !== null,
    httpUrl,
    httpsEnabled: httpsUrl !== null,
    httpsUrl,
    socksEnabled: socksUrl !== null,
    socksUrl,
    pacEnabled: false,
    pacUrl: null,
    exceptions,
  };
}

function hasAnyConfiguredProxy(snapshot: SystemProxySnapshot): boolean {
  return snapshot.httpEnabled || snapshot.httpsEnabled || snapshot.socksEnabled || snapshot.pacEnabled;
}

export function resolveWindowsRegExePath(env: NodeJS.ProcessEnv = process.env): string {
  const systemRoot = (env.SystemRoot || env.WINDIR || 'C:\\Windows').trim() || 'C:\\Windows';
  return win32Path.join(systemRoot, 'System32', 'reg.exe');
}

export function clearSystemProxyCache(): void {
  systemProxyCache = null;
}

export async function readSystemProxySnapshot(options?: {
  forceRefresh?: boolean;
  execScutil?: () => Promise<string>;
  execWinReg?: () => Promise<string>;
  env?: NodeJS.ProcessEnv;
}): Promise<SystemProxySnapshot> {
  if (options?.execScutil) {
    try {
      const stdout = await options.execScutil();
      return parseScutilProxyOutput(stdout);
    } catch {
      return { ...EMPTY_SYSTEM_SNAPSHOT, exceptions: [] };
    }
  }

  if (options?.execWinReg) {
    try {
      const stdout = await options.execWinReg();
      const regSnap = parseWindowsInternetSettingsOutput(stdout);
      if (hasAnyConfiguredProxy(regSnap)) return regSnap;
      const envSnap = parseEnvProxySnapshot(options.env ?? {});
      if (hasAnyConfiguredProxy(envSnap)) {
        return {
          ...envSnap,
          exceptions: Array.from(new Set([...regSnap.exceptions, ...envSnap.exceptions])),
        };
      }
      return regSnap;
    } catch {
      return options.env ? parseEnvProxySnapshot(options.env) : { ...EMPTY_SYSTEM_SNAPSHOT, exceptions: [] };
    }
  }

  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    return parseEnvProxySnapshot(options?.env ?? process.env);
  }

  const now = Date.now();
  if (!options?.forceRefresh && systemProxyCache && now < systemProxyCache.expiresAt) {
    return {
      ...systemProxyCache.snapshot,
      exceptions: [...systemProxyCache.snapshot.exceptions],
    };
  }

  if (!options?.forceRefresh && inFlightSystemProxyRead) {
    const snap = await inFlightSystemProxyRead;
    return { ...snap, exceptions: [...snap.exceptions] };
  }

  const task = (async (): Promise<SystemProxySnapshot> => {
    try {
      let parsed: SystemProxySnapshot;
      if (process.platform === 'win32') {
        const { stdout } = await execFileAsync(
          resolveWindowsRegExePath(),
          ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
          { encoding: 'utf8', timeout: 2000, windowsHide: true }
        );
        const regSnap = parseWindowsInternetSettingsOutput(stdout);
        if (hasAnyConfiguredProxy(regSnap)) {
          parsed = regSnap;
        } else {
          const envSnap = parseEnvProxySnapshot(options?.env ?? process.env);
          parsed = hasAnyConfiguredProxy(envSnap)
            ? { ...envSnap, exceptions: Array.from(new Set([...regSnap.exceptions, ...envSnap.exceptions])) }
            : regSnap;
        }
      } else {
        const { stdout } = await execFileAsync('/usr/sbin/scutil', ['--proxy'], {
          encoding: 'utf8',
          timeout: 2000,
        });
        parsed = parseScutilProxyOutput(stdout);
      }
      systemProxyCache = {
        snapshot: parsed,
        expiresAt: Date.now() + SYSTEM_PROXY_CACHE_TTL_MS,
      };
      return parsed;
    } catch {
      const fallback: SystemProxySnapshot =
        process.platform === 'win32'
          ? parseEnvProxySnapshot(options?.env ?? process.env)
          : { ...EMPTY_SYSTEM_SNAPSHOT, exceptions: [] };
      systemProxyCache = {
        snapshot: fallback,
        expiresAt: Date.now() + SYSTEM_PROXY_CACHE_TTL_MS,
      };
      return fallback;
    }
  })();

  inFlightSystemProxyRead = task;
  try {
    const snap = await task;
    return { ...snap, exceptions: [...snap.exceptions] };
  } finally {
    if (inFlightSystemProxyRead === task) {
      inFlightSystemProxyRead = null;
    }
  }
}

/**
 * Normalize and validate a manual proxy URL.
 * Accepts `http://host:port`, `https://host:port`, or bare `host:port` (normalized to `http://host:port`).
 * Rejects unsupported schemes, missing/invalid ports, empty hosts, paths, queries, and control chars.
 */
export function normalizeManualProxyUrl(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new Error(bt('proxy.err.url_must_be_string'));
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(bt('proxy.err.url_empty'));
  }
  if (/[\s\x00-\x1f\x7f]/.test(trimmed)) {
    throw new Error(bt('proxy.err.url_invalid_chars'));
  }

  let candidate: string;
  if (trimmed.includes('://')) {
    const schemeMatch = trimmed.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//);
    if (!schemeMatch || !schemeMatch[1]) {
      throw new Error(bt('proxy.err.url_invalid'));
    }
    const scheme = schemeMatch[1].toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') {
      throw new Error(bt('proxy.err.unsupported_scheme_named', { scheme }));
    }
    candidate = trimmed;
  } else {
    if (DISALLOWED_BARE_SCHEMES.test(trimmed)) {
      throw new Error(bt('proxy.err.unsupported_scheme'));
    }
    candidate = `http://${trimmed}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(bt('proxy.err.url_invalid'));
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(bt('proxy.err.unsupported_scheme'));
  }
  if (!parsed.hostname) {
    throw new Error(bt('proxy.err.missing_host'));
  }
  if ((parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) {
    throw new Error(bt('proxy.err.disallowed_path_query_fragment'));
  }

  // Verify explicit numeric port in raw authority (also handles default ports :80 and :443).
  const afterScheme = candidate.slice(candidate.indexOf('://') + 3);
  const authority = afterScheme.split('/')[0] ?? '';
  const hostPort = authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority;
  const portMatch = hostPort.startsWith('[')
    ? hostPort.match(/^\[[^\]]+\]:(\d+)$/)
    : hostPort.match(/^([^:]+):(\d+)$/);

  if (!portMatch) {
    throw new Error(bt('proxy.err.missing_port'));
  }
  const rawHostPart = hostPort.startsWith('[') ? hostPort.slice(0, hostPort.lastIndexOf(':')) : portMatch[1];
  const rawPortPart = hostPort.startsWith('[') ? portMatch[1] : portMatch[2];
  if (!rawHostPart || !rawPortPart) {
    throw new Error(bt('proxy.err.invalid_host_port'));
  }

  const portNum = Number.parseInt(rawPortPart, 10);
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    throw new Error(bt('proxy.err.invalid_port'));
  }

  const authPrefix = parsed.username
    ? `${parsed.username}${parsed.password ? `:${parsed.password}` : ''}@`
    : '';
  return `${parsed.protocol}//${authPrefix}${parsed.hostname}:${portNum}`;
}

/**
 * Redact embedded credentials (username/password) from a proxy URL before exposing it
 * over IPC responses, CLI output, or diagnostics. Credential-free URLs are returned verbatim.
 */
export function redactProxyUrl(raw: string | null): string | null {
  if (raw === null || raw === '') return raw;
  const trimmed = raw.trim();
  if (!trimmed) return raw;
  if (!trimmed.includes('://')) {
    const slashIdx = trimmed.indexOf('/');
    const authority = slashIdx >= 0 ? trimmed.slice(0, slashIdx) : trimmed;
    const suffix = slashIdx >= 0 ? trimmed.slice(slashIdx) : '';
    const atIdx = authority.lastIndexOf('@');
    if (atIdx < 0) return raw;
    const userInfo = authority.slice(0, atIdx);
    const hostPort = authority.slice(atIdx + 1);
    const colonIdx = userInfo.indexOf(':');
    const authPart = colonIdx >= 0
      ? `${userInfo.slice(0, colonIdx)}:[REDACTED]`
      : '[REDACTED]';
    return `${authPart}@${hostPort}${suffix}`;
  }
  try {
    const parsed = new URL(trimmed);
    if (!parsed.username && !parsed.password) return raw;
    const schemeIdx = trimmed.indexOf('://');
    const afterScheme = schemeIdx >= 0 ? trimmed.slice(schemeIdx + 3) : trimmed;
    const slashIdx = afterScheme.indexOf('/');
    const authority = slashIdx >= 0 ? afterScheme.slice(0, slashIdx) : afterScheme;
    const suffix = slashIdx >= 0 ? afterScheme.slice(slashIdx) : '';
    const atIdx = authority.lastIndexOf('@');
    const hostPort = atIdx >= 0 ? authority.slice(atIdx + 1) : parsed.host;
    const authPart = parsed.password
      ? `${parsed.username ? `${parsed.username}:` : ':'}[REDACTED]`
      : '[REDACTED]';
    return `${parsed.protocol}//${authPart}@${hostPort}${suffix}`;
  } catch {
    return raw.replace(
      /((?:^|\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]*:)([^@\s/]+)(@)/gi,
      '$1[REDACTED]$3'
    );
  }
}

function ipv4ToUint32(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number.parseInt(part, 10);
    if (octet < 0 || octet > 255) return null;
    value = ((value << 8) | octet) >>> 0;
  }
  return value;
}

/**
 * Parse IPv4 CIDR including macOS short CIDR notation such as `169.254/16` or `10/8`.
 */
function parseIpv4Cidr(pattern: string): { network: number; mask: number } | null {
  const slash = pattern.indexOf('/');
  if (slash <= 0 || slash !== pattern.lastIndexOf('/')) return null;
  const ipPart = pattern.slice(0, slash);
  const prefixPart = pattern.slice(slash + 1);
  if (!/^\d{1,2}$/.test(prefixPart)) return null;
  const prefix = Number.parseInt(prefixPart, 10);
  if (prefix < 0 || prefix > 32) return null;

  const octets = ipPart.split('.');
  if (octets.length < 1 || octets.length > 4) return null;
  let network = 0;
  for (let i = 0; i < 4; i++) {
    const raw = octets[i] ?? '0';
    if (!/^\d{1,3}$/.test(raw)) return null;
    const num = Number.parseInt(raw, 10);
    if (num < 0 || num > 255) return null;
    network = ((network << 8) | num) >>> 0;
  }
  const mask = prefix === 0 ? 0 : ((~0 << (32 - prefix)) >>> 0);
  return { network: (network & mask) >>> 0, mask };
}

function isMandatoryLoopbackHost(unbracketedHost: string): boolean {
  if (
    unbracketedHost === 'localhost' ||
    unbracketedHost.endsWith('.localhost') ||
    unbracketedHost === '::1' ||
    unbracketedHost === '0:0:0:0:0:0:0:1' ||
    unbracketedHost === '::ffff:127.0.0.1'
  ) {
    return true;
  }
  const ipv4 = ipv4ToUint32(unbracketedHost);
  if (ipv4 !== null && (ipv4 >>> 24) === 127) {
    return true;
  }
  return false;
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

function matchesBypassPattern(
  unbracketedHost: string,
  targetPort: number,
  targetIpv4: number | null,
  rawPattern: string
): boolean {
  const pattern = rawPattern.trim().toLowerCase();
  if (!pattern) return false;
  if (pattern === '*') return true;
  if (pattern === '<local>') {
    return !unbracketedHost.includes('.') && targetIpv4 === null && !unbracketedHost.includes(':');
  }

  if (pattern.includes('/')) {
    if (targetIpv4 === null) return false;
    const cidr = parseIpv4Cidr(pattern);
    if (!cidr) return false;
    return ((targetIpv4 & cidr.mask) >>> 0) === cidr.network;
  }

  let patHost = pattern;
  let patPort: number | null = null;

  if (pattern.startsWith('[')) {
    const bracketMatch = pattern.match(/^\[([^\]]+)\](?::(\d+))?$/);
    if (!bracketMatch || !bracketMatch[1]) return false;
    patHost = bracketMatch[1];
    if (bracketMatch[2]) {
      patPort = Number.parseInt(bracketMatch[2], 10);
    }
  } else {
    const firstColon = pattern.indexOf(':');
    if (firstColon > 0 && firstColon === pattern.lastIndexOf(':')) {
      const maybePort = pattern.slice(firstColon + 1);
      if (/^\d+$/.test(maybePort)) {
        patHost = pattern.slice(0, firstColon);
        patPort = Number.parseInt(maybePort, 10);
      }
    }
  }

  if (patPort !== null && patPort !== targetPort) {
    return false;
  }
  if (!patHost) return false;

  if (patHost.includes('*')) {
    if (patHost.startsWith('*.') && !patHost.slice(2).includes('*')) {
      const suffix = patHost.slice(1); // e.g. ".local"
      return unbracketedHost.endsWith(suffix) && unbracketedHost.length > suffix.length;
    }
    const regexSource = '^' + patHost.split('*').map(escapeRegexLiteral).join('.*') + '$';
    return new RegExp(regexSource).test(unbracketedHost);
  }

  if (patHost.startsWith('.')) {
    const clean = patHost.slice(1);
    if (!clean) return false;
    return unbracketedHost === clean || unbracketedHost.endsWith(`.${clean}`);
  }

  if (unbracketedHost === patHost) {
    return true;
  }
  if (net.isIP(patHost) === 0 && unbracketedHost.endsWith(`.${patHost}`)) {
    return true;
  }
  return false;
}

/**
 * Determine whether `targetUrl` must bypass the proxy.
 * Always bypasses `127.0.0.1` (and `127.0.0.0/8`), `localhost`, and `::1`,
 * plus any matching system `ExceptionsList` or `NO_PROXY` patterns.
 */
export function shouldBypassProxy(
  targetUrl: string | URL,
  exceptions: readonly string[] = [],
  envNoProxy?: string
): boolean {
  let parsed: URL;
  try {
    parsed = targetUrl instanceof URL ? targetUrl : new URL(targetUrl);
  } catch {
    return true;
  }

  const rawHost = parsed.hostname.toLowerCase();
  const unbracketedHost =
    rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost;

  if (isMandatoryLoopbackHost(unbracketedHost)) {
    return true;
  }

  const targetPort = parsed.port
    ? Number.parseInt(parsed.port, 10)
    : parsed.protocol === 'https:'
      ? 443
      : 80;
  const targetIpv4 = ipv4ToUint32(unbracketedHost);

  const noProxyText =
    envNoProxy !== undefined ? envNoProxy : (process.env.NO_PROXY ?? process.env.no_proxy ?? '');
  const envPatterns = noProxyText ? noProxyText.split(',') : [];

  for (const pattern of exceptions) {
    if (matchesBypassPattern(unbracketedHost, targetPort, targetIpv4, pattern)) {
      return true;
    }
  }
  for (const pattern of envPatterns) {
    if (matchesBypassPattern(unbracketedHost, targetPort, targetIpv4, pattern)) {
      return true;
    }
  }
  return false;
}

export function getRuntimeProxyConfig(): ProxyRuntimeConfig {
  return { ...runtimeProxyConfig };
}

export function setRuntimeProxyConfig(input: {
  mode: unknown;
  manualUrl?: unknown;
}): ProxyRuntimeConfig {
  if (!isProxyMode(input?.mode)) {
    throw new Error(bt('proxy.err.invalid_mode'));
  }
  const mode = input.mode;
  let manualUrl = runtimeProxyConfig.manualUrl;
  if (input.manualUrl !== undefined) {
    if (typeof input.manualUrl !== 'string') {
      throw new Error(bt('proxy.err.manual_url_must_be_string'));
    }
    const trimmed = input.manualUrl.trim();
    if (mode === 'manual') {
      manualUrl = normalizeManualProxyUrl(trimmed);
    } else if (trimmed) {
      try {
        manualUrl = normalizeManualProxyUrl(trimmed);
      } catch {
        manualUrl = trimmed;
      }
    } else {
      manualUrl = '';
    }
  } else if (mode === 'manual') {
    manualUrl = normalizeManualProxyUrl(manualUrl);
  }

  runtimeProxyConfig = { mode, manualUrl };
  clearSystemProxyCache();
  return { ...runtimeProxyConfig };
}

/**
 * Load `antigravityProxyMode` and `antigravityProxyManualUrl` from `<stateDir>/config.json` on startup.
 * Fails safe to `'off'` if config is missing or unreadable; never crashes startup.
 */
export function loadProxyConfigFromStateDir(stateDir: string): ProxyRuntimeConfig {
  const configPath = join(stateDir, 'config.json');
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8'));
    const rawMode = parsed?.antigravityProxyMode;
    const rawManual = typeof parsed?.antigravityProxyManualUrl === 'string'
      ? parsed.antigravityProxyManualUrl.trim()
      : '';
    const mode: ProxyMode = isProxyMode(rawMode) ? rawMode : 'off';
    let manualUrl = rawManual;
    if (rawManual) {
      try {
        manualUrl = normalizeManualProxyUrl(rawManual);
      } catch {
        manualUrl = rawManual;
      }
    }
    runtimeProxyConfig = { mode, manualUrl };
    clearSystemProxyCache();
    return { ...runtimeProxyConfig };
  } catch {
    runtimeProxyConfig = { mode: 'off', manualUrl: '' };
    clearSystemProxyCache();
    return { ...runtimeProxyConfig };
  }
}

export async function resolveEffectiveProxy(options?: {
  config?: ProxyRuntimeConfig;
  systemSnapshot?: SystemProxySnapshot;
  forceRefreshSystem?: boolean;
  execScutil?: () => Promise<string>;
}): Promise<EffectiveProxyResolution> {
  const cfg = options?.config ?? runtimeProxyConfig;

  if (cfg.mode === 'off') {
    return {
      mode: 'off',
      manualUrl: cfg.manualUrl,
      effectiveUrl: null,
      httpUrl: null,
      httpsUrl: null,
      exceptions: [],
      source: 'off',
    };
  }

  if (cfg.mode === 'manual') {
    try {
      const normalized = normalizeManualProxyUrl(cfg.manualUrl);
      return {
        mode: 'manual',
        manualUrl: normalized,
        effectiveUrl: normalized,
        httpUrl: normalized,
        httpsUrl: normalized,
        exceptions: [],
        source: 'manual',
      };
    } catch {
      return {
        mode: 'manual',
        manualUrl: cfg.manualUrl,
        effectiveUrl: null,
        httpUrl: null,
        httpsUrl: null,
        exceptions: [],
        source: 'invalid_manual',
      };
    }
  }

  const snapshot =
    options?.systemSnapshot ??
    (await readSystemProxySnapshot({
      forceRefresh: options?.forceRefreshSystem,
      execScutil: options?.execScutil,
    }));

  if (snapshot.httpsUrl || snapshot.httpUrl) {
    const httpUrl = snapshot.httpUrl ?? snapshot.httpsUrl;
    const httpsUrl = snapshot.httpsUrl ?? snapshot.httpUrl;
    return {
      mode: 'system',
      manualUrl: cfg.manualUrl,
      effectiveUrl: httpsUrl ?? httpUrl,
      httpUrl,
      httpsUrl,
      exceptions: [...snapshot.exceptions],
      source: 'system',
    };
  }

  if (snapshot.pacEnabled && snapshot.pacUrl) {
    return {
      mode: 'system',
      manualUrl: cfg.manualUrl,
      effectiveUrl: null,
      httpUrl: null,
      httpsUrl: null,
      exceptions: [...snapshot.exceptions],
      source: 'system_pac_unsupported',
    };
  }

  if (snapshot.socksEnabled && snapshot.socksUrl) {
    return {
      mode: 'system',
      manualUrl: cfg.manualUrl,
      effectiveUrl: null,
      httpUrl: null,
      httpsUrl: null,
      exceptions: [...snapshot.exceptions],
      source: 'system_socks_unsupported',
    };
  }

  return {
    mode: 'system',
    manualUrl: cfg.manualUrl,
    effectiveUrl: null,
    httpUrl: null,
    httpsUrl: null,
    exceptions: [...snapshot.exceptions],
    source: 'system_unconfigured',
  };
}

function getAbortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  return new DOMException('The operation was aborted.', 'AbortError');
}

function headersToRecord(initHeaders?: HeadersInit): Record<string, string> {
  const out: Record<string, string> = {};
  if (!initHeaders) return out;
  const h = new Headers(initHeaders);
  h.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function hasHeaderCaseInsensitive(headers: Record<string, string>, name: string): boolean {
  const target = name.toLowerCase();
  return Object.keys(headers).some(k => k.toLowerCase() === target);
}

function deleteHeaderCaseInsensitive(headers: Record<string, string>, name: string): void {
  const target = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) {
      delete headers[key];
    }
  }
}

async function serializeRequestBody(
  body: BodyInit | null | undefined,
  headers: Record<string, string>
): Promise<Buffer | null> {
  if (body === undefined || body === null) return null;
  if (typeof body === 'string') {
    return Buffer.from(body, 'utf8');
  }
  if (body instanceof URLSearchParams) {
    if (!hasHeaderCaseInsensitive(headers, 'content-type')) {
      headers['content-type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
    }
    return Buffer.from(body.toString(), 'utf8');
  }
  if (Buffer.isBuffer(body)) {
    return body;
  }
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  if (body instanceof ArrayBuffer) {
    return Buffer.from(body);
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    return Buffer.from(await body.arrayBuffer());
  }
  if (typeof (body as ReadableStream<Uint8Array>).getReader === 'function') {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    const chunks: Buffer[] = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks);
  }
  throw new TypeError('Unsupported request body type for proxied fetch');
}

function safeDecodeComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function buildProxyAuthHeader(proxyUrl: URL): string | null {
  if (!proxyUrl.username && !proxyUrl.password) return null;
  const decodedUser = safeDecodeComponent(proxyUrl.username);
  const decodedPass = safeDecodeComponent(proxyUrl.password);
  return `Basic ${Buffer.from(`${decodedUser}:${decodedPass}`).toString('base64')}`;
}

function buildWebResponse(
  finalUrl: URL,
  res: http.IncomingMessage,
  bodyBuffer: Buffer
): Response {
  const status = res.statusCode ?? 200;
  const statusText = res.statusMessage ?? '';
  const webHeaders = new Headers();
  for (const [key, value] of Object.entries(res.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        webHeaders.append(key, item);
      }
    } else {
      webHeaders.append(key, value);
    }
  }
  const responseBody = NULL_BODY_STATUSES.has(status) ? null : new Uint8Array(bodyBuffer);
  const response = new Response(responseBody, {
    status,
    statusText,
    headers: webHeaders,
  });
  Object.defineProperty(response, 'url', {
    value: finalUrl.href,
    enumerable: true,
    configurable: true,
  });
  return response;
}

async function openConnectTunnel(
  proxyUrl: URL,
  targetUrl: URL,
  signal: AbortSignal | undefined,
  tlsCa?: string | Buffer | Array<string | Buffer>,
  timeoutMs: number = DEFAULT_PROXY_TIMEOUT_MS
): Promise<tls.TLSSocket> {
  if (signal?.aborted) {
    throw getAbortReason(signal);
  }

  const targetPort = targetUrl.port ? Number.parseInt(targetUrl.port, 10) : 443;
  const rawHost = targetUrl.hostname;
  const unbracketedHost =
    rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost;
  const connectAuthority = `${rawHost}:${targetPort}`;

  const proxyPort = proxyUrl.port
    ? Number.parseInt(proxyUrl.port, 10)
    : proxyUrl.protocol === 'https:'
      ? 443
      : 80;
  const proxyRawHost = proxyUrl.hostname;
  const proxyHost =
    proxyRawHost.startsWith('[') && proxyRawHost.endsWith(']')
      ? proxyRawHost.slice(1, -1)
      : proxyRawHost;

  const connectHeaders: Record<string, string> = {
    Host: connectAuthority,
    'Proxy-Connection': 'Keep-Alive',
  };
  const proxyAuth = buildProxyAuthHeader(proxyUrl);
  if (proxyAuth) {
    connectHeaders['Proxy-Authorization'] = proxyAuth;
  }

  return await new Promise<tls.TLSSocket>((resolveSocket, rejectSocket) => {
    let settled = false;
    let connectReq: http.ClientRequest | null = null;
    let tunnelSocket: net.Socket | null = null;
    let tlsSocket: tls.TLSSocket | null = null;

    let onTlsSecureConnect: (() => void) | null = null;
    let onTlsError: ((err: Error) => void) | null = null;
    let onTlsClose: (() => void) | null = null;

    const cleanupSignal = () => {
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const cleanupTlsHandshakeListeners = () => {
      if (!tlsSocket) return;
      if (onTlsSecureConnect) tlsSocket.off('secureConnect', onTlsSecureConnect);
      if (onTlsError) tlsSocket.off('error', onTlsError);
      if (onTlsClose) tlsSocket.off('close', onTlsClose);
      onTlsSecureConnect = null;
      onTlsError = null;
      onTlsClose = null;
    };
    const onTimeout = () => {
      finishReject(new Error(`Proxy CONNECT tunnel timed out after ${timeoutMs}ms`));
    };
    const cleanupTimeout = () => {
      connectReq?.setTimeout(0);
      connectReq?.off('timeout', onTimeout);
      tunnelSocket?.setTimeout(0);
      tunnelSocket?.off('timeout', onTimeout);
      tlsSocket?.setTimeout(0);
      tlsSocket?.off('timeout', onTimeout);
    };
    const finishResolve = (sock: tls.TLSSocket) => {
      if (settled) return;
      settled = true;
      cleanupSignal();
      cleanupTimeout();
      cleanupTlsHandshakeListeners();
      resolveSocket(sock);
    };
    const finishReject = (err: unknown) => {
      if (settled) return;
      settled = true;
      cleanupSignal();
      cleanupTimeout();
      cleanupTlsHandshakeListeners();
      tlsSocket?.destroy();
      tunnelSocket?.destroy();
      connectReq?.socket?.destroy();
      connectReq?.destroy();
      rejectSocket(err);
    };

    const transport = proxyUrl.protocol === 'https:' ? https : http;
    connectReq = transport.request({
      host: proxyHost,
      port: proxyPort,
      method: 'CONNECT',
      path: connectAuthority,
      headers: connectHeaders,
      agent: false,
      ...(proxyUrl.protocol === 'https:' && tlsCa ? { ca: tlsCa } : {}),
    });

    const onAbort = () => {
      finishReject(getAbortReason(signal!));
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    connectReq.setTimeout(timeoutMs, onTimeout);
    connectReq.on('error', err => finishReject(err));
    connectReq.once('close', () => {
      if (!settled && !tunnelSocket) {
        finishReject(new Error('Proxy CONNECT connection closed before response'));
      }
    });

    connectReq.on('connect', (proxyRes, socket, head) => {
      tunnelSocket = socket;
      connectReq?.setTimeout(0);
      connectReq?.off('timeout', onTimeout);
      socket.setTimeout(0);
      if (signal?.aborted) {
        finishReject(getAbortReason(signal));
        return;
      }
      if (proxyRes.statusCode !== 200) {
        finishReject(new Error(`Proxy CONNECT failed with HTTP ${proxyRes.statusCode ?? 'unknown'}`));
        return;
      }
      if (head && head.length > 0) {
        socket.unshift(head);
      }

      const servername = net.isIP(unbracketedHost) === 0 ? unbracketedHost : undefined;
      tlsSocket = tls.connect({
        socket,
        servername,
        rejectUnauthorized: true,
        ...(tlsCa ? { ca: tlsCa } : {}),
      });

      tlsSocket.setTimeout(timeoutMs, onTimeout);
      onTlsSecureConnect = () => {
        if (signal?.aborted) {
          finishReject(getAbortReason(signal));
          return;
        }
        finishResolve(tlsSocket!);
      };
      onTlsError = (err: Error) => finishReject(err);
      onTlsClose = () => {
        if (!settled) {
          finishReject(new Error('TLS handshake over proxy tunnel closed unexpectedly'));
        }
      };
      tlsSocket.once('secureConnect', onTlsSecureConnect);
      tlsSocket.once('error', onTlsError);
      tlsSocket.once('close', onTlsClose);
    });

    connectReq.end();
  });
}

async function sendSingleProxiedHttpRequest(params: {
  targetUrl: URL;
  proxyUrl: URL;
  method: string;
  headers: Record<string, string>;
  body: Buffer | null;
  signal?: AbortSignal;
  tlsCa?: string | Buffer | Array<string | Buffer>;
  maxResponseBytes?: number;
  timeoutMs?: number;
}): Promise<Response> {
  const {
    targetUrl,
    proxyUrl,
    method,
    headers,
    body,
    signal,
    tlsCa,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
    timeoutMs = DEFAULT_PROXY_TIMEOUT_MS,
  } = params;
  if (signal?.aborted) {
    throw getAbortReason(signal);
  }

  const reqHeaders: Record<string, string> = { ...headers };
  if (!hasHeaderCaseInsensitive(reqHeaders, 'host')) {
    reqHeaders['Host'] = targetUrl.host;
  }
  if (body !== null && !hasHeaderCaseInsensitive(reqHeaders, 'content-length')) {
    reqHeaders['Content-Length'] = String(body.byteLength);
  }

  if (targetUrl.protocol === 'https:') {
    if (!hasHeaderCaseInsensitive(reqHeaders, 'connection')) {
      reqHeaders['Connection'] = 'close';
    }
    const tlsSocket = await openConnectTunnel(proxyUrl, targetUrl, signal, tlsCa, timeoutMs);
    const targetPort = targetUrl.port ? Number.parseInt(targetUrl.port, 10) : 443;
    const rawHost = targetUrl.hostname;
    const targetHost =
      rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost;

    return await new Promise<Response>((resolveResp, rejectResp) => {
      let settled = false;
      let req: http.ClientRequest | null = null;
      const cleanupSignal = () => {
        if (signal) signal.removeEventListener('abort', onAbort);
      };
      const onTimeout = () => {
        finishReject(new Error(`Proxied HTTPS request timed out after ${timeoutMs}ms`));
      };
      const cleanupTimeout = () => {
        req?.setTimeout(0);
        req?.off('timeout', onTimeout);
        tlsSocket.setTimeout(0);
        tlsSocket.off('timeout', onTimeout);
      };
      const finishResolve = (value: Response) => {
        if (settled) return;
        settled = true;
        cleanupSignal();
        cleanupTimeout();
        resolveResp(value);
      };
      const finishReject = (err: unknown) => {
        if (settled) return;
        settled = true;
        cleanupSignal();
        cleanupTimeout();
        req?.destroy();
        tlsSocket.destroy();
        rejectResp(err);
      };

      req = http.request(
        {
          host: targetHost,
          port: targetPort,
          method,
          path: `${targetUrl.pathname}${targetUrl.search}`,
          headers: reqHeaders,
          // Keep `agent` omitted: Node.js `http.request` constructs a fresh `http.Agent`
          // when `agent: false` is set and ignores custom `createConnection`.
          createConnection: () => tlsSocket,
        },
        res => {
          const chunks: Buffer[] = [];
          let totalBytes = 0;
          res.on('data', (chunk: Buffer | string) => {
            if (settled) return;
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            totalBytes += buf.length;
            if (totalBytes > maxResponseBytes) {
              finishReject(
                new Error(`Proxied HTTPS response exceeded maxResponseBytes (${maxResponseBytes} bytes)`)
              );
              return;
            }
            chunks.push(buf);
          });
          res.on('error', err => finishReject(err));
          res.on('close', () => {
            if (!settled && !res.complete) {
              finishReject(new Error('Proxied HTTPS response closed prematurely'));
            }
          });
          res.on('end', () => {
            if (settled) return;
            const bodyBuf = Buffer.concat(chunks, totalBytes);
            tlsSocket.destroy();
            finishResolve(buildWebResponse(targetUrl, res, bodyBuf));
          });
        }
      );

      const onAbort = () => {
        finishReject(getAbortReason(signal!));
      };
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      req.setTimeout(timeoutMs, onTimeout);
      tlsSocket.setTimeout(timeoutMs, onTimeout);
      req.on('error', err => finishReject(err));
      if (body !== null) {
        req.write(body);
      }
      req.end();
    });
  }

  // Standard HTTP proxy forwarding for plain http:// targets.
  const proxyPort = proxyUrl.port
    ? Number.parseInt(proxyUrl.port, 10)
    : proxyUrl.protocol === 'https:'
      ? 443
      : 80;
  const proxyRawHost = proxyUrl.hostname;
  const proxyHost =
    proxyRawHost.startsWith('[') && proxyRawHost.endsWith(']')
      ? proxyRawHost.slice(1, -1)
      : proxyRawHost;
  const proxyAuth = buildProxyAuthHeader(proxyUrl);
  if (proxyAuth && !hasHeaderCaseInsensitive(reqHeaders, 'proxy-authorization')) {
    reqHeaders['Proxy-Authorization'] = proxyAuth;
  }

  return await new Promise<Response>((resolveResp, rejectResp) => {
    let settled = false;
    let req: http.ClientRequest | null = null;
    const cleanupSignal = () => {
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const onTimeout = () => {
      finishReject(new Error(`Proxied HTTP request timed out after ${timeoutMs}ms`));
    };
    const cleanupTimeout = () => {
      req?.setTimeout(0);
      req?.off('timeout', onTimeout);
    };
    const finishResolve = (value: Response) => {
      if (settled) return;
      settled = true;
      cleanupSignal();
      cleanupTimeout();
      resolveResp(value);
    };
    const finishReject = (err: unknown) => {
      if (settled) return;
      settled = true;
      cleanupSignal();
      cleanupTimeout();
      req?.destroy();
      rejectResp(err);
    };

    const transport = proxyUrl.protocol === 'https:' ? https : http;
    req = transport.request(
      {
        host: proxyHost,
        port: proxyPort,
        method,
        path: targetUrl.href,
        headers: reqHeaders,
        agent: false,
        ...(proxyUrl.protocol === 'https:' && tlsCa ? { ca: tlsCa } : {}),
      },
      res => {
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        res.on('data', (chunk: Buffer | string) => {
          if (settled) return;
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalBytes += buf.length;
          if (totalBytes > maxResponseBytes) {
            finishReject(
              new Error(`Proxied HTTP response exceeded maxResponseBytes (${maxResponseBytes} bytes)`)
            );
            return;
          }
          chunks.push(buf);
        });
        res.on('error', err => finishReject(err));
        res.on('close', () => {
          if (!settled && !res.complete) {
            finishReject(new Error('Proxied HTTP response closed prematurely'));
          }
        });
        res.on('end', () => {
          if (settled) return;
          const bodyBuf = Buffer.concat(chunks, totalBytes);
          finishResolve(buildWebResponse(targetUrl, res, bodyBuf));
        });
      }
    );

    const onAbort = () => {
      finishReject(getAbortReason(signal!));
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    req.setTimeout(timeoutMs, onTimeout);
    req.on('error', err => finishReject(err));
    if (body !== null) {
      req.write(body);
    }
    req.end();
  });
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * Create a zero-dependency proxy-aware fetch function.
 * Production callers should use the exported `fetchWithProxy` (which enforces strict TLS verification).
 */
export function createProxyFetch(options?: ProxyFetchFactoryOptions): typeof globalThis.fetch {
  const getDirectFetch = () => options?.directFetch ?? globalThis.fetch;
  const resolveProxyFn = options?.resolveProxy ?? (() => resolveEffectiveProxy());
  const tlsCa = options?.tlsCa;
  const maxResponseBytes =
    typeof options?.maxResponseBytes === 'number' &&
    Number.isFinite(options.maxResponseBytes) &&
    options.maxResponseBytes > 0
      ? options.maxResponseBytes
      : DEFAULT_MAX_RESPONSE_BYTES;
  const timeoutMs =
    typeof options?.timeoutMs === 'number' &&
    Number.isFinite(options.timeoutMs) &&
    options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_PROXY_TIMEOUT_MS;

  return async function proxyAwareFetch(
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> {
    let rawUrl: string;
    let method: string;
    let headers: Record<string, string>;
    let bodyInit: BodyInit | null | undefined;
    let signal: AbortSignal | undefined;
    let redirectMode: RequestRedirect;

    if (typeof Request !== 'undefined' && input instanceof Request) {
      rawUrl = input.url;
      method = (init?.method ?? input.method ?? 'GET').toUpperCase();
      headers = headersToRecord(init?.headers ?? input.headers);
      bodyInit = init?.body !== undefined ? init.body : (input.body ?? null);
      signal = init?.signal ?? input.signal ?? undefined;
      redirectMode = init?.redirect ?? input.redirect ?? 'follow';
    } else {
      rawUrl = input instanceof URL ? input.href : String(input);
      method = (init?.method ?? 'GET').toUpperCase();
      headers = headersToRecord(init?.headers);
      bodyInit = init?.body;
      signal = init?.signal ?? undefined;
      redirectMode = init?.redirect ?? 'follow';
    }

    let currentUrl: URL;
    try {
      currentUrl = new URL(rawUrl);
    } catch {
      return await getDirectFetch()(input, init);
    }

    if (currentUrl.protocol !== 'http:' && currentUrl.protocol !== 'https:') {
      return await getDirectFetch()(input, init);
    }

    const resolved = await resolveProxyFn();
    const initialProxyStr = currentUrl.protocol === 'https:' ? resolved.httpsUrl : resolved.httpUrl;
    if (
      resolved.mode === 'off' ||
      !initialProxyStr ||
      shouldBypassProxy(currentUrl, resolved.exceptions)
    ) {
      return await getDirectFetch()(input, init);
    }

    let currentMethod = method;
    let currentHeaders = { ...headers };
    let currentBody = await serializeRequestBody(bodyInit, currentHeaders);

    for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
      if (signal?.aborted) {
        throw getAbortReason(signal);
      }

      const hopProxyStr = currentUrl.protocol === 'https:' ? resolved.httpsUrl : resolved.httpUrl;
      let response: Response;

      if (!hopProxyStr || shouldBypassProxy(currentUrl, resolved.exceptions)) {
        const directInit: RequestInit = {
          method: currentMethod,
          headers: currentHeaders,
          redirect: 'manual',
          ...(signal ? { signal } : {}),
          ...(currentBody !== null ? { body: new Uint8Array(currentBody) } : {}),
        };
        response = await getDirectFetch()(currentUrl.href, directInit);
      } else {
        const proxyUrl = new URL(hopProxyStr);
        response = await sendSingleProxiedHttpRequest({
          targetUrl: currentUrl,
          proxyUrl,
          method: currentMethod,
          headers: currentHeaders,
          body: currentBody,
          signal,
          tlsCa,
          maxResponseBytes,
          timeoutMs,
        });
      }

      if (!isRedirectStatus(response.status)) {
        return response;
      }

      if (redirectMode === 'manual') {
        return response;
      }
      if (redirectMode === 'error') {
        throw new TypeError('Failed to fetch: unexpected redirect');
      }

      const location = response.headers.get('location');
      if (!location) {
        return response;
      }
      if (hop >= MAX_REDIRECT_HOPS) {
        throw new Error(`Too many redirects (exceeded ${MAX_REDIRECT_HOPS} hops)`);
      }

      const nextUrl = new URL(location, currentUrl);
      if (nextUrl.protocol !== 'http:' && nextUrl.protocol !== 'https:') {
        throw new TypeError(`Unsupported redirect protocol: ${nextUrl.protocol}`);
      }
      if (nextUrl.origin !== currentUrl.origin) {
        deleteHeaderCaseInsensitive(currentHeaders, 'authorization');
        deleteHeaderCaseInsensitive(currentHeaders, 'cookie');
        deleteHeaderCaseInsensitive(currentHeaders, 'proxy-authorization');
      }
      if (
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) && currentMethod === 'POST')
      ) {
        currentMethod = 'GET';
        currentBody = null;
        deleteHeaderCaseInsensitive(currentHeaders, 'content-length');
        deleteHeaderCaseInsensitive(currentHeaders, 'content-type');
      }
      deleteHeaderCaseInsensitive(currentHeaders, 'host');
      currentUrl = nextUrl;
    }

    throw new Error(`Too many redirects (exceeded ${MAX_REDIRECT_HOPS} hops)`);
  };
}

export const fetchWithProxy: typeof globalThis.fetch = createProxyFetch();

/**
 * Returns `fetchWithProxy` ONLY when `fetchImpl === globalThis.fetch` AND runtime proxy mode is enabled.
 * Preserves injected test mocks and all `fetchImpl === globalThis.fetch` identity checks in callers.
 */
export function resolveOutboundFetch(
  fetchImpl: typeof globalThis.fetch = globalThis.fetch
): typeof globalThis.fetch {
  if (fetchImpl === globalThis.fetch && runtimeProxyConfig.mode !== 'off') {
    return fetchWithProxy;
  }
  return fetchImpl;
}
