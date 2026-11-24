import { compactNumber, compactPercent, compactRate, compactUsd, durationText, formatTurnDurationCompact } from '../metric-format.js';
export { formatTurnDurationCompact };
import { bt } from '../i18n.js';
import { lstat, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type {
  ConversationHudMetrics,
  HudActivityPhase,
  HudCapacitySource,
  HudContextStageRole,
  HudDataAvailability,
  HudModelContextStage,
  ParsedConversationStep,
  ParsedExecutorMetadata,
  ParsedGenMetadata,
} from './types.js';
import {
  resolveModelCapacity,
  resolveObservedModelSpecByEnum,
  stripOrchestratorWrapper,
} from './model-catalog.js';
import { resetAndRegisterRemoteModelMetadata } from '../model-catalog.js';
import {
  DEFAULT_API_PRICES,
  isTemporalPricingEntry,
  lookupPricingEntry,
  resolveContextTierPricing,
  resolvePricingFromTable,
  calculateEstimatedUsd,
  type ApiPricingEntry,
} from '../pricing.js';
import { loadRawPricingTable } from '../usage-pricing.js';
import { resolveDatabaseModelFullName } from '../usage-types.js';
import { runHudDbScanInWorker, runSummariesLookupInWorker } from '../sqlite-read.js';
import type { HudWorkerRawStepRow } from '../sqlite-worker.js';
import { decodeVarint64, skipProtobufField } from '../protobuf.js';
import {
  CORTEX_STEP_STATUS,
  ACTIVE_STEP_STATUSES,
  RUNNING_SUBAGENT_STEP_STATUSES,
  TERMINAL_ABORTED_STEP_STATUSES,
  TERMINAL_INACTIVE_STEP_STATUSES,
} from './cortex-status.js';

const UUID_REGEX_GLOBAL = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const TRANSPARENT_HANDOFF_STEP_TYPES = new Set([81, 98, 99, 101, 102, 104]);

function findLastSubstantiveStep<T extends { stepType?: number; step_type?: number }>(
  steps: readonly T[]
): T | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const candidate = steps[i]!;
    const st = candidate.step_type ?? candidate.stepType ?? 0;
    if (!TRANSPARENT_HANDOFF_STEP_TYPES.has(st)) return candidate;
  }
  return steps[steps.length - 1];
}
const SUBAGENT_TOOL_NAMES = new Set([
  'invoke_subagent',
  'default_api:invoke_subagent',
  'browser_subagent',
  'start_subagent',
  'spawn_subagent',
]);
const SUBAGENT_WAITING_TOOL_NAMES = new Set([
  'swarm_wait',
  'default_api:swarm_wait',
]);

function isWaitingSubagentToolName(toolCallName: string | undefined): boolean {
  if (!toolCallName) return false;
  return SUBAGENT_WAITING_TOOL_NAMES.has(toolCallName.trim().toLowerCase());
}
const MAX_CACHED_CONVERSATIONS = 128;
const MAX_TERMINAL_CHILD_CACHE_ENTRIES = 512;
const ACTIVE_DB_RECENCY_MS = 60 * 60 * 1000;
const TURN_STEP_HANDOFF_GRACE_SEC = 600;
const INLINE_BLOB_LIMIT_BYTES = 65_536;
const UTF8_DECODER = new TextDecoder('utf-8');

/**
 * 解析 Protobuf Timestamp / Duration (field 1: 秒数 int64/uint64, field 2: 纳秒数 int32)
 * 完整支持 wireType 0 / 1 / 2 / 5 安全跳过
 */
export function parseProtobufTimestamp(fieldBuf: Uint8Array): number {
  const cursor = { pos: 0 };
  let seconds = 0n;
  let nanos = 0n;
  while (cursor.pos < fieldBuf.length) {
    const tag = Number(decodeVarint64(fieldBuf, cursor));
    if (!tag) break;
    const fieldNum = tag >>> 3;
    const wireType = tag & 0x07;
    if (wireType === 0) {
      const val = decodeVarint64(fieldBuf, cursor);
      if (fieldNum === 1) seconds = val;
      else if (fieldNum === 2) nanos = val;
    } else {
      if (!skipProtobufField(fieldBuf, cursor, wireType)) break;
    }
  }
  return Number(seconds) + Number(nanos) / 1e9;
}

/**
 * 解析 steps.metadata 中的 ModelUsageStats (field 9)
 * subfield 2: input_tokens (uncached input tokens)
 * subfield 3: output_tokens (total completion tokens)
 * subfield 4: cache_write_tokens
 * subfield 5: cache_read_tokens (cached read tokens)
 * subfield 9: thinking_output_tokens (reasoning output tokens)
 * subfield 10: response_output_tokens (candidate output tokens)
 */
export function parseModelUsageStatsField9(usageBuf: Uint8Array): {
  rawInputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cachedReadTokens: number;
  reasoningTokens: number;
  candidateTokens: number;
} {
  const cursor = { pos: 0 };
  let rawInputTokens = 0;
  let outputTokens = 0;
  let cacheWriteTokens = 0;
  let cachedReadTokens = 0;
  let reasoningTokens = 0;
  let candidateTokens = 0;

  while (cursor.pos < usageBuf.length) {
    const tag = Number(decodeVarint64(usageBuf, cursor));
    if (!tag) break;
    const fieldNum = tag >>> 3;
    const wireType = tag & 0x07;
    if (wireType === 0) {
      const val = Number(decodeVarint64(usageBuf, cursor));
      const safeVal = Number.isFinite(val) && val >= 0 ? val : 0;
      if (fieldNum === 2) rawInputTokens = safeVal;
      else if (fieldNum === 3) outputTokens = safeVal;
      else if (fieldNum === 4) cacheWriteTokens = safeVal;
      else if (fieldNum === 5) cachedReadTokens = safeVal;
      else if (fieldNum === 9) reasoningTokens = safeVal;
      else if (fieldNum === 10) candidateTokens = safeVal;
    } else {
      if (!skipProtobufField(usageBuf, cursor, wireType)) break;
    }
  }

  return {
    rawInputTokens,
    outputTokens,
    cacheWriteTokens,
    cachedReadTokens,
    reasoningTokens,
    candidateTokens,
  };
}

/**
 * 解析 ModelInfo (steps.metadata field 24 或 planner_config field 27)
 * subfield 4: max_tokens
 * subfield 8: model_name
 * subfield 12: chat_model_name
 * subfield 20: display_name
 */
function parseModelInfoBlob(buf: Uint8Array): { maxTokens?: number; modelName?: string } {
  const cursor = { pos: 0 };
  let maxTokens: number | undefined;
  let modelName: string | undefined;

  while (cursor.pos < buf.length) {
    const tag = Number(decodeVarint64(buf, cursor));
    if (!tag) break;
    const fieldNum = tag >>> 3;
    const wireType = tag & 0x07;
    if (wireType === 0) {
      const val = Number(decodeVarint64(buf, cursor));
      if (fieldNum === 4 && val > 0) maxTokens = val;
    } else if (wireType === 2) {
      const len = Number(decodeVarint64(buf, cursor));
      if (!Number.isSafeInteger(len) || len < 0 || cursor.pos + len > buf.length) break;
      if ((fieldNum === 8 || fieldNum === 12 || fieldNum === 20) && len > 0 && len < 256) {
        const str = UTF8_DECODER.decode(buf.subarray(cursor.pos, cursor.pos + len)).trim();
        if (str && (!modelName || fieldNum === 20)) modelName = str;
      }
      cursor.pos += len;
    } else {
      if (!skipProtobufField(buf, cursor, wireType)) break;
    }
  }
  return { maxTokens, modelName };
}

/**
 * 解析 ChatToolCall (CortexStepMetadata.field 4)
 * subfield 2: name (e.g. "invoke_subagent", "browser_subagent", "send_message")
 * subfield 3: arguments_json
 */
function parseChatToolCallBlob(buf: Uint8Array): { name?: string; childIds: string[] } {
  const cursor = { pos: 0 };
  let name: string | undefined;
  const candidateSlices: Array<{ start: number; end: number }> = [];

  while (cursor.pos < buf.length) {
    const tag = Number(decodeVarint64(buf, cursor));
    if (!tag) break;
    const fieldNum = tag >>> 3;
    const wireType = tag & 0x07;
    if (wireType === 2) {
      const len = Number(decodeVarint64(buf, cursor));
      if (!Number.isSafeInteger(len) || len < 0 || cursor.pos + len > buf.length) break;
      if (fieldNum === 2 && len > 0 && len < 256) {
        name = UTF8_DECODER.decode(buf.subarray(cursor.pos, cursor.pos + len)).trim();
      } else if ((fieldNum === 3 || fieldNum === 8) && len > 0 && len < 65536) {
        candidateSlices.push({ start: cursor.pos, end: cursor.pos + len });
      }
      cursor.pos += len;
    } else {
      if (!skipProtobufField(buf, cursor, wireType)) break;
    }
  }

  // 仅当工具确实为子智能体调度工具时才提取参数/结果中的子会话 UUID，杜绝 run_command / read_file 参数中的无关 UUID 串号污染
  const childIds = new Set<string>();
  if (name && SUBAGENT_TOOL_NAMES.has(name)) {
    for (const slice of candidateSlices) {
      const jsonStr = UTF8_DECODER.decode(buf.subarray(slice.start, slice.end));
      for (const m of jsonStr.matchAll(UUID_REGEX_GLOBAL)) {
        if (m[0]) childIds.add(m[0].toLowerCase());
      }
    }
  }
  return { name, childIds: [...childIds] };
}

/**
 * 从二进制切片中提取 UUID 字符串（用于 step_type = 127 INVOKE_SUBAGENT 等载荷提取子会话 ID）
 */
function extractUuidsFromBlob(buf: Uint8Array | null | undefined, maxBytes = 65536): string[] {
  if (!buf || buf.length === 0) return [];
  const slice = buf.length > maxBytes ? buf.subarray(0, maxBytes) : buf;
  const text = UTF8_DECODER.decode(slice);
  const found = new Set<string>();
  for (const m of text.matchAll(UUID_REGEX_GLOBAL)) {
    if (m[0]) found.add(m[0].toLowerCase());
  }
  return [...found];
}

const EXACT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function walkStrictProtobufFields(
  buf: Uint8Array,
  onLengthDelimited: (fieldNum: number, subBuf: Uint8Array) => void
): boolean {
  if (!buf || buf.length === 0) return false;
  const cursor = { pos: 0 };
  const pending: Array<{ fieldNum: number; subBuf: Uint8Array }> = [];
  while (cursor.pos < buf.length) {
    let tagNum: number;
    try {
      tagNum = Number(decodeVarint64(buf, cursor));
    } catch {
      return false;
    }
    if (!tagNum) return false;
    const fieldNum = tagNum >>> 3;
    const wireType = tagNum & 0x07;
    if (fieldNum < 1 || fieldNum > 16384) return false;
    if (wireType === 2) {
      let len: number;
      try {
        len = Number(decodeVarint64(buf, cursor));
      } catch {
        return false;
      }
      if (!Number.isSafeInteger(len) || len < 0 || cursor.pos + len > buf.length) return false;
      pending.push({ fieldNum, subBuf: buf.subarray(cursor.pos, cursor.pos + len) });
      cursor.pos += len;
    } else if (wireType === 0 || wireType === 1 || wireType === 5) {
      if (!skipProtobufField(buf, cursor, wireType)) return false;
    } else {
      return false;
    }
  }
  if (cursor.pos !== buf.length) return false;
  for (const item of pending) {
    onLengthDelimited(item.fieldNum, item.subBuf);
  }
  return true;
}

function extractAgentRefConversationId(agentRefBuf: Uint8Array): string | null {
  let foundUuid: string | null = null;
  const valid = walkStrictProtobufFields(agentRefBuf, (fieldNum, subBuf) => {
    if (fieldNum === 1 && subBuf.length === 36 && !foundUuid) {
      const candidate = UTF8_DECODER.decode(subBuf);
      if (EXACT_UUID_RE.test(candidate)) {
        foundUuid = candidate.toLowerCase();
      }
    }
  });
  return valid ? foundUuid : null;
}

/**
 * 从 StepRenderInfo (exa.cortex_pb.StepRenderInfo) 中结构化提取并行子智能体 AgentRef.conversation_id：
 * - field 9: title_parts (TitlePart.field 5 -> AgentRef.field 1)
 * - field 10: content_blocks (ContentBlock.field 4 -> AgentRef.field 1, ContentBlock.field 5 -> StepBlock.field 1 -> StepRenderInfo)
 * 严格验证完整 Protobuf 边界与精确 36 字节 UUID，对 run_command 等普通工具的纯文本/JSON 载荷零误判。
 */
function collectAgentRefsFromStepRenderInfo(
  renderInfoBuf: Uint8Array,
  out: Set<string>,
  depth = 0
): void {
  if (depth > 4 || !renderInfoBuf || renderInfoBuf.length === 0) return;
  walkStrictProtobufFields(renderInfoBuf, (fieldNum, subBuf) => {
    if (fieldNum === 9) {
      walkStrictProtobufFields(subBuf, (partField, partSub) => {
        if (partField === 5) {
          const uuid = extractAgentRefConversationId(partSub);
          if (uuid) out.add(uuid);
        }
      });
    } else if (fieldNum === 10) {
      walkStrictProtobufFields(subBuf, (blockField, blockSub) => {
        if (blockField === 4) {
          const uuid = extractAgentRefConversationId(blockSub);
          if (uuid) out.add(uuid);
        } else if (blockField === 5) {
          walkStrictProtobufFields(blockSub, (stepBlockField, nestedRenderInfo) => {
            if (stepBlockField === 1) {
              collectAgentRefsFromStepRenderInfo(nestedRenderInfo, out, depth + 1);
            }
          });
        }
      });
    }
  });
}

function collectAgentRefsFromStepPayloadOrData(blob: Uint8Array, out: Set<string>): void {
  if (!blob || blob.length === 0) return;
  const beforeSize = out.size;
  collectAgentRefsFromStepRenderInfo(blob, out, 0);
  if (out.size > beforeSize) return;
  // CortexStepGeneric: field 2 (GenericStepResult) -> field 3 (StepRenderInfo)，或外层 oneof 包装
  walkStrictProtobufFields(blob, (outerField, outerSub) => {
    if (outerField === 3) {
      collectAgentRefsFromStepRenderInfo(outerSub, out, 0);
    } else if (outerField === 2 || outerField >= 10) {
      walkStrictProtobufFields(outerSub, (innerField, innerSub) => {
        if (innerField === 3) {
          collectAgentRefsFromStepRenderInfo(innerSub, out, 0);
        } else if (innerField === 2) {
          walkStrictProtobufFields(innerSub, (resField, resSub) => {
            if (resField === 3) {
              collectAgentRefsFromStepRenderInfo(resSub, out, 0);
            }
          });
        }
      });
    }
  });
}

function parentReferences(buf: Uint8Array): Set<string> {
  const references = new Set<string>();
  const cursor = { pos: 0 };
  while (cursor.pos < buf.length) {
    const tag = Number(decodeVarint64(buf, cursor));
    const field = tag >>> 3;
    const wire = tag & 7;
    if ((field === 5 || field === 6) && wire === 2) {
      const length = Number(decodeVarint64(buf, cursor));
      if (!Number.isSafeInteger(length) || cursor.pos + length > buf.length) break;
      if (length === 36) {
        const value = Buffer.from(buf.subarray(cursor.pos, cursor.pos + length)).toString('utf8');
        if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) references.add(value.toLowerCase());
      }
      cursor.pos += length;
    } else if (!skipProtobufField(buf, cursor, wire)) {
      break;
    }
  }
  return references;
}

/**
 * 解析单行 steps.metadata BLOB (CortexStepMetadata)：
 * - field 1: created_at (Timestamp)
 * - field 4: tool_call (ChatToolCall -> field 2: name, field 3: arguments_json)
 * - field 6: viewable_at (Timestamp)
 * - field 7: finished_generating_at (Timestamp)
 * - field 8: completed_at (Timestamp)
 * - field 9: model_usage (ModelUsageStats)
 * - field 22: last_completed_chunk_at (Timestamp)
 * - field 24: model_info (ModelInfo)
 * - field 32: started_at (Timestamp)
 */
export function parseStepMetadataBlob(
  idx: number,
  stepType: number,
  status: number,
  metadataBlob: Uint8Array | Buffer | null | undefined,
  dataBlob?: Uint8Array | Buffer | null | undefined,
  extraSubagentBlobs?: Array<Uint8Array | Buffer | null | undefined>
): ParsedConversationStep {
  const result: ParsedConversationStep = {
    idx,
    stepType,
    status,
    createdAtSeconds: null,
    startedAtSeconds: null,
    startTimeSeconds: null,
    firstTokenSeconds: null,
    finishedGeneratingSeconds: null,
    completedAtSeconds: null,
    endTimeSeconds: null,
    rawInputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cachedReadTokens: 0,
    reasoningTokens: 0,
    candidateTokens: 0,
    hasUsage: false,
    isSubagentStep: stepType === 85 || stepType === 127,
  };

  const childIds = new Set<string>();

  if (metadataBlob && metadataBlob.length > 0) {
    const buf: Uint8Array = metadataBlob;
    const cursor = { pos: 0 };
    let field1CreatedTs: number | null = null;
    let field6ViewableTs: number | null = null;
    let field7FinishedGenTs: number | null = null;
    let field8CompletedTs: number | null = null;
    let field22LastChunkTs: number | null = null;
    let field32StartedTs: number | null = null;

    while (cursor.pos < buf.length) {
      const tag = Number(decodeVarint64(buf, cursor));
      if (!tag) break;
      const fieldNum = tag >>> 3;
      const wireType = tag & 0x07;

      if (wireType === 2) {
        const len = Number(decodeVarint64(buf, cursor));
        if (!Number.isSafeInteger(len) || len < 0 || cursor.pos + len > buf.length) break;
        const subBuf = buf.subarray(cursor.pos, cursor.pos + len);
        cursor.pos += len;

        if (fieldNum === 1) {
          const ts = parseProtobufTimestamp(subBuf);
          if (ts > 0) field1CreatedTs = ts;
        } else if (fieldNum === 4) {
          const toolInfo = parseChatToolCallBlob(subBuf);
          if (toolInfo.name) {
            result.toolCallName = toolInfo.name;
            if (SUBAGENT_TOOL_NAMES.has(toolInfo.name)) {
              result.isSubagentStep = true;
            }
          }
          for (const cid of toolInfo.childIds) childIds.add(cid);
        } else if (fieldNum === 6 && stepType === 15) {
          const ts = parseProtobufTimestamp(subBuf);
          if (ts > 0) field6ViewableTs = ts;
        } else if (fieldNum === 7) {
          const ts = parseProtobufTimestamp(subBuf);
          if (ts > 0) field7FinishedGenTs = ts;
        } else if (fieldNum === 8) {
          const ts = parseProtobufTimestamp(subBuf);
          if (ts > 0) field8CompletedTs = ts;
        } else if (fieldNum === 9 && stepType === 15) {
          const usage = parseModelUsageStatsField9(subBuf);
          const totalUsageTokens =
            usage.rawInputTokens +
            usage.outputTokens +
            usage.cacheWriteTokens +
            usage.cachedReadTokens;
          if (totalUsageTokens > 0) {
            result.hasUsage = true;
            result.rawInputTokens = usage.rawInputTokens;
            result.outputTokens = usage.outputTokens;
            result.cacheWriteTokens = usage.cacheWriteTokens;
            result.cachedReadTokens = usage.cachedReadTokens;
            result.reasoningTokens = usage.reasoningTokens;
            result.candidateTokens = usage.candidateTokens;
          }
        } else if (fieldNum === 12) {
          result.executionId = Buffer.from(subBuf).toString('hex');
        } else if (fieldNum === 22 && stepType === 15) {
          const ts = parseProtobufTimestamp(subBuf);
          if (ts > 0) field22LastChunkTs = ts;
        } else if (fieldNum === 24) {
          const info = parseModelInfoBlob(subBuf);
          if (info.maxTokens) result.modelMaxTokens = info.maxTokens;
          if (info.modelName) result.modelName = info.modelName;
        } else if (fieldNum === 32) {
          const ts = parseProtobufTimestamp(subBuf);
          if (ts > 0) field32StartedTs = ts;
        }
      } else {
        if (!skipProtobufField(buf, cursor, wireType)) break;
      }
    }

    result.createdAtSeconds = field1CreatedTs;
    result.startedAtSeconds = field32StartedTs;
    result.firstTokenSeconds = field6ViewableTs;
    result.finishedGeneratingSeconds = field7FinishedGenTs;
    result.completedAtSeconds = field8CompletedTs;

    if (stepType === 15) {
      // 模型响应步骤 (PLANNER_RESPONSE):
      // 起始时间取 created_at (field 1)；生成结束时间优先取 finished_generating_at (field 7) 或 last_completed_chunk_at (field 22)，回退 completed_at (field 8)
      result.startTimeSeconds = field1CreatedTs ?? field32StartedTs;
      result.endTimeSeconds = field7FinishedGenTs ?? field22LastChunkTs ?? field8CompletedTs;
    } else {
      // 工具调用步骤:
      // 结束时间取 completed_at (field 8) ?? finished_generating_at (field 7)
      // 起始时间若存在有效的 started_at (field 32，代表工具实际开始执行时刻，不含前置排队/审批等待)，优先采用 started_at
      const toolEnd = field8CompletedTs ?? field7FinishedGenTs;
      result.endTimeSeconds = toolEnd;
      if (
        field32StartedTs !== null &&
        (field1CreatedTs === null || field32StartedTs >= field1CreatedTs) &&
        (toolEnd === null || field32StartedTs <= toolEnd)
      ) {
        result.startTimeSeconds = field32StartedTs;
      } else {
        result.startTimeSeconds = field1CreatedTs ?? field32StartedTs;
      }
    }
  }

  // 对 step_type = 85 / 127 / 132（含并行子智能体审计团队 GENERIC 步骤）结构化提取 StepRenderInfo.AgentRef
  if (stepType === 85 || stepType === 127 || stepType === 132) {
    const agentRefIds = new Set<string>();
    if (extraSubagentBlobs && extraSubagentBlobs.length > 0) {
      for (const extra of extraSubagentBlobs) {
        if (!extra || extra.length === 0) continue;
        collectAgentRefsFromStepPayloadOrData(extra, agentRefIds);
      }
    }
    if (dataBlob && dataBlob.length > 0) {
      collectAgentRefsFromStepPayloadOrData(dataBlob, agentRefIds);
    }
    if (agentRefIds.size > 0) {
      result.isSubagentStep = true;
      for (const cid of agentRefIds) {
        childIds.add(cid);
      }
    }
  }

  if (result.isSubagentStep && dataBlob && dataBlob.length > 0) {
    for (const cid of extractUuidsFromBlob(dataBlob)) {
      childIds.add(cid);
    }
  }
  if (result.isSubagentStep && extraSubagentBlobs && extraSubagentBlobs.length > 0) {
    for (const extra of extraSubagentBlobs) {
      if (!extra || extra.length === 0) continue;
      for (const cid of extractUuidsFromBlob(extra)) {
        childIds.add(cid);
      }
    }
  }

  if (childIds.size > 0) {
    result.childConversationIds = [...childIds];
  }

  return result;
}

/**
 * 解析 gen_metadata.data 的真实模型、权威流式耗时与上下文窗口配置 (零大块拷贝，O(fields) 游标跳跃)
 * CortexStepGeneratorMetadata:
 * - field 1: chat_model (ChatModelMetadata)
 *   - field 9: chat_start_metadata -> field 10: context_window_metadata
 *     - field 1: estimated_tokens_used
 *     - field 3: token_breakdown -> field 1: groups (TopLevelTokenGroup: field 2 type, field 4 num_tokens)
 *     - field 4: max_context_tokens
 *   - field 11: time_to_first_token (google.protobuf.Duration)
 *   - field 12: streaming_duration (google.protobuf.Duration)
 *   - field 19: response_model
 *   - field 21: model_display_name
 * - field 3: planner_config (CascadePlannerConfig)
 *   - field 14: truncation_threshold_tokens
 *   - field 27: custom_model_info_override -> field 4: max_tokens
 *   - field 28: model_name
 */
export function parseLatestGenMetadataBlob(
  dataBlob: Uint8Array | Buffer | null | undefined
): ParsedGenMetadata {
  const out: ParsedGenMetadata = {};
  if (!dataBlob || dataBlob.length === 0) return out;

  const buf: Uint8Array = dataBlob;
  const decoder = UTF8_DECODER;
  const cursor = { pos: 0 };

  while (cursor.pos < buf.length) {
    const tag = Number(decodeVarint64(buf, cursor));
    if (!tag) break;
    const fieldNum = tag >>> 3;
    const wireType = tag & 0x07;

    if (wireType === 2) {
      const len = Number(decodeVarint64(buf, cursor));
      if (!Number.isSafeInteger(len) || len < 0 || cursor.pos + len > buf.length) break;
      const subBuf = buf.subarray(cursor.pos, cursor.pos + len);
      cursor.pos += len;

      if (fieldNum === 2) {
        const packed = { pos: 0 };
        out.stepIndices ??= [];
        while (packed.pos < subBuf.length && out.stepIndices.length < 10000) {
          const value = Number(decodeVarint64(subBuf, packed));
          if (Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff) {
            out.stepIndices.push(value);
          }
        }
      } else if (fieldNum === 4) {
        out.executionId = Buffer.from(subBuf).toString('hex');
      } else if (fieldNum === 1) {
        // ChatModelMetadata
        const c1 = { pos: 0 };
        while (c1.pos < subBuf.length) {
          const t1 = Number(decodeVarint64(subBuf, c1));
          if (!t1) break;
          const fn1 = t1 >>> 3;
          const wt1 = t1 & 0x07;
          if (wt1 === 0) {
            const v1 = Number(decodeVarint64(subBuf, c1));
            if (fn1 === 3 && Number.isSafeInteger(v1) && v1 > 0) {
              out.modelEnum = v1;
            }
          } else if (wt1 === 2) {
            const l1 = Number(decodeVarint64(subBuf, c1));
            if (!Number.isSafeInteger(l1) || l1 < 0 || c1.pos + l1 > subBuf.length) break;
            const fieldSlice = subBuf.subarray(c1.pos, c1.pos + l1);
            if (fn1 === 4) {
              out.usage = parseModelUsageStatsField9(fieldSlice);
              if (!out.modelEnum) {
                const cu = { pos: 0 };
                while (cu.pos < fieldSlice.length) {
                  const tu = Number(decodeVarint64(fieldSlice, cu));
                  if (!tu) break;
                  if ((tu & 0x07) === 0) {
                    const vu = Number(decodeVarint64(fieldSlice, cu));
                    if ((tu >>> 3) === 1 && Number.isSafeInteger(vu) && vu > 0) out.modelEnum = vu;
                  } else if (!skipProtobufField(fieldSlice, cu, tu & 0x07)) {
                    break;
                  }
                }
              }
            } else if ((fn1 === 19 || fn1 === 21) && l1 > 0 && l1 < 256) {
              const str = decoder.decode(fieldSlice).trim();
              if (str) {
                if (fn1 === 19) out.responseModel = str;
                else if (fn1 === 21) out.modelDisplayName = str;
              }
            } else if (fn1 === 11 && l1 <= 32) {
              // field 11: time_to_first_token (google.protobuf.Duration)
              const ttftSec = parseProtobufTimestamp(fieldSlice);
              if (ttftSec >= 0 && Number.isFinite(ttftSec)) {
                out.timeToFirstTokenSeconds = ttftSec;
              }
            } else if (fn1 === 12 && l1 <= 32) {
              // field 12: streaming_duration (google.protobuf.Duration)
              const streamSec = parseProtobufTimestamp(fieldSlice);
              if (streamSec >= 0 && Number.isFinite(streamSec)) {
                out.streamingDurationSeconds = streamSec;
              }
            } else if (fn1 === 9) {
              // ChatStartMetadata -> field 4: started_at (Timestamp), field 10: ContextWindowMetadata
              const startBuf = fieldSlice;
              const cStart = { pos: 0 };
              while (cStart.pos < startBuf.length) {
                const tS = Number(decodeVarint64(startBuf, cStart));
                if (!tS) break;
                const fnS = tS >>> 3;
                const wtS = tS & 0x07;
                if (wtS === 2 && fnS === 4) {
                  const lTs = Number(decodeVarint64(startBuf, cStart));
                  if (!Number.isSafeInteger(lTs) || lTs < 0 || cStart.pos + lTs > startBuf.length) break;
                  const tsSec = parseProtobufTimestamp(startBuf.subarray(cStart.pos, cStart.pos + lTs));
                  if (tsSec >= 946684800 && Number.isFinite(tsSec)) {
                    out.startedAtSeconds = tsSec;
                  }
                  cStart.pos += lTs;
                } else if (wtS === 2 && fnS === 10) {
                  const lS = Number(decodeVarint64(startBuf, cStart));
                  if (!Number.isSafeInteger(lS) || lS < 0 || cStart.pos + lS > startBuf.length) break;
                  const cwBuf = startBuf.subarray(cStart.pos, cStart.pos + lS);
                  cStart.pos += lS;
                  const cCw = { pos: 0 };
                  while (cCw.pos < cwBuf.length) {
                    const tCw = Number(decodeVarint64(cwBuf, cCw));
                    if (!tCw) break;
                    const fnCw = tCw >>> 3;
                    const wtCw = tCw & 0x07;
                    if (wtCw === 0) {
                      const val = Number(decodeVarint64(cwBuf, cCw));
                      if (fnCw === 1 && val > 0) out.estimatedTokensUsed = val;
                      else if (fnCw === 4 && val > 0) out.maxContextTokens = val;
                    } else {
                      if (!skipProtobufField(cwBuf, cCw, wtCw)) break;
                    }
                  }
                } else {
                  if (!skipProtobufField(startBuf, cStart, wtS)) break;
                }
              }
            }
            c1.pos += l1;
          } else {
            if (!skipProtobufField(subBuf, c1, wt1)) break;
          }
        }
      } else if (fieldNum === 3) {
        // CascadePlannerConfig
        const parsedPlanner = parseCascadePlannerConfigBlob(subBuf);
        if (parsedPlanner.planModelEnum) out.planModelEnum = parsedPlanner.planModelEnum;
        if (parsedPlanner.executionModelEnum) out.executionModelEnum = parsedPlanner.executionModelEnum;
        if (parsedPlanner.plannerModelName) out.plannerModelName = parsedPlanner.plannerModelName;
        if (parsedPlanner.maxContextTokens && !out.maxContextTokens) {
          out.maxContextTokens = parsedPlanner.maxContextTokens;
        }
      }
    } else if (fieldNum === 2 && wireType === 0) {
      const value = Number(decodeVarint64(buf, cursor));
      if (Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff) {
        (out.stepIndices ??= []).push(value);
      }
    } else {
      if (!skipProtobufField(buf, cursor, wireType)) break;
    }
  }

  return out;
}

function parseCascadePlannerConfigBlob(subBuf: Uint8Array): {
  planModelEnum?: number;
  executionModelEnum?: number;
  plannerModelName?: string;
  maxContextTokens?: number;
} {
  const out: {
    planModelEnum?: number;
    executionModelEnum?: number;
    plannerModelName?: string;
    maxContextTokens?: number;
  } = {};
  const decoder = UTF8_DECODER;
  const c3 = { pos: 0 };
  while (c3.pos < subBuf.length) {
    const t3 = Number(decodeVarint64(subBuf, c3));
    if (!t3) break;
    const fn3 = t3 >>> 3;
    const wt3 = t3 & 0x07;
    if (wt3 === 0) {
      const val = Number(decodeVarint64(subBuf, c3));
      if (fn3 === 1 && Number.isSafeInteger(val) && val > 0) {
        out.planModelEnum = val;
      } else if (fn3 === 14 && val > 0 && !out.maxContextTokens) {
        out.maxContextTokens = val;
      }
    } else if (wt3 === 2) {
      const l3 = Number(decodeVarint64(subBuf, c3));
      if (!Number.isSafeInteger(l3) || l3 < 0 || c3.pos + l3 > subBuf.length) break;
      const fieldSlice = subBuf.subarray(c3.pos, c3.pos + l3);
      if (fn3 === 28 && l3 > 0 && l3 < 256) {
        const str = decoder.decode(fieldSlice).trim();
        if (str) out.plannerModelName = str;
      } else if (fn3 === 27) {
        const info = parseModelInfoBlob(fieldSlice);
        if (info.maxTokens && !out.maxContextTokens) out.maxContextTokens = info.maxTokens;
        if (info.modelName && !out.plannerModelName) out.plannerModelName = info.modelName;
      } else if (fn3 === 60) {
        // plan_execute_config -> field 1: execution_model
        const c60 = { pos: 0 };
        while (c60.pos < fieldSlice.length) {
          const t60 = Number(decodeVarint64(fieldSlice, c60));
          if (!t60) break;
          const fn60 = t60 >>> 3;
          const wt60 = t60 & 0x07;
          if (wt60 === 0) {
            const v60 = Number(decodeVarint64(fieldSlice, c60));
            if (fn60 === 1 && Number.isSafeInteger(v60) && v60 > 0) {
              out.executionModelEnum = v60;
            }
          } else if (!skipProtobufField(fieldSlice, c60, wt60)) {
            break;
          }
        }
      }
      c3.pos += l3;
    } else {
      if (!skipProtobufField(subBuf, c3, wt3)) break;
    }
  }
  return out;
}

/**
 * 解析 executor_metadata.data 的会话级 Plan&Execute 配置与压缩阈值上限：
 * - field 10: cascade_config
 *   - field 1: planner_config (f1: plan_model, f14/f27/f28, f60.1: execution_model)
 *   - field 2: checkpoint_config (f5: max_token_limit)
 */
export function parseExecutorMetadataBlob(
  dataBlob: Uint8Array | Buffer | null | undefined
): ParsedExecutorMetadata {
  const out: ParsedExecutorMetadata = {};
  if (!dataBlob || dataBlob.length === 0) return out;
  const buf: Uint8Array = dataBlob;
  const cursor = { pos: 0 };
  while (cursor.pos < buf.length) {
    const tag = Number(decodeVarint64(buf, cursor));
    if (!tag) break;
    const fieldNum = tag >>> 3;
    const wireType = tag & 0x07;
    if (wireType === 2 && fieldNum === 10) {
      const len = Number(decodeVarint64(buf, cursor));
      if (!Number.isSafeInteger(len) || len < 0 || cursor.pos + len > buf.length) break;
      const ccBuf = buf.subarray(cursor.pos, cursor.pos + len);
      cursor.pos += len;
      const cCc = { pos: 0 };
      while (cCc.pos < ccBuf.length) {
        const tCc = Number(decodeVarint64(ccBuf, cCc));
        if (!tCc) break;
        const fnCc = tCc >>> 3;
        const wtCc = tCc & 0x07;
        if (wtCc === 2) {
          const lCc = Number(decodeVarint64(ccBuf, cCc));
          if (!Number.isSafeInteger(lCc) || lCc < 0 || cCc.pos + lCc > ccBuf.length) break;
          const sub = ccBuf.subarray(cCc.pos, cCc.pos + lCc);
          cCc.pos += lCc;
          if (fnCc === 1) {
            const planner = parseCascadePlannerConfigBlob(sub);
            if (planner.planModelEnum) out.planModelEnum = planner.planModelEnum;
            if (planner.executionModelEnum) out.executionModelEnum = planner.executionModelEnum;
            if (planner.plannerModelName) out.plannerModelName = planner.plannerModelName;
            if (planner.maxContextTokens) out.maxContextTokens = planner.maxContextTokens;
          } else if (fnCc === 2) {
            // checkpoint_config -> field 5: max_token_limit
            const cCp = { pos: 0 };
            while (cCp.pos < sub.length) {
              const tCp = Number(decodeVarint64(sub, cCp));
              if (!tCp) break;
              const fnCp = tCp >>> 3;
              const wtCp = tCp & 0x07;
              if (wtCp === 0) {
                const vCp = Number(decodeVarint64(sub, cCp));
                if (fnCp === 5 && Number.isSafeInteger(vCp) && vCp > 0) {
                  out.checkpointMaxTokenLimit = vCp;
                }
              } else if (!skipProtobufField(sub, cCp, wtCp)) {
                break;
              }
            }
          }
        } else if (!skipProtobufField(ccBuf, cCc, wtCc)) {
          break;
        }
      }
    } else if (!skipProtobufField(buf, cursor, wireType)) {
      break;
    }
  }
  return out;
}

/**
 * 有效输出速度：只对匹配的 Token 与完整正耗时计算，保留未舍入结果。
 */
export function computeTps(
  activeSec: number,
  totalOutputTokens: number,
  minWindow: number = 0
): {
  status: 'pending_or_fallback' | 'calculated';
  rawTps: number | null;
  outputTps: number;
  formatted: string;
} {
  if (!Number.isFinite(activeSec) || activeSec <= 0 || activeSec < minWindow || !Number.isFinite(totalOutputTokens) || totalOutputTokens < 0) {
    return {
      status: 'pending_or_fallback',
      rawTps: null,
      outputTps: 0,
      formatted: '—',
    };
  }
  const rawTps = totalOutputTokens / activeSec;
  return {
    status: 'calculated',
    rawTps,
    outputTps: rawTps,
    formatted: `${compactRate(rawTps)} tok/s`,
  };
}

/**
 * 格式化紧凑 Token 读数 (如 23196078 -> "23.2M", 226412 -> "226K", 8312 -> "8.3K", 999600 -> "1M")
 */
export function formatCompactTokenNumber(tokens: number, prefixTilde = false): string {
  return `${prefixTilde && tokens > 0 ? '~' : ''}${compactNumber(tokens)}`;
}

/**
 * 格式化千分位 Token 读数 (如 "23,196,078 tok")
 */
export function formatThousandsTokens(tokens: number): string {
  const safe = Math.max(0, Math.floor(Number.isFinite(tokens) ? tokens : 0));
  return `${safe.toLocaleString('en-US')} tok`;
}

/**
 * 格式化用时 (如 1348 秒 -> "22分28秒", 360 秒 -> "6分", 3600 秒 -> "1小时", 0 秒 -> "0秒")
 */
export function formatDurationSeconds(seconds: number, lang: 'zh' | 'en' = 'zh'): string { return durationText(seconds, lang); }

/**
 * 格式化本轮用时展开卡片展示 (整数秒，省略零分/零秒；中文使用汉字时分秒，英文使用 h/m/s)
 */
export function formatTurnDurationCard(seconds: number, lang: 'zh' | 'en' = 'zh'): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  return durationText(seconds, lang);
}

/**
 * 格式化 HUD 卡片美元估算金额（0 显示 $0；微额至多 4/6 位小数去尾零；常规至多 2 位小数去尾零；>= $1000 进位）
 */
export function formatHudUsd(usd: number): string {
  return compactUsd(usd);
}



export interface ComputeHudMetricsInput {
  conversationId?: string;
  paneSlotId?: string;
  sessionRevision?: number;
  metricsSequence?: number;
  availability?: HudDataAvailability;
  observedAt?: number | null;
  lastSuccessAt?: number | null;
  failedChildCount?: number;
  isStreaming?: boolean;
  activityPhase?: HudActivityPhase;
  isSubagentRunning?: boolean;
  runningSubagentCount?: number;
  subagentCount?: number;
  subagentSteps?: number;
  totalStepsOverride?: number;
  allowDbActiveStepInference?: boolean;
  isSubagentTrajectory?: boolean;
  isBtwTrajectory?: boolean;
  inheritedContextStep?: ComputeHudMetricsInput['steps'][number];
  inheritedGenMetadata?: ParsedGenMetadata;
  modelId?: string;
  modelCapacity?: number;
  pricingTable?: Record<string, ApiPricingEntry>;
  genMetadata?: ParsedGenMetadata;
  executorMetadata?: ParsedExecutorMetadata;
  extraUsageGenerations?: Array<{
    generation: ParsedGenMetadata;
    isChildStep?: boolean;
    timestampSeconds?: number | null;
  }>;
  contextSteps?: ComputeHudMetricsInput['steps'];
  steps: Array<{
    idx?: number;
    step_type?: number;
    stepType?: number;
    status?: number;
    t_start?: number | null;
    startTimeSeconds?: number | null;
    createdAtSeconds?: number | null;
    t_first_token?: number | null;
    firstTokenSeconds?: number | null;
    t_end?: number | null;
    endTimeSeconds?: number | null;
    finishedGeneratingSeconds?: number | null;
    completedAtSeconds?: number | null;
    childConversationIds?: string[];
    rawInput?: number;
    rawInputTokens?: number;
    cachedTokens?: number;
    cachedReadTokens?: number;
    cacheWriteTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    candidateTokens?: number;
    modelMaxTokens?: number;
    modelName?: string;
    toolCallName?: string;
    isSubagentStep?: boolean;
    hasUsage?: boolean;
    generation?: ParsedGenMetadata;
  }>;
}

const NON_TOOL_STEP_TYPES = new Set([0, 1, 2, 14, 15, 23, 81, 98, 99, 101, 102, 104]);

function validSeconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function safeTokens(value: number | undefined): number {
  return Number.isSafeInteger(value) && value! >= 0 ? value! : 0;
}

function isStepCompleted(step: ComputeHudMetricsInput['steps'][number]): boolean {
  const rawStatus = step.status ?? 3;
  return (
    rawStatus === 3 ||
    (rawStatus === 5 &&
      (step.generation !== undefined ||
        step.finishedGeneratingSeconds != null ||
        step.completedAtSeconds != null ||
        step.t_end != null))
  );
}

function isStepActiveNow(
  step: ComputeHudMetricsInput['steps'][number],
  isStreaming: boolean,
  allowActiveInference: boolean,
  options?: { allowWaitingStatus?: boolean }
): boolean {
  if (isStepCompleted(step)) return false;
  if (isWaitingSubagentToolName(step.toolCallName)) return false;
  const rawStatus = step.status ?? CORTEX_STEP_STATUS.DONE;
  if (TERMINAL_INACTIVE_STEP_STATUSES.has(rawStatus) || rawStatus === CORTEX_STEP_STATUS.UNSPECIFIED) return false;
  if (rawStatus === CORTEX_STEP_STATUS.WAITING) {
    return Boolean(options?.allowWaitingStatus && isStreaming);
  }
  if (ACTIVE_STEP_STATUSES.has(rawStatus)) {
    return allowActiveInference || isStreaming;
  }
  const end = step.t_end ?? step.endTimeSeconds;
  return isStreaming && end == null;
}

function mergeDurationIntervals(intervals: ReadonlyArray<readonly [number, number]>): number {
  const normalized: Array<[number, number]> = [];
  for (const [start, end] of intervals) {
    if (validSeconds(start) && validSeconds(end) && end > start) {
      normalized.push([start, end]);
    }
  }
  if (normalized.length === 0) return 0;
  normalized.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let total = 0;
  let curStart = normalized[0]![0];
  let curEnd = normalized[0]![1];
  for (let i = 1; i < normalized.length; i++) {
    const [nextStart, nextEnd] = normalized[i]!;
    if (nextStart <= curEnd) {
      if (nextEnd > curEnd) curEnd = nextEnd;
    } else {
      total += curEnd - curStart;
      curStart = nextStart;
      curEnd = nextEnd;
    }
  }
  total += curEnd - curStart;
  return total;
}

interface ClassifiedContextSlot {
  slotKey: string;
  role: HudContextStageRole;
  modelId: string;
  displayName: string;
  shortLabel: string;
  compactLabel: string;
  capacityTokens: number;
  isFallbackModel: boolean;
  hasExplicitEvidence: boolean;
}

interface StageAccumulator {
  slot: ClassifiedContextSlot;
  latestStep?: ComputeHudMetricsInput['steps'][number];
  latestPrompt: number;
  peakContextTokens: number;
  explicitCapacity?: number;
  compactionCount?: number;
}

const COMPACT_MODEL_LABEL_RULES: ReadonlyArray<readonly [RegExp, string, string]> = [
  [/^gemini-4-carbon/, 'Carbon', 'C'],
  [/^gemini-4-argon/, 'Argon', 'A'],
  [/^gemini-4-neon/, 'Neon', 'N'],
  [/^gemini-4-hydrogen/, 'Hydrogen', 'H'],
  [/^gemini-(?:[\d.]+-)?pro|^gemini-pro/, 'Pro', 'P'],
  [/^gemini-(?:[\d.]+-)?flash|^gemini-flash/, 'Flash', 'F'],
  [/^claude-(?:.*-)?opus/, 'Opus', 'O'],
  [/^claude-(?:.*-)?sonnet/, 'Sonnet', 'S'],
  [/^claude-(?:.*-)?haiku/, 'Haiku', 'H'],
  [/^gpt-oss/, 'GPT-OSS', 'G'],
];

function buildCompactModelLabel(modelId: string, displayName: string): { shortLabel: string; compactLabel: string } {
  const lower = modelId.toLowerCase();
  for (const [pattern, shortLabel, compactLabel] of COMPACT_MODEL_LABEL_RULES) {
    if (pattern.test(lower)) return { shortLabel, compactLabel };
  }
  const dynamicGemini = lower.match(/^gemini-(?:[4-9](?:\.\d+)?)-([a-z][a-z0-9]*)/);
  if (dynamicGemini?.[1]) {
    const code = dynamicGemini[1].charAt(0).toUpperCase() + dynamicGemini[1].slice(1);
    return { shortLabel: code, compactLabel: code.charAt(0).toUpperCase() };
  }
  const dynamicClaude = lower.match(/^claude-([a-z]{3,16})(?:-\d|$)/);
  if (dynamicClaude?.[1]) {
    const tier = dynamicClaude[1].charAt(0).toUpperCase() + dynamicClaude[1].slice(1);
    return { shortLabel: tier, compactLabel: tier.charAt(0).toUpperCase() };
  }
  const dynamicGpt = lower.match(/^gpt-([4-9](?:\.\d+)?)/);
  if (dynamicGpt?.[1]) {
    return { shortLabel: `GPT-${dynamicGpt[1]}`, compactLabel: 'G' };
  }
  const cleaned = displayName.trim() || modelId.trim() || 'Model';
  const shortLabel = cleaned.length <= 10 ? cleaned : (cleaned.split(/\s+/).slice(0, 2).join(' ').slice(0, 10) || cleaned.slice(0, 10));
  const compactLabel = shortLabel.match(/[A-Za-z0-9]/)?.[0]?.toUpperCase() || 'M';
  return { shortLabel, compactLabel };
}

function buildOrchestratorSlotKey(role: 'planner' | 'executor', modelId: string): string {
  const lower = (modelId || '').toLowerCase();
  const g4Match = lower.match(/^gemini-(?:[4-9](?:\.\d+)?)-([a-z][a-z0-9]*)/);
  if (g4Match?.[1]) return `orchestrator:${g4Match[1]}`;
  if (lower === 'gemini-3.8-flash' || /^gemini-(?:[\d.]+-)?flash$/.test(lower)) {
    return 'orchestrator:flash';
  }
  const slug = lower.replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '');
  return slug ? `orchestrator:${slug}` : `orchestrator:${role}`;
}

function isPositiveSafeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function createPendingPlannerSlot(params: {
  planModelEnum?: number;
  plannerModelName?: string;
  inputPlannerSlot?: ClassifiedContextSlot | null;
  capacityTokens: number;
  isFallbackModel: boolean;
}): ClassifiedContextSlot {
  const fromEnum = resolveObservedModelSpecByEnum(params.planModelEnum);
  if (fromEnum && fromEnum.modelId !== 'unknown-model') {
    const { shortLabel, compactLabel } = buildCompactModelLabel(fromEnum.modelId, fromEnum.displayName);
    return {
      slotKey: buildOrchestratorSlotKey('planner', fromEnum.modelId),
      role: 'planner',
      modelId: fromEnum.modelId,
      displayName: fromEnum.displayName,
      shortLabel,
      compactLabel,
      capacityTokens: fromEnum.capacityTokens,
      isFallbackModel: fromEnum.isFallback,
      hasExplicitEvidence: true,
    };
  }
  if (
    params.inputPlannerSlot &&
    params.inputPlannerSlot.role === 'planner' &&
    params.inputPlannerSlot.hasExplicitEvidence &&
    params.inputPlannerSlot.modelId !== 'pending' &&
    params.inputPlannerSlot.modelId !== 'unknown'
  ) {
    return params.inputPlannerSlot;
  }
  if (params.plannerModelName && params.plannerModelName.trim()) {
    const fromName = resolveModelCapacity(params.plannerModelName);
    if (fromName.modelId !== 'unknown-model') {
      const { shortLabel, compactLabel } = buildCompactModelLabel(fromName.modelId, fromName.displayName);
      return {
        slotKey: buildOrchestratorSlotKey('planner', fromName.modelId),
        role: 'planner',
        modelId: fromName.modelId,
        displayName: fromName.displayName,
        shortLabel,
        compactLabel,
        capacityTokens: fromName.capacityTokens,
        isFallbackModel: fromName.isFallback,
        hasExplicitEvidence: true,
      };
    }
  }
  return {
    slotKey: 'orchestrator:planner_pending',
    role: 'planner',
    modelId: 'pending',
    displayName: '',
    shortLabel: '',
    compactLabel: '',
    capacityTokens: params.capacityTokens,
    isFallbackModel: true,
    hasExplicitEvidence: false,
  };
}

function createPendingExecutorSlot(params: {
  executionModelEnum?: number;
  capacityTokens: number;
  isFallbackModel: boolean;
}): ClassifiedContextSlot {
  const fromEnum = resolveObservedModelSpecByEnum(params.executionModelEnum);
  if (fromEnum && fromEnum.modelId !== 'unknown-model') {
    const { shortLabel, compactLabel } = buildCompactModelLabel(fromEnum.modelId, fromEnum.displayName);
    return {
      slotKey: buildOrchestratorSlotKey('executor', fromEnum.modelId),
      role: 'executor',
      modelId: fromEnum.modelId,
      displayName: fromEnum.displayName,
      shortLabel,
      compactLabel,
      capacityTokens: fromEnum.capacityTokens,
      isFallbackModel: fromEnum.isFallback,
      hasExplicitEvidence: true,
    };
  }
  return {
    slotKey: 'orchestrator:executor_pending',
    role: 'executor',
    modelId: 'pending',
    displayName: '',
    shortLabel: '',
    compactLabel: '',
    capacityTokens: params.capacityTokens,
    isFallbackModel: params.isFallbackModel,
    hasExplicitEvidence: false,
  };
}

function classifyContextModelSlot(params: {
  responseModel?: string;
  modelDisplayName?: string;
  plannerModelName?: string;
  stepModelName?: string;
  modelEnum?: number;
  planModelEnum?: number;
  executionModelEnum?: number;
  fallbackInputModelId?: string;
  hasPriorOrchestrator?: boolean;
}): ClassifiedContextSlot {
  const responseModel = (params.responseModel || '').trim();
  const modelDisplayName = (params.modelDisplayName || '').trim();
  const plannerModelName = (params.plannerModelName || '').trim();
  const stepModelName = (params.stepModelName || '').trim();
  const modelEnum = isPositiveSafeInt(params.modelEnum) ? params.modelEnum : undefined;
  const planModelEnum = isPositiveSafeInt(params.planModelEnum) ? params.planModelEnum : undefined;
  const executionModelEnum = isPositiveSafeInt(params.executionModelEnum) ? params.executionModelEnum : undefined;
  const fallbackInputModelId = (params.fallbackInputModelId || '').trim();
  const combinedRaw = [responseModel, modelDisplayName, plannerModelName, stepModelName].filter(Boolean).join(' ');
  const hasStepRaw = Boolean(combinedRaw || modelEnum !== undefined);

  const hasPlanExecuteProtocol = Boolean(executionModelEnum && executionModelEnum > 0);
  const matchesProtocolExecutor = Boolean(
    hasPlanExecuteProtocol &&
      modelEnum !== undefined &&
      modelEnum === executionModelEnum &&
      (planModelEnum === undefined || executionModelEnum !== planModelEnum)
  );
  const matchesProtocolPlanner = Boolean(
    hasPlanExecuteProtocol &&
      modelEnum !== undefined &&
      planModelEnum !== undefined &&
      modelEnum === planModelEnum
  );

  const displayOrch = stripOrchestratorWrapper(modelDisplayName);
  const stepOrch = stripOrchestratorWrapper(stepModelName);
  const plannerOrch = stripOrchestratorWrapper(plannerModelName);
  const fallbackOrch = stripOrchestratorWrapper(fallbackInputModelId);

  const isLegacyWorker =
    /^gemini-flash-worker(?:-agy)?$/i.test(responseModel) ||
    /^gemini-flash-worker(?:-agy)?$/i.test(plannerModelName) ||
    /^gemini-flash-worker(?:-agy)?$/i.test(stepModelName) ||
    (!hasStepRaw && /^gemini-flash-worker(?:-agy)?$/i.test(fallbackInputModelId));

  const isTrailingOrchestratorExecutor =
    displayOrch.isTrailingSuffix || stepOrch.isTrailingSuffix;

  const isLegacyPlanner =
    /\bgemini-pro-orchestrator\b/i.test(combinedRaw) ||
    (displayOrch.isOrchestrator && !displayOrch.isTrailingSuffix) ||
    (plannerOrch.isOrchestrator && !plannerOrch.isTrailingSuffix) ||
    (stepOrch.isOrchestrator && !stepOrch.isTrailingSuffix);

  const isFallbackPlanner =
    !hasStepRaw &&
    ((fallbackOrch.isOrchestrator && !fallbackOrch.isTrailingSuffix) ||
      /\bgemini-pro-orchestrator\b/i.test(fallbackInputModelId));

  const isFallbackExecutor =
    !hasStepRaw &&
    (fallbackOrch.isTrailingSuffix || /^gemini-flash-worker(?:-agy)?$/i.test(fallbackInputModelId));

  const enumSpec = resolveObservedModelSpecByEnum(modelEnum);
  const execEnumSpec = hasPlanExecuteProtocol ? resolveObservedModelSpecByEnum(executionModelEnum) : null;
  const planEnumSpec = hasPlanExecuteProtocol ? resolveObservedModelSpecByEnum(planModelEnum) : null;

  // 解析真实底层物理模型（完全消除硬编码 Argon / Carbon / gemini-4-* 拼接）
  const resolveUnderlyingSpec = (): ReturnType<typeof resolveModelCapacity> | null => {
    if (isLegacyWorker || isTrailingOrchestratorExecutor) {
      if (displayOrch.isTrailingSuffix && displayOrch.inner) {
        return resolveModelCapacity(displayOrch.inner);
      }
      if (stepOrch.isTrailingSuffix && stepOrch.inner) {
        return resolveModelCapacity(stepOrch.inner);
      }
      if (modelDisplayName && !/^gemini-flash-worker(?:-agy)?$/i.test(modelDisplayName)) {
        return resolveModelCapacity(modelDisplayName);
      }
      if (enumSpec && enumSpec.modelId !== 'unknown-model') {
        return enumSpec;
      }
      const workerRef = responseModel || plannerModelName || stepModelName || fallbackInputModelId;
      return workerRef ? resolveModelCapacity(workerRef) : null;
    }

    const candidates: Array<string | undefined> = [];
    if (modelDisplayName && (!displayOrch.isOrchestrator || Boolean(displayOrch.inner))) {
      candidates.push(modelDisplayName);
    }
    const isOpaqueOrchestratorId = /^gemini-pro-orchestrator$/i.test(responseModel);
    if (responseModel && !isOpaqueOrchestratorId) {
      candidates.push(responseModel);
    }
    for (const c of candidates) {
      if (!c) continue;
      const spec = resolveModelCapacity(c);
      if (spec.modelId !== 'unknown-model' && spec.modelId !== 'orchestrator') {
        return spec;
      }
    }
    if (enumSpec && enumSpec.modelId !== 'unknown-model') {
      return enumSpec;
    }
    for (const c of [
      isOpaqueOrchestratorId ? responseModel : undefined,
      plannerModelName && (!plannerOrch.isOrchestrator || Boolean(plannerOrch.inner)) ? plannerModelName : undefined,
      stepModelName && (!stepOrch.isOrchestrator || Boolean(stepOrch.inner)) ? stepModelName : undefined,
      !hasStepRaw && fallbackInputModelId && (!fallbackOrch.isOrchestrator || Boolean(fallbackOrch.inner))
        ? fallbackInputModelId
        : undefined,
    ]) {
      if (!c) continue;
      const spec = resolveModelCapacity(c);
      if (spec.modelId !== 'unknown-model' && spec.modelId !== 'orchestrator') {
        return spec;
      }
    }
    return null;
  };

  const spec = resolveUnderlyingSpec();

  // 裸 "Orchestrator" 且无任何模型证据 -> 中性待介入规划槽位（绝不伪造 Argon 或 Carbon）
  if (!spec || spec.modelId === 'unknown-model') {
    const fallbackCap = resolveModelCapacity('');
    if (isLegacyPlanner || isFallbackPlanner || hasPlanExecuteProtocol) {
      return createPendingPlannerSlot({
        planModelEnum,
        plannerModelName,
        capacityTokens: fallbackCap.capacityTokens,
        isFallbackModel: true,
      });
    }
    if (isLegacyWorker || isTrailingOrchestratorExecutor || isFallbackExecutor) {
      return createPendingExecutorSlot({
        executionModelEnum,
        capacityTokens: fallbackCap.capacityTokens,
        isFallbackModel: true,
      });
    }
    return {
      slotKey: 'model:unknown',
      role: 'model',
      modelId: 'unknown',
      displayName: '—',
      shortLabel: '',
      compactLabel: '',
      capacityTokens: fallbackCap.capacityTokens,
      isFallbackModel: true,
      hasExplicitEvidence: false,
    };
  }

  const matchesProtocolExecutorByModelId = Boolean(
    hasPlanExecuteProtocol &&
      !matchesProtocolPlanner &&
      !isLegacyPlanner &&
      execEnumSpec &&
      execEnumSpec.modelId === spec.modelId &&
      (!planEnumSpec || planEnumSpec.modelId !== spec.modelId)
  );

  const isExecutorRole =
    matchesProtocolExecutor ||
    matchesProtocolExecutorByModelId ||
    isLegacyWorker ||
    isTrailingOrchestratorExecutor ||
    isFallbackExecutor ||
    Boolean(
      params.hasPriorOrchestrator &&
        !hasPlanExecuteProtocol &&
        !isLegacyPlanner &&
        !matchesProtocolPlanner &&
        (spec.modelId === 'gemini-4-hydrogen' || spec.modelId === 'gemini-3.8-flash')
    );

  if (isExecutorRole) {
    const resolvedDisplayName = modelDisplayName || stepModelName || spec.displayName;
    const { shortLabel, compactLabel } = buildCompactModelLabel(spec.modelId, resolvedDisplayName);
    return {
      slotKey: buildOrchestratorSlotKey('executor', spec.modelId),
      role: 'executor',
      modelId: spec.modelId,
      displayName: resolvedDisplayName,
      shortLabel,
      compactLabel,
      capacityTokens: spec.capacityTokens,
      isFallbackModel: spec.isFallback,
      hasExplicitEvidence: true,
    };
  }

  const isPlannerRole =
    matchesProtocolPlanner ||
    hasPlanExecuteProtocol ||
    isLegacyPlanner ||
    isFallbackPlanner;

  if (isPlannerRole) {
    const resolvedDisplayName = modelDisplayName || stepModelName || spec.displayName;
    const { shortLabel, compactLabel } = buildCompactModelLabel(spec.modelId, resolvedDisplayName);
    return {
      slotKey: buildOrchestratorSlotKey('planner', spec.modelId),
      role: 'planner',
      modelId: spec.modelId,
      displayName: resolvedDisplayName,
      shortLabel,
      compactLabel,
      capacityTokens: spec.capacityTokens,
      isFallbackModel: spec.isFallback,
      hasExplicitEvidence: true,
    };
  }

  const resolvedDisplayName = modelDisplayName || spec.displayName;
  const { shortLabel, compactLabel } = buildCompactModelLabel(spec.modelId, resolvedDisplayName);
  return {
    slotKey: `model:${spec.modelId}`,
    role: 'model',
    modelId: spec.modelId,
    displayName: resolvedDisplayName,
    shortLabel,
    compactLabel,
    capacityTokens: spec.capacityTokens,
    isFallbackModel: spec.isFallback,
    hasExplicitEvidence: true,
  };
}

function createStageSnapshot(
  acc: StageAccumulator,
  isActive: boolean,
  inheritedExplicitCapacity?: number,
  section?: 'primary' | 'history'
): HudModelContextStage {
  const hasUsageData = Boolean(acc.latestStep);
  const effectiveExplicitCap = acc.explicitCapacity ?? inheritedExplicitCapacity;
  const capacityTokens = effectiveExplicitCap ?? acc.slot.capacityTokens;
  const capacityTokensCompact = effectiveExplicitCap !== undefined
    ? formatCompactTokenNumber(effectiveExplicitCap)
    : `~${formatCompactTokenNumber(capacityTokens)}`;
  const capacitySource: HudCapacitySource = effectiveExplicitCap !== undefined
    ? 'explicit'
    : acc.slot.isFallbackModel
    ? 'unknown'
    : 'reference';
  const usedTokens = hasUsageData ? acc.latestPrompt : 0;
  const usedRatio = hasUsageData && capacityTokens > 0 ? usedTokens / capacityTokens : 0;
  return {
    slotKey: acc.slot.slotKey,
    role: acc.slot.role,
    ...(section ? { section } : {}),
    modelId: acc.slot.modelId,
    modelDisplayName: acc.slot.displayName,
    shortLabel: acc.slot.shortLabel,
    compactLabel: acc.slot.compactLabel,
    hasUsageData,
    isActive,
    ...(acc.compactionCount && acc.compactionCount > 0 ? { compactionCount: acc.compactionCount } : {}),
    usedTokens,
    usedTokensCompact: formatCompactTokenNumber(usedTokens),
    usedTokensFormatted: formatThousandsTokens(usedTokens),
    peakContextTokens: acc.peakContextTokens,
    peakContextCompact: formatCompactTokenNumber(acc.peakContextTokens),
    peakContextFormatted: formatThousandsTokens(acc.peakContextTokens),
    capacityTokens,
    capacityTokensCompact,
    isFallbackCapacity: effectiveExplicitCap === undefined,
    capacitySource,
    usedRatio,
    usedRatioFormatted: compactPercent(usedRatio),
  };
}

interface LiveHudContextInfo {
  latestSessionTurn: number;
  latestTurnRunning: boolean;
  trailingActiveModelStep?: {
    step: ComputeHudMetricsInput['steps'][number];
    turnIndex: number;
  };
}

function resolveContextStagesAndActiveSlot(
  usageContextEntries: ReadonlyArray<{ step: ComputeHudMetricsInput['steps'][number]; prompt: number; turnIndex?: number }>,
  input: ComputeHudMetricsInput,
  compactionContextEntries: ReadonlyArray<{
    step: ComputeHudMetricsInput['steps'][number];
    precedingUsageIndex: number;
    turnIndex: number;
  }> = [],
  liveContext?: LiveHudContextInfo
): {
  latestStep?: ComputeHudMetricsInput['steps'][number];
  latestUsageStep?: ComputeHudMetricsInput['steps'][number];
  latestGenMeta?: ParsedGenMetadata;
  sessionPeakContextTokens: number;
  activeStage: HudModelContextStage;
  hasExplicitModelEvidence: boolean;
  isMultiModel: boolean;
  isOrchestrator: boolean;
  modelStages?: HudModelContextStage[];
  defaultFallbackModel: string;
} {
  const trimmedInputModel = typeof input.modelId === 'string' ? input.modelId.trim() : '';
  const inputAsStandaloneSlot = trimmedInputModel
    ? classifyContextModelSlot({ fallbackInputModelId: trimmedInputModel })
    : null;
  const inputOrch = stripOrchestratorWrapper(trimmedInputModel);
  const inputIsOrchestrator = Boolean(
    trimmedInputModel &&
      (inputOrch.isOrchestrator ||
        /\bgemini-pro-orchestrator\b|^gemini-flash-worker(?:-agy)?$/i.test(trimmedInputModel))
  );
  const inputExplicitCapacity = isPositiveSafeInt(input.modelCapacity) ? input.modelCapacity : undefined;
  const execMetaPlanEnum = isPositiveSafeInt(input.executorMetadata?.planModelEnum)
    ? input.executorMetadata!.planModelEnum
    : undefined;
  const execMetaExecEnum = isPositiveSafeInt(input.executorMetadata?.executionModelEnum)
    ? input.executorMetadata!.executionModelEnum
    : undefined;
  const executorExplicitCap =
    (isPositiveSafeInt(input.executorMetadata?.checkpointMaxTokenLimit)
      ? input.executorMetadata!.checkpointMaxTokenLimit
      : undefined) ??
    (isPositiveSafeInt(input.executorMetadata?.maxContextTokens)
      ? input.executorMetadata!.maxContextTokens
      : undefined);

  if (usageContextEntries.length === 0) {
    const emptyPlanEnum = input.genMetadata?.planModelEnum ?? execMetaPlanEnum;
    const emptyExecEnum = input.genMetadata?.executionModelEnum ?? execMetaExecEnum;
    const emptySlot = classifyContextModelSlot({
      responseModel: input.genMetadata?.responseModel,
      modelDisplayName: input.genMetadata?.modelDisplayName,
      plannerModelName: input.genMetadata?.plannerModelName ?? input.executorMetadata?.plannerModelName,
      modelEnum: input.genMetadata?.modelEnum ?? emptyPlanEnum,
      planModelEnum: emptyPlanEnum,
      executionModelEnum: emptyExecEnum,
      fallbackInputModelId: trimmedInputModel,
    });
    const emptyExplicitCap = [
      input.genMetadata?.maxContextTokens,
      executorExplicitCap,
      inputExplicitCapacity,
    ].find(isPositiveSafeInt);
    const emptyAcc: StageAccumulator = {
      slot: emptySlot,
      latestStep: undefined,
      latestPrompt: 0,
      peakContextTokens: 0,
      explicitCapacity: emptyExplicitCap,
    };
    const isOrchestrator =
      emptySlot.role === 'planner' ||
      emptySlot.role === 'executor' ||
      Boolean(emptyExecEnum && emptyExecEnum > 0) ||
      inputIsOrchestrator;
    if (isOrchestrator) {
      const pair: StageAccumulator[] = [];
      let historyModelAcc: StageAccumulator | undefined;
      if (emptySlot.role === 'executor') {
        const plannerSlot = createPendingPlannerSlot({
          planModelEnum: emptyPlanEnum,
          plannerModelName: input.genMetadata?.plannerModelName ?? input.executorMetadata?.plannerModelName,
          inputPlannerSlot: inputAsStandaloneSlot?.role === 'planner' ? inputAsStandaloneSlot : null,
          capacityTokens: emptySlot.capacityTokens,
          isFallbackModel: emptySlot.isFallbackModel,
        });
        pair.push({ slot: plannerSlot, latestPrompt: 0, peakContextTokens: 0, explicitCapacity: emptyExplicitCap });
        pair.push(emptyAcc);
      } else if (emptySlot.role === 'planner') {
        pair.push(emptyAcc);
        const pendingExecSlot = createPendingExecutorSlot({
          executionModelEnum: emptyExecEnum,
          capacityTokens: emptySlot.capacityTokens,
          isFallbackModel: emptySlot.isFallbackModel,
        });
        const sameAsPlanner =
          (pendingExecSlot.modelId !== 'pending' && pendingExecSlot.modelId === emptySlot.modelId) ||
          (!emptyExecEnum && emptySlot.shortLabel === 'Hydrogen');
        if (!sameAsPlanner) {
          pair.push({
            slot: pendingExecSlot,
            latestPrompt: 0,
            peakContextTokens: 0,
            explicitCapacity: emptyExplicitCap,
          });
        }
      } else {
        const plannerSlot = createPendingPlannerSlot({
          planModelEnum: emptyPlanEnum,
          plannerModelName: input.genMetadata?.plannerModelName ?? input.executorMetadata?.plannerModelName,
          inputPlannerSlot: inputAsStandaloneSlot?.role === 'planner' ? inputAsStandaloneSlot : null,
          capacityTokens: emptySlot.capacityTokens,
          isFallbackModel: emptySlot.isFallbackModel,
        });
        // 空对话未有 DB / DOM 明确上限时，严禁把参考容量写入 explicitCapacity（保持 ~ 前缀）
        pair.push({
          slot: plannerSlot,
          latestPrompt: 0,
          peakContextTokens: 0,
          explicitCapacity: emptyExplicitCap,
        });
        const pendingExecSlot = createPendingExecutorSlot({
          executionModelEnum: emptyExecEnum,
          capacityTokens: plannerSlot.capacityTokens,
          isFallbackModel: plannerSlot.isFallbackModel,
        });
        const sameAsPlanner =
          (pendingExecSlot.modelId !== 'pending' && pendingExecSlot.modelId === plannerSlot.modelId) ||
          (!emptyExecEnum && plannerSlot.shortLabel === 'Hydrogen');
        if (!sameAsPlanner) {
          pair.push({
            slot: pendingExecSlot,
            latestPrompt: 0,
            peakContextTokens: 0,
            explicitCapacity: emptyExplicitCap,
          });
        }
        if (
          emptySlot.hasExplicitEvidence &&
          emptySlot.modelId !== 'unknown' &&
          !pair.some((a) => a.slot.modelId === emptySlot.modelId)
        ) {
          historyModelAcc = emptyAcc;
        }
      }
      const fallbackTargetAcc = pair[0] ?? emptyAcc;
      for (const cpEntry of compactionContextEntries) {
        const cpGen = cpEntry.step.generation;
        let targetAcc: StageAccumulator | undefined;
        if (
          cpGen?.responseModel ||
          cpGen?.modelDisplayName ||
          cpGen?.plannerModelName ||
          cpGen?.modelEnum ||
          cpEntry.step.modelName
        ) {
          const cpSlot = classifyContextModelSlot({
            responseModel: cpGen?.responseModel,
            modelDisplayName: cpGen?.modelDisplayName,
            plannerModelName: cpGen?.plannerModelName,
            stepModelName: cpEntry.step.modelName,
            modelEnum: cpGen?.modelEnum,
            planModelEnum: cpGen?.planModelEnum ?? emptyPlanEnum,
            executionModelEnum: cpGen?.executionModelEnum ?? emptyExecEnum,
            hasPriorOrchestrator: true,
          });
          if (cpSlot.hasExplicitEvidence && cpSlot.modelId !== 'unknown') {
            targetAcc =
              pair.find((a) => a.slot.slotKey === cpSlot.slotKey || a.slot.modelId === cpSlot.modelId) ??
              (historyModelAcc &&
              (historyModelAcc.slot.slotKey === cpSlot.slotKey || historyModelAcc.slot.modelId === cpSlot.modelId)
                ? historyModelAcc
                : undefined);
          }
        }
        const resolved = targetAcc ?? (emptySlot.role === 'model' && historyModelAcc ? historyModelAcc : fallbackTargetAcc);
        resolved.compactionCount = (resolved.compactionCount ?? 0) + 1;
      }
      const stages = [
        ...pair.map((acc) => createStageSnapshot(acc, acc.slot.slotKey === emptySlot.slotKey, emptyExplicitCap, 'primary')),
        ...(historyModelAcc
          ? [createStageSnapshot(historyModelAcc, historyModelAcc.slot.slotKey === emptySlot.slotKey, undefined, 'primary')]
          : []),
      ];
      const activeStage = stages.find((s) => s.isActive) ?? stages[0]!;
      return {
        latestStep: undefined,
        latestUsageStep: undefined,
        latestGenMeta: input.genMetadata,
        sessionPeakContextTokens: 0,
        activeStage,
        hasExplicitModelEvidence: emptySlot.hasExplicitEvidence,
        isMultiModel: stages.length >= 2,
        isOrchestrator: true,
        modelStages: stages.length >= 2 ? stages : undefined,
        defaultFallbackModel: emptySlot.hasExplicitEvidence ? (emptySlot.role === 'model' ? emptySlot.displayName : emptySlot.modelId) : '',
      };
    }
    if (compactionContextEntries.length > 0) {
      emptyAcc.compactionCount = compactionContextEntries.length;
    }
    const activeStage = createStageSnapshot(emptyAcc, true);
    return {
      latestStep: undefined,
      latestUsageStep: undefined,
      latestGenMeta: input.genMetadata,
      sessionPeakContextTokens: 0,
      activeStage,
      hasExplicitModelEvidence: emptySlot.hasExplicitEvidence,
      isMultiModel: false,
      isOrchestrator: false,
      defaultFallbackModel: emptySlot.hasExplicitEvidence ? emptySlot.displayName : '',
    };
  }

  const stageMap = new Map<string, StageAccumulator & { lastSeenSeq: number }>();
  const slotKeyByUsageIndex: string[] = [];
  const orchestratorTurns = new Set<number>();
  const turnPlanExecConfig = new Map<number, { planModelEnum?: number; executionModelEnum?: number }>();
  let sessionPeakContextTokens = 0;
  let latestEntry!: {
    step: ComputeHudMetricsInput['steps'][number];
    slot: ClassifiedContextSlot;
    genMeta?: ParsedGenMetadata;
  };
  let latestPlanModelEnum: number | undefined;
  let latestExecutionModelEnum: number | undefined;
  const lastTurnNum = usageContextEntries[usageContextEntries.length - 1]?.turnIndex ?? 0;
  const execMetaInLatestSessionTurn = lastTurnNum === (liveContext?.latestSessionTurn ?? lastTurnNum);
  const execMetaAppliesToCurrentSession = Boolean(
    execMetaExecEnum &&
      execMetaExecEnum > 0 &&
      (inputIsOrchestrator || !trimmedInputModel)
  );
  const execMetaAppliesToLatestUsageTurn = Boolean(
    execMetaAppliesToCurrentSession && execMetaInLatestSessionTurn
  );
  const execMetaCapAppliesToLatestUsageTurn = Boolean(
    execMetaInLatestSessionTurn &&
      (!execMetaExecEnum || inputIsOrchestrator || !trimmedInputModel)
  );
  const hasAnyExplicitUsageModel = usageContextEntries.some((entry, idx) => {
    const isGlobalLatest = idx === usageContextEntries.length - 1;
    const gm = entry.step.generation ?? (isGlobalLatest ? input.genMetadata : undefined);
    return Boolean(
      gm?.responseModel || gm?.modelDisplayName || gm?.plannerModelName || gm?.modelEnum || entry.step.modelName
    );
  });
  let lastExplicitFallbackModel = '';

  for (let i = 0; i < usageContextEntries.length; i++) {
    const entry = usageContextEntries[i]!;
    const turnIndex = entry.turnIndex ?? 0;
    const isGlobalLatest = i === usageContextEntries.length - 1;
    const stepGenMeta = entry.step.generation ?? (isGlobalLatest ? input.genMetadata : undefined);
    const prevTurnConfig = turnPlanExecConfig.get(turnIndex);
    const stepExecEnum =
      stepGenMeta?.executionModelEnum ??
      prevTurnConfig?.executionModelEnum ??
      (turnIndex === lastTurnNum && execMetaAppliesToLatestUsageTurn ? execMetaExecEnum : undefined);
    const rawStepPlanEnum = stepGenMeta?.planModelEnum;
    const distinctPrevPlanEnum =
      prevTurnConfig?.planModelEnum !== undefined && prevTurnConfig.planModelEnum !== stepExecEnum
        ? prevTurnConfig.planModelEnum
        : undefined;
    const distinctExecMetaPlanEnum =
      execMetaPlanEnum !== undefined && execMetaPlanEnum !== stepExecEnum
        ? execMetaPlanEnum
        : undefined;
    let stepPlanEnum: number | undefined;
    if (rawStepPlanEnum !== undefined && stepExecEnum !== undefined && rawStepPlanEnum === stepExecEnum) {
      // 宿主在执行步会将 gen_metadata.f3.1 改写为当前执行模型枚举（与 f3.60.1 相同）：
      // 优先保留同轮前步或 executor_metadata 中真实的 planModelEnum；若无则校验 DOM 规划模型是否不同，避免把执行步错判为第二个 Planner。
      const execSpec = resolveObservedModelSpecByEnum(stepExecEnum);
      const domSuggestsDifferentPlanner = Boolean(
        inputAsStandaloneSlot &&
          inputAsStandaloneSlot.role === 'planner' &&
          inputAsStandaloneSlot.hasExplicitEvidence &&
          execSpec &&
          inputAsStandaloneSlot.modelId !== execSpec.modelId
      );
      stepPlanEnum =
        distinctPrevPlanEnum ??
        (turnIndex === lastTurnNum || !prevTurnConfig ? distinctExecMetaPlanEnum : undefined) ??
        (domSuggestsDifferentPlanner ? undefined : rawStepPlanEnum);
    } else {
      stepPlanEnum =
        rawStepPlanEnum ??
        prevTurnConfig?.planModelEnum ??
        (turnIndex === lastTurnNum && execMetaAppliesToLatestUsageTurn ? execMetaPlanEnum : undefined);
    }
    if (stepExecEnum && stepExecEnum > 0) {
      const preservedPlanEnum =
        stepPlanEnum !== undefined && stepPlanEnum !== stepExecEnum
          ? stepPlanEnum
          : distinctPrevPlanEnum ?? stepPlanEnum;
      turnPlanExecConfig.set(turnIndex, {
        planModelEnum: preservedPlanEnum,
        executionModelEnum: stepExecEnum,
      });
    }
    const hasStepExplicitModel = Boolean(
      stepGenMeta?.responseModel ||
        stepGenMeta?.modelDisplayName ||
        stepGenMeta?.plannerModelName ||
        stepGenMeta?.modelEnum ||
        entry.step.modelName
    );
    const stepFallbackModel =
      !hasAnyExplicitUsageModel || (isGlobalLatest && !isStepCompleted(entry.step))
        ? trimmedInputModel
        : lastExplicitFallbackModel;
    const slot = classifyContextModelSlot({
      responseModel: stepGenMeta?.responseModel,
      modelDisplayName: stepGenMeta?.modelDisplayName,
      plannerModelName: stepGenMeta?.plannerModelName,
      stepModelName: entry.step.modelName,
      modelEnum: stepGenMeta?.modelEnum,
      planModelEnum: stepPlanEnum,
      executionModelEnum: stepExecEnum,
      fallbackInputModelId: stepFallbackModel,
      hasPriorOrchestrator: orchestratorTurns.has(turnIndex),
    });
    if (hasStepExplicitModel && slot.hasExplicitEvidence && slot.modelId !== 'unknown') {
      lastExplicitFallbackModel = slot.role === 'model' ? slot.displayName : slot.modelId;
    }
    if (slot.role === 'planner' || slot.role === 'executor') {
      orchestratorTurns.add(turnIndex);
    }
    if (isGlobalLatest) {
      latestPlanModelEnum = stepPlanEnum;
      latestExecutionModelEnum = stepExecEnum;
    }
    // 容量优先级：stepGenMeta.maxContextTokens > executorMetadata.checkpointMaxTokenLimit > step.modelMaxTokens > inputExplicitCapacity > 动态目录 > ~200K
    const stepExplicitCap = [
      stepGenMeta?.maxContextTokens,
      execMetaCapAppliesToLatestUsageTurn &&
      (isGlobalLatest || (turnIndex === lastTurnNum && (slot.role === 'planner' || slot.role === 'executor')))
        ? executorExplicitCap
        : undefined,
      entry.step.modelMaxTokens,
      isGlobalLatest ? inputExplicitCapacity : undefined,
    ].find(isPositiveSafeInt);
    const prev = stageMap.get(slot.slotKey);
    stageMap.set(slot.slotKey, {
      slot,
      latestStep: entry.step,
      latestPrompt: entry.prompt,
      peakContextTokens: Math.max(prev?.peakContextTokens ?? 0, entry.prompt),
      explicitCapacity: stepExplicitCap ?? prev?.explicitCapacity,
      ...(prev?.compactionCount ? { compactionCount: prev.compactionCount } : {}),
      lastSeenSeq: i,
    });
    slotKeyByUsageIndex.push(slot.slotKey);
    sessionPeakContextTokens = Math.max(sessionPeakContextTokens, entry.prompt);
    latestEntry = { step: entry.step, slot, genMeta: stepGenMeta };
  }

  for (const cpEntry of compactionContextEntries) {
    let targetSlotKey: string | undefined;
    const cpGen = cpEntry.step.generation;
    const cpTurnCfg = turnPlanExecConfig.get(cpEntry.turnIndex);
    if (
      cpGen?.responseModel ||
      cpGen?.modelDisplayName ||
      cpGen?.plannerModelName ||
      cpGen?.modelEnum ||
      cpEntry.step.modelName
    ) {
      const cpSlot = classifyContextModelSlot({
        responseModel: cpGen?.responseModel,
        modelDisplayName: cpGen?.modelDisplayName,
        plannerModelName: cpGen?.plannerModelName,
        stepModelName: cpEntry.step.modelName,
        modelEnum: cpGen?.modelEnum,
        planModelEnum: cpGen?.planModelEnum ?? cpTurnCfg?.planModelEnum,
        executionModelEnum: cpGen?.executionModelEnum ?? cpTurnCfg?.executionModelEnum,
        hasPriorOrchestrator: orchestratorTurns.has(cpEntry.turnIndex),
      });
      if (cpSlot.hasExplicitEvidence && cpSlot.modelId !== 'unknown') {
        if (stageMap.has(cpSlot.slotKey)) {
          targetSlotKey = cpSlot.slotKey;
        } else {
          const matchedByModelId = [...stageMap.values()].find((a) => a.slot.modelId === cpSlot.modelId);
          if (matchedByModelId) targetSlotKey = matchedByModelId.slot.slotKey;
        }
      }
    }
    if (!targetSlotKey) {
      if (cpEntry.precedingUsageIndex >= 0 && cpEntry.precedingUsageIndex < slotKeyByUsageIndex.length) {
        targetSlotKey = slotKeyByUsageIndex[cpEntry.precedingUsageIndex];
      } else {
        targetSlotKey = slotKeyByUsageIndex[0] ?? latestEntry.slot.slotKey;
      }
    }
    const targetAcc = targetSlotKey ? stageMap.get(targetSlotKey) : undefined;
    if (targetAcc) {
      targetAcc.compactionCount = (targetAcc.compactionCount ?? 0) + 1;
    }
  }

  let effectiveActiveSlotKey = latestEntry.slot.slotKey;
  const activeAcc = stageMap.get(effectiveActiveSlotKey)!;
  const allAccs = [...stageMap.values()];
  const effectivePlanModelEnum = latestPlanModelEnum ?? (execMetaAppliesToCurrentSession ? execMetaPlanEnum : undefined);
  const effectiveExecutionModelEnum =
    latestExecutionModelEnum ?? (execMetaAppliesToCurrentSession ? execMetaExecEnum : undefined);
  const isOrchestrator =
    latestEntry.slot.role === 'planner' ||
    latestEntry.slot.role === 'executor' ||
    Boolean(effectiveExecutionModelEnum && effectiveExecutionModelEnum > 0) ||
    inputIsOrchestrator;

  let orderedEntries: Array<{ acc: StageAccumulator; section: 'primary' | 'history' }>;
  let inheritedOrchCap: number | undefined;
  const hasPendingInputSlot = (accs: ReadonlyArray<StageAccumulator>): boolean =>
    Boolean(
      inputAsStandaloneSlot &&
      inputAsStandaloneSlot.hasExplicitEvidence &&
      inputAsStandaloneSlot.modelId !== 'unknown' &&
      inputAsStandaloneSlot.modelId !== 'pending' &&
      !accs.some(
        (a) => a.slot.slotKey === inputAsStandaloneSlot.slotKey || a.slot.modelId === inputAsStandaloneSlot.modelId
      )
    );
  const findMatchingSlot = (
    accs: ReadonlyArray<StageAccumulator>,
    target: ClassifiedContextSlot
  ): StageAccumulator | undefined =>
    accs.find(
      (a) =>
        a.slot.slotKey === target.slotKey ||
        (target.modelId !== 'unknown' && target.modelId !== 'pending' && a.slot.modelId === target.modelId)
    );
  const resolveTrailingLiveModelSlot = (): { slot: ClassifiedContextSlot; explicitCap?: number } | null => {
    const trailing = liveContext?.trailingActiveModelStep;
    if (!trailing) return null;
    const liveStep = trailing.step;
    const liveGen = liveStep.generation;
    const hasLiveModelEvidence = Boolean(
      liveGen?.responseModel ||
        liveGen?.modelDisplayName ||
        liveGen?.plannerModelName ||
        liveGen?.modelEnum ||
        liveStep.modelName
    );
    if (!hasLiveModelEvidence) return null;
    const liveTurnIdx = trailing.turnIndex;
    const liveTurnCfg = turnPlanExecConfig.get(liveTurnIdx);
    const isCurrentLatestSessionTurn = liveTurnIdx === liveContext!.latestSessionTurn;
    const liveExecEnum =
      liveGen?.executionModelEnum ??
      liveTurnCfg?.executionModelEnum ??
      (execMetaAppliesToCurrentSession && isCurrentLatestSessionTurn ? execMetaExecEnum : undefined);
    const rawLivePlanEnum = liveGen?.planModelEnum;
    const liveDistinctPrevPlan =
      liveTurnCfg?.planModelEnum !== undefined && liveTurnCfg.planModelEnum !== liveExecEnum
        ? liveTurnCfg.planModelEnum
        : undefined;
    const liveDistinctExecMetaPlan =
      execMetaAppliesToCurrentSession &&
      isCurrentLatestSessionTurn &&
      execMetaPlanEnum !== undefined &&
      execMetaPlanEnum !== liveExecEnum
        ? execMetaPlanEnum
        : undefined;
    let livePlanEnum: number | undefined;
    if (rawLivePlanEnum !== undefined && liveExecEnum !== undefined && rawLivePlanEnum === liveExecEnum) {
      const execSpec = resolveObservedModelSpecByEnum(liveExecEnum);
      const domSuggestsDifferentPlanner = Boolean(
        inputAsStandaloneSlot &&
          inputAsStandaloneSlot.role === 'planner' &&
          inputAsStandaloneSlot.hasExplicitEvidence &&
          execSpec &&
          inputAsStandaloneSlot.modelId !== execSpec.modelId
      );
      livePlanEnum =
        liveDistinctPrevPlan ??
        liveDistinctExecMetaPlan ??
        (domSuggestsDifferentPlanner ? undefined : rawLivePlanEnum);
    } else {
      livePlanEnum =
        rawLivePlanEnum ??
        liveTurnCfg?.planModelEnum ??
        (execMetaAppliesToCurrentSession && isCurrentLatestSessionTurn ? execMetaPlanEnum : undefined);
    }
    const slot = classifyContextModelSlot({
      responseModel: liveGen?.responseModel,
      modelDisplayName: liveGen?.modelDisplayName,
      plannerModelName: liveGen?.plannerModelName,
      stepModelName: liveStep.modelName,
      modelEnum: liveGen?.modelEnum,
      planModelEnum: livePlanEnum,
      executionModelEnum: liveExecEnum,
      hasPriorOrchestrator: orchestratorTurns.has(liveTurnIdx),
    });
    const explicitCap = [liveGen?.maxContextTokens, liveStep.modelMaxTokens].find(isPositiveSafeInt);
    return { slot, explicitCap };
  };

  if (isOrchestrator) {
    const planners = allAccs.filter((a) => a.slot.role === 'planner');
    const executors = allAccs.filter((a) => a.slot.role === 'executor');
    const others = allAccs.filter((a) => a.slot.role === 'model');
    inheritedOrchCap =
      [...planners, ...executors].find((a) => a.explicitCapacity !== undefined)?.explicitCapacity ??
      executorExplicitCap;

    if (planners.length === 0) {
      const fallbackPlannerSlot = createPendingPlannerSlot({
        planModelEnum: effectivePlanModelEnum,
        plannerModelName: latestEntry.genMeta?.plannerModelName ?? input.executorMetadata?.plannerModelName,
        inputPlannerSlot: inputAsStandaloneSlot?.role === 'planner' ? inputAsStandaloneSlot : null,
        capacityTokens: activeAcc.slot.capacityTokens,
        isFallbackModel: activeAcc.slot.isFallbackModel,
      });
      planners.push({
        slot: fallbackPlannerSlot,
        latestPrompt: 0,
        peakContextTokens: 0,
        explicitCapacity: inheritedOrchCap ?? inputExplicitCapacity,
        lastSeenSeq: -1,
      });
    }
    const primaryPlanner = planners[0]!;
    if (executors.length === 0) {
      const pendingExecSlot = createPendingExecutorSlot({
        executionModelEnum: effectiveExecutionModelEnum,
        capacityTokens: primaryPlanner.slot.capacityTokens,
        isFallbackModel: primaryPlanner.slot.isFallbackModel,
      });
      const sameAsAnyPlanner =
        planners.some(
          (p) =>
            p.slot.slotKey === pendingExecSlot.slotKey ||
            (pendingExecSlot.modelId !== 'pending' && p.slot.modelId === pendingExecSlot.modelId)
        ) ||
        (!effectiveExecutionModelEnum && primaryPlanner.slot.shortLabel === 'Hydrogen');
      if (!sameAsAnyPlanner) {
        executors.push({
          slot: pendingExecSlot,
          latestPrompt: 0,
          peakContextTokens: 0,
          explicitCapacity: inheritedOrchCap ?? inputExplicitCapacity,
          lastSeenSeq: -1,
        });
      }
    }

    const peByModelId = new Map<string, StageAccumulator & { lastSeenSeq: number }>();
    for (const pe of [...planners, ...executors]) {
      const modelId = pe.slot.modelId;
      if (modelId && modelId !== 'pending' && modelId !== 'unknown') {
        const existingPe = peByModelId.get(modelId);
        if (!existingPe || (!existingPe.latestStep && Boolean(pe.latestStep))) {
          peByModelId.set(modelId, pe);
        }
      }
    }
    const filteredOthersRaw: Array<StageAccumulator & { lastSeenSeq: number }> = [];
    for (const other of others) {
      if (!Boolean(other.latestStep)) continue;
      const absorbedTarget = peByModelId.get(other.slot.modelId);
      if (absorbedTarget) {
        absorbedTarget.peakContextTokens = Math.max(absorbedTarget.peakContextTokens, other.peakContextTokens);
        if (other.compactionCount && other.compactionCount > 0) {
          absorbedTarget.compactionCount = (absorbedTarget.compactionCount ?? 0) + other.compactionCount;
        }
        if (other.lastSeenSeq > absorbedTarget.lastSeenSeq) {
          absorbedTarget.latestStep = other.latestStep;
          absorbedTarget.latestPrompt = other.latestPrompt;
          if (other.explicitCapacity !== undefined) {
            absorbedTarget.explicitCapacity = other.explicitCapacity;
          }
          absorbedTarget.lastSeenSeq = other.lastSeenSeq;
        } else if (absorbedTarget.explicitCapacity === undefined && other.explicitCapacity !== undefined) {
          absorbedTarget.explicitCapacity = other.explicitCapacity;
        }
        if (other.slot.slotKey === effectiveActiveSlotKey) {
          effectiveActiveSlotKey = absorbedTarget.slot.slotKey;
        }
        continue;
      }
      filteredOthersRaw.push(other);
    }
    // 吸收可能刚刚填充了 planner/executor 的 explicitCapacity，刷新 inheritedOrchCap 供 pending 槽位继承
    inheritedOrchCap =
      [...planners, ...executors].find((a) => a.explicitCapacity !== undefined)?.explicitCapacity ??
      inheritedOrchCap;
    const filteredOthersSorted: StageAccumulator[] = [...filteredOthersRaw].sort((a, b) => a.lastSeenSeq - b.lastSeenSeq);

    const primaryAccs: StageAccumulator[] = [...planners, ...executors];
    if (hasPendingInputSlot([...primaryAccs, ...filteredOthersSorted]) && inputAsStandaloneSlot) {
      primaryAccs.push({
        slot: inputAsStandaloneSlot,
        latestPrompt: 0,
        peakContextTokens: 0,
        explicitCapacity: inputExplicitCapacity,
      });
    }
    const trailingLiveOrch = resolveTrailingLiveModelSlot();
    if (trailingLiveOrch) {
      const matched = findMatchingSlot([...primaryAccs, ...filteredOthersSorted], trailingLiveOrch.slot);
      if (matched) {
        effectiveActiveSlotKey = matched.slot.slotKey;
      } else if (trailingLiveOrch.slot.hasExplicitEvidence && trailingLiveOrch.slot.modelId !== 'unknown') {
        const pendingLiveAcc: StageAccumulator = {
          slot: trailingLiveOrch.slot,
          latestStep: undefined,
          latestPrompt: 0,
          peakContextTokens: 0,
          ...(trailingLiveOrch.explicitCap !== undefined ? { explicitCapacity: trailingLiveOrch.explicitCap } : {}),
        };
        if (trailingLiveOrch.slot.role === 'planner' || trailingLiveOrch.slot.role === 'executor') {
          primaryAccs.push(pendingLiveAcc);
        } else {
          filteredOthersSorted.push(pendingLiveAcc);
        }
        effectiveActiveSlotKey = trailingLiveOrch.slot.slotKey;
      }
    } else if (liveContext?.latestTurnRunning === true && liveContext.latestSessionTurn > lastTurnNum) {
      const validPlanner = planners.find(
        (p) => p.slot.modelId !== 'unknown' && p.slot.modelId !== 'pending'
      );
      if (validPlanner) {
        effectiveActiveSlotKey = validPlanner.slot.slotKey;
      }
    }
    const allOrchAccs: StageAccumulator[] = [...primaryAccs, ...filteredOthersSorted];
    let cappedAccs: StageAccumulator[];
    if (allOrchAccs.length > 5) {
      const maxOthers = Math.max(0, 5 - primaryAccs.length);
      if (primaryAccs.length >= 5) {
        const tail = primaryAccs.slice(-5);
        const activeInPrimary = primaryAccs.find((a) => a.slot.slotKey === effectiveActiveSlotKey);
        cappedAccs =
          activeInPrimary && !tail.includes(activeInPrimary)
            ? [activeInPrimary, ...tail.slice(1)]
            : tail;
      } else {
        const tailOthers = maxOthers > 0 ? filteredOthersSorted.slice(-maxOthers) : [];
        const activeInOthers = filteredOthersSorted.find((a) => a.slot.slotKey === effectiveActiveSlotKey);
        const keptOthers =
          activeInOthers && !tailOthers.includes(activeInOthers)
            ? maxOthers > 0
              ? [activeInOthers, ...tailOthers.slice(1)]
              : [activeInOthers]
            : tailOthers;
        cappedAccs = [...primaryAccs, ...keptOthers].slice(0, 5);
      }
    } else {
      cappedAccs = allOrchAccs;
    }
    orderedEntries = cappedAccs.map((acc) => ({ acc, section: 'primary' as const }));
  } else {
    const dedupByModelId = new Map<string, StageAccumulator & { lastSeenSeq: number }>();
    const latestOrchRoleByModelId = new Map<
      string,
      { role: 'planner' | 'executor'; slotKey: string; lastSeenSeq: number }
    >();
    for (const acc of allAccs) {
      if (acc.slot.role === 'planner' || acc.slot.role === 'executor') {
        const key = acc.slot.modelId || acc.slot.slotKey;
        const prevOrch = latestOrchRoleByModelId.get(key);
        if (!prevOrch || acc.lastSeenSeq > prevOrch.lastSeenSeq) {
          latestOrchRoleByModelId.set(key, {
            role: acc.slot.role,
            slotKey: acc.slot.slotKey,
            lastSeenSeq: acc.lastSeenSeq,
          });
        }
      }
    }
    for (const acc of allAccs) {
      const key = acc.slot.modelId || acc.slot.slotKey;
      const existing = dedupByModelId.get(key);
      const mergedCompactions = (existing?.compactionCount ?? 0) + (acc.compactionCount ?? 0);
      const mergedPeak = Math.max(existing?.peakContextTokens ?? 0, acc.peakContextTokens);
      if (!existing || acc.lastSeenSeq > existing.lastSeenSeq) {
        if (existing && existing.slot.slotKey === effectiveActiveSlotKey) {
          effectiveActiveSlotKey = acc.slot.slotKey;
        }
        dedupByModelId.set(key, {
          ...acc,
          peakContextTokens: mergedPeak,
          ...(mergedCompactions > 0 ? { compactionCount: mergedCompactions } : {}),
        });
      } else {
        if (acc.slot.slotKey === effectiveActiveSlotKey) {
          effectiveActiveSlotKey = existing.slot.slotKey;
        }
        dedupByModelId.set(key, {
          ...existing,
          peakContextTokens: mergedPeak,
          ...(mergedCompactions > 0 ? { compactionCount: mergedCompactions } : {}),
        });
      }
    }
    for (const [key, acc] of dedupByModelId.entries()) {
      const orch = latestOrchRoleByModelId.get(key);
      if (orch && acc.slot.role === 'model') {
        if (acc.slot.slotKey === effectiveActiveSlotKey) {
          effectiveActiveSlotKey = orch.slotKey;
        }
        dedupByModelId.set(key, {
          ...acc,
          slot: {
            ...acc.slot,
            role: orch.role,
            slotKey: orch.slotKey,
          },
        });
      }
    }
    const orderedAccs: StageAccumulator[] = [...dedupByModelId.values()].sort(
      (a, b) => a.lastSeenSeq - b.lastSeenSeq
    );
    if (hasPendingInputSlot(orderedAccs) && inputAsStandaloneSlot) {
      orderedAccs.push({
        slot: inputAsStandaloneSlot,
        latestPrompt: 0,
        peakContextTokens: 0,
        explicitCapacity: inputExplicitCapacity,
      });
    }
    const trailingLiveStandalone = resolveTrailingLiveModelSlot();
    if (trailingLiveStandalone) {
      const matched = findMatchingSlot(orderedAccs, trailingLiveStandalone.slot);
      if (matched) {
        effectiveActiveSlotKey = matched.slot.slotKey;
      } else if (trailingLiveStandalone.slot.hasExplicitEvidence && trailingLiveStandalone.slot.modelId !== 'unknown') {
        orderedAccs.push({
          slot: trailingLiveStandalone.slot,
          latestStep: undefined,
          latestPrompt: 0,
          peakContextTokens: 0,
          ...(trailingLiveStandalone.explicitCap !== undefined ? { explicitCapacity: trailingLiveStandalone.explicitCap } : {}),
        });
        effectiveActiveSlotKey = trailingLiveStandalone.slot.slotKey;
      }
    } else if (liveContext?.latestTurnRunning === true && liveContext.latestSessionTurn > lastTurnNum) {
      if (
        inputAsStandaloneSlot &&
        inputAsStandaloneSlot.hasExplicitEvidence &&
        inputAsStandaloneSlot.modelId !== 'unknown' &&
        inputAsStandaloneSlot.modelId !== 'pending'
      ) {
        const matched = findMatchingSlot(orderedAccs, inputAsStandaloneSlot);
        if (matched) {
          effectiveActiveSlotKey = matched.slot.slotKey;
        }
      }
    }
    let finalAccs: StageAccumulator[];
    if (orderedAccs.length > 5) {
      const tail = orderedAccs.slice(-5);
      const pinnedInput =
        inputAsStandaloneSlot &&
        inputAsStandaloneSlot.hasExplicitEvidence &&
        inputAsStandaloneSlot.modelId !== 'unknown'
          ? orderedAccs.find(
              (a) =>
                a.slot.slotKey === inputAsStandaloneSlot.slotKey ||
                a.slot.modelId === inputAsStandaloneSlot.modelId
            )
          : undefined;
      const activeInOrdered = orderedAccs.find((a) => a.slot.slotKey === effectiveActiveSlotKey);
      if (activeInOrdered && !tail.includes(activeInOrdered)) {
        const dropIdx = tail.findIndex((a) => a !== pinnedInput && a.slot.slotKey !== effectiveActiveSlotKey);
        if (dropIdx >= 0) {
          tail.splice(dropIdx, 1);
          tail.unshift(activeInOrdered);
        }
      }
      if (pinnedInput && !tail.includes(pinnedInput)) {
        const dropIdx = tail.findIndex((a) => a.slot.slotKey !== effectiveActiveSlotKey);
        if (dropIdx >= 0) {
          tail.splice(dropIdx, 1);
          finalAccs = [pinnedInput, ...tail];
        } else {
          finalAccs = tail;
        }
      } else {
        finalAccs = tail;
      }
    } else {
      finalAccs = orderedAccs;
    }
    orderedEntries = finalAccs.map((acc) => ({ acc, section: 'primary' as const }));
  }

  const primaryNonPending = orderedEntries.filter(({ acc }) => Boolean(acc.latestStep));
  const isMultiModel =
    orderedEntries.length >= 2 &&
    (isOrchestrator ||
      primaryNonPending.length >= 2 ||
      orderedEntries.some(({ acc }) => !acc.latestStep));
  const modelStages = isMultiModel
    ? (() => {
        let assignedActive = false;
        return orderedEntries.map(({ acc, section }) => {
          const inheritCap =
            !acc.latestStep && isOrchestrator && (acc.slot.role === 'planner' || acc.slot.role === 'executor')
              ? inheritedOrchCap
              : undefined;
          const isMatch = !assignedActive && acc.slot.slotKey === effectiveActiveSlotKey;
          if (isMatch) assignedActive = true;
          return createStageSnapshot(acc, isMatch, inheritCap, section);
        });
      })()
    : undefined;
  const activeStageAcc =
    orderedEntries.find(({ acc }) => acc.slot.slotKey === effectiveActiveSlotKey)?.acc ??
    orderedEntries[0]?.acc ??
    activeAcc;
  const activeStage =
    modelStages?.find((s) => s.isActive) ??
    createStageSnapshot(activeStageAcc, true);

  return {
    latestStep: activeStageAcc?.latestStep,
    latestUsageStep: latestEntry.step,
    latestGenMeta: latestEntry.genMeta,
    sessionPeakContextTokens,
    activeStage,
    hasExplicitModelEvidence: activeStageAcc
      ? activeStageAcc.slot.hasExplicitEvidence
      : latestEntry.slot.hasExplicitEvidence,
    isMultiModel,
    isOrchestrator,
    modelStages,
    defaultFallbackModel: latestEntry.slot.hasExplicitEvidence
      ? latestEntry.slot.role === 'model'
        ? latestEntry.slot.displayName
        : latestEntry.slot.modelId
      : '',
  };
}

export function buildConversationHudMetrics(input: ComputeHudMetricsInput): ConversationHudMetrics {
  const steps = input.steps || [];
  const contextSteps = input.contextSteps ?? steps;
  const contextStepSet = input.contextSteps ? new Set(contextSteps) : null;
  let modelSteps = 0;
  let toolSteps = 0;
  let mainCompletedModelDuration = 0;
  let unanchoredChildModelDuration = 0;
  const mainCompletedModelIntervals: Array<readonly [number, number]> = [];
  const childCompletedModelIntervals: Array<readonly [number, number]> = [];
  const completedToolIntervals: Array<readonly [number, number]> = [];
  let timedOutputTokens = 0;
  let timedOutputSeconds = 0;
  let timedOutputCount = 0;
  let latestForegroundStepTps: { outputTps: number; formatted: string } | null = null;
  let latestAnyStepTps: { outputTps: number; formatted: string } | null = null;
  let latestForegroundStepTtft: { seconds: number; formatted: string; formattedEn: string } | null = null;
  let latestAnyStepTtft: { seconds: number; formatted: string; formattedEn: string } | null = null;
  let validTtftSum = 0;
  let validTtftCount = 0;
  const usageStepsForCost: Array<{
    step: ComputeHudMetricsInput['steps'][number];
    isChildStep: boolean;
    rawInput: number;
    cached: number;
    written: number;
    output: number;
  }> = [];
  let detectedSubagents = 0;
  let detectedRunningSubagents = 0;
  let uncachedInputTokens = 0;
  let cachedReadTokens = 0;
  let cacheWriteTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let candidateTokens = 0;
  let usageSampleCount = 0;

  for (const step of steps) {
    const stepType = step.step_type ?? step.stepType ?? 0;
    const start = step.t_start ?? step.startTimeSeconds;
    const first = step.t_first_token ?? step.firstTokenSeconds;
    const end = step.t_end ?? step.endTimeSeconds;
    const rawStatus = step.status ?? 3;
    const complete = isStepCompleted(step);
    const hasInterval = validSeconds(start) && validSeconds(end) && end > start;
    const isChildStep = Boolean(contextStepSet && !contextStepSet.has(step));
    const subagent = Boolean(step.isSubagentStep) || stepType === 127 ||
      Boolean(step.toolCallName && SUBAGENT_TOOL_NAMES.has(step.toolCallName));
    if (subagent) {
      detectedSubagents++;
    }
    if (stepType === 15) {
      modelSteps++;
      if (step.hasUsage !== false) usageSampleCount++;
      const rawInput = safeTokens(step.rawInput ?? step.rawInputTokens);
      const cached = safeTokens(step.cachedTokens ?? step.cachedReadTokens);
      const written = safeTokens(step.cacheWriteTokens);
      const output = safeTokens(step.outputTokens);
      uncachedInputTokens += rawInput;
      cachedReadTokens += cached;
      cacheWriteTokens += written;
      outputTokens += output;
      reasoningTokens += safeTokens(step.reasoningTokens);
      candidateTokens += safeTokens(step.candidateTokens);
      if (step.hasUsage !== false) {
        usageStepsForCost.push({ step, isChildStep, rawInput, cached, written, output });
      }

      const gen = step.generation;
      const rawTtft = gen?.timeToFirstTokenSeconds;
      const rawStreaming = gen?.streamingDurationSeconds;
      const duration = validSeconds(rawTtft) && validSeconds(rawStreaming) && rawTtft + rawStreaming > 0
        ? rawTtft + rawStreaming
        : hasInterval ? end! - start! : null;
      if (complete && duration !== null) {
        if (isChildStep) {
          if (validSeconds(start)) {
            childCompletedModelIntervals.push([start, start + duration]);
          } else {
            unanchoredChildModelDuration += duration;
          }
        } else {
          mainCompletedModelDuration += duration;
          if (validSeconds(start)) {
            mainCompletedModelIntervals.push([start, start + duration]);
          }
        }
        if (step.hasUsage !== false && Number.isSafeInteger(step.outputTokens) && step.outputTokens! >= 0) {
          timedOutputTokens += output;
          timedOutputSeconds += duration;
          timedOutputCount++;
          const stepTps = computeTps(duration, output);
          if (stepTps.status === 'calculated') {
            const snapshot = { outputTps: stepTps.outputTps, formatted: stepTps.formatted };
            if (!isChildStep) {
              latestForegroundStepTps = snapshot;
            }
            latestAnyStepTps = snapshot;
          }
        }
      }
      const ttft = validSeconds(rawTtft)
        ? rawTtft
        : hasInterval && validSeconds(first) && first >= start! && first <= end!
        ? first - start! : null;
      if (complete && ttft !== null) {
        validTtftSum += ttft;
        validTtftCount++;
        const ttftText = compactRate(ttft);
        const ttftSnapshot = {
          seconds: ttft,
          formatted: bt('metrics.ttft_seconds', { value: ttftText }),
          formattedEn: `${ttftText}s`,
        };
        if (!isChildStep) {
          latestForegroundStepTtft = ttftSnapshot;
        }
        latestAnyStepTtft = ttftSnapshot;
      }
    } else if (!NON_TOOL_STEP_TYPES.has(stepType)) {
      toolSteps++;
      if (hasInterval && !ACTIVE_STEP_STATUSES.has(rawStatus)) {
        completedToolIntervals.push([start!, end!]);
      }
    }
  }
  if (Array.isArray(input.extraUsageGenerations) && input.extraUsageGenerations.length > 0) {
    for (const extra of input.extraUsageGenerations) {
      const u = extra?.generation?.usage;
      if (!u) continue;
      const rawInput = safeTokens(u.rawInputTokens);
      const cached = safeTokens(u.cachedReadTokens);
      const written = safeTokens(u.cacheWriteTokens);
      const output = safeTokens(u.outputTokens);
      if (rawInput + cached + written + output <= 0) continue;
      usageSampleCount++;
      uncachedInputTokens += rawInput;
      cachedReadTokens += cached;
      cacheWriteTokens += written;
      outputTokens += output;
      reasoningTokens += safeTokens(u.reasoningTokens);
      candidateTokens += safeTokens(u.candidateTokens);
      const ts = validSeconds(extra.timestampSeconds) && extra.timestampSeconds > 0
        ? extra.timestampSeconds
        : validSeconds(extra.generation.startedAtSeconds) && extra.generation.startedAtSeconds > 0
        ? extra.generation.startedAtSeconds
        : null;
      usageStepsForCost.push({
        step: {
          stepType: 15,
          hasUsage: true,
          startTimeSeconds: ts,
          rawInputTokens: rawInput,
          cachedReadTokens: cached,
          cacheWriteTokens: written,
          outputTokens: output,
          generation: extra.generation,
        },
        isChildStep: Boolean(extra.isChildStep),
        rawInput,
        cached,
        written,
        output,
      });
    }
  }
  const mainCompletedAnchoredTotal = mergeDurationIntervals(mainCompletedModelIntervals);
  const allCompletedModelIntervals = [
    ...mainCompletedModelIntervals,
    ...childCompletedModelIntervals,
  ];
  const allCompletedAnchoredTotal = mergeDurationIntervals(allCompletedModelIntervals);
  const incrementalChildAnchoredDuration = Math.max(
    0,
    allCompletedAnchoredTotal - mainCompletedAnchoredTotal
  );
  const childCompletedModelDuration = incrementalChildAnchoredDuration + unanchoredChildModelDuration;
  const modelDurationSeconds = mainCompletedModelDuration + childCompletedModelDuration;
  const toolDurationSeconds = mergeDurationIntervals(completedToolIntervals);

  const usageContextEntries: Array<{ step: ComputeHudMetricsInput['steps'][number]; prompt: number; turnIndex: number }> = [];
  const compactionContextEntries: Array<{
    step: ComputeHudMetricsInput['steps'][number];
    precedingUsageIndex: number;
    turnIndex: number;
  }> = [];
  let turns = 0;
  let compactionCount = 0;
  let lastUserStepIdx = -1;
  let lastUsageContextStepIdx = -1;
  let trailingActiveModelStep:
    | { step: ComputeHudMetricsInput['steps'][number]; turnIndex: number }
    | undefined;
  for (let i = 0; i < contextSteps.length; i++) {
    const step = contextSteps[i]!;
    const stepType = step.step_type ?? step.stepType ?? 0;
    const rawStatus = step.status ?? 3;
    if (stepType === 14) {
      turns++;
      lastUserStepIdx = i;
    }
    if (stepType === 23 && (rawStatus === 3 || rawStatus === 5)) {
      compactionCount++;
      compactionContextEntries.push({
        step,
        precedingUsageIndex: usageContextEntries.length - 1,
        turnIndex: turns,
      });
    }
    if (stepType !== 15) continue;
    const hasUsage = step.hasUsage !== false;
    const prompt = hasUsage
      ? safeTokens(step.rawInput ?? step.rawInputTokens) +
        safeTokens(step.cachedTokens ?? step.cachedReadTokens) +
        safeTokens(step.cacheWriteTokens)
      : 0;
    const estCtx = safeTokens(step.generation?.estimatedTokensUsed);
    const effectivePrompt = prompt > 0 ? prompt : estCtx;
    const outputTok = hasUsage ? safeTokens(step.outputTokens) : 0;
    if (effectivePrompt > 0 || (step.hasUsage === true && outputTok > 0)) {
      usageContextEntries.push({ step, prompt: effectivePrompt, turnIndex: turns });
      lastUsageContextStepIdx = i;
      trailingActiveModelStep = undefined;
    } else if (
      i > lastUsageContextStepIdx &&
      !isStepCompleted(step) &&
      !TERMINAL_INACTIVE_STEP_STATUSES.has(rawStatus) &&
      rawStatus !== 5
    ) {
      trailingActiveModelStep = { step, turnIndex: turns };
    }
  }
  const latestTurnSteps = lastUserStepIdx >= 0 ? contextSteps.slice(lastUserStepIdx + 1) : contextSteps;
  const latestTurnLastSub = findLastSubstantiveStep(latestTurnSteps);
  const latestTurnLastSubType = latestTurnLastSub
    ? (latestTurnLastSub.step_type ?? latestTurnLastSub.stepType ?? 0)
    : 0;
  const latestTurnLastSubStatus = latestTurnLastSub?.status ?? 3;
  const isLatestTurnAborted =
    Boolean(latestTurnLastSub) &&
    TERMINAL_ABORTED_STEP_STATUSES.has(latestTurnLastSubStatus);
  const isLatestTurnClosed =
    Boolean(latestTurnLastSub) &&
    latestTurnLastSubType === 2 &&
    (latestTurnLastSubStatus === 3 || latestTurnLastSubStatus === 5);
  const hasActiveNonTerminalStepInLatestTurn = latestTurnSteps.some((step) => {
    const st = step.step_type ?? step.stepType ?? 0;
    if (TRANSPARENT_HANDOFF_STEP_TYPES.has(st)) return false;
    if (isWaitingSubagentToolName(step.toolCallName)) return false;
    const rawStatus = step.status ?? 3;
    return (
      RUNNING_SUBAGENT_STEP_STATUSES.has(rawStatus) &&
      !isStepCompleted(step) &&
      !TERMINAL_INACTIVE_STEP_STATUSES.has(rawStatus) &&
      rawStatus !== 5
    );
  });
  const liveContext: LiveHudContextInfo = {
    latestSessionTurn: turns,
    trailingActiveModelStep,
    latestTurnRunning:
      isLatestTurnAborted || isLatestTurnClosed
        ? false
        : Boolean(input.isStreaming || trailingActiveModelStep || hasActiveNonTerminalStepInLatestTurn),
  };
  let effectiveUsageContextEntries = usageContextEntries;
  let effectiveContextInput = input;
  if (usageContextEntries.length === 0 && input.inheritedContextStep) {
    const inh = input.inheritedContextStep;
    const inhWithGen =
      inh.generation || !input.inheritedGenMetadata
        ? inh
        : { ...inh, generation: input.inheritedGenMetadata };
    const inhPrompt =
      safeTokens(inhWithGen.rawInput ?? inhWithGen.rawInputTokens) +
      safeTokens(inhWithGen.cachedTokens ?? inhWithGen.cachedReadTokens) +
      safeTokens(inhWithGen.cacheWriteTokens);
    const inhEstCtx = safeTokens(
      inhWithGen.generation?.estimatedTokensUsed ?? input.inheritedGenMetadata?.estimatedTokensUsed
    );
    const inhEffectivePrompt = inhPrompt > 0 ? inhPrompt : inhEstCtx;
    const inhOutputTok = safeTokens(inhWithGen.outputTokens);
    if (inhEffectivePrompt > 0 || (inhWithGen.hasUsage === true && inhOutputTok > 0)) {
      effectiveUsageContextEntries = [{ step: inhWithGen, prompt: inhEffectivePrompt, turnIndex: 0 }];
    }
    if (!input.genMetadata && input.inheritedGenMetadata) {
      effectiveContextInput = { ...input, genMetadata: input.inheritedGenMetadata };
    }
  }
  const {
    latestStep,
    latestUsageStep,
    sessionPeakContextTokens,
    activeStage,
    hasExplicitModelEvidence,
    isMultiModel,
    isOrchestrator,
    modelStages,
    defaultFallbackModel: stageFallbackModel,
  } = resolveContextStagesAndActiveSlot(
    effectiveUsageContextEntries,
    effectiveContextInput,
    compactionContextEntries,
    liveContext
  );
  const activeModelCompactionCount = activeStage.compactionCount ?? 0;
  const peakContextTokens = activeStage.peakContextTokens;
  const capacityTokens = activeStage.capacityTokens;
  const capacityTokensCompact = activeStage.capacityTokensCompact;
  const capacitySource = activeStage.capacitySource;
  const hasExplicitDbCapacity = !activeStage.isFallbackCapacity;
  const latestHasUsage = latestStep?.hasUsage !== false;
  const stepCached = latestHasUsage ? safeTokens(latestStep?.cachedTokens ?? latestStep?.cachedReadTokens) : 0;
  const stepUncached = latestHasUsage
    ? safeTokens(latestStep?.rawInput ?? latestStep?.rawInputTokens) + safeTokens(latestStep?.cacheWriteTokens)
    : 0;
  const rawPromptTokens = stepCached + stepUncached;
  const fallbackEstimatedTokens =
    rawPromptTokens === 0 ? safeTokens(latestStep?.generation?.estimatedTokensUsed) : 0;
  const effectiveStepUncached = rawPromptTokens > 0 ? stepUncached : fallbackEstimatedTokens;
  const usedTokens = stepCached + effectiveStepUncached;
  const usedRatio = capacityTokens > 0 ? usedTokens / capacityTokens : 0;
  const stepCacheRatio = usedTokens > 0 ? stepCached / usedTokens : 0;
  const denominator = Math.max(capacityTokens, usedTokens, 1);
  const cachedBarRatio = stepCached / denominator * 100;
  const uncachedBarRatio = effectiveStepUncached / denominator * 100;
  const latestOutput = latestHasUsage ? safeTokens(latestStep?.outputTokens) : 0;
  let latestActiveForegroundKind: 'model' | 'tool' | null = null;
  const lastCtx = findLastSubstantiveStep(contextSteps);
  const lastCtxType = lastCtx ? (lastCtx.step_type ?? lastCtx.stepType ?? 0) : 0;
  const lastCtxStatus = lastCtx?.status ?? CORTEX_STEP_STATUS.DONE;
  const lastTurnAborted = Boolean(!input.isStreaming && lastCtx && lastCtxType !== 14 && TERMINAL_ABORTED_STEP_STATUSES.has(lastCtxStatus));
  if (input.allowDbActiveStepInference !== false && !lastTurnAborted) {
    let turnFinished = false;
    for (let index = contextSteps.length - 1; index >= 0; index--) {
      const candidate = contextSteps[index]!;
      const candidateType = candidate.step_type ?? candidate.stepType ?? 0;
      if (candidateType === 14) break;
      if (candidateType === 2 && (candidate.status ?? 3) === 3) {
        turnFinished = true;
        break;
      }
      const candidateStatus = candidate.status ?? 3;
      if (!ACTIVE_STEP_STATUSES.has(candidateStatus)) continue;
      const isCandidateSubagent =
        !isWaitingSubagentToolName(candidate.toolCallName) &&
        (Boolean(candidate.isSubagentStep) ||
          candidateType === 127 ||
          Boolean(candidate.toolCallName && SUBAGENT_TOOL_NAMES.has(candidate.toolCallName)));
      if (
        isCandidateSubagent &&
        !turnFinished &&
        RUNNING_SUBAGENT_STEP_STATUSES.has(candidateStatus)
      ) {
        detectedRunningSubagents++;
      }
      if (
        input.allowDbActiveStepInference &&
        latestActiveForegroundKind === null &&
        candidateStatus !== 9 &&
        !isWaitingSubagentToolName(candidate.toolCallName)
      ) {
        if (candidateType === 15) {
          latestActiveForegroundKind = 'model';
        } else if (!NON_TOOL_STEP_TYPES.has(candidateType)) {
          latestActiveForegroundKind = 'tool';
        }
      }
    }
  }
  const runningSubagentCount = Math.max(
    input.runningSubagentCount ?? 0, detectedRunningSubagents, input.isSubagentRunning ? 1 : 0
  );
  const isSubagentRunning = Boolean(input.isSubagentRunning || runningSubagentCount > 0);
  const dbForegroundActive = input.allowDbActiveStepInference === true && latestActiveForegroundKind !== null;
  const isStreaming = Boolean(input.isStreaming || isSubagentRunning || dbForegroundActive);
  // 小圆点活动阶段默认绑定当前分栏前台流式状态（input.isStreaming）；
  // 独立子智能体轨迹分栏因宿主 DOM 常无内部停止按钮，允许由底层数据库实锤的前台活跃步骤驱动状态圆点。
  let activityPhase: HudActivityPhase = 'idle';
  if (input.isStreaming || (input.isSubagentTrajectory === true && dbForegroundActive)) {
    if (input.activityPhase === 'executing' || latestActiveForegroundKind === 'tool') {
      activityPhase = 'executing';
    } else {
      activityPhase = 'generating';
    }
  }
  const tpsInfo = computeTps(timedOutputSeconds, timedOutputTokens);
  const outputTpsPending = timedOutputCount === 0 && isStreaming;
  const outputTpsFormatted = timedOutputCount > 0 ? tpsInfo.formatted : isStreaming ? bt('metrics.calculating') : '—';
  const latestStepTpsInfo = timedOutputCount > 0 ? (latestForegroundStepTps ?? latestAnyStepTps) : null;
  const latestStepTtftInfo = validTtftCount > 0 ? (latestForegroundStepTtft ?? latestAnyStepTtft) : null;
  const averageTtftSeconds = validTtftCount > 0 ? validTtftSum / validTtftCount : 0;
  const totalTokens = uncachedInputTokens + cachedReadTokens + cacheWriteTokens + outputTokens;
  const inputTokens = uncachedInputTokens + cachedReadTokens + cacheWriteTokens;
  const cacheHitRate = inputTokens > 0 ? cachedReadTokens / inputTokens : 0;
  const availability: HudDataAvailability = input.availability ?? 'ready';
  const isFrozenSnapshot = availability === 'cached' || availability === 'remote_stale';
  const nowMs = Date.now();
  const observedAt = input.observedAt !== undefined ? input.observedAt : (availability === 'unavailable' ? null : nowMs);
  const lastSuccessAt = input.lastSuccessAt !== undefined ? input.lastSuccessAt : observedAt;
  const referenceNowMs =
    isFrozenSnapshot && typeof lastSuccessAt === 'number' && Number.isFinite(lastSuccessAt)
      ? lastSuccessAt
      : nowMs;
  const pricingTable = input.pricingTable ?? DEFAULT_API_PRICES;
  let estimatedCostUsd = 0;
  let cacheSavedUsd = 0;
  let pricedUsageSteps = 0;
  let unpricedUsageSteps = 0;
  const defaultFallbackModel =
    (typeof stageFallbackModel === 'string' && stageFallbackModel.trim()) ||
    (typeof input.modelId === 'string' && input.modelId.trim()) ||
    '';
  const defaultPriceTsSeconds = Math.floor(referenceNowMs / 1000);
  const resolveExplicitStepModel = (step: ComputeHudMetricsInput['steps'][number]): string => {
    const resolvedStepGenModel =
      step.generation && (step.generation.responseModel || step.generation.modelDisplayName || step.generation.modelEnum)
        ? resolveDatabaseModelFullName(
            step.generation.responseModel,
            step.generation.modelDisplayName,
            step.generation.modelEnum ?? null
          )
        : '';
    return (
      (resolvedStepGenModel &&
      resolvedStepGenModel !== '未知模型' &&
      resolvedStepGenModel !== 'Unknown Model' &&
      resolvedStepGenModel !== bt('usage.unknown_model')
        ? resolvedStepGenModel
        : '') ||
      step.generation?.plannerModelName ||
      step.modelName ||
      ''
    );
  };
  let firstExplicitMainStepModel = '';
  for (const candidate of usageStepsForCost) {
    if (candidate.isChildStep) continue;
    const explicit = resolveExplicitStepModel(candidate.step);
    if (explicit) {
      firstExplicitMainStepModel = explicit;
      break;
    }
  }
  let lastExplicitMainStepModel = '';
  for (const item of usageStepsForCost) {
    const step = item.step;
    const explicitStepModel = resolveExplicitStepModel(step);
    if (!item.isChildStep && explicitStepModel) {
      lastExplicitMainStepModel = explicitStepModel;
    }
    const isLiveLatestStep = Boolean(
      input.isStreaming && latestUsageStep && step === latestUsageStep && !isStepCompleted(step)
    );
    const contextualMainFallback = isLiveLatestStep
      ? defaultFallbackModel
      : lastExplicitMainStepModel || firstExplicitMainStepModel || defaultFallbackModel;
    const stepModel =
      explicitStepModel ||
      (item.isChildStep ? '' : contextualMainFallback);
    const stepTs = [
      step.t_start,
      step.startTimeSeconds,
      step.createdAtSeconds,
      step.t_end,
      step.endTimeSeconds,
      step.completedAtSeconds,
    ].find((ts) => validSeconds(ts) && ts > 0);
    const rawPricingEntry = stepModel ? lookupPricingEntry(pricingTable, stepModel) : null;
    const price = !stepModel
      ? null
      : stepTs
        ? resolvePricingFromTable(pricingTable, stepModel, stepTs)
        : rawPricingEntry && !isTemporalPricingEntry(rawPricingEntry.entry)
          ? resolvePricingFromTable(pricingTable, stepModel, defaultPriceTsSeconds)
          : null;
    const effectivePrice = price
      ? resolveContextTierPricing(price, item.rawInput + item.cached + item.written)
      : null;
    if (!effectivePrice || (item.written > 0 && !Number.isFinite(effectivePrice.cacheWrite))) {
      if (item.rawInput + item.cached + item.written + item.output > 0) {
        unpricedUsageSteps++;
      }
      continue;
    }
    try {
      estimatedCostUsd += calculateEstimatedUsd(item.rawInput, item.output, item.cached, effectivePrice, item.written);
      const unitSaved = Math.max(0, effectivePrice.input - effectivePrice.cached);
      if (item.cached > 0 && unitSaved > 0) {
        cacheSavedUsd += (item.cached * unitSaved) / 1_000_000;
      }
      pricedUsageSteps++;
    } catch {
      unpricedUsageSteps++;
    }
  }
  estimatedCostUsd = Math.round(estimatedCostUsd * 1e8) / 1e8;
  cacheSavedUsd = Math.round(cacheSavedUsd * 1e8) / 1e8;
  const resolvedModelId = !hasExplicitModelEvidence ? 'unknown' : activeStage.modelId;
  const resolvedModelDisplayName =
    !hasExplicitModelEvidence
      ? '—'
      : activeStage.modelDisplayName;

  // 计算本轮起步点与当轮耗时 (Turn Duration)
  let lastTurnStartIndex = -1;
  for (let index = contextSteps.length - 1; index >= 0; index--) {
    const candidate = contextSteps[index]!;
    const candidateType = candidate.step_type ?? candidate.stepType ?? 0;
    if (candidateType === 14) {
      lastTurnStartIndex = index;
      break;
    }
  }

  const turnSteps = lastTurnStartIndex >= 0 ? contextSteps.slice(lastTurnStartIndex) : contextSteps;
  const turnModelIntervals: Array<readonly [number, number]> = [];
  const turnToolIntervals: Array<readonly [number, number]> = [];
  const turnChildIntervals: Array<readonly [number, number]> = [];
  let unanchoredTurnModelDuration = 0;
  let currentTurnTimedOutputTokens = 0;
  let currentTurnTimedOutputSeconds = 0;
  let currentTurnTimedSamples = 0;
  let turnWallStart: number | null = null;
  let turnCompletedEnd: number | null = null;
  let hasActiveStepInTurn = false;
  let hasSubagentStepInTurn = false;
  const nowSeconds = referenceNowMs / 1000;
  const allowActiveInference = !isFrozenSnapshot && input.allowDbActiveStepInference !== false;
  const lastTurnStep = findLastSubstantiveStep(turnSteps);
  const lastTurnStepAborted =
    lastTurnStep !== undefined &&
    TERMINAL_ABORTED_STEP_STATUSES.has(lastTurnStep.status ?? CORTEX_STEP_STATUS.DONE);
  const lastTurnStepAbortedMissingEnd =
    lastTurnStepAborted &&
    !validSeconds(
      lastTurnStep!.t_end ??
        lastTurnStep!.endTimeSeconds ??
        lastTurnStep!.completedAtSeconds ??
        lastTurnStep!.finishedGeneratingSeconds
    );
  const allowForegroundActiveInTurn = allowActiveInference && !(!input.isStreaming && lastTurnStepAborted);

  const trackWallStart = (ts: number | null | undefined) => {
    if (validSeconds(ts)) {
      turnWallStart = turnWallStart === null ? ts : Math.min(turnWallStart, ts);
    }
  };
  const trackWallEnd = (ts: number | null | undefined) => {
    if (validSeconds(ts)) {
      turnCompletedEnd = turnCompletedEnd === null ? ts : Math.max(turnCompletedEnd, ts);
    }
  };

  for (const step of turnSteps) {
    const stepType = step.step_type ?? step.stepType ?? 0;
    const stepStart = step.t_start ?? step.startTimeSeconds ?? step.createdAtSeconds;
    trackWallStart(stepStart);
    if (stepType === 14) continue;
    const start = step.t_start ?? step.startTimeSeconds;
    const end = step.t_end ?? step.endTimeSeconds;
    const rawStatus = step.status ?? 3;
    if (
      Boolean(step.isSubagentStep) ||
      stepType === 127 ||
      Boolean(step.toolCallName && SUBAGENT_TOOL_NAMES.has(step.toolCallName)) ||
      (step.childConversationIds && step.childConversationIds.length > 0)
    ) {
      hasSubagentStepInTurn = true;
    }
    const complete = isStepCompleted(step);
    const activeNow =
      !isFrozenSnapshot &&
      isStepActiveNow(step, isStreaming, allowForegroundActiveInTurn, {
        allowWaitingStatus: Boolean(input.isStreaming),
      });
    const hasInterval = validSeconds(start) && validSeconds(end) && end > start;
    if (complete) {
      trackWallEnd(end ?? step.finishedGeneratingSeconds ?? step.completedAtSeconds ?? start);
    } else if (activeNow) {
      hasActiveStepInTurn = true;
    } else if (TERMINAL_ABORTED_STEP_STATUSES.has(rawStatus)) {
      const terminalEndedTs = end ?? step.completedAtSeconds ?? step.finishedGeneratingSeconds;
      if (validSeconds(terminalEndedTs) && (!validSeconds(start) || terminalEndedTs >= start)) {
        trackWallEnd(terminalEndedTs);
      }
    }

    if (stepType === 15) {
      const gen = step.generation;
      const rawTtft = gen?.timeToFirstTokenSeconds;
      const rawStreaming = gen?.streamingDurationSeconds;
      const duration = validSeconds(rawTtft) && validSeconds(rawStreaming) && rawTtft + rawStreaming > 0
        ? rawTtft + rawStreaming
        : hasInterval ? end! - start! : null;
      if (complete && duration !== null) {
        if (validSeconds(start)) {
          turnModelIntervals.push([start, start + duration]);
        } else {
          unanchoredTurnModelDuration += duration;
        }
        if (step.hasUsage !== false && Number.isSafeInteger(step.outputTokens) && step.outputTokens! >= 0) {
          currentTurnTimedOutputTokens += safeTokens(step.outputTokens);
          currentTurnTimedOutputSeconds += duration;
          currentTurnTimedSamples++;
        }
      } else if (validSeconds(start) && activeNow) {
        turnModelIntervals.push([start, Math.max(start, nowSeconds)]);
      }
    } else if (!NON_TOOL_STEP_TYPES.has(stepType)) {
      if (hasInterval && !ACTIVE_STEP_STATUSES.has(rawStatus)) {
        turnToolIntervals.push([start!, end!]);
      } else if (validSeconds(start) && activeNow) {
        turnToolIntervals.push([start, Math.max(start, nowSeconds)]);
      }
    }
  }

  let prevTurnBoundarySeconds: number | null = null;
  if (lastTurnStartIndex > 0) {
    for (let index = lastTurnStartIndex - 1; index >= 0; index--) {
      const prev = contextSteps[index]!;
      const prevEnd =
        prev.t_end ??
        prev.endTimeSeconds ??
        prev.finishedGeneratingSeconds ??
        prev.completedAtSeconds ??
        prev.t_start ??
        prev.startTimeSeconds ??
        prev.createdAtSeconds;
      if (validSeconds(prevEnd)) {
        prevTurnBoundarySeconds =
          prevTurnBoundarySeconds === null ? prevEnd : Math.max(prevTurnBoundarySeconds, prevEnd);
      }
    }
  }
  const childStepsAll = steps.length > contextSteps.length ? steps.slice(contextSteps.length) : [];
  const childStepsInTurn = childStepsAll.filter((step) => {
    const start = step.t_start ?? step.startTimeSeconds ?? step.createdAtSeconds;
    const end = step.t_end ?? step.endTimeSeconds ?? step.finishedGeneratingSeconds ?? step.completedAtSeconds;
    if (turnWallStart !== null) {
      if (validSeconds(start)) return start >= turnWallStart - 1;
      if (validSeconds(end)) return end >= turnWallStart - 1;
      const activeChildNow =
        !isFrozenSnapshot && isStepActiveNow(step, isStreaming, allowActiveInference);
      return Boolean(hasSubagentStepInTurn && activeChildNow);
    }
    if (prevTurnBoundarySeconds !== null) {
      const activeChildNow =
        !isFrozenSnapshot && isStepActiveNow(step, isStreaming, allowActiveInference);
      if (!hasSubagentStepInTurn && !activeChildNow) {
        return false;
      }
      if (validSeconds(start)) return start >= prevTurnBoundarySeconds;
      if (validSeconds(end)) return end >= prevTurnBoundarySeconds;
      return activeChildNow;
    }
    return isSubagentRunning;
  });
  for (const childStep of childStepsInTurn) {
    const stepType = childStep.step_type ?? childStep.stepType ?? 0;
    const rawStatus = childStep.status ?? 3;
    const start = childStep.t_start ?? childStep.startTimeSeconds ?? childStep.createdAtSeconds;
    const end = childStep.t_end ?? childStep.endTimeSeconds ?? childStep.finishedGeneratingSeconds ?? childStep.completedAtSeconds;
    const rawStart = childStep.t_start ?? childStep.startTimeSeconds;
    const rawEnd = childStep.t_end ?? childStep.endTimeSeconds;
    const hasInterval = validSeconds(rawStart) && validSeconds(rawEnd) && rawEnd > rawStart;
    trackWallStart(start);
    if (!isFrozenSnapshot && stepType !== 14 && isStepActiveNow(childStep, isStreaming, allowActiveInference)) {
      hasActiveStepInTurn = true;
      if (validSeconds(rawStart)) {
        const activeInterval: readonly [number, number] = [rawStart, Math.max(rawStart, nowSeconds)];
        turnChildIntervals.push(activeInterval);
        if (stepType === 15) {
          turnModelIntervals.push(activeInterval);
        } else if (!NON_TOOL_STEP_TYPES.has(stepType)) {
          turnToolIntervals.push(activeInterval);
        }
      }
    } else if (stepType !== 14) {
      const childCompleted =
        stepType === 15
          ? isStepCompleted(childStep)
          : !TERMINAL_ABORTED_STEP_STATUSES.has(rawStatus) && (rawStatus === 3 || rawStatus === 5 || !ACTIVE_STEP_STATUSES.has(rawStatus));
      if (childCompleted) {
        trackWallEnd(end ?? start);
        if (stepType === 15) {
          const gen = childStep.generation;
          const rawTtft = gen?.timeToFirstTokenSeconds;
          const rawStreaming = gen?.streamingDurationSeconds;
          const duration = validSeconds(rawTtft) && validSeconds(rawStreaming) && rawTtft + rawStreaming > 0
            ? rawTtft + rawStreaming
            : hasInterval ? rawEnd! - rawStart! : null;
          if (duration !== null) {
            if (validSeconds(rawStart)) {
              const modelInterval: readonly [number, number] = [rawStart, rawStart + duration];
              turnModelIntervals.push(modelInterval);
              turnChildIntervals.push(modelInterval);
            } else {
              unanchoredTurnModelDuration += duration;
            }
          } else if (hasInterval) {
            turnChildIntervals.push([rawStart!, rawEnd!]);
          }
        } else if (hasInterval) {
          const toolInterval: readonly [number, number] = [rawStart!, rawEnd!];
          turnChildIntervals.push(toolInterval);
          if (!NON_TOOL_STEP_TYPES.has(stepType)) {
            turnToolIntervals.push(toolInterval);
          }
        }
      } else if (TERMINAL_ABORTED_STEP_STATUSES.has(rawStatus)) {
        const terminalEndedTs =
          rawEnd ?? childStep.completedAtSeconds ?? childStep.finishedGeneratingSeconds;
        if (validSeconds(terminalEndedTs) && (!validSeconds(start) || terminalEndedTs >= start)) {
          trackWallEnd(terminalEndedTs);
        }
      }
    }
  }

  // 仅统计当前轮次（主对话本轮 + 归属于本轮的子智能体）真实活跃步，隔离历史残留未闭合/中止步并合并并行重叠区间
  const activeModelIntervals: Array<readonly [number, number]> = [];
  const activeToolIntervals: Array<readonly [number, number]> = [];
  let activeModelStepCount = 0;
  let activeToolStepCount = 0;
  if (!isFrozenSnapshot) {
    for (const step of turnSteps) {
      const stepType = step.step_type ?? step.stepType ?? 0;
      if (stepType === 14) continue;
      const start = step.t_start ?? step.startTimeSeconds;
      if (!validSeconds(start)) continue;
      if (!isStepActiveNow(step, isStreaming, allowForegroundActiveInTurn)) continue;
      const interval: readonly [number, number] = [start, Math.max(start, nowSeconds)];
      if (stepType === 15) {
        activeModelIntervals.push(interval);
        activeModelStepCount++;
      } else if (!NON_TOOL_STEP_TYPES.has(stepType)) {
        activeToolIntervals.push(interval);
        activeToolStepCount++;
      }
    }
    for (const step of childStepsInTurn) {
      const stepType = step.step_type ?? step.stepType ?? 0;
      if (stepType === 14) continue;
      const start = step.t_start ?? step.startTimeSeconds;
      if (!validSeconds(start)) continue;
      if (!isStepActiveNow(step, isStreaming, allowActiveInference)) continue;
      const interval: readonly [number, number] = [start, Math.max(start, nowSeconds)];
      if (stepType === 15) {
        activeModelIntervals.push(interval);
        activeModelStepCount++;
      } else if (!NON_TOOL_STEP_TYPES.has(stepType)) {
        activeToolIntervals.push(interval);
        activeToolStepCount++;
      }
    }
  }
  const inFlightModelDurationSeconds = Math.max(
    0,
    mergeDurationIntervals([...allCompletedModelIntervals, ...activeModelIntervals]) -
      allCompletedAnchoredTotal
  );
  const inFlightToolDurationSeconds = Math.max(
    0,
    mergeDurationIntervals([...completedToolIntervals, ...activeToolIntervals]) -
      toolDurationSeconds
  );

  const currentTurnModelDurationSeconds =
    mergeDurationIntervals(turnModelIntervals) + unanchoredTurnModelDuration;
  const currentTurnToolDurationSeconds = mergeDurationIntervals(turnToolIntervals);
  const hasSubagentInTurn = Boolean(isSubagentRunning || hasSubagentStepInTurn || childStepsInTurn.length > 0);
  const mergedTurnDuration =
    mergeDurationIntervals([...turnModelIntervals, ...turnToolIntervals, ...turnChildIntervals]) +
    unanchoredTurnModelDuration;
  let currentTurnDurationSeconds = mergedTurnDuration;
  // 本轮用时按挂钟时间展示：覆盖上下文压缩、步骤间调度/排队等不属于任何步骤区间的空档；
  // 仅在能定位到本轮起点（存在用户输入步）或独立子智能体轨迹中启用，避免把轮次之间的空闲时间算入。
  if ((hasSubagentInTurn || input.isSubagentTrajectory === true || lastTurnStartIndex >= 0) && turnWallStart !== null) {
    const completedWallSpan = turnCompletedEnd !== null && turnCompletedEnd > turnWallStart
      ? turnCompletedEnd - turnWallStart
      : 0;
    const lastTurnStepType = lastTurnStep ? (lastTurnStep.step_type ?? lastTurnStep.stepType ?? 0) : 0;
    const lastTurnStepStatus = lastTurnStep?.status ?? 3;
    const lastTurnExplicitlyClosed =
      lastTurnStep !== undefined &&
      lastTurnStepType === 2 &&
      (lastTurnStepStatus === 3 || lastTurnStepStatus === 5);
    const lastTurnStepStaleCompleted =
      lastTurnStep !== undefined &&
      lastTurnStepType !== 14 &&
      isStepCompleted(lastTurnStep) &&
      turnCompletedEnd !== null &&
      nowSeconds - turnCompletedEnd > TURN_STEP_HANDOFF_GRACE_SEC;
    // 前台流式中但末步已被中止/取消、轮次已明确收尾 (stepType=2)，或上轮末步已完结且超出步间交接宽限期 (600s) 时，
    // 视为上轮已终止，不再因前端瞬时 isStreaming 信号或新轮未落盘而把跨轮空闲时间外推累加到上轮用时；
    // 主库处于错误回退缓存态 (cached) 或远端离线缓存态 (remote_stale) 时快照已冻结，不再把旧轮起始时间外推到当前时刻。
    const wallClockRunning =
      !isFrozenSnapshot &&
      (isSubagentRunning ||
        hasActiveStepInTurn ||
        (isStreaming &&
          !lastTurnStepAborted &&
          !lastTurnExplicitlyClosed &&
          !lastTurnStepStaleCompleted));
    if (wallClockRunning) {
      currentTurnDurationSeconds = Math.max(mergedTurnDuration, nowSeconds - turnWallStart, completedWallSpan);
    } else if (completedWallSpan > 0) {
      currentTurnDurationSeconds = Math.max(mergedTurnDuration, completedWallSpan);
    }
  }
  const hasTurnDuration = turns > 0 || (turnSteps.length > 0 && currentTurnDurationSeconds > 0) || isStreaming;
  const currentTurnDurationFormatted = hasTurnDuration
    ? formatTurnDurationCard(currentTurnDurationSeconds, 'zh')
    : '—';
  const currentTurnDurationFormattedEn = hasTurnDuration
    ? formatTurnDurationCard(currentTurnDurationSeconds, 'en')
    : '—';
  const currentTurnTpsInfo = computeTps(currentTurnTimedOutputSeconds, currentTurnTimedOutputTokens);
  const currentTurnOutputTpsPending = currentTurnTimedSamples === 0 && isStreaming;
  const currentTurnOutputTpsFormatted =
    currentTurnTimedSamples > 0 ? currentTurnTpsInfo.formatted : isStreaming ? bt('metrics.calculating') : '—';
  let effectiveLastCtxIdx = contextSteps.length - 1;
  while (effectiveLastCtxIdx > lastTurnStartIndex && effectiveLastCtxIdx >= 0) {
    const candidate = contextSteps[effectiveLastCtxIdx]!;
    const candidateType = candidate.step_type ?? candidate.stepType ?? 0;
    if (!TRANSPARENT_HANDOFF_STEP_TYPES.has(candidateType)) break;
    effectiveLastCtxIdx--;
  }
  const lastContextStep = effectiveLastCtxIdx >= 0 ? contextSteps[effectiveLastCtxIdx] : undefined;
  const lastContextStepType = lastContextStep ? (lastContextStep.step_type ?? lastContextStep.stepType ?? 0) : 0;
  const lastContextStepStatus = lastContextStep?.status ?? 3;
  const lastContextToolCompleted =
    Boolean(lastContextStep) &&
    !NON_TOOL_STEP_TYPES.has(lastContextStepType) &&
    (lastContextStepStatus === 3 ||
      lastContextStepStatus === 5 ||
      (!ACTIVE_STEP_STATUSES.has(lastContextStepStatus) &&
        !TERMINAL_ABORTED_STEP_STATUSES.has(lastContextStepStatus) &&
        validSeconds(lastContextStep!.t_end ?? lastContextStep!.endTimeSeconds)));
  const awaitingFirstTurnStep = Boolean(
    input.isStreaming &&
      !isSubagentRunning &&
      activeModelStepCount === 0 &&
      activeToolStepCount === 0 &&
      (contextSteps.length === 0 ||
        lastTurnStartIndex === effectiveLastCtxIdx ||
        ((lastContextStepType === 2 || lastContextStepType === 23) &&
          (lastContextStepStatus === 3 || lastContextStepStatus === 5)) ||
        lastContextToolCompleted)
  );
  const currentTurnDurationCompactZh = hasTurnDuration
    ? formatTurnDurationCompact(currentTurnDurationSeconds, 'zh')
    : formatTurnDurationCompact(0, 'zh');
  const currentTurnDurationCompactEn = hasTurnDuration
    ? formatTurnDurationCompact(currentTurnDurationSeconds, 'en')
    : formatTurnDurationCompact(0, 'en');

  const resolvedSubagentSteps =
    input.subagentSteps ?? (input.contextSteps ? Math.max(0, steps.length - contextSteps.length) : 0);
  const resolvedTotalSteps =
    input.totalStepsOverride ??
    (input.contextSteps
      ? contextSteps.length + Math.max(steps.length - contextSteps.length, resolvedSubagentSteps)
      : steps.length + Math.max(0, resolvedSubagentSteps));

  return {
    conversationId: input.conversationId || 'default',
    ...(input.paneSlotId ? { paneSlotId: input.paneSlotId } : {}),
    sessionRevision: input.sessionRevision ?? 1,
    ...(typeof input.metricsSequence === 'number' ? { metricsSequence: input.metricsSequence } : {}),
    availability,
    observedAt,
    lastSuccessAt,
    ...(typeof input.failedChildCount === 'number' && input.failedChildCount > 0
      ? { failedChildCount: input.failedChildCount }
      : {}),
    updatedAt: observedAt ?? nowMs,
    isStreaming,
    activityPhase,
    isSubagentRunning,
    runningSubagentCount,
    session: {
      turns,
      steps: resolvedTotalSteps,
      modelSteps,
      samples: { usage: usageSampleCount,
        timed: timedOutputCount, ttft: validTtftCount },
      toolSteps,
      compactionCount,
      subagentCount: Math.max(input.subagentCount ?? detectedSubagents, runningSubagentCount),
      runningSubagentCount,
      subagentSteps: resolvedSubagentSteps,
      hasSubagentInTurn,
      ...(lastTurnStepAborted ? { turnAborted: true } : {}),
      ...(lastTurnStepAbortedMissingEnd ? { turnAbortedMissingEnd: true } : {}),
      ...(input.isSubagentTrajectory ? { isSubagentTrajectory: true } : {}),
      ...(input.isBtwTrajectory ? { isBtwTrajectory: true } : {}),
      ...(awaitingFirstTurnStep ? { awaitingFirstTurnStep: true } : {}),
      modelDurationSeconds,
      modelDurationFormatted: formatDurationSeconds(modelDurationSeconds, 'zh'),
      modelDurationFormattedEn: formatDurationSeconds(modelDurationSeconds, 'en'),
      toolDurationSeconds,
      toolDurationFormatted: formatDurationSeconds(toolDurationSeconds, 'zh'),
      toolDurationFormattedEn: formatDurationSeconds(toolDurationSeconds, 'en'),
      averageTtftSeconds,
      averageTtftFormatted: validTtftCount > 0 ? bt('metrics.ttft_seconds', { value: compactRate(averageTtftSeconds) }) : '—',
      averageTtftFormattedEn: validTtftCount > 0 ? `${compactRate(averageTtftSeconds)}s` : '—',
      outputTps: tpsInfo.outputTps,
      outputTpsFormatted,
      outputTpsPending,
      ...(latestStepTpsInfo
        ? {
            latestStepOutputTps: latestStepTpsInfo.outputTps,
            latestStepOutputTpsFormatted: latestStepTpsInfo.formatted,
          }
        : {}),
      ...(latestStepTtftInfo
        ? {
            latestStepTtftSeconds: latestStepTtftInfo.seconds,
            latestStepTtftFormatted: latestStepTtftInfo.formatted,
            latestStepTtftFormattedEn: latestStepTtftInfo.formattedEn,
          }
        : {}),
      currentTurnOutputTps: currentTurnTpsInfo.outputTps,
      currentTurnOutputTpsFormatted,
      currentTurnOutputTpsPending,
      currentTurnTimedSamples,
      currentTurnDurationSeconds,
      currentTurnDurationFormatted,
      currentTurnDurationFormattedEn,
      currentTurnDurationCompactZh,
      currentTurnDurationCompactEn,
      currentTurnModelDurationSeconds,
      currentTurnToolDurationSeconds,
      inFlightModelDurationSeconds,
      activeModelStepCount,
      inFlightToolDurationSeconds,
      activeToolStepCount,
    },
    tokens: {
      totalTokens,
      totalTokensCompact: `${formatCompactTokenNumber(totalTokens)} tok`,
      totalTokensFormatted: formatThousandsTokens(totalTokens),
      cacheHitRate,
      cacheHitRateFormatted: compactPercent(cacheHitRate),
      uncachedInputTokens,
      uncachedInputFormatted: formatThousandsTokens(uncachedInputTokens),
      cachedReadTokens,
      cachedReadFormatted: formatThousandsTokens(cachedReadTokens),
      ...(cacheWriteTokens > 0 ? { cacheWriteTokens, cacheWriteFormatted: formatThousandsTokens(cacheWriteTokens) } : {}),
      outputTokens,
      outputFormatted: formatThousandsTokens(outputTokens),
      ...(reasoningTokens > 0 ? { reasoningTokens, reasoningFormatted: formatThousandsTokens(reasoningTokens) } : {}),
      ...(candidateTokens > 0 ? { candidateTokens, candidateFormatted: formatThousandsTokens(candidateTokens) } : {}),
      ...(pricedUsageSteps > 0
        ? {
            estimatedCostUsd,
            estimatedCostFormatted: formatHudUsd(estimatedCostUsd),
            cacheSavedUsd,
            cacheSavedFormatted: formatHudUsd(cacheSavedUsd),
            pricedStepCount: pricedUsageSteps,
            ...(unpricedUsageSteps > 0 ? { hasUnpricedSteps: true } : {}),
          }
        : {}),
    },
    context: {
      hasUsageData: Boolean(latestStep),
      modelId: resolvedModelId,
      modelDisplayName: resolvedModelDisplayName,
      ...(hasExplicitModelEvidence && activeStage.shortLabel
        ? {
            modelShortLabel: activeStage.shortLabel,
            modelCompactLabel: activeStage.compactLabel,
          }
        : {}),
      ...(isMultiModel ? { isMultiModel: true } : {}),
      ...(isOrchestrator ? { isOrchestrator: true } : {}),
      ...(sessionPeakContextTokens > 0 ? { sessionPeakContextTokens } : {}),
      ...(compactionCount > 0 ? { activeModelCompactionCount } : {}),
      ...(modelStages ? { modelStages } : {}),
      usedTokens,
      usedTokensCompact: formatCompactTokenNumber(usedTokens),
      usedTokensFormatted: formatThousandsTokens(usedTokens),
      peakContextTokens,
      peakContextCompact: formatCompactTokenNumber(peakContextTokens),
      peakContextFormatted: formatThousandsTokens(peakContextTokens),
      capacityTokens,
      capacityTokensCompact,
      hasExplicitDbCapacity,
      isFallbackCapacity: !hasExplicitDbCapacity,
      capacitySource,
      usedRatio,
      usedRatioFormatted: compactPercent(usedRatio),
      stepCacheRatio,
      stepCacheRatioFormatted: compactPercent(stepCacheRatio),
      breakdown: {
        cachedContextTokens: stepCached,
        cachedContextFormatted: formatThousandsTokens(stepCached),
        cachedContextRatio: cachedBarRatio,
        uncachedContextTokens: effectiveStepUncached,
        uncachedContextFormatted: formatThousandsTokens(effectiveStepUncached),
        uncachedContextRatio: uncachedBarRatio,
        latestOutputTokens: latestOutput,
        latestOutputFormatted: formatThousandsTokens(latestOutput),
        systemTokens: stepCached,
        systemTokensCompact: formatThousandsTokens(stepCached),
        systemRatio: cachedBarRatio,
        toolTokens: effectiveStepUncached,
        toolTokensCompact: formatThousandsTokens(effectiveStepUncached),
        toolRatio: uncachedBarRatio,
        messageTokens: latestOutput,
        messageTokensCompact: formatThousandsTokens(latestOutput),
        messageRatio: 0,
      },
    },
  };
}

interface CachedConversationState {
  fileId: string;
  mtimeMs: number;
  size: number;
  walMtimeMs: number;
  walSize: number;
  lastStepIdx: number;
  lastGenIdx: number;
  parentMetaDigest: string;
  executorMetaDigest: string;
  executorMetadata?: ParsedExecutorMetadata;
  stepPrefixCutoffIdx: number;
  stepPrefixDigest: string;
  genDigest: string;
  genPrefixCutoffIdx: number;
  genPrefixDigest: string;
  observedAt: number;
  lastSuccessAt: number;
  fromErrorFallback?: boolean;
  parentMetaReadError?: boolean;
  hasDataColumn?: boolean;
  hasRenderInfoColumn?: boolean;
  hasStepPayloadColumn?: boolean;
  hasTrajectoryMeta?: boolean;
  hasParentMetadataBlob?: boolean;
  trajectoryId?: string;
  trajectoryType?: number;
  forkStepIndex?: number;
  forkParentCascadeId?: string;
  referencedUuidsInMetaBlob: Set<string>;
  rawSteps: ParsedConversationStep[];
  steps: ParsedConversationStep[];
  childConversationIds: Set<string>;
  verifiedSniffedChildren: Set<string>;
  genMetadata?: ParsedGenMetadata;
  generations: Map<number, ParsedGenMetadata>;
  unmatchedUsageGenerations: Array<{
    generation: ParsedGenMetadata;
    timestampSeconds: number | null;
  }>;
  isCompactTerminalChild?: boolean;
}

/**
 * 零阻塞、单语句自动提交 (Auto-Commit) 会话指标采集引擎
 * 通过只读 Worker 线程池执行短生命周期查询，严禁显式 BEGIN 事务，每条语句结束释放读取状态，避免长期持有 WAL 快照
 */
export class ConversationMetricsEngine {
  private readonly conversationsDir: string;
  private readonly summariesDbPath: string;
  private readonly remotePricingCachePath: string | null;
  private readonly pricingCachePath: string | null;
  private cachedPricingTable: { key: string; table: Record<string, ApiPricingEntry> } | null = null;
  private pricingResolveInFlight: Promise<Record<string, ApiPricingEntry>> | null = null;
  private hasLoadedRemotePricing = false;
  private readonly cache = new Map<string, CachedConversationState>();
  private readonly terminalChildCache = new Map<string, CachedConversationState>();
  private readonly protectedMainDbPaths = new Map<string, number>();
  private readonly pendingReads = new Map<string, Promise<CachedConversationState | null>>();
  private readonly verifiedSniffedChildrenByDb = new Map<string, { fileId: string; stepCount: number; children: Set<string> }>();
  private readonly recentActiveChildUntilByDb = new Map<string, number>();
  private readonly coldSniffedByDb = new Map<string, { fileId: string; stepCount: number }>();
  private readonly rejectedSniffMtimeByKey = new Map<string, number>();
  private readonly summariesChildCache = new Map<string, { sig: string; childIds: string[]; terminalChildIds: string[]; runningChildIds: string[]; selfRunning: boolean }>();
  private summariesMissingUntilMs = 0;
  private sniffDirCache: { at: number; dirMtimeMs: number; allEntries: Array<{ id: string; mtimeMs: number }> } | null = null;
  private sniffDirListCache: { dirMtimeMs: number; dbEntries: Array<{ file: string; id: string }> } | null = null;
  private sniffInFlight: Promise<Array<{ id: string; mtimeMs: number }>> | null = null;

  constructor(options?: { geminiDir?: string; conversationsDir?: string; stateDir?: string }) {
    const baseGemini = options?.geminiDir ?? join(homedir(), '.gemini');
    this.conversationsDir =
      options?.conversationsDir ?? join(baseGemini, 'antigravity', 'conversations');
    this.summariesDbPath = join(dirname(this.conversationsDir), 'conversation_summaries.db');
    const cleanStateDir = typeof options?.stateDir === 'string' && options.stateDir.trim()
      ? options.stateDir.trim()
      : null;
    this.remotePricingCachePath = cleanStateDir ? join(cleanStateDir, 'remote_pricing.json') : null;
    this.pricingCachePath = cleanStateDir ? join(cleanStateDir, 'api_pricing.json') : null;
  }

  public invalidatePricingCache(): void {
    this.cachedPricingTable = null;
  }

  public getEffectivePricingTable(): Promise<Record<string, ApiPricingEntry>> {
    return this.resolveEffectivePricingTable();
  }

  private async resolveEffectivePricingTable(): Promise<Record<string, ApiPricingEntry>> {
    if (!this.remotePricingCachePath || !this.pricingCachePath) {
      return DEFAULT_API_PRICES;
    }
    return (this.pricingResolveInFlight ??= (async () => {
      try {
        const [remoteStat, customStat] = await Promise.all([
          lstat(this.remotePricingCachePath!).catch(() => null),
          lstat(this.pricingCachePath!).catch(() => null),
        ]);
        const key = `${remoteStat ? `${remoteStat.mtimeMs}:${remoteStat.size}` : 'none'}|${customStat ? `${customStat.mtimeMs}:${customStat.size}` : 'none'}`;
        if (key === 'none|none') {
          if (this.cachedPricingTable !== null || this.hasLoadedRemotePricing) {
            this.cachedPricingTable = null;
            this.hasLoadedRemotePricing = false;
            resetAndRegisterRemoteModelMetadata({});
          }
          return DEFAULT_API_PRICES;
        }
        if (this.cachedPricingTable?.key === key) {
          return this.cachedPricingTable.table;
        }
        const { billingPrices } = await loadRawPricingTable(this.remotePricingCachePath!, this.pricingCachePath!);
        this.hasLoadedRemotePricing = true;
        this.cachedPricingTable = { key, table: billingPrices };
        return billingPrices;
      } catch {
        return DEFAULT_API_PRICES;
      } finally {
        this.pricingResolveInFlight = null;
      }
    })());
  }

  public resolveDbPath(conversationId: string): string {
    const cleanId = conversationId.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!cleanId) {
      throw new Error(bt('metrics.err.invalid_conversation_id'));
    }
    return join(this.conversationsDir, `${cleanId}.db`);
  }

  private async lookupIndexedChildrenFromSummariesDb(
    parentIds: string[],
    selfIds: string[] = []
  ): Promise<{ available: boolean; childIds: Set<string>; terminalChildIds: Set<string>; runningChildIds: Set<string>; selfRunning: boolean }> {
    const cleanParents = [...new Set(parentIds.map(p => p.trim().toLowerCase()).filter(Boolean))].sort();
    const cleanSelf = [...new Set(selfIds.map(s => s.trim().toLowerCase()).filter(Boolean))].sort();
    const emptyRes = () => ({ available: false, childIds: new Set<string>(), terminalChildIds: new Set<string>(), runningChildIds: new Set<string>(), selfRunning: false });
    if (cleanParents.length === 0 && cleanSelf.length === 0) return emptyRes();
    const now = Date.now();
    if (now < this.summariesMissingUntilMs) {
      return emptyRes();
    }
    let targetPath = this.summariesDbPath;
    let st = await lstat(targetPath).catch(() => null);
    if (!st || !st.isFile() || st.isSymbolicLink()) {
      const altPath = join(this.conversationsDir, 'conversation_summaries.db');
      st = await lstat(altPath).catch(() => null);
      if (!st || !st.isFile() || st.isSymbolicLink()) {
        this.summariesMissingUntilMs = now + 2000;
        return emptyRes();
      }
      targetPath = altPath;
    }
    const walSt = await lstat(`${targetPath}-wal`).catch(() => null);
    const sig = `${targetPath}|${st.mtimeMs}:${st.size}:${walSt?.mtimeMs ?? 0}:${walSt?.size ?? 0}`;
    const cacheKey = `p:${cleanParents.join('|')}#s:${cleanSelf.join('|')}`;
    const cached = this.summariesChildCache.get(cacheKey);
    if (cached && cached.sig === sig) {
      return {
        available: true,
        childIds: new Set(cached.childIds),
        terminalChildIds: new Set(cached.terminalChildIds),
        runningChildIds: new Set(cached.runningChildIds),
        selfRunning: cached.selfRunning,
      };
    }
    const res = await runSummariesLookupInWorker({ dbPath: targetPath, parentIds: cleanParents, selfIds: cleanSelf });
    if (!res || !res.foundTable) {
      return emptyRes();
    }
    if (this.summariesChildCache.size >= MAX_CACHED_CONVERSATIONS && !this.summariesChildCache.has(cacheKey)) {
      const oldest = this.summariesChildCache.keys().next().value;
      if (oldest !== undefined) this.summariesChildCache.delete(oldest);
    }
    const terminalList = Array.isArray(res.terminalChildIds) ? res.terminalChildIds : [];
    const runningList = Array.isArray(res.runningChildIds) ? res.runningChildIds : [];
    const selfRunning = Boolean(res.selfRunning);
    this.summariesChildCache.set(cacheKey, { sig, childIds: res.childIds, terminalChildIds: terminalList, runningChildIds: runningList, selfRunning });
    return {
      available: true,
      childIds: new Set(res.childIds),
      terminalChildIds: new Set(terminalList),
      runningChildIds: new Set(runningList),
      selfRunning,
    };
  }

  private setCachedState(dbPath: string, state: CachedConversationState): void {
    this.terminalChildCache.delete(dbPath);
    if (this.cache.has(dbPath)) {
      this.cache.delete(dbPath);
    }
    this.cache.set(dbPath, state);
    while (this.cache.size > MAX_CACHED_CONVERSATIONS) {
      let oldestKey: string | undefined;
      for (const candidateKey of this.cache.keys()) {
        if (candidateKey !== dbPath && !this.protectedMainDbPaths.has(candidateKey)) {
          oldestKey = candidateKey;
          break;
        }
      }
      if (oldestKey === undefined) break;
      this.cache.delete(oldestKey);
    }
  }

  private setTerminalChildCache(dbPath: string, state: CachedConversationState): void {
    if (this.terminalChildCache.has(dbPath)) {
      this.terminalChildCache.delete(dbPath);
    }
    this.terminalChildCache.set(dbPath, state);
    while (this.terminalChildCache.size > MAX_TERMINAL_CHILD_CACHE_ENTRIES) {
      const oldestKey = this.terminalChildCache.keys().next().value;
      if (oldestKey === undefined) break;
      this.terminalChildCache.delete(oldestKey);
    }
  }

  private demoteTerminalChildToCompactCache(dbPath: string, state: CachedConversationState): void {
    if (state.fromErrorFallback || this.protectedMainDbPaths.has(dbPath)) return;
    const compact: CachedConversationState = state.isCompactTerminalChild
      ? state
      : {
          ...state,
          rawSteps: [],
          generations: new Map(),
          stepPrefixCutoffIdx: -1,
          stepPrefixDigest: '',
          genPrefixCutoffIdx: -1,
          genPrefixDigest: '',
          isCompactTerminalChild: true,
        };
    this.cache.delete(dbPath);
    this.setTerminalChildCache(dbPath, compact);
  }

  private async readSingleDbState(
    dbPath: string,
    selfConversationId: string
  ): Promise<CachedConversationState | null> {
    const pending = this.pendingReads.get(dbPath);
    if (pending) return pending;
    const operation = this.loadSingleDbState(dbPath, selfConversationId);
    this.pendingReads.set(dbPath, operation);
    try {
      return await operation;
    } finally {
      if (this.pendingReads.get(dbPath) === operation) this.pendingReads.delete(dbPath);
    }
  }

  private async loadSingleDbState(
    dbPath: string,
    selfConversationId: string
  ): Promise<CachedConversationState | null> {
    let dbStat: { mtimeMs: number; size: number; fileId: string } | null = null;
    let walStat: { mtimeMs: number; size: number } | null = null;
    try {
      const st = await lstat(dbPath);
      if (!st.isFile() || st.isSymbolicLink()) return null;
      dbStat = { mtimeMs: st.mtimeMs, size: st.size, fileId: `${st.dev}:${st.ino}` };
      try {
        const wst = await lstat(`${dbPath}-wal`);
        walStat = { mtimeMs: wst.mtimeMs, size: wst.size };
      } catch {
        walStat = null;
      }
    } catch {
      return null;
    }

    const cached = this.cache.get(dbPath) ?? this.terminalChildCache.get(dbPath);
    const existing = cached?.fileId === dbStat.fileId ? cached : undefined;
    const walMtimeMs = walStat?.mtimeMs ?? 0;
    const walSize = walStat?.size ?? 0;

    if (
      existing &&
      !existing.fromErrorFallback &&
      existing.fileId === dbStat.fileId &&
      existing.mtimeMs === dbStat.mtimeMs &&
      existing.size === dbStat.size &&
      existing.walMtimeMs === walMtimeMs &&
      existing.walSize === walSize
    ) {
      if (existing.isCompactTerminalChild) {
        this.setTerminalChildCache(dbPath, existing);
      } else {
        this.setCachedState(dbPath, existing);
      }
      return existing;
    }

    const canReuseIncremental = Boolean(
      existing && !existing.fromErrorFallback && !existing.isCompactTerminalChild
    );
    const prevStepPrefixCutoffIdx =
      canReuseIncremental && existing!.stepPrefixCutoffIdx >= 0
        ? existing!.stepPrefixCutoffIdx
        : undefined;
    const prevGenPrefixCutoffIdx =
      canReuseIncremental && existing!.genPrefixCutoffIdx >= 0
        ? existing!.genPrefixCutoffIdx
        : undefined;
    const scanParams = {
      dbPath,
      inlineBlobLimitBytes: INLINE_BLOB_LIMIT_BYTES,
      selfCascadeIdHint: EXACT_UUID_RE.test(selfConversationId)
        ? selfConversationId.toLowerCase()
        : undefined,
      knownColumns:
        existing &&
        existing.hasDataColumn !== undefined &&
        existing.hasRenderInfoColumn !== undefined &&
        existing.hasStepPayloadColumn !== undefined
          ? {
              hasDataColumn: existing.hasDataColumn,
              hasRenderInfoColumn: existing.hasRenderInfoColumn,
              hasStepPayloadColumn: existing.hasStepPayloadColumn,
            }
          : undefined,
      cachedTrajectoryId: existing?.trajectoryId,
      prevParentMetaDigest:
        canReuseIncremental && !existing!.parentMetaReadError && existing!.parentMetaDigest
          ? existing!.parentMetaDigest
          : undefined,
      prevExecutorMetaDigest:
        canReuseIncremental && existing!.executorMetaDigest
          ? existing!.executorMetaDigest
          : undefined,
      prevStepPrefixCutoffIdx,
      prevStepPrefixDigest:
        prevStepPrefixCutoffIdx !== undefined ? existing!.stepPrefixDigest : undefined,
      prevGenDigest: canReuseIncremental ? existing!.genDigest : undefined,
      prevGenPrefixCutoffIdx,
      prevGenPrefixDigest:
        prevGenPrefixCutoffIdx !== undefined ? existing!.genPrefixDigest : undefined,
    };

    try {
      let workerRes: Awaited<ReturnType<typeof runHudDbScanInWorker>>;
      try {
        workerRes = await runHudDbScanInWorker(scanParams);
      } catch (firstErr) {
        const msg = (firstErr as Error)?.message ?? '';
        if (!/busy|locked|投影失败|工作线程|预算|projection|worker|budget|timeout|no such table|unable to open/i.test(msg)) {
          throw firstErr;
        }
        await new Promise(resolve => setTimeout(resolve, 60));
        workerRes = await runHudDbScanInWorker(scanParams);
      }

      const {
        hasDataColumn,
        hasRenderInfoColumn,
        hasStepPayloadColumn,
        hasTrajectoryMeta,
        hasParentMetadataBlob,
        parentMetaReadError,
        parentMetaUnchanged,
        parentMetaDigest,
        executorMetaUnchanged,
        executorMetaDigest,
        executorMetaBlob,
        trajectoryId,
        trajectoryType,
        forkStepIndex,
        forkParentCascadeId,
        metaBlobProjectedSlices,
        maxIdx,
        stepsMode,
        stepPrefixCutoffIdx,
        stepPrefixDigest,
        appendedSteps,
        genMode,
        lastGenIdx,
        genDigest,
        genPrefixCutoffIdx,
        genPrefixDigest,
        genBlobs,
      } = workerRes;

      const executorMetadata: ParsedExecutorMetadata | undefined =
        executorMetaUnchanged && existing
          ? existing.executorMetadata
          : executorMetaBlob && executorMetaBlob.byteLength > 0
          ? parseExecutorMetadataBlob(executorMetaBlob)
          : undefined;

      const selfLower = selfConversationId.toLowerCase();
      const selfTrajLower = trajectoryId?.toLowerCase() ?? '';
      const referencedUuidsInMetaBlob = new Set<string>(
        parentMetaReadError || (parentMetaUnchanged && existing)
          ? existing?.referencedUuidsInMetaBlob ?? []
          : []
      );
      if (!parentMetaReadError && !parentMetaUnchanged) {
        for (const slice of metaBlobProjectedSlices) {
          for (const u of parentReferences(slice)) {
            if (u === selfLower || (selfTrajLower && u === selfTrajLower)) continue;
            referencedUuidsInMetaBlob.add(u);
          }
        }
      }

      const childConversationIds = new Set<string>();

      const parseStepRow = (row: HudWorkerRawStepRow): ParsedConversationStep => {
        const extraList = [row.render_info, row.step_payload].filter(
          (b): b is Uint8Array => Boolean(b && b.length > 0)
        );
        const extraBlobs = extraList.length > 0 ? extraList : undefined;
        const parsed = parseStepMetadataBlob(
          Number(row.idx),
          Number(row.step_type),
          Number(row.status),
          row.metadata,
          row.data,
          extraBlobs
        );
        parsed.metadataByteLength = Number(row.metadata_len ?? 0);
        return parsed;
      };

      const rawSteps: ParsedConversationStep[] =
        stepsMode === 'append' && existing && prevStepPrefixCutoffIdx !== undefined
          ? existing.rawSteps.filter(s => s.idx < prevStepPrefixCutoffIdx)
          : [];
      for (const row of appendedSteps) {
        rawSteps.push(parseStepRow(row));
      }
      const baseSteps: ParsedConversationStep[] = rawSteps.map(s => ({
        ...s,
        ...(s.childConversationIds ? { childConversationIds: [...s.childConversationIds] } : {}),
      }));
      let lastIdx = baseSteps.length > 0 ? baseSteps[baseSteps.length - 1]!.idx : -1;
      if (maxIdx > lastIdx) {
        lastIdx = maxIdx;
      }

      let generations: Map<number, ParsedGenMetadata>;
      if (genMode === 'unchanged' && existing) {
        generations = existing.generations;
      } else if (genMode === 'append' && existing && prevGenPrefixCutoffIdx !== undefined) {
        generations = new Map<number, ParsedGenMetadata>();
        for (const [k, v] of existing.generations) {
          if (k < prevGenPrefixCutoffIdx) generations.set(k, v);
        }
        for (const item of genBlobs) {
          generations.set(item.idx, parseLatestGenMetadataBlob(item.data));
        }
      } else {
        generations = new Map<number, ParsedGenMetadata>();
        for (const item of genBlobs) {
          generations.set(item.idx, parseLatestGenMetadataBlob(item.data));
        }
      }

      const stepByIndex = new Map(baseSteps.map(step => [step.idx, step]));
      const sortedGenerations = [...generations.entries()].sort((a, b) => a[0] - b[0]);
      const claimedUsageStepIdxs = new Set<number>();
      const matchedGenIdxs = new Set<number>();
      const resolveCandidate15Steps = (generation: ParsedGenMetadata): ParsedConversationStep[] => {
        const fromIndices = [...new Set(generation.stepIndices ?? [])]
          .map(index => stepByIndex.get(index))
          .filter((step): step is ParsedConversationStep => step?.stepType === 15);
        if (fromIndices.length > 0) return fromIndices;
        if (generation.executionId && (!generation.stepIndices || generation.stepIndices.length === 0)) {
          return baseSteps.filter(step => step.stepType === 15 && step.executionId === generation.executionId);
        }
        return [];
      };

      const stripTimingFromGeneration = (gen: ParsedGenMetadata): ParsedGenMetadata => {
        const { timeToFirstTokenSeconds: _ttft, streamingDurationSeconds: _stream, ...rest } = gen;
        return rest;
      };
      const canAttachAuthoritativeTiming = (
        gen: ParsedGenMetadata,
        candidate15Count: number,
        step: ParsedConversationStep
      ): boolean =>
        candidate15Count === 1 &&
        Boolean(gen.executionId) &&
        Boolean(step.executionId) &&
        step.executionId === gen.executionId;

      // 第 1 遍：精确对齐 steps.metadata.field 9 与 gen_metadata.usage 一致的模型步（1:1 认领，防止同轮多次 API 调用被误吞）
      const attachCompactionStepModel = (generation: ParsedGenMetadata): void => {
        if (
          !(
            generation.responseModel ||
            generation.modelDisplayName ||
            generation.plannerModelName ||
            generation.modelEnum ||
            generation.maxContextTokens
          )
        ) {
          return;
        }
        const modelOnlyGen: ParsedGenMetadata = {
          ...(generation.responseModel ? { responseModel: generation.responseModel } : {}),
          ...(generation.modelDisplayName ? { modelDisplayName: generation.modelDisplayName } : {}),
          ...(generation.plannerModelName ? { plannerModelName: generation.plannerModelName } : {}),
          ...(generation.modelEnum ? { modelEnum: generation.modelEnum } : {}),
          ...(generation.planModelEnum ? { planModelEnum: generation.planModelEnum } : {}),
          ...(generation.executionModelEnum ? { executionModelEnum: generation.executionModelEnum } : {}),
          ...(generation.maxContextTokens ? { maxContextTokens: generation.maxContextTokens } : {}),
        };
        for (const stepIdx of new Set(generation.stepIndices ?? [])) {
          const cpStep = stepByIndex.get(stepIdx);
          if (
            cpStep &&
            cpStep.stepType === 23 &&
            !cpStep.generation &&
            (!generation.executionId || !cpStep.executionId || cpStep.executionId === generation.executionId)
          ) {
            cpStep.generation = modelOnlyGen;
          }
        }
      };

      for (const [genIdx, generation] of sortedGenerations) {
        const linked = resolveCandidate15Steps(generation);
        if (generation.usage) {
          const u = generation.usage;
          const uTotal = u.rawInputTokens + u.cachedReadTokens + u.cacheWriteTokens + u.outputTokens;
          if (uTotal > 0) {
            const exactMatch = linked.find(
              step =>
                !claimedUsageStepIdxs.has(step.idx) &&
                step.hasUsage &&
                (!generation.executionId || !step.executionId || step.executionId === generation.executionId) &&
                step.rawInputTokens === u.rawInputTokens &&
                step.outputTokens === u.outputTokens &&
                step.cachedReadTokens === u.cachedReadTokens &&
                step.cacheWriteTokens === u.cacheWriteTokens
            );
            if (exactMatch) {
              if (exactMatch.reasoningTokens === 0 && u.reasoningTokens > 0) {
                exactMatch.reasoningTokens = u.reasoningTokens;
              }
              if (exactMatch.candidateTokens === 0 && u.candidateTokens > 0) {
                exactMatch.candidateTokens = u.candidateTokens;
              }
              exactMatch.generation = canAttachAuthoritativeTiming(generation, linked.length, exactMatch)
                ? generation
                : stripTimingFromGeneration(generation);
              attachCompactionStepModel(generation);
              claimedUsageStepIdxs.add(exactMatch.idx);
              matchedGenIdxs.add(genIdx);
              continue;
            }
          }
        }
        const hasEstimatedTokensUsed =
          typeof generation.estimatedTokensUsed === 'number' &&
          Number.isFinite(generation.estimatedTokensUsed) &&
          generation.estimatedTokensUsed > 0;
        if (
          generation.responseModel ||
          generation.modelDisplayName ||
          generation.plannerModelName ||
          generation.modelEnum ||
          generation.planModelEnum ||
          generation.executionModelEnum ||
          generation.maxContextTokens ||
          hasEstimatedTokensUsed
        ) {
          const modelOnlyGen: ParsedGenMetadata = {
            ...(generation.responseModel ? { responseModel: generation.responseModel } : {}),
            ...(generation.modelDisplayName ? { modelDisplayName: generation.modelDisplayName } : {}),
            ...(generation.plannerModelName ? { plannerModelName: generation.plannerModelName } : {}),
            ...(generation.modelEnum ? { modelEnum: generation.modelEnum } : {}),
            ...(generation.planModelEnum ? { planModelEnum: generation.planModelEnum } : {}),
            ...(generation.executionModelEnum ? { executionModelEnum: generation.executionModelEnum } : {}),
            ...(generation.maxContextTokens ? { maxContextTokens: generation.maxContextTokens } : {}),
            ...(hasEstimatedTokensUsed ? { estimatedTokensUsed: generation.estimatedTokensUsed } : {}),
          };
          for (const step of linked) {
            if (!generation.executionId || !step.executionId || step.executionId === generation.executionId) {
              if (!step.generation) {
                step.generation = modelOnlyGen;
              } else if (
                hasEstimatedTokensUsed &&
                !(
                  typeof step.generation.estimatedTokensUsed === 'number' &&
                  step.generation.estimatedTokensUsed > 0
                )
              ) {
                step.generation = {
                  ...step.generation,
                  estimatedTokensUsed: generation.estimatedTokensUsed,
                };
              }
            }
          }
          attachCompactionStepModel(generation);
        }
      }

      // 第 2 遍：回填缺失内联 field 9 / cacheWriteTokens 的 stepType=15，并收集压缩步 (step_type=23)、重试/中断等独立计费 gen_metadata
      const unmatchedUsageGenerations: Array<{ generation: ParsedGenMetadata; timestampSeconds: number | null }> = [];
      const genCountByStepIdx = new Map<number, number>();
      const singleStepCompetitors = new Map<number, number[]>();
      for (const [genIdx, generation] of sortedGenerations) {
        const u = generation.usage;
        if (!u || u.rawInputTokens + u.cachedReadTokens + u.cacheWriteTokens + u.outputTokens <= 0) continue;
        const allLinked = resolveCandidate15Steps(generation);
        for (const step of allLinked) {
          genCountByStepIdx.set(step.idx, (genCountByStepIdx.get(step.idx) ?? 0) + 1);
        }
        if (matchedGenIdxs.has(genIdx)) continue;
        const missingCandidates = allLinked.filter(
          step =>
            !claimedUsageStepIdxs.has(step.idx) &&
            !step.hasUsage &&
            (!generation.executionId || !step.executionId || step.executionId === generation.executionId)
        );
        if (missingCandidates.length === 1) {
          const targetIdx = missingCandidates[0]!.idx;
          const list = singleStepCompetitors.get(targetIdx) ?? [];
          list.push(genIdx);
          singleStepCompetitors.set(targetIdx, list);
        }
      }
      // 竞争仲裁（对齐 ssh-remote-rpc.ts）：多条 gen_metadata 竞争同一缺失内联 usage 的 stepType=15 时，
      // 优先选择 outputTokens > 0 且时间靠后（最大 genIdx）的最终响应回填步骤，早先失败/中断重试留给 unmatchedUsageGenerations。
      for (const [stepIdx, genIdxList] of singleStepCompetitors.entries()) {
        const targetStep = stepByIndex.get(stepIdx);
        if (!targetStep || claimedUsageStepIdxs.has(stepIdx) || targetStep.hasUsage) continue;
        let winnerGenIdx = genIdxList[genIdxList.length - 1]!;
        for (let k = genIdxList.length - 1; k >= 0; k--) {
          const candidateIdx = genIdxList[k]!;
          const candidateGen = generations.get(candidateIdx);
          if ((candidateGen?.usage?.outputTokens ?? 0) > 0) {
            winnerGenIdx = candidateIdx;
            break;
          }
        }
        const winnerGen = generations.get(winnerGenIdx);
        const u = winnerGen?.usage;
        if (!winnerGen || !u) continue;
        const linked = resolveCandidate15Steps(winnerGen);
        targetStep.hasUsage = true;
        targetStep.rawInputTokens = u.rawInputTokens;
        targetStep.outputTokens = u.outputTokens;
        targetStep.cacheWriteTokens = u.cacheWriteTokens;
        targetStep.cachedReadTokens = u.cachedReadTokens;
        targetStep.reasoningTokens = u.reasoningTokens;
        targetStep.candidateTokens = u.candidateTokens;
        targetStep.generation = canAttachAuthoritativeTiming(winnerGen, linked.length, targetStep)
          ? winnerGen
          : stripTimingFromGeneration(winnerGen);
        claimedUsageStepIdxs.add(targetStep.idx);
        matchedGenIdxs.add(winnerGenIdx);
      }
      for (const [genIdx, generation] of sortedGenerations) {
        if (matchedGenIdxs.has(genIdx) || !generation.usage) continue;
        const u = generation.usage;
        const uTotal = u.rawInputTokens + u.cachedReadTokens + u.cacheWriteTokens + u.outputTokens;
        if (uTotal <= 0) continue;
        const linked = resolveCandidate15Steps(generation);
        const missingUsageStep = linked.find(
          step =>
            !claimedUsageStepIdxs.has(step.idx) &&
            !step.hasUsage &&
            (!generation.executionId || !step.executionId || step.executionId === generation.executionId)
        );
        if (missingUsageStep) {
          missingUsageStep.hasUsage = true;
          missingUsageStep.rawInputTokens = u.rawInputTokens;
          missingUsageStep.outputTokens = u.outputTokens;
          missingUsageStep.cacheWriteTokens = u.cacheWriteTokens;
          missingUsageStep.cachedReadTokens = u.cachedReadTokens;
          missingUsageStep.reasoningTokens = u.reasoningTokens;
          missingUsageStep.candidateTokens = u.candidateTokens;
          missingUsageStep.generation = canAttachAuthoritativeTiming(generation, linked.length, missingUsageStep)
            ? generation
            : stripTimingFromGeneration(generation);
          claimedUsageStepIdxs.add(missingUsageStep.idx);
          matchedGenIdxs.add(genIdx);
          continue;
        }
        if (linked.length === 1) {
          const soleStep = linked[0]!;
          if (
            !claimedUsageStepIdxs.has(soleStep.idx) &&
            (genCountByStepIdx.get(soleStep.idx) ?? 0) === 1 &&
            soleStep.hasUsage &&
            (!generation.executionId || !soleStep.executionId || soleStep.executionId === generation.executionId)
          ) {
            if (
              soleStep.rawInputTokens === u.rawInputTokens &&
              soleStep.outputTokens === u.outputTokens &&
              soleStep.cachedReadTokens === u.cachedReadTokens &&
              soleStep.cacheWriteTokens === 0 &&
              u.cacheWriteTokens > 0
            ) {
              soleStep.cacheWriteTokens = u.cacheWriteTokens;
              if (soleStep.reasoningTokens === 0 && u.reasoningTokens > 0) soleStep.reasoningTokens = u.reasoningTokens;
              if (soleStep.candidateTokens === 0 && u.candidateTokens > 0) soleStep.candidateTokens = u.candidateTokens;
              soleStep.generation = canAttachAuthoritativeTiming(generation, linked.length, soleStep)
                ? generation
                : stripTimingFromGeneration(generation);
              claimedUsageStepIdxs.add(soleStep.idx);
              matchedGenIdxs.add(genIdx);
              continue;
            }
            if (Boolean(generation.executionId) && soleStep.executionId === generation.executionId) {
              claimedUsageStepIdxs.add(soleStep.idx);
              matchedGenIdxs.add(genIdx);
              continue;
            }
          }
        }
        let fallbackStepTs: number | null = generation.startedAtSeconds ?? null;
        if (fallbackStepTs === null && generation.stepIndices?.length) {
          for (const sIdx of generation.stepIndices) {
            const anyStep = stepByIndex.get(sIdx);
            const ts = anyStep?.startTimeSeconds ?? anyStep?.createdAtSeconds ?? anyStep?.completedAtSeconds ?? null;
            if (ts !== null && ts > 0) {
              fallbackStepTs = ts;
              break;
            }
          }
        }
        unmatchedUsageGenerations.push({ generation, timestampSeconds: fallbackStepTs });
      }
      const latestModelStep = [...baseSteps].reverse().find(step => step.stepType === 15 && step.hasUsage);
      let genMetadata = latestModelStep?.generation;
      if (!genMetadata && generations.size > 0) {
        const fallbackGens = [...generations.entries()].sort((a, b) => a[0] - b[0]);
        const lastGen = fallbackGens[fallbackGens.length - 1]?.[1];
        const indices = lastGen?.stepIndices;
        const compatible = !latestModelStep
          ? true
          : (!indices?.length || indices.includes(latestModelStep.idx)) &&
            (!lastGen?.executionId || !latestModelStep.executionId || lastGen.executionId === latestModelStep.executionId);
        if (lastGen && compatible) {
          genMetadata = lastGen;
        }
      }
      for (const step of baseSteps) {
        for (const childId of step.childConversationIds ?? []) {
          if (childId !== selfLower && childId !== selfTrajLower) childConversationIds.add(childId);
        }
      }

      const persistedSniff = this.verifiedSniffedChildrenByDb.get(dbPath);
      const timelineShrunk =
        (existing && baseSteps.length < existing.steps.length) ||
        (persistedSniff && (persistedSniff.fileId !== dbStat.fileId || baseSteps.length < persistedSniff.stepCount));
      const verifiedSniffedChildren = new Set<string>(
        timelineShrunk ? [] : (persistedSniff?.children ?? existing?.verifiedSniffedChildren ?? [])
      );
      if (timelineShrunk) {
        this.verifiedSniffedChildrenByDb.delete(dbPath);
      } else if (persistedSniff) {
        persistedSniff.stepCount = Math.max(persistedSniff.stepCount, baseSteps.length);
      }

      const nowMs = Date.now();
      const observedAt = Math.max(Math.round(dbStat.mtimeMs), Math.round(walMtimeMs)) || nowMs;
      const nextState: CachedConversationState = {
        fileId: dbStat.fileId,
        mtimeMs: dbStat.mtimeMs,
        size: dbStat.size,
        walMtimeMs,
        walSize,
        lastStepIdx: lastIdx,
        lastGenIdx,
        parentMetaDigest: parentMetaReadError ? existing?.parentMetaDigest ?? '' : parentMetaDigest,
        executorMetaDigest: executorMetaDigest ?? '',
        executorMetadata,
        stepPrefixCutoffIdx,
        stepPrefixDigest,
        genDigest,
        genPrefixCutoffIdx,
        genPrefixDigest,
        observedAt,
        lastSuccessAt: nowMs,
        fromErrorFallback: false,
        parentMetaReadError,
        hasDataColumn,
        hasRenderInfoColumn,
        hasStepPayloadColumn,
        hasTrajectoryMeta,
        hasParentMetadataBlob,
        trajectoryId,
        trajectoryType,
        forkStepIndex,
        forkParentCascadeId,
        referencedUuidsInMetaBlob,
        rawSteps,
        steps: baseSteps,
        childConversationIds,
        verifiedSniffedChildren,
        genMetadata,
        generations,
        unmatchedUsageGenerations,
      };
      this.setCachedState(dbPath, nextState);
      return nextState;
    } catch {
      if (existing) {
        return { ...existing, fromErrorFallback: true };
      }
      return null;
    }
  }

  public async getConversationMetrics(options: {
    conversationId: string;
    paneSlotId?: string;
    sessionRevision?: number;
    metricsSequence?: number;
    modelId?: string;
    modelCapacity?: number;
    isStreaming?: boolean;
    activityPhase?: HudActivityPhase;
    isSubagentRunning?: boolean;
    runningSubagentCount?: number;
    childConversationIds?: string[];
    dbPathOverride?: string;
  }): Promise<ConversationHudMetrics> {
    const {
      conversationId,
      paneSlotId,
      sessionRevision = 1,
      metricsSequence,
      modelId,
      modelCapacity,
      isStreaming = false,
      activityPhase,
      isSubagentRunning = false,
      runningSubagentCount = 0,
      childConversationIds: domHintChildIds,
      dbPathOverride,
    } = options;

    const dbPath = dbPathOverride || this.resolveDbPath(conversationId);
    const mainState = await this.readSingleDbState(dbPath, conversationId);
    if (!mainState) {
      return buildConversationHudMetrics({
        conversationId,
        paneSlotId,
        sessionRevision,
        metricsSequence,
        availability: isStreaming || isSubagentRunning ? 'ready' : 'unavailable',
        observedAt: null,
        lastSuccessAt: null,
        isStreaming,
        activityPhase,
        isSubagentRunning,
        runningSubagentCount,
        modelId,
        modelCapacity,
        steps: [],
      });
    }

    const nowMs = Date.now();
    const mainIsRecent = nowMs - Math.max(mainState.mtimeMs, mainState.walMtimeMs) <= ACTIVE_DB_RECENCY_MS;
    const mainIdLower = conversationId.toLowerCase();
    const mainTrajLower = mainState.trajectoryId?.toLowerCase() ?? '';
    const forkParentLower = mainState.forkParentCascadeId?.toLowerCase();
    const forkStepCutoff = mainState.forkStepIndex;
    const isBtwTrajectory = mainState.trajectoryType === 22;
    const hasForkSlice = Boolean(
      forkParentLower &&
        EXACT_UUID_RE.test(forkParentLower) &&
        forkParentLower !== mainIdLower &&
        (!mainTrajLower || forkParentLower !== mainTrajLower) &&
        typeof forkStepCutoff === 'number' &&
        Number.isSafeInteger(forkStepCutoff) &&
        forkStepCutoff >= 0 &&
        forkStepCutoff < 10_000_000
    );
    const ownSteps = hasForkSlice
      ? mainState.steps.filter(s => s.idx > forkStepCutoff!)
      : mainState.steps;

    let descendants: ParsedConversationStep[] = [];
    const childUnmatchedGenerations: Array<{ generation: ParsedGenMetadata; isChildStep: true; timestampSeconds: number | null }> = [];
    let totalSubagentSteps = 0;
    let activeChildSubagents = 0;
    let failedChildCount = 0;
    const verifiedChildIds = new Set<string>();
    const activeVerifiedChildIds = new Set<string>();

    const persistedSniffEntry = this.verifiedSniffedChildrenByDb.get(dbPath);
    const candidateChildIds = new Set<string>();
    if (hasForkSlice) {
      for (const s of ownSteps) {
        for (const cid of s.childConversationIds ?? []) {
          if (cid !== mainIdLower && cid !== mainTrajLower) {
            candidateChildIds.add(cid);
          }
        }
      }
    } else {
      for (const cid of mainState.childConversationIds) {
        candidateChildIds.add(cid);
      }
    }
    for (const persistedChild of mainState.verifiedSniffedChildren) {
      candidateChildIds.add(persistedChild);
    }
    if (persistedSniffEntry && persistedSniffEntry.fileId === mainState.fileId) {
      for (const persistedChild of persistedSniffEntry.children) {
        candidateChildIds.add(persistedChild);
      }
    }
    if (Array.isArray(domHintChildIds)) {
      for (const rawHint of domHintChildIds) {
        if (typeof rawHint !== 'string') continue;
        const trimmed = rawHint.trim().toLowerCase();
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(trimmed)) {
          candidateChildIds.add(trimmed);
        }
      }
    }

    const hasActiveSubagentStep = mainIsRecent && ownSteps.some(
      (s) =>
        !isWaitingSubagentToolName(s.toolCallName) &&
        (s.isSubagentStep || (s.toolCallName && SUBAGENT_TOOL_NAMES.has(s.toolCallName))) &&
        RUNNING_SUBAGENT_STEP_STATUSES.has(s.status)
    );
    const hasSubagentEvidenceInMain = ownSteps.some(
      (s) =>
        s.isSubagentStep ||
        s.stepType === 132 ||
        Boolean(s.toolCallName && SUBAGENT_TOOL_NAMES.has(s.toolCallName))
    );

    let hasExternalParentRef = false;
    for (const ref of mainState.referencedUuidsInMetaBlob) {
      if (ref !== mainIdLower && (!mainTrajLower || ref !== mainTrajLower)) {
        hasExternalParentRef = true;
        break;
      }
    }
    const isSubagentTrajectory =
      !isBtwTrajectory &&
      !hasForkSlice &&
      Boolean(dbPathOverride || (mainState.hasParentMetadataBlob && hasExternalParentRef));
    // 优先通过官方 conversation_summaries.db 索引表 O(log N) 精确检索全量子会话与分屏子智能体自身运行态
    const indexedSummaryChildren = new Set<string>();
    const terminalSummaryChildren = new Set<string>();
    const runningSummaryChildren = new Set<string>();
    let selfSummaryRunning = false;
    let summariesIndexAvailable = false;
    const shouldQueryChildrenInSummaries =
      !dbPathOverride && (isSubagentRunning || hasActiveSubagentStep || hasSubagentEvidenceInMain || candidateChildIds.size > 0);
    const shouldQuerySelfInSummaries = isSubagentTrajectory && !isStreaming;
    if (shouldQueryChildrenInSummaries || shouldQuerySelfInSummaries) {
      const selfIdentityIds = mainTrajLower ? [mainIdLower, mainTrajLower] : [mainIdLower];
      const summaryLookup = await this.lookupIndexedChildrenFromSummariesDb(
        shouldQueryChildrenInSummaries ? selfIdentityIds : [],
        shouldQuerySelfInSummaries ? selfIdentityIds : []
      );
      summariesIndexAvailable = summaryLookup.available;
      for (const indexedId of summaryLookup.childIds) {
        if (indexedId !== mainIdLower && indexedId !== mainTrajLower) {
          indexedSummaryChildren.add(indexedId);
          candidateChildIds.add(indexedId);
        }
      }
      for (const termId of summaryLookup.terminalChildIds) {
        terminalSummaryChildren.add(termId);
      }
      for (const runId of summaryLookup.runningChildIds) {
        runningSummaryChildren.add(runId);
      }
      selfSummaryRunning = summaryLookup.selfRunning;
    }

    // 反向子会话文件嗅探回退：仅当官方 summaries 索引库不存在或运行期尚未登记任何子会话时启用
    const coldSniffRec = this.coldSniffedByDb.get(dbPath);
    const needsColdHistoricalSniff =
      !dbPathOverride &&
      !summariesIndexAvailable &&
      !(isSubagentRunning || hasActiveSubagentStep) &&
      hasSubagentEvidenceInMain &&
      (!coldSniffRec || coldSniffRec.fileId !== mainState.fileId || coldSniffRec.stepCount !== mainState.steps.length);
    const needsActiveFallbackSniff =
      !dbPathOverride &&
      (isSubagentRunning || hasActiveSubagentStep) &&
      (!summariesIndexAvailable || candidateChildIds.size === 0);
    if (needsActiveFallbackSniff || needsColdHistoricalSniff) {
      try {
        const allEntries = await (this.sniffInFlight ??= (async () => {
          try {
            const dirStat = await lstat(this.conversationsDir).catch(() => null);
            const dirMtimeMs = dirStat?.mtimeMs ?? -1;
            const checkNow = Date.now();
            const sniffCacheWindowMs = isSubagentRunning || hasActiveSubagentStep ? 800 : 2500;
            if (
              this.sniffDirCache &&
              checkNow - this.sniffDirCache.at < sniffCacheWindowMs &&
              this.sniffDirCache.dirMtimeMs === dirMtimeMs
            ) {
              return this.sniffDirCache.allEntries;
            }
            let dbEntries: Array<{ file: string; id: string }>;
            if (dirStat && this.sniffDirListCache && this.sniffDirListCache.dirMtimeMs === dirStat.mtimeMs) {
              dbEntries = this.sniffDirListCache.dbEntries;
            } else {
              const files = await readdir(this.conversationsDir).catch(() => [] as string[]);
              dbEntries = [];
              for (const file of files) {
                if (!file.endsWith('.db') || file.length < 39) continue;
                const potentialChildId = file.slice(0, -3).toLowerCase();
                if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(potentialChildId)) {
                  dbEntries.push({ file, id: potentialChildId });
                }
              }
              if (dirStat) {
                this.sniffDirListCache = { dirMtimeMs: dirStat.mtimeMs, dbEntries };
              }
            }
            const found: Array<{ id: string; mtimeMs: number }> = [];
            for (let i = 0; i < dbEntries.length; i += 48) {
              const batch = dbEntries.slice(i, i + 48);
              await Promise.all(batch.map(async ({ file, id: potentialChildId }) => {
                const fullChildPath = join(this.conversationsDir, file);
                const [st, walSt] = await Promise.all([
                  lstat(fullChildPath).catch(() => null),
                  lstat(`${fullChildPath}-wal`).catch(() => null),
                ]);
                if (!st || !st.isFile() || st.isSymbolicLink()) return;
                const latestMtime = Math.max(st.mtimeMs, walSt?.mtimeMs ?? 0);
                found.push({ id: potentialChildId, mtimeMs: latestMtime });
              }));
            }
            this.sniffDirCache = { at: checkNow, dirMtimeMs, allEntries: found };
            return found;
          } finally {
            this.sniffInFlight = null;
          }
        })());
        let candidateEntries: Array<{ id: string; mtimeMs: number }>;
        if (isSubagentRunning || hasActiveSubagentStep) {
          candidateEntries = allEntries.filter((e) => nowMs - e.mtimeMs <= ACTIVE_DB_RECENCY_MS);
        } else {
          if (this.coldSniffedByDb.size >= MAX_CACHED_CONVERSATIONS && !this.coldSniffedByDb.has(dbPath)) {
            const oldestCold = this.coldSniffedByDb.keys().next().value;
            if (oldestCold !== undefined) this.coldSniffedByDb.delete(oldestCold);
          }
          this.coldSniffedByDb.set(dbPath, { fileId: mainState.fileId, stepCount: mainState.steps.length });
          const mainLatestMs = Math.max(mainState.mtimeMs, mainState.walMtimeMs);
          let minEpochSec = Number.POSITIVE_INFINITY;
          let maxEpochSec = 0;
          for (const stp of mainState.steps) {
            for (const ts of [stp.startTimeSeconds, stp.createdAtSeconds, stp.endTimeSeconds, stp.completedAtSeconds, stp.finishedGeneratingSeconds]) {
              if (typeof ts === 'number' && Number.isFinite(ts) && ts >= 946_684_800) {
                if (ts < minEpochSec) minEpochSec = ts;
                if (ts > maxEpochSec) maxEpochSec = ts;
              }
            }
          }
          const windowStartMs = Number.isFinite(minEpochSec)
            ? Math.min(minEpochSec * 1000, mainLatestMs) - 120_000
            : mainLatestMs - 3_600_000;
          const windowEndMs = (maxEpochSec > 0 ? Math.max(maxEpochSec * 1000, mainLatestMs) : mainLatestMs) + 900_000;
          candidateEntries = allEntries
            .filter((e) => e.mtimeMs >= windowStartMs && e.mtimeMs <= windowEndMs)
            .sort((a, b) => Math.abs(a.mtimeMs - mainLatestMs) - Math.abs(b.mtimeMs - mainLatestMs))
            .slice(0, 32);
        }
        for (const { id: potentialChildId, mtimeMs: candidateMtime } of candidateEntries) {
          if (
            potentialChildId !== mainIdLower &&
            potentialChildId !== mainTrajLower &&
            !candidateChildIds.has(potentialChildId)
          ) {
            const rejectKey = `${mainIdLower}::${mainTrajLower}::${potentialChildId}`;
            const rejectedMtime = this.rejectedSniffMtimeByKey.get(rejectKey);
            if (rejectedMtime !== undefined && rejectedMtime >= candidateMtime) continue;
            candidateChildIds.add(potentialChildId);
          }
        }
      } catch {}
    }

    if (!dbPathOverride) {
      this.protectedMainDbPaths.set(dbPath, (this.protectedMainDbPaths.get(dbPath) ?? 0) + 1);
      try {
      const pendingChildren = [...candidateChildIds].map(childId => ({
        childId,
        parentId: mainIdLower,
        explicit: mainState.childConversationIds.has(childId),
        indexed: indexedSummaryChildren.has(childId),
        sniffed: !mainState.childConversationIds.has(childId) && !indexedSummaryChildren.has(childId),
      }));
      const processedEdges = new Set<string>();
      const verifiedChildRecords: Array<{
        childId: string;
        childDbPath: string;
        childState: CachedConversationState;
        latestChildMtime: number;
        recent: boolean;
      }> = [];
      const SUBAGENT_READ_CONCURRENCY = 4;
      while (pendingChildren.length > 0) {
        const wave: Array<{
          edge: { childId: string; parentId: string; explicit: boolean; indexed: boolean; sniffed: boolean };
          childId: string;
          childDbPath: string;
        }> = [];
        const waveChildIds = new Set<string>();
        const deferredEdges: typeof pendingChildren = [];
        while (wave.length < SUBAGENT_READ_CONCURRENCY && pendingChildren.length > 0) {
          const edge = pendingChildren.shift()!;
          const childId = edge.childId.toLowerCase();
          if (waveChildIds.has(childId)) {
            deferredEdges.push(edge);
            continue;
          }
          const edgeKey = `${edge.parentId}::${childId}`;
          if (processedEdges.has(edgeKey) || verifiedChildIds.has(childId) ||
              childId === mainIdLower || childId === mainTrajLower) continue;
          processedEdges.add(edgeKey);
          waveChildIds.add(childId);
          wave.push({ edge, childId, childDbPath: this.resolveDbPath(childId) });
        }
        if (deferredEdges.length > 0) {
          pendingChildren.unshift(...deferredEdges);
        }
        if (wave.length === 0) continue;
        const results = await Promise.all(wave.map(async (item) => {
          try {
            const childState = await this.readSingleDbState(item.childDbPath, item.childId);
            if (!childState) {
              if (item.edge.explicit) {
                const childStat = await lstat(item.childDbPath).catch(() => null);
                if (childStat && childStat.size > 4096) return { item, childState: null, failed: true };
              }
              return { item, childState: null, failed: false };
            }
            return { item, childState, failed: false };
          } catch {
            return { item, childState: null, failed: item.edge.explicit };
          }
        }));
        for (const { item, childState, failed } of results) {
          if (failed) {
            failedChildCount++;
            continue;
          }
          if (!childState) {
            if (item.edge.indexed) {
              verifiedChildIds.add(item.childId);
            }
            continue;
          }
          const { edge, childId } = item;
          if (verifiedChildIds.has(childId)) continue;
          const childForkParent = childState.forkParentCascadeId?.toLowerCase();
          const childTrajLower = childState.trajectoryId?.toLowerCase() ?? '';
          const childHasExternalForkParent = Boolean(
            childForkParent &&
              EXACT_UUID_RE.test(childForkParent) &&
              childForkParent !== childId &&
              (!childTrajLower || childForkParent !== childTrajLower)
          );
          if (childState.trajectoryType === 22 || childHasExternalForkParent) {
            if (edge.sniffed) {
              const rejectKey = `${mainIdLower}::${mainTrajLower}::${childId}`;
              const latestChildMtime = Math.max(childState.mtimeMs, childState.walMtimeMs);
              if (this.rejectedSniffMtimeByKey.size >= 1024 && !this.rejectedSniffMtimeByKey.has(rejectKey)) {
                const oldestReject = this.rejectedSniffMtimeByKey.keys().next().value;
                if (oldestReject !== undefined) this.rejectedSniffMtimeByKey.delete(oldestReject);
              }
              this.rejectedSniffMtimeByKey.set(rejectKey, latestChildMtime);
            }
            continue;
          }
          if (childState.fromErrorFallback) {
            failedChildCount++;
          }
          const belongsToParent =
            childState.referencedUuidsInMetaBlob.has(edge.parentId) ||
            ((edge.explicit || edge.indexed) &&
              (childState.referencedUuidsInMetaBlob.has(mainIdLower) ||
                (mainTrajLower !== '' && childState.referencedUuidsInMetaBlob.has(mainTrajLower)))) ||
            (edge.sniffed &&
              mainTrajLower !== '' &&
              childState.referencedUuidsInMetaBlob.has(mainTrajLower));
          if (childState.parentMetaReadError) {
            failedChildCount++;
            continue;
          }
          if (childState.hasParentMetadataBlob) {
            const indexedWithoutConflict =
              edge.indexed && childState.referencedUuidsInMetaBlob.size === 0;
            if (!belongsToParent && !indexedWithoutConflict) {
              if (edge.sniffed) {
                const rejectKey = `${mainIdLower}::${mainTrajLower}::${childId}`;
                const latestChildMtime = Math.max(childState.mtimeMs, childState.walMtimeMs);
                if (this.rejectedSniffMtimeByKey.size >= 1024 && !this.rejectedSniffMtimeByKey.has(rejectKey)) {
                  const oldestReject = this.rejectedSniffMtimeByKey.keys().next().value;
                  if (oldestReject !== undefined) this.rejectedSniffMtimeByKey.delete(oldestReject);
                }
                this.rejectedSniffMtimeByKey.set(rejectKey, latestChildMtime);
              }
              continue;
            }
          } else if (!edge.indexed && (!edge.explicit || childState.hasTrajectoryMeta)) {
            continue;
          }
          verifiedChildIds.add(childId);
          if (edge.sniffed) {
            mainState.verifiedSniffedChildren.add(childId);
            let sniffRecord = this.verifiedSniffedChildrenByDb.get(dbPath);
            if (!sniffRecord || sniffRecord.fileId !== mainState.fileId) {
              sniffRecord = { fileId: mainState.fileId, stepCount: mainState.steps.length, children: new Set() };
              if (this.verifiedSniffedChildrenByDb.size >= MAX_CACHED_CONVERSATIONS) {
                const oldestSniffKey = this.verifiedSniffedChildrenByDb.keys().next().value;
                if (oldestSniffKey !== undefined) this.verifiedSniffedChildrenByDb.delete(oldestSniffKey);
              }
            } else {
              this.verifiedSniffedChildrenByDb.delete(dbPath);
            }
            sniffRecord.children.add(childId);
            this.verifiedSniffedChildrenByDb.set(dbPath, sniffRecord);
          }
          totalSubagentSteps += childState.steps.length;
          const latestChildMtime = Math.max(childState.mtimeMs, childState.walMtimeMs);
          const recent = nowMs - latestChildMtime <= ACTIVE_DB_RECENCY_MS;
          verifiedChildRecords.push({
            childId,
            childDbPath: item.childDbPath,
            childState,
            latestChildMtime,
            recent,
          });
          const cg = childState.genMetadata;
          const hasGenModel = (g: ParsedGenMetadata | undefined): boolean =>
            Boolean(g && (g.responseModel || g.modelDisplayName || g.plannerModelName || g.modelEnum));
          const sameChildStepModel = (() => {
            for (const cs of childState.steps) {
              const g = cs.generation;
              if (g && hasGenModel(g)) {
                return {
                  ...(g.responseModel ? { responseModel: g.responseModel } : {}),
                  ...(g.modelDisplayName ? { modelDisplayName: g.modelDisplayName } : {}),
                  ...(g.plannerModelName ? { plannerModelName: g.plannerModelName } : {}),
                  ...(g.modelEnum ? { modelEnum: g.modelEnum } : {}),
                };
              }
              if (cs.modelName) {
                return { plannerModelName: cs.modelName };
              }
            }
            return undefined;
          })();
          const childFallbackGen: ParsedGenMetadata | undefined = cg && hasGenModel(cg)
            ? {
                ...(cg.responseModel ? { responseModel: cg.responseModel } : {}),
                ...(cg.modelDisplayName ? { modelDisplayName: cg.modelDisplayName } : {}),
                ...(cg.plannerModelName ? { plannerModelName: cg.plannerModelName } : {}),
                ...(cg.modelEnum ? { modelEnum: cg.modelEnum } : {}),
              }
            : sameChildStepModel;
          for (const cStep of childState.steps) {
            if (childFallbackGen && cStep.stepType === 15 && cStep.hasUsage && !hasGenModel(cStep.generation) && !cStep.modelName) {
              descendants.push({
                ...cStep,
                generation: cStep.generation ? { ...childFallbackGen, ...cStep.generation } : childFallbackGen,
              });
            } else {
              descendants.push(cStep);
            }
          }
          for (const extraGen of childState.unmatchedUsageGenerations) {
            childUnmatchedGenerations.push({
              generation: extraGen.generation,
              isChildStep: true,
              timestampSeconds: extraGen.timestampSeconds,
            });
          }
          for (const nested of childState.childConversationIds) {
            pendingChildren.push({ childId: nested, parentId: childId, explicit: true, indexed: false, sniffed: false });
          }
        }
      }

      // 第一阶段：跨全部分波扫描所有近期子库，先确立实锤活跃子库数量，消除并发分波/数组顺序造成的兄弟漏计竞态
      let confirmedActiveChildCount = 0;
      const evaluatedRecentChildren: Array<{
        record: (typeof verifiedChildRecords)[number];
        explicitActive: boolean;
        childTurnTerminated: boolean;
      }> = [];
      for (const record of verifiedChildRecords) {
        if (!record.recent && !runningSummaryChildren.has(record.childId)) continue;
        const { childId, childState } = record;
        let explicitActive = false;
        let childTurnTerminated = terminalSummaryChildren.has(childId);
        let sawWaitingTailStep = false;
        let tailInspectionDone = false;
        for (let idx = childState.steps.length - 1; idx >= 0; idx--) {
          const step = childState.steps[idx]!;
          if (step.stepType === 14) break;
          if (step.stepType === 2 && (step.status === 3 || step.status === 5)) {
            childTurnTerminated = true;
            break;
          }
          if (!tailInspectionDone && !TRANSPARENT_HANDOFF_STEP_TYPES.has(step.stepType)) {
            tailInspectionDone = true;
            if (TERMINAL_ABORTED_STEP_STATUSES.has(step.status)) {
              childTurnTerminated = true;
              break;
            }
            if (isWaitingSubagentToolName(step.toolCallName)) {
              childTurnTerminated = true;
              break;
            }
            if (step.status === 9) {
              sawWaitingTailStep = true;
            }
          }
          if (isWaitingSubagentToolName(step.toolCallName)) {
            if (ACTIVE_STEP_STATUSES.has(step.status)) {
              childTurnTerminated = true;
              break;
            }
            continue;
          }
          if (RUNNING_SUBAGENT_STEP_STATUSES.has(step.status)) {
            explicitActive = true;
            break;
          }
        }
        if (!explicitActive && sawWaitingTailStep) {
          childTurnTerminated = true;
        }
        if (!childTurnTerminated && runningSummaryChildren.has(childId)) {
          explicitActive = true;
        }
        if (explicitActive) {
          confirmedActiveChildCount++;
        }
        evaluatedRecentChildren.push({ record, explicitActive, childTurnTerminated });
      }
      // 第二阶段：基于全局实锤活跃兄弟数统一结算过渡防抖保活（绝不混入前台 isStreaming）
      const terminatedRecentChildIds = new Set<string>();
      for (const { record, explicitActive, childTurnTerminated } of evaluatedRecentChildren) {
        const { childId, childDbPath, childState, latestChildMtime } = record;
        let childActive = explicitActive;
        if (childActive) {
          if (this.recentActiveChildUntilByDb.has(childDbPath)) {
            this.recentActiveChildUntilByDb.delete(childDbPath);
          } else if (this.recentActiveChildUntilByDb.size >= MAX_CACHED_CONVERSATIONS * 2) {
            const oldestActiveKey = this.recentActiveChildUntilByDb.keys().next().value;
            if (oldestActiveKey !== undefined) this.recentActiveChildUntilByDb.delete(oldestActiveKey);
          }
          this.recentActiveChildUntilByDb.set(childDbPath, nowMs + 12_000);
        } else if (!childTurnTerminated && childState.steps.length > 0) {
          const holdUntil = this.recentActiveChildUntilByDb.get(childDbPath) ?? 0;
          const parentCorroboratesActive = Boolean(
            isSubagentRunning ||
              hasActiveSubagentStep ||
              confirmedActiveChildCount > 0 ||
              runningSummaryChildren.size > 0
          );
          const childMidStepTransition =
            nowMs - latestChildMtime <= 15_000 && parentCorroboratesActive;
          if ((holdUntil > nowMs && parentCorroboratesActive) || childMidStepTransition) {
            childActive = true;
          } else if (holdUntil > 0 && !parentCorroboratesActive) {
            this.recentActiveChildUntilByDb.delete(childDbPath);
          }
        } else if (childTurnTerminated) {
          this.recentActiveChildUntilByDb.delete(childDbPath);
          terminatedRecentChildIds.add(childId);
        }
        if (childActive) {
          activeChildSubagents++;
          activeVerifiedChildIds.add(childId);
        }
      }
      // 将已确认终态且非活跃的历史子库降级为轻量不可变聚合缓存（释放 rawSteps/generations 并提容至 512），消除超长 Swarm 会话 LRU 抖动风暴
      for (const record of verifiedChildRecords) {
        if (activeVerifiedChildIds.has(record.childId)) continue;
        if (!record.recent || terminatedRecentChildIds.has(record.childId)) {
          this.demoteTerminalChildToCompactCache(record.childDbPath, record.childState);
        }
      }
      if (!mainState.fromErrorFallback && !mainState.isCompactTerminalChild) {
        this.setCachedState(dbPath, mainState);
      }
      } finally {
        const nextRefs = (this.protectedMainDbPaths.get(dbPath) ?? 1) - 1;
        if (nextRefs <= 0) this.protectedMainDbPaths.delete(dbPath);
        else this.protectedMainDbPaths.set(dbPath, nextRefs);
      }
    }

    let latestMainModelStepPos = -1;
    for (let i = ownSteps.length - 1; i >= 0; i--) {
      if (ownSteps[i]!.stepType === 15) {
        latestMainModelStepPos = i;
        break;
      }
    }
    const normalizedContextSteps =
      verifiedChildIds.size > 0
        ? ownSteps.map((step, idx) => {
            if (!RUNNING_SUBAGENT_STEP_STATUSES.has(step.status)) return step;
            const isSubStep =
              !isWaitingSubagentToolName(step.toolCallName) &&
              (Boolean(step.isSubagentStep) ||
                step.stepType === 127 ||
                Boolean(step.toolCallName && SUBAGENT_TOOL_NAMES.has(step.toolCallName)));
            if (!isSubStep) return step;
            if (step.childConversationIds && step.childConversationIds.length > 0) {
              const linkedVerified = step.childConversationIds
                .map((cid) => cid.toLowerCase())
                .filter((cid) => verifiedChildIds.has(cid));
              if (linkedVerified.length > 0) {
                if (
                  failedChildCount === 0 &&
                  linkedVerified.every((cid) => !activeVerifiedChildIds.has(cid))
                ) {
                  return { ...step, status: 3 };
                }
                return step;
              }
            }
            // 无显式内联 UUID 的历史批次派发步（如通过 summaries/嗅探识别的 Swarm 步），若其后已有新的模型生成步或全部验证子库均已完结，不再重复占活跃位
            if (failedChildCount === 0 && (activeChildSubagents === 0 || idx < latestMainModelStepPos)) {
              return { ...step, status: 3 };
            }
            return step;
          })
        : ownSteps;
    const combinedSteps = dbPathOverride ? normalizedContextSteps : [...normalizedContextSteps, ...descendants];

    let ownUnmatchedGens = mainState.unmatchedUsageGenerations;
    if (hasForkSlice) {
      let hasPreForkSteps = false;
      let maxPreForkTs: number | null = null;
      for (const s of mainState.steps) {
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
      ownUnmatchedGens = mainState.unmatchedUsageGenerations.filter((item) => {
        const indices = item.generation.stepIndices;
        if (indices && indices.length > 0) {
          return indices.every((idx) => idx > forkStepCutoff!);
        }
        if (!hasPreForkSteps) {
          return item.timestampSeconds !== null && item.timestampSeconds > 0;
        }
        if (maxPreForkTs === null) return false;
        return item.timestampSeconds !== null && item.timestampSeconds > maxPreForkTs;
      });
    }

    const latestOwnModelStep = [...normalizedContextSteps]
      .reverse()
      .find(step => step.stepType === 15 && step.hasUsage);
    let effectiveGenMetadata = latestOwnModelStep?.generation;
    let inheritedContextStep: ParsedConversationStep | undefined;
    let inheritedGenMetadata: ParsedGenMetadata | undefined;
    if (hasForkSlice) {
      if (!effectiveGenMetadata) {
        const ownGens = [...mainState.generations.entries()]
          .filter(([, g]) => g.stepIndices && g.stepIndices.length > 0 && g.stepIndices.every(idx => idx > forkStepCutoff!))
          .sort((a, b) => a[0] - b[0]);
        effectiveGenMetadata = ownGens[ownGens.length - 1]?.[1];
      }
      if (!latestOwnModelStep) {
        inheritedContextStep = [...mainState.steps]
          .reverse()
          .find(s => s.idx <= forkStepCutoff! && s.stepType === 15 && s.hasUsage);
        inheritedGenMetadata = inheritedContextStep?.generation ?? mainState.genMetadata;
      }
    } else if (!effectiveGenMetadata) {
      effectiveGenMetadata = mainState.genMetadata;
    }

    const effectiveRunningSubagents = Math.max(runningSubagentCount, activeChildSubagents);
    const effectiveSubagentRunning = Boolean(isSubagentRunning || effectiveRunningSubagents > 0);
    const availability: HudDataAvailability = mainState.fromErrorFallback
      ? 'cached'
      : failedChildCount > 0 || mainState.parentMetaReadError
      ? 'partial'
      : 'ready';

    const pricingTable = await this.resolveEffectivePricingTable();
    const metrics = buildConversationHudMetrics({
      conversationId,
      paneSlotId,
      sessionRevision,
      metricsSequence,
      availability,
      observedAt: mainState.observedAt,
      lastSuccessAt: mainState.lastSuccessAt,
      failedChildCount,
      // 传入前台流式信号（分屏子智能体无独立停止按钮时结合 summaries.db 实锤 RUNNING 且末步未完结信号保活）
      isStreaming: Boolean(
        isStreaming ||
          (selfSummaryRunning &&
            !(() => {
              const tail = findLastSubstantiveStep(normalizedContextSteps);
              if (!tail) return false;
              if (tail.stepType === 2 && (tail.status === 3 || tail.status === 5)) return true;
              return TERMINAL_ABORTED_STEP_STATUSES.has(tail.status);
            })())
      ),
      activityPhase,
      isSubagentRunning: effectiveSubagentRunning,
      runningSubagentCount: effectiveRunningSubagents,
      subagentCount: dbPathOverride ? undefined : verifiedChildIds.size,
      subagentSteps: totalSubagentSteps,
      totalStepsOverride: ownSteps.length + totalSubagentSteps,
      allowDbActiveStepInference: mainIsRecent || isStreaming || effectiveSubagentRunning || selfSummaryRunning,
      isSubagentTrajectory,
      isBtwTrajectory,
      inheritedContextStep,
      inheritedGenMetadata,
      modelId,
      modelCapacity,
      pricingTable,
      genMetadata: effectiveGenMetadata,
      executorMetadata: mainState.executorMetadata,
      extraUsageGenerations: [
        ...ownUnmatchedGens.map(item => ({
          generation: item.generation,
          isChildStep: false,
          timestampSeconds: item.timestampSeconds,
        })),
        ...(dbPathOverride ? [] : childUnmatchedGenerations),
      ],
      contextSteps: normalizedContextSteps,
      steps: combinedSteps,
    });

    return metrics;
  }

  public clearCache(): void {
    this.cache.clear();
    this.terminalChildCache.clear();
    this.protectedMainDbPaths.clear();
    this.verifiedSniffedChildrenByDb.clear();
    this.recentActiveChildUntilByDb.clear();
    this.coldSniffedByDb.clear();
    this.rejectedSniffMtimeByKey.clear();
    this.summariesChildCache.clear();
    this.summariesMissingUntilMs = 0;
    this.sniffDirCache = null;
    this.sniffDirListCache = null;
    this.sniffInFlight = null;
    this.cachedPricingTable = null;
    this.pricingResolveInFlight = null;
  }
}
