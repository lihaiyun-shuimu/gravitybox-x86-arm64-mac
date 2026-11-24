import { compactBarNumber, compactDecimal, compactNumber, compactPercent, compactRate, compactUsd, durationText, formatTurnDurationCompact } from '../dist/metric-format.js';
import { hudText, normalizeHudLocale } from './hud-i18n.js';
import { HUD_STYLES_CSS } from './hud-styles.js';
import {
  resolveVisibleHorizontalBounds,
  computeUpwardPopoverPosition,
  applyPopoverGeometry,
  resetPopoverGeometryCache,
} from './hud-popover.js';

/**
 * 单分栏自治 HUD 实例 (HudInstance - Antigravity Native v2.1)
 * 包含：
 * 1. 输入框底边与应用底端之间的精确垂直居中平衡器 (syncVerticalCentering)
 * 2. Antigravity 原生一体化分段遥测条与向上展开卡片（完全移除原生 title 悬浮提示避免遮挡）
 * 3. 子智能体运行状态实时感知与展示（支持 DOM + SQLite 双栈子智能体追踪）
 * 4. 100% 真实会话底层指标渲染（零虚构 1M 上限，零硬编码 1.9K/7.6K 提示词，修正思维链模型 TPS/TTFT）
 * 5. Open Shadow DOM 双向隔离、AbortController 信号守卫与双重令牌防篡改
 */

const POPOVER_WIDTHS = {
  session: 296,
  tokens: 296,
  context: 344,
};

function isRawNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function trimFallbackTrailingZeros(text) {
  return String(text).replace(/(\d+)\.(\d*[1-9])?0+(?=[KMBkmb]?$)/g, (_m, intPart, frac) =>
    frac ? `${intPart}.${frac}` : intPart
  );
}

/**
 * 紧凑数字表示法：全端统一 3 位有效数字，并始终去除尾零。
 */
function formatDetailCompactNumber(value, sig = 3) { return compactNumber(value, sig); }

function formatBarCompactCount(value, fallback = '0') {
  if (isRawNumber(value)) {
    return compactBarNumber(value);
  }
  if (!fallback) return '0';
  if (fallback === '—') return '—';
  const cleanedText = String(fallback).replace(/[,~\s]|tok$/gi, '');
  const parsedValue = Number(cleanedText);
  if (Number.isFinite(parsedValue) && parsedValue >= 0) {
    return compactBarNumber(parsedValue);
  }
  return trimFallbackTrailingZeros(cleanedText || fallback);
}

function formatBarTokenCount(value, fallback) {
  if (isRawNumber(value)) {
    return `${compactBarNumber(value)} tok`;
  }
  if (!fallback) return '0 tok';
  if (fallback === '—') return '—';
  const cleanedText = String(fallback).replace(/[,~\s]|tok$/gi, '');
  const parsedValue = Number(cleanedText);
  if (Number.isFinite(parsedValue) && parsedValue >= 0) {
    return `${compactBarNumber(parsedValue)} tok`;
  }
  const normalized = trimFallbackTrailingZeros(cleanedText);
  return normalized.endsWith('tok') ? normalized : `${normalized} tok`;
}

function formatTokenCount(value, fallback) {
  if (isRawNumber(value)) {
    return `${formatDetailCompactNumber(value)} tok`;
  }
  if (!fallback) return '0 tok';
  if (fallback === '—') return '—';
  const cleanedText = String(fallback).replace(/[,~\s]|tok$/gi, '');
  const parsedValue = Number(cleanedText);
  if (Number.isFinite(parsedValue) && parsedValue >= 0) {
    return `${formatDetailCompactNumber(parsedValue)} tok`;
  }
  const normalized = trimFallbackTrailingZeros(cleanedText);
  return normalized.endsWith('tok') ? normalized : `${normalized} tok`;
}

function formatMetric(value, formatted, digits, suffix) {
  if (formatted === '—' || !isRawNumber(value)) return '—';
  return `${digits === 0 ? Math.round(value) : compactDecimal(value, digits)}${suffix}`;
}

function formatRateMetric(value, formatted, suffix) {
  if (formatted === '—' || !isRawNumber(value)) return '—';
  return `${compactRate(value)}${suffix}`;
}

/** 弹窗百分比：国际简明格式（>=99.95% 取整，>=1% 最多 1 位小数，<1% 最多 2 位小数并去尾零）。 */
function formatPopoverPercent(value, formatted) {
  if (formatted === '—' || !isRawNumber(value)) return '—';
  return compactPercent(value);
}

function formatConciseStageModelName(rawName) {
  let text = String(rawName || '').trim();
  if (!text) return '—';
  // 兼容 2.34.0 "Orchestrator <Model>" 与历史 "Orchestrator (<Model>)" / "<Model> (Orchestrator)" 包装
  text = text
    .replace(/^Orchestrator\s*[（(]\s*([^）)]+?)\s*[）)]$/i, '$1')
    .replace(/^Orchestrator(?:\s*[:·•/-]\s*|\s+)/i, '')
    .replace(/\s*[（(]\s*Orchestrator\s*[）)]$/i, '')
    .trim();
  if (!text) return '—';
  const g4Match = text.match(/^Gemini\s+4\s+(.+)$/i);
  if (g4Match) return g4Match[1];
  const gVerMatch = text.match(/^Gemini\s+(\d+(?:\.\d+)?\s+.+)$/i);
  if (gVerMatch) return gVerMatch[1];
  const claudeMatch = text.match(/^Claude\s+(.+)$/i);
  if (claudeMatch) return claudeMatch[1];
  const vendorMatch = text.match(/^(?:OpenAI|Anthropic|Google|Meta|xAI|Mistral)\s+(.+)$/i);
  if (vendorMatch && vendorMatch[1]) return vendorMatch[1].trim();
  return text;
}

function escapeHudHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatPercent(value, formatted, digits) {
  return formatMetric(isRawNumber(value) ? value * 100 : NaN, formatted, digits, '%');
}

function formatDuration(value, formatted, locale) {
  if (formatted === '—' || !isRawNumber(value)) return '—';
  return durationText(value, locale === true ? 'en' : locale === false ? 'zh-Hans' : (locale || 'zh-Hans'));
}

/**
 * 上下文进度条同色系渐进演进配色（0% → 100%）：
 * 浅色模式由清透天蓝渐深至深钴蓝；深色模式由柔和冰蓝过渡至饱满电光蓝（避免深底吞色）。
 */
function computeContextProgressColor(ratio, isDark = false) {
  const r = Math.min(1, Math.max(0, Number(ratio) || 0));
  const stops = isDark
    ? [
        [147, 197, 253], // #93C5FD
        [88, 155, 255],  // #589BFF
        [37, 99, 235],   // #2563EB
      ]
    : [
        [132, 186, 255], // #84BAFF
        [49, 134, 255],  // #3186FF
        [20, 73, 196],   // #1449C4
      ];
  const [start, end, t] =
    r <= 0.5 ? [stops[0], stops[1], r * 2] : [stops[1], stops[2], (r - 0.5) * 2];
  const ch = (idx) => Math.round(start[idx] + (end[idx] - start[idx]) * t);
  return `rgb(${ch(0)}, ${ch(1)}, ${ch(2)})`;
}

function createDefaultMetrics(conversationId = 'default', sessionRevision = 1) {
  return {
    conversationId,
    sessionRevision,
    updatedAt: Date.now(),
    availability: 'loading', observedAt: null,
    isStreaming: false,
    activityPhase: 'idle',
    isSubagentRunning: false,
    runningSubagentCount: 0,
    session: {
      turns: 0,
      steps: 0,
      modelSteps: 0,
      toolSteps: 0,
      compactionCount: 0,
      subagentCount: 0,
      runningSubagentCount: 0,
      subagentSteps: 0,
      hasSubagentInTurn: false,
      modelDurationSeconds: 0,
      modelDurationFormatted: '0秒',
      modelDurationFormattedEn: '0s',
      toolDurationSeconds: 0,
      toolDurationFormatted: '0秒',
      toolDurationFormattedEn: '0s',
      averageTtftSeconds: 0,
      averageTtftFormatted: '—',
      averageTtftFormattedEn: '—',
      outputTps: 0,
      outputTpsFormatted: '—',
      latestStepOutputTps: 0,
      latestStepOutputTpsFormatted: '—',
      latestStepTtftSeconds: 0,
      latestStepTtftFormatted: '—',
      latestStepTtftFormattedEn: '—',
      currentTurnOutputTps: 0,
      currentTurnOutputTpsFormatted: '—',
      currentTurnTimedSamples: 0,
      currentTurnDurationSeconds: 0,
      currentTurnDurationFormatted: '0秒',
      currentTurnDurationFormattedEn: '0s',
      currentTurnDurationCompactZh: '本轮 0s',
      currentTurnDurationCompactEn: 'Turn 0s',
      currentTurnModelDurationSeconds: 0,
      currentTurnToolDurationSeconds: 0,
      inFlightModelDurationSeconds: 0,
      activeModelStepCount: 0,
      inFlightToolDurationSeconds: 0,
      activeToolStepCount: 0,
    },
    tokens: {
      totalTokens: 0,
      totalTokensCompact: '0 tok',
      totalTokensFormatted: '0 tok',
      cacheHitRate: 0,
      cacheHitRateFormatted: '0%',
      uncachedInputTokens: 0,
      uncachedInputFormatted: '0 tok',
      cachedReadTokens: 0,
      cachedReadFormatted: '0 tok',
      outputTokens: 0,
      outputFormatted: '0 tok',
      estimatedCostUsd: undefined,
      estimatedCostFormatted: '—',
      cacheSavedUsd: undefined,
      cacheSavedFormatted: '—',
    },
    context: {
      hasUsageData: false,
      modelId: '',
      modelDisplayName: '—',
      usedTokens: 0,
      usedTokensCompact: '0',
      usedTokensFormatted: '0 tok',
      peakContextTokens: 0,
      peakContextCompact: '0',
      peakContextFormatted: '0 tok',
      capacityTokens: 0,
      capacityTokensCompact: '—',
      usedRatio: 0,
      usedRatioFormatted: '0%',
      stepCacheRatio: 0,
      stepCacheRatioFormatted: '0%',
      breakdown: {
        cachedContextTokens: 0,
        cachedContextFormatted: '0 tok',
        cachedContextRatio: 0,
        uncachedContextTokens: 0,
        uncachedContextFormatted: '0 tok',
        uncachedContextRatio: 0,
        latestOutputTokens: 0,
        latestOutputFormatted: '0 tok',
        systemTokens: 0,
        systemTokensCompact: '0 tok',
        systemRatio: 0,
        toolTokens: 0,
        toolTokensCompact: '0 tok',
        toolRatio: 0,
        messageTokens: 0,
        messageTokensCompact: '0 tok',
        messageRatio: 0,
      },
    },
  };
}

export class HudInstance {
  constructor(cascadeId, options = {}) {
    this.cascadeId = cascadeId || 'default-pane';
    this.paneSlotId = options.paneSlotId || this.cascadeId;
    this.isPrimaryPane = Boolean(options.isPrimaryPane);
    this.paneKind = options.paneKind || (options.isSubpane ? 'subagent' : 'main');
    this.isSubpane = Boolean(options.isSubpane || this.paneKind !== 'main');
    this.locale = normalizeHudLocale(options.locale || options.languageMode || 'zh-Hans');
    this.languageMode = this.locale === 'zh-Hans' ? 'zh' : this.locale;
    this.onBridgeEvent = typeof options.onBridgeEvent === 'function' ? options.onBridgeEvent : null;
    this.onPopoverOpen = typeof options.onPopoverOpen === 'function' ? options.onPopoverOpen : null;
    this.allocateRevision = typeof options.allocateRevision === 'function' ? options.allocateRevision : null;
    this.onVisibilityResume = typeof options.onVisibilityResume === 'function' ? options.onVisibilityResume : null;
    this.currentConvId = null;
    this.sessionRevision = 0;
    this.lastMetricsSequence = 0;
    this.lastAppliedUpdatedAt = 0;
    this.currentModelId = '';
    this.currentModelCapacity = undefined;
    this.backendIsStreaming = false;
    this.domIsStreaming = false;
    this.domActivityPhase = 'idle';
    this.backendActivityPhase = null;
    this.activityPhase = 'idle';
    this.domIsSubagentRunning = false;
    this.domRunningSubagentCount = 0;
    this.backendIsSubagentRunning = false;
    this.backendRunningSubagentCount = 0;
    this.childConversationIds = [];
    this.isStreaming = false;
    this.hasActiveWork = false;
    this.isSubagentRunning = false;
    this.runningSubagentCount = 0;
    this.abortController = null;
    this.resizeObserver = null;
    this.host = null;
    this.shadow = null;
    this.isDarkTheme = false;
    this.domRefs = null;
    this.domRefsShadow = null;
    this.targetComposer = null;
    this.hostMountedInDom = false;
    this.lastThemeSig = '';
    this.lastReconcileWidth = -1;
    this.lastContainerWidthTier = '';
    this.lastCenteringSig = '';
    this.activePopoverId = null;
    this.pinnedPopoverId = null;
    this.hoverEnterTimer = null;
    this.hoverLeaveTimer = null;
    this.turnClockTimer = null;
    this.turnClockAnchor = null;
    this.modelClockAnchor = null;
    this.toolClockAnchor = null;
    this.turnHighWaterMark = null;
    this.frozenClockSnapshot = null;
    this.settledIdleTurnState = null;
    this.streamResumeAtMs = 0;
    this.lastMetrics = createDefaultMetrics('default', 0);
  }

  resetToEmptyState() {
    this.stopTurnClock();
    this.turnHighWaterMark = null;
    this.frozenClockSnapshot = null;
    this.settledIdleTurnState = null;
    this.streamResumeAtMs = 0;
    this.currentConvId = null;
    this.currentModelId = '';
    this.currentModelCapacity = undefined;
    this.backendIsStreaming = false;
    this.domIsStreaming = false;
    this.domActivityPhase = 'idle';
    this.backendActivityPhase = null;
    this.activityPhase = 'idle';
    this.domIsSubagentRunning = false;
    this.domRunningSubagentCount = 0;
    this.backendIsSubagentRunning = false;
    this.backendRunningSubagentCount = 0;
    this.childConversationIds = [];
    this.isStreaming = false;
    this.hasActiveWork = false;
    this.isSubagentRunning = false;
    this.runningSubagentCount = 0;
    this.pinnedPopoverId = null;
    this.lastMetrics = createDefaultMetrics('default', 0);
    if (this.shadow) {
      this.applyMetricsToDom(this.lastMetrics);
    }
    this.renderSkeleton();
  }

  getCurrentConvId() {
    return this.currentConvId;
  }

  getSessionRevision() {
    return this.sessionRevision;
  }

  switchConversation(
    newConvId,
    modelId = null,
    isStreaming = false,
    isSubagentRunning = false,
    runningSubagentCount = 0,
    childConversationIds = null,
    activityPhase = null,
    modelCapacity = undefined
  ) {
    if (!newConvId) return this.sessionRevision;
    const changed = this.currentConvId !== newConvId;
    this.currentConvId = newConvId;
    const validCap =
      typeof modelCapacity === 'number' && Number.isSafeInteger(modelCapacity) && modelCapacity > 0
        ? modelCapacity
        : undefined;
    if (changed) {
      this.currentModelId = modelId || '';
      this.currentModelCapacity = validCap;
    } else {
      if (modelId) this.currentModelId = modelId;
      if (validCap !== undefined) this.currentModelCapacity = validCap;
    }
    const prevDomStreaming = this.domIsStreaming;
    this.domIsSubagentRunning = Boolean(isSubagentRunning);
    this.domRunningSubagentCount = Math.max(0, Number(runningSubagentCount) || 0);
    // domIsStreaming 与 domActivityPhase 仅由当前分栏前台模型/流式状态决定，不与独立子智能体混用
    this.domIsStreaming = Boolean(isStreaming);
    this.domActivityPhase = !this.domIsStreaming
      ? 'idle'
      : activityPhase === 'executing'
      ? 'executing'
      : 'generating';
    if (Array.isArray(childConversationIds)) {
      this.childConversationIds = [...new Set(childConversationIds.filter(Boolean))];
    } else if (changed) {
      this.childConversationIds = [];
    }
    if (changed) {
      this.stopTurnClock();
      this.turnHighWaterMark = null;
      this.frozenClockSnapshot = null;
      this.settledIdleTurnState = null;
      this.backendIsSubagentRunning = false;
      this.backendRunningSubagentCount = 0;
      this.backendActivityPhase = null;
      this.backendIsStreaming = false;
      this.isSubagentRunning = this.domIsSubagentRunning;
      this.runningSubagentCount = this.domRunningSubagentCount;
      this.isStreaming = this.domIsStreaming;
      this.hasActiveWork = Boolean(this.domIsStreaming || this.isSubagentRunning);
      this.streamResumeAtMs = this.hasActiveWork ? Date.now() : 0;
      this.activityPhase = this.computeMergedActivityPhase();
      this.sessionRevision = this.allocateRevision
        ? Math.max(this.sessionRevision + 1, this.allocateRevision())
        : this.sessionRevision + 1;
      this.lastMetricsSequence = 0;
      this.lastAppliedUpdatedAt = 0;
      this.pinnedPopoverId = null;
      this.lastMetrics = createDefaultMetrics(newConvId, this.sessionRevision);
      if (this.shadow) {
        this.applyMetricsToDom(this.lastMetrics);
      }
      this.renderSkeleton();
      this.syncStreamingClass();
      this.emitBridgeEvent('SESSION_ATTACHED');
    } else {
      if (prevDomStreaming && !this.domIsStreaming) {
        this.backendIsStreaming = false;
      }
      const wasActiveWork = this.hasActiveWork;
      this.isSubagentRunning = Boolean(this.domIsSubagentRunning || this.backendIsSubagentRunning);
      this.runningSubagentCount = Math.max(
        this.domRunningSubagentCount,
        this.backendRunningSubagentCount
      );
      const subagentBackendStreaming = this.isSubagentBackendStreaming(this.lastMetrics);
      this.isStreaming = Boolean(this.domIsStreaming || subagentBackendStreaming);
      this.hasActiveWork = Boolean(
        this.isStreaming ||
          this.isSubagentRunning ||
          (this.lastMetrics?.session?.activeModelStepCount || 0) > 0 ||
          (this.lastMetrics?.session?.activeToolStepCount || 0) > 0
      );
      if (!wasActiveWork && this.hasActiveWork) {
        this.streamResumeAtMs = Date.now();
        if (this.lastMetrics?.availability === 'remote_unbridged') {
          this.turnHighWaterMark = null;
          this.frozenClockSnapshot = null;
        }
      }
      this.activityPhase = this.computeMergedActivityPhase();
      this.syncStreamingClass();
    }
    return this.sessionRevision;
  }

  isSubagentBackendStreaming(metricsRef = null) {
    return Boolean(
      metricsRef?.session?.isSubagentTrajectory === true &&
        this.backendIsStreaming
    );
  }

  computeMergedActivityPhase(metricsOverride = null) {
    const refMetrics = metricsOverride || this.lastMetrics;
    const subpaneDbActive =
      Boolean(
        this.isSubpane ||
          this.paneKind === 'btw' ||
          this.paneKind === 'subagent' ||
          refMetrics?.session?.isSubagentTrajectory
      ) &&
      ((refMetrics?.session?.activeModelStepCount || 0) > 0 ||
        (refMetrics?.session?.activeToolStepCount || 0) > 0);
    const subagentTrajectoryStreaming = this.isSubagentBackendStreaming(refMetrics);
    // 当前分栏前台模型未处于流式轮次时（除非是独立子智能体/BTW 分栏且底层数据库实锤存在活跃步或后端判定子轨迹流式中），小圆点保持灰色 idle
    if (!this.domIsStreaming && !subpaneDbActive && !subagentTrajectoryStreaming) return 'idle';
    const refBackendPhase = metricsOverride?.activityPhase ?? this.backendActivityPhase;
    if (this.domActivityPhase === 'executing' || refBackendPhase === 'executing') {
      return 'executing';
    }
    return 'generating';
  }

  notifyModelOrStreamingChange(
    modelId,
    isStreaming,
    isSubagentRunning = false,
    runningSubagentCount = 0,
    childConversationIds = null,
    activityPhase = null,
    modelCapacity = undefined
  ) {
    let changed = false;
    const validCap =
      typeof modelCapacity === 'number' && Number.isSafeInteger(modelCapacity) && modelCapacity > 0
        ? modelCapacity
        : undefined;
    const modelChanged = Boolean(modelId && modelId !== this.currentModelId);
    const capChanged = validCap !== undefined && validCap !== this.currentModelCapacity;
    if (modelChanged || capChanged) {
      if (modelId) this.currentModelId = modelId;
      if (validCap !== undefined) this.currentModelCapacity = validCap;
      else if (modelChanged) this.currentModelCapacity = undefined;
      changed = true;
      this.emitBridgeEvent('MODEL_CHANGED');
    }
    const nextDomSubagentRunning = Boolean(isSubagentRunning);
    const nextDomSubagentCount = Math.max(0, Number(runningSubagentCount) || 0);
    const nextDomStreaming = Boolean(isStreaming);
    const nextDomPhase = !nextDomStreaming
      ? 'idle'
      : activityPhase === 'executing'
      ? 'executing'
      : 'generating';
    const nextChildIds = Array.isArray(childConversationIds)
      ? [...new Set(childConversationIds.filter(Boolean))]
      : this.childConversationIds;
    const childIdsChanged = nextChildIds.join(',') !== this.childConversationIds.join(',');

    if (
      nextDomStreaming !== this.domIsStreaming ||
      nextDomPhase !== this.domActivityPhase ||
      nextDomSubagentRunning !== this.domIsSubagentRunning ||
      nextDomSubagentCount !== this.domRunningSubagentCount ||
      childIdsChanged
    ) {
      const wasActiveWork = this.hasActiveWork;
      if (
        (this.domActivityPhase === 'executing' && nextDomPhase === 'generating') ||
        nextDomPhase === 'idle'
      ) {
        this.backendActivityPhase = null;
      }
      if (this.domIsStreaming && !nextDomStreaming) {
        this.backendIsStreaming = false;
      }
      this.domIsStreaming = nextDomStreaming;
      this.domActivityPhase = nextDomPhase;
      this.domIsSubagentRunning = nextDomSubagentRunning;
      this.domRunningSubagentCount = nextDomSubagentCount;
      this.childConversationIds = nextChildIds;
      this.isSubagentRunning = Boolean(this.domIsSubagentRunning || this.backendIsSubagentRunning);
      this.runningSubagentCount = Math.max(
        this.domRunningSubagentCount,
        this.backendRunningSubagentCount
      );
      const subagentBackendStreaming = this.isSubagentBackendStreaming(this.lastMetrics);
      this.isStreaming = Boolean(this.domIsStreaming || subagentBackendStreaming);
      this.hasActiveWork = Boolean(
        this.isStreaming ||
          this.isSubagentRunning ||
          (this.lastMetrics?.session?.activeModelStepCount || 0) > 0 ||
          (this.lastMetrics?.session?.activeToolStepCount || 0) > 0
      );
      if (!wasActiveWork && this.hasActiveWork) {
        this.streamResumeAtMs = Date.now();
        if (this.lastMetrics?.availability === 'remote_unbridged') {
          this.turnHighWaterMark = null;
          this.frozenClockSnapshot = null;
        }
      }
      this.activityPhase = this.computeMergedActivityPhase();
      if (!this.hasActiveWork) {
        this.freezeActiveClocksForPendingIdle();
        this.syncStreamingClass();
      } else {
        this.syncStreamingClass();
        if (this.lastMetrics && this.shadow) {
          this.applyMetricsToDom({
            ...this.lastMetrics,
            isStreaming: this.hasActiveWork,
            activityPhase: this.activityPhase,
            isSubagentRunning: this.isSubagentRunning,
            runningSubagentCount: this.runningSubagentCount,
          });
        }
      }
      changed = true;
      this.emitBridgeEvent('STREAMING_CHANGED');
    }
    return changed;
  }

  isSameOrMigratedFirstTurn(hw, turns, refSec = null) {
    return Boolean(
      hw &&
        (hw.turns === turns ||
          (hw.turns === 0 && turns === 1 && (refSec === null || refSec < hw.seconds)))
    );
  }

  isAwaitingPostIdleNewTurnFlush(metrics) {
    const s = metrics?.session || {};
    const rawTurns = isRawNumber(s.turns) ? s.turns : 0;
    const rawSteps = isRawNumber(s.steps) ? s.steps : 0;
    const settled = this.settledIdleTurnState;
    return Boolean(
      this.domIsStreaming &&
        !this.isSubagentRunning &&
        !metrics?.isSubagentRunning &&
        settled &&
        settled.convId === this.currentConvId &&
        settled.turns === rawTurns &&
        rawSteps <= settled.steps &&
        !(Number(s.activeModelStepCount) > 0) &&
        !(Number(s.activeToolStepCount) > 0)
    );
  }

  /**
   * 当 DOM 先检测到轮次暂停/结束而后端权威包尚未抵达时，停止本地定时器并冻结当前高水位，
   * 避免立刻用过期的 this.lastMetrics 刷旧 DOM，等待真实 updateMetrics 到来后再统一校准或恢复。
   */
  freezeActiveClocksForPendingIdle() {
    const nowMs = Date.now();
    const s = this.lastMetrics?.session || {};
    const turns = this.turnClockAnchor?.turns ?? (isRawNumber(s.turns) ? s.turns : 0);
    const cappedBackendSec = isRawNumber(s.currentTurnDurationSeconds)
      ? this.capPostIdleBackendTurnSec(s.currentTurnDurationSeconds, this.lastMetrics, nowMs)
      : 0;
    const matchesTurn = (hw) => this.isSameOrMigratedFirstTurn(hw, turns, cappedBackendSec);
    const hasSubagent = Boolean(
      this.isSubagentRunning ||
      this.lastMetrics?.isSubagentRunning ||
      (isRawNumber(s.runningSubagentCount) && s.runningSubagentCount > 0) ||
      (matchesTurn(this.turnHighWaterMark) && this.turnHighWaterMark.hasSubagent)
    );
    const liveTurnSec = this.turnClockAnchor
      ? Math.max(
          this.turnClockAnchor.baseSeconds + (nowMs - this.turnClockAnchor.anchorMs) / 1000,
          matchesTurn(this.turnHighWaterMark) ? (this.turnHighWaterMark.seconds ?? 0) : 0
        )
      : Math.max(
          this.frozenClockSnapshot?.convId === this.currentConvId ? (this.frozenClockSnapshot?.turnSeconds ?? 0) : 0,
          cappedBackendSec
        );
    const liveModelSec = this.modelClockAnchor
      ? this.getLiveClockSeconds(this.modelClockAnchor, nowMs)
      : Math.max(
          this.frozenClockSnapshot?.convId === this.currentConvId ? (this.frozenClockSnapshot?.modelSeconds ?? 0) : 0,
          (isRawNumber(s.modelDurationSeconds) ? s.modelDurationSeconds : 0) +
            (isRawNumber(s.inFlightModelDurationSeconds) ? s.inFlightModelDurationSeconds : 0)
        );
    const liveToolSec = this.toolClockAnchor
      ? this.getLiveClockSeconds(this.toolClockAnchor, nowMs)
      : Math.max(
          this.frozenClockSnapshot?.convId === this.currentConvId ? (this.frozenClockSnapshot?.toolSeconds ?? 0) : 0,
          (isRawNumber(s.toolDurationSeconds) ? s.toolDurationSeconds : 0) +
            (isRawNumber(s.inFlightToolDurationSeconds) ? s.inFlightToolDurationSeconds : 0)
        );
    this.frozenClockSnapshot = {
      convId: this.currentConvId,
      turns,
      turnSeconds: Math.max(0, liveTurnSec),
      modelSeconds: Math.max(0, liveModelSec),
      toolSeconds: Math.max(0, liveToolSec),
      hasSubagent,
    };
    if (this.turnClockAnchor || this.turnHighWaterMark) {
      const prevHigh = matchesTurn(this.turnHighWaterMark) ? this.turnHighWaterMark.seconds : 0;
      this.turnHighWaterMark = {
        turns,
        seconds: Math.max(liveTurnSec, prevHigh),
        hasSubagent,
      };
    }
    this.stopTurnClock();
  }

  requestRefresh(options = {}) {
    if (!this.currentConvId) return;
    if (options && options.bumpRevision === true) {
      this.sessionRevision = this.allocateRevision
        ? Math.max(this.sessionRevision + 1, this.allocateRevision())
        : this.sessionRevision + 1;
      this.lastMetricsSequence = 0;
      this.lastAppliedUpdatedAt = 0;
    }
    this.emitBridgeEvent('REQUEST_REFRESH');
  }

  emitBridgeEvent(type) {
    if (!this.currentConvId) return;
    const payload = {
      type,
      conversationId: this.currentConvId,
      cascadeId: this.cascadeId,
      paneSlotId: this.paneSlotId,
      paneKind: this.paneKind,
      sessionRevision: this.sessionRevision,
      modelId: this.currentModelId,
      ...(typeof this.currentModelCapacity === 'number' && this.currentModelCapacity > 0
        ? { modelCapacity: this.currentModelCapacity }
        : {}),
      isStreaming: this.domIsStreaming,
      activityPhase: this.domActivityPhase,
      isSubagentRunning: this.domIsSubagentRunning,
      runningSubagentCount: this.domRunningSubagentCount,
      ...(this.childConversationIds.length > 0
        ? { childConversationIds: this.childConversationIds }
        : {}),
      timestamp: Date.now(),
    };
    if (this.onBridgeEvent) {
      try {
        this.onBridgeEvent(payload);
      } catch {}
    }
    if (typeof globalThis.__gravityboxHudBridge === 'function') {
      try {
        globalThis.__gravityboxHudBridge(JSON.stringify(payload));
      } catch {}
    }
  }

  updateMetrics(metrics) {
    if (!metrics || typeof metrics !== 'object') return false;
    // 三重防线校验：杜绝跨会话污染、同会话跨分栏串扰、A->B->A 迟到包及同代乱序旧包回退
    if (metrics.conversationId !== this.currentConvId) {
      return false;
    }
    if (metrics.paneSlotId && this.paneSlotId && metrics.paneSlotId !== this.paneSlotId) {
      return false;
    }
    if (typeof metrics.sessionRevision === 'number') {
      if (this.sessionRevision > 0 && metrics.sessionRevision !== this.sessionRevision) {
        return false;
      }
      if (metrics.sessionRevision < this.sessionRevision) {
        return false;
      }
    }
    if (typeof metrics.metricsSequence === 'number' && metrics.metricsSequence > 0) {
      if (metrics.metricsSequence <= this.lastMetricsSequence) {
        return false;
      }
      this.lastMetricsSequence = metrics.metricsSequence;
    } else if (
      typeof metrics.updatedAt === 'number' &&
      this.lastAppliedUpdatedAt > 0 &&
      metrics.sessionRevision === this.lastMetrics?.sessionRevision &&
      metrics.updatedAt < this.lastAppliedUpdatedAt
    ) {
      return false;
    }
    if (typeof metrics.updatedAt === 'number' && metrics.updatedAt > 0) {
      this.lastAppliedUpdatedAt = metrics.updatedAt;
    }
    this.backendIsSubagentRunning = Boolean(metrics.isSubagentRunning);
    this.backendRunningSubagentCount = Math.max(
      0,
      Number(metrics.runningSubagentCount) || 0,
      Number(metrics.session?.runningSubagentCount) || 0
    );
    const mergedSubagentRunning = Boolean(
      this.backendIsSubagentRunning || this.domIsSubagentRunning
    );
    const mergedSubagentCount = Math.max(
      this.backendRunningSubagentCount,
      this.domRunningSubagentCount
    );
    this.isSubagentRunning = mergedSubagentRunning;
    this.runningSubagentCount = mergedSubagentCount;
    const activeModelSteps = Math.max(0, Number(metrics.session?.activeModelStepCount) || 0);
    const activeToolSteps = Math.max(0, Number(metrics.session?.activeToolStepCount) || 0);
    this.backendIsStreaming = Boolean(metrics.isStreaming);
    const subagentBackendStreaming = this.isSubagentBackendStreaming(metrics);
    this.isStreaming = Boolean(this.domIsStreaming || subagentBackendStreaming);
    this.hasActiveWork = Boolean(
      this.isStreaming ||
        mergedSubagentRunning ||
        this.backendIsStreaming ||
        activeModelSteps > 0 ||
        activeToolSteps > 0
    );
    this.backendActivityPhase =
      metrics.activityPhase === 'generating' ||
      metrics.activityPhase === 'executing' ||
      metrics.activityPhase === 'idle'
        ? metrics.activityPhase
        : null;
    this.activityPhase = this.computeMergedActivityPhase(metrics);
    this.lastMetrics = {
      ...metrics,
      isStreaming: this.isStreaming,
      activityPhase: this.activityPhase,
      isSubagentRunning: mergedSubagentRunning,
      runningSubagentCount: mergedSubagentCount,
    };
    if (!this.hasActiveWork) {
      // 收到后端权威 idle 确认包，解除挂起冻结态，停用旧轮跑表并按子智能体防闪烁/无时间戳中止兜底规则精准收敛
      this.stopTurnClock();
      this.frozenClockSnapshot = null;
      this.streamResumeAtMs = 0;
      if (
        metrics.availability !== 'cached' &&
        metrics.availability !== 'remote_stale' &&
        metrics.availability !== 'remote_unbridged' &&
        isRawNumber(metrics.session?.currentTurnDurationSeconds)
      ) {
        const rawTurns = isRawNumber(metrics.session?.turns) ? metrics.session.turns : 0;
        const rawSteps = isRawNumber(metrics.session?.steps) ? metrics.session.steps : 0;
        const rawBackendSec = Math.max(0, metrics.session.currentTurnDurationSeconds);
        if (
          this.turnHighWaterMark &&
          this.turnHighWaterMark.turns === 0 &&
          rawTurns === 1 &&
          rawBackendSec < this.turnHighWaterMark.seconds
        ) {
          this.turnHighWaterMark.turns = 1;
        }
        const prevSettled =
          this.settledIdleTurnState &&
          this.settledIdleTurnState.convId === this.currentConvId &&
          this.settledIdleTurnState.turns === rawTurns &&
          rawSteps <= this.settledIdleTurnState.steps
            ? this.settledIdleTurnState
            : null;
        if (prevSettled) {
          const isLateAbortedZeroResolution =
            metrics.session?.turnAborted === true &&
            prevSettled.hadAbortedZeroFallback === true &&
            metrics.session?.turnAbortedMissingEnd !== true &&
            rawBackendSec > 0;
          const floorSec = isLateAbortedZeroResolution
            ? rawBackendSec
            : Math.max(rawBackendSec, prevSettled.floorSec);
          const keepSubagentFloor = Boolean(
            prevSettled.hasSubagent && floorSec > rawBackendSec + 1e-6
          );
          const keepAbortedFloor = Boolean(
            metrics.session?.turnAborted === true &&
              (rawBackendSec <= 0 || metrics.session?.turnAbortedMissingEnd === true) &&
              floorSec > rawBackendSec + 1e-6
          );
          this.turnHighWaterMark = keepSubagentFloor || keepAbortedFloor
            ? { turns: rawTurns, seconds: floorSec, hasSubagent: keepSubagentFloor }
            : null;
          this.settledIdleTurnState = {
            convId: this.currentConvId,
            turns: rawTurns,
            steps: Math.max(prevSettled.steps, rawSteps),
            floorSec,
            hasSubagent: keepSubagentFloor,
            hadAbortedZeroFallback: keepAbortedFloor,
          };
        } else {
          const hwMatchesTurn =
            this.turnHighWaterMark && this.turnHighWaterMark.turns === rawTurns;
          const isTrueSubagentGap = Boolean(
            hwMatchesTurn &&
              this.turnHighWaterMark.hasSubagent &&
              rawBackendSec < this.turnHighWaterMark.seconds - 1e-6 &&
              metrics.session?.hasSubagentInTurn !== true &&
              (Number(metrics.session?.subagentCount) || 0) <= 1 &&
              (Number(metrics.session?.turns) || 0) === 0
          );
          const keepAbortedZeroFallback = Boolean(
            hwMatchesTurn &&
              metrics.session?.turnAborted === true &&
              (rawBackendSec <= 0 ||
                (metrics.session?.turnAbortedMissingEnd === true &&
                  rawBackendSec < this.turnHighWaterMark.seconds - 1e-6))
          );
          if (!mergedSubagentRunning && !isTrueSubagentGap && !keepAbortedZeroFallback) {
            this.turnHighWaterMark = null;
          }
          const floorSec =
            (isTrueSubagentGap || keepAbortedZeroFallback) && this.turnHighWaterMark
              ? Math.max(rawBackendSec, this.turnHighWaterMark.seconds)
              : rawBackendSec;
          this.settledIdleTurnState = {
            convId: this.currentConvId,
            turns: rawTurns,
            steps: rawSteps,
            floorSec,
            hasSubagent: isTrueSubagentGap,
            hadAbortedZeroFallback: keepAbortedZeroFallback,
          };
        }
      }
    }
    this.applyMetricsToDom(this.lastMetrics);
    return true;
  }

  t(key, params) {
    return hudText(this.locale, key, params);
  }

  setLanguage(mode) {
    const resolved = normalizeHudLocale(mode);
    const next = resolved === 'zh-Hans' ? 'zh' : resolved;
    if (this.locale === resolved && this.languageMode === next) return;
    this.locale = resolved;
    this.languageMode = next;
    if (this.lastMetrics && this.shadow) {
      this.applyMetricsToDom(this.lastMetrics);
    }
  }

  computeThemeSignature() {
    if (typeof document === 'undefined') return '';
    const bodyCls = document.body?.className || '';
    const htmlCls = document.documentElement?.className || '';
    const htmlStyle = document.documentElement?.getAttribute?.('style') || '';
    const bodyDataTheme = document.body?.getAttribute?.('data-theme') || '';
    const htmlDataTheme = document.documentElement?.getAttribute?.('data-theme') || '';
    const sysDark =
      typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)')?.matches
        ? '1'
        : '0';
    return `${bodyCls}|${htmlCls}|${htmlStyle}|${bodyDataTheme}|${htmlDataTheme}|${sysDark}`;
  }

  syncTheme() {
    if (!this.host || typeof document === 'undefined') return;
    const bodyCls = document.body?.classList;
    const htmlCls = document.documentElement?.classList;
    const bodyDataTheme = (document.body?.getAttribute?.('data-theme') || '').toLowerCase();
    const htmlDataTheme = (document.documentElement?.getAttribute?.('data-theme') || '').toLowerCase();

    const explicitDark =
      bodyCls?.contains('theme-dark') ||
      bodyCls?.contains('dark') ||
      bodyCls?.contains('dark-theme') ||
      bodyCls?.contains('vs-dark') ||
      htmlCls?.contains('dark') ||
      htmlCls?.contains('theme-dark') ||
      bodyDataTheme.includes('dark') ||
      htmlDataTheme.includes('dark');

    const explicitLight =
      bodyCls?.contains('theme-light') ||
      bodyCls?.contains('light') ||
      bodyCls?.contains('light-theme') ||
      htmlCls?.contains('light') ||
      htmlCls?.contains('theme-light') ||
      bodyDataTheme.includes('light') ||
      htmlDataTheme.includes('light');

    let isDark = false;
    if (explicitDark) {
      isDark = true;
    } else if (explicitLight) {
      isDark = false;
    } else {
      let resolvedByComputed = false;
      if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
        try {
          const csScheme = (window.getComputedStyle(document.documentElement).colorScheme || '').toLowerCase();
          if (csScheme === 'dark') {
            isDark = true;
            resolvedByComputed = true;
          } else if (csScheme === 'light') {
            isDark = false;
            resolvedByComputed = true;
          } else if (document.body) {
            const bg = window.getComputedStyle(document.body).backgroundColor || '';
            const rgb = bg.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
            if (rgb) {
              const lum = 0.2126 * Number(rgb[1]) + 0.7152 * Number(rgb[2]) + 0.0722 * Number(rgb[3]);
              if (lum > 0 || !bg.includes('0, 0, 0, 0')) {
                isDark = lum < 128;
                resolvedByComputed = true;
              }
            }
          }
        } catch {}
      }
      if (!resolvedByComputed) {
        isDark = Boolean(
          typeof window !== 'undefined' &&
            window.matchMedia?.('(prefers-color-scheme: dark)')?.matches
        );
      }
    }

    this.isDarkTheme = isDark;
    if (isDark) {
      if (this.host.getAttribute('data-theme') !== 'dark') {
        this.host.setAttribute('data-theme', 'dark');
      }
    } else if (this.host.hasAttribute('data-theme')) {
      this.host.removeAttribute('data-theme');
    }
    const meterFillEl = this.getShadowEl('#hud-meter-fill');
    if (meterFillEl && this.lastMetrics?.context?.hasUsageData) {
      const ratioClamped = Math.min(1.0, Math.max(0, Number(this.lastMetrics.context.usedRatio) || 0));
      meterFillEl.setAttribute('fill', computeContextProgressColor(ratioClamped, isDark));
    }
    const stagesListEl = this.getShadowEl('#hud-ctx-stages-list');
    const stageBars = stagesListEl?.querySelectorAll?.('.hud-stage-bar-fill');
    if (stageBars && typeof stageBars.forEach === 'function') {
      stageBars.forEach((bar) => {
        const rawRatio = Number(bar.getAttribute?.('data-stage-ratio'));
        const ratioClamped = Number.isFinite(rawRatio) ? Math.min(1.0, Math.max(0, rawRatio)) : 0;
        if (bar.style) {
          bar.style.backgroundColor = computeContextProgressColor(ratioClamped, isDark);
        }
      });
    }
  }

  syncHorizontalBounds(targetComposer = this.targetComposer) {
    if (!targetComposer) return 0;
    const composerRect =
      typeof targetComposer.getBoundingClientRect === 'function'
        ? targetComposer.getBoundingClientRect()
        : null;
    const rawWidth = composerRect?.width ?? targetComposer.clientWidth ?? 0;
    const boundsFn =
      typeof resolveVisibleHorizontalBounds === 'function'
        ? resolveVisibleHorizontalBounds
        : globalThis.__GRAVITYBOX_HUD_POPOVER__?.resolveVisibleHorizontalBounds;
    if (!this.host || !composerRect || !(rawWidth > 0) || typeof boundsFn !== 'function') {
      return rawWidth;
    }
    const bounds = boundsFn(targetComposer);
    const visibleLeft = Math.max(composerRect.left, bounds.left);
    const visibleRight = Math.min(composerRect.right, bounds.right);
    const obstructedRight = composerRect.right - visibleRight > 1;
    const obstructedLeft = visibleLeft - composerRect.left > 1;
    if (visibleRight > visibleLeft && (obstructedRight || obstructedLeft)) {
      const clampedWidth = Math.max(110, Math.floor(visibleRight - visibleLeft));
      this.host.style.maxWidth = `${clampedWidth}px`;
      this.host.style.alignSelf = obstructedRight && !obstructedLeft ? 'flex-start' : 'center';
      this.host.style.marginLeft = obstructedLeft ? `${Math.round(visibleLeft - composerRect.left)}px` : '0px';
      return clampedWidth;
    }
    if (this.host.style.maxWidth !== '100%') this.host.style.maxWidth = '100%';
    if (this.host.style.alignSelf) this.host.style.alignSelf = '';
    if (this.host.style.marginLeft && this.host.style.marginLeft !== '0px') this.host.style.marginLeft = '0px';
    return rawWidth;
  }

  syncVerticalCentering() {
    if (!this.host || !this.targetComposer) return;
    // Own only our box. Never rewrite the host application's ancestor padding.
    this.host.style.marginTop = '4px';
    this.host.style.marginBottom = '4px';
    this.syncHorizontalBounds(this.targetComposer);
    const win = typeof window !== 'undefined' ? window : globalThis.window;
    if (typeof this.host.getBoundingClientRect !== 'function') return;
    const composer = this.targetComposer.getBoundingClientRect?.();
    const rect = this.host.getBoundingClientRect();
    const vh = Number(win?.innerHeight) || 0;
    // Align the normal bottom-docked composer; centred welcome-page composers
    // keep their natural layout instead of being moved towards the viewport edge.
    if (composer && vh && composer.top > vh / 2 && rect.height > 0) {
      const topGap = rect.top - composer.bottom;
      const bottomGap = vh - rect.bottom;
      if (bottomGap >= 0 && bottomGap < 48) {
        const previous = parseFloat(this.host.style.getPropertyValue?.('--hud-offset') || '0') || 0;
        const offset = Math.max(-8, Math.min(8, previous + (bottomGap - topGap) / 2));
        if (Math.abs(offset) >= 0.5) {
          this.host.style.setProperty?.('--hud-offset', `${offset}px`);
          this.host.style.translate = `0 var(--hud-offset, 0px)`;
          return;
        }
      }
    }
    this.host.style.setProperty?.('--hud-offset', '0px');
    this.host.style.translate = 'none';
  }

  mount(targetComposer) {
    if (!targetComposer) return;
    const isRemount = Boolean(this.host || this.shadow);
    const preservedClocks =
      this.hasActiveWork &&
      (this.turnClockAnchor || this.modelClockAnchor || this.toolClockAnchor)
        ? {
            turnClockAnchor: this.turnClockAnchor ? { ...this.turnClockAnchor } : null,
            modelClockAnchor: this.modelClockAnchor ? { ...this.modelClockAnchor } : null,
            toolClockAnchor: this.toolClockAnchor ? { ...this.toolClockAnchor } : null,
          }
        : null;
    this.cleanupListeners();
    if (preservedClocks) {
      this.turnClockAnchor = preservedClocks.turnClockAnchor;
      this.modelClockAnchor = preservedClocks.modelClockAnchor;
      this.toolClockAnchor = preservedClocks.toolClockAnchor;
    }
    this.targetComposer = targetComposer;

    const doc = targetComposer.ownerDocument || (typeof document !== 'undefined' ? document : null);
    if (!doc) return;

    if (this.host) {
      try {
        this.host.remove?.();
      } catch {}
      this.host = null;
    }

    this.host = doc.createElement('div');
    this.host.id = this.isPrimaryPane
      ? '__gravitybox_hud_host__'
      : `__gravitybox_hud_host_${this.cascadeId}__`;
    this.host.className = '__gravitybox_hud_host__';
    this.host.setAttribute('data-gravitybox-protect', 'true');
    this.host.setAttribute('data-gravitybox-hud', 'v2');
    this.host.setAttribute('data-cascade-id', this.cascadeId);

    Object.assign(this.host.style, {
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
      width: '100%',
      maxWidth: '100%',
      minWidth: '0',
      height: '24px',
      marginTop: '4px',
      marginBottom: '4px',
      pointerEvents: 'none',
      userSelect: 'none',
      transform: 'none',
      filter: 'none',
      boxSizing: 'border-box',
    });

    this.syncTheme();

    this.resetDomCache();
    this.shadow = this.host.attachShadow({ mode: 'open' });
    const stylesCss =
      typeof HUD_STYLES_CSS === 'string'
        ? HUD_STYLES_CSS
        : globalThis.__GRAVITYBOX_HUD_STYLES_CSS__ || '';
    this.shadow.innerHTML = `<style>${stylesCss}</style>${this.buildHudHtml()}`;
    this.domRefsShadow = this.shadow;

    if (typeof targetComposer.insertAdjacentElement === 'function') {
      targetComposer.insertAdjacentElement('afterend', this.host);
    } else if (targetComposer.parentNode) {
      targetComposer.parentNode.appendChild(this.host);
    }
    this.hostMountedInDom = Boolean(this.host.isConnected);
    this.lastThemeSig = this.computeThemeSignature();

    this.syncVerticalCentering();
    const initialRect =
      typeof targetComposer.getBoundingClientRect === 'function'
        ? targetComposer.getBoundingClientRect()
        : null;
    const initialWidth = this.syncHorizontalBounds(targetComposer);
    const vh =
      Number((typeof window !== 'undefined' ? window : globalThis.window)?.innerHeight) || 0;
    this.lastCenteringSig = `${Math.round(initialWidth)}:${Math.round(initialRect?.top ?? 0)}:${Math.round(initialRect?.bottom ?? 0)}:${vh}`;
    if (initialWidth > 0) {
      this.handleContainerResize(initialWidth);
    }
    this.bindEvents(targetComposer);
    if (this.lastMetrics) {
      this.applyMetricsToDom(this.lastMetrics);
    }
    if (isRemount && preservedClocks && this.currentConvId) {
      this.requestRefresh();
    }
  }

  reconcile(targetComposer) {
    if (!targetComposer) return;
    if (!this.host || !this.host.isConnected) {
      this.mount(targetComposer);
      return;
    }
    const composerChanged = this.targetComposer !== targetComposer;
    let moved = composerChanged;
    this.targetComposer = targetComposer;
    if (this.host.previousElementSibling !== targetComposer) {
      if (typeof targetComposer.insertAdjacentElement === 'function') {
        targetComposer.insertAdjacentElement('afterend', this.host);
        moved = true;
      }
    }
    if (composerChanged) {
      this.rebindResizeObserver(targetComposer);
    }
    this.hostMountedInDom = Boolean(this.host.isConnected);
    const rect =
      typeof targetComposer.getBoundingClientRect === 'function'
        ? targetComposer.getBoundingClientRect()
        : null;
    const width = this.syncHorizontalBounds(targetComposer);
    const vh =
      Number((typeof window !== 'undefined' ? window : globalThis.window)?.innerHeight) || 0;
    const centerSig = `${Math.round(width)}:${Math.round(rect?.top ?? 0)}:${Math.round(rect?.bottom ?? 0)}:${vh}`;
    const widthChanged = width > 0 && Math.abs(width - this.lastReconcileWidth) >= 1;
    if (moved || widthChanged || this.lastCenteringSig !== centerSig) {
      this.lastCenteringSig = centerSig;
      this.syncVerticalCentering();
    }
    const themeSig = this.computeThemeSignature();
    if (moved || themeSig !== this.lastThemeSig) {
      this.lastThemeSig = themeSig;
      this.syncTheme();
    }
    if (width > 0 && (moved || widthChanged)) {
      this.handleContainerResize(width);
    }
  }

  buildHudHtml() {
    const zeroDur = durationText(0, this.locale);
    return `
      <div class="hud-container" id="hud-toolbar" role="toolbar" aria-label="${this.t('toolbarLabel')}">
        <div class="hud-dock-surface">
          <!-- 分段 1: 会话与执行耗时 (移除原生 title 提示，杜绝遮挡上浮卡片) -->
          <button type="button" class="capsule capsule-session" data-capsule-id="session" aria-haspopup="dialog" aria-expanded="false" aria-label="${this.t('capsuleSessionLabel')}">
            <span class="hud-status-dot" aria-hidden="true"></span>
            <span class="capsule-text" id="hud-txt-session">
              <span class="hud-turns">${this.t('turnsUnit', { count: 0 })}</span><span class="hud-turn-dur"><span class="hud-turn-dot">· </span><span class="hud-turn-text">${this.t('turnCompactDefault')}</span></span><span class="hud-speed"> · —</span><span class="hud-subagent-tag" hidden><span class="hud-subagent-sep" aria-hidden="true"></span><svg class="hud-subagent-icon" viewBox="0 0 12 12" aria-hidden="true"><circle cx="3" cy="3" r="1.5" fill="currentColor"/><circle cx="9.2" cy="3.8" r="1.35" fill="currentColor"/><circle cx="9.2" cy="8.8" r="1.35" fill="currentColor"/><path d="M4.3 3.2H5.8C6.5 3.2 7 3.7 7 4.4M5.8 3.2V7.6C5.8 8.3 6.3 8.8 7 8.8H7.8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="hud-subagent-count"></span></span>
            </span>
          </button>

          <span class="hud-seg-sep" aria-hidden="true"></span>

          <!-- 分段 2: 累计 Token 账本 (移除原生 title 提示，杜绝遮挡上浮卡片) -->
          <button type="button" class="capsule capsule-tokens" data-capsule-id="tokens" aria-haspopup="dialog" aria-expanded="false" aria-label="${this.t('capsuleTokensLabel')}">
            <svg class="capsule-icon" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M8 1.2L9.9 6.1L14.8 8L9.9 9.9L8 14.8L6.1 9.9L1.2 8L6.1 6.1L8 1.2Z" fill="currentColor"/>
            </svg>
            <span class="capsule-text" id="hud-txt-tokens">
              <span class="hud-tok-total">0 tok</span><span class="hud-tok-cache"><span class="hud-cache-dot"> · </span><span class="hud-cache-prefix">${this.t('cachePrefix')}</span><span class="hud-cache-label">${this.t('cacheLabel')}</span><span class="hud-cache-space"> </span><span class="hud-cache-val">0%</span></span>
            </span>
          </button>

          <span class="hud-seg-sep" aria-hidden="true"></span>

          <!-- 分段 3: 当前上下文实况 (左侧显示当前展示模型的上下文压缩次数徽章，0 次隐藏，>=1 次显示；多模型/Orchestrator 时显示模型短标) -->
          <button type="button" class="capsule capsule-context" data-capsule-id="context" aria-haspopup="dialog" aria-expanded="false" aria-label="${this.t('capsuleContextLabel')}">
            <span class="hud-compaction-badge" id="hud-compaction-badge" hidden></span>
            <span class="hud-ctx-model-tag" id="hud-ctx-model-tag" hidden><span class="hud-ctx-model-full" id="hud-ctx-model-full"></span><span class="hud-ctx-model-short" id="hud-ctx-model-short"></span></span>
            <svg class="capsule-donut" viewBox="0 0 56 8" preserveAspectRatio="none" aria-hidden="true">
              <rect x="0.5" y="1.5" width="55" height="5" rx="2.5" fill="var(--hud-progress-track)" stroke="var(--hud-divider)" stroke-width="0.6"/>
              <rect id="hud-meter-fill" x="1" y="2" width="0" height="4" rx="2" fill="var(--hud-seg-sys-color)"/>
            </svg>
            <span class="capsule-text" id="hud-txt-context">0%</span>
          </button>
        </div>
      </div>

      <!-- 向上展开详情卡片 1: 会话统计 -->
      <div class="hud-popover" id="hud-popover-session" data-popover-id="session" popover="manual" role="dialog" aria-label="${this.t('popoverSessionAria')}" hidden>
        <div class="hud-popover-inner">
          <div class="hud-popover-header">
            <span class="hud-popover-title">
              <span class="hud-status-dot" style="margin-right:2px" aria-hidden="true"></span>
              <span id="pop-session-title">${this.t('popSessionTitle')}</span>
            </span>
            <span class="hud-popover-badge" id="pop-session-badge">${this.t('popSessionBadge', { turns: 0, steps: 0 })}</span>
          </div>
          <div class="hud-popover-divider"></div>
          <div class="hud-popover-grid">
            <div class="hud-popover-row">
              <span class="hud-popover-label" id="lbl-model-dur">${this.t('lblModelDur')}</span>
              <span class="hud-popover-val" id="val-model-dur">${zeroDur}</span>
            </div>
            <div class="hud-popover-row">
              <span class="hud-popover-label" id="lbl-tool-dur">${this.t('lblToolDur')}</span>
              <span class="hud-popover-val" id="val-tool-dur">${zeroDur}</span>
            </div>
            <div class="hud-popover-row">
              <span class="hud-popover-label" id="lbl-ttft">${this.t('lblTtft')}</span>
              <span class="hud-popover-val" id="val-ttft">—</span>
            </div>
            <div class="hud-popover-row">
              <span class="hud-popover-label" id="lbl-tps">${this.t('lblTps')}</span>
              <span class="hud-popover-val" id="val-tps">—</span>
            </div>
          </div>
          <div class="hud-popover-divider-dashed" aria-hidden="true"></div>
          <div class="hud-popover-grid">
            <div class="hud-popover-row" id="row-turn-dur">
              <span class="hud-popover-label" id="lbl-turn-dur">${this.t('lblTurnDur')}</span>
              <span class="hud-popover-val" id="val-turn-dur">${zeroDur}</span>
            </div>
            <div class="hud-popover-row" id="row-ttft-latest">
              <span class="hud-popover-label" id="lbl-ttft-latest">${this.t('lblTtftLatest')}</span>
              <span class="hud-popover-val" id="val-ttft-latest">—</span>
            </div>
            <div class="hud-popover-row" id="row-tps-latest">
              <span class="hud-popover-label" id="lbl-tps-latest">${this.t('lblTpsLatest')}</span>
              <span class="hud-popover-val" id="val-tps-latest">—</span>
            </div>
            <div class="hud-popover-row" id="row-subagent-status" hidden>
              <span class="hud-popover-label" id="lbl-subagent-status">${this.t('lblSubagentStatus')}</span>
              <span class="hud-popover-val" id="val-subagent-status">—</span>
            </div>
          </div>
          <div class="hud-popover-status-note" id="hud-session-status-note" hidden></div>
        </div>
        <div class="hud-popover-arrow" id="arrow-session">
          <svg viewBox="0 0 14 6" aria-hidden="true">
            <path d="M0 0 L7 6 L14 0 Z" fill="var(--hud-popover-bg)" stroke="none"/>
            <path d="M0.5 0 L7 5.5 L13.5 0" fill="none" stroke="var(--hud-popover-border)" stroke-width="1" stroke-linejoin="round"/>
          </svg>
        </div>
      </div>

      <!-- 向上展开详情卡片 2: Token 用量 -->
      <div class="hud-popover" id="hud-popover-tokens" data-popover-id="tokens" popover="manual" role="dialog" aria-label="${this.t('popoverTokensAria')}" hidden>
        <div class="hud-popover-inner">
          <div class="hud-popover-header">
            <span class="hud-popover-title">
              <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" style="color:var(--hud-accent-blue)">
                <path d="M8 1.2L9.9 6.1L14.8 8L9.9 9.9L8 14.8L6.1 9.9L1.2 8L6.1 6.1L8 1.2Z" fill="currentColor"/>
              </svg>
              <span id="pop-tokens-title">${this.t('popTokensTitle')}</span>
            </span>
            <span class="hud-popover-badge" id="pop-tokens-badge">0 tok</span>
          </div>
          <div class="hud-popover-divider"></div>
          <div class="hud-popover-grid">
            <div class="hud-popover-row">
              <span class="hud-popover-label" id="lbl-cache-hit">${this.t('lblCacheHit')}</span>
              <span class="hud-popover-val" id="val-cache-hit">0%</span>
            </div>
            <div class="hud-popover-row">
              <span class="hud-popover-label" id="lbl-uncached-in">${this.t('lblUncachedIn')}</span>
              <span class="hud-popover-val" id="val-uncached-in">0 tok</span>
            </div>
            <div class="hud-popover-row">
              <span class="hud-popover-label" id="lbl-cached-read">${this.t('lblCachedRead')}</span>
              <span class="hud-popover-val" id="val-cached-read">0 tok</span>
            </div>
            <div class="hud-popover-row" id="row-cache-write" hidden>
              <span class="hud-popover-label" id="lbl-cache-write">${this.t('lblCacheWrite')}</span>
              <span class="hud-popover-val" id="val-cache-write">0 tok</span>
            </div>
            <div class="hud-popover-row">
              <span class="hud-popover-label" id="lbl-output-tok">${this.t('lblOutputTok')}</span>
              <span class="hud-popover-val" id="val-output-tok">0 tok</span>
            </div>
            <div class="hud-popover-row" id="row-reasoning-tok" hidden>
              <span class="hud-popover-label" id="lbl-reasoning-tok">${this.t('lblReasoningTok')}</span>
              <span class="hud-popover-val" id="val-reasoning-tok">0 / 0 tok</span>
            </div>
          </div>
          <div class="hud-popover-divider-dashed" aria-hidden="true"></div>
          <div class="hud-popover-grid">
            <div class="hud-popover-row" id="row-est-cost">
              <span class="hud-popover-label" id="lbl-est-cost">${this.t('lblEstCost')}</span>
              <span class="hud-popover-val" id="val-est-cost">—</span>
            </div>
            <div class="hud-popover-row" id="row-cache-saved">
              <span class="hud-popover-label" id="lbl-cache-saved">${this.t('lblCacheSaved')}</span>
              <span class="hud-popover-val" id="val-cache-saved">—</span>
            </div>
          </div>
        </div>
        <div class="hud-popover-arrow" id="arrow-tokens">
          <svg viewBox="0 0 14 6" aria-hidden="true">
            <path d="M0 0 L7 6 L14 0 Z" fill="var(--hud-popover-bg)" stroke="none"/>
            <path d="M0.5 0 L7 5.5 L13.5 0" fill="none" stroke="var(--hud-popover-border)" stroke-width="1" stroke-linejoin="round"/>
          </svg>
        </div>
      </div>

      <!-- 向上展开详情卡片 3: 当前上下文实况 -->
      <div class="hud-popover" id="hud-popover-context" data-popover-id="context" popover="manual" role="dialog" aria-label="${this.t('popoverContextAria')}" hidden>
        <div class="hud-popover-inner">
          <div class="hud-popover-header">
            <span class="hud-popover-title">
              <span class="hud-popover-title-regular" id="pop-ctx-prefix">${this.t('popCtxPrefix')}</span>
              <span class="hud-role-badge" id="pop-ctx-role" hidden></span>
              <span class="hud-popover-title-strong" id="pop-ctx-pct">0%</span>
            </span>
            <span class="hud-popover-badge-muted" id="pop-ctx-capacity">— / —</span>
          </div>
          <div class="hud-progress-track" id="pop-ctx-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
            <div class="hud-progress-seg hud-seg-sys" id="seg-sys" style="width: 0%"></div>
            <div class="hud-progress-seg hud-seg-tool" id="seg-tool" style="width: 0%"></div>
            <div class="hud-progress-seg hud-seg-msg" id="seg-msg" style="width: 0%"></div>
          </div>
          <div class="hud-popover-grid">
            <div class="hud-popover-row">
              <span class="hud-popover-label">
                <span class="hud-legend-dot" style="background-color: var(--hud-seg-sys-color)"></span>
                <span id="lbl-seg-sys">${this.t('lblSegSys')}</span>
              </span>
              <span class="hud-popover-val" id="val-seg-sys">0 tok</span>
            </div>
            <div class="hud-popover-row">
              <span class="hud-popover-label">
                <span class="hud-legend-dot" style="background-color: var(--hud-seg-tool-color)"></span>
                <span id="lbl-seg-tool">${this.t('lblSegTool')}</span>
              </span>
              <span class="hud-popover-val" id="val-seg-tool">0 tok</span>
            </div>
            <div class="hud-popover-row">
              <span class="hud-popover-label">
                <span id="lbl-seg-msg">${this.t('lblSegMsg')}</span>
              </span>
              <span class="hud-popover-val" id="val-seg-msg">0 tok</span>
            </div>
            <div class="hud-popover-row" id="row-ctx-peak">
              <span class="hud-popover-label" id="lbl-ctx-peak">${this.t('lblCtxPeak')}</span>
              <span class="hud-popover-val" id="val-ctx-peak">0 tok</span>
            </div>
            <div class="hud-popover-row" id="row-ctx-model">
              <span class="hud-popover-label" id="lbl-ctx-model">${this.t('lblCtxModel')}</span>
              <span class="hud-popover-val" id="val-ctx-model">—</span>
            </div>
          </div>
          <div class="hud-ctx-stages-wrap" id="hud-ctx-stages-wrap" hidden>
            <div class="hud-ctx-stages-divider" aria-hidden="true"></div>
            <div class="hud-ctx-stages-title" id="lbl-ctx-stages"></div>
            <div class="hud-ctx-stages-list" id="hud-ctx-stages-list"></div>
          </div>
        </div>
        <div class="hud-popover-arrow" id="arrow-context">
          <svg viewBox="0 0 14 6" aria-hidden="true">
            <path d="M0 0 L7 6 L14 0 Z" fill="var(--hud-popover-bg)" stroke="none"/>
            <path d="M0.5 0 L7 5.5 L13.5 0" fill="none" stroke="var(--hud-popover-border)" stroke-width="1" stroke-linejoin="round"/>
          </svg>
        </div>
      </div>
    `;
  }

  resetDomCache() {
    this.domRefs = null;
    this.domRefsShadow = null;
  }

  ensureDomCache() {
    if (!this.shadow) {
      this.resetDomCache();
      return null;
    }
    if (this.domRefsShadow !== this.shadow || !this.domRefs) {
      this.domRefsShadow = this.shadow;
      this.domRefs = { bySelector: new Map(), capsules: null, popovers: null };
    }
    return this.domRefs;
  }

  getShadowEl(selector) {
    const cache = this.ensureDomCache();
    if (!cache) return null;
    if (cache.bySelector.has(selector)) return cache.bySelector.get(selector);
    const el = this.shadow.querySelector(selector);
    if (el) cache.bySelector.set(selector, el);
    return el;
  }

  getShadowCapsules() {
    const cache = this.ensureDomCache();
    if (!cache) return [];
    if (!cache.capsules && typeof this.shadow.querySelectorAll === 'function') {
      cache.capsules = [...this.shadow.querySelectorAll('.capsule')];
    }
    return cache.capsules || [];
  }

  getShadowPopovers() {
    const cache = this.ensureDomCache();
    if (!cache) return [];
    if (!cache.popovers && typeof this.shadow.querySelectorAll === 'function') {
      cache.popovers = [...this.shadow.querySelectorAll('.hud-popover')];
    }
    return cache.popovers || [];
  }

  renderSkeleton() {
    if (!this.shadow) return;
    const capsules = this.getShadowCapsules();
    for (const c of capsules) {
      if (c.classList) {
        c.classList.add('is-skeleton');
        c.classList.remove('has-compaction', 'has-model-tag');
      }
    }
    const compBadgeEl = this.getShadowEl('#hud-compaction-badge');
    if (compBadgeEl) {
      compBadgeEl.textContent = '';
      compBadgeEl.setAttribute('hidden', '');
      compBadgeEl.removeAttribute('aria-label');
      compBadgeEl.removeAttribute('data-compaction-tier');
      compBadgeEl.classList?.remove('is-compaction-low', 'is-compaction-warn', 'is-compaction-danger');
    }
    const modelTagEl = this.getShadowEl('#hud-ctx-model-tag');
    if (modelTagEl) {
      modelTagEl.setAttribute('hidden', '');
    }
    const modelFullEl = this.getShadowEl('#hud-ctx-model-full');
    if (modelFullEl) modelFullEl.textContent = '';
    const modelShortEl = this.getShadowEl('#hud-ctx-model-short');
    if (modelShortEl) modelShortEl.textContent = '';
    const stagesWrapEl = this.getShadowEl('#hud-ctx-stages-wrap');
    if (stagesWrapEl) stagesWrapEl.setAttribute('hidden', '');
    const stagesListEl = this.getShadowEl('#hud-ctx-stages-list');
    if (stagesListEl) {
      stagesListEl.textContent = '';
      stagesListEl.innerHTML = '';
    }
    this.getShadowEl('#row-ctx-model')?.removeAttribute?.('hidden');
    const latestTpsEl = this.getShadowEl('#val-tps-latest');
    if (latestTpsEl) {
      latestTpsEl.textContent = '—';
      latestTpsEl.removeAttribute('hidden');
    }
    this.hideAllPopovers();
  }

  syncStreamingClass() {
    if (!this.shadow) return;
    const sessionCapsule = this.getShadowEl('.capsule-session');
    const sessionPopover = this.getShadowEl('#hud-popover-session');
    const phase =
      this.activityPhase === 'generating' || this.activityPhase === 'executing'
        ? this.activityPhase
        : 'idle';
    const applyPhaseClasses = (targetElement) => {
      if (!targetElement || !targetElement.classList) return;
      if (phase !== 'idle') {
        targetElement.classList.add('is-streaming');
      } else {
        targetElement.classList.remove('is-streaming');
      }
      if (phase === 'generating') {
        targetElement.classList.add('is-generating');
      } else {
        targetElement.classList.remove('is-generating');
      }
      if (phase === 'executing') {
        targetElement.classList.add('is-executing');
      } else {
        targetElement.classList.remove('is-executing');
      }
    };
    if (sessionCapsule && sessionCapsule.classList) {
      applyPhaseClasses(sessionCapsule);
    }
    applyPhaseClasses(sessionPopover);

    const subagentRow = this.getShadowEl('#row-subagent-status');
    const lblSubEl = this.getShadowEl('#lbl-subagent-status');
    const valSubEl = this.getShadowEl('#val-subagent-status');
    const activeSubagents = Math.max(1, this.runningSubagentCount || 1);
    const activeSubagentsBar = formatBarCompactCount(activeSubagents);
    const activeSubagentsPop = formatDetailCompactNumber(activeSubagents);
    const subStepsCount = Math.max(0, Number(this.lastMetrics?.session?.subagentSteps) || 0);
    const subStepsPop = formatDetailCompactNumber(subStepsCount);
    const rawSubSuffix =
      subStepsCount > 0 ? this.t('subStepsSuffix', { steps: subStepsPop }) : '';
    const subStepSuffix =
      this.locale === 'en' ? rawSubSuffix.replace(/\b1 steps\b/g, '1 step') : rawSubSuffix;

    this.syncSubagentTagElement(this.isSubagentRunning, activeSubagentsBar, activeSubagents);
    if (this.isSubagentRunning) {
      if (subagentRow) {
        subagentRow.removeAttribute('hidden');
      }
      if (lblSubEl) {
        lblSubEl.textContent = this.t('lblSubagentStatus');
      }
      if (valSubEl) {
        valSubEl.textContent = this.t('subRunning', { count: activeSubagentsPop, suffix: subStepSuffix });
      }
    } else {
      const totalSubagents = Math.max(0, Number(this.lastMetrics?.session?.subagentCount) || 0);
      if (totalSubagents > 0) {
        if (subagentRow) subagentRow.removeAttribute('hidden');
        if (lblSubEl) lblSubEl.textContent = this.t('lblSubagentStatus');
        if (valSubEl) {
          const totalSubPop = formatDetailCompactNumber(totalSubagents);
          valSubEl.textContent = this.t('subScheduled', { count: totalSubPop, suffix: subStepSuffix });
        }
      } else if (subagentRow) {
        subagentRow.setAttribute('hidden', '');
      }
    }
  }

  syncSubagentTagElement(isRunning, activeSubagentsBar = '1', activeSubagents = 1) {
    const subagentTagEl = this.getShadowEl('#hud-txt-session .hud-subagent-tag');
    if (!subagentTagEl) return;
    const sepEl =
      this.getShadowEl('#hud-txt-session .hud-subagent-sep') ||
      subagentTagEl.querySelector?.('.hud-subagent-sep') ||
      null;
    const countEl =
      this.getShadowEl('#hud-txt-session .hud-subagent-count') ||
      subagentTagEl.querySelector?.('.hud-subagent-count') ||
      null;
    if (isRunning) {
      subagentTagEl.removeAttribute?.('hidden');
      subagentTagEl.setAttribute?.('data-subagent-active', 'true');
      subagentTagEl.setAttribute?.('data-subagent-count', String(activeSubagents));
      if (sepEl && sepEl.textContent !== ' · ') sepEl.textContent = ' · ';
      if (countEl) {
        const nextCount = activeSubagents > 1 ? String(activeSubagentsBar) : '';
        if (countEl.textContent !== nextCount) countEl.textContent = nextCount;
      } else {
        const fallbackGlyph = activeSubagents > 1 ? ` · ⑂${activeSubagentsBar}` : ' · ⑂';
        if (subagentTagEl.textContent !== fallbackGlyph) subagentTagEl.textContent = fallbackGlyph;
      }
    } else {
      subagentTagEl.setAttribute?.('hidden', '');
      subagentTagEl.removeAttribute?.('data-subagent-active');
      subagentTagEl.removeAttribute?.('data-subagent-count');
      if (sepEl && sepEl.textContent !== '') sepEl.textContent = '';
      if (countEl) {
        if (countEl.textContent !== '') countEl.textContent = '';
      } else if (subagentTagEl.textContent !== '') {
        subagentTagEl.textContent = '';
      }
    }
  }

  buildSessionReadoutForAria(subagentRunning = false, activeSubagents = 1) {
    const turnsTxt = (this.getShadowEl('#hud-txt-session .hud-turns')?.textContent || '').trim();
    const turnDurTxt = (this.getShadowEl('#hud-txt-session .hud-turn-dur')?.textContent || '').replace(/\s+/g, ' ').trim();
    const speedTxt = (this.getShadowEl('#hud-txt-session .hud-speed')?.textContent || '').replace(/\s+/g, ' ').trim();
    const baseReadout = `${turnsTxt}${turnsTxt && turnDurTxt ? ' ' : ''}${turnDurTxt}${speedTxt ? ` ${speedTxt}` : ''}`
      .replace(/\s+/g, ' ')
      .trim();
    if (!subagentRunning) return baseReadout;
    const countBar = formatBarCompactCount(Math.max(1, activeSubagents));
    const subAria =
      activeSubagents > 1
        ? this.t('subagentTagPlural', { count: countBar })
        : this.t('subagentTagSingle');
    return `${baseReadout}${subAria}`.replace(/\s+/g, ' ').trim();
  }

  formatCompactTurnDuration(sec, locale = this.locale) {
    const resolved = locale === true ? 'en' : locale === false ? 'zh-Hans' : (locale || this.locale);
    return formatTurnDurationCompact(sec, resolved);
  }

  stopTurnClock() {
    if (this.turnClockTimer) {
      clearInterval(this.turnClockTimer);
      this.turnClockTimer = null;
    }
    this.turnClockAnchor = null;
    this.modelClockAnchor = null;
    this.toolClockAnchor = null;
  }

  getLiveClockSeconds(anchor, nowMs = Date.now()) {
    if (!anchor) return 0;
    return Math.max(0, anchor.baseSeconds + ((nowMs - anchor.anchorMs) / 1000) * anchor.rate);
  }

  syncSubClock(anchorKey, backendTotal, completedBase, rate, isWorkingNow, nowMs, resumeFloor = 0) {
    if (!isWorkingNow || !this.shadow) {
      this[anchorKey] = null;
      return;
    }
    const flooredBackend = Math.max(backendTotal, resumeFloor);
    const existing = this[anchorKey];
    if (!existing) {
      this[anchorKey] = {
        baseSeconds: flooredBackend,
        anchorMs: nowMs,
        rate,
        lastCompletedBase: completedBase,
        lastRenderedSec: Math.max(0, Math.round(flooredBackend)),
      };
      return;
    }
    const prevElapsed = this.getLiveClockSeconds(existing, nowMs);
    const monotonicFloor = Math.max(prevElapsed, flooredBackend);
    const completedAdvanced = completedBase > existing.lastCompletedBase + 1e-6;
    if (rate !== existing.rate) {
      // 运行期切换阶段时严格维持单调不减，杜绝因刚完结步骤略短于客户端预估而向回闪退 1 秒
      this[anchorKey] = {
        baseSeconds: monotonicFloor,
        anchorMs: nowMs,
        rate,
        lastCompletedBase: completedBase,
        lastRenderedSec: existing.lastRenderedSec,
      };
      return;
    }
    if (rate > 0) {
      if (
        flooredBackend > prevElapsed + 0.6 ||
        (flooredBackend > prevElapsed && Math.round(flooredBackend) > Math.round(prevElapsed))
      ) {
        this[anchorKey] = {
          baseSeconds: flooredBackend,
          anchorMs: nowMs,
          rate,
          lastCompletedBase: completedBase,
          lastRenderedSec: existing.lastRenderedSec,
        };
      } else if (completedAdvanced) {
        existing.lastCompletedBase = completedBase;
      }
    } else if (
      flooredBackend > prevElapsed + 0.6 ||
      (flooredBackend > prevElapsed && Math.round(flooredBackend) > Math.round(prevElapsed))
    ) {
      this[anchorKey] = {
        baseSeconds: monotonicFloor,
        anchorMs: nowMs,
        rate: 0,
        lastCompletedBase: completedBase,
        lastRenderedSec: existing.lastRenderedSec,
      };
    } else if (completedAdvanced) {
      existing.lastCompletedBase = completedBase;
    }
  }

  updateSubClockDom(anchor, selector, locale, nowMs) {
    if (!anchor || !this.shadow || anchor.rate <= 0) return false;
    const elapsedSec = this.getLiveClockSeconds(anchor, nowMs);
    const roundedSec = Math.max(0, Math.round(elapsedSec));
    if (roundedSec <= anchor.lastRenderedSec) return false;
    anchor.lastRenderedSec = roundedSec;
    const el = this.getShadowEl(selector);
    if (el) {
      const resolved = locale === true ? 'en' : locale === false ? 'zh-Hans' : (locale || this.locale);
      const nextText = durationText(elapsedSec, resolved);
      if (el.textContent !== nextText) {
        el.textContent = nextText;
      }
    }
    return true;
  }

  capPostIdleBackendTurnSec(rawBackendSec, metrics, nowMs = Date.now()) {
    if (!isRawNumber(rawBackendSec)) return rawBackendSec;
    const s = metrics?.session || {};
    const rawTurns = isRawNumber(s.turns) ? s.turns : 0;
    const rawSteps = isRawNumber(s.steps) ? s.steps : 0;
    const settled = this.settledIdleTurnState;
    if (
      settled &&
      settled.convId === this.currentConvId &&
      settled.turns === rawTurns &&
      rawSteps <= settled.steps &&
      !(Number(s.activeModelStepCount) > 0) &&
      !(Number(s.activeToolStepCount) > 0) &&
      !this.isSubagentRunning &&
      !metrics?.isSubagentRunning
    ) {
      const elapsedSinceResume =
        this.streamResumeAtMs > 0 ? Math.max(0, (nowMs - this.streamResumeAtMs) / 1000) : 0;
      if (this.isAwaitingPostIdleNewTurnFlush(metrics)) {
        return elapsedSinceResume;
      }
      return Math.min(rawBackendSec, settled.floorSec + elapsedSinceResume);
    }
    return rawBackendSec;
  }

  syncTurnClock(metrics, isWorkingNow) {
    const s = metrics?.session || {};
    const nowMs = Date.now();
    const rawBackendSec = isRawNumber(s.currentTurnDurationSeconds) ? Math.max(0, s.currentTurnDurationSeconds) : 0;
    const awaitingNewTurnFlush = isWorkingNow && this.isAwaitingPostIdleNewTurnFlush(metrics);
    const backendSec = isWorkingNow
      ? this.capPostIdleBackendTurnSec(rawBackendSec, metrics, nowMs)
      : rawBackendSec;
    const turns = isRawNumber(s.turns) ? s.turns : 0;
    const matchesTurnOrZeroToOne = (hw) =>
      this.isSameOrMigratedFirstTurn(hw, turns, backendSec);
    const hasSubagentInTurn = Boolean(
      this.isSubagentRunning ||
      metrics?.isSubagentRunning ||
      (isRawNumber(s.runningSubagentCount) && s.runningSubagentCount > 0) ||
      (matchesTurnOrZeroToOne(this.turnHighWaterMark) && this.turnHighWaterMark.hasSubagent)
    );
    if (!isWorkingNow || !this.shadow) {
      if (this.turnClockAnchor) {
        if (!this.turnClockAnchor.awaitingNewTurnFlush) {
          const liveSec = this.turnClockAnchor.baseSeconds + (nowMs - this.turnClockAnchor.anchorMs) / 1000;
          const prevHigh = matchesTurnOrZeroToOne(this.turnHighWaterMark)
            ? this.turnHighWaterMark.seconds
            : 0;
          this.turnHighWaterMark = {
            turns,
            seconds: Math.max(backendSec, liveSec, prevHigh),
            hasSubagent: hasSubagentInTurn,
          };
        }
      }
      this.stopTurnClock();
      return;
    }
    const frozenMatch =
      !awaitingNewTurnFlush &&
      this.frozenClockSnapshot &&
      this.frozenClockSnapshot.convId === this.currentConvId &&
      this.isSameOrMigratedFirstTurn(
        { turns: this.frozenClockSnapshot.turns, seconds: this.frozenClockSnapshot.turnSeconds },
        turns,
        backendSec
      );
    const frozenTurnFloor = frozenMatch ? this.frozenClockSnapshot.turnSeconds : 0;
    const frozenModelFloor =
      !awaitingNewTurnFlush &&
      this.frozenClockSnapshot &&
      this.frozenClockSnapshot.convId === this.currentConvId
        ? this.frozenClockSnapshot.modelSeconds
        : 0;
    const frozenToolFloor =
      !awaitingNewTurnFlush &&
      this.frozenClockSnapshot &&
      this.frozenClockSnapshot.convId === this.currentConvId
        ? this.frozenClockSnapshot.toolSeconds
        : 0;
    const modelBase = isRawNumber(s.modelDurationSeconds) ? Math.max(0, s.modelDurationSeconds) : 0;
    const modelInFlight = isRawNumber(s.inFlightModelDurationSeconds) ? Math.max(0, s.inFlightModelDurationSeconds) : 0;
    const modelBackendTotal = modelBase + modelInFlight;
    const activeModels = isRawNumber(s.activeModelStepCount) ? Math.max(0, Math.floor(s.activeModelStepCount)) : 0;
    const toolBase = isRawNumber(s.toolDurationSeconds) ? Math.max(0, s.toolDurationSeconds) : 0;
    const toolInFlight = isRawNumber(s.inFlightToolDurationSeconds) ? Math.max(0, s.inFlightToolDurationSeconds) : 0;
    const toolBackendTotal = toolBase + toolInFlight;
    const activeTools = isRawNumber(s.activeToolStepCount) ? Math.max(0, Math.floor(s.activeToolStepCount)) : 0;
    let modelRate = activeModels > 0 ? 1 : 0;
    let toolRate = activeTools > 0 ? 1 : 0;
    const isOptimisticBoot =
      (this.domIsStreaming || (s.isSubagentTrajectory === true && metrics.isStreaming === true)) &&
      !this.isSubagentRunning &&
      ((modelBackendTotal === 0 && toolBackendTotal === 0) || s.awaitingFirstTurnStep === true || awaitingNewTurnFlush);
    if (modelRate === 0 && toolRate === 0 && isOptimisticBoot) {
      if (this.activityPhase === 'executing') toolRate = 1;
      else modelRate = 1;
    }
    this.syncSubClock('modelClockAnchor', modelBackendTotal, modelBase, modelRate, isWorkingNow, nowMs, frozenModelFloor);
    this.syncSubClock('toolClockAnchor', toolBackendTotal, toolBase, toolRate, isWorkingNow, nowMs, frozenToolFloor);

    if (!this.turnClockAnchor) {
      const sameTurnResumeFloor =
        !awaitingNewTurnFlush && matchesTurnOrZeroToOne(this.turnHighWaterMark)
          ? this.turnHighWaterMark.seconds
          : 0;
      const startSec = Math.max(backendSec, sameTurnResumeFloor, frozenTurnFloor);
      this.turnClockAnchor = {
        baseSeconds: startSec,
        anchorMs: nowMs,
        turns,
        lastRenderedSec: Math.round(startSec),
        ...(awaitingNewTurnFlush ? { awaitingNewTurnFlush: true } : {}),
      };
    } else if (turns > this.turnClockAnchor.turns) {
      const liveSec = this.turnClockAnchor.baseSeconds + (nowMs - this.turnClockAnchor.anchorMs) / 1000;
      if (
        (this.turnClockAnchor.turns === 0 && turns === 1 && backendSec < liveSec) ||
        (this.turnClockAnchor.awaitingNewTurnFlush && backendSec <= liveSec + 1.5)
      ) {
        // Delayed SQLite flush of new turn's USER_INPUT row mid-turn: keep live optimistic timer uninterrupted.
        this.turnClockAnchor.turns = turns;
        delete this.turnClockAnchor.awaitingNewTurnFlush;
        if (this.turnHighWaterMark && this.turnHighWaterMark.turns === 0) {
          this.turnHighWaterMark.turns = turns;
        }
      } else {
        this.turnClockAnchor = { baseSeconds: backendSec, anchorMs: nowMs, turns, lastRenderedSec: Math.round(backendSec) };
        this.turnHighWaterMark = null;
      }
    } else {
      if (!awaitingNewTurnFlush && this.turnClockAnchor.awaitingNewTurnFlush) {
        delete this.turnClockAnchor.awaitingNewTurnFlush;
      }
      const liveSec = this.turnClockAnchor.baseSeconds + (nowMs - this.turnClockAnchor.anchorMs) / 1000;
      const highFloor =
        !awaitingNewTurnFlush && matchesTurnOrZeroToOne(this.turnHighWaterMark)
          ? this.turnHighWaterMark.seconds
          : 0;
      const effectiveLive = Math.max(liveSec, highFloor);
      if (
        backendSec > effectiveLive + 0.5 ||
        (backendSec > effectiveLive && Math.round(backendSec) > Math.round(effectiveLive))
      ) {
        this.turnClockAnchor = {
          baseSeconds: backendSec,
          anchorMs: nowMs,
          turns,
          lastRenderedSec: this.turnClockAnchor.lastRenderedSec,
        };
      }
    }
    this.frozenClockSnapshot = null;
    if (!awaitingNewTurnFlush) {
      const currentLive = this.turnClockAnchor.baseSeconds + (nowMs - this.turnClockAnchor.anchorMs) / 1000;
      const prevHigh = matchesTurnOrZeroToOne(this.turnHighWaterMark)
        ? this.turnHighWaterMark.seconds
        : 0;
      this.turnHighWaterMark = {
        turns,
        seconds: Math.max(backendSec, currentLive, prevHigh),
        hasSubagent: hasSubagentInTurn,
      };
    }
    if (!this.turnClockTimer) {
      this.turnClockTimer = setInterval(() => this.tickTurnClock(), 250);
      if (typeof this.turnClockTimer?.unref === 'function') {
        this.turnClockTimer.unref();
      }
    }
  }

  setTurnDurationText(label, showDot) {
    if (!this.shadow) return;
    const turnDurEl = this.getShadowEl('#hud-txt-session .hud-turn-dur');
    if (!turnDurEl) return;
    const resolvedShowDot =
      showDot !== undefined
        ? showDot
        : Boolean(this.getShadowEl('#hud-txt-session .hud-turns')?.textContent);
    const dotEl = this.getShadowEl('#hud-txt-session .hud-turn-dot');
    const textEl = this.getShadowEl('#hud-txt-session .hud-turn-text');
    if (dotEl && textEl) {
      const nextDot = resolvedShowDot ? '· ' : '';
      if (dotEl.textContent !== nextDot) {
        dotEl.textContent = nextDot;
      }
      if (textEl.textContent !== label) {
        textEl.textContent = label;
      }
      return;
    }
    const nextTurnText = resolvedShowDot ? `· ${label}` : label;
    if (turnDurEl.textContent !== nextTurnText) {
      turnDurEl.textContent = nextTurnText;
    }
  }

  tickTurnClock() {
    if (
      !this.turnClockAnchor ||
      !this.shadow ||
      !this.host ||
      (this.hostMountedInDom && !this.host.isConnected) ||
      !(this.hasActiveWork || this.isStreaming || this.isSubagentRunning)
    ) {
      this.stopTurnClock();
      return;
    }
    if (
      (typeof document !== 'undefined' &&
        (document.hidden === true || document.visibilityState === 'hidden')) ||
      this.host.style?.display === 'none' ||
      this.host.hasAttribute?.('hidden')
    ) {
      return;
    }
    const nowMs = Date.now();
    const modelAdvanced = this.updateSubClockDom(this.modelClockAnchor, '#val-model-dur', this.locale, nowMs);
    const toolAdvanced = this.updateSubClockDom(this.toolClockAnchor, '#val-tool-dur', this.locale, nowMs);
    if (modelAdvanced || toolAdvanced) {
      const s = this.lastMetrics?.session || {};
      const rawTurns = isRawNumber(s.turns) ? s.turns : 0;
      const rawSteps = isRawNumber(s.steps) ? s.steps : 0;
      const sessionCompCount = Math.max(0, Math.floor(Number(s.compactionCount) || 0));
      const liveModel = this.modelClockAnchor ? this.getLiveClockSeconds(this.modelClockAnchor, nowMs) : Number(s.modelDurationSeconds || 0);
      const liveTool = this.toolClockAnchor ? this.getLiveClockSeconds(this.toolClockAnchor, nowMs) : Number(s.toolDurationSeconds || 0);
      const popSession = this.getShadowEl('#hud-popover-session');
      if (popSession) {
        popSession.setAttribute(
          'data-exact-summary',
          `turns=${rawTurns}; steps=${rawSteps}; modelSec=${liveModel.toFixed(2)}; toolSec=${liveTool.toFixed(2)}; ttftSec=${Number(s.averageTtftSeconds || 0).toFixed(2)}; tps=${Number(s.outputTps || 0).toFixed(2)}; compactions=${sessionCompCount}`
        );
      }
      const baseModelSnap = Number(s.modelDurationSeconds || 0) + Number(s.inFlightModelDurationSeconds || 0);
      const baseToolSnap = Number(s.toolDurationSeconds || 0) + Number(s.inFlightToolDurationSeconds || 0);
      const liveTurnModel = Math.max(0, Number(s.currentTurnModelDurationSeconds || 0) + Math.max(0, liveModel - baseModelSnap));
      const liveTurnTool = Math.max(0, Number(s.currentTurnToolDurationSeconds || 0) + Math.max(0, liveTool - baseToolSnap));
      this.getShadowEl('#val-turn-dur')?.setAttribute(
        'aria-description',
        this.t('turnBreakdownDesc', {
          model: durationText(liveTurnModel, this.locale),
          tool: durationText(liveTurnTool, this.locale),
        })
      );
    }
    const anchorTurnSec = this.turnClockAnchor.baseSeconds + (nowMs - this.turnClockAnchor.anchorMs) / 1000;
    const hwMatchesAnchor = this.isSameOrMigratedFirstTurn(
      this.turnHighWaterMark,
      this.turnClockAnchor.turns,
      anchorTurnSec
    );
    const highTurnSec = hwMatchesAnchor ? this.turnHighWaterMark.seconds : 0;
    const elapsedSec = Math.max(anchorTurnSec, highTurnSec);
    if (!this.turnClockAnchor.awaitingNewTurnFlush && hwMatchesAnchor && this.turnHighWaterMark) {
      this.turnHighWaterMark.seconds = Math.max(this.turnHighWaterMark.seconds, elapsedSec);
    }
    const roundedSec = Math.max(0, Math.round(elapsedSec));
    if (roundedSec <= this.turnClockAnchor.lastRenderedSec) return;
    this.turnClockAnchor.lastRenderedSec = roundedSec;
    const compactTickDur = this.formatCompactTurnDuration(elapsedSec, this.locale);
    const tickTurnLabel =
      this.lastMetrics?.availability === 'remote_unbridged'
        ? this.t('remoteObservedDur', { dur: compactTickDur })
        : compactTickDur;
    this.setTurnDurationText(tickTurnLabel);
    const valTurnDurEl = this.getShadowEl('#val-turn-dur');
    if (valTurnDurEl) {
      const nextCardText = durationText(elapsedSec, this.locale);
      if (valTurnDurEl.textContent !== nextCardText) {
        valTurnDurEl.textContent = nextCardText;
      }
    }
    const capSession = this.getShadowEl('.capsule-session');
    if (capSession) {
      const phase =
        this.activityPhase === 'generating' || this.activityPhase === 'executing'
          ? this.activityPhase
          : 'idle';
      const phaseText = phase === 'generating'
        ? this.t('phaseGenerating')
        : phase === 'executing'
        ? this.t('phaseExecuting')
        : this.t('phaseIdle');
      const activeSubs = Math.max(1, this.runningSubagentCount || 1);
      const sessionReadout = this.buildSessionReadoutForAria(this.isSubagentRunning, activeSubs);
      capSession.setAttribute(
        'aria-label',
        this.t('ariaSessionSummary', { phase: phaseText, readout: sessionReadout })
      );
    }
  }

  applyMetricsToDom(metrics) {
    if (!this.shadow || !metrics) return;
    const locale = this.locale || normalizeHudLocale(this.languageMode);
    const isZh = locale === 'zh-Hans';
    const q = (sel) => this.getShadowEl(sel);
    const setElText = (el, val) => {
      if (el && el.textContent !== val) el.textContent = val;
    };
    const setTxt = (sel, val) => {
      setElText(q(sel), val);
    };

    const capsules = this.getShadowCapsules();
    for (const c of capsules) {
      if (c.classList) c.classList.remove('is-skeleton');
    }
    this.syncStreamingClass();

    const s = metrics.session || {};
    const t = metrics.tokens || {};
    const c = metrics.context || {};
    const b = c.breakdown || {};
    const isRemoteUnbridged = metrics.availability === 'remote_unbridged';
    const isRemoteStale = metrics.availability === 'remote_stale';
    const unavailable = metrics.availability === 'unavailable' || metrics.availability === 'loading';
    const hasTelemetry = !unavailable && !isRemoteUnbridged;
    const hasContextUsage = hasTelemetry && c.hasUsageData !== false;

    const subagentRunning = Boolean(
      metrics.isSubagentRunning ||
        this.isSubagentRunning ||
        (Number(s.runningSubagentCount) || 0) > 0 ||
        this.runningSubagentCount > 0
    );
    const activeSubagents = Math.max(
      Number(metrics.runningSubagentCount) || 0,
      Number(s.runningSubagentCount) || 0,
      this.runningSubagentCount,
      subagentRunning ? 1 : 0
    );
    const totalSubagents = Math.max(Number(s.subagentCount) || 0, activeSubagents);

    // 1. 更新分段 1 (会话统计 + 子智能体实时工作状态 - 采用紧凑数字表示法)
    const turnsEl = q('#hud-txt-session .hud-turns');
    const turnDurEl = q('#hud-txt-session .hud-turn-dur');
    const speedEl = q('#hud-txt-session .hud-speed');
    const subagentTagEl = q('#hud-txt-session .hud-subagent-tag');
    const rawTurns = isRawNumber(s.turns) ? s.turns : 0;
    const rawSteps = isRawNumber(s.steps) ? s.steps : 0;
    const turnsBarCount = formatBarCompactCount(rawTurns);
    const turnsPopCount = formatDetailCompactNumber(rawTurns);
    const stepsPopCount = formatDetailCompactNumber(rawSteps);
    const activeSubagentsBar = formatBarCompactCount(activeSubagents);
    const isWorkingNow = Boolean(this.hasActiveWork || this.isStreaming || this.isSubagentRunning);
    const awaitingNewTurnFlush = isWorkingNow && this.isAwaitingPostIdleNewTurnFlush(metrics);
    const isFrozenRemoteStale = isRemoteStale && (!this.isStreaming || !metrics.isStreaming);
    const clockActive =
      isWorkingNow &&
      !unavailable &&
      !isFrozenRemoteStale &&
      (metrics.availability !== 'cached' || Boolean(this.turnClockAnchor));
    this.syncTurnClock(metrics, clockActive);
    const clockNowMs = Date.now();
    const rawBackendTurnSec = isRawNumber(s.currentTurnDurationSeconds)
      ? (isWorkingNow
          ? this.capPostIdleBackendTurnSec(Math.max(0, s.currentTurnDurationSeconds), metrics, clockNowMs)
          : Math.max(0, s.currentTurnDurationSeconds))
      : null;
    const hwMatchesRawTurns =
      !awaitingNewTurnFlush &&
      this.isSameOrMigratedFirstTurn(this.turnHighWaterMark, rawTurns, rawBackendTurnSec);
    const frozenMatchesRawTurns = Boolean(
      !isWorkingNow &&
        this.frozenClockSnapshot &&
        this.frozenClockSnapshot.convId === this.currentConvId &&
        this.isSameOrMigratedFirstTurn(
          { turns: this.frozenClockSnapshot.turns, seconds: this.frozenClockSnapshot.turnSeconds },
          rawTurns,
          rawBackendTurnSec
        )
    );
    const frozenTurnSec = frozenMatchesRawTurns ? this.frozenClockSnapshot.turnSeconds : 0;
    const highWaterCandidate =
      !isWorkingNow && hwMatchesRawTurns ? this.turnHighWaterMark.seconds : 0;
    const sameTurnFloor =
      Math.max(
        frozenTurnSec,
        highWaterCandidate > 0 &&
          (this.turnHighWaterMark?.hasSubagent ||
            isRemoteUnbridged ||
            (s.turnAborted === true &&
              (rawBackendTurnSec === null ||
                rawBackendTurnSec <= 0 ||
                (s.turnAbortedMissingEnd === true && rawBackendTurnSec < highWaterCandidate - 1e-6))) ||
            rawBackendTurnSec === null)
          ? highWaterCandidate
          : 0
      );
    const effectiveIdleTurnSec =
      rawBackendTurnSec !== null
        ? Math.max(rawBackendTurnSec, sameTurnFloor)
        : sameTurnFloor > 0
        ? sameTurnFloor
        : null;
    const liveElapsedSec = clockActive && this.turnClockAnchor
      ? Math.max(
          this.turnClockAnchor.baseSeconds + (clockNowMs - this.turnClockAnchor.anchorMs) / 1000,
          hwMatchesRawTurns ? this.turnHighWaterMark.seconds : 0
        )
      : effectiveIdleTurnSec;
    const liveModelSec = clockActive && this.modelClockAnchor
      ? this.getLiveClockSeconds(this.modelClockAnchor, clockNowMs)
      : frozenMatchesRawTurns
      ? Math.max(Number(s.modelDurationSeconds || 0), this.frozenClockSnapshot.modelSeconds)
      : s.modelDurationSeconds;
    const liveToolSec = clockActive && this.toolClockAnchor
      ? this.getLiveClockSeconds(this.toolClockAnchor, clockNowMs)
      : frozenMatchesRawTurns
      ? Math.max(Number(s.toolDurationSeconds || 0), this.frozenClockSnapshot.toolSeconds)
      : s.toolDurationSeconds;
    if (this.turnClockAnchor && isRawNumber(liveElapsedSec)) {
      this.turnClockAnchor.lastRenderedSec = Math.max(
        this.turnClockAnchor.lastRenderedSec ?? 0,
        Math.round(liveElapsedSec)
      );
    }
    if (this.modelClockAnchor && isRawNumber(liveModelSec)) {
      this.modelClockAnchor.lastRenderedSec = Math.max(
        this.modelClockAnchor.lastRenderedSec ?? 0,
        Math.round(liveModelSec)
      );
    }
    if (this.toolClockAnchor && isRawNumber(liveToolSec)) {
      this.toolClockAnchor.lastRenderedSec = Math.max(
        this.toolClockAnchor.lastRenderedSec ?? 0,
        Math.round(liveToolSec)
      );
    }
    const isPendingTps =
      s.outputTpsPending === true ||
      s.outputTpsFormatted === '计算中...' ||
      s.outputTpsFormatted === 'Calculating...' ||
      s.outputTpsFormatted === 'Measuring…' ||
      (isWorkingNow && !(Number(s.samples?.timed) > 0) && s.outputTpsFormatted === '—');
    const barSpeedText = isPendingTps
      ? this.t('tpsMeasuring')
      : s.outputTpsFormatted === '—' || !isRawNumber(s.outputTps)
      ? '—'
      : `${compactBarNumber(Math.round(s.outputTps))} tok/s`;
    const popTpsText = isPendingTps
      ? this.t('tpsMeasuring')
      : formatRateMetric(s.outputTps, s.outputTpsFormatted, ' tok/s');

    const isSubagentSession = Boolean(this.paneKind === 'subagent' || s.isSubagentTrajectory === true);
    if (turnsEl) {
      turnsEl.textContent =
        isSubagentSession && rawTurns === 0 && rawSteps > 0
          ? ''
          : this.t('turnsUnit', { count: turnsBarCount });
    }
    if (turnDurEl) {
      let compactDur;
      if (liveElapsedSec !== null && (isWorkingNow || sameTurnFloor > (rawBackendTurnSec ?? 0))) {
        compactDur = this.formatCompactTurnDuration(liveElapsedSec, locale);
      } else {
        compactDur = isZh
          ? (s.currentTurnDurationCompactZh || (liveElapsedSec !== null ? this.formatCompactTurnDuration(liveElapsedSec, locale) : this.t('turnCompactDefault')))
          : (s.currentTurnDurationCompactEn || (liveElapsedSec !== null ? this.formatCompactTurnDuration(liveElapsedSec, locale) : this.t('turnCompactDefault')));
      }
      this.setTurnDurationText(compactDur, Boolean(turnsEl?.textContent));
    }
    setElText(speedEl, ` · ${barSpeedText}`);
    void subagentTagEl;
    this.syncSubagentTagElement(subagentRunning, activeSubagentsBar, activeSubagents);

    // 2. 更新分段 2 (Token 用量)
    const tokTotalEl = q('#hud-txt-tokens .hud-tok-total');
    const cachePrefixEl = q('#hud-txt-tokens .hud-cache-prefix');
    const cacheLabelEl = q('#hud-txt-tokens .hud-cache-label');
    const cacheValEl = q('#hud-txt-tokens .hud-cache-val');
    setElText(
      tokTotalEl,
      formatBarTokenCount(t.totalTokens, t.totalTokensCompact)
    );
    if (cachePrefixEl) cachePrefixEl.textContent = this.t('cachePrefix');
    if (cacheLabelEl) cacheLabelEl.textContent = this.t('cacheLabel');
    setElText(cacheValEl, formatPercent(t.cacheHitRate, t.cacheHitRateFormatted, 0));

    // 3. 更新分段 3 (上下文实况 + 左侧上下文压缩次数徽章)
    const ctxCapsule = q('.capsule-context');
    const compBadgeEl = q('#hud-compaction-badge');
    const modelTagEl = q('#hud-ctx-model-tag');
    const modelFullEl = q('#hud-ctx-model-full');
    const modelShortEl = q('#hud-ctx-model-short');
    const ctxTxtEl = q('#hud-txt-context');
    const meterFillEl = q('#hud-meter-fill');
    const stages = Array.isArray(c.modelStages) ? c.modelStages : [];
    const visibleStages = stages.filter((st) => st && !st.isActive);
    const conciseModelName = formatConciseStageModelName(c.modelDisplayName || '');
    const rawShortLabel = String(
      c.modelShortLabel ||
        (conciseModelName && conciseModelName !== '—' ? conciseModelName : '') ||
        (c.modelId && c.modelId !== 'pending' && c.modelId !== 'unknown' ? c.modelId : '') ||
        ''
    ).trim();
    const validShortLabel =
      rawShortLabel && rawShortLabel !== '—' && rawShortLabel !== 'pending' && rawShortLabel !== 'unknown'
        ? rawShortLabel
        : '';
    const showMultiModel = hasTelemetry && Boolean(c.isMultiModel && visibleStages.length > 0 && validShortLabel);
    const activeStageObj = stages.find((st) => st && st.isActive);
    const sessionCompCount = !hasTelemetry ? 0 : Math.max(0, Math.floor(Number(s.compactionCount) || 0));
    const hasPerModelCompaction =
      isRawNumber(c.activeModelCompactionCount) ||
      stages.some((st) => st && isRawNumber(st.compactionCount));
    const effectiveModelCompCount = !hasTelemetry
      ? 0
      : showMultiModel && hasPerModelCompaction
      ? Math.max(
          0,
          Math.floor(
            Number(c.activeModelCompactionCount ?? activeStageObj?.compactionCount) || 0
          )
        )
      : sessionCompCount;
    const compCount = effectiveModelCompCount;
    if (compBadgeEl) {
      compBadgeEl.classList?.remove('is-compaction-low', 'is-compaction-warn', 'is-compaction-danger');
      if (compCount >= 1) {
        const compTier = compCount >= 3 ? 'danger' : compCount === 2 ? 'warn' : 'low';
        const compBarText = formatBarCompactCount(compCount);
        compBadgeEl.textContent = compBarText;
        compBadgeEl.removeAttribute('hidden');
        compBadgeEl.setAttribute('data-compaction-tier', compTier);
        compBadgeEl.classList?.add(`is-compaction-${compTier}`);
        compBadgeEl.setAttribute(
          'aria-label',
          compCount === 1
            ? this.t('compactionAriaOnce')
            : this.t('compactionAria', { count: compBarText })
        );
        ctxCapsule?.classList?.add('has-compaction');
      } else {
        compBadgeEl.textContent = '';
        compBadgeEl.setAttribute('hidden', '');
        compBadgeEl.removeAttribute('aria-label');
        compBadgeEl.removeAttribute('data-compaction-tier');
        ctxCapsule?.classList?.remove('has-compaction');
      }
    }
    if (modelTagEl) {
      if (showMultiModel) {
        const shortLbl = validShortLabel;
        const compactLbl = String(c.modelCompactLabel || shortLbl.charAt(0).toUpperCase() || '');
        setElText(modelFullEl, shortLbl);
        setElText(modelShortEl, compactLbl);
        modelTagEl.removeAttribute('hidden');
        ctxCapsule?.classList?.add('has-model-tag');
      } else {
        setElText(modelFullEl, '');
        setElText(modelShortEl, '');
        modelTagEl.setAttribute('hidden', '');
        ctxCapsule?.classList?.remove('has-model-tag');
      }
    }

    const ratioClamped = hasContextUsage ? Math.min(1.0, Math.max(0, Number(c.usedRatio) || 0)) : 0;
    const usedCompact = !hasContextUsage
      ? '—'
      : isRawNumber(c.usedTokens)
      ? formatDetailCompactNumber(c.usedTokens, 3)
      : String(c.usedTokensCompact || '0').replace(/\s*tok$/i, '');
    const contextRatio = hasContextUsage ? c.usedRatio : undefined;
    const ctxPctPrefix = hasContextUsage && isRawNumber(contextRatio) && c.isFallbackCapacity ? '~' : '';
    const pctText = `${ctxPctPrefix}${formatPercent(contextRatio, c.usedRatioFormatted, 0)}`;

    if (ctxTxtEl) {
      setElText(ctxTxtEl, pctText);
      ctxTxtEl.setAttribute('data-used-tokens', usedCompact);
    }

    const isDark = Boolean(this.isDarkTheme || this.host?.getAttribute?.('data-theme') === 'dark');
    const strokeColor = computeContextProgressColor(ratioClamped, isDark);

    if (meterFillEl) {
      const fillWidth = Number((54 * ratioClamped).toFixed(2));
      meterFillEl.setAttribute('width', String(fillWidth));
      meterFillEl.setAttribute('fill', strokeColor);
    }

    // 4. 更新 Popover 1 (会话统计 - 采用紧凑数字表示法)
    setTxt('#pop-session-title', this.t('popSessionTitle'));
    const rawPopSessionBadge =
      isSubagentSession && rawTurns === 0 && rawSteps > 0
        ? this.t('popSessionBadge', { turns: 0, steps: stepsPopCount }).replace(/^0\s*(?:轮|turns)\s*/i, '')
        : this.t('popSessionBadge', { turns: turnsPopCount, steps: stepsPopCount });
    setTxt(
      '#pop-session-badge',
      isZh
        ? rawPopSessionBadge
        : rawPopSessionBadge.replace(/\b1 turns\b/g, '1 turn').replace(/\b1 steps\b/g, '1 step')
    );
    setTxt('#lbl-model-dur', this.t('lblModelDur'));
    setTxt(
      '#val-model-dur',
      formatDuration(liveModelSec, s.modelDurationFormatted, locale)
    );
    setTxt('#lbl-tool-dur', this.t('lblToolDur'));
    setTxt(
      '#val-tool-dur',
      formatDuration(liveToolSec, s.toolDurationFormatted, locale)
    );
    setTxt('#lbl-ttft', this.t('lblTtft'));
    setTxt(
      '#val-ttft',
      formatRateMetric(s.averageTtftSeconds, s.averageTtftFormatted, this.t('secSuffix'))
    );
    setTxt('#lbl-tps', this.t('lblTps'));
    setTxt('#val-tps', popTpsText);
    setTxt('#lbl-turn-dur', this.t('lblTurnDur'));
    const cardTurnSec = liveElapsedSec !== null && (isWorkingNow || sameTurnFloor > (rawBackendTurnSec ?? 0))
      ? liveElapsedSec
      : s.currentTurnDurationSeconds;
    const turnDurFormatted = isZh
      ? (isRawNumber(cardTurnSec) && (isWorkingNow || sameTurnFloor > (rawBackendTurnSec ?? 0) || s.currentTurnDurationFormatted !== '—')
        ? durationText(cardTurnSec, locale)
        : (s.currentTurnDurationFormatted || '—'))
      : (isRawNumber(cardTurnSec) && (isWorkingNow || sameTurnFloor > (rawBackendTurnSec ?? 0) || s.currentTurnDurationFormattedEn !== '—')
        ? durationText(cardTurnSec, locale)
        : (s.currentTurnDurationFormattedEn || '—'));
    setTxt('#val-turn-dur', turnDurFormatted);
    setTxt('#lbl-ttft-latest', this.t('lblTtftLatest'));
    const latestStepTtftRawFormatted = isZh ? s.latestStepTtftFormatted : s.latestStepTtftFormattedEn;
    const hasLatestStepTtft =
      hasTelemetry &&
      isRawNumber(s.latestStepTtftSeconds) &&
      Boolean(latestStepTtftRawFormatted) &&
      latestStepTtftRawFormatted !== '—';
    const latestStepTtftText = hasLatestStepTtft
      ? formatRateMetric(s.latestStepTtftSeconds, latestStepTtftRawFormatted, this.t('secSuffix'))
      : '—';
    setTxt('#val-ttft-latest', latestStepTtftText);
    setTxt('#lbl-tps-latest', this.t('lblTpsLatest'));
    const hasLatestStepTps =
      hasTelemetry &&
      isRawNumber(s.latestStepOutputTps) &&
      Boolean(s.latestStepOutputTpsFormatted) &&
      s.latestStepOutputTpsFormatted !== '—';
    const latestStepTpsText = hasLatestStepTps
      ? formatRateMetric(s.latestStepOutputTps, s.latestStepOutputTpsFormatted, ' tok/s')
      : '—';
    setTxt('#val-tps-latest', latestStepTpsText);
    const baseModelSnap = Number(s.modelDurationSeconds || 0) + Number(s.inFlightModelDurationSeconds || 0);
    const baseToolSnap = Number(s.toolDurationSeconds || 0) + Number(s.inFlightToolDurationSeconds || 0);
    const liveTurnModel = Math.max(
      0,
      Number(s.currentTurnModelDurationSeconds || 0) +
        Math.max(0, Number(liveModelSec || 0) - baseModelSnap)
    );
    const liveTurnTool = Math.max(
      0,
      Number(s.currentTurnToolDurationSeconds || 0) +
        Math.max(0, Number(liveToolSec || 0) - baseToolSnap)
    );
    const modelTurnSec = durationText(liveTurnModel, locale);
    const toolTurnSec = durationText(liveTurnTool, locale);
    q('#val-turn-dur')?.setAttribute(
      'aria-description',
      this.t('turnBreakdownDesc', { model: modelTurnSec, tool: toolTurnSec })
    );
    const statusNoteEl = q('#hud-session-status-note');
    if (statusNoteEl) {
      if (isRemoteUnbridged) {
        statusNoteEl.textContent = this.t('remoteUnbridgedNote');
        statusNoteEl.removeAttribute('hidden');
      } else if (
        metrics.availability === 'partial' ||
        metrics.availability === 'cached' ||
        isRemoteStale
      ) {
        const obsLocale = locale === 'en' ? 'en-US' : 'zh-CN';
        const ts = isRemoteStale
          ? (metrics.lastSuccessAt ?? metrics.observedAt)
          : metrics.observedAt;
        const obs = ts
          ? new Date(ts).toLocaleTimeString(obsLocale, {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
              hour12: false,
            })
          : '';
        const baseNote = isRemoteStale
          ? this.t('remoteStaleNote')
          : metrics.availability === 'cached'
          ? this.t('noteCached')
          : this.t('notePartial');
        const timePart = obs ? this.t('noteTimeParen', { time: obs }) : '';
        statusNoteEl.textContent = `${baseNote}${timePart}`;
        statusNoteEl.removeAttribute('hidden');
      } else {
        statusNoteEl.textContent = '';
        statusNoteEl.setAttribute('hidden', '');
      }
    }
    q('#val-ttft')?.setAttribute('aria-description', this.t('descTtft'));
    q('#val-tps')?.setAttribute('aria-description', this.t('descTps'));
    q('#val-ttft-latest')?.setAttribute('aria-description', this.t('descTtftLatest'));
    q('#val-tps-latest')?.setAttribute('aria-description', this.t('descTpsLatest'));

    const subagentRow = q('#row-subagent-status');
    setTxt('#lbl-subagent-status', this.t('lblSubagentStatus'));
    const subStepsCount = Math.max(0, Number(s.subagentSteps) || 0);
    const subStepsPop = formatDetailCompactNumber(subStepsCount);
    const activeSubagentsPop = formatDetailCompactNumber(activeSubagents);
    const totalSubagentsPop = formatDetailCompactNumber(totalSubagents);
    const rawSubSuffix =
      subStepsCount > 0 ? this.t('subStepsSuffix', { steps: subStepsPop }) : '';
    const subStepSuffix =
      this.locale === 'en' ? rawSubSuffix.replace(/\b1 steps\b/g, '1 step') : rawSubSuffix;
    if (subagentRow) {
      if (subagentRunning || totalSubagents > 0) {
        subagentRow.removeAttribute('hidden');
        if (subagentRunning) {
          setTxt(
            '#val-subagent-status',
            this.t('subRunning', { count: activeSubagentsPop, suffix: subStepSuffix })
          );
        } else {
          setTxt(
            '#val-subagent-status',
            this.t('subScheduled', { count: totalSubagentsPop, suffix: subStepSuffix })
          );
        }
      } else {
        subagentRow.setAttribute('hidden', '');
        setTxt('#val-subagent-status', '—');
      }
    }

    // 5. 更新 Popover 2 (Token 用量)
    setTxt('#pop-tokens-title', this.t('popTokensTitle'));
    setTxt('#pop-tokens-badge', formatTokenCount(t.totalTokens, t.totalTokensFormatted));
    setTxt('#lbl-cache-hit', this.t('lblCacheHit'));
    setTxt('#val-cache-hit', formatPopoverPercent(t.cacheHitRate, t.cacheHitRateFormatted));
    setTxt('#lbl-uncached-in', this.t('lblUncachedIn'));
    setTxt('#val-uncached-in', formatTokenCount(t.uncachedInputTokens, t.uncachedInputFormatted));
    setTxt('#lbl-cached-read', this.t('lblCachedRead'));
    setTxt('#val-cached-read', formatTokenCount(t.cachedReadTokens, t.cachedReadFormatted));
    const cacheWriteRow = q('#row-cache-write');
    setTxt('#lbl-cache-write', this.t('lblCacheWrite'));
    if (cacheWriteRow) {
      if (Number(t.cacheWriteTokens) > 0) {
        cacheWriteRow.removeAttribute('hidden');
        setTxt(
          '#val-cache-write',
          formatTokenCount(t.cacheWriteTokens, t.cacheWriteFormatted)
        );
      } else {
        cacheWriteRow.setAttribute('hidden', '');
        setTxt('#val-cache-write', '0 tok');
      }
    }
    setTxt('#lbl-output-tok', this.t('lblOutputTok'));
    setTxt('#val-output-tok', formatTokenCount(t.outputTokens, t.outputFormatted));

    const reasoningRow = q('#row-reasoning-tok');
    setTxt('#lbl-reasoning-tok', this.t('lblReasoningTok'));
    if (reasoningRow) {
      if (Number(t.reasoningTokens) > 0) {
        reasoningRow.removeAttribute('hidden');
        setTxt(
          '#val-reasoning-tok',
          `${formatDetailCompactNumber(t.reasoningTokens)} / ${formatDetailCompactNumber(t.candidateTokens || 0)} tok`
        );
      } else {
        reasoningRow.setAttribute('hidden', '');
        setTxt('#val-reasoning-tok', '0 / 0 tok');
      }
    }

    const formatUsdDisplay = (usd, formatted) => {
      if (!hasTelemetry || formatted === '—') return '—';
      if (isRawNumber(usd)) return compactUsd(usd);
      if (typeof formatted === 'string') {
        const trimmed = formatted.trim();
        if (!trimmed) return '—';
        const numericMatch = trimmed.replace(/,/g, '').match(/^~?\$\s*([0-9]+(?:\.[0-9]+)?)$/);
        if (numericMatch) {
          const parsed = Number(numericMatch[1]);
          if (Number.isFinite(parsed) && parsed >= 0) {
            return compactUsd(parsed);
          }
        }
        return trimmed;
      }
      return '—';
    };
    const rawEstCostText = formatUsdDisplay(t.estimatedCostUsd, t.estimatedCostFormatted);
    const estCostText =
      rawEstCostText !== '—' && t.hasUnpricedSteps === true && isRawNumber(t.estimatedCostUsd) && t.estimatedCostUsd > 0
        ? `≥ ${rawEstCostText.replace(/^~\s*/, '')}`
        : rawEstCostText;
    setTxt('#lbl-est-cost', this.t('lblEstCost'));
    setTxt('#val-est-cost', estCostText);
    setTxt('#lbl-cache-saved', this.t('lblCacheSaved'));
    setTxt('#val-cache-saved', formatUsdDisplay(t.cacheSavedUsd, t.cacheSavedFormatted));
    q('#val-est-cost')?.setAttribute('aria-description', this.t('descEstCost'));
    q('#val-cache-saved')?.setAttribute('aria-description', this.t('descCacheSaved'));

    // 6. 更新 Popover 3 (当前上下文实况 - 100% 真实底层数据)
    const activeRole = activeStageObj?.role;
    const hasActiveRole = activeRole === 'planner' || activeRole === 'executor';
    let popCtxPrefixText = this.t('popCtxPrefix');
    if (hasTelemetry && (showMultiModel || hasActiveRole) && validShortLabel) {
      popCtxPrefixText = this.t('popCtxPrefixWithModel', { model: validShortLabel });
    }
    setTxt('#pop-ctx-prefix', popCtxPrefixText);
    const popRoleEl = q('#pop-ctx-role');
    if (popRoleEl) {
      if (hasTelemetry && validShortLabel && (activeRole === 'planner' || activeRole === 'executor')) {
        popRoleEl.textContent =
          activeRole === 'planner' ? this.t('stageRolePlannerBadge') : this.t('stageRoleExecutorBadge');
        popRoleEl.className = `hud-role-badge is-role-${activeRole}`;
        popRoleEl.removeAttribute('hidden');
      } else {
        popRoleEl.textContent = '';
        popRoleEl.className = 'hud-role-badge';
        popRoleEl.setAttribute('hidden', '');
      }
    }
    setTxt('#pop-ctx-pct', `${ctxPctPrefix}${formatPopoverPercent(contextRatio, c.usedRatioFormatted)}`);
    const capacityText = isRawNumber(c.capacityTokens) && c.capacityTokens > 0
      ? `${c.isFallbackCapacity ? '~' : ''}${formatDetailCompactNumber(c.capacityTokens)}` : '—';
    const usedText = hasContextUsage && isRawNumber(c.usedTokens) ? formatDetailCompactNumber(c.usedTokens) : '—';
    setTxt(
      '#pop-ctx-capacity',
      `${usedText} / ${capacityText}`
    );

    const trackEl = q('#pop-ctx-track');
    if (trackEl) {
      trackEl.setAttribute('aria-valuenow', String(Math.round(ratioClamped * 100)));
      trackEl.setAttribute('aria-valuetext', formatPopoverPercent(contextRatio, c.usedRatioFormatted));
    }
    const segSysEl = q('#seg-sys');
    const segToolEl = q('#seg-tool');
    const segMsgEl = q('#seg-msg');
    const wSys = hasContextUsage ? Math.max(0, Number(b.cachedContextRatio ?? b.systemRatio) || 0) : 0;
    const wTool = hasContextUsage ? Math.max(0, Number(b.uncachedContextRatio ?? b.toolRatio) || 0) : 0;
    if (segSysEl) segSysEl.style.width = `${wSys.toFixed(3)}%`;
    if (segToolEl) segToolEl.style.width = `${wTool.toFixed(3)}%`;
    if (segMsgEl) segMsgEl.style.width = '0%';

    setTxt('#lbl-seg-sys', this.t('lblSegSys'));
    setTxt('#val-seg-sys', hasContextUsage ? formatTokenCount(b.cachedContextTokens ?? b.systemTokens, b.cachedContextFormatted || b.systemTokensCompact) : '—');
    setTxt('#lbl-seg-tool', this.t('lblSegTool'));
    setTxt('#val-seg-tool', hasContextUsage ? formatTokenCount(b.uncachedContextTokens ?? b.toolTokens, b.uncachedContextFormatted || b.toolTokensCompact) : '—');
    setTxt('#lbl-seg-msg', this.t('lblSegMsg'));
    setTxt('#val-seg-msg', hasContextUsage ? formatTokenCount(b.latestOutputTokens ?? b.messageTokens, b.latestOutputFormatted || b.messageTokensCompact) : '—');

    const effectivePeakCompCount = effectiveModelCompCount;
    const peakRow = q('#row-ctx-peak');
    if (peakRow) {
      setTxt('#lbl-ctx-peak', showMultiModel ? this.t('lblCtxModelPeak') : this.t('lblCtxPeak'));
      const hasPeakData = hasContextUsage || (isRawNumber(c.peakContextTokens) && c.peakContextTokens > 0);
      if (!hasPeakData) {
        setTxt('#val-ctx-peak', '—');
      } else {
        const peakVal = formatTokenCount(
          c.peakContextTokens ?? c.usedTokens,
          c.peakContextFormatted || c.usedTokensFormatted
        );
        const compPopText = formatDetailCompactNumber(effectivePeakCompCount);
        const compSuffix =
          effectivePeakCompCount > 0 ? this.t('ctxPeakCompSuffix', { count: compPopText }) : '';
        setTxt('#val-ctx-peak', `${peakVal}${compSuffix}`);
      }
    }
    const modelRow = q('#row-ctx-model');
    if (modelRow) {
      setTxt('#lbl-ctx-model', this.t('lblCtxModel'));
      setTxt('#val-ctx-model', c.modelDisplayName || c.modelId || '—');
      if (showMultiModel) modelRow.setAttribute('hidden', '');
      else modelRow.removeAttribute('hidden');
    }
    const stagesWrapEl = q('#hud-ctx-stages-wrap');
    const stagesListEl = q('#hud-ctx-stages-list');
    if (stagesWrapEl) {
      if (showMultiModel) {
        const stagesSectionTitle = visibleStages.every((st) => st.hasUsageData !== true)
          ? this.t('lblStageSectionPending')
          : this.t('lblStageSectionMulti');
        setTxt('#lbl-ctx-stages', stagesSectionTitle);
        this.renderModelStagesList(stagesListEl, visibleStages, isDark);
        stagesWrapEl.removeAttribute('hidden');
      } else {
        stagesWrapEl.setAttribute('hidden', '');
        this.renderModelStagesList(stagesListEl, [], isDark);
      }
    }

    // 7. 同步多语言无障碍标签 (aria-label) 与可核查精确整数摘要 (data-exact-summary)
    const toolbarEl = q('.hud-container');
    if (toolbarEl) {
      toolbarEl.setAttribute('aria-label', this.t('toolbarLabel'));
      if (metrics.availability) {
        toolbarEl.setAttribute('data-availability', String(metrics.availability));
      }
    }
    const phase =
      this.activityPhase === 'generating' || this.activityPhase === 'executing'
        ? this.activityPhase
        : 'idle';
    const phaseText = phase === 'generating'
      ? this.t('phaseGenerating')
      : phase === 'executing'
      ? this.t('phaseExecuting')
      : this.t('phaseIdle');

    const capSession = q('.capsule-session');
    const capTokens = q('.capsule-tokens');
    const capContext = q('.capsule-context');
    const sessionReadout = this.buildSessionReadoutForAria(subagentRunning, activeSubagents);
    const tokensReadout = (q('#hud-txt-tokens')?.textContent || '').replace(/\s+/g, ' ').trim();
    const contextReadout = pctText;
    if (capSession) {
      capSession.setAttribute(
        'aria-label',
        this.t('ariaSessionSummary', { phase: phaseText, readout: sessionReadout })
      );
    }
    if (capTokens) {
      capTokens.setAttribute(
        'aria-label',
        this.t('ariaTokensSummary', { readout: tokensReadout })
      );
    }
    if (capContext) {
      const modelNote = showMultiModel
        ? this.t('ariaContextModelNote', { model: validShortLabel })
        : '';
      let compNote = '';
      if (compCount >= 1) {
        compNote =
          compCount === 1
            ? this.t('ariaContextCompNoteOnce')
            : this.t('ariaContextCompNote', { count: formatBarCompactCount(compCount) });
      }
      capContext.setAttribute(
        'aria-label',
        this.t('ariaContextSummary', { readout: contextReadout, note: `${modelNote}${compNote}` })
      );
    }

    const popSession = q('#hud-popover-session');
    const popTokens = q('#hud-popover-tokens');
    const popContext = q('#hud-popover-context');
    if (popSession) {
      popSession.setAttribute('aria-label', this.t('popoverSessionAria'));
      popSession.setAttribute(
        'data-exact-summary',
        `turns=${rawTurns}; steps=${rawSteps}; modelSec=${Number(liveModelSec || 0).toFixed(2)}; toolSec=${Number(liveToolSec || 0).toFixed(2)}; ttftSec=${Number(s.averageTtftSeconds || 0).toFixed(2)}; tps=${Number(s.outputTps || 0).toFixed(2)}; compactions=${sessionCompCount}`
      );
    }
    if (popTokens) {
      popTokens.setAttribute('aria-label', this.t('popoverTokensAria'));
      popTokens.setAttribute(
        'data-exact-summary',
        `total=${Math.floor(Number(t.totalTokens) || 0)}; uncachedInput=${Math.floor(Number(t.uncachedInputTokens) || 0)}; cachedRead=${Math.floor(Number(t.cachedReadTokens) || 0)}; cacheWrite=${Math.floor(Number(t.cacheWriteTokens) || 0)}; output=${Math.floor(Number(t.outputTokens) || 0)}; reasoning=${Math.floor(Number(t.reasoningTokens) || 0)}; reply=${Math.floor(Number(t.candidateTokens) || 0)}`
      );
    }
    if (popContext) {
      popContext.setAttribute('aria-label', this.t('popoverContextAria'));
      popContext.setAttribute(
        'data-exact-summary',
        `used=${Math.floor(Number(c.usedTokens) || 0)}; capacity=${Math.floor(Number(c.capacityTokens) || 0)}; peak=${Math.floor(Number(c.peakContextTokens ?? c.usedTokens) || 0)}; compactions=${sessionCompCount}; modelCompactions=${effectivePeakCompCount}; model=${c.modelDisplayName || c.modelId || ''}`
      );
    }

    if (unavailable) {
      const isLoad = metrics.availability === 'loading';
      const isNewConv = metrics.conversationId === 'default';
      const sessionEmptyLabel = isLoad
        ? this.t('statusLoading')
        : isNewConv
        ? this.t('statusNewChat')
        : this.t('statusNoData');
      const stateLabel = isLoad ? this.t('statusLoading') : this.t('dataUnavailableAria');
      const sep = locale === 'en' ? ': ' : '：';
      if (capSession) {
        capSession.setAttribute('aria-label', `${this.t('capsuleSessionLabel')}${sep}${sessionEmptyLabel}`);
      }
      if (capTokens) {
        capTokens.setAttribute('aria-label', `${this.t('capsuleTokensLabel')}${sep}${stateLabel}`);
      }
      if (capContext) {
        capContext.setAttribute('aria-label', `${this.t('capsuleContextLabel')}${sep}${stateLabel}`);
      }
      setTxt('#hud-txt-session .hud-turns', '');
      this.setTurnDurationText(sessionEmptyLabel, false);
      setTxt('#hud-txt-session .hud-speed', '');
      q('#val-tps-latest')?.removeAttribute('hidden');
      ctxCapsule?.classList?.remove('has-model-tag');
      modelTagEl?.setAttribute('hidden', '');
      setElText(modelFullEl, '');
      setElText(modelShortEl, '');
      stagesWrapEl?.setAttribute('hidden', '');
      this.renderModelStagesList(stagesListEl, [], isDark);
      modelRow?.removeAttribute('hidden');
      for (const sel of ['#hud-txt-tokens .hud-tok-total','#hud-txt-tokens .hud-cache-val','#hud-txt-context','#pop-session-badge','#pop-tokens-badge','#val-cache-hit','#val-uncached-in','#val-cached-read','#val-output-tok','#val-est-cost','#val-cache-saved','#val-model-dur','#val-tool-dur','#val-ttft','#val-tps','#val-ttft-latest','#val-tps-latest','#val-turn-dur','#val-ctx-peak']) setTxt(sel, '—');
    } else if (isRemoteUnbridged) {
      const cleanHost = typeof metrics.remoteHostLabel === 'string' ? metrics.remoteHostLabel.trim() : '';
      const hostLabel = cleanHost
        ? this.t('remoteHostBadge', { host: cleanHost })
        : this.t('remoteHostFallback');
      const observedSec =
        isWorkingNow || (liveElapsedSec !== null && liveElapsedSec > 0)
          ? Math.max(0, Number(liveElapsedSec || 0))
          : 0;
      const hasObservedDur = isWorkingNow || observedSec > 0;
      const durText = hasObservedDur
        ? this.t('remoteObservedDur', { dur: this.formatCompactTurnDuration(observedSec, locale) })
        : this.t('statusRemoteUnbridged');
      const sep = locale === 'en' ? ': ' : '：';
      if (capSession) {
        capSession.setAttribute('aria-label', `${this.t('capsuleSessionLabel')}${sep}${hostLabel} · ${durText}`);
      }
      if (capTokens) {
        capTokens.setAttribute('aria-label', `${this.t('capsuleTokensLabel')}${sep}${this.t('dataUnavailableAria')}`);
      }
      if (capContext) {
        capContext.setAttribute('aria-label', `${this.t('capsuleContextLabel')}${sep}${this.t('dataUnavailableAria')}`);
      }
      setTxt('#hud-txt-session .hud-turns', `${hostLabel} `);
      this.setTurnDurationText(durText, true);
      setTxt('#hud-txt-session .hud-speed', '');
      q('#val-tps-latest')?.removeAttribute('hidden');
      ctxCapsule?.classList?.remove('has-model-tag');
      modelTagEl?.setAttribute('hidden', '');
      setElText(modelFullEl, '');
      setElText(modelShortEl, '');
      stagesWrapEl?.setAttribute('hidden', '');
      this.renderModelStagesList(stagesListEl, [], isDark);
      modelRow?.removeAttribute('hidden');
      for (const sel of ['#hud-txt-tokens .hud-tok-total','#hud-txt-tokens .hud-cache-val','#hud-txt-context','#pop-session-badge','#pop-tokens-badge','#val-cache-hit','#val-uncached-in','#val-cached-read','#val-output-tok','#val-est-cost','#val-cache-saved','#val-model-dur','#val-tool-dur','#val-ttft','#val-tps','#val-ttft-latest','#val-tps-latest','#val-ctx-peak']) setTxt(sel, '—');
      setTxt('#val-turn-dur', hasObservedDur ? durationText(observedSec, locale) : '—');
    }
    if (this.activePopoverId) this.repositionActivePopover(false);
  }

  renderModelStagesList(listEl, stages, isDark) {
    if (!listEl) return;
    if (!Array.isArray(stages) || stages.length === 0) {
      if (typeof listEl.replaceChildren === 'function') listEl.replaceChildren();
      listEl.textContent = '';
      listEl.innerHTML = '';
      return;
    }
    const doc =
      listEl.ownerDocument ||
      this.host?.ownerDocument ||
      (typeof document !== 'undefined' && typeof document.createElement === 'function' ? document : null);
    const useDomNodes = Boolean(
      doc && typeof doc.createElement === 'function' && typeof listEl.replaceChildren === 'function'
    );
    const nodes = [];
    const htmlParts = [];

    for (const stage of stages) {
      if (!stage || typeof stage !== 'object') continue;
      const isPending = stage.hasUsageData !== true;
      const isActive = Boolean(stage.isActive);
      const rawStageShort = String(stage.shortLabel || '').trim();
      const hasNamedStageShort =
        Boolean(rawStageShort) && rawStageShort !== 'pending' && rawStageShort !== 'unknown' && rawStageShort !== '—';
      const shortModel = hasNamedStageShort
        ? rawStageShort
        : String(stage.modelDisplayName || stage.modelId || '—');
      const hasRoleBadge =
        hasNamedStageShort && (stage.role === 'planner' || stage.role === 'executor');
      const roleBadgeText = hasRoleBadge
        ? stage.role === 'planner'
          ? this.t('stageRolePlannerBadge')
          : this.t('stageRoleExecutorBadge')
        : '';
      const stageTitle =
        stage.role === 'planner'
          ? !hasNamedStageShort
            ? (this.locale === 'en' ? 'Plan Stage' : '规划阶段')
            : shortModel
          : stage.role === 'executor'
          ? !hasNamedStageShort
            ? this.t('stageRoleExecutorPending')
            : shortModel
          : formatConciseStageModelName(stage.modelDisplayName || shortModel);

      let valText;
      let ratioClamped = 0;
      if (isPending) {
        valText = this.t('stagePending');
      } else {
        const rawRatio = Number(stage.usedRatio) || 0;
        ratioClamped = Math.min(1.0, Math.max(0, rawRatio));
        const prefix = stage.isFallbackCapacity ? '~' : '';
        const pct = `${prefix}${formatPopoverPercent(rawRatio, stage.usedRatioFormatted)}`;
        const usedStr = isRawNumber(stage.usedTokens)
          ? formatDetailCompactNumber(stage.usedTokens)
          : String(stage.usedTokensCompact || '0').replace(/\s*tok$/i, '');
        const capStr =
          isRawNumber(stage.capacityTokens) && stage.capacityTokens > 0
            ? `${stage.isFallbackCapacity ? '~' : ''}${formatDetailCompactNumber(stage.capacityTokens)}`
            : '—';
        valText = `${pct} · ${usedStr} / ${capStr}`;
      }

      const barWidthPct = isPending ? 0 : Number((ratioClamped * 100).toFixed(2));
      const barColor = computeContextProgressColor(ratioClamped, isDark);
      const stageCompCount = Math.max(0, Math.floor(Number(stage.compactionCount) || 0));
      const stageCompTier =
        stageCompCount >= 3 ? 'danger' : stageCompCount === 2 ? 'warn' : stageCompCount === 1 ? 'low' : '';
      const stageCompText = stageCompCount >= 1 ? formatBarCompactCount(stageCompCount) : '';
      const stageCompAria =
        stageCompCount === 1
          ? this.t('compactionAriaOnce')
          : stageCompCount > 1
          ? this.t('compactionAria', { count: formatDetailCompactNumber(stageCompCount) })
          : '';
      const itemClasses = [
        'hud-stage-item',
        isActive ? 'is-active' : '',
        isPending ? 'is-pending' : '',
      ]
        .filter(Boolean)
        .join(' ');

      if (useDomNodes) {
        const item = doc.createElement('div');
        item.className = itemClasses;
        if (stage.slotKey) item.setAttribute('data-stage-slot', String(stage.slotKey));
        if (stageCompCount >= 1) item.setAttribute('data-stage-compactions', String(stageCompCount));

        const head = doc.createElement('div');
        head.className = 'hud-stage-head';

        const nameEl = doc.createElement('span');
        nameEl.className = 'hud-stage-name';

        const dot = doc.createElement('span');
        dot.className = 'hud-stage-dot';
        dot.setAttribute('aria-hidden', 'true');
        nameEl.appendChild(dot);

        const labelSpan = doc.createElement('span');
        labelSpan.className = 'hud-stage-label';
        labelSpan.textContent = stageTitle;
        nameEl.appendChild(labelSpan);

        if (hasRoleBadge) {
          const roleBadge = doc.createElement('span');
          roleBadge.className = `hud-role-badge is-role-${stage.role}`;
          roleBadge.textContent = roleBadgeText;
          nameEl.appendChild(roleBadge);
        }

        if (isActive) {
          const badge = doc.createElement('span');
          badge.className = 'hud-stage-badge';
          badge.textContent = this.t('stageActiveBadge');
          nameEl.appendChild(badge);
        }

        if (stageCompCount >= 1 && stageCompTier) {
          const compBadge = doc.createElement('span');
          compBadge.className = `hud-stage-compaction is-compaction-${stageCompTier}`;
          compBadge.setAttribute('data-compaction-tier', stageCompTier);
          if (stageCompAria) compBadge.setAttribute('aria-label', stageCompAria);
          compBadge.textContent = stageCompText;
          nameEl.appendChild(compBadge);
        }

        const valEl = doc.createElement('span');
        valEl.className = 'hud-stage-val';
        valEl.textContent = valText;

        head.appendChild(nameEl);
        head.appendChild(valEl);

        const track = doc.createElement('div');
        track.className = 'hud-stage-bar-track';

        const fill = doc.createElement('div');
        fill.className = 'hud-stage-bar-fill';
        fill.setAttribute('data-stage-ratio', String(ratioClamped));
        fill.style.width = `${barWidthPct}%`;
        fill.style.backgroundColor = barColor;

        track.appendChild(fill);
        item.appendChild(head);
        item.appendChild(track);
        nodes.push(item);
      } else {
        const roleBadgeHtml = hasRoleBadge
          ? `<span class="hud-role-badge is-role-${escapeHudHtml(stage.role)}">${escapeHudHtml(roleBadgeText)}</span>`
          : '';
        const badgeHtml = isActive
          ? `<span class="hud-stage-badge">${escapeHudHtml(this.t('stageActiveBadge'))}</span>`
          : '';
        const compAriaAttr = stageCompAria ? ` aria-label="${escapeHudHtml(stageCompAria)}"` : '';
        const compBadgeHtml =
          stageCompCount >= 1 && stageCompTier
            ? `<span class="hud-stage-compaction is-compaction-${stageCompTier}" data-compaction-tier="${stageCompTier}"${compAriaAttr}>${escapeHudHtml(stageCompText)}</span>`
            : '';
        const slotAttr = stage.slotKey ? ` data-stage-slot="${escapeHudHtml(String(stage.slotKey))}"` : '';
        const compAttr = stageCompCount >= 1 ? ` data-stage-compactions="${stageCompCount}"` : '';
        htmlParts.push(
          `<div class="${itemClasses}"${slotAttr}${compAttr}>` +
            `<div class="hud-stage-head">` +
              `<span class="hud-stage-name"><span class="hud-stage-dot" aria-hidden="true"></span><span class="hud-stage-label">${escapeHudHtml(stageTitle)}</span>${roleBadgeHtml}${badgeHtml}${compBadgeHtml}</span>` +
              `<span class="hud-stage-val">${escapeHudHtml(valText)}</span>` +
            `</div>` +
            `<div class="hud-stage-bar-track"><div class="hud-stage-bar-fill" data-stage-ratio="${ratioClamped}" style="width:${barWidthPct}%;background-color:${barColor}"></div></div>` +
          `</div>`
        );
      }
    }

    if (useDomNodes) {
      listEl.replaceChildren(...nodes);
    } else {
      listEl.innerHTML = htmlParts.join('');
    }
  }

  bindEvents(targetComposer) {
    this.abortController = new AbortController();
    const { signal } = this.abortController;
    const win = typeof window !== 'undefined' ? window : globalThis.window;

    if (win && typeof win.addEventListener === 'function') {
      win.addEventListener('resize', () => this.handleWindowResize(), { signal });
      win.addEventListener('pointerdown', (e) => this.handleGlobalPointerDown(e), {
        signal,
        passive: true,
        capture: true,
      });
      win.addEventListener('keydown', (e) => this.handleGlobalKeyDown(e), { signal });
      win.addEventListener(
        'blur',
        () => {
          if (!this.pinnedPopoverId && this.activePopoverId) {
            this.hideAllPopovers();
          }
        },
        { signal }
      );
      const mql = win.matchMedia?.('(prefers-color-scheme: dark)');
      mql?.addEventListener?.('change', () => this.syncTheme(), { signal });
    }
    const doc = typeof document !== 'undefined' ? document : null;
    doc?.addEventListener?.(
      'visibilitychange',
      () => {
        if (doc.visibilityState === 'visible') {
          try {
            this.onVisibilityResume?.();
          } catch {}
          this.syncTheme();
          if (this.turnClockAnchor && (this.hasActiveWork || this.isStreaming || this.isSubagentRunning)) {
            this.tickTurnClock();
          }
        }
      },
      { signal }
    );

    if (this.shadow && typeof this.shadow.querySelectorAll === 'function') {
      const capsules = this.shadow.querySelectorAll('.capsule');
      capsules.forEach((capsule) => {
        if (typeof capsule.addEventListener !== 'function') return;
        capsule.addEventListener(
          'mousedown',
          (e) => {
            e.preventDefault();
          },
          { signal }
        );
        capsule.addEventListener('mouseenter', () => this.handleCapsuleHover(capsule), { signal });
        capsule.addEventListener('mouseleave', () => this.handleCapsuleLeave(), { signal });
        capsule.addEventListener('click', (e) => this.handleCapsuleClick(capsule, e), { signal });
        capsule.addEventListener('keydown', (e) => this.handleCapsuleKeydown(capsule, e), {
          signal,
        });
      });

      const popovers = this.shadow.querySelectorAll('.hud-popover');
      popovers.forEach((popover) => {
        if (typeof popover.addEventListener !== 'function') return;
        popover.addEventListener(
          'mouseenter',
          () => {
            if (this.hoverLeaveTimer) {
              clearTimeout(this.hoverLeaveTimer);
              this.hoverLeaveTimer = null;
            }
          },
          { signal }
        );
        popover.addEventListener(
          'mouseleave',
          () => {
            if (!this.pinnedPopoverId) {
              this.handleCapsuleLeave();
            }
          },
          { signal }
        );
      });
    }

    this.rebindResizeObserver(targetComposer);
  }

  rebindResizeObserver(targetComposer) {
    if (this.resizeObserver) {
      try {
        this.resizeObserver.disconnect();
      } catch {}
      this.resizeObserver = null;
    }
    if (typeof ResizeObserver === 'function' && targetComposer) {
      this.resizeObserver = new ResizeObserver((entries) => {
        const activeComposer = this.targetComposer || targetComposer;
        const boundedWidth = this.syncHorizontalBounds(activeComposer);
        if (boundedWidth > 0) {
          this.handleContainerResize(boundedWidth);
        } else {
          for (const entry of entries) {
            const width = entry.contentRect?.width ?? activeComposer.clientWidth ?? 0;
            if (width > 0) this.handleContainerResize(width);
          }
        }
        this.syncVerticalCentering();
      });
      try {
        this.resizeObserver.observe(targetComposer);
        const convPane = targetComposer.closest?.(
          '[data-testid="conversation-view"], [data-media-drop-scope="subpane"]'
        );
        if (convPane && convPane !== targetComposer) {
          this.resizeObserver.observe(convPane);
        }
        const splitRoot = targetComposer.closest?.('[data-split-root="true"]');
        if (splitRoot && splitRoot !== targetComposer && splitRoot !== convPane) {
          this.resizeObserver.observe(splitRoot);
        }
      } catch {}
    }
  }

  handleContainerResize(width) {
    if (!this.shadow) return;
    const container = this.getShadowEl('.hud-container');
    if (!container || !container.classList) return;

    let nextTier = 'full';
    if (width > 0 && width < 260) {
      nextTier = 'micro';
      container.classList.add('is-ultra-compact', 'is-micro-compact');
      container.classList.remove('is-compact', 'is-mid-compact');
    } else if (width >= 260 && width < 360) {
      nextTier = 'ultra';
      container.classList.add('is-ultra-compact');
      container.classList.remove('is-compact', 'is-mid-compact', 'is-micro-compact');
    } else if (width >= 360 && width <= 440) {
      nextTier = 'compact';
      container.classList.add('is-compact');
      container.classList.remove('is-ultra-compact', 'is-mid-compact', 'is-micro-compact');
    } else if (width > 440 && width <= 510) {
      nextTier = 'mid';
      container.classList.add('is-mid-compact');
      container.classList.remove('is-compact', 'is-ultra-compact', 'is-micro-compact');
    } else {
      container.classList.remove('is-compact', 'is-ultra-compact', 'is-mid-compact', 'is-micro-compact');
    }

    this.lastContainerWidthTier = nextTier;
    if (width > 0) this.lastReconcileWidth = width;

    if (this.activePopoverId) {
      this.repositionActivePopover(true);
    }
  }

  handleWindowResize() {
    this.syncVerticalCentering();
    if (this.targetComposer) {
      const width = this.syncHorizontalBounds(this.targetComposer);
      if (width > 0) {
        this.handleContainerResize(width);
      }
    }
    if (this.activePopoverId) {
      this.repositionActivePopover(true);
    }
  }

  handleCapsuleHover(capsule) {
    const id = capsule.getAttribute('data-capsule-id');
    if (!id) return;
    if (this.hoverLeaveTimer) {
      clearTimeout(this.hoverLeaveTimer);
      this.hoverLeaveTimer = null;
    }
    if (this.pinnedPopoverId && this.pinnedPopoverId !== id) {
      return;
    }
    if (this.activePopoverId === id) return;
    if (this.hoverEnterTimer) clearTimeout(this.hoverEnterTimer);
    this.hoverEnterTimer = setTimeout(() => {
      this.hoverEnterTimer = null;
      this.showPopover(id);
    }, 90);
  }

  handleCapsuleLeave() {
    if (this.hoverEnterTimer) {
      clearTimeout(this.hoverEnterTimer);
      this.hoverEnterTimer = null;
    }
    if (this.pinnedPopoverId) return;
    if (this.hoverLeaveTimer) clearTimeout(this.hoverLeaveTimer);
    this.hoverLeaveTimer = setTimeout(() => {
      this.hoverLeaveTimer = null;
      if (!this.pinnedPopoverId) {
        this.hideAllPopovers();
      }
    }, 150);
  }

  handleCapsuleClick(capsule, event) {
    event?.stopPropagation?.();
    const id = capsule.getAttribute('data-capsule-id');
    if (!id) return;
    if (this.hoverEnterTimer) {
      clearTimeout(this.hoverEnterTimer);
      this.hoverEnterTimer = null;
    }
    if (this.pinnedPopoverId === id) {
      this.pinnedPopoverId = null;
      this.hideAllPopovers();
    } else {
      this.pinnedPopoverId = id;
      this.showPopover(id);
    }
  }

  handleCapsuleKeydown(capsule, event) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.handleCapsuleClick(capsule, event);
    } else if (event.key === 'Escape') {
      this.pinnedPopoverId = null;
      this.hideAllPopovers();
    }
  }

  handleGlobalPointerDown(event) {
    if (!this.activePopoverId && !this.pinnedPopoverId) return;
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    if (this.host && path.includes(this.host)) return;
    this.pinnedPopoverId = null;
    this.hideAllPopovers();
  }

  handleGlobalKeyDown(event) {
    if (event.key === 'Escape' && (this.activePopoverId || this.pinnedPopoverId)) {
      this.pinnedPopoverId = null;
      this.hideAllPopovers();
    }
  }

  showPopover(id) {
    if (!this.shadow) return;
    if (this.onPopoverOpen) {
      try {
        this.onPopoverOpen(this.paneSlotId);
      } catch {}
    }
    this.activePopoverId = id;
    const capsules = this.getShadowCapsules();
    capsules.forEach((cap) => {
      const match = cap.getAttribute('data-capsule-id') === id;
      cap.setAttribute('aria-expanded', match ? 'true' : 'false');
      if (cap.classList) {
        if (match) cap.classList.add('is-active');
        else cap.classList.remove('is-active');
      }
    });

    const popovers = this.getShadowPopovers();
    popovers.forEach((pop) => {
      const match = pop.getAttribute('data-popover-id') === id;
      if (match) {
        pop.removeAttribute('hidden');
        try {
          if (typeof pop.showPopover === 'function') {
            pop.showPopover();
          }
        } catch {}
      } else {
        try {
          if (typeof pop.hidePopover === 'function') {
            pop.hidePopover();
          }
        } catch {}
        if (pop.classList) pop.classList.remove('is-visible');
        pop.setAttribute('hidden', '');
      }
    });

    // 先在未激活过渡态完成定位与祖先包含块校准，触发一次布局后再附加 is-visible 以保留 130ms 入场过渡动画
    this.repositionActivePopover(true);
    const activePop = this.getShadowEl(`#hud-popover-${id}`);
    if (activePop && activePop.classList) {
      void activePop.offsetWidth;
      activePop.classList.add('is-visible');
    }
  }

  repositionActivePopover(force = false) {
    if (!this.shadow || !this.activePopoverId) return;
    const id = this.activePopoverId;
    const capsule = this.getShadowEl(`.capsule[data-capsule-id="${id}"]`);
    const popover = this.getShadowEl(`#hud-popover-${id}`);
    const arrow = this.getShadowEl(`#arrow-${id}`);
    if (!capsule || !popover) return;

    const standardWidth = POPOVER_WIDTHS[id] || 296;
    const calcFn =
      typeof computeUpwardPopoverPosition === 'function'
        ? computeUpwardPopoverPosition
        : globalThis.__GRAVITYBOX_HUD_POPOVER__?.computeUpwardPopoverPosition;
    const applyFn =
      typeof applyPopoverGeometry === 'function'
        ? applyPopoverGeometry
        : globalThis.__GRAVITYBOX_HUD_POPOVER__?.applyPopoverGeometry;

    if (typeof calcFn === 'function') {
      const inner = this.getShadowEl(`#hud-popover-${id} .hud-popover-inner`);
      const innerHeight = typeof inner?.scrollHeight === 'number' && inner.scrollHeight > 40 ? inner.scrollHeight : 0;
      const rawHeight = innerHeight || (typeof popover.scrollHeight === 'number' && popover.scrollHeight > 40 ? popover.scrollHeight : 0);
      const measuredHeight = rawHeight > 40 ? Math.min(rawHeight, 480) : 195;
      const pos = calcFn(capsule, standardWidth, measuredHeight, 12, 8, 12);
      if (typeof applyFn === 'function') {
        applyFn(popover, arrow, pos, { force });
      }
    }
  }

  hideAllPopovers() {
    this.activePopoverId = null;
    this.pinnedPopoverId = null;
    if (!this.shadow || typeof this.shadow.querySelectorAll !== 'function') return;
    const resetGeoFn =
      typeof resetPopoverGeometryCache === 'function'
        ? resetPopoverGeometryCache
        : globalThis.__GRAVITYBOX_HUD_POPOVER__?.resetPopoverGeometryCache;
    const capsules = this.getShadowCapsules();
    capsules.forEach((cap) => {
      cap.setAttribute('aria-expanded', 'false');
      if (cap.classList) cap.classList.remove('is-active');
    });
    const popovers = this.getShadowPopovers();
    popovers.forEach((pop) => {
      try {
        if (typeof pop.hidePopover === 'function') {
          pop.hidePopover();
        }
      } catch {}
      if (typeof resetGeoFn === 'function') {
        resetGeoFn(pop);
      }
      if (pop.classList) pop.classList.remove('is-visible');
      pop.setAttribute('hidden', '');
    });
  }

  cleanupListeners() {
    this.stopTurnClock();
    if (this.hoverEnterTimer) {
      clearTimeout(this.hoverEnterTimer);
      this.hoverEnterTimer = null;
    }
    if (this.hoverLeaveTimer) {
      clearTimeout(this.hoverLeaveTimer);
      this.hoverLeaveTimer = null;
    }
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
  }

  dispose() {
    if (this.currentConvId) {
      this.emitBridgeEvent('SESSION_DETACHED');
    }
    this.cleanupListeners();
    if (this.host) {
      this.host.remove();
      this.host = null;
    }
    this.shadow = null;
    this.resetDomCache();
    this.targetComposer = null;
    this.hostMountedInDom = false;
    this.lastThemeSig = '';
    this.lastReconcileWidth = -1;
    this.lastContainerWidthTier = '';
    this.lastCenteringSig = '';
    this.activePopoverId = null;
    this.pinnedPopoverId = null;
  }
}

globalThis.__GRAVITYBOX_HUD_INSTANCE__ = { HudInstance };
