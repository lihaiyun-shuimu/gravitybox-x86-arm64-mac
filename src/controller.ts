import { BundleCache } from './bundle-cache.js';
import { CdpHudBridge, HUD_BRIDGE_BINDING_NAME } from './hud.js';
import { scopedKey, describeContext, type PendingItem } from './candidates.js';
import { readFile, mkdir } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { createHash } from 'node:crypto';
import { atomicJson, atomicText } from './files.js';
import { nativeSources, createCoverage, classifyCoverage, recountCoverage, coverageScopes, coverageTranslationLookup, resolveCoverageTranslation, type CoverageReport } from './coverage.js';
import { readPluginCatalog } from './plugin-catalog.js';
import { sanitizeNativeMenus, deepMarkdown, type DeepReport } from './deep-scan.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CDP, assertLoopback } from './cdp.js';
import {
  allowedTarget,
  discover,
  inspectBundle,
  inspectPageService,
  isApplicationRunning,
  type Endpoint,
  type PageServiceKind,
} from './discovery.js';
import { compareLayers, type Dictionary } from './dictionary.js';
import { normalizeLocale, translate } from './i18n.js';
import {
  isEnglishSource, SUPPORTED_BUNDLES,
  isSupportedBundleHash,
  fetchBundleFromOrigin,
  fetchRemoteBundleHashViaCdp,
  computeBundleSha256,
  extractUiStrings, extractedKind,
  createPendingList,
  computeBundleDictionaryCoverage,
  ADAPTIVE_FULL_TRANSLATION_MIN_COVERAGE,
  ADAPTIVE_FULL_TRANSLATION_MIN_STRINGS,
  type ExtractedString,
} from './bundle.js';
import {
  cleanHostLabel,
  probeMainWorldSshRemote,
  supportsSshRemoteBridge,
  verifyRemotePageWindow,
  type RemoteWindowVerification,
  type WindowSourceKind,
} from './ssh-context.js';
import { SshRemoteRpcClient, type RemoteRpcClientLike } from './ssh-remote-rpc.js';
import { buildRemoteEnvironmentId } from './remote-usage-sync.js';
import { mergeLiveQuotaWithSaved } from './ipc-projections.js';
import type { LiveLanguageServerStatus, QuotaData } from './accounts.js';

export type RemoteSessionConnectionState = 'connected' | 'disconnected' | 'auth_expired' | 'unverified';

export interface RemoteSessionState {
  remoteKey: string;
  environmentId: string;
  machineId?: string;
  hostLabel: string;
  targetId: string;
  origin: string;
  state: RemoteSessionConnectionState;
  windowCount?: number;
  probing: boolean;
  email: string;
  name: string | null;
  tier: string;
  accountType: 'consumer' | 'enterprise_vertex' | 'unknown';
  matchedLocalAccountId: string | null;
  quota: QuotaData | null;
  quotaOverview: Record<string, unknown> | null;
  observedAt: number | null;
  lastIdentityVerifiedAt: number | null;
  needsIdentityVerify?: boolean;
  disconnectedAt: number | null;
  lastError: string;
  lastFocusedAt: number;
}

export interface ConnectedRemoteRpcTarget {
  remoteKey: string;
  hostLabel: string;
  environmentId: string;
  origin: string;
  rpcClient: RemoteRpcClientLike;
  email: string;
  name: string | null;
  accountType: 'consumer' | 'enterprise_vertex' | 'unknown';
  matchedLocalAccountId: string | null;
  state: RemoteSessionConnectionState;
  windowCount: number;
  lastIdentityVerifiedAt: number;
  reconnected: boolean;
}

export type AssistantStatus = {
  schema: 1; mode: string; message: string; appVersion?: string; windows: number;
  sshWindows?: number;
  sshWindowsCount?: number;
  activeSshHosts?: string[];
  focusedContextKey?: string;
  remoteObservedVersion?: number;
  dictionaryVersion: string; entries: number; dictionaryError?: string; errors: string[];
  rssMB: number; updatedAt: string; pid: number;
  translationEnabled?: boolean;
  hudEnabled?: boolean;
  unverifiedVersion?: boolean;
  newStringsCount?: number;
  pendingListPath?: string;
  bundleSha256?: string;
  menuHooked?: boolean;
  dictionaryBaseVersion?: string;
  languageMode?: string;
  locale?: string;
  configuredLanguage?: string;
  bundleCacheHit?: boolean;
  taskRevision?: number;
  bundleReads?:number;bundleBytes?:number;
};
export type PageSession = {
  cdp: CDP;
  targetId: string;
  contextId?: number;
  registration?: string;
  updateChain: Promise<void>;
  url: string;
  languageMode?: string;
  detaching?: boolean;
  sourceKind?: WindowSourceKind;
  remoteKey?: string;
  environmentId?: string;
  machineId?: string;
  hostLabel?: string;
  browserContextId?: string;
  bundleSha256?: string;
  verifiedBundle?: boolean;
  registeredVerifiedBundle?: boolean;
  registeredFullTranslation?: boolean;
  domContractPassed?: boolean;
  bootedConservative?: boolean;
  lastFocusedAt?: number;
  rpcClient?: SshRemoteRpcClient;
};
function isSafeCandidate(key: unknown): key is string {
  return typeof key === 'string' && isEnglishSource(key) && key.length <= 400 && !/(?:https?:\/\/|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|(?:^|\s)(?:\/|~\/|[A-Za-z]:\\)|\b(?:sk-|AIza)[A-Za-z0-9_-]{12,})/.test(key);
}
const WORLD = 'GRAVITYBOX-localization-v1';

export class Controller {
  private endpoint?: Endpoint;
  private browser?: CDP;
  private pages = new Map<string, PageSession>();
  private reconnection?: NodeJS.Timeout;
  private targetTimer?: NodeJS.Timeout;
  private stopped = false;
  private paused = false;
  private locale = 'zh-Hans';
  private configuredLanguage = 'zh-Hans';
  private hasTargetDictionary = true;
  private get observeOnly() { return this.paused && !this.hudEnabled; }
  private get dormant() { return this.observeOnly; }
  private focusPublishTimer?: NodeJS.Timeout;
  private lastPublishedFocusKey = '';
  private lastFocusPublishAt = 0;
  private effectiveStatusLocale(): string {
    return this.locale;
  }
  private effectiveHudLocale(): string {
    if (this.options.fixture && this.paused) return 'en';
    return this.locale;
  }
  private t(key: string, params?: Record<string, string | number | boolean | null | undefined>): string {
    return translate(this.effectiveStatusLocale(), key, params, { namespace: 'backend' });
  }
  private hudEnabled = true;
  private reconnectionDelay = 1000;
  private syncing = false;
  private syncAgain = false;
  private engine = '';
  private runtimeId='';
  private bootCache = new Map<string, string>();
  private controlChain: Promise<void> = Promise.resolve();
  private enqueueControl<T>(task: () => Promise<T>): Promise<T> {
    const run = this.controlChain.catch(() => {}).then(task);
    this.controlChain = run.then(() => {}, () => {});
    return run;
  }
  private profileWatchers: FSWatcher[] = [];
  private connecting?: Promise<void>;
  private syncWaiters: (() => void)[] = [];
  private lastInspectedSha?: string;
  private lastInspectedAppVersion?: string;
  private lastInspectedDictVersion?: string;
  private lastInspectedBundle?: { sha: string; extracted: ExtractedString[] };
  private inspectingBundle = false;
  private adaptiveFullTranslationByBundle = new Map<string, boolean>();
  private unverifiedWindowRetries = 0;
  private sshProbeRetries = 0;
  private pendingRemoteTargets = new Map<string, number>();
  private localBrowserContextIds = new Set<string>();
  private remoteSessions = new Map<string, RemoteSessionState>();
  private remoteProbeInFlight = new Map<string, Promise<void>>();
  private remoteObservedVersion = 0;
  private localFocusedAt = 0;
  private readonly REMOTE_SESSION_CACHE_TTL_MS = 30_000;
  private readonly REMOTE_DISCONNECTED_RETENTION_MS = 10 * 60 * 1000;
  private trustedCandidates: PendingItem[] = [];
  private bundleCache = new BundleCache();
  private hudBridge: CdpHudBridge;
  private initialBundle?: string;
  private coverage?: CoverageReport;
  private coverageMissingForKey?: string;
  status: AssistantStatus;
  constructor(private options: {
    appPath: string;
    profile: string;
    fixture?: { port: number; origin: string };
    dictionary: Dictionary;
    stateDir?: string;
    geminiDir?: string;
    inspectPort?: number; // Deprecated: never opens a main-process inspector.
    shortcutEnabled?: boolean;
    hudEnabled?: boolean;
    initiallyPaused?: boolean;
    locale?: string;
    configuredLanguage?: string;
    hasTargetDictionary?: boolean;
    reloadDictionary?: () => Promise<void>;
    selectDictionary?: (version: string) => Promise<Dictionary>;
    isAppRunning?: () => Promise<boolean>;
    discoverEndpoint?: (appPath: string, profile: string) => Promise<Endpoint | undefined>;
    inspectAppBundle?: (appPath: string) => Promise<{ version: string; legacyPatch: boolean }>;
    verifyPage?: (url: string, appPath: string) => Promise<boolean>;
    inspectPage?: (url: string, appPath: string) => Promise<PageServiceKind>;
    verifyRemoteWindow?: (params: {
      appVersion: string;
      antigravityPid: number;
      url: string;
      cdp: CDP;
      browserContextId?: string;
      localBrowserContextIds: ReadonlySet<string>;
    }) => Promise<RemoteWindowVerification>;
    onStatus: (status: AssistantStatus) => void;
  }) {
    const initialLocale = normalizeLocale(options.locale ?? '') ?? (options.initiallyPaused ? 'en' : 'zh-Hans');
    this.locale = initialLocale;
    this.configuredLanguage = options.configuredLanguage ?? initialLocale;
    this.hasTargetDictionary = options.hasTargetDictionary ?? (initialLocale !== 'en');
    this.paused = options.initiallyPaused === true || initialLocale === 'en' || !this.hasTargetDictionary;
    this.hudEnabled = options.hudEnabled !== false;
    this.hudBridge = new CdpHudBridge({
      geminiDir: options.geminiDir || process.env.GRAVITYBOX_GEMINI_DIR || process.env.GEMINI_DIR,
      stateDir: options.stateDir,
    });
    const effectiveLocale = this.effectiveStatusLocale();
    this.status = { schema: 1, mode: 'starting', message: this.t('status.starting'), windows: 0, sshWindows: 0, sshWindowsCount: 0, activeSshHosts: [], focusedContextKey: 'local', remoteObservedVersion: 0, dictionaryVersion: options.dictionary.version, entries: Object.keys(options.dictionary.entries).length, errors: [], rssMB: 0, updatedAt: '', pid: process.pid, menuHooked: false, translationEnabled: !this.paused, hudEnabled: this.hudEnabled, locale: effectiveLocale, configuredLanguage: this.configuredLanguage };
  }
  private publish(mode?: string, message?: string) {
    if (mode) this.status.mode = mode;
    if (message) this.status.message = message;
    const effectiveLocale = this.effectiveStatusLocale();
    this.status.translationEnabled = !this.paused;
    this.status.hudEnabled = this.hudEnabled;
    this.status.locale = effectiveLocale;
    this.status.configuredLanguage = this.configuredLanguage;
    this.status.windows = this.pages.size;
    const sshSummary = this.getActiveSshWindowsSummary();
    this.status.sshWindows = sshSummary.count;
    this.status.sshWindowsCount = sshSummary.count;
    this.status.activeSshHosts = sshSummary.hosts;
    this.status.focusedContextKey = this.getFocusedContextKey();
    this.status.remoteObservedVersion = this.remoteObservedVersion;
    this.status.unverifiedVersion = !this.effectiveVerifiedStatus();
    this.status.bundleReads=this.bundleCache.downloads;this.status.bundleBytes=this.bundleCache.downloadedBytes;
    const modes=new Set([...this.pages.values()].map(p=>p.languageMode??(this.paused?'en':'zh')));this.status.languageMode=modes.size>1?'mixed':([...modes][0]??(this.paused?'en':'zh'));
    this.status.rssMB = Math.round(process.memoryUsage().rss / 1024 / 1024 * 10) / 10;
    this.status.updatedAt = new Date().toISOString();
    this.options.onStatus({ ...this.status });
  }
  private activeAppPath(): string {
    return this.endpoint?.appPath ?? this.options.appPath;
  }
  private checkAppRunning(): Promise<boolean> {
    return this.options.isAppRunning
      ? this.options.isAppRunning()
      : isApplicationRunning(this.activeAppPath());
  }
  private discoverEndpoint(appPath: string, profile: string): Promise<Endpoint | undefined> {
    return this.options.discoverEndpoint
      ? this.options.discoverEndpoint(appPath, profile)
      : discover(appPath, profile);
  }
  private inspectAppBundle(appPath: string): Promise<{ version: string; legacyPatch: boolean }> {
    return this.options.inspectAppBundle
      ? this.options.inspectAppBundle(appPath)
      : inspectBundle(appPath);
  }
  private async checkPageService(url: string, appPath: string): Promise<boolean> {
    return (await this.inspectPageState(url, appPath)) === 'local';
  }
  private async inspectPageState(url: string, appPath: string): Promise<PageServiceKind> {
    if (this.options.inspectPage) {
      return this.options.inspectPage(url, appPath);
    }
    if (this.options.verifyPage) {
      return (await this.options.verifyPage(url, appPath)) ? 'local' : 'unlisted';
    }
    return inspectPageService(url, appPath);
  }
  private async verifyRemoteWindowTarget(params: {
    appVersion: string;
    antigravityPid: number;
    url: string;
    cdp: CDP;
    browserContextId?: string;
  }): Promise<RemoteWindowVerification> {
    if (this.options.verifyRemoteWindow) {
      return this.options.verifyRemoteWindow({
        ...params,
        localBrowserContextIds: this.localBrowserContextIds,
      });
    }
    return verifyRemotePageWindow({
      ...params,
      localBrowserContextIds: this.localBrowserContextIds,
    });
  }
  private closeProfileWatchers() {
    for (const w of this.profileWatchers.splice(0)) {
      try { w.close(); } catch {}
    }
  }
  private watchProfiles() {
    this.closeProfileWatchers();
    if (this.options.fixture) return;
    for (const profileDir of [this.options.profile]) {
      try {
        const watcher = watch(profileDir, (_event, name) => {
          if (String(name) === 'DevToolsActivePort' && !this.stopped) {
            clearTimeout(this.reconnection);
            this.reconnectionDelay = 1000;
            this.unverifiedWindowRetries = 0;
            void this.tryConnect().catch(() => this.retry());
          }
        });
        watcher.on('error', () => { try { watcher.close(); } catch {} });
        this.profileWatchers.push(watcher);
      } catch { /* A missing profile uses bounded discovery retries. */ }
    }
  }
  private scheduleFocusPublish(forceImmediate = false) {
    if (this.stopped) return;
    const nextFocusKey = `${this.getFocusedEnvironmentId()}|${this.getFocusedContextKey()}`;
    const focusChanged = nextFocusKey !== this.lastPublishedFocusKey;
    const now = Date.now();
    if (forceImmediate || focusChanged || now - this.lastFocusPublishAt >= 200) {
      if (this.focusPublishTimer) {
        clearTimeout(this.focusPublishTimer);
        this.focusPublishTimer = undefined;
      }
      this.lastPublishedFocusKey = nextFocusKey;
      this.lastFocusPublishAt = now;
      this.publish();
      return;
    }
    if (!this.focusPublishTimer) {
      this.focusPublishTimer = setTimeout(() => {
        this.focusPublishTimer = undefined;
        if (this.stopped) return;
        this.lastPublishedFocusKey = `${this.getFocusedEnvironmentId()}|${this.getFocusedContextKey()}`;
        this.lastFocusPublishAt = Date.now();
        this.publish();
      }, 150);
      this.focusPublishTimer.unref?.();
    }
  }
  async start() {
    this.engine = await readFile(new URL('./engine.js', import.meta.url), 'utf8');this.runtimeId=createHash('sha256').update(this.engine).digest('hex');
    this.watchProfiles();
    await this.tryConnect();
  }
  private tryConnect(): Promise<void> {
    if (this.connecting) return this.connecting;
    const attempt = this.connectOnce();
    this.connecting = attempt;
    return attempt.finally(() => { this.connecting = undefined; });
  }
  private async connectOnce() {
    if (this.stopped) return;
    try {
      if (this.browser) { await this.sync(); return; }
      if (this.options.fixture) {
        const port = this.options.fixture.port;
        const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
        const version = await response.json() as { webSocketDebuggerUrl: string };
        const url = assertLoopback(version.webSocketDebuggerUrl);
        if (Number(url.port) !== port) throw new Error(this.t('controller.err.fixture_port_mismatch'));
        this.endpoint = { port, browserURL: url.href, pid: 0, appVersion: 'fixture', legacyPatch: false };
      } else this.endpoint = await this.discoverEndpoint(this.options.appPath, this.options.profile);
      if (this.stopped) return;
      if (!this.endpoint) {
        if (!this.options.fixture && await this.checkAppRunning()) {
          if (this.stopped) return;
          const inspected = await this.inspectAppBundle(this.activeAppPath()).catch(() => undefined);
          if (this.stopped) return;
          if (inspected?.version) this.status.appVersion = inspected.version;
          if (this.observeOnly) {
            this.publish('paused', this.t('status.paused_keep'));
          } else {
            this.publish('debug-port-missing', this.t('status.debug_port_missing'));
          }
          this.retry(3000);
          return;
        }
        if (this.observeOnly) {
          this.publish('paused', this.t('status.paused_keep'));
        } else {
          this.publish('waiting', this.t('status.waiting_app'));
        }
        this.retry();
        return;
      }
      this.status.appVersion = this.endpoint.appVersion;
      if(this.options.selectDictionary){const dictionary=await this.options.selectDictionary(this.endpoint.appVersion);this.options.dictionary=dictionary;this.status.dictionaryVersion=dictionary.version;this.status.entries=Object.keys(dictionary.entries).length;this.bootCache.clear();}
      if (this.endpoint.legacyPatch) { this.publish('legacy-blocked', this.t('status.legacy_blocked')); this.retry(30000); return; }
      this.status.dictionaryBaseVersion = [...SUPPORTED_BUNDLES.keys()].filter(v=>compareLayers(v+'.json',this.endpoint!.appVersion+'.json')<=0).sort((a,b)=>compareLayers(a+'.json',b+'.json')).at(-1)??'base';
      this.status.unverifiedVersion=!this.effectiveVerifiedStatus();
      const browser = this.browser = new CDP(this.endpoint.browserURL);
      await browser.connect();
      if (this.stopped) { browser.close(); this.browser = undefined; return; }
      browser.on('Target.targetCreated', () => this.scheduleSync());
      browser.on('Target.targetInfoChanged', () => this.scheduleSync());
      browser.on('Target.targetDestroyed', () => this.scheduleSync());
      browser.on('disconnected', () => { void this.disconnectPages(); this.browser = undefined; this.pendingRemoteTargets.clear(); this.localBrowserContextIds.clear(); if (!this.stopped) { this.reconnectionDelay = 1000; this.unverifiedWindowRetries = 0; this.sshProbeRetries = 0; this.publish('waiting', this.t('status.reconnecting')); this.retry(); } });
      await browser.send('Target.setDiscoverTargets', { discover: true });
      this.reconnectionDelay = 1000;
      this.unverifiedWindowRetries = 0;
      this.sshProbeRetries = 0;
      await this.sync();
    } catch (error) {
      this.browser?.close(); this.browser = undefined;
      this.publish('error', (error as Error).message); this.retry();
    }
  }
  private verifiedBundle(session?: PageSession){
    if(this.options.fixture)return true;
    if(session&&session.verifiedBundle!==undefined)return session.verifiedBundle;
    return isSupportedBundleHash(this.status.appVersion,this.status.bundleSha256);
  }
  private shouldUseFullTranslation(session?: PageSession): boolean {
    if (this.verifiedBundle(session)) return true;
    if (!session || session.sourceKind === 'remote') return false;
    if (!session.domContractPassed || !session.bundleSha256) return false;
    return this.adaptiveFullTranslationByBundle.get(`${session.bundleSha256}:${this.options.dictionary.version}`) === true;
  }
  private effectiveVerifiedStatus(){
    if(this.pages.size===0)return this.verifiedBundle();
    return [...this.pages.values()].every(s=>this.verifiedBundle(s));
  }
  private retry(delay?: number) {
    clearTimeout(this.reconnection);
    if (this.stopped) return;
    /* 显式传入延迟时（例如"版本未适配，30 秒后再试"）不要再去倍增基数，
       否则会把共享的 reconnectionDelay 顶到上限，污染断线重连路径。 */
    const wait = delay ?? this.reconnectionDelay;
    this.reconnection = setTimeout(() => {
        void this.tryConnect();
    }, wait);
    if (delay === undefined) this.reconnectionDelay = Math.min(30000, this.reconnectionDelay * 2);
  }
  private scheduleSync(delayMs = 100) {
    if (this.stopped) return;
    clearTimeout(this.targetTimer);
    this.targetTimer = setTimeout(() => void this.sync().catch(() => this.publish('error', this.t('status.probe_failed'))), delayMs);
  }
  private boot(url: string, session?: PageSession) {
    const page = new URL(url);
    const effectiveHudLocale = this.effectiveHudLocale();
    const languageMode = this.paused ? 'en' : (this.locale === 'zh-Hans' ? 'zh' : this.locale);
    const fullTranslation = this.shouldUseFullTranslation(session);
    const conservative = !fullTranslation;
    const key = `${page.origin}${page.pathname}:${this.options.dictionary.version}:${conservative}:${this.hudEnabled}:${this.paused}:${effectiveHudLocale}`;
    const cached = this.bootCache.get(key);
    if (cached) return cached;
    const source = `delete globalThis.__GRAVITYBOX_ATTACH_DEEP_SCAN__;delete globalThis.__GRAVITYBOX_ATTACH_HUD__;globalThis.__GRAVITYBOX_BOOT__=${JSON.stringify({ origin: page.origin, path: page.pathname, dictionary: this.options.dictionary, conservative,runtimeId:this.runtimeId,shortcutEnabled:this.options.shortcutEnabled!==false,hudEnabled:this.hudEnabled,translationEnabled:!this.paused,languageMode,locale:effectiveHudLocale,shellValidated:true })};\n${this.engine}`;
    if (this.bootCache.size < 16) this.bootCache.set(key, source);
    return source;
  }
  async sync() {
    if (this.syncing) { this.syncAgain = true; return; }
    if (!this.endpoint || !this.browser || this.stopped) return;
    this.syncing = true;
    try {
      const [response, targetInfosRes] = await Promise.all([
        fetch(`http://127.0.0.1:${this.endpoint.port}/json/list`, { signal: AbortSignal.timeout(2000), redirect: 'error' }),
        typeof this.browser.send === 'function'
          ? this.browser.send('Target.getTargets').catch(() => ({ targetInfos: [] }))
          : Promise.resolve({ targetInfos: [] }),
      ]);
      const targets = await response.json() as { id: string; type: string; url: string; webSocketDebuggerUrl: string }[];
      const browserContextByTargetId = new Map<string, string>();
      const rawTargetInfos = (targetInfosRes as { targetInfos?: Array<{ targetId?: string; browserContextId?: string }> })?.targetInfos;
      if (Array.isArray(rawTargetInfos)) {
        for (const info of rawTargetInfos) {
          if (typeof info?.targetId === 'string' && typeof info?.browserContextId === 'string' && info.browserContextId) {
            browserContextByTargetId.set(info.targetId, info.browserContextId);
          }
        }
      }

      const permitted = targets.filter(target => allowedTarget(target, this.options.fixture?.origin));
      const permittedIds = new Set(permitted.map(t => t.id));
      for (const pendingId of [...this.pendingRemoteTargets.keys()]) {
        if (!permittedIds.has(pendingId)) this.pendingRemoteTargets.delete(pendingId);
      }

      for (const [id, session] of this.pages) {
        const target = permitted.find(target => target.id === id);
        if (!target) {
          this.markRemoteSessionDisconnected(session);
          await this.detach(session);
          this.pages.delete(id);
        } else if (target.url !== session.url || (session.contextId === undefined && !session.detaching)) {
          try {
            if (target.url !== session.url) {
              let prevOrigin = '';
              let nextOrigin = '';
              try {
                prevOrigin = new URL(session.url).origin;
                nextOrigin = new URL(target.url).origin;
              } catch {}
              session.url = target.url;
              if (session.sourceKind === 'remote' && prevOrigin !== nextOrigin) {
                session.bundleSha256 = undefined;
                session.verifiedBundle = undefined;
                if (!this.options.verifyRemoteWindow) {
                  const recheck = await probeMainWorldSshRemote(session.cdp, 800);
                  if (!recheck.ready || recheck.kind !== 'ssh') {
                    this.markRemoteSessionDisconnected(session);
                    await this.detach(session);
                    this.pages.delete(id);
                    continue;
                  }
                }
                if (nextOrigin) this.hudBridge.updateTargetOrigin(id, nextOrigin);
                this.upsertConnectedRemoteSession(session);
              }
              if (!this.observeOnly) await this.refreshRegistration(session);
            }
            await this.queueBootstrap(session, false);
          } catch {
            this.markRemoteSessionDisconnected(session);
            await this.detach(session);
            this.pages.delete(id);
          }
        }
      }
      this.status.errors = [];
      const activeApp = this.activeAppPath();
      let hasPendingRemoteProbe = false;
      for (const target of permitted) if (!this.pages.has(target.id)) {
        if (this.stopped) break;
        let tempCdp: CDP | undefined;
        try {
          const browserContextId = browserContextByTargetId.get(target.id);
          let sourceKind: WindowSourceKind = 'local';
          let remoteKey: string | undefined;
          let hostLabel: string | undefined;
          let machineId: string | undefined;

          if (this.options.fixture) {
            sourceKind = 'local';
          } else {
            const serviceKind = await this.inspectPageState(target.url, activeApp);
            if (serviceKind === 'local') {
              sourceKind = 'local';
              if (browserContextId) this.localBrowserContextIds.add(browserContextId);
            } else if (serviceKind === 'foreign') {
              this.status.errors.push(this.t('controller.err.window_unverified'));
              continue;
            } else {
              if (!this.options.verifyRemoteWindow && !supportsSshRemoteBridge(this.endpoint.appVersion)) {
                this.status.errors.push(this.t('controller.err.window_unverified'));
                continue;
              }
              const socketURL = assertLoopback(target.webSocketDebuggerUrl);
              if (Number(socketURL.port) !== this.endpoint.port) throw new Error(this.t('controller.err.window_port_mismatch'));
              tempCdp = new CDP(socketURL.href);
              await tempCdp.connect();
              if (this.stopped) { tempCdp.close(); tempCdp = undefined; break; }
              const verification = await this.verifyRemoteWindowTarget({
                appVersion: this.endpoint.appVersion,
                antigravityPid: this.endpoint.pid,
                url: target.url,
                cdp: tempCdp,
                browserContextId,
              });
              if (verification.status === 'verified') {
                sourceKind = 'remote';
                remoteKey = verification.identity.remoteKey;
                hostLabel = cleanHostLabel(verification.identity.hostLabel) || verification.identity.hostLabel;
                machineId = verification.identity.machineId;
                this.pendingRemoteTargets.delete(target.id);
              } else {
                tempCdp.close();
                tempCdp = undefined;
                if (verification.status === 'pending') {
                  const tries = (this.pendingRemoteTargets.get(target.id) ?? 0) + 1;
                  this.pendingRemoteTargets.set(target.id, tries);
                  if (tries <= 30) {
                    hasPendingRemoteProbe = true;
                    continue;
                  }
                }
                this.pendingRemoteTargets.delete(target.id);
                this.status.errors.push(this.t('controller.err.window_unverified'));
                continue;
              }
            }
          }

          if (this.stopped) { tempCdp?.close(); break; }
          const socketURL = assertLoopback(target.webSocketDebuggerUrl);
          if (Number(socketURL.port) !== this.endpoint.port) { tempCdp?.close(); throw new Error(this.t('controller.err.window_port_mismatch')); }
          const cdp = tempCdp ?? new CDP(socketURL.href);
          if (!tempCdp) await cdp.connect();
          tempCdp = undefined;
          if (this.stopped) { cdp.close(); break; }
          const environmentId = sourceKind === 'remote'
            ? buildRemoteEnvironmentId(hostLabel || 'ssh-host')
            : 'local';
          const session: PageSession = {
            cdp,
            targetId: target.id,
            url: target.url,
            updateChain: Promise.resolve(),
            sourceKind,
            remoteKey,
            environmentId,
            machineId,
            hostLabel,
            browserContextId,
            lastFocusedAt: Date.now(),
          };
          if (sourceKind === 'remote') {
            session.rpcClient = new SshRemoteRpcClient({
              cdp,
              getContextId: () => session.contextId,
            });
            this.upsertConnectedRemoteSession(session);
          } else {
            this.localFocusedAt = Math.max(this.localFocusedAt, session.lastFocusedAt ?? 0);
          }
          let targetOrigin = '';
          try { targetOrigin = new URL(target.url).origin; } catch {}
          this.pages.set(target.id, session);
          cdp.on('disconnected', () => {this.hudBridge.detachTarget(target.id);if(!session.detaching&&this.pages.get(target.id)===session){this.pages.delete(target.id);this.markRemoteSessionDisconnected(session);this.scheduleSync();}});
          cdp.on('Page.frameNavigated', (event) => {
            if (!event.frame?.parentId) {
              this.hudBridge.detachTargetPanes(target.id);
              session.contextId = undefined;
              if (session.sourceKind === 'remote' && event.frame?.url) {
                try {
                  const nextOrigin = new URL(event.frame.url).origin;
                  if (nextOrigin && nextOrigin !== 'null') {
                    session.url = event.frame.url;
                    this.hudBridge.updateTargetOrigin(target.id, nextOrigin);
                  }
                } catch {}
              }
              void this.queueBootstrap(session).catch(() => this.scheduleSync(1500));
            }
          });
          cdp.on('Page.navigatedWithinDocument', () => this.scheduleSync());
          cdp.on('Runtime.executionContextsCleared', () => {
            this.hudBridge.detachTargetPanes(target.id);
            session.contextId = undefined;
            if (!session.detaching && !this.stopped) this.scheduleSync(300);
          });
          await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
          await cdp.send('Runtime.addBinding',{name:'__gravityboxLanguageChanged',executionContextName:WORLD});
          await cdp.send('Runtime.addBinding',{name:'__gravityboxWindowFocus',executionContextName:WORLD});
          if (!this.observeOnly) {
            await this.hudBridge.attachToTarget(target.id, cdp, () => session.contextId, WORLD, {
              sourceKind,
              ...(remoteKey ? { remoteKey } : {}),
              ...(hostLabel ? { hostLabel } : {}),
              ...(targetOrigin ? { origin: targetOrigin } : {}),
              ...(session.rpcClient ? { rpcClient: session.rpcClient } : {}),
            });
          }
          cdp.on('Runtime.bindingCalled',(event)=>{
            if(event.name==='__gravityboxLanguageChanged'&&event.executionContextId===session.contextId&&['zh','en'].includes(event.payload)){
              session.languageMode=event.payload;this.publish();if(this.hudEnabled){void this.hudBridge.refreshAllForLocaleChange();}
            }else if(event.name==='__gravityboxWindowFocus'&&event.executionContextId===session.contextId){
              const focusTs = Date.now();
              const prevFocusedEnv = this.getFocusedEnvironmentId();
              const prevFocusedCtx = this.getFocusedContextKey();
              session.lastFocusedAt = focusTs;
              if (session.sourceKind === 'remote' && session.remoteKey) {
                const entry = this.remoteSessions.get(session.remoteKey);
                if (entry) {
                  entry.lastFocusedAt = focusTs;
                  this.remoteObservedVersion++;
                }
              } else if (session.sourceKind !== 'remote') {
                this.localFocusedAt = focusTs;
              }
              const nextFocusedEnv = this.getFocusedEnvironmentId();
              const nextFocusedCtx = this.getFocusedContextKey();
              if (nextFocusedEnv !== prevFocusedEnv || nextFocusedCtx !== prevFocusedCtx) {
                this.remoteObservedVersion++;
                this.scheduleFocusPublish(true);
              } else {
                this.scheduleFocusPublish(false);
              }
            }else if(event.name===HUD_BRIDGE_BINDING_NAME&&this.hudEnabled&&event.executionContextId===session.contextId){
              this.hudBridge.handleRawBindingPayload(target.id,event.payload);
            }
          });
          if (!this.observeOnly) await this.refreshRegistration(session);
          await this.queueBootstrap(session, false);
        } catch(error) {
          tempCdp?.close();
          const failed = this.pages.get(target.id); if (failed) { await this.detach(failed); this.pages.delete(target.id); }
          this.status.errors.push((error as Error).message === this.t('controller.err.unrecognized_structure') ? (error as Error).message : this.t('controller.err.window_inject_failed'));
        }
      }
      const hasUnreadyPage = [...this.pages.values()].some(session => !session.detaching && session.contextId === undefined);
      if (!this.stopped && hasPendingRemoteProbe) {
        if (this.sshProbeRetries < 30) {
          this.sshProbeRetries++;
          this.scheduleSync(300);
        }
      } else {
        this.sshProbeRetries = 0;
      }
      if (!this.stopped && !hasPendingRemoteProbe && permitted.length > 0 && (this.pages.size < permitted.length || hasUnreadyPage)) {
        if (this.unverifiedWindowRetries < 20) {
          this.unverifiedWindowRetries++;
          this.scheduleSync(1500);
        }
      } else if (!hasPendingRemoteProbe) {
        this.unverifiedWindowRetries = 0;
      }
      const isVerified = this.effectiveVerifiedStatus();
      const defaultMode = this.paused
        ? 'paused'
        : this.pages.size
          ? (isVerified ? 'connected' : 'adaptive')
          : 'waiting-window';
      const defaultMsg = this.paused
        ? this.t('status.paused')
        : this.pages.size
          ? (isVerified
              ? this.t('status.connected_watch')
              : (this.status.newStringsCount
                  ? this.t('status.connected_adaptive_new', { version: this.endpoint?.appVersion ?? '', count: this.status.newStringsCount })
                  : this.t('status.connected_adaptive', { version: this.endpoint?.appVersion ?? '' })))
          : this.t('status.waiting_supported_window');
      this.publish(defaultMode, defaultMsg);

      const localSession = [...this.pages.values()].find(s => s.sourceKind !== 'remote');
      if (!this.options.fixture && !this.observeOnly && this.endpoint && localSession && !this.inspectingBundle && (this.lastInspectedAppVersion !== this.endpoint.appVersion || this.lastInspectedSha !== localSession.bundleSha256 || this.lastInspectedDictVersion !== this.options.dictionary.version)) {
        try {
          const origin = new URL(localSession.url).origin;
          void this.inspectBundleInBackground(origin, this.endpoint.appVersion,this.initialBundle);this.initialBundle=undefined;
        } catch {}
      }
      } finally {
      this.initialBundle=undefined;
      this.syncing = false;
      for (const resolve of this.syncWaiters.splice(0)) resolve();
      if (this.syncAgain) { this.syncAgain = false; this.scheduleSync(); }
    }
  }
  private async installObserveFocusListener(session: PageSession): Promise<void> {
    if (session.contextId === undefined || session.detaching || this.stopped) return;
    await session.cdp.evaluate(
      `(() => {
        if (globalThis.__GRAVITYBOX_OBS_FOCUS__) return;
        globalThis.__GRAVITYBOX_OBS_FOCUS__ = true;
        const report = () => {
          try {
            if (typeof document !== 'undefined' && document.hidden) return;
            if (typeof globalThis.__gravityboxWindowFocus === 'function') {
              globalThis.__gravityboxWindowFocus(String(Date.now()));
            }
          } catch {}
        };
        if (typeof window !== 'undefined') window.addEventListener('focus', report, true);
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => {
          if (typeof document === 'undefined' || !document.hidden) report();
        }, true);
      })()`,
      session.contextId
    ).catch(() => {});
  }
  private queueBootstrap(session: PageSession, reportUnhandledError = true): Promise<void> {
    if(session.detaching)return Promise.resolve();
    session.updateChain = session.updateChain.catch(() => {}).then(async () => {
      if (this.stopped || session.detaching || this.pages.get(session.targetId)!==session) return;
      const tree = await session.cdp.send('Page.getFrameTree');
      const frame = tree.frameTree.frame;
      if (!allowedTarget({ type: 'page', url: frame.url }, this.options.fixture?.origin)) return;
      const isRemote = session.sourceKind === 'remote';
      if (this.observeOnly) {
        if (!this.options.fixture && this.endpoint && !isRemote) {
          const activeApp = this.activeAppPath();
          if (!await this.checkPageService(frame.url, activeApp)) throw new Error(this.t('controller.err.page_unverified'));
        }
        session.url = frame.url;
        if (session.contextId === undefined) {
          const context = await session.cdp.send('Page.createIsolatedWorld', { frameId: frame.id, worldName: WORLD });
          session.contextId = context.executionContextId;
        }
        await this.installObserveFocusListener(session);
        session.languageMode = 'en';
        return;
      }
      if(!this.options.fixture&&this.endpoint&&!isRemote){
        const activeApp = this.activeAppPath();
        if(!await this.checkPageService(frame.url,activeApp))throw new Error(this.t('controller.err.page_unverified'));
        const bundle=await this.bundleCache.read(activeApp,this.endpoint.pid,this.endpoint.appVersion,new URL(frame.url).origin,undefined,'local');
        session.bundleSha256=bundle.hash;session.verifiedBundle=isSupportedBundleHash(this.endpoint.appVersion,bundle.hash);
        this.status.bundleSha256=bundle.hash;this.status.bundleCacheHit=bundle.cacheHit;this.status.unverifiedVersion=!this.effectiveVerifiedStatus();
        if(bundle.source)this.initialBundle=bundle.source;
      }

      session.url = frame.url;
      let previous: any;
      if (session.contextId !== undefined) {
        try {
          previous = await session.cdp.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__?.state()', session.contextId);
        } catch {
          session.contextId = undefined;
        }
      }
      if (session.contextId === undefined || !previous?.active) {
        const context = await session.cdp.send('Page.createIsolatedWorld', { frameId: frame.id, worldName: WORLD });
        session.contextId = context.executionContextId;
      }
      if(!this.options.fixture&&this.endpoint&&isRemote){
        const activeApp = this.activeAppPath();
        const bundle=await this.bundleCache.read(
          activeApp,
          this.endpoint.pid,
          this.endpoint.appVersion,
          new URL(frame.url).origin,
          () => fetchRemoteBundleHashViaCdp(session.cdp, session.contextId!),
          session.remoteKey ?? 'remote'
        );
        session.bundleSha256=bundle.hash;
        session.verifiedBundle=isSupportedBundleHash(this.endpoint.appVersion,bundle.hash);
        this.status.bundleCacheHit=bundle.cacheHit;
        this.status.unverifiedVersion=!this.effectiveVerifiedStatus();
      }
      const sessionVerified = this.verifiedBundle(session);
      if(!sessionVerified){
        if(/^\/(?:onboarding|oauth|auth|login|sign-in)(?:\/|$)/i.test(new URL(frame.url).pathname))throw new Error(this.t('controller.err.onboarding_skipped'));
        const contract=await session.cdp.evaluate(`(async()=>{for(let i=0;i<30;i++){if(!!document.body&&((!!document.querySelector('[aria-label*="Sidebar" i],[aria-label*="侧边栏"],[data-testid*="sidebar" i],[data-testid="agent-input-box"]')&&!!document.querySelector('[data-testid="model-selector-trigger"],a[href="/history"],a[href="/customizations"],[data-testid="agent-input-box"],textarea,input'))||(/^\\/(?:settings(?:\\/[^?#]*)?|settings-standalone)$/.test(location.pathname)&&!!document.querySelector('[role="dialog"][aria-label="Settings"],[role="dialog"][aria-label="设置"],[data-testid*="settings"]')&&!!document.querySelector('[role="tablist"],nav,[role="navigation"]'))||(location.pathname==='/terminal-standalone'&&!!document.querySelector('.xterm,.monaco-editor,[data-testid*="terminal"]'))))return true;await new Promise(r=>setTimeout(r,100));}return false;})()`,session.contextId);
        if(!contract)throw new Error(this.t('controller.err.unrecognized_structure'));
        session.domContractPassed = true;
      }
      const desiredFullTranslation = this.shouldUseFullTranslation(session);
      const desiredConservative = !desiredFullTranslation;
      if (
        (session.registeredVerifiedBundle !== undefined && session.registeredVerifiedBundle !== sessionVerified) ||
        (session.registeredFullTranslation !== undefined && session.registeredFullTranslation !== desiredFullTranslation)
      ) {
        await this.applyDocumentRegistration(session);
      }
      if(this.dormant||this.stopped||session.detaching)return;
      if (!previous?.active) previous = await session.cdp.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__?.state()', session.contextId);
      if(this.dormant||this.stopped||session.detaching)return;
      const preservedManualEn = !this.paused && session.languageMode === 'en';
      const conservativeModeChanged = session.bootedConservative !== undefined && session.bootedConservative !== desiredConservative;
      if (previous?.active&&previous.runtimeId===this.runtimeId&&!conservativeModeChanged) {
        if (previous.version === this.options.dictionary.version) await session.cdp.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.refresh()', session.contextId);
        else await session.cdp.evaluate(`globalThis.__GRAVITYBOX_ENGINE_V1__.update(${JSON.stringify(this.options.dictionary)})`, session.contextId);
        const desiredLanguageMode = this.paused ? 'en' : preservedManualEn ? 'en' : (this.locale === 'zh-Hans' ? 'zh' : 'en');
        if (!this.paused && !this.options.fixture && previous.languageMode && previous.languageMode !== desiredLanguageMode) {
          await session.cdp.evaluate(`globalThis.__GRAVITYBOX_ENGINE_V1__?.toggleLanguage?.(${JSON.stringify(desiredLanguageMode)})`, session.contextId);
        }
      }
      else{if(previous?.active)await session.cdp.evaluate(this.hudEnabled?'globalThis.__GRAVITYBOX_ENGINE_V1__?.dispose?.({keepHud:true})':'(globalThis.__GRAVITYBOX_ENGINE_V1__?.dispose?.(),globalThis.__GRAVITYBOX_HUD_V1__?.dispose?.())',session.contextId);await session.cdp.evaluate(this.boot(session.url,session),session.contextId);session.bootedConservative=desiredConservative;if((this.options.fixture||preservedManualEn)&&!this.paused&&(previous?.languageMode==='en'||preservedManualEn))await session.cdp.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__?.toggleLanguage?.("en")',session.contextId);}
      if (session.bootedConservative === undefined) session.bootedConservative = desiredConservative;
      let state: any;
      for (let i = 0; i < 10; i++) {
        state = await session.cdp.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__?.state()', session.contextId);
        if (state?.version === this.options.dictionary.version) break;
        await new Promise(r => setTimeout(r, 100));
      }
      if (state?.version !== this.options.dictionary.version) throw new Error(this.t('controller.err.dict_version_unconfirmed'));
      session.languageMode=state.languageMode??'zh';
      const effectiveHudLocale = !this.paused && session.languageMode === 'en' ? 'en' : this.effectiveHudLocale();
      if (this.hudEnabled) {
        await session.cdp.evaluate(`(globalThis.__GRAVITYBOX_ATTACH_HUD__?.(), globalThis.__GRAVITYBOX_HUD_V1__?.setLanguage?.(${JSON.stringify(effectiveHudLocale)}), globalThis.__GRAVITYBOX_HUD_V1__?.setEnabled?.(true), globalThis.__GRAVITYBOX_HUD_V1__?.syncAllSessions?.())`, session.contextId).catch(() => {});
      } else {
        await session.cdp.evaluate('globalThis.__GRAVITYBOX_HUD_V1__?.setEnabled?.(false)', session.contextId).catch(() => {});
      }
    });
    if (reportUnhandledError) {
      session.updateChain.catch(() => {
        if (!this.status.errors.includes(this.t('controller.err.window_connect_failed'))) this.status.errors.push(this.t('controller.err.window_connect_failed'));
        this.publish();
      });
    }
    return session.updateChain;
  }
  private async applyDocumentRegistration(session: PageSession): Promise<void> {
    if(session.detaching||this.dormant||this.stopped)return;
    if(session.registration){await session.cdp.send('Page.removeScriptToEvaluateOnNewDocument',{identifier:session.registration});session.registration=undefined;}
    if(session.detaching||this.dormant||this.stopped)return;
    const registered=await session.cdp.send('Page.addScriptToEvaluateOnNewDocument',{source:this.boot(session.url,session),worldName:WORLD});
    if(session.detaching||this.dormant||this.stopped){await session.cdp.send('Page.removeScriptToEvaluateOnNewDocument',{identifier:registered.identifier});return;}
    session.registration=registered.identifier;
    session.registeredVerifiedBundle=this.verifiedBundle(session);
    session.registeredFullTranslation=this.shouldUseFullTranslation(session);
  }
  private refreshRegistration(session: PageSession):Promise<void> {
    if(session.detaching)return Promise.resolve();
    session.updateChain=session.updateChain.catch(()=>{}).then(()=>this.applyDocumentRegistration(session));
    return session.updateChain;
  }
  /** 后台异步对比界面包指纹，提取界面串并检测未译新词，不阻塞前台窗口注入与翻译。 */
  private async inspectBundleInBackground(origin: string, appVersion: string,initialSource?:string): Promise<void> {
    if (this.inspectingBundle || this.stopped) return;
    this.inspectingBundle = true;
    try {
      const source = initialSource??await fetchBundleFromOrigin(origin, 8000);
      const sha = computeBundleSha256(source);
      this.status.bundleSha256 = sha;
      this.lastInspectedAppVersion = appVersion;
      if (this.lastInspectedSha === sha && this.lastInspectedDictVersion === this.options.dictionary.version) return;
      this.lastInspectedSha = sha;

      const extracted =
        this.lastInspectedBundle?.sha === sha
          ? this.lastInspectedBundle.extracted
          : extractUiStrings(source, { includeJsxRuntime: true });
      this.lastInspectedBundle = { sha, extracted };
      this.lastInspectedDictVersion = this.options.dictionary.version;
      const bundleCoverage = computeBundleDictionaryCoverage(extracted, this.options.dictionary);
      const missing = bundleCoverage.missing;
      const highConfidenceAdaptive =
        bundleCoverage.total >= ADAPTIVE_FULL_TRANSLATION_MIN_STRINGS &&
        bundleCoverage.coverage >= ADAPTIVE_FULL_TRANSLATION_MIN_COVERAGE;
      this.adaptiveFullTranslationByBundle.set(`${sha}:${this.options.dictionary.version}`, highConfidenceAdaptive);
      this.trustedCandidates = missing.filter(isSafeCandidate).map(key=>({key,kind:extractedKind(extracted.find(e=>e.text===key)?.kinds),source:'static'}));
      this.status.newStringsCount = this.trustedCandidates.length;

      if (this.options.stateDir) {
        const reportsDir = join(this.options.stateDir, 'reports');
        await mkdir(reportsDir, { recursive: true });
        if (!this.verifiedBundle()) {
          const byKind: Record<string, number> = {};
          for (const entry of extracted) for (const kind of entry.kinds) byKind[kind] = (byKind[kind] ?? 0) + 1;
          await atomicJson(join(reportsDir, `ui-strings-${appVersion}.json`), {
            schema: 1,
            appVersion,
            source: 'runtime-loopback',
            bundleSha256: sha,
            bundleBytes: Buffer.byteLength(source),
            extractedAt: new Date().toISOString(),
            counts: { total: extracted.length, ...byKind },
            strings: extracted,
          }).catch(() => {});
        }
        if (this.trustedCandidates.length > 0) {
          const pendingPath = join(reportsDir, `pending-${appVersion}.json`);
          const pendingPayload = createPendingList(appVersion, sha, this.trustedCandidates.map(e=>e.key));
          await atomicJson(pendingPath, pendingPayload);
          this.status.pendingListPath = pendingPath;
        }
      }

      if (this.stopped || this.paused) return;
      const isVerified = this.verifiedBundle();
      if (!isVerified && highConfidenceAdaptive && !this.dormant) {
        const upgradeTargets = [...this.pages.values()].filter(
          (s) => !s.detaching && s.sourceKind !== 'remote' && s.bundleSha256 === sha && s.domContractPassed && s.bootedConservative === true
        );
        if (upgradeTargets.length > 0) {
          this.bootCache.clear();
          await Promise.allSettled(
            upgradeTargets.map(async (session) => {
              await this.refreshRegistration(session);
              await this.queueBootstrap(session, false);
            })
          );
        }
      }
      const candidateCount = this.trustedCandidates.length;
      if (!isVerified) {
        const msg = candidateCount > 0
          ? this.t('status.adaptive_candidates', { version: appVersion, count: candidateCount })
          : this.t('status.adaptive_matched', { version: appVersion });
        this.publish('adaptive', msg);
      } else if (candidateCount > 0) {
        this.publish('connected', this.t('status.connected_candidates', { count: candidateCount }));
      }
    } catch {
      // 后台探测异常不影响前台窗口注入与翻译
    } finally {
      this.inspectingBundle = false;
    }
  }
  update(dictionary: Dictionary): Promise<void> {
    return this.enqueueControl(() => this.applyDictionary(dictionary));
  }
  private async applyDictionary(dictionary: Dictionary) {
    this.options.dictionary = dictionary;
    if (this.lastInspectedBundle) {
      const bundleCoverage = computeBundleDictionaryCoverage(this.lastInspectedBundle.extracted, dictionary);
      const highConfidenceAdaptive =
        bundleCoverage.total >= ADAPTIVE_FULL_TRANSLATION_MIN_STRINGS &&
        bundleCoverage.coverage >= ADAPTIVE_FULL_TRANSLATION_MIN_COVERAGE;
      this.adaptiveFullTranslationByBundle.set(`${this.lastInspectedBundle.sha}:${dictionary.version}`, highConfidenceAdaptive);
      this.lastInspectedDictVersion = dictionary.version;
    }
    this.bootCache.clear();
    this.status.dictionaryVersion = dictionary.version; this.status.entries = Object.keys(dictionary.entries).length;
    this.status.errors = [];
    const results = await Promise.allSettled([...this.pages.values()].map(async session => {
      await this.refreshRegistration(session);
      await this.queueBootstrap(session);
    }));
    if (results.some(result => result.status === 'rejected')) this.status.errors.push(this.t('controller.err.partial_dict_update'));
    this.publish();
  }
  dictionaryError(message?: string) { this.status.dictionaryError = message; this.publish(); }
  private upsertConnectedRemoteSession(session: PageSession): void {
    if (session.sourceKind !== 'remote' || !session.remoteKey) return;
    let origin = '';
    try { origin = new URL(session.url).origin; } catch {}
    const hostLabel = cleanHostLabel(session.hostLabel) || session.hostLabel || 'ssh-host';
    const environmentId = session.environmentId || buildRemoteEnvironmentId(hostLabel);
    session.hostLabel = hostLabel;
    session.environmentId = environmentId;

    const existing = this.remoteSessions.get(session.remoteKey);
    if (existing) {
      const originChanged = Boolean(origin && existing.origin && existing.origin !== origin);
      const changed =
        existing.state === 'disconnected' ||
        existing.targetId !== session.targetId ||
        originChanged;
      existing.targetId = session.targetId;
      existing.hostLabel = hostLabel;
      existing.environmentId = environmentId;
      if (session.machineId) existing.machineId = session.machineId;
      if (origin) existing.origin = origin;
      if (existing.state === 'disconnected' || originChanged) {
        existing.state = 'connected';
        existing.disconnectedAt = null;
        existing.lastError = '';
        existing.needsIdentityVerify = true;
      }
      existing.lastFocusedAt = Math.max(existing.lastFocusedAt, session.lastFocusedAt ?? 0);
      if (changed) this.remoteObservedVersion++;
      return;
    }

    // Reconnected under a new dynamic port (different remoteKey, same environmentId):
    // retire stale disconnected entries for this environmentId and flag identity re-verification.
    let inheritedFocus = session.lastFocusedAt ?? Date.now();
    let reconnectedFromOffline = false;
    for (const [prevKey, prevEntry] of this.remoteSessions.entries()) {
      if (prevEntry.environmentId === environmentId && prevEntry.state === 'disconnected') {
        inheritedFocus = Math.max(inheritedFocus, prevEntry.lastFocusedAt);
        reconnectedFromOffline = true;
        this.remoteSessions.delete(prevKey);
      }
    }

    this.remoteSessions.set(session.remoteKey, {
      remoteKey: session.remoteKey,
      environmentId,
      ...(session.machineId ? { machineId: session.machineId } : {}),
      hostLabel,
      targetId: session.targetId,
      origin,
      state: 'connected',
      probing: true,
      email: '',
      name: null,
      tier: '',
      accountType: 'unknown',
      matchedLocalAccountId: null,
      quota: null,
      quotaOverview: null,
      observedAt: null,
      lastIdentityVerifiedAt: null,
      needsIdentityVerify: reconnectedFromOffline,
      disconnectedAt: null,
      lastError: '',
      lastFocusedAt: inheritedFocus,
    });
    this.remoteObservedVersion++;
  }

  private markRemoteSessionDisconnected(session: PageSession, nowMs = Date.now()): void {
    if (session.sourceKind !== 'remote' || !session.remoteKey) return;
    const replacement = [...this.pages.values()].find(
      p => p !== session && !p.detaching && p.sourceKind === 'remote' && p.remoteKey === session.remoteKey
    );
    const entry = this.remoteSessions.get(session.remoteKey);
    if (!entry) return;
    if (replacement) {
      entry.targetId = replacement.targetId;
      entry.hostLabel = cleanHostLabel(replacement.hostLabel) || entry.hostLabel;
      try {
        const nextOrigin = new URL(replacement.url).origin;
        if (nextOrigin) entry.origin = nextOrigin;
      } catch {}
      this.remoteObservedVersion++;
      return;
    }
    if (entry.state !== 'disconnected') {
      entry.state = 'disconnected';
      entry.probing = false;
      entry.disconnectedAt = nowMs;
      this.remoteObservedVersion++;
    }
  }

  private pruneExpiredRemoteSessions(nowMs = Date.now()): void {
    for (const [key, entry] of this.remoteSessions.entries()) {
      if (entry.state !== 'disconnected' || entry.disconnectedAt === null) continue;
      const stillOpen = [...this.pages.values()].some(
        p => !p.detaching && p.sourceKind === 'remote' && p.remoteKey === key
      );
      if (stillOpen) continue;
      if (nowMs - entry.disconnectedAt >= this.REMOTE_DISCONNECTED_RETENTION_MS) {
        this.remoteSessions.delete(key);
        this.remoteObservedVersion++;
      }
    }
  }

  public getEnvironmentWindowCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    counts.set('local', 0);
    for (const session of this.pages.values()) {
      if (session.detaching) continue;
      if (session.sourceKind === 'remote') {
        const host = cleanHostLabel(session.hostLabel) || session.hostLabel || 'ssh-host';
        const envId = session.environmentId || buildRemoteEnvironmentId(host);
        counts.set(envId, (counts.get(envId) ?? 0) + 1);
      } else {
        counts.set('local', (counts.get('local') ?? 0) + 1);
      }
    }
    return counts;
  }

  public getLocalWindowsCount(): number {
    return this.getEnvironmentWindowCounts().get('local') ?? 0;
  }

  public getLocalFocusedAt(): number {
    let localFocus = this.localFocusedAt;
    for (const session of this.pages.values()) {
      if (!session.detaching && session.sourceKind !== 'remote') {
        localFocus = Math.max(localFocus, session.lastFocusedAt ?? 0);
      }
    }
    return localFocus;
  }

  public getRemoteObservedVersion(): number {
    return this.remoteObservedVersion;
  }

  public getActiveSshWindowsSummary(): { count: number; hosts: string[] } {
    const remotePages = [...this.pages.values()].filter(p => !p.detaching && p.sourceKind === 'remote');
    const hosts = [...new Set(remotePages.map(p => cleanHostLabel(p.hostLabel) || (p.hostLabel || '').trim()).filter(Boolean))];
    return { count: remotePages.length, hosts };
  }

  private pickFocusedRemoteEntry(): (RemoteSessionState & { lastFocusedAt: number }) | null {
    const localFocus = this.getLocalFocusedAt();
    let bestRemote: (RemoteSessionState & { lastFocusedAt: number }) | null = null;
    for (const entry of this.remoteSessions.values()) {
      if (entry.state === 'disconnected') continue;
      const livePages = [...this.pages.values()].filter(
        p => !p.detaching && p.sourceKind === 'remote' && (p.remoteKey === entry.remoteKey || p.targetId === entry.targetId)
      );
      if (livePages.length === 0) continue;
      const pageMaxFocus = Math.max(...livePages.map(p => p.lastFocusedAt ?? 0));
      const entryFocus = Math.max(entry.lastFocusedAt, pageMaxFocus);
      if (!bestRemote || entryFocus > bestRemote.lastFocusedAt) {
        bestRemote = { ...entry, lastFocusedAt: entryFocus };
      }
    }
    if (bestRemote && bestRemote.lastFocusedAt > localFocus) {
      return bestRemote;
    }
    return null;
  }

  public getFocusedEnvironmentId(): string {
    const best = this.pickFocusedRemoteEntry();
    return best ? best.environmentId : 'local';
  }

  public getFocusedContextKey(): string {
    const best = this.pickFocusedRemoteEntry();
    if (best) {
      return `remote:${best.remoteKey}`;
    }
    return 'local';
  }

  public getRemoteSessionsSnapshot(nowMs = Date.now()): RemoteSessionState[] {
    this.pruneExpiredRemoteSessions(nowMs);
    const windowCounts = this.getEnvironmentWindowCounts();
    return [...this.remoteSessions.values()]
      .map(entry => ({
        ...entry,
        windowCount: entry.state === 'disconnected' ? 0 : (windowCounts.get(entry.environmentId) ?? 0),
      }))
      .sort((a, b) => {
        const aConn = a.state === 'disconnected' ? 0 : 1;
        const bConn = b.state === 'disconnected' ? 0 : 1;
        if (aConn !== bConn) return bConn - aConn;
        return b.lastFocusedAt - a.lastFocusedAt;
      });
  }

  public getConnectedRemoteRpcTargets(): ConnectedRemoteRpcTarget[] {
    const windowCounts = this.getEnvironmentWindowCounts();
    const bestByEnvId = new Map<
      string,
      {
        session: PageSession;
        entry?: RemoteSessionState;
        rpcClient: RemoteRpcClientLike;
        hasContext: number;
        healthyAuth: number;
        lastFocusedAt: number;
      }
    >();

    for (const session of this.pages.values()) {
      if (session.detaching || session.sourceKind !== 'remote' || !session.remoteKey || !session.rpcClient) {
        continue;
      }
      const entry = this.remoteSessions.get(session.remoteKey);
      if (entry?.state === 'disconnected') continue;
      const hostLabel = cleanHostLabel(entry?.hostLabel || session.hostLabel || 'ssh-host') || 'ssh-host';
      const environmentId = session.environmentId || entry?.environmentId || buildRemoteEnvironmentId(hostLabel);
      const hasContext = session.contextId !== undefined ? 1 : 0;
      const healthyAuth = entry?.state !== 'auth_expired' ? 1 : 0;
      const lastFocusedAt = Math.max(entry?.lastFocusedAt ?? 0, session.lastFocusedAt ?? 0);
      const existing = bestByEnvId.get(environmentId);
      const shouldReplace =
        !existing ||
        hasContext > existing.hasContext ||
        (hasContext === existing.hasContext && healthyAuth > existing.healthyAuth) ||
        (hasContext === existing.hasContext && healthyAuth === existing.healthyAuth && lastFocusedAt > existing.lastFocusedAt);
      if (shouldReplace) {
        bestByEnvId.set(environmentId, {
          session,
          entry,
          rpcClient: session.rpcClient,
          hasContext,
          healthyAuth,
          lastFocusedAt,
        });
      }
    }

    const targets: Array<{ target: ConnectedRemoteRpcTarget; lastFocusedAt: number }> = [];
    for (const [environmentId, picked] of bestByEnvId.entries()) {
      const { session, entry, rpcClient, lastFocusedAt } = picked;
      let origin = entry?.origin ?? '';
      if (!origin) {
        try {
          origin = new URL(session.url).origin;
        } catch {
          origin = '';
        }
      }
      const hostLabel = cleanHostLabel(entry?.hostLabel || session.hostLabel || 'ssh-host') || 'ssh-host';
      targets.push({
        lastFocusedAt,
        target: {
          remoteKey: session.remoteKey!,
          hostLabel,
          environmentId,
          origin,
          rpcClient,
          email: entry?.email ?? '',
          name: entry?.name ?? null,
          accountType: entry?.accountType ?? 'unknown',
          matchedLocalAccountId: entry?.matchedLocalAccountId ?? null,
          state: entry?.state ?? 'connected',
          windowCount: windowCounts.get(environmentId) ?? 1,
          lastIdentityVerifiedAt: entry?.lastIdentityVerifiedAt ?? entry?.observedAt ?? 0,
          reconnected: Boolean(entry?.needsIdentityVerify),
        },
      });
    }

    targets.sort((a, b) => b.lastFocusedAt - a.lastFocusedAt);
    return targets.map(item => item.target);
  }

  public applyObservedRemoteIdentity(params: {
    environmentId: string;
    remoteKey?: string;
    live: LiveLanguageServerStatus;
    observedAtMs?: number;
    matchAccountId?: (email: string) => string | null;
    getQuotaOverview?: (quota: QuotaData, nowMs: number) => any;
  }): boolean {
    const observedAtMs = params.observedAtMs ?? Date.now();
    let updated = false;
    for (const entry of this.remoteSessions.values()) {
      if (entry.state === 'disconnected') continue;
      if (entry.environmentId !== params.environmentId && (!params.remoteKey || entry.remoteKey !== params.remoteKey)) {
        continue;
      }
      entry.state = 'connected';
      entry.probing = false;
      entry.disconnectedAt = null;
      entry.lastError = '';
      entry.email = params.live.email;
      entry.name = params.live.name ?? null;
      entry.tier = params.live.tier || '';
      entry.accountType = params.live.accountType ?? 'unknown';
      entry.quota = params.live.quota ?? entry.quota;
      entry.observedAt = observedAtMs;
      entry.lastIdentityVerifiedAt = observedAtMs;
      entry.needsIdentityVerify = false;
      if (params.matchAccountId) {
        entry.matchedLocalAccountId = params.matchAccountId(entry.email);
      }
      if (entry.quota && params.getQuotaOverview) {
        entry.quotaOverview = params.getQuotaOverview(entry.quota, observedAtMs);
      }
      updated = true;
    }
    if (updated) {
      this.remoteObservedVersion++;
    }
    return updated;
  }

  public async probeRemoteSessions(options?: {
    force?: boolean;
    remoteKey?: string;
    environmentId?: string;
    nowMs?: number;
    matchAccountId?: (email: string) => string | null;
    getQuotaOverview?: (quota: QuotaData, nowMs: number) => any;
  }): Promise<RemoteSessionState[]> {
    const nowMs = options?.nowMs ?? Date.now();
    this.pruneExpiredRemoteSessions(nowMs);
    for (const session of this.pages.values()) {
      if (!session.detaching && session.sourceKind === 'remote') {
        this.upsertConnectedRemoteSession(session);
      }
    }

    const candidates = [...this.remoteSessions.values()].filter(entry => {
      if (options?.remoteKey && entry.remoteKey !== options.remoteKey) return false;
      if (options?.environmentId && entry.environmentId !== options.environmentId) return false;
      return entry.state !== 'disconnected';
    });

    await Promise.all(
      candidates.map(async entry => {
        const livePage = [...this.pages.values()]
          .filter(
            p =>
              !p.detaching &&
              p.sourceKind === 'remote' &&
              (p.remoteKey === entry.remoteKey || p.environmentId === entry.environmentId)
          )
          .sort(
            (a, b) =>
              (b.contextId !== undefined ? 1 : 0) - (a.contextId !== undefined ? 1 : 0) ||
              (b.lastFocusedAt ?? 0) - (a.lastFocusedAt ?? 0)
          )[0];
        if (!livePage?.rpcClient) {
          return;
        }
        const cacheFresh =
          !options?.force &&
          entry.state === 'connected' &&
          !entry.probing &&
          Boolean(entry.email) &&
          entry.observedAt !== null &&
          nowMs - entry.observedAt < this.REMOTE_SESSION_CACHE_TTL_MS;
        if (cacheFresh) {
          if (entry.email && options?.matchAccountId) {
            entry.matchedLocalAccountId = options.matchAccountId(entry.email);
          }
          if (entry.quota && options?.getQuotaOverview) {
            entry.quotaOverview = options.getQuotaOverview(entry.quota, nowMs);
          }
          return;
        }

        const existingInFlight = this.remoteProbeInFlight.get(entry.remoteKey);
        if (existingInFlight) {
          await existingInFlight;
          return;
        }

        const probeTask = (async () => {
          try {
            const probeNowMs = options?.nowMs ?? Date.now();
            const res = await livePage.rpcClient!.probeUserAndQuota();
            const current = this.remoteSessions.get(entry.remoteKey);
            if (!current) return;
            if (res.ok) {
              current.state = 'connected';
              current.probing = false;
              current.disconnectedAt = null;
              current.lastError = '';
              current.email = res.data.email;
              current.name = res.data.name ?? null;
              current.tier = res.data.tier || '';
              current.accountType = res.data.accountType ?? 'unknown';
              current.quota = mergeLiveQuotaWithSaved(current.quota, res.data.quota, probeNowMs) ?? res.data.quota ?? null;
              current.observedAt = probeNowMs;
              current.lastIdentityVerifiedAt = probeNowMs;
              current.needsIdentityVerify = false;
              current.matchedLocalAccountId = options?.matchAccountId
                ? options.matchAccountId(current.email)
                : current.matchedLocalAccountId;
              current.quotaOverview = current.quota && options?.getQuotaOverview
                ? options.getQuotaOverview(current.quota, probeNowMs)
                : current.quotaOverview;
              this.remoteObservedVersion++;
              return;
            }
            if (res.authExpired) {
              current.state = 'auth_expired';
              current.probing = false;
              current.lastError = 'auth_expired';
              this.remoteObservedVersion++;
            } else if (res.reason !== 'context_unavailable') {
              current.probing = false;
              current.lastError = res.reason || 'rpc_error';
              this.remoteObservedVersion++;
            }
          } catch {
            const current = this.remoteSessions.get(entry.remoteKey);
            if (current) {
              current.probing = false;
              current.lastError = 'rpc_error';
              this.remoteObservedVersion++;
            }
          }
        })().finally(() => {
          const current = this.remoteSessions.get(entry.remoteKey);
          if (current && current.probing && current.lastError) {
            current.probing = false;
          }
          this.remoteProbeInFlight.delete(entry.remoteKey);
        });

        this.remoteProbeInFlight.set(entry.remoteKey, probeTask);
        await probeTask;
      })
    );

    if (options?.matchAccountId || options?.getQuotaOverview) {
      for (const entry of this.remoteSessions.values()) {
        if (entry.email && options?.matchAccountId) {
          entry.matchedLocalAccountId = options.matchAccountId(entry.email);
        }
        if (entry.quota && options?.getQuotaOverview) {
          entry.quotaOverview = options.getQuotaOverview(entry.quota, nowMs);
        }
      }
    }

    return this.getRemoteSessionsSnapshot(nowMs);
  }

  private async detach(session: PageSession) {
    session.detaching=true;
    this.hudBridge.detachTarget(session.targetId);
    let restorationFailed = false;
    try {
      await session.updateChain.catch(() => {});
      if (session.registration) await session.cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: session.registration });
      let ctxId = session.contextId;
      if (ctxId === undefined) {
        const tree = await session.cdp.send('Page.getFrameTree');
        const world = await session.cdp.send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: WORLD });
        ctxId = world.executionContextId;
      }
      await session.cdp.evaluate('(globalThis.__GRAVITYBOX_PENDING_BOOT__?.cancel(),globalThis.__GRAVITYBOX_ENGINE_V1__?.dispose(),globalThis.__GRAVITYBOX_HUD_V1__?.dispose())', ctxId);
    } catch { restorationFailed = true; }
    session.cdp.close();
    if (restorationFailed) this.status.errors.push(this.t('controller.err.window_lost_restore'));
  }
  private async disconnectPages() {
    for (const session of this.pages.values()) {
      this.markRemoteSessionDisconnected(session);
      await this.detach(session);
    }
    this.pages.clear();
  }
  private async quiescePages() {
    await this.connecting?.catch(() => {});
    if (this.syncing) await new Promise<void>(resolve => this.syncWaiters.push(resolve));
    await this.disconnectPages();
  }
  private async quiesce() {
    await this.controlChain.catch(() => {});
    await this.quiescePages();
  }
  private async ensureHudBridgeAttached(session: PageSession): Promise<void> {
    let targetOrigin = '';
    try { targetOrigin = new URL(session.url).origin; } catch {}
    await this.hudBridge.attachToTarget(session.targetId, session.cdp, () => session.contextId, WORLD, {
      sourceKind: session.sourceKind ?? 'local',
      ...(session.remoteKey ? { remoteKey: session.remoteKey } : {}),
      ...(session.hostLabel ? { hostLabel: session.hostLabel } : {}),
      ...(targetOrigin ? { origin: targetOrigin } : {}),
      ...(session.rpcClient ? { rpcClient: session.rpcClient } : {}),
    });
  }
  private async transitionActiveSessionsToObserveOnly(): Promise<void> {
    await this.connecting?.catch(() => {});
    if (this.syncing) await new Promise<void>(resolve => this.syncWaiters.push(resolve));
    this.hudBridge.clearActivePanes();
    for (const [id, session] of [...this.pages.entries()]) {
      if (session.detaching) continue;
      try {
        await session.updateChain.catch(() => {});
        this.hudBridge.detachTarget(id);
        if (session.registration) {
          await session.cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: session.registration }).catch(() => {});
          session.registration = undefined;
          session.registeredVerifiedBundle = undefined;
          session.registeredFullTranslation = undefined;
        }
        if (session.contextId !== undefined) {
          await session.cdp.evaluate(
            '(globalThis.__GRAVITYBOX_PENDING_BOOT__?.cancel?.(),globalThis.__GRAVITYBOX_ENGINE_V1__?.dispose?.(),globalThis.__GRAVITYBOX_HUD_V1__?.dispose?.())',
            session.contextId
          ).catch(() => {});
          await this.installObserveFocusListener(session);
        }
        session.languageMode = 'en';
        session.bootedConservative = undefined;
      } catch {
        this.markRemoteSessionDisconnected(session);
        await this.detach(session);
        this.pages.delete(id);
      }
    }
  }
  private async transitionActiveSessionsToHudOnly(): Promise<void> {
    await this.connecting?.catch(() => {});
    if (this.syncing) await new Promise<void>(resolve => this.syncWaiters.push(resolve));
    if (!this.hudEnabled) {
      await this.transitionActiveSessionsToObserveOnly();
      return;
    }
    const hudLocale = this.effectiveHudLocale();
    for (const [id, session] of [...this.pages.entries()]) {
      if (session.detaching) continue;
      try {
        await session.updateChain.catch(() => {});
        const tree = await session.cdp.send('Page.getFrameTree');
        const frame = tree.frameTree.frame;
        if (!allowedTarget({ type: 'page', url: frame.url }, this.options.fixture?.origin)) {
          this.markRemoteSessionDisconnected(session);
          await this.detach(session);
          this.pages.delete(id);
          continue;
        }
        session.url = frame.url;
        await this.ensureHudBridgeAttached(session);
        await this.refreshRegistration(session);
        if (session.contextId === undefined) {
          const world = await session.cdp.send('Page.createIsolatedWorld', { frameId: frame.id, worldName: WORLD });
          session.contextId = world.executionContextId;
        }
        await session.cdp.evaluate(
          '(globalThis.__GRAVITYBOX_PENDING_BOOT__?.cancel?.(),globalThis.__GRAVITYBOX_ENGINE_V1__?.dispose?.({keepHud:true}))',
          session.contextId
        );
        await session.cdp.evaluate(this.boot(session.url, session), session.contextId);
        await session.cdp.evaluate(
          `(globalThis.__GRAVITYBOX_ATTACH_HUD__?.(), globalThis.__GRAVITYBOX_HUD_V1__?.setLanguage?.(${JSON.stringify(hudLocale)}), globalThis.__GRAVITYBOX_HUD_V1__?.setEnabled?.(true))`,
          session.contextId
        );
        session.languageMode = 'en';
      } catch {
        this.markRemoteSessionDisconnected(session);
        await this.detach(session);
        this.pages.delete(id);
      }
    }
  }
  pause(): Promise<void> {
    return this.enqueueControl(async () => {
      const prevHudLocale = this.effectiveHudLocale();
      this.paused = true;
      this.status.errors = [];
      this.bootCache.clear();
      await this.transitionActiveSessionsToHudOnly();
      await this.resumeHudOnly();
      if (this.hudEnabled) {
        if (this.effectiveHudLocale() !== prevHudLocale) {
          await this.hudBridge.refreshAllForLocaleChange();
        }
        if (!this.browser && this.status.mode === 'debug-port-missing') {
          this.publish('debug-port-missing', this.t('status.debug_port_missing'));
          return;
        }
      }
      this.publish('paused', this.status.errors.length ? this.t('status.pausedWithErrors') : this.t('status.paused'));
    });
  }
  private async resumeHudOnly() {
    if (this.browser) await this.sync(); else await this.tryConnect();
  }
  private async resumeInternal() {
    const prevHudLocale = this.effectiveHudLocale();
    // Recreate the isolated runtime so translation starts from the chosen mode.
    if (this.locale === 'en') {
      this.locale = 'zh-Hans';
      this.configuredLanguage = 'zh-Hans';
      this.hasTargetDictionary = true;
    }
    const wasPaused = this.paused;
    this.paused = false;
    this.reconnectionDelay = 1000;
    this.unverifiedWindowRetries = 0;
    this.bootCache.clear();
    if (wasPaused && this.pages.size) {
      for (const [id, session] of [...this.pages.entries()]) {
        if (session.detaching) continue;
        session.languageMode = undefined;
        try {
          if (this.hudEnabled) {
            await this.ensureHudBridgeAttached(session);
          }
          if (session.contextId !== undefined) {
            await session.cdp.evaluate(
              this.hudEnabled
                ? '(globalThis.__GRAVITYBOX_PENDING_BOOT__?.cancel?.(),globalThis.__GRAVITYBOX_ENGINE_V1__?.dispose?.({keepHud:true}))'
                : '(globalThis.__GRAVITYBOX_PENDING_BOOT__?.cancel?.(),globalThis.__GRAVITYBOX_ENGINE_V1__?.dispose?.(),globalThis.__GRAVITYBOX_HUD_V1__?.dispose?.())',
              session.contextId
            );
          }
          await this.refreshRegistration(session);
          await this.queueBootstrap(session, false);
        } catch {
          this.markRemoteSessionDisconnected(session);
          await this.detach(session);
          this.pages.delete(id);
        }
      }
    }
    try {
      if (this.browser) await this.sync();
      else { clearTimeout(this.reconnection); await this.tryConnect(); }
    } catch {
      this.browser?.close();
      this.browser = undefined;
      clearTimeout(this.reconnection);
      await this.tryConnect();
    }
    if (this.hudEnabled && this.effectiveHudLocale() !== prevHudLocale) {
      await this.hudBridge.refreshAllForLocaleChange();
    }
  }
  resume(): Promise<void> {
    return this.enqueueControl(() => this.resumeInternal());
  }
  setLocale(
    nextLocale: string,
    configuredLanguage?: string,
    options?: { dictionary?: Dictionary; hasTargetDictionary?: boolean }
  ): Promise<void> {
    return this.enqueueControl(async () => {
      const resolved = normalizeLocale(nextLocale) ?? 'en';
      const previousLocale = this.locale;
      const previousPaused = this.paused;
      this.locale = resolved;
      this.configuredLanguage = configuredLanguage ?? resolved;
      this.hasTargetDictionary = options?.hasTargetDictionary ?? (resolved !== 'en');
      this.status.errors = [];
      if (options?.dictionary) {
        this.options.dictionary = options.dictionary;
        this.status.dictionaryVersion = options.dictionary.version;
        this.status.entries = Object.keys(options.dictionary.entries).length;
      }
      if (previousLocale !== resolved) {
        for (const s of this.pages.values()) s.languageMode = undefined;
      }
      this.bootCache.clear();
      const shouldTranslateDom = resolved !== 'en' && this.hasTargetDictionary;
      if (!shouldTranslateDom) {
        this.paused = true;
        if (!previousPaused || previousLocale !== resolved) {
          await this.transitionActiveSessionsToHudOnly();
          await this.resumeHudOnly();
          if (this.hudEnabled) {
            await this.hudBridge.refreshAllForLocaleChange();
          }
        }
        if (this.hudEnabled && !this.browser && this.status.mode === 'debug-port-missing') {
          this.publish('debug-port-missing', this.t('status.debug_port_missing'));
          return;
        }
        const message = this.status.errors.length
          ? this.t('status.pausedWithErrors')
          : this.t('status.paused');
        this.publish('paused', message);
        return;
      }
      if (previousPaused) {
        await this.resumeInternal();
        if (this.hudEnabled) {
          await this.hudBridge.refreshAllForLocaleChange();
        }
        return;
      }
      if (options?.dictionary) {
        await this.applyDictionary(options.dictionary);
      }
      const effectiveHudLocale = this.effectiveHudLocale();
      await Promise.allSettled([...this.pages.values()].map(async session => {
        await this.refreshRegistration(session);
        if (session.contextId !== undefined && !session.detaching) {
          await session.cdp.evaluate(
            `globalThis.__GRAVITYBOX_HUD_V1__?.setLanguage?.(${JSON.stringify(effectiveHudLocale)})`,
            session.contextId
          );
        }
      }));
      if (this.hudEnabled) {
        await this.hudBridge.refreshAllForLocaleChange();
      }
      if (!this.browser && this.status.mode === 'debug-port-missing') {
        this.publish('debug-port-missing', this.t('status.debug_port_missing'));
        return;
      }
      this.publish();
    });
  }
  /** @internal Fixture-only shortcut toggle; no-op in production. */
  configureShortcut(enabled: boolean): Promise<void> {
    return this.enqueueControl(async () => {
      if (!this.options.fixture) return;
      this.options.shortcutEnabled = enabled;
      this.bootCache.clear();
      await Promise.allSettled([...this.pages.values()].map(async session => {
        await this.refreshRegistration(session);
        if (session.contextId !== undefined && !session.detaching) {
          await session.cdp.evaluate(
            `globalThis.__GRAVITYBOX_ENGINE_V1__?.setShortcutEnabled(${enabled})`,
            session.contextId
          );
        }
      }));
    });
  }
  configureHud(enabled: boolean): Promise<void> {
    return this.enqueueControl(async () => {
      this.hudEnabled = enabled;
      this.options.hudEnabled = enabled;
      this.bootCache.clear();
      if (this.paused) {
        if (enabled) {
          await this.transitionActiveSessionsToHudOnly();
          await this.resumeHudOnly();
          await this.hudBridge.refreshAllForLocaleChange();
          this.publish();
          return;
        }
        await this.transitionActiveSessionsToObserveOnly();
        await this.resumeHudOnly();
        this.publish('paused', this.t('status.paused_keep'));
        return;
      }
      if (!enabled) {
        this.hudBridge.clearActivePanes();
      }
      const effectiveHudLocale = this.effectiveHudLocale();
      await Promise.allSettled([...this.pages.values()].map(async session => {
        await this.refreshRegistration(session);
        if (session.contextId !== undefined && !session.detaching) {
          if (enabled) {
            await this.ensureHudBridgeAttached(session);
            await session.cdp.evaluate(
              `((globalThis.__GRAVITYBOX_BOOT__&&(globalThis.__GRAVITYBOX_BOOT__.hudEnabled=true)),globalThis.__GRAVITYBOX_ATTACH_HUD__?.(),globalThis.__GRAVITYBOX_HUD_V1__?.setLanguage?.(${JSON.stringify(effectiveHudLocale)}),globalThis.__GRAVITYBOX_HUD_V1__?.setEnabled?.(true),globalThis.__GRAVITYBOX_HUD_V1__?.syncAllSessions?.())`,
              session.contextId
            );
          } else {
            await session.cdp.evaluate('((globalThis.__GRAVITYBOX_BOOT__&&(globalThis.__GRAVITYBOX_BOOT__.hudEnabled=false)),globalThis.__GRAVITYBOX_HUD_V1__?.setEnabled?.(false))', session.contextId);
          }
        }
      }));
      this.publish();
    });
  }
  toggleLanguage(mode?: 'zh' | 'en'): Promise<void> {
    return this.enqueueControl(async () => {
      if (this.paused || !this.pages.size) return;
      await Promise.allSettled([...this.pages.values()].map(async session => {
        if (session.contextId !== undefined && !session.detaching) {
          await session.cdp.evaluate(`globalThis.__GRAVITYBOX_ENGINE_V1__?.toggleLanguage(${mode ? JSON.stringify(mode) : ''})`, session.contextId);
        }
      }));
    });
  }
  snapshot(): AssistantStatus {
    this.status.rssMB = Math.round(process.memoryUsage().rss / 1024 / 1024 * 10) / 10;
    this.status.updatedAt = new Date().toISOString();
    const sshSummary = this.getActiveSshWindowsSummary();
    this.status.sshWindows = sshSummary.count;
    this.status.sshWindowsCount = sshSummary.count;
    this.status.activeSshHosts = sshSummary.hosts;
    this.status.focusedContextKey = this.getFocusedContextKey();
    this.status.remoteObservedVersion = this.remoteObservedVersion;
    return { ...this.status, errors: [...this.status.errors], activeSshHosts: [...sshSummary.hosts] };
  }
  async coverageReport(): Promise<CoverageReport | undefined> {
    if (this.coverage && (this.coverage.appVersion !== this.status.appVersion || this.coverage.bundleSha256 !== this.status.bundleSha256)) {
      this.coverage = undefined;
    }
    const versionKey = `${this.status.appVersion ?? ''}:${this.status.bundleSha256 ?? ''}`;
    if (!this.coverage && this.options.stateDir && this.coverageMissingForKey !== versionKey) {
      try {
        const saved = JSON.parse(await readFile(join(this.options.stateDir,'reports/coverage.json'),'utf8'));
        if(saved.schema===1 && saved.appVersion===this.status.appVersion && saved.bundleSha256===this.status.bundleSha256) {
          this.coverage=saved;
          this.coverageMissingForKey=undefined;
        } else {
          this.coverageMissingForKey=versionKey;
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') this.coverageMissingForKey = versionKey;
      }
    }
    if (this.coverage && (!this.coverage.statusCounts || !this.coverage.observedCounts)) recountCoverage(this.coverage);
    if(this.coverage && this.coverage.dictionaryVersion!==this.options.dictionary.version){
      const lookup=coverageTranslationLookup(this.options.dictionary);
      for(const entry of this.coverage.entries){
        if(entry.status==='native')continue;
        /* 先按已知场景精确命中 @ui:<route>|<kind>|<原文>，再退回普通键/任意场景译文。 */
        const resolved=resolveCoverageTranslation(entry.key,lookup,coverageScopes(entry));
        const next=resolved.translation;
        if(next!==entry.translation){delete entry.observed;delete entry.observations;}
        entry.translation=next;entry.scoped=resolved.scoped;
        entry.status=resolved.ambiguous?'review':classifyCoverage(entry.key,next,entry.status==='dynamic');
        if(entry.confidence==='literal'&&entry.status==='missing')entry.status='review';
      }
      this.coverage.dictionaryVersion=this.options.dictionary.version;recountCoverage(this.coverage);
    }
    return this.coverage;
  }
  coverageEditable(entry:CoverageReport['entries'][number]){return entry.confidence==='ui'&&!['native','review','dynamic'].includes(entry.status)&&coverageScopes(entry).length<=1;}
  async prepareCoverageEdit(key:unknown){
    if(typeof key!=='string')throw new Error(this.t('controller.coverage.select_entry'));
    const report=await this.coverageReport(), entry=report?.entries.find(e=>e.key===key);
    if(!entry||!this.coverageEditable(entry))throw new Error(this.t('controller.coverage.not_editable'));
    const scope=coverageScopes(entry)[0], normalized=key.replace(/\s+/g,' ').trim(), target=scope?scopedKey(normalized,scope.kind,scope.route):normalized;
    return{key:target,displayKey:key,context:scope?describeContext(scope):this.t('controller.coverage.general_context'),value:this.options.dictionary.entries[target]??entry.translation??'',version:this.options.dictionary.version};
  }
  async hasRunningAgentTask(): Promise<{ busy: boolean; checked?: boolean; reason?: string }> {
    let checked = false;
    for (const page of this.pages.values()) {
      if (page.contextId === undefined) continue;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const res = await Promise.race([
          page.cdp.evaluate(
            `(() => {
              const engineState = globalThis.__GRAVITYBOX_ENGINE_V1__?.draftState?.();
              if (engineState?.generating) return { busy: true, checked: true, reason: ${JSON.stringify(this.t('controller.task.streaming_busy'))} };
              const rendered = e => !!e?.getClientRects?.().length && getComputedStyle(e).visibility !== 'hidden';
              const hasIdleBanner = [...document.querySelectorAll('[data-testid="idle-status-text"]')].some(e => rendered(e) && !!(e.textContent || '').trim());
              const hasTurnSignal = [...document.querySelectorAll('[data-testid="input-cancel-button"],[data-state="streaming"],[data-streaming="true"],[data-testid="agent-loading"],[data-testid="browser-subagent-thinking"],[data-testid="running-subagent-steps-toggle"],[data-testid="running-subagent-browser-steps"]')].some(e => {
                if (!rendered(e)) return false;
                const tid = e.getAttribute('data-testid') || '';
                if (tid === 'agent-loading' && hasIdleBanner) return false;
                if (tid !== 'input-cancel-button' && e.closest?.('[data-testid="idle-status-text"],[data-testid="running-items-card"]')) return false;
                return true;
              });
              if (hasTurnSignal) return { busy: true, checked: true, reason: ${JSON.stringify(this.t('controller.task.agent_busy'))} };
              const stopBtn = [...document.querySelectorAll('button,[role="button"],[data-testid="input-cancel-button"]')].some(e => {
                if (!rendered(e)) return false;
                if (e.closest?.('[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[data-select-popup],[data-testid="running-row"],[data-testid="running-selection-bar"]')) return false;
                const tid = (e.getAttribute('data-testid') || '').toLowerCase();
                if (tid === 'input-cancel-button') return true;
                const cls = typeof e.className === 'string' ? e.className.toLowerCase() : '';
                if (/(?:voice|dictat|microphone|audio-record|speech|record-audio)/i.test(tid + ' ' + cls)) return false;
                const label = (e.getAttribute('aria-label') || e.getAttribute('title') || e.textContent || '').trim();
                if (/(?:voice|dictat|recording|microphone|语音|录音|听写|麦克风)/i.test(label)) return false;
                if (/^(?:Stop generating|Cancel generation|Stop subagent|Cancel\\s*[（(][^）)]+[）)]|停止生成|取消生成|终止生成|停止子智能体|取消\\s*[（(][^）)]+[）)])$/i.test(label)) return true;
                if (/(?:stop|cancel)\\s*(?:generation|generating|streaming|agent|response)/i.test(label)) return true;
                if (/^(?:Stop|Interrupt|停止|中断)$/i.test(label) && Boolean(e.closest?.('[data-testid="agent-input-box"],.surface-composer'))) return true;
                return false;
              });
              if (stopBtn) return { busy: true, checked: true, reason: ${JSON.stringify(this.t('controller.task.agent_busy'))} };
              return { busy: false, checked: true };
            })()`,
            page.contextId
          ),
          new Promise<{ busy: boolean; checked: boolean }>(resolve => {
            timer = setTimeout(() => resolve({ busy: false, checked: false }), 600);
          }),
        ]);
        if (res?.checked) checked = true;
        if (res?.busy) return res;
      } catch {
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    return { busy: false, checked };
  }
  async maintenancePreflight(){
    const sshSummary = this.getActiveSshWindowsSummary();
    if(!this.endpoint||!this.pages.size)return{ok:true,pid:0,activeSshWindowsCount:sshSummary.count,activeSshHosts:sshSummary.hosts};
    const endpoint=await this.discoverEndpoint(this.options.appPath,this.options.profile);if(!endpoint||endpoint.pid!==this.endpoint.pid)return{ok:true,pid:endpoint?.pid??0,activeSshWindowsCount:sshSummary.count,activeSshHosts:sshSummary.hosts};
    const agentTask=await this.hasRunningAgentTask();
    if(agentTask.busy)throw new Error(agentTask.reason?this.t('controller.preflight.reason_wait', { reason: agentTask.reason }):this.t('controller.preflight.task_wait'));
    for(const page of this.pages.values()){
      if(page.contextId===undefined||page.detaching)continue;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let state: { busy?: boolean } | undefined;
      try {
        state = await Promise.race([
          page.cdp.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__?.maintenanceState?.()', page.contextId),
          new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 1500); }),
        ]);
      } catch {
        continue;
      } finally {
        if (timer) clearTimeout(timer);
      }
      if(state?.busy)throw new Error(this.t('controller.preflight.save_drafts'));
    }
    return{ok:true,pid:endpoint.pid,activeSshWindowsCount:sshSummary.count,activeSshHosts:sshSummary.hosts};
  }
  async prepareDeepScan() {
    if(this.options.fixture)throw new Error(this.t('controller.scan.fixture_unsupported'));
    const endpoint=await discover(this.options.appPath,this.options.profile);
    if(!endpoint||endpoint.pid!==this.endpoint?.pid||endpoint.appVersion!==this.status.appVersion)throw new Error(this.t('controller.scan.connect_app_first'));
    const sources=await nativeSources(endpoint.appPath ?? this.activeAppPath());
    const report=createCoverage(sources,this.options.dictionary,endpoint.appVersion,this.status.bundleSha256??'');
    const defaults=['Antigravity','File','Edit','View','Window','Help','Services','Hide Antigravity','Hide Others','Show All','Quit Antigravity','About Antigravity','Undo','Redo','Cut','Copy','Paste','Paste and Match Style','Delete','Select All','Minimize','Zoom','Bring All to Front','Open Recent','Clear Menu'];
    const names=[...defaults,...report.entries.map(e=>e.key)];
    return {pid:endpoint.pid,nativeKeys:[...new Set([...names,...names.map(k=>this.options.dictionary.entries[k]).filter((v):v is string=>typeof v==='string')])].filter(k=>k.length<=200).slice(0,1200)};
  }
  async metadataScan(signal:AbortSignal,nativeInput?:unknown,onCommit?:()=>void){
    const prepared=await this.prepareDeepScan();signal.throwIfAborted();
    const report=await this.coverageReport()??createCoverage([],this.options.dictionary,this.status.appVersion??'unknown',this.status.bundleSha256??'',[]);
    const deep:DeepReport={schema:1,scope:'metadata',startedAt:new Date().toISOString(),finishedAt:new Date().toISOString(),state:'partial',steps:[],plugins:await readPluginCatalog(join(homedir(),'.gemini/config/plugins'),signal),nativeMenus:sanitizeNativeMenus(nativeInput,new Set(prepared.nativeKeys)),notes:[this.t('controller.scan.note_metadata_only'),this.t('controller.scan.note_local_only')]};
    const reportFilename = this.t('deep_scan.report_filename');
    deep.state=deep.nativeMenus.state==='read'&&!deep.plugins.limited?'complete':'partial';report.deep=deep;signal.throwIfAborted();onCommit?.();const directory=join(this.options.stateDir!,'reports');await atomicJson(join(directory,'coverage.json'),report,signal);await atomicJson(join(directory,'deep-scan.json'),deep,signal);await atomicText(join(directory,reportFilename),deepMarkdown(deep),signal);this.coverage=report;this.publish();return{ok:deep.state==='complete',partial:true,message:this.t('controller.scan.summary', { count: deep.plugins.entries.length, menuMessage: deep.nativeMenus.message })};
  }
  async refreshHudForPricingChange(): Promise<void> {
    if (!this.hudEnabled || this.stopped) return;
    await this.hudBridge.refreshAllForPricingChange();
  }
  async stop() {
    this.stopped = true; this.closeProfileWatchers(); clearTimeout(this.reconnection); clearTimeout(this.targetTimer); clearTimeout(this.focusPublishTimer);
    this.hudBridge.dispose();
    await this.quiesce();
    this.browser?.close();
    this.publish('stopped', this.status.errors.length ? this.t('status.stopped_with_errors') : this.t('status.stopped'));
  }
}

