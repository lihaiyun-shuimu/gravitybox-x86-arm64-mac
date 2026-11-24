import type { CDP } from '../cdp.js';
import type {
  ConversationHudMetrics,
  HudActivityPhase,
  HudClientEvent,
  HudPaneKind,
  ICdpHudBridge,
  ParsedExecutorMetadata,
} from './types.js';
import { ConversationMetricsEngine, buildConversationHudMetrics } from './metrics-engine.js';
import {
  computeRemoteConversationHudMetrics,
  isRemoteChildTrajectoryTerminal,
  isStrictSubagentSummary,
  type RemoteGenMetadataRecord,
  type RemoteRpcClientLike,
  type RemoteStepRecord,
  type RemoteTrajectorySummary,
} from '../ssh-remote-rpc.js';

export interface HudTargetMeta {
  sourceKind?: 'local' | 'remote';
  remoteKey?: string;
  hostLabel?: string;
  origin?: string;
  rpcClient?: RemoteRpcClientLike;
}

interface AttachedTargetEntry {
  cdp: CDP;
  getContextId: () => number | undefined;
  sourceKind: 'local' | 'remote';
  remoteKey?: string;
  hostLabel?: string;
  origin?: string;
  rpcClient?: RemoteRpcClientLike;
}

interface RemoteChildTrajectoryCache {
  cascadeId: string;
  summary?: RemoteTrajectorySummary | null;
  steps: RemoteStepRecord[];
  generatorMetadata: RemoteGenMetadataRecord[];
  signature?: string;
  isTerminal?: boolean;
}

interface RemoteRpcSessionCacheEntry {
  cacheKey: string;
  remoteKey: string;
  origin: string;
  conversationId: string;
  summary?: RemoteTrajectorySummary | null;
  steps: RemoteStepRecord[];
  generatorMetadata: RemoteGenMetadataRecord[];
  executorMetadata?: ParsedExecutorMetadata | null;
  childTrajectories: RemoteChildTrajectoryCache[];
  childCursor?: number;
  hasUncollectedChildren?: boolean;
  failedChildCount: number;
  lastMetrics: ConversationHudMetrics;
  lastSuccessAt: number;
  isStale: boolean;
}

const MAX_REMOTE_SESSION_CACHE_ENTRIES = 64;
const REMOTE_ACTIVE_POLL_INTERVAL_MS = 1000;
const REMOTE_IDLE_POLL_INTERVAL_MS = 5000;

export const HUD_BRIDGE_BINDING_NAME = '__gravityboxHudBridge';

export interface ActivePaneSession {
  targetId: string;
  paneSlotId: string;
  paneKind?: HudPaneKind;
  cascadeId: string;
  conversationId: string;
  sessionRevision: number;
  metricsSequence: number;
  modelId: string;
  modelCapacity?: number;
  foregroundStreaming: boolean;
  isStreaming: boolean;
  activityPhase: HudActivityPhase;
  isSubagentRunning: boolean;
  runningSubagentCount: number;
  childConversationIds: string[];
  lastUpdatedAt: number;
  lastMetricsKey: string;
  lastActivityAt: number;
  autoHealAttempts?: number;
}

const ACTIVITY_GRACE_WINDOW_MS = 15_000;

/**
 * CDP HUD 双向通信与多窗口/多分栏会话协调桥
 * 复用 Controller 维护的 PageSession CDP 通道与 GRAVITYBOX-localization-v1 隔离世界
 */
export class CdpHudBridge implements ICdpHudBridge {
  private readonly engine: ConversationMetricsEngine;
  private readonly targets = new Map<string, AttachedTargetEntry>();
  private readonly activePanes = new Map<string, ActivePaneSession>();
  private readonly remoteSessionCache = new Map<string, RemoteRpcSessionCacheEntry>();
  private readonly inFlightPaneRefreshes = new Set<string>();
  private readonly inFlightPaneRefreshCounts = new Map<string, number>();
  private readonly pendingPaneRefreshForce = new Map<string, boolean>();
  private readonly clientEventHandlers = new Set<(event: HudClientEvent) => void>();
  private pollTimer: NodeJS.Timeout | null = null;
  private localPollInFlight = false;
  private lastLocalPollStartedAt = 0;
  private readonly remotePollInFlightByTarget = new Map<string, boolean>();
  private readonly lastRemotePollStartedAtByTarget = new Map<string, number>();
  private sequenceCounter = Date.now();
  private readonly basePollIntervalMs: number;
  private disposed = false;

  constructor(options?: {
    engine?: ConversationMetricsEngine;
    geminiDir?: string;
    conversationsDir?: string;
    stateDir?: string;
    pollIntervalMs?: number;
  }) {
    this.engine =
      options?.engine ??
      new ConversationMetricsEngine({
        geminiDir: options?.geminiDir,
        conversationsDir: options?.conversationsDir,
        stateDir: options?.stateDir,
      });
    const interval = options?.pollIntervalMs ?? 250;
    this.basePollIntervalMs = interval;
    if (interval > 0) {
      this.pollTimer = setInterval(() => {
        void this.pollActiveSessions(false);
      }, interval);
      this.pollTimer.unref?.();
    }
  }

  private buildRemoteCacheKey(remoteKey: string, origin: string, conversationId: string): string {
    return `${remoteKey}::${origin}::${conversationId}`;
  }

  private setRemoteCacheEntry(entry: RemoteRpcSessionCacheEntry): void {
    if (this.remoteSessionCache.has(entry.cacheKey)) {
      this.remoteSessionCache.delete(entry.cacheKey);
    }
    this.remoteSessionCache.set(entry.cacheKey, entry);
    while (this.remoteSessionCache.size > MAX_REMOTE_SESSION_CACHE_ENTRIES) {
      const oldestKey = this.remoteSessionCache.keys().next().value;
      if (!oldestKey) break;
      this.remoteSessionCache.delete(oldestKey);
    }
  }

  private purgeRemoteCacheForDifferentOrigin(remoteKey: string, nextOrigin: string): void {
    if (!remoteKey || !nextOrigin) return;
    for (const [key, entry] of this.remoteSessionCache.entries()) {
      if (entry.remoteKey === remoteKey && entry.origin !== nextOrigin) {
        this.remoteSessionCache.delete(key);
      }
    }
  }

  public updateTargetOrigin(targetId: string, nextOrigin: string): void {
    const target = this.targets.get(targetId);
    if (!target || !nextOrigin) return;
    target.origin = nextOrigin;
    if (target.sourceKind === 'remote' && target.remoteKey) {
      this.purgeRemoteCacheForDifferentOrigin(target.remoteKey, nextOrigin);
    }
  }

  /**
   * 绑定到已连接的 CDP PageSession
   */
  public async attachToTarget(
    targetId: string,
    cdp?: CDP,
    getContextId?: () => number | undefined,
    worldName = 'GRAVITYBOX-localization-v1',
    meta?: HudTargetMeta
  ): Promise<void> {
    if (this.disposed || !cdp || !getContextId) return;
    const sourceKind: 'local' | 'remote' = meta?.sourceKind === 'remote' ? 'remote' : 'local';
    const remoteKey = meta?.remoteKey;
    const origin = meta?.origin ?? '';
    if (sourceKind === 'remote' && remoteKey && origin) {
      this.purgeRemoteCacheForDifferentOrigin(remoteKey, origin);
    }
    this.targets.set(targetId, {
      cdp,
      getContextId,
      sourceKind,
      ...(remoteKey ? { remoteKey } : {}),
      ...(meta?.hostLabel ? { hostLabel: meta.hostLabel } : {}),
      ...(origin ? { origin } : {}),
      ...(meta?.rpcClient ? { rpcClient: meta.rpcClient } : {}),
    });
    for (const [paneKey, pane] of this.activePanes.entries()) {
      if (paneKey.startsWith(`${targetId}::`)) {
        pane.lastMetricsKey = '';
      }
    }
    try {
      await cdp.send('Runtime.addBinding', {
        name: HUD_BRIDGE_BINDING_NAME,
        executionContextName: worldName,
      });
    } catch {
      // 若已绑定或目标窗口正在切换，忽略重复绑定错误
    }
  }

  public detachTarget(targetId: string): void {
    this.targets.delete(targetId);
    this.remotePollInFlightByTarget.delete(targetId);
    this.lastRemotePollStartedAtByTarget.delete(targetId);
    this.detachTargetPanes(targetId);
  }

  public detachTargetPanes(targetId: string): void {
    for (const key of this.activePanes.keys()) {
      if (key.startsWith(`${targetId}::`)) {
        this.activePanes.delete(key);
        this.pendingPaneRefreshForce.delete(key);
      }
    }
  }

  public clearActivePanes(): void {
    this.activePanes.clear();
    this.pendingPaneRefreshForce.clear();
  }

  /**
   * 处理来自隔离世界 `window.__gravityboxHudBridge(jsonPayload)` 的事件
   */
  public handleRawBindingPayload(targetId: string, rawPayload: string): void {
    if (this.disposed || typeof rawPayload !== 'string') return;
    let parsed: HudClientEvent;
    try {
      parsed = JSON.parse(rawPayload) as HudClientEvent;
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== 'object' || !['SESSION_ATTACHED', 'MODEL_CHANGED', 'STREAMING_CHANGED', 'REQUEST_REFRESH', 'SESSION_DETACHED'].includes(parsed.type)) return;

    for (const handler of this.clientEventHandlers) {
      try {
        handler(parsed);
      } catch {}
    }

    const cascadeId = String(parsed.cascadeId || 'default-pane');
    const paneSlotId = String(parsed.paneSlotId || cascadeId);
    const conversationId = String(parsed.conversationId || '');
    if (!conversationId) return;

    const paneKey = `${targetId}::${paneSlotId}`;
    const existing = this.activePanes.get(paneKey);
    const revision = parsed.sessionRevision;
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) return;
    if (existing && (revision < existing.sessionRevision || revision === existing.sessionRevision && conversationId !== existing.conversationId)) return;

    if (parsed.type === 'SESSION_DETACHED') {
      if (!existing || revision !== existing.sessionRevision || conversationId !== existing.conversationId) return;
      this.activePanes.delete(paneKey);
      this.pendingPaneRefreshForce.delete(paneKey);
      if (paneSlotId === cascadeId) {
        const legacyKey = `${targetId}::${cascadeId}`;
        this.activePanes.delete(legacyKey);
        this.pendingPaneRefreshForce.delete(legacyKey);
      }
      return;
    }

    const sameConv = existing && existing.conversationId === conversationId ? existing : undefined;
    const nextRevision = revision;

    const isSubagentRunning =
      typeof parsed.isSubagentRunning === 'boolean'
        ? parsed.isSubagentRunning
        : sameConv
        ? sameConv.isSubagentRunning
        : false;

    const runningSubagentCount =
      typeof parsed.runningSubagentCount === 'number' && parsed.runningSubagentCount >= 0
        ? parsed.runningSubagentCount
        : isSubagentRunning
        ? Math.max(1, sameConv?.runningSubagentCount ?? 1)
        : 0;

    const childConversationIds = Array.isArray(parsed.childConversationIds)
      ? parsed.childConversationIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : sameConv
      ? sameConv.childConversationIds
      : [];

    const foregroundStreaming =
      typeof parsed.isStreaming === 'boolean'
        ? parsed.isStreaming
        : (sameConv?.foregroundStreaming ?? false);
    const resolvedStreaming = foregroundStreaming || isSubagentRunning;
    const resolvedPhase: HudActivityPhase = !foregroundStreaming
      ? 'idle'
      : parsed.activityPhase === 'generating' || parsed.activityPhase === 'executing'
      ? parsed.activityPhase
      : sameConv?.activityPhase && sameConv.activityPhase !== 'idle'
      ? sameConv.activityPhase
      : 'generating';

    const nowMs = Date.now();
    const parsedModelId =
      (typeof parsed.modelId === 'string' && parsed.modelId.trim()) ||
      sameConv?.modelId ||
      '';
    const modelChanged = Boolean(sameConv && parsedModelId && parsedModelId !== sameConv.modelId);
    const parsedModelCapacity =
      typeof parsed.modelCapacity === 'number' &&
      Number.isSafeInteger(parsed.modelCapacity) &&
      parsed.modelCapacity > 0
        ? parsed.modelCapacity
        : modelChanged
        ? undefined
        : sameConv?.modelCapacity;
    const parsedPaneKind: HudPaneKind | undefined =
      parsed.paneKind === 'main' || parsed.paneKind === 'subagent' || parsed.paneKind === 'btw'
        ? parsed.paneKind
        : sameConv?.paneKind;
    const session: ActivePaneSession = {
      targetId,
      paneSlotId,
      ...(parsedPaneKind ? { paneKind: parsedPaneKind } : {}),
      cascadeId,
      conversationId,
      sessionRevision: nextRevision,
      metricsSequence: sameConv?.metricsSequence ?? 0,
      modelId: parsedModelId,
      ...(parsedModelCapacity !== undefined ? { modelCapacity: parsedModelCapacity } : {}),
      foregroundStreaming,
      isStreaming: resolvedStreaming,
      activityPhase: resolvedPhase,
      isSubagentRunning,
      runningSubagentCount,
      childConversationIds,
      lastUpdatedAt: nowMs,
      lastMetricsKey:
        !sameConv ||
        parsed.type === 'SESSION_ATTACHED' ||
        parsed.type === 'REQUEST_REFRESH' ||
        nextRevision > sameConv.sessionRevision
          ? ''
          : sameConv.lastMetricsKey,
      lastActivityAt:
        resolvedStreaming || parsed.type === 'STREAMING_CHANGED' || isSubagentRunning
          ? nowMs
          : sameConv?.lastActivityAt ?? nowMs,
      ...(sameConv?.autoHealAttempts ? { autoHealAttempts: sameConv.autoHealAttempts } : {}),
    };

    this.activePanes.set(paneKey, session);
    void this.refreshPaneMetrics(paneKey, true).catch(() => {});
  }

  private buildRemoteUnbridgedMetrics(
    session: ActivePaneSession,
    target: AttachedTargetEntry,
    nextSeq: number
  ): ConversationHudMetrics {
    const metrics = buildConversationHudMetrics({
      conversationId: session.conversationId,
      paneSlotId: session.paneSlotId,
      sessionRevision: session.sessionRevision,
      metricsSequence: nextSeq,
      availability: 'remote_unbridged',
      observedAt: null,
      lastSuccessAt: null,
      isStreaming: session.foregroundStreaming,
      activityPhase: session.activityPhase,
      isSubagentRunning: session.isSubagentRunning,
      runningSubagentCount: session.runningSubagentCount,
      modelId: session.modelId,
      modelCapacity: session.modelCapacity,
      steps: [],
    });
    metrics.sourceKind = 'remote';
    if (target.hostLabel) metrics.remoteHostLabel = target.hostLabel;
    return metrics;
  }

  private async resolvePricingForRemote(): Promise<Record<string, any> | undefined> {
    try {
      const getter = (this.engine as unknown as { getEffectivePricingTable?: () => Promise<Record<string, any>> })
        .getEffectivePricingTable;
      if (typeof getter === 'function') {
        return await getter.call(this.engine);
      }
    } catch {}
    return undefined;
  }

  private isPaneStillCurrent(paneKey: string, session: ActivePaneSession, metrics: ConversationHudMetrics, seq: number): boolean {
    const latest = this.activePanes.get(paneKey);
    return Boolean(
      latest &&
      latest === session &&
      latest.conversationId === metrics.conversationId &&
      latest.sessionRevision <= metrics.sessionRevision &&
      latest.metricsSequence <= seq
    );
  }

  private computeMetricsFingerprint(metrics: ConversationHudMetrics): string {
    const sessionForFingerprint = metrics.isStreaming
      ? {
          ...metrics.session,
          currentTurnDurationSeconds: 0,
          currentTurnDurationFormatted: '',
          currentTurnDurationFormattedEn: '',
          currentTurnDurationCompactZh: '',
          currentTurnDurationCompactEn: '',
          currentTurnModelDurationSeconds: 0,
          currentTurnToolDurationSeconds: 0,
          inFlightModelDurationSeconds: 0,
          inFlightToolDurationSeconds: 0,
          hasTurnDurationAnchor: (metrics.session.currentTurnDurationSeconds ?? 0) > 0,
          hasInFlightModelAnchor: (metrics.session.inFlightModelDurationSeconds ?? 0) > 0,
          hasInFlightToolAnchor: (metrics.session.inFlightToolDurationSeconds ?? 0) > 0,
        }
      : {
          ...metrics.session,
          currentTurnDurationSeconds: Math.round(metrics.session.currentTurnDurationSeconds ?? 0),
          currentTurnModelDurationSeconds: Math.round(metrics.session.currentTurnModelDurationSeconds ?? 0),
          currentTurnToolDurationSeconds: Math.round(metrics.session.currentTurnToolDurationSeconds ?? 0),
          inFlightModelDurationSeconds: Math.round(metrics.session.inFlightModelDurationSeconds ?? 0),
          inFlightToolDurationSeconds: Math.round(metrics.session.inFlightToolDurationSeconds ?? 0),
        };
    return JSON.stringify({
      session: sessionForFingerprint,
      tokens: metrics.tokens,
      context: metrics.context,
      availability: metrics.availability,
      sourceKind: metrics.sourceKind ?? 'local',
      remoteHostLabel: metrics.remoteHostLabel ?? '',
      observedAt: metrics.isStreaming && metrics.availability === 'ready' ? 0 : metrics.observedAt,
      lastSuccessAt: metrics.availability === 'remote_stale' ? metrics.lastSuccessAt : undefined,
      failedChildCount: metrics.failedChildCount,
      isStreaming: metrics.isStreaming,
      activityPhase: metrics.activityPhase,
      isSubagentRunning: metrics.isSubagentRunning,
      runningSubagentCount: metrics.runningSubagentCount,
    });
  }

  private async commitMetricsIfChanged(
    paneKey: string,
    session: ActivePaneSession,
    metrics: ConversationHudMetrics,
    nextSeq: number,
    forcePush: boolean
  ): Promise<void> {
    if (!this.isPaneStillCurrent(paneKey, session, metrics, nextSeq)) {
      return;
    }
    const fingerprint = this.computeMetricsFingerprint(metrics);
    if (!forcePush && session.lastMetricsKey === fingerprint) {
      session.metricsSequence = Math.max(session.metricsSequence, nextSeq);
      return;
    }
    const pushed = await this.pushMetricsToTarget(session.targetId, metrics);
    if (pushed) {
      session.metricsSequence = nextSeq;
      session.lastMetricsKey = fingerprint;
      session.lastUpdatedAt = Date.now();
      session.isStreaming = Boolean(session.foregroundStreaming || metrics.isStreaming);
      session.activityPhase =
        metrics.activityPhase ?? (session.foregroundStreaming ? 'generating' : 'idle');
      if (session.foregroundStreaming || metrics.isStreaming || metrics.isSubagentRunning) {
        session.lastActivityAt = Date.now();
      }
      if (metrics.availability === 'partial' || metrics.availability === 'cached') {
        const attempts = session.autoHealAttempts ?? 0;
        if (attempts < 5) {
          session.autoHealAttempts = attempts + 1;
          session.lastActivityAt = Date.now();
        }
      } else {
        session.autoHealAttempts = 0;
      }
    }
  }

  private async refreshRemotePaneMetrics(
    paneKey: string,
    session: ActivePaneSession,
    target: AttachedTargetEntry,
    forcePush: boolean,
    recomputeFromCacheOnly = false
  ): Promise<void> {
    const nextSeq = ++this.sequenceCounter;
    const remoteKey = target.remoteKey ?? session.targetId;
    const origin = target.origin ?? '';
    const cacheKey = this.buildRemoteCacheKey(remoteKey, origin, session.conversationId);
    const cached = origin ? this.remoteSessionCache.get(cacheKey) : undefined;
    const pricingTable = await this.resolvePricingForRemote();

    if (recomputeFromCacheOnly) {
      if (cached) {
        const recomputed = computeRemoteConversationHudMetrics({
          conversationId: session.conversationId,
          paneSlotId: session.paneSlotId,
          sessionRevision: session.sessionRevision,
          metricsSequence: nextSeq,
          availability: cached.isStale
            ? 'remote_stale'
            : cached.failedChildCount > 0 || cached.hasUncollectedChildren
            ? 'partial'
            : 'ready',
          observedAt: cached.lastSuccessAt,
          lastSuccessAt: cached.lastSuccessAt,
          allowDbActiveStepInference: !cached.isStale,
          isStreaming: cached.isStale ? false : session.foregroundStreaming,
          activityPhase: cached.isStale ? 'idle' : session.activityPhase,
          isSubagentRunning: cached.isStale ? false : session.isSubagentRunning,
          runningSubagentCount: cached.isStale ? 0 : session.runningSubagentCount,
          modelId: session.modelId,
          modelCapacity: session.modelCapacity,
          pricingTable,
          summary: cached.summary,
          steps: cached.steps,
          generatorMetadata: cached.generatorMetadata,
          executorMetadata: cached.executorMetadata,
          childTrajectories: cached.childTrajectories,
          failedChildCount: cached.failedChildCount,
          remoteHostLabel: target.hostLabel,
        });
        cached.lastMetrics = recomputed;
        this.setRemoteCacheEntry(cached);
        await this.commitMetricsIfChanged(paneKey, session, recomputed, nextSeq, forcePush);
        return;
      }
      const unbridged = this.buildRemoteUnbridgedMetrics(session, target, nextSeq);
      await this.commitMetricsIfChanged(paneKey, session, unbridged, nextSeq, forcePush);
      return;
    }

    const rpc = target.rpcClient;
    if (!rpc) {
      const unbridged = this.buildRemoteUnbridgedMetrics(session, target, nextSeq);
      await this.commitMetricsIfChanged(paneKey, session, unbridged, nextSeq, forcePush);
      return;
    }

    const fallbackToStaleOrUnbridged = async (authExpired: boolean): Promise<void> => {
      if (!authExpired && cached && origin) {
        cached.isStale = true;
        this.setRemoteCacheEntry(cached);
        const staleMetrics = computeRemoteConversationHudMetrics({
          conversationId: session.conversationId,
          paneSlotId: session.paneSlotId,
          sessionRevision: session.sessionRevision,
          metricsSequence: nextSeq,
          availability: 'remote_stale',
          observedAt: cached.lastSuccessAt,
          lastSuccessAt: cached.lastSuccessAt,
          allowDbActiveStepInference: false,
          isStreaming: false,
          activityPhase: 'idle',
          isSubagentRunning: false,
          runningSubagentCount: 0,
          modelId: session.modelId,
          modelCapacity: session.modelCapacity,
          pricingTable,
          summary: cached.summary,
          steps: cached.steps,
          generatorMetadata: cached.generatorMetadata,
          executorMetadata: cached.executorMetadata,
          childTrajectories: cached.childTrajectories,
          failedChildCount: cached.failedChildCount,
          remoteHostLabel: target.hostLabel,
        });
        cached.lastMetrics = staleMetrics;
        await this.commitMetricsIfChanged(paneKey, session, staleMetrics, nextSeq, forcePush);
        return;
      }
      const unbridged = this.buildRemoteUnbridgedMetrics(session, target, nextSeq);
      await this.commitMetricsIfChanged(paneKey, session, unbridged, nextSeq, forcePush);
    };

    const [trajectoriesRes, stepsRes, genRes, execMetaRes] = await Promise.all([
      rpc.getAllCascadeTrajectories(),
      rpc.getTrajectorySteps(session.conversationId, 0),
      rpc.getGeneratorMetadata(session.conversationId, 0),
      typeof rpc.getExecutorMetadata === 'function'
        ? rpc.getExecutorMetadata(session.conversationId)
        : Promise.resolve({ ok: true as const, data: null as ParsedExecutorMetadata | null, latencyMs: 0 }),
    ]);

    if (
      (trajectoriesRes.ok === false && trajectoriesRes.authExpired) ||
      (stepsRes.ok === false && stepsRes.authExpired) ||
      (genRes.ok === false && genRes.authExpired) ||
      (execMetaRes.ok === false && execMetaRes.authExpired)
    ) {
      await fallbackToStaleOrUnbridged(true);
      return;
    }

    if (!stepsRes.ok && !genRes.ok) {
      await fallbackToStaleOrUnbridged(false);
      return;
    }

    const allSummaries = trajectoriesRes.ok ? trajectoriesRes.data : [];
    const mainSummary = allSummaries.find(s => s.cascadeId === session.conversationId) ?? null;
    const summaryById = new Map(allSummaries.map(s => [s.cascadeId, s]));
    const childIdSet = new Set<string>();
    const lineageIds = new Set<string>([session.conversationId]);
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const sum of allSummaries) {
        if (childIdSet.has(sum.cascadeId) || sum.cascadeId === session.conversationId) continue;
        if (!isStrictSubagentSummary(sum.cascadeId, sum)) continue;
        if (
          (sum.parentConversationId && lineageIds.has(sum.parentConversationId)) ||
          (sum.rootConversationId && lineageIds.has(sum.rootConversationId))
        ) {
          childIdSet.add(sum.cascadeId);
          lineageIds.add(sum.cascadeId);
          expanded = true;
        }
      }
    }
    for (const hintId of session.childConversationIds) {
      if (!hintId || hintId === session.conversationId || childIdSet.has(hintId)) continue;
      const cSum = summaryById.get(hintId);
      if (
        cSum &&
        isStrictSubagentSummary(cSum.cascadeId, cSum) &&
        ((cSum.parentConversationId && lineageIds.has(cSum.parentConversationId)) ||
          (cSum.rootConversationId && lineageIds.has(cSum.rootConversationId)))
      ) {
        childIdSet.add(cSum.cascadeId);
      }
    }
    childIdSet.delete(session.conversationId);

    const allChildIds = [...childIdSet];
    const cachedByChildId = new Map(
      (cached?.childTrajectories ?? []).map(entry => [entry.cascadeId, entry])
    );
    const buildChildSignature = (cSum: RemoteTrajectorySummary | null | undefined): string => {
      if (!cSum) return '';
      const count = Number(cSum.stepCount) || 0;
      const lastMod = cSum.lastModifiedTime !== undefined ? JSON.stringify(cSum.lastModifiedTime) : '';
      const statusStr = cSum.status !== undefined ? String(cSum.status) : '';
      return `${count}|${lastMod}|${statusStr}`;
    };

    const childTrajectoriesById = new Map<string, RemoteChildTrajectoryCache>();
    const needFetchIds: string[] = [];
    for (const cid of allChildIds) {
      const cSum = summaryById.get(cid) ?? null;
      const prevChild = cachedByChildId.get(cid);
      const sig = buildChildSignature(cSum);
      if (prevChild?.isTerminal && sig && sig !== '0||' && prevChild.signature === sig) {
        childTrajectoriesById.set(cid, {
          ...prevChild,
          summary: cSum ?? prevChild.summary,
        });
      } else {
        needFetchIds.push(cid);
      }
    }

    const REMOTE_CHILD_FETCH_BUDGET = 32;
    let childIdsToFetch = needFetchIds;
    let nextChildCursor = 0;
    let uncollectedChildCount = 0;
    if (needFetchIds.length > REMOTE_CHILD_FETCH_BUDGET) {
      const startIdx = (cached?.childCursor ?? 0) % needFetchIds.length;
      const rotated = [...needFetchIds.slice(startIdx), ...needFetchIds.slice(0, startIdx)];
      childIdsToFetch = rotated.slice(0, REMOTE_CHILD_FETCH_BUDGET);
      nextChildCursor = (startIdx + childIdsToFetch.length) % needFetchIds.length;
      for (const deferredCid of rotated.slice(REMOTE_CHILD_FETCH_BUDGET)) {
        const prevChild = cachedByChildId.get(deferredCid);
        if (prevChild) {
          childTrajectoriesById.set(deferredCid, prevChild);
        } else {
          uncollectedChildCount++;
        }
      }
    }

    let failedChildCount = (!stepsRes.ok || !genRes.ok) ? 1 : 0;

    if (childIdsToFetch.length > 0) {
      const REMOTE_CHILD_BATCH_SIZE = 4;
      for (let i = 0; i < childIdsToFetch.length; i += REMOTE_CHILD_BATCH_SIZE) {
        const batch = childIdsToFetch.slice(i, i + REMOTE_CHILD_BATCH_SIZE);
        const childResults = await Promise.all(
          batch.map(async cid => {
            const cSum = summaryById.get(cid) ?? null;
            const [cSteps, cGen] = await Promise.all([
              rpc.getTrajectorySteps(cid, 0, cSum?.stepCount ?? 0),
              rpc.getGeneratorMetadata(cid, 0),
            ]);
            return { cid, cSum, cSteps, cGen };
          })
        );
        for (const item of childResults) {
          if ((item.cSteps.ok === false && item.cSteps.authExpired) || (item.cGen.ok === false && item.cGen.authExpired)) {
            await fallbackToStaleOrUnbridged(true);
            return;
          }
          const prevChild = cachedByChildId.get(item.cid);
          if (!item.cSteps.ok || !item.cGen.ok) {
            failedChildCount++;
          }
          if (!item.cSteps.ok && !item.cGen.ok) {
            if (prevChild) {
              childTrajectoriesById.set(item.cid, prevChild);
            }
            continue;
          }
          const bothOk = item.cSteps.ok && item.cGen.ok;
          const stepsData = item.cSteps.ok ? item.cSteps.data : (prevChild?.steps ?? []);
          const genData = item.cGen.ok ? item.cGen.data : (prevChild?.generatorMetadata ?? []);
          const sig = buildChildSignature(item.cSum);
          const isTerminal = bothOk && Boolean(sig) && sig !== '0||' && isRemoteChildTrajectoryTerminal(item.cSum, stepsData);
          childTrajectoriesById.set(item.cid, {
            cascadeId: item.cid,
            summary: item.cSum ?? prevChild?.summary ?? null,
            steps: stepsData,
            generatorMetadata: genData,
            ...(sig ? { signature: sig } : {}),
            isTerminal,
          });
        }
      }
    }

    const childTrajectories = allChildIds
      .map(cid => childTrajectoriesById.get(cid))
      .filter((entry): entry is RemoteChildTrajectoryCache => Boolean(entry));
    const hasUncollectedChildren = uncollectedChildCount > 0;

    const nowMs = Date.now();
    const steps = stepsRes.ok ? stepsRes.data : [];
    const generatorMetadata = genRes.ok ? genRes.data : [];
    const executorMetadata = execMetaRes.ok ? execMetaRes.data : null;
    const metrics = computeRemoteConversationHudMetrics({
      conversationId: session.conversationId,
      paneSlotId: session.paneSlotId,
      sessionRevision: session.sessionRevision,
      metricsSequence: nextSeq,
      availability: failedChildCount > 0 || hasUncollectedChildren ? 'partial' : 'ready',
      observedAt: nowMs,
      lastSuccessAt: nowMs,
      isStreaming: session.foregroundStreaming,
      activityPhase: session.activityPhase,
      isSubagentRunning: session.isSubagentRunning,
      runningSubagentCount: session.runningSubagentCount,
      modelId: session.modelId,
      modelCapacity: session.modelCapacity,
      pricingTable,
      summary: mainSummary,
      steps,
      generatorMetadata,
      executorMetadata,
      childTrajectories,
      failedChildCount,
      remoteHostLabel: target.hostLabel,
    });

    if (origin) {
      this.setRemoteCacheEntry({
        cacheKey,
        remoteKey,
        origin,
        conversationId: session.conversationId,
        summary: mainSummary,
        steps,
        generatorMetadata,
        executorMetadata,
        childTrajectories,
        childCursor: nextChildCursor,
        hasUncollectedChildren,
        failedChildCount,
        lastMetrics: metrics,
        lastSuccessAt: nowMs,
        isStale: false,
      });
    }

    await this.commitMetricsIfChanged(paneKey, session, metrics, nextSeq, forcePush);
  }

  /**
   * 计算并向指定分栏所在窗口推送最新 ConversationHudMetrics
   */
  public async refreshPaneMetrics(
    paneKey: string,
    forcePush = false,
    options?: { recomputeFromCacheOnly?: boolean }
  ): Promise<void> {
    if (this.disposed) return;
    const session = this.activePanes.get(paneKey);
    if (!session) return;

    const target = this.targets.get(session.targetId);
    const isRemote = target?.sourceKind === 'remote';
    if (isRemote && target) {
      if (this.inFlightPaneRefreshes.has(paneKey) && !options?.recomputeFromCacheOnly) {
        if (forcePush) {
          this.pendingPaneRefreshForce.set(paneKey, true);
        }
        return;
      }
      this.inFlightPaneRefreshes.add(paneKey);
      this.inFlightPaneRefreshCounts.set(paneKey, (this.inFlightPaneRefreshCounts.get(paneKey) ?? 0) + 1);
      try {
        await this.refreshRemotePaneMetrics(
          paneKey,
          session,
          target,
          forcePush,
          options?.recomputeFromCacheOnly === true
        );
      } finally {
        const nextCount = Math.max(0, (this.inFlightPaneRefreshCounts.get(paneKey) ?? 1) - 1);
        if (nextCount === 0) {
          this.inFlightPaneRefreshCounts.delete(paneKey);
          this.inFlightPaneRefreshes.delete(paneKey);
        } else {
          this.inFlightPaneRefreshCounts.set(paneKey, nextCount);
        }
        if (!this.disposed && nextCount === 0 && this.pendingPaneRefreshForce.has(paneKey)) {
          const nextForce = this.pendingPaneRefreshForce.get(paneKey) ?? false;
          this.pendingPaneRefreshForce.delete(paneKey);
          if (this.activePanes.has(paneKey)) {
            void this.refreshPaneMetrics(paneKey, nextForce).catch(() => {});
          }
        }
      }
      return;
    }

    // 本机路径复用 inFlightPaneRefreshes 对周期轮询 (forcePush=false) 去重；
    // 显式事件触发 (forcePush=true) 立即推进并在提交时通过 isPaneStillCurrent 过滤旧包。
    if (!forcePush && this.inFlightPaneRefreshes.has(paneKey)) {
      return;
    }
    this.inFlightPaneRefreshes.add(paneKey);
    this.inFlightPaneRefreshCounts.set(paneKey, (this.inFlightPaneRefreshCounts.get(paneKey) ?? 0) + 1);
    try {
      const nextSeq = ++this.sequenceCounter;
      const metrics = await this.engine.getConversationMetrics({
        conversationId: session.conversationId,
        paneSlotId: session.paneSlotId,
        sessionRevision: session.sessionRevision,
        metricsSequence: nextSeq,
        modelId: session.modelId,
        modelCapacity: session.modelCapacity,
        isStreaming: session.foregroundStreaming,
        activityPhase: session.activityPhase,
        isSubagentRunning: session.isSubagentRunning,
        runningSubagentCount: session.runningSubagentCount,
        childConversationIds: session.childConversationIds,
      });

      await this.commitMetricsIfChanged(paneKey, session, metrics, nextSeq, forcePush);
    } finally {
      const nextCount = Math.max(0, (this.inFlightPaneRefreshCounts.get(paneKey) ?? 1) - 1);
      if (nextCount === 0) {
        this.inFlightPaneRefreshCounts.delete(paneKey);
        this.inFlightPaneRefreshes.delete(paneKey);
      } else {
        this.inFlightPaneRefreshCounts.set(paneKey, nextCount);
      }
    }
  }

  /**
   * 广播度量数据到所有已绑定本机目标窗口（绝不向远端窗口广播本机指标）
   */
  public async broadcastMetrics(metrics: ConversationHudMetrics): Promise<void> {
    if (this.disposed) return;
    await Promise.allSettled(
      [...this.targets.entries()]
        .filter(([, target]) => target.sourceKind !== 'remote')
        .map(([targetId]) => this.pushMetricsToTarget(targetId, metrics))
    );
  }

  private async pushMetricsToTarget(
    targetId: string,
    metrics: ConversationHudMetrics
  ): Promise<boolean> {
    const target = this.targets.get(targetId);
    if (!target) return false;
    const contextId = target.getContextId();
    if (contextId === undefined) return false;
    const serialized = JSON.stringify(metrics);
    try {
      const accepted = await target.cdp.evaluate(
        `((m) => Boolean(globalThis.__gravityboxUpdateHudMetrics ? globalThis.__gravityboxUpdateHudMetrics(m) : globalThis.__GRAVITYBOX_HUD_V1__?.dispatchMetrics?.(m)))(${serialized})`,
        contextId
      );
      return Boolean(accepted);
    } catch {
      // 忽略窗口关闭或导航瞬间的执行上下文失效
      return false;
    }
  }

  /**
   * 定时增量轮询所有活跃会话：
   * - 本机窗口与各远端窗口完全独立调度（慢远端绝不阻塞本机轮询）
   * - 本机：活跃/15s宽限期 300ms，空闲 1000ms
   * - 远端：活跃/15s宽限期 1000ms，空闲 5000ms
   */
  public async pollActiveSessions(force = true): Promise<void> {
    if (this.disposed || this.activePanes.size === 0) return;
    const now = Date.now();
    const localPaneKeys: string[] = [];
    const remotePaneKeysByTarget = new Map<string, string[]>();

    for (const [paneKey, pane] of this.activePanes.entries()) {
      const target = this.targets.get(pane.targetId);
      if (!target) continue;
      if (target.sourceKind === 'remote') {
        const list = remotePaneKeysByTarget.get(pane.targetId) ?? [];
        list.push(paneKey);
        remotePaneKeysByTarget.set(pane.targetId, list);
      } else {
        localPaneKeys.push(paneKey);
      }
    }

    const tasks: Promise<unknown>[] = [];

    if (localPaneKeys.length > 0 && !this.localPollInFlight) {
      let shouldPollLocal = force || this.basePollIntervalMs <= 0;
      if (!shouldPollLocal) {
        const anyLocalActive = localPaneKeys.some((k) => {
          const p = this.activePanes.get(k);
          return Boolean(
            p &&
            (p.isStreaming ||
              p.isSubagentRunning ||
              (p.lastActivityAt && now - p.lastActivityAt < ACTIVITY_GRACE_WINDOW_MS))
          );
        });
        const localInterval = anyLocalActive
          ? Math.min(this.basePollIntervalMs, 300)
          : Math.max(this.basePollIntervalMs, 1000);
        shouldPollLocal = now - this.lastLocalPollStartedAt >= localInterval - 20;
      }
      if (shouldPollLocal) {
        this.localPollInFlight = true;
        this.lastLocalPollStartedAt = now;
        tasks.push(
          Promise.allSettled(localPaneKeys.map((paneKey) => this.refreshPaneMetrics(paneKey, false)))
            .finally(() => {
              this.localPollInFlight = false;
            })
        );
      }
    }

    for (const [targetId, paneKeys] of remotePaneKeysByTarget.entries()) {
      if (this.remotePollInFlightByTarget.get(targetId)) continue;
      let shouldPollRemote = force || this.basePollIntervalMs <= 0;
      if (!shouldPollRemote) {
        const anyRemoteActive = paneKeys.some((k) => {
          const p = this.activePanes.get(k);
          return Boolean(
            p &&
            (p.isStreaming ||
              p.isSubagentRunning ||
              (p.lastActivityAt && now - p.lastActivityAt < ACTIVITY_GRACE_WINDOW_MS))
          );
        });
        const remoteInterval = anyRemoteActive
          ? REMOTE_ACTIVE_POLL_INTERVAL_MS
          : REMOTE_IDLE_POLL_INTERVAL_MS;
        const lastStarted = this.lastRemotePollStartedAtByTarget.get(targetId) ?? 0;
        shouldPollRemote = now - lastStarted >= remoteInterval - 20;
      }
      if (shouldPollRemote) {
        this.remotePollInFlightByTarget.set(targetId, true);
        this.lastRemotePollStartedAtByTarget.set(targetId, now);
        tasks.push(
          Promise.allSettled(paneKeys.map((paneKey) => this.refreshPaneMetrics(paneKey, false)))
            .finally(() => {
              this.remotePollInFlightByTarget.set(targetId, false);
            })
        );
      }
    }

    if (tasks.length > 0) {
      await Promise.allSettled(tasks);
    }
  }

  /**
   * 语言切换后清空各分栏指纹缓存并立即重推本地化后的 HUD 度量快照
   */
  public async refreshAllForLocaleChange(): Promise<void> {
    if (this.disposed || this.activePanes.size === 0) return;
    for (const session of this.activePanes.values()) {
      session.lastMetricsKey = '';
    }
    await Promise.allSettled(
      [...this.activePanes.entries()].map(([paneKey, session]) => {
        const target = this.targets.get(session.targetId);
        return this.refreshPaneMetrics(
          paneKey,
          true,
          target?.sourceKind === 'remote' ? { recomputeFromCacheOnly: true } : undefined
        );
      })
    );
  }

  /**
   * 价格基准同步后使 HUD 定价缓存失效，并立即重推所有活跃分栏的度量快照
   */
  public async refreshAllForPricingChange(): Promise<void> {
    this.engine.invalidatePricingCache();
    await this.refreshAllForLocaleChange();
  }

  public onClientEvent(handler: (event: HudClientEvent) => void): void {
    this.clientEventHandlers.add(handler);
  }

  public getEngine(): ConversationMetricsEngine {
    return this.engine;
  }

  public getActivePanes(): ActivePaneSession[] {
    return [...this.activePanes.values()];
  }

  public dispose(): void {
    this.disposed = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.targets.clear();
    this.activePanes.clear();
    this.remoteSessionCache.clear();
    this.inFlightPaneRefreshes.clear();
    this.inFlightPaneRefreshCounts.clear();
    this.pendingPaneRefreshForce.clear();
    this.remotePollInFlightByTarget.clear();
    this.lastRemotePollStartedAtByTarget.clear();
    this.clientEventHandlers.clear();
    this.engine.clearCache();
  }
}
