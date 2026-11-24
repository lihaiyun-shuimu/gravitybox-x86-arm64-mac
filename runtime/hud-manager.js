import { normalizeHudLocale } from './hud-i18n.js';
import { HudInstance } from './hud-instance.js';
import { computeUpwardPopoverPosition } from './hud-popover.js';

/**
 * 分栏多会话 HUD 顶层生命周期管理器 (AntigravityHudManager v2.1)
 * 支持双分栏多实例挂载、精确会话 UUID 解析、DOM 模型/流式/子智能体探针、路由安全守卫与无损销毁
 */

const RESTRICTED_HUD_ROUTE = /^\/(?:onboarding|oauth|auth|login|sign-in|api|browser|preview)(?:\/|$)/i;

const NON_RUNNING_AGENT_STATUS_TESTIDS = new Set([
  'agent-status-done',
  'agent-status-killed',
  'agent-status-canceled',
  'agent-status-error',
  'agent-status-failed',
  'agent-status-waiting',
  'agent-status-blocked',
  'agent-status-paused',
]);

const NON_RUNNING_AGENT_STATUS_SELECTOR = [...NON_RUNNING_AGENT_STATUS_TESTIDS]
  .map((id) => `[data-testid="${id}"]`)
  .join(', ');

const NON_RUNNING_AGENT_DOT_STATE_RE =
  /^(?:idle|done|completed|paused|stopped|error|failed|canceled|cancelled|killed|inactive|none|false|0|waiting|standing[\s_-]*by|blocked|needs[\s_-]*(?:you|attention|approval|input))$/i;

const NESTED_SUBPANE_SELECTOR =
  '[data-media-drop-scope="subpane"], [data-testid="subagent-tab-conversation"], [data-testid="side-question-tab-conversation"], [data-testid="side-question-tab-content"]';

const SIDE_QUESTION_HEADER_BUTTON_TESTIDS = new Set([
  'side-question-tab-stop',
  'side-question-tab-promote',
  'side-question-tab-delete',
]);

const URGENT_CHILD_MUTATION_SELECTOR =
  'button, [role="button"], .surface-composer, .model-selector, [data-testid="agent-input-box"], [data-testid="conversation-view"], [data-testid="subagent-tab-conversation"], [data-testid="side-question-tab-conversation"], [data-media-drop-scope="subpane"], [data-testid="input-cancel-button"], [data-testid="agent-loading"], [data-testid="ephemeral-tool-status"], [data-testid="idle-status-text"], [data-testid="model-selector-trigger"], [data-testid="running-subagent-steps-toggle"], [data-testid="running-subagent-browser-steps"], [data-testid="browser-subagent-thinking"], [data-cascade-id], [data-conversation-id], [data-subagent-id]';

const URGENT_TARGET_ANCESTOR_SELECTOR =
  '.surface-composer, .model-selector, [data-testid="agent-input-box"], [data-testid="model-selector-trigger"], [data-testid="idle-status-text"], [data-testid="ephemeral-tool-status"], [data-testid="agent-loading"]';

const GLOBAL_MODEL_TRIGGER_SELECTOR =
  '[data-testid="model-selector-trigger"], .model-selector, button[data-context-window], button[aria-label*="Select model"], button[aria-label*="选择模型"]';

export class AntigravityHudManager {
  constructor(options = {}) {
    this.instances = new Map();
    this.viewToSlotId = typeof WeakMap === 'function' ? new WeakMap() : null;
    this.nextSlotSeq = 1;
    this.nextRevisionCounter = Number(globalThis.__GRAVITYBOX_HUD_REVISION__) || 0;
    this.mutationObserver = null;
    this.themeObserver = null;
    this.composerTextObservers = new Map();
    this.domReadyAbort = null;
    this.visibilityHandler = null;
    this.reconcileTimer = null;
    this.routeTimer = null;
    this.active = false;
    this.enabled = options.enabled !== false;
    this.routeExcluded = false;
    this.locale = normalizeHudLocale(options.locale || options.languageMode || 'zh-Hans');
    this.languageMode = this.locale === 'zh-Hans' ? 'zh' : this.locale;
    this.onBridgeEvent = typeof options.onBridgeEvent === 'function' ? options.onBridgeEvent : null;
  }

  allocateSessionRevision() {
    this.nextRevisionCounter = Math.max(this.nextRevisionCounter, Number(globalThis.__GRAVITYBOX_HUD_REVISION__) || 0) + 1;
    globalThis.__GRAVITYBOX_HUD_REVISION__ = this.nextRevisionCounter;
    return this.nextRevisionCounter;
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.checkRoute();

    const attachDomObservers = () => {
      if (!this.active || this.mutationObserver) return;
      if (typeof document === 'undefined' || !document.body) return;
      if (this.enabled && !this.routeExcluded) {
        this.reconcileMounts();
      }
      if (typeof MutationObserver !== 'function') return;
      const isUrgentChildElement = (node) => {
        if (!node || node.nodeType !== 1) return false;
        if (
          node.tagName === 'BUTTON' ||
          node.getAttribute?.('role') === 'button' ||
          node.hasAttribute?.('data-testid') ||
          node.hasAttribute?.('data-cascade-id') ||
          node.hasAttribute?.('data-conversation-id') ||
          node.hasAttribute?.('data-subagent-id') ||
          node.hasAttribute?.('data-media-drop-scope') ||
          node.hasAttribute?.('data-model-id') ||
          node.hasAttribute?.('data-context-window') ||
          node.matches?.(URGENT_CHILD_MUTATION_SELECTOR)
        ) {
          return true;
        }
        return Boolean(node.querySelector?.(URGENT_CHILD_MUTATION_SELECTOR));
      };
      const isUrgentChildMutation = (m, t) => {
        if (
          !t ||
          t === document.body ||
          t === document.documentElement ||
          t.tagName === 'BUTTON' ||
          t.getAttribute?.('role') === 'button' ||
          t.hasAttribute?.('data-cascade-id') ||
          t.hasAttribute?.('data-conversation-id') ||
          t.hasAttribute?.('data-subagent-id') ||
          t.hasAttribute?.('data-media-drop-scope') ||
          t.closest?.(URGENT_TARGET_ANCESTOR_SELECTOR)
        ) {
          return true;
        }
        const lists = [m.addedNodes, m.removedNodes];
        for (const list of lists) {
          if (!list || !list.length) continue;
          const limit = Math.min(list.length, 16);
          for (let i = 0; i < limit; i++) {
            if (isUrgentChildElement(list[i])) return true;
          }
        }
        return false;
      };
      this.mutationObserver = new MutationObserver((mutations) => {
        if (!this.active || !this.enabled) return;
        if (this.reconcileTimer !== null) return;
        let hasUrgent = false;
        let hasAttrMutation = false;
        let hasContentChildList = false;
        if (Array.isArray(mutations) && mutations.length > 0) {
          let hasRelevant = false;
          for (const m of mutations) {
            const t = m?.target;
            if (
              t &&
              (t.classList?.contains?.('__gravitybox_hud_host__') ||
                t.closest?.('.__gravitybox_hud_host__'))
            ) {
              continue;
            }
            if (m?.type === 'childList') {
              hasRelevant = true;
              if (!hasUrgent) {
                if (isUrgentChildMutation(m, t)) hasUrgent = true;
                else hasContentChildList = true;
              }
              continue;
            }
            const attr = m?.attributeName || '';
            // attributeFilter 仅监听 data-*、hidden 与 aria-label：非 aria-label 属性全部视为紧急状态变化
            if (attr !== 'aria-label') {
              hasRelevant = true;
              hasUrgent = true;
              hasAttrMutation = true;
              continue;
            }
            if (
              !t ||
              t === document.body ||
              t === document.documentElement ||
              typeof t.matches !== 'function'
            ) {
              hasRelevant = true;
              hasAttrMutation = true;
              continue;
            }
            if (
              t.tagName === 'BUTTON' ||
              t.getAttribute?.('role') === 'button' ||
              t.hasAttribute?.('data-testid') ||
              t.hasAttribute?.('data-cascade-id') ||
              t.hasAttribute?.('data-conversation-id') ||
              t.hasAttribute?.('data-subagent-id') ||
              t.hasAttribute?.('data-media-drop-scope') ||
              t.matches(
                '.surface-composer, .model-selector, .animate-shimmer-text, .animate-spin, .codicon-loading, .spinner'
              ) ||
              t.closest?.(
                '[data-testid="idle-status-text"], [data-testid="ephemeral-tool-status"], [data-testid="agent-loading"], [data-testid="model-selector-trigger"], .surface-composer'
              )
            ) {
              hasRelevant = true;
              hasAttrMutation = true;
              if (t.tagName === 'BUTTON' || attr === 'aria-label') hasUrgent = true;
            }
          }
          if (!hasRelevant) return;
        } else {
          hasUrgent = true;
        }

        const delayMs = hasUrgent ? 20 : hasContentChildList && !hasAttrMutation ? 140 : 60;
        this.reconcileTimer = setTimeout(() => {
          this.reconcileTimer = null;
          this.checkRoute();
          if (this.enabled && !this.routeExcluded) {
            this.reconcileMounts();
          }
        }, delayMs);
      });
      this.mutationObserver.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: [
          'data-cascade-id',
          'data-conversation-id',
          'data-context-window',
          'data-model-id',
          'data-state',
          'data-streaming',
          'data-testid',
          'data-theme',
          'data-subagent-id',
          'data-agent-state',
          'data-agent-state-dot',
          'data-side-panel-open',
          'data-aux-pane-open',
          'data-split-transition',
          'aria-label',
          'hidden',
        ],
      });
      // 仅对根节点 (document.body / document.documentElement, subtree: false) 监听主题 class/style，避免流式光标/动画引发全子树回调风暴
      this.themeObserver = new MutationObserver(() => {
        if (!this.active || !this.enabled || this.reconcileTimer !== null) return;
        this.reconcileTimer = setTimeout(() => {
          this.reconcileTimer = null;
          this.checkRoute();
          if (this.enabled && !this.routeExcluded) {
            this.reconcileMounts();
          }
        }, 60);
      });
      try {
        this.themeObserver.observe(document.body, {
          attributes: true,
          attributeFilter: ['class', 'data-theme', 'style', 'hidden'],
        });
      } catch {}
      if (document.documentElement && typeof document.documentElement.nodeType === 'number') {
        try {
          this.themeObserver.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['class', 'data-theme', 'style', 'hidden'],
          });
        } catch {}
      }
      if (!this.visibilityHandler && typeof document.addEventListener === 'function') {
        this.visibilityHandler = () => {
          if (!this.active || document.hidden === true) return;
          this.checkRoute();
          if (this.enabled && !this.routeExcluded) {
            this.reconcileMounts();
          }
        };
        document.addEventListener('visibilitychange', this.visibilityHandler);
      }
    };

    if (typeof document !== 'undefined' && document.body) {
      attachDomObservers();
    } else if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      this.domReadyAbort = new AbortController();
      window.addEventListener(
        'DOMContentLoaded',
        () => {
          this.domReadyAbort = null;
          attachDomObservers();
        },
        { once: true, signal: this.domReadyAbort.signal }
      );
    }

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      this.routeTimer = setInterval(() => {
        if (this.active) {
          if (typeof document !== 'undefined' && document.hidden === true) return;
          if (!this.mutationObserver && typeof document !== 'undefined' && document.body) {
            attachDomObservers();
          }
          this.checkRoute();
          if (this.enabled && !this.routeExcluded) this.reconcileMounts();
        }
      }, 650);
      if (typeof this.routeTimer?.unref === 'function') {
        this.routeTimer.unref();
      }
    }
  }

  setEnabled(enabled) {
    const next = Boolean(enabled);
    if (this.enabled === next) return;
    this.enabled = next;
    if (!this.enabled) {
      if (this.reconcileTimer !== null) {
        clearTimeout(this.reconcileTimer);
        this.reconcileTimer = null;
      }
      this.clearComposerTextObservers();
      for (const instance of this.instances.values()) {
        instance.dispose();
      }
      this.instances.clear();
    } else if (this.active && !this.routeExcluded) {
      this.reconcileMounts();
    }
  }

  syncAllSessions() {
    if (!this.active || !this.enabled || this.routeExcluded) return;
    this.reconcileMounts();
    for (const instance of this.instances.values()) {
      // 推进单调刷新代际 (sessionRevision)，避免清零 lastMetricsSequence 后被旧在途轮询包短暂覆盖最新视图
      instance.requestRefresh?.({ bumpRevision: true });
    }
  }

  checkRoute() {
    if (typeof location === 'undefined') return;
    const restricted = RESTRICTED_HUD_ROUTE.test(location.pathname || '');
    this.setRouteExcluded(restricted);
  }

  setRouteExcluded(excluded) {
    const next = Boolean(excluded);
    if (this.routeExcluded === next) return;
    this.routeExcluded = next;
    if (this.routeExcluded) {
      if (this.reconcileTimer !== null) {
        clearTimeout(this.reconcileTimer);
        this.reconcileTimer = null;
      }
      this.clearComposerTextObservers();
      for (const instance of this.instances.values()) {
        instance.dispose();
      }
      this.instances.clear();
    } else if (this.active && this.enabled) {
      this.reconcileMounts();
    }
  }

  setLanguage(mode) {
    const resolved = normalizeHudLocale(mode);
    const next = resolved === 'zh-Hans' ? 'zh' : resolved;
    this.locale = resolved;
    this.languageMode = next;
    for (const instance of this.instances.values()) {
      instance.setLanguage(resolved);
    }
  }

  handleInstancePopoverOpen(originSlotId) {
    for (const [slotId, inst] of this.instances.entries()) {
      if (slotId !== originSlotId && typeof inst?.hideAllPopovers === 'function') {
        inst.hideAllPopovers();
      }
    }
  }

  clearComposerTextObservers() {
    for (const obs of this.composerTextObservers.values()) {
      try {
        obs.disconnect();
      } catch {}
    }
    this.composerTextObservers.clear();
  }

  handleComposerTextMutations(mutations) {
    if (!this.active || !this.enabled || this.routeExcluded || this.reconcileTimer !== null) return;
    if (!Array.isArray(mutations) || mutations.length === 0) return;

    let hasRelevant = false;
    for (const m of mutations) {
      if (m?.type !== 'characterData') continue;
      const parent = m.target?.parentElement || m.target?.parentNode;
      if (!parent) continue;
      if (
        parent.classList?.contains?.('__gravitybox_hud_host__') ||
        parent.closest?.('.__gravitybox_hud_host__')
      ) {
        continue;
      }
      if (parent.closest?.('[contenteditable="true"], textarea, input')) {
        continue;
      }
      if (
        parent.closest?.(
          'button, [role="button"], .model-selector, [data-testid="model-selector-trigger"]'
        )
      ) {
        hasRelevant = true;
        break;
      }
    }
    if (!hasRelevant) return;

    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = null;
      this.checkRoute();
      if (this.active && this.enabled && !this.routeExcluded) {
        this.reconcileMounts();
      }
    }, 20);
  }

  syncComposerTextObservers(activeComposers) {
    const canObserve =
      typeof MutationObserver === 'function' && this.active && this.enabled && !this.routeExcluded;
    for (const [composer, obs] of this.composerTextObservers.entries()) {
      if (!canObserve || !activeComposers.has(composer)) {
        try {
          obs.disconnect();
        } catch {}
        this.composerTextObservers.delete(composer);
      }
    }
    if (!canObserve) return;

    for (const composer of activeComposers) {
      if (this.composerTextObservers.has(composer)) continue;
      const obs = new MutationObserver((mutations) => this.handleComposerTextMutations(mutations));
      try {
        obs.observe(composer, { characterData: true, subtree: true });
        this.composerTextObservers.set(composer, obs);
      } catch {
        try {
          obs.disconnect();
        } catch {}
      }
    }
  }

  /**
   * 扫描并协调所有活跃会话分栏 (支持传入模拟 views 列表或自动从 document 查询)
   */
  reconcileMounts(explicitViews = null) {
    if (this.routeExcluded || !this.enabled) return;
    const InstanceCtor =
      typeof HudInstance === 'function'
        ? HudInstance
        : globalThis.__GRAVITYBOX_HUD_INSTANCE__?.HudInstance;
    if (!InstanceCtor) return;

    let views = explicitViews;
    if (!views && typeof document !== 'undefined') {
      const found = [...document.querySelectorAll('[data-testid="conversation-view"]')];
      const subConvs = [
        ...document.querySelectorAll(
          '[data-testid="subagent-tab-conversation"][data-cascade-id], [data-testid="side-question-tab-conversation"][data-cascade-id]'
        ),
      ];
      for (const subConv of subConvs) {
        const subpane = subConv.closest?.('[data-media-drop-scope="subpane"]') || subConv.parentElement;
        if (!subpane || found.includes(subpane)) continue;
        if (this.isSubpaneVisible(subpane)) {
          found.push(subpane);
        }
      }
      if (found.length > 0) {
        views = found;
      } else {
        const standaloneBoxes = [...document.querySelectorAll('[data-testid="agent-input-box"]')];
        if (standaloneBoxes.length > 0) {
          views = standaloneBoxes.map((box) => box.parentElement || box);
        }
      }
    }
    if (!views || !views.length) {
      this.clearComposerTextObservers();
      for (const [id, instance] of this.instances.entries()) {
        instance.dispose();
        this.instances.delete(id);
      }
      return;
    }

    const panes = views
      .filter(Boolean)
      .map((view, index) => {
        const viewTestId = view?.getAttribute?.('data-testid');
        const isMainConvView = viewTestId === 'conversation-view';
        const subagentConvNode =
          viewTestId === 'subagent-tab-conversation'
            ? view
            : !isMainConvView
            ? this.findVisibleOrFirst(view, '[data-testid="subagent-tab-conversation"][data-cascade-id]')
            : null;
        const btwConvNode =
          viewTestId === 'side-question-tab-conversation'
            ? view
            : !isMainConvView
            ? this.findVisibleOrFirst(view, '[data-testid="side-question-tab-conversation"][data-cascade-id]')
            : null;
        const activeBtw = btwConvNode && this.isNodeVisibleInDom(btwConvNode, view) ? btwConvNode : null;
        const activeSub =
          subagentConvNode && this.isNodeVisibleInDom(subagentConvNode, view) ? subagentConvNode : null;
        const subConvNode = activeBtw || activeSub || btwConvNode || subagentConvNode;
        const resolvedSubTestId = subConvNode?.getAttribute?.('data-testid');
        const paneKind = isMainConvView
          ? 'main'
          : resolvedSubTestId === 'side-question-tab-conversation'
          ? 'btw'
          : resolvedSubTestId === 'subagent-tab-conversation'
          ? 'subagent'
          : viewTestId === 'side-question-tab-content'
          ? 'btw'
          : view?.getAttribute?.('data-media-drop-scope') === 'subpane'
          ? 'subagent'
          : 'main';
        const isSubpane = paneKind !== 'main';
        const rawCascadeId =
          subConvNode?.getAttribute?.('data-cascade-id') || view.getAttribute?.('data-cascade-id');
        let slotId = this.viewToSlotId.get(view);
        if (!slotId) {
          slotId = `slot-${this.nextSlotSeq++}`;
          this.viewToSlotId.set(view, slotId);
        }
        return {
          view,
          index,
          paneKind,
          isSubpane,
          subConvNode,
          rawCascadeId,
          slotId,
          composer:
            this.resolveComposerElement(subConvNode || view) ||
            (subConvNode && subConvNode !== view ? this.resolveComposerElement(view) : null),
        };
      })
      .filter((p) => p.composer);
    const activeSlots = new Set(panes.map((p) => p.slotId));
    for (const [slot, instance] of this.instances) {
      if (!activeSlots.has(slot)) {
        instance.dispose();
        this.instances.delete(slot);
      }
    }
    this.syncComposerTextObservers(new Set(panes.map((p) => p.composer)));
    const mainPaneCount = panes.filter((p) => !p.isSubpane).length;
    const sharedGlobalSubagentIds = mainPaneCount <= 1 ? this.collectDomSubagentIds() : null;
    for (const { view, index, paneKind, isSubpane, rawCascadeId, slotId, composer } of panes) {
      const domSubagentIds = isSubpane
        ? []
        : sharedGlobalSubagentIds ?? this.collectDomSubagentIds(view, mainPaneCount);
      const effectiveViewCount = isSubpane ? Math.max(2, views.length) : Math.max(1, mainPaneCount);
      const convId = this.resolveConversationId(view, rawCascadeId, effectiveViewCount, isSubpane);
      const modelId = this.resolveActiveModel(view, effectiveViewCount);
      const modelCapacity = this.resolveActiveModelCapacity(view, effectiveViewCount);
      const sharedButtons =
        typeof view.querySelectorAll === 'function' ? view.querySelectorAll('button, [role="button"]') : null;
      const subagentState = this.resolveSubagentState(view, {
        isSubpane,
        paneKind,
        buttons: sharedButtons,
      });
      const activityPhase = this.resolveActivityPhase(view, subagentState, {
        isSubpane,
        paneKind,
        buttons: sharedButtons,
      });
      const isStreaming = activityPhase !== 'idle';
      let instance = this.instances.get(slotId);
      if (!instance) {
        instance = new InstanceCtor(slotId, {
          paneSlotId: slotId,
          isPrimaryPane: index === 0 && !isSubpane,
          isSubpane,
          paneKind,
          locale: this.locale,
          languageMode: this.languageMode,
          onBridgeEvent: this.onBridgeEvent,
          onPopoverOpen: (origin) => this.handleInstancePopoverOpen(origin),
          allocateRevision: () => this.allocateSessionRevision(),
        });
        this.instances.set(slotId, instance);
        instance.mount(composer);
      } else {
        instance.reconcile(composer);
      }
      instance.isSubpane = isSubpane;
      instance.paneKind = paneKind;
      if (!convId) {
        if (instance.currentConvId) {
          instance.emitBridgeEvent('SESSION_DETACHED');
        }
        instance.resetToEmptyState
          ? instance.resetToEmptyState()
          : ((instance.currentConvId = null), instance.renderSkeleton());
        continue;
      }
      if (instance.getCurrentConvId() !== convId) {
        instance.switchConversation(
          convId,
          modelId,
          isStreaming,
          subagentState.isSubagentRunning,
          subagentState.runningSubagentCount,
          domSubagentIds,
          activityPhase,
          modelCapacity
        );
      } else {
        instance.notifyModelOrStreamingChange(
          modelId,
          isStreaming,
          subagentState.isSubagentRunning,
          subagentState.runningSubagentCount,
          domSubagentIds,
          activityPhase,
          modelCapacity
        );
      }
    }
  }

  isSubpaneVisible(subpane) {
    if (!subpane || typeof subpane.getBoundingClientRect !== 'function') return false;
    const win = typeof window !== 'undefined' ? window : globalThis.window;
    const vw = Number(win?.innerWidth) || 0;
    if (win && typeof win.getComputedStyle === 'function') {
      try {
        const cs = win.getComputedStyle(subpane);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') {
          return false;
        }
      } catch {}
    }
    const rect = subpane.getBoundingClientRect();
    if (!rect || rect.width < 120 || rect.height < 120) return false;
    if (vw > 0 && (rect.left >= vw - 8 || rect.right <= 8)) return false;
    return true;
  }

  isNodeVisibleInDom(el, stopAt = null) {
    if (!el) return false;
    const win = typeof window !== 'undefined' ? window : globalThis.window;
    let cursor = el;
    let depth = 0;
    while (cursor && cursor !== stopAt && depth++ < 8) {
      if (cursor.hasAttribute?.('hidden')) return false;
      if (win && typeof win.getComputedStyle === 'function') {
        try {
          const cs = win.getComputedStyle(cursor);
          if (cs?.display === 'none' || cs?.visibility === 'hidden') return false;
        } catch {}
      }
      cursor = cursor.parentElement || null;
    }
    return true;
  }

  findVisibleOrFirst(root, selector) {
    if (!root) return null;
    if (typeof root.querySelectorAll === 'function') {
      const matches = root.querySelectorAll(selector);
      if (matches) {
        const list =
          typeof matches[Symbol.iterator] === 'function' ? [...matches] : Array.from(matches);
        let first = null;
        for (const el of list) {
          if (!el) continue;
          if (!first) first = el;
          if (this.isNodeVisibleInDom(el, root)) return el;
        }
        if (first) return first;
      }
    }
    return typeof root.querySelector === 'function' ? root.querySelector(selector) : null;
  }

  isInsideNestedSubpane(view, node) {
    if (!node || typeof node.closest !== 'function') return false;
    const nested = node.closest(NESTED_SUBPANE_SELECTOR);
    return Boolean(nested && nested !== view);
  }

  inferPaneContext(view, options = {}) {
    const viewTestId = view?.getAttribute?.('data-testid');
    const needsSubTabProbe =
      !options?.paneKind &&
      options?.isSubpane !== false &&
      viewTestId !== 'conversation-view' &&
      viewTestId !== 'side-question-tab-conversation' &&
      viewTestId !== 'subagent-tab-conversation';
    const btwNode = needsSubTabProbe
      ? this.findVisibleOrFirst(view, '[data-testid="side-question-tab-conversation"]')
      : null;
    const subNode = needsSubTabProbe
      ? this.findVisibleOrFirst(view, '[data-testid="subagent-tab-conversation"]')
      : null;
    const activeSubTabKind =
      btwNode && this.isNodeVisibleInDom(btwNode, view)
        ? 'btw'
        : subNode && this.isNodeVisibleInDom(subNode, view)
        ? 'subagent'
        : btwNode
        ? 'btw'
        : subNode
        ? 'subagent'
        : null;
    const inferredPaneKind =
      options?.paneKind ||
      (options?.isSubpane === false
        ? 'main'
        : viewTestId === 'conversation-view'
        ? 'main'
        : viewTestId === 'side-question-tab-conversation'
        ? 'btw'
        : viewTestId === 'subagent-tab-conversation'
        ? 'subagent'
        : activeSubTabKind
        ? activeSubTabKind
        : viewTestId === 'side-question-tab-content'
        ? 'btw'
        : view?.getAttribute?.('data-media-drop-scope') === 'subpane'
        ? 'subagent'
        : options?.isSubpane
        ? 'subagent'
        : 'main');
    const isSubpane =
      typeof options?.isSubpane === 'boolean' ? options.isSubpane : inferredPaneKind !== 'main';
    const isBtwPane = inferredPaneKind === 'btw';
    const isSubagentPane = isSubpane && !isBtwPane;
    return { paneKind: inferredPaneKind, isSubpane, isBtwPane, isSubagentPane };
  }

  pickNonNested(view, selector) {
    if (!view || typeof view.querySelector !== 'function') return null;
    const isMainConv = view.getAttribute?.('data-testid') === 'conversation-view';
    if (!isMainConv) {
      return this.findVisibleOrFirst(view, selector);
    }
    if (typeof view.querySelectorAll !== 'function') {
      return view.querySelector(selector);
    }
    const matches = view.querySelectorAll(selector);
    if (!matches) return null;
    const list = typeof matches[Symbol.iterator] === 'function' ? [...matches] : [];
    for (const el of list) {
      if (!this.isInsideNestedSubpane(view, el)) return el;
    }
    return null;
  }

  collectDomSubagentIds(scopedView = null, mainPaneCount = 1) {
    const ids = new Set();
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const useScopedOnly = Boolean(scopedView && mainPaneCount > 1);
    if (!useScopedOnly) {
      const loc =
        typeof window !== 'undefined' && window.location
          ? window.location
          : globalThis.window?.location;
      if (loc && typeof loc.search === 'string' && loc.search.includes('subagent_convo__')) {
        const matches = loc.search.matchAll(/subagent_convo__([0-9a-f-]{36})/gi);
        for (const m of matches) {
          if (m[1] && uuidRe.test(m[1])) ids.add(m[1].toLowerCase());
        }
      }
    }
    const queryRoot =
      useScopedOnly && typeof scopedView.querySelectorAll === 'function'
        ? scopedView
        : !useScopedOnly && typeof document !== 'undefined' && typeof document.querySelectorAll === 'function'
        ? document
        : null;
    if (queryRoot) {
      const nodes = queryRoot.querySelectorAll(
        '[data-testid="subagent-tab-conversation"][data-cascade-id], [id^="subagentView-"]'
      );
      if (nodes && typeof nodes.forEach === 'function') {
        nodes.forEach((n) => {
          if (typeof n?.closest === 'function') {
            const btwAncestor = n.closest(
              '[data-testid="side-question-tab-content"], [data-testid="side-question-tab-conversation"]'
            );
            if (btwAncestor && btwAncestor !== scopedView) return;
          }
          const cid = n.getAttribute?.('data-cascade-id') || '';
          if (uuidRe.test(cid)) ids.add(cid.toLowerCase());
          const rawId = n.getAttribute?.('id') || '';
          if (rawId.startsWith('subagentView-')) {
            const sub = rawId.slice('subagentView-'.length);
            if (uuidRe.test(sub)) ids.add(sub.toLowerCase());
          }
        });
      }
    }
    return [...ids];
  }

  resolveComposerElement(view) {
    if (!view || typeof view.querySelector !== 'function') return null;
    return (
      this.pickNonNested(view, '[data-testid="agent-input-box"] > .surface-composer') ||
      this.pickNonNested(view, '[data-testid="agent-input-box"] .surface-composer') ||
      this.pickNonNested(view, '.surface-composer') ||
      this.pickNonNested(view, '[data-testid="agent-input-box"]') ||
      (view.matches?.('[data-testid="agent-input-box"]') ? view : null)
    );
  }

  /**
   * 精确解析每个分栏对应的会话 UUID：
   * 1. data-conversation-id 属性
   * 2. 分栏自身携带的非默认 data-cascade-id（修复双分栏下被 window.location 覆盖的缺陷）
   * 3. 分栏内部 /c/<uuid> 锚点
   * 4. 单栏模式下回退至 window.location.pathname 中的 /c/<uuid>
   */
  resolveConversationId(view, rawCascadeId, totalViews = 1, isSubpane = null) {
    const viewTestId = view?.getAttribute?.('data-testid');
    const subpaneDetected = isSubpane !== null
      ? Boolean(isSubpane)
      : Boolean(
          view?.getAttribute?.('data-media-drop-scope') === 'subpane' ||
          viewTestId === 'subagent-tab-conversation' ||
          viewTestId === 'side-question-tab-conversation' ||
          viewTestId === 'side-question-tab-content' ||
          (viewTestId !== 'conversation-view' &&
            this.findVisibleOrFirst(
              view,
              '[data-testid="subagent-tab-conversation"][data-cascade-id], [data-testid="side-question-tab-conversation"][data-cascade-id]'
            ))
        );
    const allowUrl = totalViews === 1 && !subpaneDetected;
    if (view && typeof view.getAttribute === 'function') {
      const directId = view.getAttribute('data-conversation-id');
      if (directId && directId !== 'conversation') return directId;
    }
    const effectiveCascadeId =
      rawCascadeId ||
      view?.getAttribute?.('data-cascade-id') ||
      (viewTestId !== 'conversation-view'
        ? this.findVisibleOrFirst(
            view,
            '[data-testid="side-question-tab-conversation"][data-cascade-id], [data-testid="subagent-tab-conversation"][data-cascade-id]'
          )?.getAttribute?.('data-cascade-id')
        : null) ||
      null;
    if (
      effectiveCascadeId &&
      effectiveCascadeId !== 'conversation' &&
      effectiveCascadeId !== 'default' &&
      !effectiveCascadeId.startsWith('fallback-pane-') &&
      !effectiveCascadeId.startsWith('pane-')
    ) {
      const loc =
        typeof window !== 'undefined' && window.location
          ? window.location
          : globalThis.window?.location;
      const urlMatch =
        allowUrl && loc && typeof loc.pathname === 'string'
          ? loc.pathname.match(/\/c\/([a-zA-Z0-9_-]+)/)
          : null;
      if (urlMatch && urlMatch[1] && urlMatch[1] !== '_new' && !/^[0-9a-f-]{36}$/i.test(effectiveCascadeId)) {
        return urlMatch[1];
      }
      return effectiveCascadeId;
    }
    if (view && typeof view.querySelector === 'function') {
      const anchor = this.pickNonNested(
        view,
        '[data-testid="conversation-header"] a[href*="/c/"], a[data-conversation-link][href*="/c/"]'
      );
      if (anchor) {
        const href = anchor.getAttribute?.('href') || anchor.href || '';
        const match = String(href).match(/\/c\/([a-zA-Z0-9_-]+)/);
        if (match && match[1] && match[1] !== '_new') return match[1];
      }
    }
    if (allowUrl) {
      const loc =
        typeof window !== 'undefined' && window.location
          ? window.location
          : globalThis.window?.location;
      if (loc && typeof loc.pathname === 'string') {
        const urlMatch = loc.pathname.match(/\/c\/([a-zA-Z0-9_-]+)/);
        if (urlMatch && urlMatch[1] && urlMatch[1] !== '_new') return urlMatch[1];
      }
    }
    return totalViews > 1 ? null : 'default';
  }

  parseContextWindowTokens(raw) {
    if (typeof raw === 'number') {
      const rounded = Math.round(raw);
      return Number.isSafeInteger(rounded) && rounded >= 4096 && rounded <= 10_000_000 ? rounded : undefined;
    }
    if (typeof raw !== 'string') return undefined;
    const cleaned = raw.trim().replace(/,/g, '');
    if (!cleaned) return undefined;
    const match = cleaned.match(/^(\d+(?:\.\d+)?)\s*([kKmM])?(?:\s*(?:tok|tokens))?$/);
    if (!match) return undefined;
    const num = Number(match[1]);
    if (!Number.isFinite(num) || num <= 0) return undefined;
    const unit = (match[2] || '').toLowerCase();
    const mult = unit === 'm' ? 1_000_000 : unit === 'k' ? 1_000 : 1;
    const tokens = Math.round(num * mult);
    return Number.isSafeInteger(tokens) && tokens >= 4096 && tokens <= 10_000_000 ? tokens : undefined;
  }

  findGlobalNonSubpaneModelTrigger() {
    if (typeof document === 'undefined') return null;
    if (typeof document.querySelectorAll === 'function') {
      const matches = document.querySelectorAll(GLOBAL_MODEL_TRIGGER_SELECTOR);
      if (matches) {
        const list =
          typeof matches[Symbol.iterator] === 'function' ? [...matches] : Array.from(matches);
        for (const el of list) {
          if (!el) continue;
          if (typeof el.closest === 'function' && el.closest(NESTED_SUBPANE_SELECTOR)) continue;
          return el;
        }
        return null;
      }
    }
    const fallback =
      typeof document.querySelector === 'function'
        ? document.querySelector(GLOBAL_MODEL_TRIGGER_SELECTOR)
        : null;
    if (fallback && typeof fallback.closest === 'function' && fallback.closest(NESTED_SUBPANE_SELECTOR)) {
      return null;
    }
    return fallback;
  }

  findModelSelectorTrigger(view, totalViews = 1) {
    if (!view || typeof view.querySelector !== 'function') return null;
    const localTrigger =
      this.pickNonNested(view, '[data-testid="model-selector-trigger"]') ||
      this.pickNonNested(view, '.model-selector') ||
      this.pickNonNested(
        view,
        'button[data-context-window], button[data-model-id], button[aria-label*="Select model"], button[aria-label*="选择模型"]'
      );
    if (localTrigger) return localTrigger;
    if (totalViews === 1 && typeof document !== 'undefined') {
      return this.findGlobalNonSubpaneModelTrigger();
    }
    return null;
  }

  resolveActiveModelCapacity(view, totalViews = 1) {
    const trigger = this.findModelSelectorTrigger(view, totalViews);
    if (!trigger || typeof trigger.getAttribute !== 'function') return undefined;
    const raw = trigger.getAttribute('data-context-window');
    return this.parseContextWindowTokens(raw);
  }

  resolveActiveModel(view, totalViews = 1) {
    if (!view || typeof view.querySelector !== 'function') return '';
    const isMainConv = view.getAttribute?.('data-testid') === 'conversation-view';
    const localTrigger =
      this.pickNonNested(view, '[data-testid="model-selector-trigger"]') ||
      this.pickNonNested(view, '.model-selector') ||
      this.pickNonNested(
        view,
        'button[data-context-window], button[data-model-id], button[aria-label*="Select model"], button[aria-label*="选择模型"]'
      );

    const extractFromTrigger = (trigger) => {
      if (!trigger) return null;
      const dataModel =
        trigger.getAttribute?.('data-model-id') || trigger.getAttribute?.('data-value');
      if (dataModel && dataModel.trim()) return dataModel.trim();

      const aria = trigger.getAttribute?.('aria-label') || trigger.getAttribute?.('title') || '';
      const ariaMatch = aria.match(/(?:current:|当前[：:])\s*(.+)$/i);
      if (ariaMatch && ariaMatch[1]) return ariaMatch[1].trim();

      const text = (trigger.textContent || '').replace(/\s+/g, ' ').trim();
      if (text && !/^(Model|模型|Select model|选择模型)$/i.test(text)) {
        return text;
      }
      return null;
    };

    const localModel = extractFromTrigger(localTrigger);
    if (localModel) return localModel;

    // 优先扫描当前分栏内部的工具栏模型按钮，避免双分栏/子分栏被全局 document 覆盖
    if (typeof view.querySelectorAll === 'function') {
      const buttons = view.querySelectorAll('.surface-composer button, [data-testid="agent-input-box"] button');
      if (buttons && typeof buttons.forEach === 'function') {
        let matchedModel = null;
        buttons.forEach((btn) => {
          if (matchedModel) return;
          if (isMainConv && this.isInsideNestedSubpane(view, btn)) return;
          if (
            typeof btn?.closest === 'function' &&
            btn.closest('[data-testid*="attachment"], [data-testid*="file-chip"], [data-testid*="context-chip"]')
          ) {
            return;
          }
          const attrCandidate = extractFromTrigger(
            btn.hasAttribute?.('data-model-id') ||
              btn.hasAttribute?.('data-context-window') ||
              /(?:Select model|选择模型)/i.test(btn.getAttribute?.('aria-label') || '')
              ? btn
              : null
          );
          if (attrCandidate) {
            matchedModel = attrCandidate;
            return;
          }
          const t = (btn.textContent || '').replace(/\s+/g, ' ').trim();
          if (/\b(?:Orchestrator|Gemini|Claude|GPT|o1|o3|o4)\b/i.test(t)) {
            matchedModel = t;
          }
        });
        if (matchedModel) return matchedModel;
      }
    }

    if (totalViews === 1 && typeof document !== 'undefined') {
      const globalTrigger = this.findGlobalNonSubpaneModelTrigger();
      const globalModel = extractFromTrigger(globalTrigger);
      if (globalModel) return globalModel;
    }

    return '';
  }

  /**
   * 检测当前分栏是否存在后台正在工作的子智能体，综合多源正向活跃探针：
   * 1. `[data-testid="idle-status-text"]` 文本（如 `"1 subagent running"`, `"2 subagents running"`, `"Working"`, `"1 个子智能体正在运行"`）
   * 2. `[data-testid="running-subagent-steps-toggle"]`, `[data-testid="running-subagent-browser-steps"]`, `[data-testid="browser-subagent-thinking"]`
   * 3. `[aria-label^="Open Subagent:"]` / `[data-testid="browser-subagent-row"]` 中不含非运行态图标（`done` / `killed` / `canceled` / `error` / `failed` / `waiting` / `blocked` / `paused`）或非运行态圆点的活跃卡片
   */
  resolveSubagentState(view, options = {}) {
    const fallback = { isSubagentRunning: false, runningSubagentCount: 0 };
    if (!view || typeof view.querySelectorAll !== 'function') return fallback;

    const { isSubpane, isSubagentPane } = this.inferPaneContext(view, options);

    let runningCount = 0;
    let exactIdleSubagentCount = 0;
    let detected = false;

    const idleStatusNodes = view.querySelectorAll('[data-testid="idle-status-text"]');
    if (idleStatusNodes && typeof idleStatusNodes.forEach === 'function') {
      idleStatusNodes.forEach((node) => {
        if (!isSubpane && this.isInsideNestedSubpane(view, node)) return;
        const txt = (node.textContent || '').replace(/\s+/g, ' ').trim();
        if (!txt) return;
        const segments = txt
          .split(/[,，·•;|\n()（）]+/)
          .map((seg) => seg.trim())
          .filter(Boolean);
        segments.forEach((seg) => {
          // 区分混合计数 ("2 subagents/tasks running" 含终端后台任务) 与官方纯子智能体计数 ("1 subagent running" / "6 subagents running")
          // 并屏蔽同一横幅内并存的 blocked / waiting / standing by 等非运行态提示数字
          const mixedCountMatch = seg.match(/(\d+)\s*(?:个)?\s*(?:subagents?\s*\/\s*tasks?|子智能体\s*\/\s*任务|子代理\s*\/\s*任务)/i);
          const pureRunningMatch = !mixedCountMatch
            ? seg.match(
                /(\d+)\s*(?:个)?\s*(?:subagents?\b|子智能体|子代理)\s*(?:is|are|正在|处于)?\s*(?:running|working|运行中|正在运行|执行中|处理中)/i
              )
            : null;
          const pureCountMatch = !mixedCountMatch
            ? pureRunningMatch || seg.match(/(\d+)\s*(?:个)?\s*(?:subagents?\b|子智能体|子代理)/i)
            : null;
          const hasRunningKeyword = /(?:running|working|运行中|正在运行|执行中|处理中)/i.test(seg);
          if (pureCountMatch && (pureRunningMatch || hasRunningKeyword)) {
            detected = true;
            const parsed = parseInt(pureCountMatch[1], 10);
            if (parsed > exactIdleSubagentCount) exactIdleSubagentCount = parsed;
            if (parsed > runningCount) runningCount = parsed;
          } else if (mixedCountMatch && hasRunningKeyword) {
            // 混合文案 y = f + n (至少 1 个子智能体 + 至少 1 个后台终端任务)，不可将终端任务数计入子智能体数量
            detected = true;
            if (runningCount < 1) runningCount = 1;
          } else if (
            /\bsubagents?(?:\/tasks?)?\s+(?:running|working)\b|(?:子智能体|子代理).*(?:运行|工作|执行)/i.test(
              seg
            )
          ) {
            detected = true;
            if (runningCount < 1) runningCount = 1;
          }
        });
      });
    }

    // 子智能体自身分栏内的 running-subagent / browser-subagent-thinking 与 Stop subagent 属于本栏自身运行态，不作为嵌套子智能体计数
    if (!isSubagentPane) {
      const activeSubagentMarkers = view.querySelectorAll(
        '[data-testid="running-subagent-steps-toggle"], [data-testid="running-subagent-browser-steps"], [data-testid="browser-subagent-thinking"]'
      );
      if (activeSubagentMarkers && activeSubagentMarkers.length > 0) {
        const markerContainers = new Set();
        if (typeof activeSubagentMarkers.forEach === 'function') {
          activeSubagentMarkers.forEach((m) => {
            if (!isSubpane && this.isInsideNestedSubpane(view, m)) return;
            const container =
              m.closest?.('[data-testid="browser-subagent-row"], [id^="subagentView-"], [data-cascade-id]') || m;
            markerContainers.add(container);
          });
        }
        if (markerContainers.size > 0) {
          detected = true;
          const markerCount = Math.max(1, markerContainers.size);
          if (exactIdleSubagentCount === 0 && runningCount < markerCount) {
            runningCount = markerCount;
          }
        }
      }
    }

    // 检查子智能体引用芯片是否仍处于加载态（排除权限来源标签、已完成/未读状态、终端后台任务图标 status-task-running 及静态卡片）
    const agentRefs = view.querySelectorAll(
      '[aria-label^="Open Subagent:"], [aria-label^="打开子智能体："], [aria-label^="打开子智能体:"], [aria-label^="打开子代理："], [aria-label^="打开子代理:"]'
    );
    if (agentRefs && typeof agentRefs.forEach === 'function') {
      const activeRefOwners = new Set();
      agentRefs.forEach((ref) => {
        if (!isSubpane && this.isInsideNestedSubpane(view, ref)) return;
        if (typeof ref.querySelector !== 'function') return;
        const refTestId = (ref.getAttribute?.('data-testid') || '').toLowerCase();
        if (
          refTestId === 'subagent-permission-source' ||
          ref.closest?.('[data-testid="subagent-permission-source"]')
        ) {
          return;
        }
        const finishedIcon =
          NON_RUNNING_AGENT_STATUS_TESTIDS.has(refTestId) ||
          refTestId === 'status-unread-dot' ||
          Boolean(
            ref.querySelector(
              `${NON_RUNNING_AGENT_STATUS_SELECTOR}, [data-testid="status-unread-dot"]`
            )
          );
        if (finishedIcon) return;
        const dotEl = ref.querySelector('[data-agent-state-dot]');
        const dotState = (dotEl?.getAttribute?.('data-agent-state-dot') || '').trim();
        if (dotEl && dotState && NON_RUNNING_AGENT_DOT_STATE_RE.test(dotState)) return;
        const hasActiveStateDot = Boolean(
          dotEl && !NON_RUNNING_AGENT_DOT_STATE_RE.test(dotState)
        );
        const hasActiveDotOrSpinner =
          hasActiveStateDot ||
          Boolean(
            ref.querySelector(
              '[data-testid="status-loading-spinner"], .animate-spin, .codicon-loading, .spinner'
            )
          );
        if (hasActiveDotOrSpinner) {
          const owner = ref.closest?.('[data-testid="browser-subagent-row"], [id^="subagentView-"]') || ref;
          const ariaIdentity = (ref.getAttribute?.('aria-label') || '').replace(/^(?:Open Subagent:|打开子智能体[：:]|打开子代理[：:])\s*/i, '').trim();
          const id = owner.getAttribute?.('data-cascade-id') || owner.getAttribute?.('id') || ariaIdentity;
          activeRefOwners.add(id || owner);
        }
      });
      const activeRefCount = activeRefOwners.size;
      if (activeRefCount > 0) {
        detected = true;
        if (exactIdleSubagentCount === 0 && activeRefCount > runningCount) runningCount = activeRefCount;
      }
    }

    const buttons = options?.buttons ?? view.querySelectorAll('button, [role="button"]');
    if (buttons && typeof buttons.forEach === 'function') {
      buttons.forEach((btn) => {
        if (!isSubpane && this.isInsideNestedSubpane(view, btn)) return;
        const btnTestId = (btn.getAttribute?.('data-testid') || '').toLowerCase();
        if (SIDE_QUESTION_HEADER_BUTTON_TESTIDS.has(btnTestId)) return;
        const label = (
          btn.getAttribute?.('aria-label') ||
          btn.getAttribute?.('title') ||
          btn.textContent ||
          ''
        ).trim();
        const isSubagentStopBtn = isSubagentPane
          ? /^(?:Stop All Subagents|停止所有子智能体)$/i.test(label)
          : /^(?:Stop All Subagents|Stop subagent|停止所有子智能体|停止子智能体)$/i.test(label);
        if (isSubagentStopBtn) {
          detected = true;
          if (runningCount < 1) runningCount = 1;
        }
      });
    }

    // 扫描正在执行中的子智能体调度工具卡片 (要求存在明确子智能体工具语义且具备正向加载指示器，杜绝正文文本误判)
    const activeToolNodes = view.querySelectorAll(
      '[data-testid="tool-call"], [data-testid="tool-invocation"], [data-testid*="subagent-card"], [data-testid="browser-subagent-row"]'
    );
    if (activeToolNodes && typeof activeToolNodes.forEach === 'function') {
      activeToolNodes.forEach((node) => {
        if (isSubpane && node === view) return;
        if (!isSubpane && this.isInsideNestedSubpane(view, node)) return;
        if (
          node.getAttribute?.('data-testid') === 'subagent-permission-source' ||
          node.closest?.('[data-testid="subagent-permission-source"]')
        ) {
          return;
        }
        const testId = (node.getAttribute?.('data-testid') || '').toLowerCase();
        const headerEl = node.querySelector?.('[data-testid*="tool-name"], [data-testid*="header"], summary, header, button') || node;
        const headerText = (headerEl.textContent || '').replace(/\s+/g, ' ').trim();
        const isSubagentTool =
          testId.includes('subagent') ||
          /\b(?:invoke_subagent|browser_subagent|start_subagent|spawn_subagent)\b/i.test(headerText);
        if (!isSubagentTool) return;
        const finished =
          NON_RUNNING_AGENT_STATUS_TESTIDS.has(testId) ||
          Boolean(node.querySelector?.(NON_RUNNING_AGENT_STATUS_SELECTOR));
        if (finished) return;
        const dotEl = node.querySelector?.('[data-agent-state-dot]');
        const dotState = (dotEl?.getAttribute?.('data-agent-state-dot') || '').trim();
        if (dotEl && NON_RUNNING_AGENT_DOT_STATE_RE.test(dotState)) return;
        const hasSpinner = Boolean(
          node.getAttribute?.('data-state') === 'running' ||
          node.querySelector?.(
            '.animate-spin, .codicon-loading, .spinner, [data-testid="status-loading-spinner"], [data-state="running"]'
          )
        );
        if (hasSpinner) {
          detected = true;
          if (runningCount < 1) runningCount = 1;
        }
      });
    }

    return {
      isSubagentRunning: detected,
      runningSubagentCount: detected ? Math.max(1, runningCount) : 0,
    };
  }

  resolveActivityPhase(view, precomputedSubagentState = null, options = {}) {
    if (!view || typeof view.querySelectorAll !== 'function') return 'idle';
    const { isSubpane, isSubagentPane } = this.inferPaneContext(view, options);
    void precomputedSubagentState;

    let hasIdleStatusBanner = false;
    if (!isSubpane) {
      const idleBannerNodes = view.querySelectorAll('[data-testid="idle-status-text"]');
      if (idleBannerNodes && typeof idleBannerNodes.forEach === 'function') {
        idleBannerNodes.forEach((node) => {
          if (hasIdleStatusBanner) return;
          if (this.isInsideNestedSubpane(view, node)) return;
          if ((node.textContent || '').trim()) hasIdleStatusBanner = true;
        });
      }
    }

    // 仅认准当前分栏的前台轮次终止/流式信号（排除后台等待期的 idle-status-text 伴生 agent-loading 与附件处理状态）
    const foregroundTurnNodes = view.querySelectorAll(
      '[data-testid="input-cancel-button"], [data-testid="agent-loading"], [data-state="streaming"], [data-streaming="true"]'
    );
    let hasForegroundTurn = false;
    let onlyAgentLoadingSeen = false;
    if (foregroundTurnNodes && foregroundTurnNodes.length > 0) {
      const nodeList = typeof foregroundTurnNodes.forEach === 'function'
        ? foregroundTurnNodes
        : Array.from(foregroundTurnNodes);
      nodeList.forEach((node) => {
        if (hasForegroundTurn) return;
        const nodeTestId = node.getAttribute?.('data-testid') || '';
        if (!isSubpane) {
          if (this.isInsideNestedSubpane(view, node)) return;
          if (nodeTestId !== 'input-cancel-button' && typeof node?.closest === 'function') {
            const nestedCard = node.closest(
              '[data-testid*="subagent-card"], [data-testid="browser-subagent-row"], [data-testid="tool-call"], [data-testid="tool-invocation"], [data-testid="running-items-card"], [data-testid="idle-status-text"]'
            );
            if (nestedCard && nestedCard !== view) return;
          }
        }
        if (!isSubpane && nodeTestId === 'agent-loading' && hasIdleStatusBanner) {
          onlyAgentLoadingSeen = true;
          return;
        }
        hasForegroundTurn = true;
      });
    }
    void onlyAgentLoadingSeen;
    let hasSubpaneThinkingMarker = false;

    if (isSubagentPane) {
      const subpaneThinking = view.querySelectorAll?.('[data-testid="browser-subagent-thinking"]');
      if (subpaneThinking && subpaneThinking.length > 0) {
        hasForegroundTurn = true;
        hasSubpaneThinkingMarker = true;
      } else {
        const subpaneActiveNodes = view.querySelectorAll(
          '[data-testid="running-subagent-steps-toggle"], [data-testid="running-subagent-browser-steps"]'
        );
        if (subpaneActiveNodes && subpaneActiveNodes.length > 0) {
          hasForegroundTurn = true;
        }
      }
    }

    if (!hasForegroundTurn) {
      const composerRoot = this.resolveComposerElement(view);
      const buttonScope = composerRoot || (isSubpane ? view : null);
      const buttons = buttonScope?.querySelectorAll?.('button, [role="button"]');
      if (buttons && typeof buttons.forEach === 'function') {
        buttons.forEach((btn) => {
          if (hasForegroundTurn) return;
          if (!isSubpane && this.isInsideNestedSubpane(view, btn)) return;
          if (typeof btn?.closest === 'function') {
            if (btn.closest('[role="menu"], [role="listbox"], [role="dialog"], [data-select-popup]')) return;
          }
          const btnTestId = (btn.getAttribute?.('data-testid') || '').toLowerCase();
          if (SIDE_QUESTION_HEADER_BUTTON_TESTIDS.has(btnTestId)) return;
          const btnClass = typeof btn.className === 'string' ? btn.className.toLowerCase() : '';
          if (/(?:voice|dictat|microphone|audio-record|speech|record-audio)/i.test(`${btnTestId} ${btnClass}`)) {
            return;
          }
          const label = (
            btn.getAttribute?.('aria-label') ||
            btn.getAttribute?.('title') ||
            btn.textContent ||
            ''
          ).trim();
          if (/(?:voice|dictat|recording|microphone|语音|录音|听写|麦克风)/i.test(label)) {
            return;
          }
          if (
            /^(?:Stop generating|Stop|Cancel generation|Cancel\s*[（(][^）)]+[）)]|停止生成|停止|中断|取消\s*[（(][^）)]+[）)])$/i.test(
              label
            ) ||
            (/(?:cancel|stop)/i.test(btnTestId) && /^(?:Cancel|取消)$/i.test(label)) ||
            (isSubagentPane && /^(?:Stop subagent|停止子智能体)$/i.test(label))
          ) {
            hasForegroundTurn = true;
          }
        });
      }
      if (!hasForegroundTurn && isSubagentPane) {
        const viewButtons = options?.buttons ?? view.querySelectorAll('button, [role="button"]');
        if (viewButtons && typeof viewButtons.forEach === 'function') {
          viewButtons.forEach((btn) => {
            const label = (
              btn.getAttribute?.('aria-label') ||
              btn.getAttribute?.('title') ||
              btn.textContent ||
              ''
            ).trim();
            if (/^(?:Stop subagent|停止子智能体)$/i.test(label)) {
              hasForegroundTurn = true;
            }
          });
        }
      }
    }

    const toolStatusNodes = view.querySelectorAll('[data-testid="ephemeral-tool-status"]');
    let hasApprovalWait = false;
    let hasEphemeralToolRunning = false;
    let hasEphemeralThinking = hasSubpaneThinkingMarker;
    if (toolStatusNodes && typeof toolStatusNodes.forEach === 'function') {
      toolStatusNodes.forEach((node) => {
        if (!isSubpane && this.isInsideNestedSubpane(view, node)) return;
        const statusText = (node.textContent || '').replace(/\s+/g, ' ').trim();
        if (!statusText) return;
        if (/(?:Waiting for your approval|等待您的批准)/i.test(statusText)) {
          hasApprovalWait = true;
        } else if (/^(?:Thinking\b|Thought\b|Compacting\b|思考|正在思考|思维|压缩)/i.test(statusText)) {
          hasEphemeralThinking = true;
        } else {
          hasEphemeralToolRunning = true;
        }
      });
    }

    // 主会话对话流内嵌入的子智能体卡片 / 后台运行汇总卡片的局部 spinner 与 shimmer 属于后台/子代理信号，
    // 不得把主会话前台纯文本生成误判为 executing（前台普通 tool-call / tool-invocation 仍保留为 executing）
    const embeddedNonForegroundCardSelector =
      '[aria-label^="Open Subagent:"], [aria-label^="打开子智能体："], [aria-label^="打开子智能体:"], [aria-label^="打开子代理："], [aria-label^="打开子代理:"], [data-testid*="subagent-card"], [data-testid="browser-subagent-row"], [data-testid="running-items-card"], [data-testid="idle-status-text"]';
    const isInsideEmbeddedNonForegroundCard = (node) => {
      if (isSubpane || typeof node?.closest !== 'function') return false;
      const card = node.closest(embeddedNonForegroundCardSelector);
      return Boolean(card && card !== view);
    };

    // 注意：status-task-running 为后台终端任务图标 (>_) 而非前台工具 Spinner，此处仅匹配 status-loading-spinner
    const taskRunningNodes = view.querySelectorAll('[data-testid="status-loading-spinner"]');
    let hasTaskSpinner = false;
    if (taskRunningNodes && taskRunningNodes.length > 0) {
      if (isSubpane) {
        hasTaskSpinner = true;
      } else {
        const list = typeof taskRunningNodes.forEach === 'function' ? taskRunningNodes : Array.from(taskRunningNodes);
        list.forEach((n) => {
          if (
            !hasTaskSpinner &&
            !this.isInsideNestedSubpane(view, n) &&
            !isInsideEmbeddedNonForegroundCard(n)
          ) {
            hasTaskSpinner = true;
          }
        });
      }
    }

    let hasToolCardShimmer = false;
    let hasModelThinkingShimmer = false;
    const shimmerNodes = view.querySelectorAll('.animate-shimmer-text');
    if (shimmerNodes && typeof shimmerNodes.forEach === 'function') {
      shimmerNodes.forEach((node) => {
        if (!isSubpane && (this.isInsideNestedSubpane(view, node) || isInsideEmbeddedNonForegroundCard(node))) {
          return;
        }
        const parentTestId = node.closest?.('[data-testid]')?.getAttribute?.('data-testid') || '';
        if (parentTestId === 'idle-status-text') return;
        const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
        if (
          parentTestId === 'agent-loading' ||
          /^(?:Thinking\b|Thought\b|Compacting\b|思考|正在思考|思维|压缩)/i.test(text)
        ) {
          hasModelThinkingShimmer = true;
        } else if (text) {
          hasToolCardShimmer = true;
        }
      });
    }

    // 当前分栏前台模型已停止（无终止/停止按钮）：无论是否存在后台工具或独立子智能体，小圆点一律保持灰色 idle
    if (!hasForegroundTurn) {
      return 'idle';
    }

    if (
      hasApprovalWait &&
      !hasModelThinkingShimmer &&
      !hasEphemeralThinking &&
      !hasToolCardShimmer &&
      !hasEphemeralToolRunning
    ) {
      return 'idle';
    }

    // 前台轮次活跃且正在与工具互动（包括同时存在思考文本与工具运行卡片时）：优先显示蓝色呼吸 executing
    if (hasEphemeralToolRunning || hasToolCardShimmer || hasTaskSpinner) {
      return 'executing';
    }

    return 'generating';
  }

  resolveStreamingState(view, precomputedSubagentState = null, options = {}) {
    return this.resolveActivityPhase(view, precomputedSubagentState, options) !== 'idle';
  }

  dispatchMetrics(metrics) {
    if (!metrics || typeof metrics !== 'object') return false;
    let handled = false;
    for (const instance of this.instances.values()) {
      if (metrics.paneSlotId && instance.paneSlotId && instance.paneSlotId !== metrics.paneSlotId) {
        continue;
      }
      if (instance.getCurrentConvId() === metrics.conversationId) {
        if (instance.updateMetrics(metrics)) {
          handled = true;
        }
      }
    }
    return handled;
  }

  state() {
    return {
      active: this.active,
      enabled: this.enabled,
      instanceCount: this.instances.size,
      routeExcluded: this.routeExcluded,
      languageMode: this.languageMode,
    };
  }

  dispose() {
    this.active = false;
    if (this.visibilityHandler && typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
    if (this.domReadyAbort) {
      this.domReadyAbort.abort();
      this.domReadyAbort = null;
    }
    if (this.reconcileTimer !== null) {
      clearTimeout(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    if (this.routeTimer !== null) {
      clearInterval(this.routeTimer);
      this.routeTimer = null;
    }
    if (this.mutationObserver) {
      this.mutationObserver.disconnect();
      this.mutationObserver = null;
    }
    if (this.themeObserver) {
      this.themeObserver.disconnect();
      this.themeObserver = null;
    }
    this.clearComposerTextObservers();
    for (const instance of this.instances.values()) {
      instance.dispose();
    }
    this.instances.clear();
  }
}

// 在浏览器/CDP 隔离世界中自动挂载并暴露全局控制句柄
(function attachGlobalHudController() {
  globalThis.__GRAVITYBOX_ATTACH_HUD__ = attachGlobalHudController;
  if (typeof document === 'undefined') return;
  const boot = globalThis.__GRAVITYBOX_BOOT__;
  if (boot !== undefined && !globalThis.__GRAVITYBOX_ENGINE_V1__) return;
  const initialEnabled = boot?.hudEnabled !== false;
  const initialLang = normalizeHudLocale(boot?.locale || globalThis.__GRAVITYBOX_ENGINE_V1__?.getLanguageMode?.() || 'zh-Hans');
  const buildSig = typeof HUD_STYLES_CSS === 'string' && typeof HUD_I18N === 'object'
    ? `${HUD_STYLES_CSS.length}:${Object.keys(HUD_I18N['zh-Hans'] || {}).length}`
    : 'runtime';
  if (globalThis.__GRAVITYBOX_HUD_V1__?.active) {
    const existingSig = globalThis.__GRAVITYBOX_HUD_V1__.__hudBuildSig;
    if (!existingSig || existingSig === buildSig) {
      if (!existingSig) globalThis.__GRAVITYBOX_HUD_V1__.__hudBuildSig = buildSig;
      globalThis.__GRAVITYBOX_HUD_V1__.setLanguage?.(initialLang);
      globalThis.__GRAVITYBOX_HUD_V1__.setEnabled?.(initialEnabled);
      globalThis.__GRAVITYBOX_HUD_V1__.reconcileMounts?.();
      return;
    }
    try {
      globalThis.__GRAVITYBOX_HUD_V1__.dispose?.();
    } catch {}
  }
  if (!document.body && boot === undefined) return;
  const manager = new AntigravityHudManager({
    locale: initialLang,
    languageMode: initialLang === 'zh-Hans' ? 'zh' : initialLang,
    enabled: initialEnabled,
  });
  manager.start();

  const hudApi = {
    __hudBuildSig: buildSig,
    get active() {
      return manager.active;
    },
    get enabled() {
      return manager.enabled;
    },
    manager,
    reconcileMounts: (views) => manager.reconcileMounts(views),
    syncAllSessions: () => manager.syncAllSessions(),
    dispatchMetrics: (metrics) => manager.dispatchMetrics(metrics),
    setLanguage: (mode) => manager.setLanguage(mode),
    setEnabled: (enabled) => manager.setEnabled(enabled),
    setRouteExcluded: (excluded) => manager.setRouteExcluded(excluded),
    computeUpwardPopoverPosition:
      typeof computeUpwardPopoverPosition === 'function'
        ? computeUpwardPopoverPosition
        : globalThis.__GRAVITYBOX_HUD_POPOVER__?.computeUpwardPopoverPosition,
    dispose: () => {
      manager.dispose();
      delete globalThis.__gravityboxUpdateHudMetrics;
      delete globalThis.__GRAVITYBOX_HUD_V1__;
      delete globalThis.__GRAVITYBOX_ATTACH_HUD__;
    },
  };

  globalThis.__GRAVITYBOX_HUD_V1__ = hudApi;
  globalThis.__gravityboxUpdateHudMetrics = (metrics) => manager.dispatchMetrics(metrics);
})();
