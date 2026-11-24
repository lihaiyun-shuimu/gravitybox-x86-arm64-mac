import type { CDP } from './cdp.js';
import type { LiveLanguageServerStatus } from './accounts.js';
import { buildLiveProbeResultFromRpc } from './account-probe.js';
import type { ApiPricingEntry } from './pricing.js';
import {
  buildConversationHudMetrics,
  type ComputeHudMetricsInput,
} from './hud/metrics-engine.js';
import {
  CORTEX_STEP_STATUS,
  RUNNING_SUBAGENT_STEP_STATUSES,
  TERMINAL_ABORTED_STEP_STATUSES,
  TERMINAL_INACTIVE_STEP_STATUSES,
  mapCortexStepStatusToNumeric,
} from './hud/cortex-status.js';
export { mapCortexStepStatusToNumeric };
import type {
  ConversationHudMetrics,
  HudActivityPhase,
  HudDataAvailability,
  ParsedConversationStep,
  ParsedExecutorMetadata,
  ParsedGenMetadata,
} from './hud/types.js';

export type RemoteRpcFailureReason =
  | 'auth_expired'
  | 'context_unavailable'
  | 'timeout'
  | 'http_error'
  | 'rpc_error';

export type RemoteRpcPartialReason =
  | 'http_error'
  | 'timeout'
  | 'rpc_error'
  | 'auth_expired'
  | 'page_limit'
  | 'duplicate_page';

export type RemoteRpcCallResult<T> =
  | {
      ok: true;
      data: T;
      latencyMs: number;
      complete?: boolean;
      nextOffset?: number;
      partialReason?: RemoteRpcPartialReason;
      status?: number;
      authExpired?: boolean;
    }
  | {
      ok: false;
      reason: RemoteRpcFailureReason;
      authExpired: boolean;
      status?: number;
      error?: string;
      latencyMs?: number;
    };

export interface RemoteParentReference {
  parentTrajectoryId?: string;
  parentCascadeId?: string;
  forkStepIndex?: number;
  referenceType?: number | string;
}

export interface RemoteTrajectorySummary {
  cascadeId: string;
  trajectoryId?: string;
  trajectoryType?: number | string;
  status?: string | number;
  stepCount: number;
  parentConversationId?: string;
  rootConversationId?: string;
  parentReferences?: RemoteParentReference[];
  forkStepIndex?: number;
  forkParentCascadeId?: string;
  lastModifiedTime?: unknown;
  requestedModel?: string;
}

export interface RemoteGenMetadataUsage {
  model?: string | number;
  inputTokens?: number | string;
  rawInputTokens?: number | string;
  outputTokens?: number | string;
  cacheReadTokens?: number | string;
  cachedReadTokens?: number | string;
  cacheCreationInputTokens?: number | string;
  cacheWriteTokens?: number | string;
  thinkingOutputTokens?: number | string;
  reasoningTokens?: number | string;
  responseOutputTokens?: number | string;
  candidateTokens?: number | string;
}

export interface RemoteGenMetadataRecord {
  stepIndices: number[];
  executionId?: string;
  usage?: RemoteGenMetadataUsage;
  model?: string | number;
  responseModel?: string;
  modelDisplayName?: string;
  timeToFirstToken?: unknown;
  streamingDuration?: unknown;
  createdAt?: unknown;
  chatStartMetadata?: {
    createdAt?: unknown;
    startTime?: unknown;
    startedAt?: unknown;
    timestamp?: unknown;
  };
  contextWindowMetadata?: {
    estimatedTokensUsed?: number | string;
    maxContextTokens?: number | string;
  };
  plannerModel?: {
    modelName?: string;
    maxTokens?: number | string;
    planModel?: string | number;
    executionModel?: string | number;
  };
}

export interface RemoteStepRecord {
  idx: number;
  type?: string | number;
  status?: string | number;
  metadata?: {
    createdAt?: unknown;
    startedAt?: unknown;
    viewableAt?: unknown;
    completedAt?: unknown;
    finishedGeneratingAt?: unknown;
    generatorModel?: string;
    requestedModel?: string;
    toolCallName?: string;
    executionId?: string;
    modelUsage?: RemoteGenMetadataUsage;
  };
  childConversationIds?: string[];
}

export interface RemoteRpcClientLike {
  probeUserAndQuota(): Promise<RemoteRpcCallResult<LiveLanguageServerStatus>>;
  getAllCascadeTrajectories(): Promise<RemoteRpcCallResult<RemoteTrajectorySummary[]>>;
  getGeneratorMetadata(cascadeId: string, offset?: number): Promise<RemoteRpcCallResult<RemoteGenMetadataRecord[]>>;
  getTrajectorySteps(cascadeId: string, stepOffset?: number, expectedTotal?: number): Promise<RemoteRpcCallResult<RemoteStepRecord[]>>;
  getExecutorMetadata?(cascadeId: string): Promise<RemoteRpcCallResult<ParsedExecutorMetadata | null>>;
}

const SUBAGENT_TOOL_NAME_SET = new Set([
  'invoke_subagent',
  'default_api:invoke_subagent',
  'browser_subagent',
  'start_subagent',
  'spawn_subagent',
]);

function normalizeTokenInt(raw: unknown): number {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (/^\d+$/.test(trimmed)) {
      const parsed = Number(trimmed);
      return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
    }
  }
  return 0;
}

function normalizePositiveInt(raw: unknown): number | undefined {
  const val = normalizeTokenInt(raw);
  return val > 0 ? val : undefined;
}

function normalizeModelEnum(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0) return raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (/^\d+$/.test(trimmed)) {
      const n = Number(trimmed);
      return Number.isSafeInteger(n) && n > 0 ? n : undefined;
    }
    const placeholderMatch = trimmed.match(/^MODEL_PLACEHOLDER_M(\d+)$/i);
    if (placeholderMatch?.[1]) {
      const n = 1000 + Number(placeholderMatch[1]);
      return Number.isSafeInteger(n) && n > 1000 ? n : undefined;
    }
  }
  return undefined;
}

/**
 * 解析 Connect JSON Duration 字段（支持 `"2.487s"`、数值秒或 `{ seconds, nanos }`）。
 */
export function parseConnectDurationSeconds(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw >= 0 ? raw : null;
  }
  if (typeof raw === 'string') {
    const m = raw.trim().match(/^(-?\d+(?:\.\d+)?)\s*s$/i);
    if (!m) return null;
    const val = Number(m[1]);
    return Number.isFinite(val) && val >= 0 ? val : null;
  }
  if (raw && typeof raw === 'object') {
    const rec = raw as { seconds?: unknown; nanos?: unknown };
    const secRaw = typeof rec.seconds === 'string' ? Number(rec.seconds) : Number(rec.seconds ?? 0);
    const nanosRaw = typeof rec.nanos === 'string' ? Number(rec.nanos) : Number(rec.nanos ?? 0);
    if (!Number.isFinite(secRaw) || !Number.isFinite(nanosRaw)) return null;
    const total = secRaw + nanosRaw / 1e9;
    return Number.isFinite(total) && total >= 0 ? total : null;
  }
  return null;
}

/**
 * 解析 Connect JSON Timestamp 字段（支持 RFC3339 字符串、Unix 秒/毫秒数或 `{ seconds, nanos }`）。
 */
export function parseConnectTimestampSeconds(raw: unknown): number | null {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) return null;
    return raw > 1e12 ? raw / 1000 : raw;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const ms = Date.parse(trimmed);
    return Number.isFinite(ms) && ms > 0 ? ms / 1000 : null;
  }
  if (raw && typeof raw === 'object') {
    const rec = raw as { seconds?: unknown; nanos?: unknown };
    const secRaw = typeof rec.seconds === 'string' ? Number(rec.seconds) : Number(rec.seconds ?? 0);
    const nanosRaw = typeof rec.nanos === 'string' ? Number(rec.nanos) : Number(rec.nanos ?? 0);
    if (!Number.isFinite(secRaw) || !Number.isFinite(nanosRaw)) return null;
    const total = secRaw + nanosRaw / 1e9;
    return Number.isFinite(total) && total > 0 ? total : null;
  }
  return null;
}

/**
 * 将 CortexStepType 枚举字符串或数字转换为内部数值 stepType。
 */
export function mapCortexStepTypeToNumeric(rawType: unknown): number {
  if (typeof rawType === 'number') {
    return Number.isSafeInteger(rawType) && rawType >= 0 ? rawType : 16;
  }
  if (typeof rawType !== 'string') return 81;
  const cleaned = rawType.trim().toUpperCase().replace(/^CORTEX_STEP_TYPE_/, '');
  if (!cleaned || cleaned === 'UNSPECIFIED') return 0;
  if (cleaned === 'USER_INPUT') return 14;
  if (cleaned === 'PLANNER_RESPONSE') return 15;
  if (cleaned === 'CHECKPOINT') return 23;
  if (cleaned === 'DONE' || cleaned === 'FINISH' || cleaned === 'NOTIFY_USER' || cleaned === 'EPHEMERAL_MESSAGE') return 2;
  if (
    cleaned === 'INVOKE_SUBAGENT' ||
    cleaned === 'SUBAGENT' ||
    cleaned === 'BROWSER_SUBAGENT' ||
    cleaned === 'START_SUBAGENT' ||
    cleaned === 'SPAWN_SUBAGENT'
  ) {
    return 127;
  }
  if (
    cleaned === 'GENERIC' ||
    cleaned === 'HANDOFF' ||
    cleaned === 'TRANSPARENT_HANDOFF' ||
    cleaned === 'SYSTEM_MESSAGE' ||
    cleaned === 'ERROR_MESSAGE' ||
    cleaned === 'CONVERSATION_HISTORY' ||
    cleaned === 'KNOWLEDGE_ARTIFACTS' ||
    cleaned === 'INITIALIZATION'
  ) {
    return 81;
  }
  return 16;
}

/**
 * 主轨迹自身也会携带 `rootConversationId === cascadeId`，
 * 因此必须结合父会话指针或严格不等判据识别子智能体轨迹。
 */
export function isStrictSubagentSummary(
  cascadeId: string,
  summary: Pick<RemoteTrajectorySummary, 'parentConversationId' | 'rootConversationId' | 'trajectoryType'> | null | undefined
): boolean {
  if (!summary) return false;
  if (summary.trajectoryType !== undefined && summary.trajectoryType !== null) {
    if (summary.trajectoryType === 22 || String(summary.trajectoryType).trim() === '22') return false;
    if (String(summary.trajectoryType).toUpperCase().includes('SIDE_QUESTION')) return false;
  }
  if (summary.parentConversationId) return true;
  return Boolean(summary.rootConversationId && summary.rootConversationId !== cascadeId);
}

function convertRemoteStep(raw: RemoteStepRecord): ParsedConversationStep {
  const meta = raw.metadata;
  const toolCallName = typeof meta?.toolCallName === 'string' && meta.toolCallName.trim()
    ? meta.toolCallName.trim()
    : undefined;
  let stepType = mapCortexStepTypeToNumeric(raw.type);
  if (stepType === 81 && toolCallName) {
    stepType = SUBAGENT_TOOL_NAME_SET.has(toolCallName) ? 127 : 16;
  }
  const status = mapCortexStepStatusToNumeric(raw.status);
  const createdAtSeconds = parseConnectTimestampSeconds(meta?.createdAt);
  const startedAtSeconds = parseConnectTimestampSeconds(meta?.startedAt);
  const firstTokenSeconds = parseConnectTimestampSeconds(meta?.viewableAt);
  const finishedGeneratingSeconds = parseConnectTimestampSeconds(meta?.finishedGeneratingAt);
  const completedAtSeconds = parseConnectTimestampSeconds(meta?.completedAt);

  let startTimeSeconds: number | null;
  let endTimeSeconds: number | null;
  if (stepType === 15) {
    startTimeSeconds = createdAtSeconds ?? startedAtSeconds;
    endTimeSeconds = finishedGeneratingSeconds ?? completedAtSeconds;
  } else {
    const toolEnd = completedAtSeconds ?? finishedGeneratingSeconds;
    endTimeSeconds = toolEnd;
    if (
      startedAtSeconds !== null &&
      (createdAtSeconds === null || startedAtSeconds >= createdAtSeconds) &&
      (toolEnd === null || startedAtSeconds <= toolEnd)
    ) {
      startTimeSeconds = startedAtSeconds;
    } else {
      startTimeSeconds = createdAtSeconds ?? startedAtSeconds;
    }
  }

  const childIds = Array.isArray(raw.childConversationIds)
    ? [...new Set(raw.childConversationIds.filter(id => typeof id === 'string' && id.trim().length > 0))]
    : [];

  const rawUsage = meta?.modelUsage;
  const rawInputTokens = rawUsage ? normalizeTokenInt(rawUsage.inputTokens ?? rawUsage.rawInputTokens) : 0;
  const outputTokens = rawUsage ? normalizeTokenInt(rawUsage.outputTokens) : 0;
  const cacheWriteTokens = rawUsage ? normalizeTokenInt(rawUsage.cacheCreationInputTokens ?? rawUsage.cacheWriteTokens) : 0;
  const cachedReadTokens = rawUsage ? normalizeTokenInt(rawUsage.cacheReadTokens ?? rawUsage.cachedReadTokens) : 0;
  const reasoningTokens = rawUsage ? normalizeTokenInt(rawUsage.thinkingOutputTokens ?? rawUsage.reasoningTokens) : 0;
  const candidateTokens = rawUsage ? normalizeTokenInt(rawUsage.responseOutputTokens ?? rawUsage.candidateTokens) : 0;
  const hasUsage = rawInputTokens + outputTokens + cacheWriteTokens + cachedReadTokens > 0;

  return {
    idx: Number.isSafeInteger(raw.idx) && raw.idx >= 0 ? raw.idx : 0,
    stepType,
    status,
    createdAtSeconds,
    startedAtSeconds,
    startTimeSeconds,
    firstTokenSeconds,
    finishedGeneratingSeconds,
    completedAtSeconds,
    endTimeSeconds,
    executionId: typeof meta?.executionId === 'string' && meta.executionId ? meta.executionId : undefined,
    modelName:
      (typeof meta?.generatorModel === 'string' && meta.generatorModel.trim()) ||
      (typeof meta?.requestedModel === 'string' && meta.requestedModel.trim()) ||
      undefined,
    rawInputTokens,
    outputTokens,
    cacheWriteTokens,
    cachedReadTokens,
    reasoningTokens,
    candidateTokens,
    hasUsage,
    toolCallName,
    isSubagentStep: stepType === 85 || stepType === 127 || Boolean(toolCallName && SUBAGENT_TOOL_NAME_SET.has(toolCallName)),
    ...(childIds.length > 0 ? { childConversationIds: childIds } : {}),
  };
}

function convertRemoteGenMetadata(raw: RemoteGenMetadataRecord): ParsedGenMetadata {
  const out: ParsedGenMetadata = {};
  if (Array.isArray(raw.stepIndices) && raw.stepIndices.length > 0) {
    out.stepIndices = raw.stepIndices.filter((n): n is number => Number.isSafeInteger(n) && n >= 0);
  }
  if (typeof raw.executionId === 'string' && raw.executionId) {
    out.executionId = raw.executionId;
  }
  const usageModelEnum = normalizeModelEnum(raw.usage?.model);
  const chatModelEnum = normalizeModelEnum(raw.model);
  if (chatModelEnum ?? usageModelEnum) {
    out.modelEnum = chatModelEnum ?? usageModelEnum;
  }
  const planModelEnum = normalizeModelEnum(raw.plannerModel?.planModel);
  if (planModelEnum) out.planModelEnum = planModelEnum;
  const executionModelEnum = normalizeModelEnum(raw.plannerModel?.executionModel);
  if (executionModelEnum) out.executionModelEnum = executionModelEnum;
  if (typeof raw.responseModel === 'string' && raw.responseModel.trim()) {
    out.responseModel = raw.responseModel.trim();
  }
  if (typeof raw.modelDisplayName === 'string' && raw.modelDisplayName.trim()) {
    out.modelDisplayName = raw.modelDisplayName.trim();
  }
  const rawPlannerName =
    (typeof raw.plannerModel?.modelName === 'string' && raw.plannerModel.modelName.trim()) ||
    (typeof raw.model === 'string' && raw.model.trim()) ||
    (typeof raw.usage?.model === 'string' && raw.usage.model.trim()) ||
    '';
  if (rawPlannerName) {
    out.plannerModelName = rawPlannerName;
  }
  const ttft = parseConnectDurationSeconds(raw.timeToFirstToken);
  if (ttft !== null) out.timeToFirstTokenSeconds = ttft;
  const stream = parseConnectDurationSeconds(raw.streamingDuration);
  if (stream !== null) out.streamingDurationSeconds = stream;
  const estUsed = normalizePositiveInt(raw.contextWindowMetadata?.estimatedTokensUsed);
  if (estUsed) out.estimatedTokensUsed = estUsed;
  const maxCtx =
    normalizePositiveInt(raw.contextWindowMetadata?.maxContextTokens) ??
    normalizePositiveInt(raw.plannerModel?.maxTokens);
  if (maxCtx) out.maxContextTokens = maxCtx;

  if (raw.usage) {
    out.usage = {
      ...(out.modelEnum ? { modelEnum: out.modelEnum } : {}),
      rawInputTokens: normalizeTokenInt(raw.usage.inputTokens ?? raw.usage.rawInputTokens),
      outputTokens: normalizeTokenInt(raw.usage.outputTokens),
      cacheWriteTokens: normalizeTokenInt(raw.usage.cacheCreationInputTokens ?? raw.usage.cacheWriteTokens),
      cachedReadTokens: normalizeTokenInt(raw.usage.cacheReadTokens ?? raw.usage.cachedReadTokens),
      reasoningTokens: normalizeTokenInt(raw.usage.thinkingOutputTokens ?? raw.usage.reasoningTokens),
      candidateTokens: normalizeTokenInt(raw.usage.responseOutputTokens ?? raw.usage.candidateTokens),
    };
  }
  return out;
}

function linkGenerationsToSteps(
  baseSteps: ParsedConversationStep[],
  genRecords: ReadonlyArray<RemoteGenMetadataRecord>,
  summaryLastModifiedSeconds: number | null,
  isChildTrajectory: boolean
): {
  genMetadata?: ParsedGenMetadata;
  extraUsageGenerations: NonNullable<ComputeHudMetricsInput['extraUsageGenerations']>;
} {
  const generations = genRecords.map(convertRemoteGenMetadata);
  const stepByIndex = new Map(baseSteps.map(step => [step.idx, step]));
  const claimedUsageStepIdxs = new Set<number>();
  const matchedGenIdxs = new Set<number>();

  const resolveCandidate15Steps = (gen: ParsedGenMetadata): ParsedConversationStep[] => {
    const fromIndices = [...new Set(gen.stepIndices ?? [])]
      .map(index => stepByIndex.get(index))
      .filter((step): step is ParsedConversationStep => step?.stepType === 15);
    if (fromIndices.length > 0) return fromIndices;
    if (gen.executionId) {
      return baseSteps.filter(step => step.stepType === 15 && step.executionId === gen.executionId);
    }
    return [];
  };

  const resolveTimestampForGen = (gen: ParsedGenMetadata): number | null => {
    for (const sIdx of gen.stepIndices ?? []) {
      const s = stepByIndex.get(sIdx);
      const ts = s?.startTimeSeconds ?? s?.createdAtSeconds ?? s?.completedAtSeconds ?? null;
      if (ts !== null && ts > 0) return ts;
    }
    if (gen.executionId) {
      const matched = baseSteps.find(s => s.executionId === gen.executionId);
      const ts = matched?.startTimeSeconds ?? matched?.createdAtSeconds ?? matched?.completedAtSeconds ?? null;
      if (ts !== null && ts > 0) return ts;
    }
    return summaryLastModifiedSeconds;
  };

  const stripTiming = (gen: ParsedGenMetadata): ParsedGenMetadata => {
    const { timeToFirstTokenSeconds: _t, streamingDurationSeconds: _s, ...rest } = gen;
    return rest;
  };

  const canAttachTiming = (gen: ParsedGenMetadata, candidateCount: number, step: ParsedConversationStep): boolean =>
    candidateCount === 1 && (!gen.executionId || !step.executionId || step.executionId === gen.executionId);

  const attachCompactionModel = (gen: ParsedGenMetadata): void => {
    if (
      !(
        gen.responseModel ||
        gen.modelDisplayName ||
        gen.plannerModelName ||
        gen.modelEnum ||
        gen.planModelEnum ||
        gen.executionModelEnum ||
        gen.maxContextTokens
      )
    ) {
      return;
    }
    const modelOnly: ParsedGenMetadata = {
      ...(gen.responseModel ? { responseModel: gen.responseModel } : {}),
      ...(gen.modelDisplayName ? { modelDisplayName: gen.modelDisplayName } : {}),
      ...(gen.plannerModelName ? { plannerModelName: gen.plannerModelName } : {}),
      ...(gen.modelEnum ? { modelEnum: gen.modelEnum } : {}),
      ...(gen.planModelEnum ? { planModelEnum: gen.planModelEnum } : {}),
      ...(gen.executionModelEnum ? { executionModelEnum: gen.executionModelEnum } : {}),
      ...(gen.maxContextTokens ? { maxContextTokens: gen.maxContextTokens } : {}),
    };
    for (const sIdx of gen.stepIndices ?? []) {
      const cpStep = stepByIndex.get(sIdx);
      if (
        cpStep &&
        cpStep.stepType === 23 &&
        !cpStep.generation &&
        (!gen.executionId || !cpStep.executionId || cpStep.executionId === gen.executionId)
      ) {
        cpStep.generation = modelOnly;
      }
    }
  };

  // Pre-populate startedAtSeconds from linked step timestamps
  generations.forEach(gen => {
    const resolvedTs = resolveTimestampForGen(gen);
    if (gen.startedAtSeconds === undefined && resolvedTs !== null) {
      gen.startedAtSeconds = resolvedTs;
    }
  });

  // Pass 1a: Exact token-tuple alignment when remote steps carry inline modelUsage
  generations.forEach((gen, genIdx) => {
    const u = gen.usage;
    if (!u) return;
    const uTotal = u.rawInputTokens + u.cachedReadTokens + u.cacheWriteTokens + u.outputTokens;
    if (uTotal <= 0) return;
    const linked = resolveCandidate15Steps(gen);
    const exactMatch = linked.find(
      step =>
        !claimedUsageStepIdxs.has(step.idx) &&
        step.hasUsage &&
        (!gen.executionId || !step.executionId || step.executionId === gen.executionId) &&
        step.rawInputTokens === u.rawInputTokens &&
        step.outputTokens === u.outputTokens &&
        step.cachedReadTokens === u.cachedReadTokens &&
        step.cacheWriteTokens === u.cacheWriteTokens
    );
    if (exactMatch) {
      if (exactMatch.reasoningTokens === 0 && u.reasoningTokens > 0) exactMatch.reasoningTokens = u.reasoningTokens;
      if (exactMatch.candidateTokens === 0 && u.candidateTokens > 0) exactMatch.candidateTokens = u.candidateTokens;
      exactMatch.generation = canAttachTiming(gen, linked.length, exactMatch) ? gen : stripTiming(gen);
      attachCompactionModel(gen);
      claimedUsageStepIdxs.add(exactMatch.idx);
      matchedGenIdxs.add(genIdx);
    }
  });

  // Pass 1b: Token-aware & retry-safe alignment for steps lacking inline modelUsage.
  // When multiple generations target the same single step (retries), pick the final successful generation
  // (preferring outputTokens > 0 and chronologically latest) for step context; earlier retries go to extraUsageGenerations.
  const singleStepCompetitors = new Map<number, number[]>();
  generations.forEach((gen, genIdx) => {
    if (matchedGenIdxs.has(genIdx) || !gen.usage) return;
    const u = gen.usage;
    const uTotal = u.rawInputTokens + u.cachedReadTokens + u.cacheWriteTokens + u.outputTokens;
    if (uTotal <= 0) return;
    const linked = resolveCandidate15Steps(gen).filter(
      step =>
        !claimedUsageStepIdxs.has(step.idx) &&
        !step.hasUsage &&
        (!gen.executionId || !step.executionId || step.executionId === gen.executionId)
    );
    if (linked.length === 1) {
      const targetIdx = linked[0]!.idx;
      const list = singleStepCompetitors.get(targetIdx) ?? [];
      list.push(genIdx);
      singleStepCompetitors.set(targetIdx, list);
    }
  });

  for (const [stepIdx, genIdxList] of singleStepCompetitors.entries()) {
    const targetStep = stepByIndex.get(stepIdx);
    if (!targetStep || claimedUsageStepIdxs.has(stepIdx)) continue;
    // Choose final attempt: prefer outputTokens > 0, then chronologically last genIdx
    let winnerGenIdx = genIdxList[genIdxList.length - 1]!;
    for (let k = genIdxList.length - 1; k >= 0; k--) {
      const candidateIdx = genIdxList[k]!;
      const candidateGen = generations[candidateIdx]!;
      if ((candidateGen.usage?.outputTokens ?? 0) > 0) {
        winnerGenIdx = candidateIdx;
        break;
      }
    }
    const gen = generations[winnerGenIdx]!;
    const u = gen.usage!;
    const linked = resolveCandidate15Steps(gen);
    targetStep.hasUsage = true;
    targetStep.rawInputTokens = u.rawInputTokens;
    targetStep.outputTokens = u.outputTokens;
    targetStep.cacheWriteTokens = u.cacheWriteTokens;
    targetStep.cachedReadTokens = u.cachedReadTokens;
    targetStep.reasoningTokens = u.reasoningTokens;
    targetStep.candidateTokens = u.candidateTokens;
    targetStep.generation = canAttachTiming(gen, linked.length, targetStep) ? gen : stripTiming(gen);
    attachCompactionModel(gen);
    claimedUsageStepIdxs.add(targetStep.idx);
    matchedGenIdxs.add(winnerGenIdx);
  }

  // Pass 1c: Remaining multi-step linked generations (prefer exact executionId + completed step)
  generations.forEach((gen, genIdx) => {
    const linked = resolveCandidate15Steps(gen);
    if (!matchedGenIdxs.has(genIdx) && gen.usage) {
      const u = gen.usage;
      const uTotal = u.rawInputTokens + u.cachedReadTokens + u.cacheWriteTokens + u.outputTokens;
      if (uTotal > 0) {
        const candidates = linked.filter(
          step =>
            !claimedUsageStepIdxs.has(step.idx) &&
            !step.hasUsage &&
            (!gen.executionId || !step.executionId || step.executionId === gen.executionId)
        );
        const targetStep =
          candidates.find(s => Boolean(gen.executionId && s.executionId === gen.executionId) && (s.status === 3 || s.status === 5)) ??
          candidates.find(s => Boolean(gen.executionId && s.executionId === gen.executionId)) ??
          candidates.find(s => s.status === 3 || s.status === 5) ??
          candidates[0];
        if (targetStep) {
          targetStep.hasUsage = true;
          targetStep.rawInputTokens = u.rawInputTokens;
          targetStep.outputTokens = u.outputTokens;
          targetStep.cacheWriteTokens = u.cacheWriteTokens;
          targetStep.cachedReadTokens = u.cachedReadTokens;
          targetStep.reasoningTokens = u.reasoningTokens;
          targetStep.candidateTokens = u.candidateTokens;
          targetStep.generation = canAttachTiming(gen, linked.length, targetStep) ? gen : stripTiming(gen);
          attachCompactionModel(gen);
          claimedUsageStepIdxs.add(targetStep.idx);
          matchedGenIdxs.add(genIdx);
          return;
        }
      }
    }
    if (
      gen.responseModel ||
      gen.modelDisplayName ||
      gen.plannerModelName ||
      gen.modelEnum ||
      gen.planModelEnum ||
      gen.executionModelEnum ||
      gen.maxContextTokens
    ) {
      const modelOnly: ParsedGenMetadata = {
        ...(gen.responseModel ? { responseModel: gen.responseModel } : {}),
        ...(gen.modelDisplayName ? { modelDisplayName: gen.modelDisplayName } : {}),
        ...(gen.plannerModelName ? { plannerModelName: gen.plannerModelName } : {}),
        ...(gen.modelEnum ? { modelEnum: gen.modelEnum } : {}),
        ...(gen.planModelEnum ? { planModelEnum: gen.planModelEnum } : {}),
        ...(gen.executionModelEnum ? { executionModelEnum: gen.executionModelEnum } : {}),
        ...(gen.maxContextTokens ? { maxContextTokens: gen.maxContextTokens } : {}),
      };
      for (const step of linked) {
        if (!step.generation && (!gen.executionId || !step.executionId || step.executionId === gen.executionId)) {
          step.generation = modelOnly;
        }
      }
      attachCompactionModel(gen);
    }
  });

  // Pass 2: leftover billed generations go to extraUsageGenerations with joined timestamps
  const extraUsageGenerations: NonNullable<ComputeHudMetricsInput['extraUsageGenerations']> = [];
  generations.forEach((gen, genIdx) => {
    if (matchedGenIdxs.has(genIdx) || !gen.usage) return;
    const u = gen.usage;
    const uTotal = u.rawInputTokens + u.cachedReadTokens + u.cacheWriteTokens + u.outputTokens;
    if (uTotal <= 0) return;
    extraUsageGenerations.push({
      generation: gen,
      isChildStep: isChildTrajectory,
      timestampSeconds: gen.startedAtSeconds ?? resolveTimestampForGen(gen),
    });
  });

  const latestModelStep = [...baseSteps].reverse().find(s => s.stepType === 15 && s.hasUsage);
  const genMetadata = latestModelStep?.generation ?? generations.at(-1);
  return { genMetadata, extraUsageGenerations };
}

export interface MapRemoteRpcToHudInputParams {
  conversationId: string;
  paneSlotId?: string;
  sessionRevision?: number;
  metricsSequence?: number;
  availability?: HudDataAvailability;
  allowDbActiveStepInference?: boolean;
  observedAt?: number | null;
  lastSuccessAt?: number | null;
  isStreaming?: boolean;
  activityPhase?: HudActivityPhase;
  isSubagentRunning?: boolean;
  runningSubagentCount?: number;
  modelId?: string;
  modelCapacity?: number;
  pricingTable?: Record<string, ApiPricingEntry>;
  summary?: RemoteTrajectorySummary | null;
  steps?: RemoteStepRecord[];
  generatorMetadata?: RemoteGenMetadataRecord[];
  executorMetadata?: ParsedExecutorMetadata | null;
  childTrajectories?: Array<{
    cascadeId: string;
    summary?: RemoteTrajectorySummary | null;
    steps: RemoteStepRecord[];
    generatorMetadata: RemoteGenMetadataRecord[];
  }>;
  failedChildCount?: number;
}

const REMOTE_RUNNING_SUMMARY_RE = /^(?:CASCADE_RUN_STATUS_)?(?:RUNNING|IN_PROGRESS|ACTIVE)$/i;
const REMOTE_NON_RUNNING_SUMMARY_RE = /^(?:CASCADE_RUN_STATUS_)?(?:IDLE|UNSPECIFIED|DONE|COMPLETED|CLEARED|ERROR|CANCELL?ED|KILLED|INTERRUPTED|WAITING|PAUSED|BLOCKED|STANDING[_ -]?BY)$/i;
const REMOTE_TRANSPARENT_STEP_TYPES = new Set([81, 98, 99, 101, 102, 104]);

function isRemoteChildTrajectoryRunning(
  summary: RemoteTrajectorySummary | null | undefined,
  childSteps: readonly ParsedConversationStep[]
): boolean {
  let terminated = false;
  if (summary?.status !== undefined && summary.status !== null) {
    const raw = String(summary.status).trim();
    if (REMOTE_NON_RUNNING_SUMMARY_RE.test(raw) || raw === '0' || raw === '1') {
      terminated = true;
    }
  }
  let explicitActive = false;
  let inspectedTail = false;
  for (let i = childSteps.length - 1; i >= 0; i--) {
    const st = childSteps[i]!;
    if (st.stepType === 14) break;
    if (st.stepType === 2 && (st.status === CORTEX_STEP_STATUS.DONE || st.status === CORTEX_STEP_STATUS.CLEARED)) {
      terminated = true;
      break;
    }
    const isWaitTool = Boolean(st.toolCallName && /^(?:default_api:)?swarm_wait$/i.test(st.toolCallName.trim()));
    if (!inspectedTail && !REMOTE_TRANSPARENT_STEP_TYPES.has(st.stepType)) {
      inspectedTail = true;
      if (
        TERMINAL_ABORTED_STEP_STATUSES.has(st.status) ||
        st.status === CORTEX_STEP_STATUS.WAITING ||
        isWaitTool
      ) {
        terminated = true;
        break;
      }
    }
    if (isWaitTool) {
      if (RUNNING_SUBAGENT_STEP_STATUSES.has(st.status) || st.status === CORTEX_STEP_STATUS.WAITING) {
        terminated = true;
        break;
      }
      continue;
    }
    if (RUNNING_SUBAGENT_STEP_STATUSES.has(st.status)) {
      explicitActive = true;
      break;
    }
  }
  if (explicitActive) return true;
  if (!terminated && summary?.status !== undefined && summary.status !== null) {
    const raw = String(summary.status).trim();
    if (REMOTE_RUNNING_SUMMARY_RE.test(raw) || raw === '2') return true;
  }
  return false;
}

/**
 * 判定远端只读子轨迹是否已处于明确终态（仅当非运行中且存在终态汇总状态或终态尾步时允许复用到期缓存）。
 */
export function isRemoteChildTrajectoryTerminal(
  summary: RemoteTrajectorySummary | null | undefined,
  rawSteps: ReadonlyArray<RemoteStepRecord>
): boolean {
  if (!summary) return false;
  const converted = rawSteps.map(convertRemoteStep);
  if (isRemoteChildTrajectoryRunning(summary, converted)) return false;
  if (summary.status !== undefined && summary.status !== null) {
    const raw = String(summary.status).trim();
    if (REMOTE_NON_RUNNING_SUMMARY_RE.test(raw) || raw === '1') {
      return true;
    }
  }
  for (let i = converted.length - 1; i >= 0; i--) {
    const st = converted[i]!;
    if (REMOTE_TRANSPARENT_STEP_TYPES.has(st.stepType)) continue;
    if (st.stepType === 2 && (st.status === CORTEX_STEP_STATUS.DONE || st.status === CORTEX_STEP_STATUS.CLEARED)) {
      return true;
    }
    return TERMINAL_ABORTED_STEP_STATUSES.has(st.status) || TERMINAL_INACTIVE_STEP_STATUSES.has(st.status);
  }
  return false;
}

/**
 * 将远端 Connect JSON RPC（Summary + Steps + GeneratorMetadata + ExecutorMetadata）映射为 buildConversationHudMetrics 标准输入。
 */
export function mapRemoteRpcToHudInput(params: MapRemoteRpcToHudInputParams): ComputeHudMetricsInput {
  const rawMainSteps = (params.steps ?? []).map(convertRemoteStep);
  const summaryLastModified = parseConnectTimestampSeconds(params.summary?.lastModifiedTime);
  const mainLinked = linkGenerationsToSteps(
    rawMainSteps,
    params.generatorMetadata ?? [],
    summaryLastModified,
    false
  );

  const mainIdLower = params.conversationId.trim().toLowerCase();
  const mainTrajLower = params.summary?.trajectoryId?.trim().toLowerCase() ?? '';
  const forkParentLower = params.summary?.forkParentCascadeId?.trim().toLowerCase();
  const forkStepCutoff = params.summary?.forkStepIndex;
  const hasForkSlice = Boolean(
    typeof forkStepCutoff === 'number' &&
      Number.isSafeInteger(forkStepCutoff) &&
      forkStepCutoff >= 0 &&
      forkStepCutoff < 10_000_000 &&
      (!forkParentLower || (forkParentLower !== mainIdLower && (!mainTrajLower || forkParentLower !== mainTrajLower)))
  );
  const mainSteps = hasForkSlice
    ? rawMainSteps.filter(s => s.idx > forkStepCutoff!)
    : rawMainSteps;

  let ownExtraUsageGenerations = mainLinked.extraUsageGenerations;
  let inheritedContextStep: ParsedConversationStep | undefined;
  let inheritedGenMetadata: ParsedGenMetadata | undefined;
  let effectiveGenMetadata = [...mainSteps].reverse().find(s => s.stepType === 15 && s.hasUsage)?.generation;

  if (hasForkSlice) {
    let hasPreForkSteps = false;
    let maxPreForkTs: number | null = null;
    for (const s of rawMainSteps) {
      if (s.idx > forkStepCutoff!) continue;
      hasPreForkSteps = true;
      for (const ts of [
        s.startTimeSeconds,
        s.createdAtSeconds,
        s.endTimeSeconds,
        s.completedAtSeconds,
        s.finishedGeneratingSeconds,
        s.generation?.startedAtSeconds,
      ]) {
        if (typeof ts === 'number' && Number.isFinite(ts) && ts > 0) {
          maxPreForkTs = maxPreForkTs === null ? ts : Math.max(maxPreForkTs, ts);
        }
      }
    }
    ownExtraUsageGenerations = mainLinked.extraUsageGenerations.filter(item => {
      const indices = item.generation.stepIndices;
      if (indices && indices.length > 0) {
        return indices.every(idx => idx > forkStepCutoff!);
      }
      if (!hasPreForkSteps) {
        return typeof item.timestampSeconds === 'number' && item.timestampSeconds > 0;
      }
      if (maxPreForkTs === null) return false;
      return typeof item.timestampSeconds === 'number' && item.timestampSeconds > maxPreForkTs;
    });
    if (!effectiveGenMetadata) {
      const ownGen = [...(params.generatorMetadata ?? [])]
        .map(convertRemoteGenMetadata)
        .filter(g => g.stepIndices && g.stepIndices.length > 0 && g.stepIndices.every(idx => idx > forkStepCutoff!))
        .at(-1);
      effectiveGenMetadata = ownGen;
    }
    if (!mainSteps.some(s => s.stepType === 15 && s.hasUsage)) {
      inheritedContextStep = [...rawMainSteps]
        .reverse()
        .find(s => s.idx <= forkStepCutoff! && s.stepType === 15 && s.hasUsage);
      inheritedGenMetadata = inheritedContextStep?.generation ?? mainLinked.genMetadata;
    }
  } else if (!effectiveGenMetadata) {
    effectiveGenMetadata = mainLinked.genMetadata;
  }

  const allSteps: ParsedConversationStep[] = [...mainSteps];
  const extraUsageGenerations = [...ownExtraUsageGenerations];
  let subagentSteps = 0;
  let activeChildSubagents = 0;

  for (const child of params.childTrajectories ?? []) {
    const childSteps = (child.steps ?? []).map(s => ({
      ...convertRemoteStep(s),
      isSubagentStep: true,
    }));
    const childLastMod = parseConnectTimestampSeconds(child.summary?.lastModifiedTime) ?? summaryLastModified;
    const childLinked = linkGenerationsToSteps(childSteps, child.generatorMetadata ?? [], childLastMod, true);
    allSteps.push(...childSteps);
    extraUsageGenerations.push(...childLinked.extraUsageGenerations);
    subagentSteps += Math.max(childSteps.length, Number(child.summary?.stepCount) || 0);
    if (isRemoteChildTrajectoryRunning(child.summary, childSteps)) {
      activeChildSubagents++;
    }
  }

  const effectiveRunningSubagents = Math.max(params.runningSubagentCount ?? 0, activeChildSubagents);
  const effectiveSubagentRunning = Boolean(params.isSubagentRunning || effectiveRunningSubagents > 0);

  const fallbackMetaForModel = effectiveGenMetadata ?? inheritedGenMetadata;
  const resolvedModelId =
    params.modelId ||
    fallbackMetaForModel?.responseModel ||
    fallbackMetaForModel?.modelDisplayName ||
    fallbackMetaForModel?.plannerModelName ||
    params.summary?.requestedModel;

  const isBtwTrajectory = Boolean(
    params.summary &&
      params.summary.trajectoryType !== undefined &&
      params.summary.trajectoryType !== null &&
      (params.summary.trajectoryType === 22 ||
        String(params.summary.trajectoryType).trim() === '22' ||
        String(params.summary.trajectoryType).toUpperCase().includes('SIDE_QUESTION'))
  );
  const isSubagentTrajectory = !isBtwTrajectory && !hasForkSlice && isStrictSubagentSummary(params.conversationId, params.summary);
  const ownStepCount = hasForkSlice ? mainSteps.length : (mainSteps.length || params.summary?.stepCount || 0);
  const totalStepsOverride = isSubagentTrajectory
    ? ownStepCount
    : ownStepCount + subagentSteps;

  const availability = params.availability ?? 'ready';
  const allowDbActiveStepInference =
    params.allowDbActiveStepInference ?? availability !== 'remote_stale';

  return {
    conversationId: params.conversationId,
    paneSlotId: params.paneSlotId,
    sessionRevision: params.sessionRevision,
    metricsSequence: params.metricsSequence,
    availability,
    observedAt: params.observedAt ?? Date.now(),
    lastSuccessAt: params.lastSuccessAt ?? Date.now(),
    failedChildCount: params.failedChildCount ?? 0,
    isStreaming: params.isStreaming,
    activityPhase: params.activityPhase,
    isSubagentRunning: effectiveSubagentRunning,
    runningSubagentCount: effectiveRunningSubagents,
    subagentCount: params.childTrajectories?.length ?? 0,
    subagentSteps,
    totalStepsOverride: totalStepsOverride > 0 || hasForkSlice ? totalStepsOverride : undefined,
    allowDbActiveStepInference,
    isSubagentTrajectory,
    ...(isBtwTrajectory ? { isBtwTrajectory: true } : {}),
    ...(inheritedContextStep ? { inheritedContextStep } : {}),
    ...(inheritedGenMetadata ? { inheritedGenMetadata } : {}),
    modelId: resolvedModelId,
    modelCapacity: params.modelCapacity,
    pricingTable: params.pricingTable,
    genMetadata: effectiveGenMetadata,
    executorMetadata: params.executorMetadata ?? undefined,
    extraUsageGenerations: extraUsageGenerations.length > 0 ? extraUsageGenerations : undefined,
    contextSteps: mainSteps,
    steps: allSteps,
  };
}

export function computeRemoteConversationHudMetrics(
  params: MapRemoteRpcToHudInputParams & { remoteHostLabel?: string }
): ConversationHudMetrics {
  const input = mapRemoteRpcToHudInput(params);
  const metrics = buildConversationHudMetrics(input);
  metrics.sourceKind = 'remote';
  if (params.remoteHostLabel) {
    metrics.remoteHostLabel = params.remoteHostLabel;
  }
  return metrics;
}

/**
 * 通过 CDP Isolated World 执行与 SSH 渲染页同源的 Connect JSON RPC 只读查询。
 * 所有凭证均在页面隔离世界内读取与消耗，绝不传出 Node 侧或落盘。
 */
export class SshRemoteRpcClient implements RemoteRpcClientLike {
  private readonly cdp: Pick<CDP, 'evaluate'>;
  private readonly getContextId: () => number | undefined;
  private readonly timeoutMs: number;

  constructor(options: { cdp: Pick<CDP, 'evaluate'>; getContextId: () => number | undefined; timeoutMs?: number }) {
    this.cdp = options.cdp;
    this.getContextId = options.getContextId;
    this.timeoutMs = options.timeoutMs ?? 2500;
  }

  private buildInPageFetchExpression(callsSpecJs: string): string {
    return `(async () => {
      const startedAt = Date.now();
      let token = '';
      try {
        token = typeof localStorage !== 'undefined' ? (localStorage.getItem('agy_session_csrf_token') || '') : '';
      } catch {}
      if (!token) {
        return { ok: false, reason: 'auth_expired', authExpired: true, status: 401, latencyMs: Date.now() - startedAt };
      }
      const invoke = async (method, payload) => {
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = controller ? setTimeout(() => { try { controller.abort(); } catch {} }, ${Math.max(200, Math.floor(this.timeoutMs))}) : null;
        try {
          const res = await fetch('/exa.language_server_pb.LanguageServerService/' + method, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-codeium-csrf-token': token,
            },
            body: JSON.stringify(payload ?? {}),
            signal: controller ? controller.signal : undefined,
          });
          if (res.status === 401 || res.status === 403) {
            return { ok: false, reason: 'auth_expired', authExpired: true, status: res.status };
          }
          if (!res.ok) {
            return { ok: false, reason: 'http_error', authExpired: false, status: res.status };
          }
          const json = await res.json();
          return { ok: true, status: res.status, data: json };
        } catch (err) {
          const name = String(err && err.name || '');
          const isTimeout = /Abort|Timeout/i.test(name);
          return { ok: false, reason: isTimeout ? 'timeout' : 'rpc_error', authExpired: false };
        } finally {
          if (timer) clearTimeout(timer);
        }
      };
      ${callsSpecJs}
    })()`;
  }

  private async evaluateInWorld<T>(expression: string): Promise<RemoteRpcCallResult<T>> {
    const contextId = this.getContextId();
    if (contextId === undefined) {
      return { ok: false, reason: 'context_unavailable', authExpired: false };
    }
    try {
      const result = await this.cdp.evaluate(expression, contextId) as RemoteRpcCallResult<T> | null | undefined;
      if (!result || typeof result !== 'object') {
        return { ok: false, reason: 'rpc_error', authExpired: false };
      }
      return result;
    } catch (error) {
      return {
        ok: false,
        reason: 'rpc_error',
        authExpired: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async probeUserAndQuota(): Promise<RemoteRpcCallResult<LiveLanguageServerStatus>> {
    const script = `
      const [userRes, quotaRes] = await Promise.all([
        invoke('GetUserStatus', {}),
        invoke('RetrieveUserQuotaSummary', {}),
      ]);
      if (!userRes.ok) {
        return { ok: false, reason: userRes.reason, authExpired: Boolean(userRes.authExpired), status: userRes.status, latencyMs: Date.now() - startedAt };
      }
      if (!quotaRes.ok && quotaRes.authExpired) {
        return { ok: false, reason: 'auth_expired', authExpired: true, status: quotaRes.status, latencyMs: Date.now() - startedAt };
      }
      const us = (userRes.data && (userRes.data.userStatus || userRes.data)) || {};
      const trimmedUserStatus = {
        email: us.email,
        name: us.name,
        userTier: us.userTier,
        paidTier: us.paidTier,
        planStatus: us.planStatus,
        cascadeModelConfigData: us.cascadeModelConfigData,
        g1Tier: us.g1Tier,
        g1_tier: us.g1_tier,
        cloudaicompanionProject: us.cloudaicompanionProject,
        projectId: us.projectId,
      };
      const quotaPayload = quotaRes.ok && quotaRes.data ? (quotaRes.data.response || quotaRes.data) : null;
      const quotaSummaryError = !quotaRes.ok ? (quotaRes.reason || (quotaRes.status ? 'HTTP ' + quotaRes.status : 'rpc_error')) : undefined;
      return {
        ok: true,
        latencyMs: Date.now() - startedAt,
        data: { userStatusData: { userStatus: trimmedUserStatus }, quotaSummaryData: quotaPayload, quotaSummaryError },
      };
    `;
    const res = await this.evaluateInWorld<{ userStatusData: any; quotaSummaryData: any; quotaSummaryError?: string }>(
      this.buildInPageFetchExpression(script)
    );
    if (!res.ok) return res;
    const rawUserStatus = res.data.userStatusData?.userStatus ?? {};
    const projectObj = rawUserStatus.cloudaicompanionProject;
    const remoteProjectId =
      typeof rawUserStatus.projectId === 'string' && rawUserStatus.projectId.trim()
        ? rawUserStatus.projectId.trim()
        : typeof projectObj === 'string' && projectObj.trim()
        ? projectObj.trim()
        : typeof projectObj?.id === 'string' && projectObj.id.trim()
        ? projectObj.id.trim()
        : null;
    const probe = buildLiveProbeResultFromRpc(
      res.data.userStatusData,
      res.data.quotaSummaryData,
      undefined,
      {
        sourcePrefix: 'remote_rpc',
        quotaSummaryError: res.data.quotaSummaryError,
        projectId: remoteProjectId,
      }
    );
    if (!probe) {
      return { ok: false, reason: 'rpc_error', authExpired: false, error: 'missing_user_email', latencyMs: res.latencyMs };
    }
    return { ok: true, data: probe, latencyMs: res.latencyMs };
  }

  async getAllCascadeTrajectories(): Promise<RemoteRpcCallResult<RemoteTrajectorySummary[]>> {
    const script = `
      const res = await invoke('GetAllCascadeTrajectories', {});
      if (!res.ok) {
        return { ok: false, reason: res.reason, authExpired: Boolean(res.authExpired), status: res.status, latencyMs: Date.now() - startedAt };
      }
      const raw = res.data && res.data.trajectorySummaries;
      const out = [];
      const MAX_VALID_FORK_STEP_INDEX = 10000000;
      const pickId = (...vals) => {
        for (const v of vals) {
          if (typeof v === 'string') {
            const t = v.trim();
            if (t) return t;
          }
        }
        return undefined;
      };
      const parseValidForkStepIndex = (val) => {
        if (val === undefined || val === null || val === '') return undefined;
        if (typeof val === 'number') {
          return Number.isSafeInteger(val) && val >= 0 && val < MAX_VALID_FORK_STEP_INDEX ? val : undefined;
        }
        if (typeof val === 'string') {
          const t = val.trim();
          if (!/^[0-9]+$/.test(t)) return undefined;
          const n = Number(t);
          return Number.isSafeInteger(n) && n >= 0 && n < MAX_VALID_FORK_STEP_INDEX ? n : undefined;
        }
        return undefined;
      };
      const pushEntry = (cid, s) => {
        if (!cid || !s || typeof s !== 'object') return;
        const tm = s.trajectoryMetadata && typeof s.trajectoryMetadata === 'object' ? s.trajectoryMetadata : {};
        const rawTrajectoryType =
          s.trajectoryType !== undefined
            ? s.trajectoryType
            : tm.trajectoryType !== undefined
            ? tm.trajectoryType
            : s.trajectory_type !== undefined
            ? s.trajectory_type
            : tm.trajectory_type;
        const trajectoryId = pickId(s.trajectoryId, s.trajectory_id, tm.trajectoryId, tm.trajectory_id);
        const parentConversationId = pickId(
          tm.parentConversationId,
          s.parentConversationId,
          tm.parent_conversation_id,
          s.parent_conversation_id
        );
        const rootConversationId = pickId(
          tm.rootConversationId,
          s.rootConversationId,
          tm.root_conversation_id,
          s.root_conversation_id
        );
        const selfIds = new Set();
        const cidNorm = String(cid).trim().toLowerCase();
        if (cidNorm) selfIds.add(cidNorm);
        if (trajectoryId) selfIds.add(trajectoryId.toLowerCase());

        const rawRefsCandidate =
          s.parentReferences !== undefined
            ? s.parentReferences
            : s.parent_references !== undefined
            ? s.parent_references
            : tm.parentReferences !== undefined
            ? tm.parentReferences
            : tm.parent_references !== undefined
            ? tm.parent_references
            : s.parentReference !== undefined
            ? s.parentReference
            : s.parent_reference !== undefined
            ? s.parent_reference
            : tm.parentReference !== undefined
            ? tm.parentReference
            : tm.parent_reference;
        const rawRefsList = Array.isArray(rawRefsCandidate)
          ? rawRefsCandidate
          : rawRefsCandidate && typeof rawRefsCandidate === 'object'
          ? [rawRefsCandidate]
          : [];
        const parentReferences = [];
        let bestForkStepIndex;
        let bestForkParentCascadeId;
        for (const ref of rawRefsList) {
          if (!ref || typeof ref !== 'object') continue;
          const parentCascadeId = pickId(
            ref.parentCascadeId,
            ref.parent_cascade_id,
            ref.parentConversationId,
            ref.parent_conversation_id,
            ref.cascadeId,
            ref.cascade_id,
            ref.parentId,
            ref.parent_id
          );
          const parentTrajectoryId = pickId(
            ref.parentTrajectoryId,
            ref.parent_trajectory_id,
            ref.trajectoryId,
            ref.trajectory_id
          );
          const refForkStepIndex = parseValidForkStepIndex(
            ref.forkStepIndex !== undefined
              ? ref.forkStepIndex
              : ref.fork_step_index !== undefined
              ? ref.fork_step_index
              : ref.stepIndex !== undefined
              ? ref.stepIndex
              : ref.step_index !== undefined
              ? ref.step_index
              : ref.parentStepIndex !== undefined
              ? ref.parentStepIndex
              : ref.parent_step_index !== undefined
              ? ref.parent_step_index
              : ref.forkedAtStepIndex !== undefined
              ? ref.forkedAtStepIndex
              : ref.forked_at_step_index
          );
          const rawRefType = ref.referenceType !== undefined ? ref.referenceType : ref.reference_type;
          const referenceType =
            typeof rawRefType === 'number' || typeof rawRefType === 'string' ? rawRefType : undefined;
          if (!parentCascadeId && !parentTrajectoryId && refForkStepIndex === undefined) continue;
          parentReferences.push({
            ...(parentTrajectoryId ? { parentTrajectoryId } : {}),
            ...(parentCascadeId ? { parentCascadeId } : {}),
            ...(refForkStepIndex !== undefined ? { forkStepIndex: refForkStepIndex } : {}),
            ...(referenceType !== undefined ? { referenceType } : {}),
          });
          const effectiveParentId = parentCascadeId || parentTrajectoryId;
          if (
            effectiveParentId &&
            !selfIds.has(effectiveParentId.toLowerCase()) &&
            refForkStepIndex !== undefined
          ) {
            if (bestForkStepIndex === undefined || refForkStepIndex > bestForkStepIndex) {
              bestForkStepIndex = refForkStepIndex;
              bestForkParentCascadeId = effectiveParentId;
            }
          }
        }
        if (bestForkStepIndex === undefined) {
          const directForkStepIndex = parseValidForkStepIndex(
            s.forkStepIndex !== undefined
              ? s.forkStepIndex
              : s.fork_step_index !== undefined
              ? s.fork_step_index
              : tm.forkStepIndex !== undefined
              ? tm.forkStepIndex
              : tm.fork_step_index !== undefined
              ? tm.fork_step_index
              : s.parentStepIndex !== undefined
              ? s.parentStepIndex
              : s.parent_step_index !== undefined
              ? s.parent_step_index
              : tm.parentStepIndex !== undefined
              ? tm.parentStepIndex
              : tm.parent_step_index !== undefined
              ? tm.parent_step_index
              : s.forkedAtStepIndex !== undefined
              ? s.forkedAtStepIndex
              : s.forked_at_step_index !== undefined
              ? s.forked_at_step_index
              : tm.forkedAtStepIndex !== undefined
              ? tm.forkedAtStepIndex
              : tm.forked_at_step_index
          );
          const directParentId = pickId(
            s.forkParentCascadeId,
            s.fork_parent_cascade_id,
            tm.forkParentCascadeId,
            tm.fork_parent_cascade_id,
            parentConversationId,
            rootConversationId
          );
          if (
            directForkStepIndex !== undefined &&
            directParentId &&
            !selfIds.has(directParentId.toLowerCase())
          ) {
            bestForkStepIndex = directForkStepIndex;
            bestForkParentCascadeId = directParentId;
          }
        }
        out.push({
          cascadeId: String(cid),
          ...(trajectoryId ? { trajectoryId } : {}),
          ...(rawTrajectoryType !== undefined && rawTrajectoryType !== null ? { trajectoryType: rawTrajectoryType } : {}),
          ...(s.status !== undefined ? { status: s.status } : {}),
          stepCount: typeof s.stepCount === 'number' ? s.stepCount : (Number(s.stepCount) || 0),
          ...(parentConversationId ? { parentConversationId } : {}),
          ...(rootConversationId ? { rootConversationId } : {}),
          ...(parentReferences.length > 0 ? { parentReferences } : {}),
          ...(bestForkStepIndex !== undefined ? { forkStepIndex: bestForkStepIndex } : {}),
          ...(bestForkParentCascadeId ? { forkParentCascadeId: bestForkParentCascadeId } : {}),
          ...(s.lastModifiedTime !== undefined ? { lastModifiedTime: s.lastModifiedTime } : {}),
          ...(typeof (s.requestedModel || tm.model) === 'string' ? { requestedModel: s.requestedModel || tm.model } : {}),
        });
      };
      if (Array.isArray(raw)) {
        for (const item of raw) pushEntry(item && (item.cascadeId || item.id), item);
      } else if (raw && typeof raw === 'object') {
        for (const [cid, s] of Object.entries(raw)) pushEntry(cid, s);
      }
      return { ok: true, data: out, latencyMs: Date.now() - startedAt };
    `;
    return this.evaluateInWorld<RemoteTrajectorySummary[]>(this.buildInPageFetchExpression(script));
  }

  async getGeneratorMetadata(
    cascadeId: string,
    offset = 0
  ): Promise<RemoteRpcCallResult<RemoteGenMetadataRecord[]>> {
    const safeOffset = Math.max(0, Math.floor(offset));
    const cidJson = JSON.stringify(cascadeId);
    const script = `
      const allOut = [];
      let curOffset = ${safeOffset};
      const MAX_PAGES = 40;
      const PAGE_THRESHOLD = 50;
      let prevPageSig = '';
      let complete = true;
      let partialReason = undefined;
      let partialStatus = undefined;
      let partialAuthExpired = false;
      for (let page = 0; page < MAX_PAGES; page++) {
        const res = await invoke('GetCascadeTrajectoryGeneratorMetadata', {
          cascadeId: ${cidJson},
          includeMessages: false,
          generatorMetadataOffset: curOffset,
        });
        if (!res.ok) {
          if (page === 0) {
            return { ok: false, reason: res.reason, authExpired: Boolean(res.authExpired), status: res.status, latencyMs: Date.now() - startedAt };
          }
          complete = false;
          partialReason = res.authExpired ? 'auth_expired' : (res.reason || 'rpc_error');
          partialStatus = res.status;
          partialAuthExpired = Boolean(res.authExpired);
          break;
        }
        const list = Array.isArray(res.data && res.data.generatorMetadata) ? res.data.generatorMetadata : [];
        if (list.length === 0) break;
        const pageMapped = list.map((item) => {
          const cm = item && item.chatModel && typeof item.chatModel === 'object' ? item.chatModel : {};
          const u = cm.usage && typeof cm.usage === 'object' ? cm.usage : null;
          const csm = cm.chatStartMetadata && typeof cm.chatStartMetadata === 'object' ? cm.chatStartMetadata : null;
          const cwm = csm && csm.contextWindowMetadata && typeof csm.contextWindowMetadata === 'object'
            ? csm.contextWindowMetadata
            : null;
          const rawCreatedAt =
            (csm && (
              csm.createdAt !== undefined ? csm.createdAt :
              csm.created_at !== undefined ? csm.created_at :
              csm.startTime !== undefined ? csm.startTime :
              csm.start_time !== undefined ? csm.start_time :
              csm.startedAt !== undefined ? csm.startedAt :
              csm.started_at !== undefined ? csm.started_at :
              csm.timestamp !== undefined ? csm.timestamp :
              csm.chatStartTimestamp
            )) ??
            (cm.createdAt !== undefined ? cm.createdAt : cm.created_at !== undefined ? cm.created_at : cm.timestamp) ??
            (item && (item.createdAt !== undefined ? item.createdAt : item.created_at));
          const pc = item && item.plannerConfig && typeof item.plannerConfig === 'object' ? item.plannerConfig : null;
          const pec = pc && pc.planExecuteConfig && typeof pc.planExecuteConfig === 'object' ? pc.planExecuteConfig : null;
          return {
            stepIndices: Array.isArray(item && item.stepIndices)
              ? item.stepIndices.map(Number).filter((n) => Number.isSafeInteger(n) && n >= 0)
              : [],
            ...(typeof (item && item.executionId) === 'string' ? { executionId: item.executionId } : {}),
            ...(rawCreatedAt !== undefined && rawCreatedAt !== null ? { createdAt: rawCreatedAt } : {}),
            ...(u ? {
              usage: {
                ...(u.model !== undefined ? { model: u.model } : {}),
                ...(u.inputTokens !== undefined ? { inputTokens: u.inputTokens } : {}),
                ...(u.rawInputTokens !== undefined ? { rawInputTokens: u.rawInputTokens } : {}),
                ...(u.outputTokens !== undefined ? { outputTokens: u.outputTokens } : {}),
                ...(u.cacheReadTokens !== undefined ? { cacheReadTokens: u.cacheReadTokens } : {}),
                ...(u.cachedReadTokens !== undefined ? { cachedReadTokens: u.cachedReadTokens } : {}),
                ...(u.cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens: u.cacheCreationInputTokens } : {}),
                ...(u.cacheWriteTokens !== undefined ? { cacheWriteTokens: u.cacheWriteTokens } : {}),
                ...(u.thinkingOutputTokens !== undefined ? { thinkingOutputTokens: u.thinkingOutputTokens } : {}),
                ...(u.reasoningTokens !== undefined ? { reasoningTokens: u.reasoningTokens } : {}),
                ...(u.responseOutputTokens !== undefined ? { responseOutputTokens: u.responseOutputTokens } : {}),
                ...(u.candidateTokens !== undefined ? { candidateTokens: u.candidateTokens } : {}),
              }
            } : {}),
            ...(cm.model !== undefined ? { model: cm.model } : {}),
            ...(typeof cm.responseModel === 'string' ? { responseModel: cm.responseModel } : {}),
            ...(typeof cm.modelDisplayName === 'string' ? { modelDisplayName: cm.modelDisplayName } : {}),
            ...(cm.timeToFirstToken !== undefined ? { timeToFirstToken: cm.timeToFirstToken } : {}),
            ...(cm.streamingDuration !== undefined ? { streamingDuration: cm.streamingDuration } : {}),
            ...(cwm ? {
              contextWindowMetadata: {
                ...(cwm.estimatedTokensUsed !== undefined ? { estimatedTokensUsed: cwm.estimatedTokensUsed } : {}),
                ...(cwm.maxContextTokens !== undefined ? { maxContextTokens: cwm.maxContextTokens } : {}),
              }
            } : {}),
            ...(pc ? {
              plannerModel: {
                ...(typeof (pc.modelName || (pc.customModelInfoOverride && pc.customModelInfoOverride.modelName)) === 'string'
                  ? { modelName: pc.modelName || pc.customModelInfoOverride.modelName }
                  : {}),
                ...((pc.customModelInfoOverride && pc.customModelInfoOverride.maxTokens) || pc.truncationThresholdTokens
                  ? { maxTokens: (pc.customModelInfoOverride && pc.customModelInfoOverride.maxTokens) || pc.truncationThresholdTokens }
                  : {}),
                ...(pc.planModel !== undefined ? { planModel: pc.planModel } : {}),
                ...(pec && pec.executionModel !== undefined ? { executionModel: pec.executionModel } : {}),
              }
            } : {}),
          };
        });
        const first = pageMapped[0];
        const last = pageMapped[pageMapped.length - 1];
        const pageSig = JSON.stringify([pageMapped.length, first && first.executionId, first && first.stepIndices, last && last.executionId, last && last.stepIndices]);
        if (page > 0 && pageSig === prevPageSig) {
          complete = false;
          partialReason = 'duplicate_page';
          break;
        }
        prevPageSig = pageSig;
        for (const row of pageMapped) allOut.push(row);
        const nextOffset = typeof (res.data && res.data.nextOffset) === 'number' && res.data.nextOffset > curOffset
          ? res.data.nextOffset
          : curOffset + list.length;
        const totalCount = Number(res.data && (res.data.totalCount ?? res.data.totalGeneratorMetadata ?? 0)) || 0;
        const hasMore = Boolean(res.data && res.data.hasMore === true) || (totalCount > 0 && nextOffset < totalCount) || list.length >= PAGE_THRESHOLD;
        if (nextOffset <= curOffset) {
          complete = false;
          partialReason = 'duplicate_page';
          break;
        }
        curOffset = nextOffset;
        if (!hasMore) break;
        if (page + 1 >= MAX_PAGES) {
          complete = false;
          partialReason = 'page_limit';
          break;
        }
      }
      return {
        ok: true,
        data: allOut,
        complete,
        nextOffset: curOffset,
        ...(partialReason ? { partialReason } : {}),
        ...(partialStatus !== undefined ? { status: partialStatus } : {}),
        ...(partialAuthExpired ? { authExpired: true } : {}),
        latencyMs: Date.now() - startedAt,
      };
    `;
    return this.evaluateInWorld<RemoteGenMetadataRecord[]>(this.buildInPageFetchExpression(script));
  }

  async getExecutorMetadata(cascadeId: string): Promise<RemoteRpcCallResult<ParsedExecutorMetadata | null>> {
    const reqJson = JSON.stringify({ cascadeId });
    const script = `
      const res = await invoke('GetCascadeTrajectoryExecutorMetadatas', ${reqJson});
      if (!res.ok) {
        if (res.authExpired) {
          return { ok: false, reason: res.reason, authExpired: true, status: res.status, latencyMs: Date.now() - startedAt };
        }
        // Gracefully degrade when older remote language_server does not support this RPC
        return { ok: true, data: null, latencyMs: Date.now() - startedAt };
      }
      const list = Array.isArray(res.data && res.data.executorMetadatas)
        ? res.data.executorMetadatas
        : Array.isArray(res.data && res.data.metadatas)
        ? res.data.metadatas
        : Array.isArray(res.data && res.data.items)
        ? res.data.items
        : [];
      const tail = list.length > 0 ? list[list.length - 1] : (res.data && res.data.executorMetadata ? res.data.executorMetadata : null);
      if (!tail || typeof tail !== 'object') {
        return { ok: true, data: null, latencyMs: Date.now() - startedAt };
      }
      const cc = tail.cascadeConfig && typeof tail.cascadeConfig === 'object' ? tail.cascadeConfig : {};
      const pc = cc.plannerConfig && typeof cc.plannerConfig === 'object' ? cc.plannerConfig : {};
      const pec = pc.planExecuteConfig && typeof pc.planExecuteConfig === 'object' ? pc.planExecuteConfig : {};
      const cpc = cc.checkpointConfig && typeof cc.checkpointConfig === 'object' ? cc.checkpointConfig : {};
      const rawName = typeof (pc.modelName || (pc.customModelInfoOverride && pc.customModelInfoOverride.modelName)) === 'string'
        ? (pc.modelName || pc.customModelInfoOverride.modelName)
        : undefined;
      const rawMax = (pc.customModelInfoOverride && pc.customModelInfoOverride.maxTokens) || pc.truncationThresholdTokens;
      return {
        ok: true,
        latencyMs: Date.now() - startedAt,
        data: {
          ...(pc.planModel !== undefined ? { planModel: pc.planModel } : {}),
          ...(pec.executionModel !== undefined ? { executionModel: pec.executionModel } : {}),
          ...(rawName ? { plannerModelName: rawName } : {}),
          ...(rawMax !== undefined ? { maxContextTokens: rawMax } : {}),
          ...(cpc.maxTokenLimit !== undefined ? { checkpointMaxTokenLimit: cpc.maxTokenLimit } : {}),
        },
      };
    `;
    const res = await this.evaluateInWorld<{
      planModel?: string | number;
      executionModel?: string | number;
      plannerModelName?: string;
      maxContextTokens?: number | string;
      checkpointMaxTokenLimit?: number | string;
    } | null>(this.buildInPageFetchExpression(script));
    if (!res.ok) return res;
    if (!res.data) return { ok: true, data: null, latencyMs: res.latencyMs };
    const planModelEnum = normalizeModelEnum(res.data.planModel);
    const executionModelEnum = normalizeModelEnum(res.data.executionModel);
    const maxContextTokens = normalizePositiveInt(res.data.maxContextTokens);
    const checkpointMaxTokenLimit = normalizePositiveInt(res.data.checkpointMaxTokenLimit);
    const plannerModelName =
      typeof res.data.plannerModelName === 'string' && res.data.plannerModelName.trim()
        ? res.data.plannerModelName.trim()
        : undefined;
    if (!planModelEnum && !executionModelEnum && !maxContextTokens && !checkpointMaxTokenLimit && !plannerModelName) {
      return { ok: true, data: null, latencyMs: res.latencyMs };
    }
    return {
      ok: true,
      latencyMs: res.latencyMs,
      data: {
        ...(planModelEnum ? { planModelEnum } : {}),
        ...(executionModelEnum ? { executionModelEnum } : {}),
        ...(plannerModelName ? { plannerModelName } : {}),
        ...(maxContextTokens ? { maxContextTokens } : {}),
        ...(checkpointMaxTokenLimit ? { checkpointMaxTokenLimit } : {}),
      },
    };
  }

  async getTrajectorySteps(
    cascadeId: string,
    stepOffset = 0,
    expectedTotal = 0
  ): Promise<RemoteRpcCallResult<RemoteStepRecord[]>> {
    const safeOffset = Math.max(0, Math.floor(stepOffset));
    const safeExpectedTotal = Math.max(0, Math.floor(expectedTotal));
    const cidJson = JSON.stringify(cascadeId);
    const script = `
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const collectIds = (step) => {
        const ids = [];
        const add = (val) => {
          if (typeof val === 'string' && uuidRe.test(val.trim())) ids.push(val.trim().toLowerCase());
        };
        if (Array.isArray(step && step.childConversationIds)) step.childConversationIds.forEach(add);
        if (step && step.subagent) add(step.subagent.conversationId || step.subagent.cascadeId);
        if (step && step.invokeSubagent) add(step.invokeSubagent.conversationId || step.invokeSubagent.cascadeId);
        return ids;
      };
      const allOut = [];
      const seenIdx = new Set();
      let curOffset = ${safeOffset};
      const expectedTotal = ${safeExpectedTotal};
      const MAX_PAGES = 40;
      const PAGE_THRESHOLD = 100;
      let complete = true;
      let partialReason = undefined;
      let partialStatus = undefined;
      let partialAuthExpired = false;
      for (let page = 0; page < MAX_PAGES; page++) {
        const res = await invoke('GetCascadeTrajectorySteps', {
          cascadeId: ${cidJson},
          stepOffset: curOffset,
          disableRehydration: true,
        });
        if (!res.ok) {
          if (page === 0) {
            return { ok: false, reason: res.reason, authExpired: Boolean(res.authExpired), status: res.status, latencyMs: Date.now() - startedAt };
          }
          complete = false;
          partialReason = res.authExpired ? 'auth_expired' : (res.reason || 'rpc_error');
          partialStatus = res.status;
          partialAuthExpired = Boolean(res.authExpired);
          break;
        }
        const list = Array.isArray(res.data && res.data.steps) ? res.data.steps : [];
        if (list.length === 0) break;
        let added = 0;
        for (let i = 0; i < list.length; i++) {
          const s = list[i];
          const meta = s && s.metadata && typeof s.metadata === 'object' ? s.metadata : null;
          const toolCallName = meta && meta.toolCall && typeof meta.toolCall.name === 'string'
            ? meta.toolCall.name
            : (meta && typeof meta.toolCallName === 'string' ? meta.toolCallName : undefined);
          const childConversationIds = collectIds(s);
          const idx = typeof (s && s.idx) === 'number' && Number.isSafeInteger(s.idx) ? s.idx : (curOffset + i);
          if (seenIdx.has(idx)) continue;
          seenIdx.add(idx);
          added++;
          const u = meta && meta.modelUsage && typeof meta.modelUsage === 'object' ? meta.modelUsage : null;
          allOut.push({
            idx,
            ...(s && s.type !== undefined ? { type: s.type } : {}),
            ...(s && s.status !== undefined ? { status: s.status } : {}),
            ...(meta ? {
              metadata: {
                ...(meta.createdAt !== undefined ? { createdAt: meta.createdAt } : {}),
                ...(meta.startedAt !== undefined ? { startedAt: meta.startedAt } : {}),
                ...(meta.viewableAt !== undefined ? { viewableAt: meta.viewableAt } : {}),
                ...(meta.completedAt !== undefined ? { completedAt: meta.completedAt } : {}),
                ...(meta.finishedGeneratingAt !== undefined ? { finishedGeneratingAt: meta.finishedGeneratingAt } : {}),
                ...(typeof meta.generatorModel === 'string' ? { generatorModel: meta.generatorModel } : {}),
                ...(typeof meta.requestedModel === 'string' ? { requestedModel: meta.requestedModel } : {}),
                ...(toolCallName ? { toolCallName } : {}),
                ...(typeof meta.executionId === 'string' ? { executionId: meta.executionId } : {}),
                ...(u ? {
                  modelUsage: {
                    ...(u.model !== undefined ? { model: u.model } : {}),
                    ...(u.inputTokens !== undefined ? { inputTokens: u.inputTokens } : {}),
                    ...(u.rawInputTokens !== undefined ? { rawInputTokens: u.rawInputTokens } : {}),
                    ...(u.outputTokens !== undefined ? { outputTokens: u.outputTokens } : {}),
                    ...(u.cacheReadTokens !== undefined ? { cacheReadTokens: u.cacheReadTokens } : {}),
                    ...(u.cachedReadTokens !== undefined ? { cachedReadTokens: u.cachedReadTokens } : {}),
                    ...(u.cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens: u.cacheCreationInputTokens } : {}),
                    ...(u.cacheWriteTokens !== undefined ? { cacheWriteTokens: u.cacheWriteTokens } : {}),
                    ...(u.thinkingOutputTokens !== undefined ? { thinkingOutputTokens: u.thinkingOutputTokens } : {}),
                    ...(u.reasoningTokens !== undefined ? { reasoningTokens: u.reasoningTokens } : {}),
                    ...(u.responseOutputTokens !== undefined ? { responseOutputTokens: u.responseOutputTokens } : {}),
                    ...(u.candidateTokens !== undefined ? { candidateTokens: u.candidateTokens } : {}),
                  }
                } : {}),
              }
            } : {}),
            ...(childConversationIds.length > 0 ? { childConversationIds } : {}),
          });
        }
        if (added === 0) {
          complete = false;
          partialReason = 'duplicate_page';
          break;
        }
        const nextOffset = typeof (res.data && res.data.nextStepOffset) === 'number' && res.data.nextStepOffset > curOffset
          ? res.data.nextStepOffset
          : curOffset + list.length;
        const totalSteps = Number(res.data && (res.data.totalSteps ?? res.data.stepCount ?? 0)) || expectedTotal;
        const hasMore = Boolean(res.data && res.data.hasMore === true) || (totalSteps > 0 && nextOffset < totalSteps) || list.length >= PAGE_THRESHOLD;
        if (nextOffset <= curOffset) {
          complete = false;
          partialReason = 'duplicate_page';
          break;
        }
        curOffset = nextOffset;
        if (!hasMore) break;
        if (page + 1 >= MAX_PAGES) {
          complete = false;
          partialReason = 'page_limit';
          break;
        }
      }
      return {
        ok: true,
        data: allOut,
        complete,
        nextOffset: curOffset,
        ...(partialReason ? { partialReason } : {}),
        ...(partialStatus !== undefined ? { status: partialStatus } : {}),
        ...(partialAuthExpired ? { authExpired: true } : {}),
        latencyMs: Date.now() - startedAt,
      };
    `;
    return this.evaluateInWorld<RemoteStepRecord[]>(this.buildInPageFetchExpression(script));
  }
}
