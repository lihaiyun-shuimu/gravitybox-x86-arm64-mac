import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HudInstance } from '../runtime/hud-instance.js';
import { AntigravityHudManager } from '../runtime/hud-manager.js';
import { applyPopoverGeometry, resetPopoverGeometryCache } from '../runtime/hud-popover.js';
import { HUD_STYLES_CSS } from '../runtime/hud-styles.js';

class FakeStyleDeclaration {
  constructor() {
    this.cssText = '';
  }
}

class FakeElement {
  constructor(tagName = 'div', ownerDoc = null) {
    this.tagName = tagName.toUpperCase();
    this.nodeType = 1;
    this.ownerDocument = ownerDoc;
    this.attributes = new Map();
    this.style = new FakeStyleDeclaration();
    this.children = [];
    this.parentNode = null;
    this.shadowRoot = null;
    this.listeners = new Map();
    this.classList = {
      _set: new Set(),
      add: (...tokens) => tokens.forEach((t) => this.classList._set.add(t)),
      remove: (...tokens) => tokens.forEach((t) => this.classList._set.delete(t)),
      toggle: (token, force) => {
        const shouldAdd = force !== undefined ? Boolean(force) : !this.classList._set.has(token);
        if (shouldAdd) this.classList._set.add(token);
        else this.classList._set.delete(token);
        return shouldAdd;
      },
      contains: (token) => this.classList._set.has(token),
    };
    this._innerHTML = '';
    this._textContent = '';
    this._rect = { left: 100, top: 700, width: 520, height: 24, right: 620, bottom: 724 };
  }

  get isConnected() {
    return Boolean(this.parentNode);
  }

  get id() {
    return this.getAttribute('id') || '';
  }
  set id(v) {
    this.setAttribute('id', v);
  }

  get className() {
    return [...this.classList._set].join(' ');
  }
  set className(v) {
    this.classList._set.clear();
    String(v || '')
      .split(/\s+/)
      .filter(Boolean)
      .forEach((t) => this.classList._set.add(t));
  }

  get textContent() {
    return this._textContent;
  }
  set textContent(v) {
    this._textContent = String(v ?? '');
  }

  get innerHTML() {
    return this._innerHTML;
  }
  set innerHTML(v) {
    this._innerHTML = String(v ?? '');
  }

  get previousElementSibling() {
    if (!this.parentNode) return null;
    const idx = this.parentNode.children.indexOf(this);
    return idx > 0 ? this.parentNode.children[idx - 1] : null;
  }

  setAttribute(k, v) {
    this.attributes.set(k, String(v));
  }
  getAttribute(k) {
    return this.attributes.has(k) ? this.attributes.get(k) : null;
  }
  hasAttribute(k) {
    return this.attributes.has(k);
  }
  removeAttribute(k) {
    this.attributes.delete(k);
  }

  getBoundingClientRect() {
    return { ...this._rect };
  }
  getClientRects() {
    return [this.getBoundingClientRect()];
  }

  attachShadow({ mode }) {
    const sr = new FakeShadowRoot(mode, this);
    this.shadowRoot = sr;
    return sr;
  }

  insertAdjacentElement(pos, el) {
    if (pos === 'afterend' && this.parentNode) {
      if (el.parentNode) {
        const oldIdx = el.parentNode.children.indexOf(el);
        if (oldIdx !== -1) el.parentNode.children.splice(oldIdx, 1);
      }
      const idx = this.parentNode.children.indexOf(this);
      if (idx !== -1) {
        this.parentNode.children.splice(idx + 1, 0, el);
        el.parentNode = this.parentNode;
      }
    }
  }

  appendChild(el) {
    if (el.parentNode) {
      const oldIdx = el.parentNode.children.indexOf(el);
      if (oldIdx !== -1) el.parentNode.children.splice(oldIdx, 1);
    }
    this.children.push(el);
    el.parentNode = this;
    return el;
  }

  remove() {
    if (this.parentNode) {
      const idx = this.parentNode.children.indexOf(this);
      if (idx !== -1) this.parentNode.children.splice(idx, 1);
      this.parentNode = null;
    }
  }

  addEventListener(type, fn, opts) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    const set = this.listeners.get(type);
    set.add(fn);
    if (opts?.signal) {
      opts.signal.addEventListener('abort', () => set.delete(fn));
    }
  }

  dispatchEvent(evt) {
    const set = this.listeners.get(evt.type);
    if (set) {
      for (const fn of set) fn(evt);
    }
    return !evt.defaultPrevented;
  }

  contains(target) {
    let cur = target;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parentNode;
    }
    return false;
  }

  matches(sel) {
    const s = String(sel);
    if (s.includes('.surface-composer') && this.classList.contains('surface-composer')) return true;
    if (s.includes('.__gravitybox_hud_host__') && this.classList.contains('__gravitybox_hud_host__')) return true;
    if (s.includes('.model-selector') && this.classList.contains('model-selector')) return true;
    if (s.includes('conversation-view') && this.getAttribute('data-testid') === 'conversation-view') return true;
    if (s.includes('subagent-tab-conversation') && this.getAttribute('data-testid') === 'subagent-tab-conversation') return true;
    if (s.includes('data-media-drop-scope="subpane"') && this.getAttribute('data-media-drop-scope') === 'subpane') return true;
    if (s.includes('overview-panel-host') && this.getAttribute('data-testid') === 'overview-panel-host') return true;
    if (s.includes('data-split-root="true"') && this.getAttribute('data-split-root') === 'true') return true;
    if (s.includes('agent-input-box') && this.getAttribute('data-testid') === 'agent-input-box') return true;
    if (s.includes('model-selector-trigger') && this.getAttribute('data-testid') === 'model-selector-trigger') return true;
    if (s.includes('[contenteditable="true"]') && this.getAttribute('contenteditable') === 'true') return true;
    if (s.includes('[role="button"]') && this.getAttribute('role') === 'button') return true;
    if (/(?:^|[\s,>])button(?=$|[\s,\[.:])/i.test(s) && this.tagName === 'BUTTON') return true;
    if (/(?:^|[\s,>])textarea(?=$|[\s,\[.:])/i.test(s) && this.tagName === 'TEXTAREA') return true;
    if (/(?:^|[\s,>])input(?=$|[\s,\[.:])/i.test(s) && this.tagName === 'INPUT') return true;
    return false;
  }

  closest(sel) {
    let cur = this;
    while (cur) {
      if (typeof cur.matches === 'function' && cur.matches(sel)) return cur;
      cur = cur.parentNode;
    }
    return null;
  }

  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }

  querySelectorAll(sel) {
    const out = [];
    const testIdTargets = [...String(sel).matchAll(/\[data-testid="([^"]+)"\]/g)].map((match) => match[1]);
    const matchButtonTag = /(?:^|[\s,>])button(?=$|[\s,\[.:])/i.test(String(sel));
    const matchShimmerClass = String(sel).includes('.animate-shimmer-text');
    const visit = (node) => {
      for (const child of node.children || []) {
        const childTestId = child.getAttribute('data-testid');
        if (
          (sel.includes('.surface-composer') && child.classList.contains('surface-composer')) ||
          (matchShimmerClass && child.classList.contains('animate-shimmer-text')) ||
          (childTestId && testIdTargets.includes(childTestId)) ||
          (matchButtonTag && child.tagName === 'BUTTON')
        ) {
          out.push(child);
        }
        visit(child);
      }
    };
    visit(this);
    return out;
  }
}

class FakeShadowRoot {
  constructor(mode, host) {
    this.mode = mode;
    this.host = host;
    this._innerHTML = '';
    this.elementsBySel = new Map();
    this.capsules = [];
    this.popovers = [];
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set innerHTML(html) {
    this._innerHTML = String(html ?? '');
    this.elementsBySel.clear();
    this.capsules = [];
    this.popovers = [];

    const container = new FakeElement('div');
    container.className = 'hud-container';
    this.container = container;

    const selectors = [
      '#hud-txt-session .hud-turns',
      '#hud-txt-session .hud-turn-dur',
      '#hud-txt-session .hud-speed',
      '#hud-txt-session .hud-subagent-tag',
      '#hud-txt-session .hud-subagent-count',
      '#hud-txt-tokens .hud-tok-total',
      '#hud-txt-tokens .hud-cache-prefix',
      '#hud-txt-tokens .hud-cache-label',
      '#hud-txt-tokens .hud-cache-val',
      '#hud-compaction-badge',
      '#hud-ctx-model-tag',
      '#hud-ctx-model-full',
      '#hud-ctx-model-short',
      '#hud-donut-val',
      '#hud-meter-fill',
      '#hud-txt-context',
      '#pop-session-title',
      '#pop-session-badge',
      '#lbl-model-dur',
      '#val-model-dur',
      '#lbl-tool-dur',
      '#val-tool-dur',
      '#lbl-ttft',
      '#val-ttft',
      '#lbl-tps',
      '#val-tps',
      '#row-turn-dur',
      '#lbl-turn-dur',
      '#val-turn-dur',
      '#row-ttft-latest',
      '#lbl-ttft-latest',
      '#val-ttft-latest',
      '#row-tps-latest',
      '#lbl-tps-latest',
      '#val-tps-latest',
      '#row-subagent-status',
      '#lbl-subagent-status',
      '#val-subagent-status',
      '#hud-session-status-note',
      '#pop-tokens-title',
      '#pop-tokens-badge',
      '#lbl-cache-hit',
      '#val-cache-hit',
      '#lbl-uncached-in',
      '#val-uncached-in',
      '#lbl-cached-read',
      '#val-cached-read',
      '#row-cache-write',
      '#lbl-cache-write',
      '#val-cache-write',
      '#lbl-output-tok',
      '#val-output-tok',
      '#row-reasoning-tok',
      '#lbl-reasoning-tok',
      '#val-reasoning-tok',
      '#row-est-cost',
      '#lbl-est-cost',
      '#val-est-cost',
      '#row-cache-saved',
      '#lbl-cache-saved',
      '#val-cache-saved',
      '#pop-ctx-prefix',
      '#pop-ctx-role',
      '#pop-ctx-pct',
      '#pop-ctx-capacity',
      '#pop-ctx-track',
      '#seg-sys',
      '#seg-tool',
      '#seg-msg',
      '#lbl-seg-sys',
      '#val-seg-sys',
      '#lbl-seg-tool',
      '#val-seg-tool',
      '#lbl-seg-msg',
      '#val-seg-msg',
      '#row-ctx-peak',
      '#lbl-ctx-peak',
      '#val-ctx-peak',
      '#row-ctx-model',
      '#lbl-ctx-model',
      '#val-ctx-model',
      '#hud-ctx-stages-wrap',
      '#lbl-ctx-stages',
      '#hud-ctx-stages-list',
      '#arrow-session',
      '#arrow-tokens',
      '#arrow-context',
    ];
    for (const sel of selectors) {
      this.elementsBySel.set(sel, new FakeElement('div'));
    }

    for (const capId of ['session', 'tokens', 'context']) {
      const btn = new FakeElement('button');
      btn.className = `capsule capsule-${capId}`;
      btn.setAttribute('data-capsule-id', capId);
      btn.setAttribute('aria-expanded', 'false');
      this.capsules.push(btn);
      this.elementsBySel.set(`.capsule-${capId}`, btn);

      const pop = new FakeElement('div');
      pop.id = `hud-popover-${capId}`;
      pop.className = 'hud-popover';
      pop.setAttribute('data-popover-id', capId);
      pop.setAttribute('hidden', '');
      this.popovers.push(pop);
      this.elementsBySel.set(`#hud-popover-${capId}`, pop);
    }
  }

  querySelector(sel) {
    if (sel === '.hud-container') return this.container;
    if (this.elementsBySel.has(sel)) return this.elementsBySel.get(sel);
    if (sel.startsWith('.capsule[data-capsule-id="')) {
      const m = sel.match(/data-capsule-id="([^"]+)"/);
      return this.capsules.find((c) => c.getAttribute('data-capsule-id') === m?.[1]) || null;
    }
    return null;
  }

  querySelectorAll(sel) {
    if (sel === '.capsule') return this.capsules;
    if (sel === '.hud-popover') return this.popovers;
    return [];
  }
}

describe('HUD raw 数值精度与缺值展示', () => {
  function render(metrics, languageMode = 'zh') {
    const instance = new HudInstance('formatting', { languageMode });
    instance.shadow = new FakeShadowRoot('open', null);
    instance.shadow.innerHTML = instance.buildHudHtml();
    instance.applyMetricsToDom(metrics);
    return { instance, text: (selector) => instance.shadow.querySelector(selector).textContent };
  }

  const metrics = {
    session: {
      turns: 12, steps: 1234, outputTps: 82.7364, outputTpsFormatted: '82.74 tok/s',
      latestStepOutputTps: 171.174, latestStepOutputTpsFormatted: '171.17 tok/s',
      latestStepTtftSeconds: 1.244, latestStepTtftFormatted: '1.24 秒', latestStepTtftFormattedEn: '1.24s',
      currentTurnOutputTps: 118.404, currentTurnOutputTpsFormatted: '118.40 tok/s',
      currentTurnTimedSamples: 3,
      averageTtftSeconds: 3.8462, averageTtftFormatted: '3.85 秒',
      modelDurationSeconds: 1348.126, modelDurationFormatted: '22分28秒',
      toolDurationSeconds: 59.999, toolDurationFormatted: '1分',
      compactionCount: 2,
      currentTurnDurationSeconds: 18.4,
      currentTurnDurationFormatted: '18秒',
      currentTurnDurationFormattedEn: '18s',
      currentTurnDurationCompactZh: '本轮 18s',
      currentTurnDurationCompactEn: 'Turn 18s',
      currentTurnModelDurationSeconds: 14.2,
      currentTurnToolDurationSeconds: 4.2,
    },
    tokens: {
      totalTokens: 61234567, totalTokensCompact: '61.2M tok', totalTokensFormatted: 'rounded',
      cacheHitRate: 0.96943, cacheHitRateFormatted: '96.94%',
      uncachedInputTokens: 1234567, cachedReadTokens: 59876543, outputTokens: 123457,
      cacheWriteTokens: 1001, reasoningTokens: 12345, candidateTokens: 111112,
      estimatedCostUsd: 0.423, estimatedCostFormatted: '~$0.42',
      cacheSavedUsd: 2.154, cacheSavedFormatted: '~$2.15',
    },
    context: {
      hasUsageData: true, usedTokens: 226412, usedTokensCompact: '226.4K',
      usedRatio: 1.13206, usedRatioFormatted: '113%',
      capacityTokens: 200000, capacityTokensCompact: '~200K', isFallbackCapacity: true,
      peakContextTokens: 1234567,
      modelDisplayName: 'Gemini Very Long Model Name With Extended Context Preview',
      breakdown: {
        cachedContextTokens: 218100, cachedContextRatio: 109.05,
        uncachedContextTokens: 8312, uncachedContextRatio: 4.156,
        latestOutputTokens: 1240, messageRatio: 20,
      },
    },
  };

  for (const languageMode of ['zh', 'en']) {
    it(`${languageMode}: 胶囊与展开卡片统一采用紧凑数字表示法（Compact Number Notation）与压缩徽章控制`, () => {
      const { instance, text } = render(metrics, languageMode);
      assert.equal(text('#hud-txt-session .hud-speed'), ' · 83 tok/s');
      assert.equal(text('#hud-txt-session .hud-turn-dur'), languageMode === 'en' ? '· Turn 18s' : '· 本轮 18s');
      assert.equal(text('#pop-session-badge'), languageMode === 'en' ? '12 turns 1.23K steps' : '12 轮 1.23K 步');
      assert.equal(text('#hud-txt-tokens .hud-tok-total'), '61.2M tok');
      assert.equal(text('#hud-txt-tokens .hud-cache-val'), '97%');
      assert.equal(text('#hud-compaction-badge'), '2');
      assert.equal(instance.shadow.querySelector('#hud-compaction-badge').hasAttribute('hidden'), false);
      assert.equal(instance.shadow.querySelector('.capsule-context').classList.contains('has-compaction'), true);
      assert.equal(text('#hud-txt-context'), '~113%');
      assert.equal(text('#val-tps'), '82.7 tok/s');
      assert.equal(text('#lbl-ttft-latest'), languageMode === 'en' ? 'Latest Step TTFT' : '最近一步 TTFT');
      assert.equal(text('#val-ttft-latest'), languageMode === 'en' ? '1.24s' : '1.24 秒');
      assert.equal(text('#lbl-tps-latest'), languageMode === 'en' ? 'Latest Step TPS' : '最近一步 TPS');
      assert.equal(text('#val-tps-latest'), '171 tok/s');
      assert.equal(instance.shadow.querySelector('#row-session-compactions'), null);
      assert.equal(text('#val-turn-dur'), languageMode === 'en' ? '18s' : '18秒');
      assert.equal(text('#val-ttft'), languageMode === 'en' ? '3.85s' : '3.85 秒');
      assert.equal(text('#val-model-dur'), languageMode === 'en' ? '22m28s' : '22分28秒');
      assert.equal(text('#val-tool-dur'), languageMode === 'en' ? '1m' : '1分');
      assert.equal(text('#val-cache-hit'), '96.9%');
      assert.equal(text('#pop-tokens-badge'), '61.2M tok');
      assert.equal(text('#val-uncached-in'), '1.23M tok');
      assert.equal(text('#val-cached-read'), '59.9M tok');
      assert.equal(text('#val-output-tok'), '123K tok');
      assert.equal(text('#val-cache-write'), '1K tok');
      assert.equal(text('#val-reasoning-tok'), '12.3K / 111K tok');
      assert.equal(text('#lbl-est-cost'), languageMode === 'en' ? 'Estimated Cost' : '估算费用');
      assert.equal(text('#val-est-cost'), '~$0.42');
      assert.equal(text('#lbl-cache-saved'), languageMode === 'en' ? 'Cache Saved' : '缓存节省');
      assert.equal(text('#val-cache-saved'), '~$2.15');
      assert.equal(text('#pop-ctx-pct'), '~113%');
      assert.equal(text('#pop-ctx-capacity'), '226K / ~200K');
      assert.equal(text('#val-seg-sys'), '218K tok');
      assert.equal(text('#val-seg-tool'), '8.31K tok');
      assert.equal(text('#val-seg-msg'), '1.24K tok');
      assert.equal(text('#val-ctx-peak'), languageMode === 'en'
        ? '1.23M tok (2x compacted)' : '1.23M tok (已压缩 2 次)');
      assert.equal(text('#val-ctx-model'), metrics.context.modelDisplayName);
      assert.equal(instance.shadow.querySelector('#seg-msg').style.width, '0%');
      assert.equal(instance.shadow.querySelector('#pop-ctx-track').getAttribute('aria-valuenow'), '100');
      assert.equal(instance.shadow.querySelector('#pop-ctx-track').getAttribute('aria-valuetext'), '113%');
      assert.match(instance.shadow.querySelector('#val-tps').getAttribute('aria-description'), /等待|waiting/);
      assert.match(instance.shadow.querySelector('#val-ttft-latest').getAttribute('aria-description'), /首字延迟|Time to first token/);
      assert.match(instance.shadow.querySelector('#val-tps-latest').getAttribute('aria-description'), /最近|latest/);
      assert.match(instance.shadow.querySelector('#val-ttft').getAttribute('aria-description'), /原始|original/);
      assert.match(instance.shadow.querySelector('#val-est-cost').getAttribute('aria-description'), /费率|pricing/);
      assert.match(instance.shadow.querySelector('#val-cache-saved').getAttribute('aria-description'), /缓存|cache/);
      const builtHtml = instance.buildHudHtml();
      assert.equal((builtHtml.match(/class="hud-popover-row"/g) || []).length, 21);
      assert.equal(builtHtml.includes('hud-popover-divider-dashed'), true);
      assert.equal(builtHtml.includes('hud-data-state'), false, 'HUD 展开卡片不应包含时间与计时请求数行');
      assert.equal(builtHtml.includes('hud-copy-stats'), false, 'HUD 展开卡片不应包含复制精确统计按钮');
      assert.equal(builtHtml.includes('复制精确统计'), false);
      assert.equal(builtHtml.includes('Copy Exact Stats'), false);
      assert.equal(builtHtml.includes('id="seg-msg"'), true);
      assert.match(builtHtml, /<span class="hud-popover-label">\s*<span class="hud-legend-dot"[^>]*hud-seg-sys-color[^>]*><\/span>\s*<span id="lbl-seg-sys">/);
      assert.match(builtHtml, /<span class="hud-popover-label">\s*<span class="hud-legend-dot"[^>]*hud-seg-tool-color[^>]*><\/span>\s*<span id="lbl-seg-tool">/);
      assert.match(builtHtml, /<span class="hud-popover-label">\s*<span id="lbl-seg-msg">/, '#lbl-seg-msg 旁不应再渲染绿色图例圆点');
      assert.equal(builtHtml.includes('hud-seg-msg-color'), false, '#lbl-seg-msg 不应再引用 --hud-seg-msg-color 圆点');

      // 当压缩次数为 0 时隐藏徽章，移除 has-compaction 类
      const zeroComp = render({
        ...metrics,
        session: { ...metrics.session, compactionCount: 0, turns: 1500, steps: 2500000, subagentCount: 1200, subagentSteps: 3450 },
      }, languageMode);
      assert.equal(zeroComp.instance.shadow.querySelector('#hud-compaction-badge').hasAttribute('hidden'), true);
      assert.equal(zeroComp.text('#hud-compaction-badge'), '');
      assert.equal(zeroComp.instance.shadow.querySelector('#row-session-compactions'), null);
      assert.equal(zeroComp.instance.shadow.querySelector('.capsule-context').classList.contains('has-compaction'), false);
      assert.equal(zeroComp.text('#hud-txt-session .hud-turns'), languageMode === 'en' ? '1.5KT ' : '1.5K 轮 ');
      assert.equal(zeroComp.text('#pop-session-badge'), languageMode === 'en' ? '1.5K turns 2.5M steps' : '1.5K 轮 2.5M 步');
      assert.equal(zeroComp.text('#val-subagent-status'), languageMode === 'en' ? '1.2K scheduled (3.45K steps)' : '已调度 1.2K 个（3.45K 步）');

      const hundredM = render({
        ...metrics,
        tokens: { ...metrics.tokens, totalTokens: 106877614, totalTokensCompact: '107M tok' },
        context: { ...metrics.context, usedTokens: 107169, usedTokensCompact: '107K' },
      }, languageMode);
      assert.equal(hundredM.text('#hud-txt-tokens .hud-tok-total'), '107M tok');
      assert.equal(hundredM.text('#pop-tokens-badge'), '107M tok');
      assert.equal(hundredM.instance.shadow.querySelector('#hud-txt-context').getAttribute('data-used-tokens'), '107K');

      const trimmedTrailing = render({
        ...metrics,
        session: {
          ...metrics.session,
          turns: 1550,
          steps: 15500,
          compactionCount: 1550,
          outputTps: 15.5,
          latestStepOutputTps: 15.0,
          averageTtftSeconds: 15.5,
          latestStepTtftSeconds: 1.2,
          latestStepTtftFormatted: '1.2 秒',
          latestStepTtftFormattedEn: '1.2s',
        },
        tokens: {
          ...metrics.tokens,
          totalTokens: 15500,
          cacheHitRate: 0.155,
          uncachedInputTokens: undefined,
          uncachedInputFormatted: '15.50K',
        },
      }, languageMode);
      assert.equal(trimmedTrailing.text('#hud-txt-session .hud-turns'), languageMode === 'en' ? '1.6KT ' : '1.6K 轮 ');
      assert.equal(trimmedTrailing.text('#hud-compaction-badge'), '1.6K');
      assert.equal(trimmedTrailing.text('#pop-session-badge'), languageMode === 'en' ? '1.55K turns 15.5K steps' : '1.55K 轮 15.5K 步');
      assert.equal(trimmedTrailing.text('#hud-txt-tokens .hud-tok-total'), '15.5K tok');
      assert.equal(trimmedTrailing.text('#val-tps'), '15.5 tok/s');
      assert.equal(trimmedTrailing.text('#val-tps-latest'), '15 tok/s');
      assert.equal(trimmedTrailing.text('#val-ttft'), languageMode === 'en' ? '15.5s' : '15.5 秒');
      assert.equal(trimmedTrailing.text('#val-ttft-latest'), languageMode === 'en' ? '1.2s' : '1.2 秒');
      assert.equal(trimmedTrailing.text('#val-cache-hit'), '15.5%');
      assert.equal(trimmedTrailing.text('#val-uncached-in'), '15.5K tok');

      const highSpeed = render({
        ...metrics,
        session: { ...metrics.session, outputTps: 1240, outputTpsFormatted: '1.24K tok/s' },
        tokens: {
          ...metrics.tokens,
          estimatedCostUsd: undefined,
          estimatedCostFormatted: '~$2.00',
          cacheSavedUsd: undefined,
          cacheSavedFormatted: '~$0.00',
        },
      }, languageMode);
      assert.equal(highSpeed.text('#hud-txt-session .hud-speed'), ' · 1.2K tok/s');
      assert.equal(highSpeed.text('#val-tps'), '1.24K tok/s');
      assert.equal(highSpeed.text('#val-est-cost'), '~$2');
      assert.equal(highSpeed.text('#val-cache-saved'), '$0');
    });
  }

  it('缺失与实测零严格区分，流式 measuring 信号保持双语', () => {
    for (const missing of [null, undefined, NaN, Infinity]) {
      const { text } = render({
        session: {
          outputTps: missing,
          latestStepTtftSeconds: missing,
          latestStepOutputTps: missing,
          averageTtftSeconds: missing,
        },
        tokens: { cacheHitRate: missing, estimatedCostUsd: missing, cacheSavedUsd: missing },
        context: { usedRatio: missing },
      });
      for (const selector of ['#val-tps', '#val-ttft-latest', '#val-tps-latest', '#val-ttft', '#val-cache-hit', '#val-est-cost', '#val-cache-saved', '#pop-ctx-pct']) {
        assert.equal(text(selector), '—');
      }
    }
    const zero = render({
      session: {
        outputTps: 0,
        latestStepTtftSeconds: 0,
        latestStepTtftFormatted: '0.00 秒',
        latestStepTtftFormattedEn: '0.00s',
        latestStepOutputTps: 0,
        latestStepOutputTpsFormatted: '0.00 tok/s',
        averageTtftSeconds: 0,
        modelDurationSeconds: 0,
      },
      tokens: {
        cacheHitRate: 0,
        estimatedCostUsd: 0,
        estimatedCostFormatted: '~$0.00',
        cacheSavedUsd: 0,
        cacheSavedFormatted: '~$0.00',
      },
      context: { usedRatio: 0 },
    });
    assert.equal(zero.text('#val-tps'), '0 tok/s');
    assert.equal(zero.text('#val-ttft-latest'), '0 秒');
    assert.equal(zero.text('#val-tps-latest'), '0 tok/s');
    assert.equal(zero.text('#val-ttft'), '0 秒');
    assert.equal(zero.text('#val-model-dur'), '0秒');
    assert.equal(zero.text('#val-cache-hit'), '0%');
    assert.equal(zero.text('#val-est-cost'), '$0');
    assert.equal(zero.text('#val-cache-saved'), '$0');
    assert.equal(zero.text('#pop-ctx-pct'), '0%');
    const absent = render({
      session: {
        outputTps: 0, outputTpsFormatted: '—',
        latestStepTtftSeconds: 0, latestStepTtftFormatted: '—', latestStepTtftFormattedEn: '—',
        latestStepOutputTps: 0, latestStepOutputTpsFormatted: '—',
        averageTtftSeconds: 0, averageTtftFormatted: '—',
      },
      tokens: {
        estimatedCostFormatted: '—',
        cacheSavedFormatted: '—',
      },
    });
    assert.equal(absent.text('#val-tps'), '—');
    assert.equal(absent.text('#val-ttft-latest'), '—');
    assert.equal(absent.text('#val-tps-latest'), '—');
    assert.equal(absent.text('#val-ttft'), '—');
    assert.equal(absent.text('#val-est-cost'), '—');
    assert.equal(absent.text('#val-cache-saved'), '—');
    for (const lang of ['zh', 'en']) {
      const { text } = render({
        session: { outputTps: 0, outputTpsFormatted: '计算中...' },
      }, lang);
      assert.equal(text('#val-tps'), lang === 'en' ? 'Measuring…' : '计算中...');
      assert.equal(text('#val-ttft-latest'), '—');
      assert.equal(text('#val-tps-latest'), '—');
    }
    for (const lang of ['zh', 'en']) {
      for (const formatted of ['Calculating...', '—']) {
        const { text } = render({
          session: {
            outputTps: 0,
            outputTpsPending: true,
            outputTpsFormatted: formatted,
            latestStepOutputTps: null,
          },
        }, lang);
        assert.equal(text('#val-tps'), lang === 'en' ? 'Measuring…' : '计算中...');
        assert.equal(text('#val-ttft-latest'), '—');
        assert.equal(text('#val-tps-latest'), '—');
      }
    }
  });

  it('缺少上下文用量不显示伪零或猜测容量；实测输入进度不计入输出', () => {
    const absent = render({ context: { hasUsageData: false, usedRatio: 0, usedTokens: 0 } });
    assert.equal(absent.text('#hud-txt-context'), '—');
    assert.equal(absent.text('#pop-ctx-capacity'), '— / —');
    assert.equal(absent.text('#val-seg-sys'), '—');
    for (const output of [1, 1000000]) {
      const { instance, text } = render({ context: { ...metrics.context, usedRatio: 0.5,
        capacityTokensCompact: '200K', breakdown: { cachedContextRatio: 40,
          uncachedContextRatio: 10, latestOutputTokens: output } } });
      assert.equal(text('#pop-ctx-capacity'), '226K / ~200K');
      assert.equal(instance.shadow.querySelector('#seg-sys').style.width, '40.000%');
      assert.equal(instance.shadow.querySelector('#seg-tool').style.width, '10.000%');
      assert.equal(instance.shadow.querySelector('#seg-msg').style.width, '0%');
      assert.equal(text('#val-seg-msg'), output >= 1_000_000 ? '1M tok' : '1 tok');
    }
  });
});

describe('HudInstance 与 AntigravityHudManager 生产模块生命周期、垂直居中平衡与防篡改测试', () => {
  it('验证双分栏独立挂载、pb-4 底部包装器垂直居中平衡与恢复、无原生 title、子智能体工作状态感知、sessionRevision 防篡改及 AbortController 50 次重挂载零泄漏', () => {
    const windowListeners = new Set();
    const doc = new FakeElement('document');
    doc.body = new FakeElement('body', doc);
    doc.documentElement = new FakeElement('html', doc);
    doc.createElement = (tag) => new FakeElement(tag, doc);
    doc.querySelectorAll = (sel) => doc.body.querySelectorAll(sel);
    doc.querySelector = (sel) => doc.body.querySelector(sel);

    globalThis.document = doc;
    globalThis.window = {
      innerWidth: 1024,
      innerHeight: 800,
      location: { pathname: '/c/4ec6348d-0f58-49db-8aed-6f67dbb78f5d' },
      matchMedia: () => ({ matches: true }),
      getComputedStyle: () => ({ visibility: 'visible', display: 'block', paddingBottom: '0px' }),
      addEventListener(type, fn, opts) {
        const rec = { type, fn };
        windowListeners.add(rec);
        if (opts?.signal) {
          opts.signal.addEventListener('abort', () => windowListeners.delete(rec));
        }
      },
    };
    globalThis.ResizeObserver = class {
      observe() {}
      disconnect() {}
    };
    globalThis.MutationObserver = class {
      observe() {}
      disconnect() {}
    };

    const createPane = (cascadeId, convId) => {
      const view = new FakeElement('div', doc);
      view.setAttribute('data-testid', 'conversation-view');
      view.setAttribute('data-cascade-id', cascadeId);
      view.setAttribute('data-conversation-id', convId);

      // 模拟 Antigravity 原生外层 pb-4 底部包装器 (p7)
      const bottomDock = new FakeElement('div', doc);
      bottomDock.className = 'relative w-full px-4 pb-4 flex-shrink-0 flex flex-col items-center gap-2';
      bottomDock.style.paddingBottom = '16px';

      const inputBox = new FakeElement('div', doc);
      inputBox.setAttribute('data-testid', 'agent-input-box');
      const composer = new FakeElement('div', doc);
      composer.className = 'surface-composer';
      inputBox.appendChild(composer);
      bottomDock.appendChild(inputBox);
      view.appendChild(bottomDock);
      doc.body.appendChild(view);
      return { view, bottomDock, inputBox, composer };
    };

    const paneA = createPane('cascade-alpha', 'conv-alpha-11111111');
    createPane('cascade-beta', 'conv-beta-22222222');

    const events = [];
    const manager = new AntigravityHudManager({
      onBridgeEvent: (evt) => events.push(evt),
    });
    manager.start();

    assert.equal(manager.state().instanceCount, 2, '左右双分栏应各自独立挂载 1 个 HudInstance');

    // 验证 Issue 1: 外层 pb-4 底部内边距被平衡归零，且 HUD 上下 margin 对称居中
    const instA = manager.instances.get(manager.viewToSlotId.get(paneA.view));
    assert.ok(instA);
    assert.equal(paneA.bottomDock.style.paddingBottom, '16px', 'HUD 不得修改宿主 pb-4 内边距');
    assert.equal(instA.host.style.marginTop, instA.host.style.marginBottom, 'HUD 上下外边距必须完全对称居中');

    const capsuleBtn = instA.shadow.querySelectorAll('.capsule')[0];
    let prevented = false;
    capsuleBtn.dispatchEvent({
      type: 'mousedown',
      preventDefault() {
        prevented = true;
      },
    });
    assert.equal(prevented, true, '点击胶囊 mousedown 必须调用 preventDefault() 保护输入框光标不失焦');

    const rev1 = instA.switchConversation('conv-1');
    const rev2 = instA.switchConversation('conv-2');
    const rev3 = instA.switchConversation('conv-1');
    assert.ok(rev3 > rev2 && rev2 > rev1);

    const sampleMetrics = (convId, rev) => ({
      conversationId: convId,
      sessionRevision: rev,
      updatedAt: Date.now(),
      isStreaming: false,
      session: {
        turns: 9,
        steps: 425,
        compactionCount: 1,
        modelDurationSeconds: 1348,
        modelDurationFormatted: '22分28秒',
        modelDurationFormattedEn: '22m28s',
        toolDurationSeconds: 360,
        toolDurationFormatted: '6分',
        toolDurationFormattedEn: '6m',
        averageTtftSeconds: 3.8,
        averageTtftFormatted: '3.8 秒',
        averageTtftFormattedEn: '3.8s',
        outputTps: 82,
        outputTpsFormatted: '82 tok/s',
      },
      tokens: {
        totalTokens: 23196078,
        totalTokensCompact: '23.2M tok',
        totalTokensFormatted: '23,196,078 tok',
        cacheHitRate: 0.9694,
        cacheHitRateFormatted: '97%',
        uncachedInputTokens: 708929,
        uncachedInputFormatted: '708,929 tok',
        cachedReadTokens: 22416293,
        cachedReadFormatted: '22,416,293 tok',
        outputTokens: 70856,
        outputFormatted: '70,856 tok',
        reasoningTokens: 20856,
        candidateTokens: 50000,
      },
      context: {
        modelId: 'gemini-3.8-flash',
        modelDisplayName: 'Gemini 3.8 Flash',
        usedTokens: 226412,
        usedTokensCompact: '226K',
        usedTokensFormatted: '226,412 tok',
        peakContextTokens: 226412,
        peakContextCompact: '226K',
        peakContextFormatted: '226,412 tok',
        capacityTokens: 262144,
        capacityTokensCompact: '256K',
        isFallbackCapacity: false,
        usedRatio: 0.8637,
        usedRatioFormatted: '86%',
        breakdown: {
          cachedContextTokens: 218100,
          cachedContextFormatted: '218,100 tok',
          cachedContextRatio: 83.2,
          uncachedContextTokens: 8312,
          uncachedContextFormatted: '8,312 tok',
          uncachedContextRatio: 3.17,
          latestOutputTokens: 1240,
          latestOutputFormatted: '1,240 tok',
          systemTokens: 218100,
          systemTokensCompact: '218,100 tok',
          systemRatio: 83.2,
          toolTokens: 8312,
          toolTokensCompact: '8,312 tok',
          toolRatio: 3.17,
          messageTokens: 1240,
          messageTokensCompact: '1,240 tok',
          messageRatio: 0,
        },
      },
    });

    assert.equal(instA.updateMetrics(sampleMetrics('conv-2', rev2)), false, '不同 conversationId 必须被拦截');
    assert.equal(instA.updateMetrics(sampleMetrics('conv-1', rev1)), false, '过期 sessionRevision 必须被拦截');
    assert.equal(instA.updateMetrics(sampleMetrics('conv-1', rev3)), true, '最新匹配快照正常接收');

    // 验证会话切换后 pinnedPopoverId 必须被重置，不得阻塞新会话中的胶囊悬停
    instA.handleCapsuleClick(capsuleBtn, { stopPropagation() {} });
    assert.equal(instA.pinnedPopoverId, 'session');
    assert.equal(
      capsuleBtn.classList.contains('is-streaming'),
      false,
      '模型未工作时点击展开卡片不得将状态圆点置为工作态'
    );
    const rev4 = instA.switchConversation('conv-3');
    assert.equal(instA.pinnedPopoverId, null, '切换会话后必须清除旧会话锁定的 pinnedPopoverId');
    assert.equal(instA.updateMetrics(sampleMetrics('conv-3', rev4)), true);

    // 验证 Popover 3 展示真实上下文明细而非 1.9K/7.6K 假数据
    assert.equal(instA.shadow.querySelector('#pop-ctx-capacity').textContent, '226K / 262K');
    assert.equal(instA.shadow.querySelector('#lbl-seg-sys').textContent, '缓存复用上下文');
    assert.equal(instA.shadow.querySelector('#val-seg-sys').textContent, '218K tok');
    assert.equal(instA.shadow.querySelector('#lbl-seg-tool').textContent, '本步新增输入');
    assert.equal(instA.shadow.querySelector('#val-seg-tool').textContent, '8.31K tok');
    assert.equal(instA.shadow.querySelector('#val-ctx-peak').textContent, '226K tok (已压缩 1 次)');
    assert.equal(instA.shadow.querySelector('#val-ctx-model').textContent, 'Gemini 3.8 Flash');

    // 验证浅色主题显式声明时，即使系统 matchMedia 为 dark 也不得误判为深色
    doc.body.className = 'theme-standalone light light-theme theme-light';
    instA.syncTheme();
    assert.equal(instA.host.hasAttribute('data-theme'), false, '显式浅色主题下不得被系统深色偏好覆盖为 dark');
    doc.body.className = 'theme-standalone dark dark-theme theme-dark';
    instA.syncTheme();
    assert.equal(instA.host.getAttribute('data-theme'), 'dark');

    // 验证双语切换
    manager.setLanguage('en');
    assert.equal(instA.shadow.querySelector('#hud-txt-session .hud-turns').textContent, '9T ');
    assert.equal(instA.shadow.querySelector('#pop-session-badge').textContent, '9 turns 425 steps');
    assert.equal(instA.shadow.querySelector('#pop-session-title').textContent, 'Session Stats');
    assert.equal(instA.shadow.querySelector('#lbl-seg-sys').textContent, 'Cached Context');
    manager.setLanguage('zh');
    assert.equal(instA.shadow.querySelector('#hud-txt-session .hud-turns').textContent, '9 轮 ');
    assert.equal(instA.shadow.querySelector('#pop-session-badge').textContent, '9 轮 425 步');
    assert.equal(instA.shadow.querySelector('#pop-session-title').textContent, '对话统计');
    assert.equal(instA.shadow.querySelector('#lbl-seg-sys').textContent, '缓存复用上下文');

    // 验证 Issue 1 (v2.1): 3 个状态栏胶囊绝不包含任何原生 title 悬浮提示属性，避免遮挡上浮卡片
    assert.equal(
      /\btitle\s*=\s*"/i.test(instA.shadow.innerHTML),
      false,
      'HUD HTML 模板绝不应包含原生 title="..." 属性'
    );
    for (const cap of instA.shadow.querySelectorAll('.capsule')) {
      assert.equal(cap.hasAttribute('title'), false, '胶囊按钮不得携带原生 title 属性');
    }

    // 验证方案 A: 主对话模型已停止而子智能体独立运行时 (1 subagent running)，状态栏保留子智能体运行态与计时，但小圆点保持灰色 idle
    const subagentStatusNode = new FakeElement('div', doc);
    subagentStatusNode.setAttribute('data-testid', 'idle-status-text');
    subagentStatusNode.textContent = '1 subagent running';
    paneA.view.appendChild(subagentStatusNode);

    const subState = manager.resolveSubagentState(paneA.view);
    assert.equal(subState.isSubagentRunning, true, '应准确检测到 [data-testid="idle-status-text"] 中的子智能体运行状态');
    assert.equal(subState.runningSubagentCount, 1);
    assert.equal(manager.resolveStreamingState(paneA.view), false, '仅子智能体运行时主栏前台流式状态为 false');
    assert.equal(
      manager.resolveActivityPhase(paneA.view),
      'idle',
      '主对话模型已停止而仅子智能体运行时，主对话小圆点必须保持 idle（灰色）'
    );

    manager.reconcileMounts();
    assert.equal(
      instA.updateMetrics({
        ...sampleMetrics('conv-alpha-11111111', instA.getSessionRevision()),
        isSubagentRunning: true,
        runningSubagentCount: 1,
      }),
      true
    );
    assert.equal(instA.isStreaming, false);
    assert.equal(instA.activityPhase, 'idle');
    assert.equal(instA.hasActiveWork, true);
    assert.equal(
      instA.shadow.querySelector('.capsule-session').classList.contains('is-streaming'),
      false,
      '仅后台子智能体运行时主栏胶囊不得携带 is-streaming'
    );
    assert.equal(
      instA.shadow.querySelector('.capsule-session').classList.contains('is-executing'),
      false,
      '仅后台子智能体运行时主栏胶囊不得携带 is-executing 呼吸类'
    );
    assert.equal(instA.isSubagentRunning, true);
    assert.equal(
      instA.shadow.querySelector('#hud-txt-session .hud-subagent-tag').hasAttribute('hidden'),
      false,
      '子智能体运行时常驻分段 1 应显示紧凑分支图标标签'
    );
    assert.equal(
      instA.shadow.querySelector('#hud-txt-session .hud-subagent-tag').getAttribute('data-subagent-count'),
      '1'
    );
    assert.equal(
      instA.shadow.querySelector('#hud-txt-session .hud-subagent-count').textContent,
      '',
      '单个子智能体运行时仅显示紧凑分支图标，不拼接冗长文字或数字 1'
    );
    assert.equal(
      instA.shadow.innerHTML.includes('class="hud-subagent-icon"'),
      true,
      'HTML 骨架应内嵌紧凑子智能体 SVG 分支符号'
    );
    assert.match(
      instA.shadow.querySelector('.capsule-session').getAttribute('aria-label') || '',
      /子智能体运行中/,
      '无障碍 aria-label 仍保留完整本地化子智能体状态读数'
    );
    assert.equal(
      instA.shadow.querySelector('#row-subagent-status').hasAttribute('hidden'),
      false,
      'Popover 1 应展开子智能体状态行'
    );
    assert.equal(
      instA.shadow.querySelector('#val-subagent-status').textContent,
      '1 个运行中'
    );

    // 多子智能体并行运行（如 6 subagents running）：常驻栏仅显示紧凑图标 + 数字 6，弹窗显示完整文本
    subagentStatusNode.textContent = '6 subagents running';
    manager.reconcileMounts();
    assert.equal(
      instA.shadow.querySelector('#hud-txt-session .hud-subagent-tag').getAttribute('data-subagent-count'),
      '6'
    );
    assert.equal(
      instA.shadow.querySelector('#hud-txt-session .hud-subagent-count').textContent,
      '6',
      '多子智能体运行时常驻栏仅附加紧凑数字 6'
    );
    assert.equal(
      instA.shadow.querySelector('#val-subagent-status').textContent,
      '6 个运行中'
    );

    // 移除子智能体状态文本，确认无前台残留
    subagentStatusNode.remove();
    assert.equal(manager.resolveStreamingState(paneA.view), false, '子智能体结束后流式状态保持为 false');

    // 验证后台普通终端任务 ("1 task running" / "1 个后台任务正在运行")、普通 Working 状态与权限指示器不会误报为子智能体运行中
    const bgTaskStatusNode = new FakeElement('div', doc);
    bgTaskStatusNode.setAttribute('data-testid', 'idle-status-text');
    bgTaskStatusNode.textContent = '1 task running';
    paneA.view.appendChild(bgTaskStatusNode);
    assert.equal(
      manager.resolveSubagentState(paneA.view).isSubagentRunning,
      false,
      '普通后台任务 "1 task running" 绝不能误报为子智能体运行中'
    );
    bgTaskStatusNode.textContent = '1 个后台任务正在运行';
    assert.equal(
      manager.resolveSubagentState(paneA.view).isSubagentRunning,
      false,
      '汉化后的 "1 个后台任务正在运行" 绝不能误报为子智能体运行中'
    );
    bgTaskStatusNode.textContent = 'Working';
    assert.equal(
      manager.resolveSubagentState(paneA.view).isSubagentRunning,
      false,
      '主智能体普通 "Working" 状态不得误报为子智能体运行中'
    );
    bgTaskStatusNode.remove();
    const cancelBtn = new FakeElement('button', doc);
    cancelBtn.setAttribute('data-testid', 'input-cancel-button');
    cancelBtn.setAttribute('aria-label', 'Cancel (⌃C)');
    paneA.view.appendChild(cancelBtn);
    assert.equal(
      manager.resolveActivityPhase(paneA.view),
      'generating',
      '宿主出现 input-cancel-button 且无脚本执行时必须识别为 generating（常亮蓝色）'
    );
    manager.reconcileMounts();
    assert.equal(
      instA.shadow.querySelector('.capsule-session').classList.contains('is-generating'),
      true,
      '模型本身思考/输出时胶囊必须携带 is-generating 常亮蓝色类'
    );
    assert.equal(
      instA.shadow.querySelector('.capsule-session').classList.contains('is-executing'),
      false,
      '模型本身思考/输出时不得携带呼吸类'
    );
    const thinkingShimmer = new FakeElement('span', doc);
    thinkingShimmer.className = 'animate-shimmer-text';
    thinkingShimmer.textContent = 'Thinking';
    paneA.view.appendChild(thinkingShimmer);

    const cmdShimmer = new FakeElement('span', doc);
    cmdShimmer.className = 'animate-shimmer-text';
    cmdShimmer.textContent = 'Running npm test';
    paneA.view.appendChild(cmdShimmer);
    assert.equal(
      manager.resolveActivityPhase(paneA.view),
      'executing',
      '前台轮次中思考文本与工具运行并存时必须识别为 executing（蓝色呼吸）'
    );

    // 前台模型停止（Cancel 按钮消失）但后台工具 shimmer 与 .codicon-loading 仍存在时，小圆点必须立即恢复灰色 idle
    const codiconLoading = new FakeElement('span', doc);
    codiconLoading.className = 'codicon-loading';
    paneA.view.appendChild(codiconLoading);
    cancelBtn.remove();
    assert.equal(
      manager.resolveActivityPhase(paneA.view),
      'idle',
      '停止按钮消失后，即使工具 shimmer 与 .codicon-loading 仍存在也必须恢复为 idle（灰色）'
    );
    codiconLoading.remove();
    thinkingShimmer.remove();
    cmdShimmer.remove();
    manager.reconcileMounts();
    const streamingEventsBefore = events.filter((e) => e.type === 'STREAMING_CHANGED').length;
    instA.updateMetrics({
      ...sampleMetrics('conv-alpha-11111111', instA.getSessionRevision()),
      isStreaming: true,
      isSubagentRunning: true,
      runningSubagentCount: 1,
    });
    manager.reconcileMounts();
    manager.reconcileMounts();
    const streamingEventsAfter = events.filter((e) => e.type === 'STREAMING_CHANGED').length;
    assert.equal(
      streamingEventsAfter,
      streamingEventsBefore,
      '后端子智能体活跃而 DOM 空闲时重复 reconcile 不得反复发送 STREAMING_CHANGED'
    );

    // 验证动态关闭/开启 HUD (setEnabled) 无损还原并可重新挂载
    manager.setEnabled(false);
    assert.equal(manager.state().instanceCount, 0);
    assert.equal(paneA.bottomDock.style.paddingBottom, '16px', '关闭 HUD 时必须立即还原宿主容器 paddingBottom');
    // 模拟崩溃残留内联 paddingBottom: 0px 时挂载后仍能清空回退至 Tailwind pb-4 样式
    paneA.bottomDock.style.paddingBottom = '0px';
    manager.setEnabled(true);
    assert.equal(manager.state().instanceCount, 2, '重新开启 HUD 后应立即恢复双分栏实例');
    manager.setEnabled(false);
    assert.equal(paneA.bottomDock.style.paddingBottom, '0px', 'HUD 不得猜测或修改宿主既有内联样式');
    paneA.bottomDock.style.paddingBottom = '16px';
    manager.setEnabled(true);

    // 验证 50 次重挂载零监听器泄漏
    const refreshedInstA = manager.instances.get(manager.viewToSlotId.get(paneA.view));
    for (let i = 0; i < 50; i++) {
      refreshedInstA.mount(paneA.composer);
    }
    // paneA (4 listeners: resize/pointerdown/keydown/blur) + paneB (4 listeners) = 8
    assert.equal(windowListeners.size, 8, '50 次重挂载后全局监听器数量恒定为 8，无任何累积泄漏');

    manager.dispose();
    assert.equal(manager.state().instanceCount, 0);
    assert.equal(windowListeners.size, 0, 'dispose() 后全局监听器清零');
    assert.equal(paneA.bottomDock.style.paddingBottom, '16px', 'dispose() 后必须无损还原外层容器原始 paddingBottom');
  });

  it('unavailable 态显示清晰中文/英文标签（不显示 ———），普通文本包含 subagent 不误触发子智能体运行态', () => {
    const inst = new HudInstance('slot-empty');
    const host = new FakeElement('div');
    const sr = host.attachShadow({ mode: 'open' });
    sr.innerHTML = inst.buildHudHtml();
    inst.shadow = sr;
    inst.applyMetricsToDom({
      ...inst.lastMetrics,
      conversationId: 'missing-conv',
      availability: 'unavailable',
    });
    assert.equal(sr.querySelector('#hud-txt-session .hud-turns').textContent, '');
    assert.equal(sr.querySelector('#hud-txt-session .hud-turn-dur').textContent, '暂无数据');
    assert.equal(sr.querySelector('#hud-txt-session .hud-speed').textContent, '');

    inst.applyMetricsToDom({
      ...inst.lastMetrics,
      conversationId: 'conv-partial',
      availability: 'partial',
      observedAt: 1731420000000,
    });
    assert.equal(sr.querySelector('#hud-session-status-note').hasAttribute('hidden'), false);
    assert.match(sr.querySelector('#hud-session-status-note').textContent, /部分数据或子库未就绪/);

    const mgr = new AntigravityHudManager();
    const view = new FakeElement('div');
    const toolNode = new FakeElement('div');
    toolNode.setAttribute('data-testid', 'tool-call');
    toolNode.textContent = 'run_command: grep subagent running';
    view.appendChild(toolNode);
    assert.equal(mgr.resolveSubagentState(view).isSubagentRunning, false);
  });

  it('流式生成期间本轮用时客户端时钟平滑 1 秒步进且结束后回落权威耗时，销毁零残留定时器', async () => {
    const inst = new HudInstance({ cascadeId: 'pane-turn-clock', isPrimaryPane: true });
    const composer = new FakeElement('div');
    composer.setAttribute('data-testid', 'agent-input-box');
    const wrapper = new FakeElement('div');
    wrapper.classList.add('pb-4');
    wrapper.appendChild(composer);
    inst.mount(composer);
    const sr = inst.host.shadowRoot;

    inst.switchConversation('conv-turn-clock', 'gemini-3.8-flash', true);
    inst.updateMetrics({
      conversationId: 'conv-turn-clock',
      sessionRevision: inst.getSessionRevision(),
      metricsSequence: 1,
      isStreaming: true,
      session: {
        turns: 1,
        steps: 2,
        currentTurnDurationSeconds: 10,
        currentTurnDurationFormatted: '10秒',
        currentTurnDurationFormattedEn: '10s',
        currentTurnDurationCompactZh: '本轮 10s',
        currentTurnDurationCompactEn: 'Turn 10s',
      },
      tokens: { totalTokens: 100 },
      context: { hasUsageData: true, usedRatio: 0.1 },
    });

    assert.equal(sr.querySelector('#hud-txt-session .hud-turn-dur').textContent, '· 本轮 10s');
    assert.equal(sr.querySelector('#val-turn-dur').textContent, '10秒');
    assert.ok(inst.turnClockTimer !== null, '流式活跃时必须启动平滑时钟');

    await new Promise((resolve) => setTimeout(resolve, 1150));
    assert.ok(
      ['· 本轮 11s', '· 本轮 12s'].includes(sr.querySelector('#hud-txt-session .hud-turn-dur').textContent),
      `即使后端暂无新推包，1.15s 后常驻栏也应前进到 11s/12s，实际 ${sr.querySelector('#hud-txt-session .hud-turn-dur').textContent}`
    );
    assert.ok(
      ['11秒', '12秒'].includes(sr.querySelector('#val-turn-dur').textContent),
      `展开卡片应同步每秒更新，实际 ${sr.querySelector('#val-turn-dur').textContent}`
    );

    // 后端在流式结束时推回最终权威数据库耗时 14.2s，DOM 同步为 14s 且定时器停止
    inst.notifyModelOrStreamingChange(null, false, false, 0, null, 'idle');
    inst.updateMetrics({
      conversationId: 'conv-turn-clock',
      sessionRevision: inst.getSessionRevision(),
      metricsSequence: 2,
      isStreaming: false,
      session: {
        turns: 1,
        steps: 3,
        currentTurnDurationSeconds: 14.2,
        currentTurnDurationFormatted: '14秒',
        currentTurnDurationFormattedEn: '14s',
        currentTurnDurationCompactZh: '本轮 14s',
        currentTurnDurationCompactEn: 'Turn 14s',
      },
      tokens: { totalTokens: 200 },
      context: { hasUsageData: true, usedRatio: 0.1 },
    });
    assert.equal(inst.turnClockTimer, null, '进入 idle 后必须立即停止客户端时钟');
    assert.equal(sr.querySelector('#hud-txt-session .hud-turn-dur').textContent, '· 本轮 14s');
    assert.equal(sr.querySelector('#val-turn-dur').textContent, '14秒');
    inst.dispose();
  });

  it('正常轮次高水位曾因瞬时抖动虚高 (>1.5s) 后，进入 idle 必须立即收敛回后端权威耗时', () => {
    const inst = new HudInstance({ cascadeId: 'pane-turn-converge', isPrimaryPane: true });
    const composer = new FakeElement('div');
    composer.setAttribute('data-testid', 'agent-input-box');
    inst.mount(composer);
    const sr = inst.host.shadowRoot;

    inst.switchConversation('conv-turn-converge', 'gemini-4-hydrogen', false);
    inst.updateMetrics({
      conversationId: 'conv-turn-converge',
      sessionRevision: inst.getSessionRevision(),
      metricsSequence: 1,
      availability: 'ready',
      isStreaming: false,
      session: {
        turns: 2,
        steps: 93,
        currentTurnDurationSeconds: 404.46,
        currentTurnDurationFormatted: '6分44秒',
        currentTurnDurationFormattedEn: '6m44s',
        currentTurnDurationCompactZh: '本轮 6m',
        currentTurnDurationCompactEn: 'Turn 6m',
      },
      tokens: { totalTokens: 1000 },
      context: { hasUsageData: true, usedRatio: 0.2 },
    });
    assert.equal(sr.querySelector('#val-turn-dur').textContent, '6分44秒');

    // 模拟前端短暂抖动并推入虚高包 (44分48秒)
    inst.notifyModelOrStreamingChange('gemini-4-hydrogen', true, false, 0, null, 'generating');
    inst.updateMetrics({
      conversationId: 'conv-turn-converge',
      sessionRevision: inst.getSessionRevision(),
      metricsSequence: 2,
      availability: 'ready',
      isStreaming: true,
      session: {
        turns: 2,
        steps: 93,
        currentTurnDurationSeconds: 2688,
        currentTurnDurationFormatted: '44分48秒',
        currentTurnDurationFormattedEn: '44m48s',
        currentTurnDurationCompactZh: '本轮 44m',
        currentTurnDurationCompactEn: 'Turn 44m',
      },
      tokens: { totalTokens: 1000 },
      context: { hasUsageData: true, usedRatio: 0.2 },
    });

    // 回到 idle 且后端下发权威 6分44秒，不得死锁在 44分48秒
    inst.notifyModelOrStreamingChange(null, false, false, 0, null, 'idle');
    inst.updateMetrics({
      conversationId: 'conv-turn-converge',
      sessionRevision: inst.getSessionRevision(),
      metricsSequence: 3,
      availability: 'ready',
      isStreaming: false,
      session: {
        turns: 2,
        steps: 93,
        currentTurnDurationSeconds: 404.46,
        currentTurnDurationFormatted: '6分44秒',
        currentTurnDurationFormattedEn: '6m44s',
        currentTurnDurationCompactZh: '本轮 6m',
        currentTurnDurationCompactEn: 'Turn 6m',
      },
      tokens: { totalTokens: 1000 },
      context: { hasUsageData: true, usedRatio: 0.2 },
    });
    assert.equal(sr.querySelector('#hud-txt-session .hud-turn-dur').textContent, '· 本轮 6m');
    assert.equal(sr.querySelector('#val-turn-dur').textContent, '6分44秒');
    assert.equal(inst.turnHighWaterMark, null);
    inst.dispose();
  });

  it('闲置输入区出现附件处理态 send-button-pending / send-button-loading 时不得误判为流式活跃', () => {
    const mgr = new AntigravityHudManager({ enabled: true });
    const view = new FakeElement('div');
    view.setAttribute('data-testid', 'conversation-view');
    const composer = new FakeElement('div');
    composer.className = 'surface-composer';
    const sendPendingBtn = new FakeElement('button');
    sendPendingBtn.setAttribute('data-testid', 'send-button-pending');
    composer.appendChild(sendPendingBtn);
    view.appendChild(composer);
    assert.equal(mgr.resolveActivityPhase(view), 'idle');

    sendPendingBtn.setAttribute('data-testid', 'send-button-loading');
    assert.equal(mgr.resolveActivityPhase(view), 'idle');

    sendPendingBtn.setAttribute('data-testid', 'input-cancel-button');
    assert.equal(mgr.resolveActivityPhase(view), 'generating');
    mgr.dispose();
  });

  it('子智能体切换间隙或 turns 延迟落库时，本轮用时保持单调递增不暂停、不回退', () => {
    const inst = new HudInstance({ cascadeId: 'pane-subagent-monotonic', isPrimaryPane: true });
    const composer = new FakeElement('div');
    composer.setAttribute('data-testid', 'agent-input-box');
    inst.mount(composer);
    const sr = inst.host.shadowRoot;

    // 1. 子智能体运行到 23s，且起初 turns 尚未写入 DB（turns=0）
    inst.switchConversation('conv-subagent-clock', 'gemini-3.8-flash', true, true, 1);
    inst.updateMetrics({
      conversationId: 'conv-subagent-clock',
      sessionRevision: inst.getSessionRevision(),
      metricsSequence: 1,
      isStreaming: true,
      isSubagentRunning: true,
      runningSubagentCount: 1,
      session: {
        turns: 0,
        steps: 3,
        subagentCount: 1,
        currentTurnDurationSeconds: 23.0,
        currentTurnDurationFormatted: '23秒',
        currentTurnDurationFormattedEn: '23s',
        currentTurnDurationCompactZh: '本轮 23s',
        currentTurnDurationCompactEn: 'Turn 23s',
      },
      tokens: { totalTokens: 100 },
      context: { hasUsageData: true, usedRatio: 0.1 },
    });
    assert.equal(sr.querySelector('#hud-txt-session .hud-turn-dur').textContent, '· 本轮 23s');

    // 2. 子智能体切换瞬间短暂出现 idle 抖动且后端仅上报 20s，绝不能从 23s 回退到 20s
    inst.notifyModelOrStreamingChange(null, false, false, 0, null, 'idle');
    inst.updateMetrics({
      conversationId: 'conv-subagent-clock',
      sessionRevision: inst.getSessionRevision(),
      metricsSequence: 2,
      isStreaming: false,
      isSubagentRunning: false,
      runningSubagentCount: 0,
      session: {
        turns: 0,
        steps: 3,
        subagentCount: 1,
        currentTurnDurationSeconds: 20.0,
        currentTurnDurationFormatted: '20秒',
        currentTurnDurationFormattedEn: '20s',
        currentTurnDurationCompactZh: '本轮 20s',
        currentTurnDurationCompactEn: 'Turn 20s',
      },
      tokens: { totalTokens: 100 },
      context: { hasUsageData: true, usedRatio: 0.1 },
    });
    assert.equal(sr.querySelector('#hud-txt-session .hud-turn-dur').textContent, '· 本轮 23s');
    assert.equal(sr.querySelector('#val-turn-dur').textContent, '23秒');

    // 3. 父对话恢复流式并延迟落库 turns: 0 -> 1 且 backendSec=20s，计时仍应从 >=23s 继续前进
    inst.notifyModelOrStreamingChange('gemini-3.8-flash', true, true, 1, null, 'executing');
    inst.updateMetrics({
      conversationId: 'conv-subagent-clock',
      sessionRevision: inst.getSessionRevision(),
      metricsSequence: 3,
      isStreaming: true,
      isSubagentRunning: true,
      runningSubagentCount: 1,
      session: {
        turns: 1,
        steps: 4,
        subagentCount: 1,
        currentTurnDurationSeconds: 20.0,
        currentTurnDurationFormatted: '20秒',
        currentTurnDurationFormattedEn: '20s',
        currentTurnDurationCompactZh: '本轮 20s',
        currentTurnDurationCompactEn: 'Turn 20s',
      },
      tokens: { totalTokens: 120 },
      context: { hasUsageData: true, usedRatio: 0.12 },
    });
    assert.equal(sr.querySelector('#hud-txt-session .hud-turn-dur').textContent, '· 本轮 23s');
    assert.ok(inst.turnClockTimer !== null, '子智能体恢复活跃后客户端时钟必须继续运行');
    inst.dispose();
  });

  it('模型用时与工具调用用时共用客户端走表器：按活跃阶段分相每秒递增、切换不回退闪烁、结束后校准权威值', async () => {
    const inst = new HudInstance({ cascadeId: 'pane-sub-clocks', isPrimaryPane: true });
    const composer = new FakeElement('div');
    composer.setAttribute('data-testid', 'agent-input-box');
    inst.mount(composer);
    const sr = inst.host.shadowRoot;

    // 1. 模型思考阶段 (activeModelStepCount=1, activeToolStepCount=0)：模型用时走表，工具用时冻结
    inst.switchConversation('conv-sub-clocks', 'gemini-3.8-flash', true, false, 0, null, 'generating');
    inst.updateMetrics({
      conversationId: 'conv-sub-clocks',
      sessionRevision: inst.getSessionRevision(),
      metricsSequence: 1,
      isStreaming: true,
      activityPhase: 'generating',
      session: {
        turns: 1,
        steps: 3,
        modelDurationSeconds: 10,
        modelDurationFormatted: '10秒',
        modelDurationFormattedEn: '10s',
        inFlightModelDurationSeconds: 5,
        activeModelStepCount: 1,
        toolDurationSeconds: 4,
        toolDurationFormatted: '4秒',
        toolDurationFormattedEn: '4s',
        inFlightToolDurationSeconds: 0,
        activeToolStepCount: 0,
        currentTurnDurationSeconds: 9,
        currentTurnDurationFormatted: '9秒',
        currentTurnDurationFormattedEn: '9s',
        currentTurnDurationCompactZh: '本轮 9s',
        currentTurnDurationCompactEn: 'Turn 9s',
      },
      tokens: { totalTokens: 100 },
      context: { hasUsageData: true, usedRatio: 0.1 },
    });
    assert.equal(sr.querySelector('#val-model-dur').textContent, '15秒');
    assert.equal(sr.querySelector('#val-tool-dur').textContent, '4秒');

    await new Promise((resolve) => setTimeout(resolve, 1150));
    assert.ok(
      ['16秒', '17秒'].includes(sr.querySelector('#val-model-dur').textContent),
      `模型活跃阶段模型用时应每秒推进，实际 ${sr.querySelector('#val-model-dur').textContent}`
    );
    assert.equal(sr.querySelector('#val-tool-dur').textContent, '4秒', '模型思考时工具用时不得同时走表');

    // 2. 刚切入工具阶段但 DB 尚未落盘上一步模型耗时 (modelDurationSeconds 暂仍为 10, active=0)，模型用时不得回退到 10s
    inst.notifyModelOrStreamingChange(null, true, false, 0, null, 'executing');
    inst.updateMetrics({
      conversationId: 'conv-sub-clocks',
      sessionRevision: inst.getSessionRevision(),
      metricsSequence: 2,
      isStreaming: true,
      activityPhase: 'executing',
      session: {
        turns: 1,
        steps: 4,
        modelDurationSeconds: 10,
        modelDurationFormatted: '10秒',
        modelDurationFormattedEn: '10s',
        inFlightModelDurationSeconds: 0,
        activeModelStepCount: 0,
        toolDurationSeconds: 4,
        toolDurationFormatted: '4秒',
        toolDurationFormattedEn: '4s',
        inFlightToolDurationSeconds: 1,
        activeToolStepCount: 1,
        currentTurnDurationSeconds: 11,
        currentTurnDurationFormatted: '11秒',
        currentTurnDurationFormattedEn: '11s',
        currentTurnDurationCompactZh: '本轮 11s',
        currentTurnDurationCompactEn: 'Turn 11s',
      },
      tokens: { totalTokens: 100 },
      context: { hasUsageData: true, usedRatio: 0.1 },
    });
    const heldModelText = sr.querySelector('#val-model-dur').textContent;
    assert.ok(['16秒', '17秒'].includes(heldModelText), `切换瞬间模型用时应保持高水位不回退，实际 ${heldModelText}`);
    assert.equal(sr.querySelector('#val-tool-dur').textContent, '5秒');

    await new Promise((resolve) => setTimeout(resolve, 1150));
    assert.equal(sr.querySelector('#val-model-dur').textContent, heldModelText, '工具执行期间模型用时应暂停走表');
    assert.ok(
      ['6秒', '7秒'].includes(sr.querySelector('#val-tool-dur').textContent),
      `工具活跃阶段工具用时应每秒推进，实际 ${sr.querySelector('#val-tool-dur').textContent}`
    );

    // 3. 结束后归位到数据库权威耗时且时钟停止
    inst.notifyModelOrStreamingChange(null, false, false, 0, null, 'idle');
    inst.updateMetrics({
      conversationId: 'conv-sub-clocks',
      sessionRevision: inst.getSessionRevision(),
      metricsSequence: 3,
      isStreaming: false,
      activityPhase: 'idle',
      session: {
        turns: 1,
        steps: 5,
        modelDurationSeconds: 16.4,
        modelDurationFormatted: '16秒',
        modelDurationFormattedEn: '16s',
        inFlightModelDurationSeconds: 0,
        activeModelStepCount: 0,
        toolDurationSeconds: 6.3,
        toolDurationFormatted: '6秒',
        toolDurationFormattedEn: '6s',
        inFlightToolDurationSeconds: 0,
        activeToolStepCount: 0,
        currentTurnDurationSeconds: 12.7,
        currentTurnDurationFormatted: '13秒',
        currentTurnDurationFormattedEn: '13s',
        currentTurnDurationCompactZh: '本轮 13s',
        currentTurnDurationCompactEn: 'Turn 13s',
      },
      tokens: { totalTokens: 200 },
      context: { hasUsageData: true, usedRatio: 0.1 },
    });
    assert.equal(inst.turnClockTimer, null);
    assert.equal(inst.modelClockAnchor, null);
    assert.equal(inst.toolClockAnchor, null);
    assert.equal(sr.querySelector('#val-model-dur').textContent, '16秒');
    assert.equal(sr.querySelector('#val-tool-dur').textContent, '6秒');
    inst.dispose();
  });

  it('并行多活跃步时（activeModelStepCount=3, activeToolStepCount=5）前端走表严格封顶 1x 物理时钟，不倍速快进', async () => {
    const inst = new HudInstance({ cascadeId: 'pane-rate-cap', isPrimaryPane: true });
    const composer = new FakeElement('div');
    composer.setAttribute('data-testid', 'agent-input-box');
    inst.mount(composer);
    const sr = inst.host.shadowRoot;

    inst.switchConversation('conv-rate-cap', 'gemini-3.8-flash', true, false, 0, null, 'executing');
    inst.updateMetrics({
      conversationId: 'conv-rate-cap',
      sessionRevision: inst.getSessionRevision(),
      metricsSequence: 1,
      isStreaming: true,
      activityPhase: 'executing',
      session: {
        turns: 1,
        steps: 10,
        modelDurationSeconds: 10,
        modelDurationFormatted: '10秒',
        modelDurationFormattedEn: '10s',
        inFlightModelDurationSeconds: 2,
        activeModelStepCount: 3,
        toolDurationSeconds: 20,
        toolDurationFormatted: '20秒',
        toolDurationFormattedEn: '20s',
        inFlightToolDurationSeconds: 5,
        activeToolStepCount: 5,
        currentTurnDurationSeconds: 17,
        currentTurnDurationFormatted: '17秒',
        currentTurnDurationFormattedEn: '17s',
        currentTurnDurationCompactZh: '本轮 17s',
        currentTurnDurationCompactEn: 'Turn 17s',
      },
      tokens: { totalTokens: 100 },
      context: { hasUsageData: true, usedRatio: 0.1 },
    });

    assert.equal(inst.modelClockAnchor.rate, 1);
    assert.equal(inst.toolClockAnchor.rate, 1);
    assert.equal(sr.querySelector('#val-model-dur').textContent, '12秒');
    assert.equal(sr.querySelector('#val-tool-dur').textContent, '25秒');

    await new Promise((resolve) => setTimeout(resolve, 1150));
    assert.ok(
      ['13秒', '14秒'].includes(sr.querySelector('#val-model-dur').textContent),
      `模型用时 1.15s 后应只推进约 1s，不得 3x 快进，实际 ${sr.querySelector('#val-model-dur').textContent}`
    );
    assert.ok(
      ['26秒', '27秒'].includes(sr.querySelector('#val-tool-dur').textContent),
      `工具用时 1.15s 后应只推进约 1s，不得 5x 快进，实际 ${sr.querySelector('#val-tool-dur').textContent}`
    );
    inst.dispose();
  });

  it('独立子智能体分栏 (isSubpane) 采用同一套小圆点状态机语义，且不自报嵌套子智能体', () => {
    const doc = new FakeElement('document');
    doc.body = new FakeElement('body', doc);
    const mgr = new AntigravityHudManager();
    const subView = new FakeElement('div', doc);
    subView.setAttribute('data-testid', 'subagent-tab-conversation');
    subView.setAttribute('data-cascade-id', 'sub-conv-1');
    subView.setAttribute('data-media-drop-scope', 'subpane');

    // 1. 子智能体分栏自身思考中 -> generating（常亮蓝），且不误报 nested subagent
    const thinkingMarker = new FakeElement('div', doc);
    thinkingMarker.setAttribute('data-testid', 'browser-subagent-thinking');
    subView.appendChild(thinkingMarker);
    assert.equal(mgr.resolveSubagentState(subView, { isSubpane: true }).isSubagentRunning, false);
    assert.equal(mgr.resolveActivityPhase(subView, null, { isSubpane: true }), 'generating');

    // 2. 子智能体自身执行工具（Stop subagent + 工具 shimmer）-> executing（呼吸蓝）
    thinkingMarker.remove();
    const stopSubBtn = new FakeElement('button', doc);
    stopSubBtn.setAttribute('aria-label', 'Stop subagent');
    subView.appendChild(stopSubBtn);
    const toolShimmer = new FakeElement('span', doc);
    toolShimmer.className = 'animate-shimmer-text';
    toolShimmer.textContent = 'Running read_file';
    subView.appendChild(toolShimmer);
    assert.equal(mgr.resolveSubagentState(subView, { isSubpane: true }).isSubagentRunning, false);
    assert.equal(mgr.resolveActivityPhase(subView, null, { isSubpane: true }), 'executing');

    // 3. 子智能体停止，即使残留 .codicon-loading 与旧 shimmer -> idle（灰色）
    stopSubBtn.remove();
    const staleLoading = new FakeElement('span', doc);
    staleLoading.className = 'codicon-loading';
    subView.appendChild(staleLoading);
    assert.equal(mgr.resolveActivityPhase(subView, null, { isSubpane: true }), 'idle');

    mgr.dispose();
  });

  it('上下文进度条采用单色渐深蓝平滑演进，压缩次数徽章严格呈 1 轻蓝 / 2 实心琥珀 / 3+ 实心正红三级联动', () => {
    const parseRgb = (str) => {
      const m = String(str).match(/rgb\(\s*(\d+),\s*(\d+),\s*(\d+)\s*\)/i);
      assert.ok(m, `应输出 rgb() 格式颜色，实际 ${str}`);
      return [Number(m[1]), Number(m[2]), Number(m[3])];
    };
    const renderMeter = ({ compactionCount = 0, usedRatio = 0.2, dark = false }) => {
      const instance = new HudInstance();
      const host = new FakeElement('div');
      const shadow = host.attachShadow({ mode: 'open' });
      host.shadowRoot = shadow;
      if (dark) host.setAttribute('data-theme', 'dark');
      instance.host = host;
      instance.shadow = shadow;
      shadow.innerHTML = instance.buildHudHtml();
      instance.isDarkTheme = dark;
      instance.switchConversation('conv-ctx-meter');
      instance.applyMetricsToDom({
        conversationId: 'conv-ctx-meter',
        sessionRevision: instance.getSessionRevision(),
        updatedAt: Date.now(),
        isStreaming: false,
        session: { turns: 1, steps: 2, compactionCount },
        tokens: { totalTokens: 1000 },
        context: { hasUsageData: true, usedTokens: 1000, usedRatio, isFallbackCapacity: false },
      });
      return instance;
    };

    // 1. 浅色模式下 15% -> 50% -> 95% 保持单调加深的同一蓝色系，95% 也不跳变黄/红
    const r15 = renderMeter({ compactionCount: 1, usedRatio: 0.15 });
    const r50 = renderMeter({ compactionCount: 2, usedRatio: 0.5 });
    const r95 = renderMeter({ compactionCount: 4, usedRatio: 0.95 });

    const fill15 = parseRgb(r15.shadow.querySelector('#hud-meter-fill').getAttribute('fill'));
    const fill50 = parseRgb(r50.shadow.querySelector('#hud-meter-fill').getAttribute('fill'));
    const fill95 = parseRgb(r95.shadow.querySelector('#hud-meter-fill').getAttribute('fill'));
    assert.ok(fill15[2] > fill15[0] && fill50[2] > fill50[0] && fill95[2] > fill95[0], '所有阶段必须保持蓝色主通道占优');
    assert.ok(fill15[0] > fill50[0] && fill50[0] > fill95[0], '浅色模式红色分量应随占比递增而单调加深');
    assert.ok(fill15[1] > fill50[1] && fill50[1] > fill95[1], '浅色模式绿色分量应随占比递增而单调加深');

    // 2. 深色模式下同样保持冰蓝 -> 品牌亮蓝 -> 电光深蓝单调加深
    const dark10Inst = renderMeter({ compactionCount: 1, usedRatio: 0.1, dark: true });
    const dark90Inst = renderMeter({ compactionCount: 3, usedRatio: 0.9, dark: true });
    const dark10 = parseRgb(dark10Inst.shadow.querySelector('#hud-meter-fill').getAttribute('fill'));
    const dark90 = parseRgb(dark90Inst.shadow.querySelector('#hud-meter-fill').getAttribute('fill'));
    assert.ok(dark10[2] > dark10[0] && dark90[2] > dark90[0], '深色模式同样必须保持单色蓝通道占优');
    assert.ok(dark10[0] > dark90[0] && dark10[1] > dark90[1], '深色模式由浅冰蓝平滑过渡到高饱电光蓝');

    // 3. 压缩次数徽章三级语义类与属性：1 -> low, 2 -> warn, 3+ -> danger, 0 -> 隐藏并清除
    const badge1 = r15.shadow.querySelector('#hud-compaction-badge');
    const badge2 = r50.shadow.querySelector('#hud-compaction-badge');
    const badge4 = r95.shadow.querySelector('#hud-compaction-badge');
    assert.equal(badge1.getAttribute('data-compaction-tier'), 'low');
    assert.equal(badge1.classList.contains('is-compaction-low'), true);
    assert.equal(badge2.getAttribute('data-compaction-tier'), 'warn');
    assert.equal(badge2.classList.contains('is-compaction-warn'), true);
    assert.equal(badge4.getAttribute('data-compaction-tier'), 'danger');
    assert.equal(badge4.classList.contains('is-compaction-danger'), true);

    const cleared = renderMeter({ compactionCount: 0, usedRatio: 0.3 });
    const badge0 = cleared.shadow.querySelector('#hud-compaction-badge');
    assert.equal(badge0.hasAttribute('hidden'), true);
    assert.equal(badge0.getAttribute('data-compaction-tier'), null);
    assert.equal(badge0.classList.contains('is-compaction-warn'), false);
    assert.equal(badge0.classList.contains('is-compaction-danger'), false);
  });

  it('紧凑指标同步直达渲染、禁用输出速度呼吸态与 Popover 最近一步真实速度副标保持真实与生命周期安全', () => {
    const prevWindow = globalThis.window;
    const prevDocument = globalThis.document;
    const prevRaf = globalThis.requestAnimationFrame;
    const prevCaf = globalThis.cancelAnimationFrame;

    let nextRafId = 1;
    const rafQueue = new Map();
    const fakeRaf = (cb) => {
      const id = nextRafId++;
      rafQueue.set(id, cb);
      return id;
    };
    const fakeCaf = (id) => {
      rafQueue.delete(id);
    };

    try {
      const doc = { hidden: false };
      globalThis.document = doc;
      globalThis.requestAnimationFrame = fakeRaf;
      globalThis.cancelAnimationFrame = fakeCaf;
      globalThis.window = {
        matchMedia: () => ({ matches: false }),
        requestAnimationFrame: fakeRaf,
        cancelAnimationFrame: fakeCaf,
        innerWidth: 1200,
        innerHeight: 800,
        addEventListener() {},
        removeEventListener() {},
      };

      const instance = new HudInstance();
      const host = new FakeElement('div', doc);
      const shadow = host.attachShadow({ mode: 'open' });
      host.shadowRoot = shadow;
      instance.host = host;
      instance.shadow = shadow;
      const builtHtml = instance.buildHudHtml();
      assert.equal((builtHtml.match(/class="hud-popover-row"/g) || []).length, 21);
      shadow.innerHTML = builtHtml;
      instance.switchConversation('conv-smooth');

      const baseMetrics = (tps, latestTps, timed, phase, totalTokens = 1000, cacheHitRate = 0.5, usedRatio = 0.25, latestTtft = undefined, estCost = undefined, cacheSaved = undefined) => ({
        conversationId: 'conv-smooth',
        sessionRevision: instance.getSessionRevision(),
        updatedAt: Date.now(),
        isStreaming: phase !== 'idle',
        activityPhase: phase,
        availability: 'ready',
        session: {
          turns: 2,
          steps: 4,
          compactionCount: 0,
          modelDurationSeconds: 10,
          modelDurationFormatted: '10秒',
          modelDurationFormattedEn: '10s',
          toolDurationSeconds: 2,
          toolDurationFormatted: '2秒',
          toolDurationFormattedEn: '2s',
          averageTtftSeconds: 1.5,
          averageTtftFormatted: '1.50 秒',
          averageTtftFormattedEn: '1.50s',
          latestStepTtftSeconds: latestTtft,
          latestStepTtftFormatted: latestTtft !== undefined ? `${latestTtft.toFixed(2)} 秒` : undefined,
          latestStepTtftFormattedEn: latestTtft !== undefined ? `${latestTtft.toFixed(2)}s` : undefined,
          outputTps: tps,
          outputTpsFormatted: timed > 0 ? `${tps.toFixed(2)} tok/s` : phase !== 'idle' ? '计算中...' : '—',
          currentTurnOutputTps: tps,
          currentTurnOutputTpsFormatted: timed > 0 ? `${tps.toFixed(2)} tok/s` : phase !== 'idle' ? '计算中...' : '—',
          currentTurnTimedSamples: timed,
          latestStepOutputTps: latestTps,
          latestStepOutputTpsFormatted: latestTps > 0 ? `${latestTps.toFixed(2)} tok/s` : undefined,
          samples: { timed },
        },
        tokens: {
          totalTokens,
          totalTokensCompact: `${totalTokens} tok`,
          totalTokensFormatted: `${totalTokens} tok`,
          cacheHitRate,
          cacheHitRateFormatted: `${(cacheHitRate * 100).toFixed(2)}%`,
          uncachedInputTokens: 500,
          uncachedInputFormatted: '500 tok',
          cachedReadTokens: 500,
          cachedReadFormatted: '500 tok',
          outputTokens: 200,
          outputFormatted: '200 tok',
          estimatedCostUsd: estCost,
          estimatedCostFormatted: estCost !== undefined ? `~$${estCost.toFixed(2)}` : undefined,
          cacheSavedUsd: cacheSaved,
          cacheSavedFormatted: cacheSaved !== undefined ? `~$${cacheSaved.toFixed(2)}` : undefined,
        },
        context: {
          hasUsageData: true,
          modelId: 'gemini-4-hydrogen',
          modelDisplayName: 'Gemini 4 Hydrogen',
          usedTokens: Math.round(100000 * usedRatio),
          usedTokensCompact: '25K',
          capacityTokens: 100000,
          isFallbackCapacity: false,
          usedRatio,
          usedRatioFormatted: `${Math.round(usedRatio * 100)}%`,
          breakdown: {},
        },
      });

      const speedEl = shadow.querySelector('#hud-txt-session .hud-speed');
      const tokEl = shadow.querySelector('#hud-txt-tokens .hud-tok-total');
      const cacheEl = shadow.querySelector('#hud-txt-tokens .hud-cache-val');
      const ctxEl = shadow.querySelector('#hud-txt-context');
      const popTpsEl = shadow.querySelector('#val-tps');
      const popLatestTtftEl = shadow.querySelector('#val-ttft-latest');
      const popLatestTtftLbl = shadow.querySelector('#lbl-ttft-latest');
      const popLatestTpsEl = shadow.querySelector('#val-tps-latest');
      const popLatestTpsLbl = shadow.querySelector('#lbl-tps-latest');
      const popEstCostEl = shadow.querySelector('#val-est-cost');
      const popCacheSavedEl = shadow.querySelector('#val-cache-saved');

      // 1. 首次从 计算中... / 骨架进入无真实读数状态 -> 同步直接写入、不启动 rAF、不挂载呼吸类
      instance.applyMetricsToDom(baseMetrics(0, 0, 0, 'generating', 0, 0, 0.1));
      assert.equal(speedEl.textContent, ' · 计算中...');
      assert.equal(speedEl.classList.contains('is-tps-measuring'), false);
      assert.equal(popLatestTtftEl.textContent, '—');
      assert.equal(popLatestTpsEl.textContent, '—', '固定占位行无样本时应展示 —');
      assert.equal(popEstCostEl.textContent, '—');
      assert.equal(popCacheSavedEl.textContent, '—');
      assert.equal(rafQueue.size, 0);

      // 2. 首个真实数值落盘 (44 tok/s, TTFT 1.12s) -> 全部指标同步直达且 generating 期间不开启呼吸类
      instance.applyMetricsToDom(baseMetrics(44, 44, 1, 'generating', 1000, 0.5, 0.2, 1.12, 0.05, 0.12));
      assert.equal(speedEl.textContent, ' · 44 tok/s');
      assert.equal(tokEl.textContent, '1K tok');
      assert.equal(cacheEl.textContent, '50%');
      assert.equal(ctxEl.textContent, '20%');
      assert.equal(popTpsEl.textContent, '44 tok/s');
      assert.equal(popLatestTtftEl.textContent, '1.12 秒');
      assert.equal(popLatestTpsEl.textContent, '44 tok/s', '固定占位方式下即使只有 1 步也固定展示最近一步速度');
      assert.equal(popEstCostEl.textContent, '~$0.05');
      assert.equal(popCacheSavedEl.textContent, '~$0.12');
      assert.equal(speedEl.classList.contains('is-tps-measuring'), false);
      assert.equal(popTpsEl.classList.contains('is-tps-measuring'), false);
      assert.equal(rafQueue.size, 0, '禁用数值 Tween 后不得启动 requestAnimationFrame');

      // 3. 工具执行期间 (executing) 与新步骤落盘 (117 tok/s, 最近一步 179.27 tok/s, TTFT 0.85s) 均同步直达终点，无任何过渡帧
      instance.applyMetricsToDom(baseMetrics(117, 179.27, 7, 'executing', 5000, 0.9, 0.6, 0.85, 0.24, 1.35));
      assert.equal(speedEl.textContent, ' · 117 tok/s');
      assert.equal(tokEl.textContent, '5K tok');
      assert.equal(cacheEl.textContent, '90%');
      assert.equal(ctxEl.textContent, '60%');
      assert.equal(popTpsEl.textContent, '117 tok/s');
      assert.equal(popLatestTtftEl.textContent, '0.85 秒');
      assert.equal(popLatestTpsEl.textContent, '179 tok/s');
      assert.equal(popEstCostEl.textContent, '~$0.24');
      assert.equal(popCacheSavedEl.textContent, '~$1.35');
      assert.equal(speedEl.classList.contains('is-tps-measuring'), false);
      assert.equal(rafQueue.size, 0);

      // 4. 连续更新 (130 tok/s) 与展开 Popover 1 时 (160 tok/s) 同样同步直达终点，切换语言同步更新
      instance.applyMetricsToDom(baseMetrics(130, 179.27, 8, 'idle', 6000, 0.92, 0.65, 0.91, 0.30, 1.50));
      assert.equal(speedEl.textContent, ' · 130 tok/s');
      assert.equal(tokEl.textContent, '6K tok');
      assert.equal(cacheEl.textContent, '92%');
      assert.equal(ctxEl.textContent, '65%');
      assert.equal(rafQueue.size, 0);

      instance.activePopoverId = 'session';
      const popMetrics = baseMetrics(160, 179.27, 8, 'generating', 6000, 0.92, 0.65, 0.91, 0.30, 1.50);
      instance.lastMetrics = popMetrics;
      instance.applyMetricsToDom(popMetrics);
      assert.equal(popTpsEl.textContent, '160 tok/s');
      assert.equal(speedEl.classList.contains('is-tps-measuring'), false);
      assert.equal(popTpsEl.classList.contains('is-tps-measuring'), false);
      assert.equal(rafQueue.size, 0);
      instance.activePopoverId = null;

      instance.setLanguage('en');
      assert.equal(popLatestTtftLbl.textContent, 'Latest Step TTFT');
      assert.equal(popLatestTtftEl.textContent, '0.91s');
      assert.equal(popLatestTpsLbl.textContent, 'Latest Step TPS');
      assert.equal(popLatestTpsEl.textContent, '179 tok/s');
      assert.equal(rafQueue.size, 0);
      instance.setLanguage('zh');

      // 5. unavailable -> ready 恢复路径：#val-tps-latest、#val-ttft-latest、#val-est-cost、#val-cache-saved 必须保持固定占位且不得永久隐藏
      const loadingMetrics = {
        ...baseMetrics(0, 0, 0, 'idle', 0, 0, 0),
        availability: 'loading',
        session: { ...baseMetrics(0, 0, 0, 'idle', 0, 0, 0).session, turns: 0, steps: 0 },
      };
      instance.applyMetricsToDom(loadingMetrics);
      assert.equal(popLatestTpsEl.hasAttribute('hidden'), false, 'unavailable/loading 分支不得隐藏 #val-tps-latest');
      assert.equal(popLatestTpsEl.textContent, '—');
      assert.equal(popLatestTtftEl.textContent, '—');
      assert.equal(popEstCostEl.textContent, '—');
      assert.equal(popCacheSavedEl.textContent, '—');

      instance.applyMetricsToDom(baseMetrics(120, 188.8, 9, 'idle', 6500, 0.93, 0.7, 1.42, 0.55, 2.20));
      assert.equal(popLatestTpsEl.hasAttribute('hidden'), false, '恢复 ready 后 #val-tps-latest 必须保持可见');
      assert.equal(popLatestTpsEl.textContent, '189 tok/s');
      assert.equal(popLatestTtftEl.textContent, '1.42 秒');
      assert.equal(popEstCostEl.textContent, '~$0.55');
      assert.equal(popCacheSavedEl.textContent, '~$2.2');

      instance.switchConversation('conv-other');
      assert.equal(rafQueue.size, 0);
      instance.dispose();
    } finally {
      globalThis.window = prevWindow;
      globalThis.document = prevDocument;
      globalThis.requestAnimationFrame = prevRaf;
      globalThis.cancelAnimationFrame = prevCaf;
    }
  });

  it('展开卡片计时器在双时钟边界、步完结偏小及 DOM 闪断恢复时保持单调稳定不闪回，且无位置变化时不强触发回流', () => {
    const inst = new HudInstance({ cascadeId: 'pane-anti-flicker', isPrimaryPane: true });
    const composer = new FakeElement('div');
    composer.setAttribute('data-testid', 'agent-input-box');
    inst.mount(composer);
    const sr = inst.host.shadowRoot;

    // 1. 启动活跃轮次：初始锚点 12.4s，后端随后推来 12.6s（领先 0.2s 且跨过 12.5 四舍五入边界）
    inst.switchConversation('conv-anti-flicker', 'gemini-3.8-flash', true, false, 0, null, 'generating');
    inst.updateMetrics({
      conversationId: 'conv-anti-flicker',
      sessionRevision: inst.getSessionRevision(),
      metricsSequence: 1,
      isStreaming: true,
      activityPhase: 'generating',
      session: {
        turns: 1,
        steps: 2,
        modelDurationSeconds: 10,
        modelDurationFormatted: '10秒',
        inFlightModelDurationSeconds: 2.4,
        activeModelStepCount: 1,
        toolDurationSeconds: 2,
        toolDurationFormatted: '2秒',
        inFlightToolDurationSeconds: 0,
        activeToolStepCount: 0,
        currentTurnDurationSeconds: 12.4,
        currentTurnDurationFormatted: '12秒',
        currentTurnDurationCompactZh: '本轮 12s',
      },
      tokens: { totalTokens: 100 },
      context: { hasUsageData: true, usedRatio: 0.1 },
    });
    assert.equal(sr.querySelector('#val-turn-dur').textContent, '12秒');

    // 后端推来 12.6s：syncTurnClock 同步前推并对齐 lastRenderedSec=13，随后立即执行 tickTurnClock 绝不能回退到 12秒
    inst.updateMetrics({
      conversationId: 'conv-anti-flicker',
      sessionRevision: inst.getSessionRevision(),
      metricsSequence: 2,
      isStreaming: true,
      activityPhase: 'generating',
      session: {
        turns: 1,
        steps: 2,
        modelDurationSeconds: 10,
        modelDurationFormatted: '10秒',
        inFlightModelDurationSeconds: 2.4,
        activeModelStepCount: 1,
        toolDurationSeconds: 2,
        toolDurationFormatted: '2秒',
        inFlightToolDurationSeconds: 0,
        activeToolStepCount: 0,
        currentTurnDurationSeconds: 12.6,
        currentTurnDurationFormatted: '13秒',
        currentTurnDurationCompactZh: '本轮 13s',
      },
      tokens: { totalTokens: 110 },
      context: { hasUsageData: true, usedRatio: 0.1 },
    });
    assert.equal(sr.querySelector('#val-turn-dur').textContent, '13秒');
    inst.tickTurnClock();
    assert.equal(sr.querySelector('#val-turn-dur').textContent, '13秒', 'tickTurnClock 不得因双时钟误差把 13秒 闪回 12秒');

    // 2. 模拟前端模型钟先走到 16.8s (17秒)，随后旧模型步落盘完成但宿主耗时仅 15.9s（completedBase 前进且差值 >0.6s），切工具或继续模型步均不可向回跌落
    inst.modelClockAnchor.anchorMs = Date.now() - 4400; // 12.4 + 4.4 = 16.8s -> 17秒
    inst.tickTurnClock();
    assert.equal(sr.querySelector('#val-model-dur').textContent, '17秒');
    inst.updateMetrics({
      conversationId: 'conv-anti-flicker',
      sessionRevision: inst.getSessionRevision(),
      metricsSequence: 3,
      isStreaming: true,
      activityPhase: 'executing',
      session: {
        turns: 1,
        steps: 3,
        modelDurationSeconds: 15.9,
        modelDurationFormatted: '16秒',
        inFlightModelDurationSeconds: 0,
        activeModelStepCount: 0,
        toolDurationSeconds: 2,
        toolDurationFormatted: '2秒',
        inFlightToolDurationSeconds: 1.0,
        activeToolStepCount: 1,
        currentTurnDurationSeconds: 17.0,
        currentTurnDurationFormatted: '17秒',
        currentTurnDurationCompactZh: '本轮 17s',
      },
      tokens: { totalTokens: 150 },
      context: { hasUsageData: true, usedRatio: 0.15 },
    });
    assert.equal(sr.querySelector('#val-model-dur').textContent, '17秒', '活跃期步骤完结即使差值 >0.6s 也不得倒退闪烁');

    // 3a. 后端仍有活跃步时 DOM 闪断：不回退过期 lastMetrics，保持高水位
    inst.notifyModelOrStreamingChange(null, false, false, 0, null, 'idle');
    assert.equal(sr.querySelector('#val-model-dur').textContent, '17秒', 'DOM 闪断时不得用过期 lastMetrics (15.9) 刷低');
    assert.equal(sr.querySelector('#val-turn-dur').textContent, '17秒');
    inst.notifyModelOrStreamingChange(null, true, false, 0, null, 'executing');

    // 3b. 步切换空档期（DB activeModel=0, activeTool=0）叠加 DOM 短暂 idle 闪断后恢复：应冻结保持高水位，不回退不丢秒
    inst.updateMetrics({
      conversationId: 'conv-anti-flicker',
      sessionRevision: inst.getSessionRevision(),
      metricsSequence: 4,
      isStreaming: true,
      activityPhase: 'executing',
      session: {
        turns: 1,
        steps: 3,
        modelDurationSeconds: 15.9,
        modelDurationFormatted: '16秒',
        inFlightModelDurationSeconds: 0,
        activeModelStepCount: 0,
        toolDurationSeconds: 3.0,
        toolDurationFormatted: '3秒',
        inFlightToolDurationSeconds: 0,
        activeToolStepCount: 0,
        currentTurnDurationSeconds: 17.0,
        currentTurnDurationFormatted: '17秒',
        currentTurnDurationCompactZh: '本轮 17s',
      },
      tokens: { totalTokens: 150 },
      context: { hasUsageData: true, usedRatio: 0.15 },
    });
    assert.equal(sr.querySelector('#val-model-dur').textContent, '17秒');
    inst.notifyModelOrStreamingChange(null, false, false, 0, null, 'idle');
    assert.equal(inst.turnClockTimer, null);
    assert.equal(sr.querySelector('#val-model-dur').textContent, '17秒', '冻结期间未收权威终态包前不得闪回旧 snapshot');
    assert.equal(sr.querySelector('#val-turn-dur').textContent, '17秒');
    inst.notifyModelOrStreamingChange(null, true, false, 0, null, 'executing');
    assert.equal(sr.querySelector('#val-model-dur').textContent, '17秒', '恢复活跃应从冻结高水位无缝续走');
    assert.ok(inst.turnClockTimer !== null);

    // 4. applyPopoverGeometry 在位置与尺寸稳定时 (!force) 应幂等跳过同步 reflow，避免卡片每 250ms 抖动
    let rectCalls = 0;
    const prevWin = globalThis.window;
    globalThis.window = { innerHeight: 900 };
    try {
      const pop = new FakeElement('div');
      const arrow = new FakeElement('div');
      pop.getBoundingClientRect = () => {
        rectCalls += 1;
        return { left: 100, top: 200, bottom: 380, width: 296, height: 180 };
      };
      const pos = {
        width: 296,
        maxHeight: 480,
        left: 100,
        bottom: 520,
        top: 200,
        direction: 'up',
        arrowPixelOffset: 80,
      };
      applyPopoverGeometry(pop, arrow, pos, { force: true });
      assert.equal(rectCalls, 1);
      // 胶囊中心微移 1px 导致 left 变化 1px（在 3px 滞后容差内），!force 必须跳过 DOM 写回与 reflow
      applyPopoverGeometry(pop, arrow, { ...pos, left: 101, arrowPixelOffset: 81 }, { force: false });
      assert.equal(rectCalls, 1, '位置微变 <=3px 时应跳过同步 reflow');
      resetPopoverGeometryCache(pop);
      applyPopoverGeometry(pop, arrow, pos, { force: false });
      assert.equal(rectCalls, 2, 'resetPopoverGeometryCache 后应重新校准');
    } finally {
      globalThis.window = prevWin;
      inst.dispose();
    }
  });

  it('441~510px 窄栏启用 .is-mid-compact 并通过 flex 布局保住缓存命中率百分比', () => {
    const inst = new HudInstance('pane-mid-compact', { isPrimaryPane: true });
    const composer = new FakeElement('div');
    composer.setAttribute('data-testid', 'agent-input-box');
    composer._rect = { left: 100, top: 700, width: 480, height: 24, right: 580, bottom: 724 };
    try {
      inst.mount(composer);
      const root = inst.shadow.querySelector('.hud-container');
      assert.equal(root.classList.contains('is-mid-compact'), true);
      assert.equal(root.classList.contains('is-compact'), false);
      assert.equal(root.classList.contains('is-ultra-compact'), false);

      inst.handleContainerResize(400);
      assert.equal(root.classList.contains('is-compact'), true);
      assert.equal(root.classList.contains('is-mid-compact'), false);

      inst.handleContainerResize(560);
      assert.equal(root.classList.contains('is-compact'), false);
      assert.equal(root.classList.contains('is-mid-compact'), false);
      assert.equal(root.classList.contains('is-ultra-compact'), false);

      assert.match(HUD_STYLES_CSS, /#hud-txt-tokens\s*\{[^}]*inline-flex/);
      assert.match(HUD_STYLES_CSS, /\.hud-cache-val\s*\{[^}]*flex-shrink:\s*0/);
      assert.match(HUD_STYLES_CSS, /max-width:\s*510px/);
      assert.match(HUD_STYLES_CSS, /\.is-mid-compact\s+\.hud-cache-label/);
    } finally {
      inst.dispose();
    }
  });

  it('loading 与 unavailable 状态按三胶囊分缀双语 aria-label，且中文不出现“会话”旧称', () => {
    for (const [lang, expectedPrefix, expectedLoading] of [
      ['zh', '对话统计明细：', '对话统计明细：读取中…'],
      ['en', 'Session Stats: ', 'Session Stats: Loading…'],
    ]) {
      const inst = new HudInstance(`aria-${lang}`, { languageMode: lang });
      const composer = new FakeElement('div');
      composer.setAttribute('data-testid', 'agent-input-box');
      try {
        inst.mount(composer);
        inst.applyMetricsToDom({ availability: 'loading', conversationId: `conv-${lang}` });
        const capSessLoading = inst.shadow.querySelector('.capsule[data-capsule-id="session"]').getAttribute('aria-label');
        const capTokLoading = inst.shadow.querySelector('.capsule[data-capsule-id="tokens"]').getAttribute('aria-label');
        const capCtxLoading = inst.shadow.querySelector('.capsule[data-capsule-id="context"]').getAttribute('aria-label');
        assert.equal(capSessLoading, expectedLoading);
        assert.ok(capTokLoading.includes(lang === 'zh' ? '读取中…' : 'Loading…'));
        assert.ok(capCtxLoading.includes(lang === 'zh' ? '读取中…' : 'Loading…'));

        inst.applyMetricsToDom({ availability: 'unavailable', conversationId: `conv-${lang}` });
        const capSessUnavail = inst.shadow.querySelector('.capsule[data-capsule-id="session"]').getAttribute('aria-label');
        const capTokUnavail = inst.shadow.querySelector('.capsule[data-capsule-id="tokens"]').getAttribute('aria-label');
        const capCtxUnavail = inst.shadow.querySelector('.capsule[data-capsule-id="context"]').getAttribute('aria-label');
        assert.ok(capSessUnavail.startsWith(expectedPrefix), `got ${capSessUnavail}`);
        assert.ok(capTokUnavail.includes(lang === 'zh' ? '数据暂不可用' : 'Data unavailable'));
        assert.ok(capCtxUnavail.includes(lang === 'zh' ? '数据暂不可用' : 'Data unavailable'));
        if (lang === 'zh') {
          assert.equal(capSessLoading.includes('会话'), false);
          assert.equal(capSessUnavail.includes('会话'), false);
        }
      } finally {
        inst.dispose();
      }
    }
  });

  it('reconcile 在宿主位置与尺寸未变化时跳过 syncVerticalCentering', () => {
    const inst = new HudInstance('pane-reconcile-cache', { isPrimaryPane: true });
    const container = new FakeElement('div');
    const composer = new FakeElement('div');
    composer.setAttribute('data-testid', 'agent-input-box');
    composer._rect = { left: 100, top: 700, width: 520, height: 24, right: 620, bottom: 724 };
    container.appendChild(composer);
    const prevWin = globalThis.window;
    globalThis.window = { innerHeight: 900 };
    try {
      inst.mount(composer);
      let syncCalls = 0;
      const origSync = inst.syncVerticalCentering.bind(inst);
      inst.syncVerticalCentering = () => {
        syncCalls += 1;
        return origSync();
      };
      inst.reconcile(composer);
      inst.reconcile(composer);
      assert.equal(syncCalls, 0);

      composer._rect = { ...composer._rect, width: 600 };
      inst.reconcile(composer);
      assert.equal(syncCalls, 1);
    } finally {
      globalThis.window = prevWin;
      inst.dispose();
    }
  });

  it('tickTurnClock 在页面隐藏时跳过刷新，在真实宿主断连后自动止表', () => {
    const inst = new HudInstance('pane-clock-lifecycle', { isPrimaryPane: true });
    const container = new FakeElement('div');
    const composer = new FakeElement('div');
    composer.setAttribute('data-testid', 'agent-input-box');
    container.appendChild(composer);
    const prevDoc = globalThis.document;
    const prevNow = Date.now;
    let fakeNow = 1_700_000_000_000;
    Date.now = () => fakeNow;
    try {
      inst.mount(composer);
      assert.equal(inst.hostMountedInDom, true);
      inst.switchConversation('conv-clock-life', 'gemini-3.8-flash', true, false, 0, null, 'generating');
      inst.updateMetrics({
        conversationId: 'conv-clock-life',
        sessionRevision: inst.getSessionRevision(),
        metricsSequence: 1,
        isStreaming: true,
        activityPhase: 'generating',
        session: {
          turns: 1,
          steps: 1,
          modelDurationSeconds: 5,
          modelDurationFormatted: '5秒',
          inFlightModelDurationSeconds: 1,
          activeModelStepCount: 1,
          currentTurnDurationSeconds: 5,
          currentTurnDurationFormatted: '5秒',
          currentTurnDurationCompactZh: '本轮 5s',
        },
        tokens: { totalTokens: 10 },
        context: { hasUsageData: true, usedRatio: 0.1 },
      });
      const before = inst.shadow.querySelector('#val-turn-dur').textContent;
      assert.ok(inst.turnClockTimer !== null);

      globalThis.document = { hidden: true, visibilityState: 'hidden' };
      fakeNow += 10_000;
      inst.tickTurnClock();
      assert.equal(inst.shadow.querySelector('#val-turn-dur').textContent, before);
      assert.ok(inst.turnClockTimer !== null);

      globalThis.document = { hidden: false, visibilityState: 'visible' };
      inst.host.setAttribute('hidden', '');
      fakeNow += 10_000;
      inst.tickTurnClock();
      assert.equal(inst.shadow.querySelector('#val-turn-dur').textContent, before);

      inst.host.remove();
      assert.equal(inst.host.isConnected, false);
      inst.tickTurnClock();
      assert.equal(inst.turnClockTimer, null);
    } finally {
      Date.now = prevNow;
      globalThis.document = prevDoc;
      inst.dispose();
    }
  });

  it('长审批空档与仅后台子智能体运行时不触发子时钟乐观虚增，且 turns 0->1 短延时落盘不回退', () => {
    const inst = new HudInstance('pane-optimistic-guard', { isPrimaryPane: true });
    const container = new FakeElement('div');
    const composer = new FakeElement('div');
    composer.setAttribute('data-testid', 'agent-input-box');
    container.appendChild(composer);
    const prevNow = Date.now;
    let fakeNow = 1_700_000_100_000;
    Date.now = () => fakeNow;
    try {
      inst.mount(composer);
      // 1. 首轮刚启动 (<2s) 且模型/工具均为 0：允许 generating 乐观走表到 1.6s，随后 turns 0->1 且 backendSec=0.8s 不回退
      inst.switchConversation('conv-opt-guard', 'gemini-3.8-flash', true, false, 0, null, 'generating');
      inst.updateMetrics({
        conversationId: 'conv-opt-guard',
        sessionRevision: inst.getSessionRevision(),
        metricsSequence: 1,
        isStreaming: true,
        activityPhase: 'generating',
        session: {
          turns: 0,
          steps: 0,
          modelDurationSeconds: 0,
          toolDurationSeconds: 0,
          currentTurnDurationSeconds: 0.4,
          currentTurnDurationFormatted: '0秒',
          currentTurnDurationCompactZh: '本轮 0s',
        },
        tokens: { totalTokens: 0 },
        context: { hasUsageData: false, usedRatio: 0 },
      });
      assert.equal(inst.modelClockAnchor.rate, 1, '首轮未落盘 (<2s) 应启用乐观模型走表');
      fakeNow += 1200; // live turn clock ~1.6s
      inst.tickTurnClock();
      assert.equal(inst.shadow.querySelector('#hud-txt-session .hud-turn-dur').textContent, '· 本轮 2s');

      // SQLite 延迟落盘 USER_INPUT (turns: 0 -> 1)，backendSec=0.8s (<2s 且 <liveSec)：不应把 2s 重置回 1s
      inst.updateMetrics({
        conversationId: 'conv-opt-guard',
        sessionRevision: inst.getSessionRevision(),
        metricsSequence: 2,
        isStreaming: true,
        activityPhase: 'generating',
        session: {
          turns: 1,
          steps: 1,
          modelDurationSeconds: 1.2,
          inFlightModelDurationSeconds: 0,
          activeModelStepCount: 0,
          toolDurationSeconds: 0,
          inFlightToolDurationSeconds: 0,
          activeToolStepCount: 0,
          currentTurnDurationSeconds: 0.8,
          currentTurnDurationFormatted: '1秒',
          currentTurnDurationCompactZh: '本轮 1s',
        },
        tokens: { totalTokens: 20 },
        context: { hasUsageData: true, usedRatio: 0.05 },
      });
      assert.equal(inst.shadow.querySelector('#hud-txt-session .hud-turn-dur').textContent, '· 本轮 2s');
      assert.equal(inst.modelClockAnchor.rate, 0, '已有落盘耗时后处于审批/步间空档时子时钟 rate 必须归 0');
      assert.equal(inst.toolClockAnchor.rate, 0);

      // 模拟长达 30 秒的工具权限审批等待：本轮总挂钟继续走，但模型/工具子时钟绝不虚增
      const modelBeforeWait = inst.shadow.querySelector('#val-model-dur').textContent;
      const toolBeforeWait = inst.shadow.querySelector('#val-tool-dur').textContent;
      fakeNow += 30_000;
      inst.tickTurnClock();
      assert.equal(inst.shadow.querySelector('#val-model-dur').textContent, modelBeforeWait);
      assert.equal(inst.shadow.querySelector('#val-tool-dur').textContent, toolBeforeWait);
    } finally {
      Date.now = prevNow;
      inst.dispose();
    }
  });

  it('常驻上下文胶囊留白修正、Orchestrator 双模型区分渲染、XSS 转义与按钮回退识别', () => {
    // 1. 验证 .capsule-context 已移除硬编码过宽留白并统一采用 padding: 0 7px
    const ctxRuleMatch = HUD_STYLES_CSS.match(/\.capsule-context\s*\{[^}]*\}/);
    assert.ok(ctxRuleMatch, '应存在 .capsule-context 样式规则');
    assert.equal(ctxRuleMatch[0].includes('min-width: 124px'), false, '不应硬编码 min-width: 124px 撑宽留白');
    assert.equal(ctxRuleMatch[0].includes('padding-inline: 11px'), false, '不应硬编码 padding-inline: 11px');
    assert.equal(ctxRuleMatch[0].includes('padding: 0 7px'), true, '应与其余胶囊统一使用 padding: 0 7px');

    const renderWithLang = (m, lang = 'zh') => {
      const inst = new HudInstance('ctx-dual', { languageMode: lang });
      inst.shadow = new FakeShadowRoot('open', null);
      inst.shadow.innerHTML = inst.buildHudHtml();
      inst.applyMetricsToDom(m);
      return inst;
    };

    // 2. 单模型会话应隐藏模型短标与阶段对照区，保留 #row-ctx-model
    const singleInst = renderWithLang({
      availability: 'ready',
      session: { turns: 1, steps: 2, compactionCount: 0 },
      tokens: { totalTokens: 1000, cacheHitRate: 0.5 },
      context: {
        hasUsageData: true,
        modelId: 'gemini-3.8-flash',
        modelDisplayName: 'Gemini 3.8 Flash',
        modelShortLabel: 'Flash',
        modelCompactLabel: 'F',
        isMultiModel: false,
        usedTokens: 50000,
        peakContextTokens: 50000,
        capacityTokens: 200000,
        isFallbackCapacity: true,
        usedRatio: 0.25,
        usedRatioFormatted: '25%',
        breakdown: { cachedContextTokens: 40000, uncachedContextTokens: 10000, latestOutputTokens: 200 },
      },
    });
    assert.equal(singleInst.shadow.querySelector('#hud-ctx-model-tag').hasAttribute('hidden'), true);
    assert.equal(singleInst.shadow.querySelector('.capsule-context').classList.contains('has-model-tag'), false);
    assert.equal(singleInst.shadow.querySelector('#hud-ctx-stages-wrap').hasAttribute('hidden'), true);
    assert.equal(singleInst.shadow.querySelector('#row-ctx-model').hasAttribute('hidden'), false);
    assert.equal(singleInst.shadow.querySelector('#val-ctx-model').textContent, 'Gemini 3.8 Flash');

    // 3. Orchestrator 双模型中英文渲染
    const dualMetrics = {
      availability: 'ready',
      session: { turns: 4, steps: 20, compactionCount: 0 },
      tokens: { totalTokens: 1000000, cacheHitRate: 0.9 },
      context: {
        hasUsageData: true,
        modelId: 'gemini-4-hydrogen',
        modelDisplayName: 'Gemini 4 Hydrogen (Orchestrator)',
        modelShortLabel: 'Hydrogen',
        modelCompactLabel: 'H',
        isMultiModel: true,
        isOrchestrator: true,
        usedTokens: 468000,
        peakContextTokens: 468000,
        capacityTokens: 512000,
        isFallbackCapacity: false,
        usedRatio: 468000 / 512000,
        usedRatioFormatted: '91.4%',
        breakdown: { cachedContextTokens: 465000, cachedContextRatio: 90.8, uncachedContextTokens: 3000, uncachedContextRatio: 0.6, latestOutputTokens: 3730 },
        modelStages: [
          {
            slotKey: 'orchestrator:carbon',
            role: 'planner',
            modelId: 'gemini-4-carbon',
            modelDisplayName: 'Orchestrator (Carbon)',
            shortLabel: 'Carbon',
            compactLabel: 'C',
            hasUsageData: true,
            isActive: false,
            usedTokens: 462000,
            peakContextTokens: 462000,
            capacityTokens: 512000,
            isFallbackCapacity: false,
            usedRatio: 462000 / 512000,
            usedRatioFormatted: '90.2%',
          },
          {
            slotKey: 'orchestrator:hydrogen',
            role: 'executor',
            modelId: 'gemini-4-hydrogen',
            modelDisplayName: 'Gemini 4 Hydrogen (Orchestrator)',
            shortLabel: 'Hydrogen',
            compactLabel: 'H',
            hasUsageData: true,
            isActive: true,
            usedTokens: 468000,
            peakContextTokens: 468000,
            capacityTokens: 512000,
            isFallbackCapacity: false,
            usedRatio: 468000 / 512000,
            usedRatioFormatted: '91.4%',
          },
        ],
      },
    };

    for (const lang of ['zh', 'en']) {
      const inst = renderWithLang(dualMetrics, lang);
      assert.equal(inst.shadow.querySelector('#hud-ctx-model-tag').hasAttribute('hidden'), false);
      assert.equal(inst.shadow.querySelector('.capsule-context').classList.contains('has-model-tag'), true);
      assert.equal(inst.shadow.querySelector('#hud-ctx-model-full').textContent, 'Hydrogen');
      assert.equal(inst.shadow.querySelector('#hud-ctx-model-short').textContent, 'H');
      assert.equal(inst.shadow.querySelector('#hud-txt-context').textContent, '91%');
      assert.equal(
        inst.shadow.querySelector('#pop-ctx-prefix').textContent,
        lang === 'en' ? 'Current Context · Hydrogen ' : '当前上下文 · Hydrogen '
      );
      const popRole = inst.shadow.querySelector('#pop-ctx-role');
      assert.equal(popRole.hasAttribute('hidden'), false);
      assert.equal(popRole.classList.contains('is-role-executor'), true);
      assert.equal(popRole.textContent, lang === 'en' ? 'Exec' : '执行');
      assert.equal(
        inst.shadow.querySelector('#lbl-ctx-peak').textContent,
        lang === 'en' ? 'Model Peak Context' : '当前模型峰值'
      );
      assert.equal(inst.shadow.querySelector('#row-ctx-model').hasAttribute('hidden'), true);
      assert.equal(inst.shadow.querySelector('#hud-ctx-stages-wrap').hasAttribute('hidden'), false);
      assert.equal(
        inst.shadow.querySelector('#lbl-ctx-stages').textContent,
        lang === 'en' ? 'Prior Model Context' : '曾用模型上下文'
      );
      const listHtml = inst.shadow.querySelector('#hud-ctx-stages-list').innerHTML;
      assert.equal(listHtml.includes('<span class="hud-stage-label">Carbon</span>'), true);
      assert.equal(listHtml.includes(lang === 'en' ? 'class="hud-role-badge is-role-planner">Plan<' : 'class="hud-role-badge is-role-planner">规划<'), true);
      assert.equal(listHtml.includes('90.2% · 462K / 512K'), true);
      assert.equal(listHtml.includes('<span class="hud-stage-label">Hydrogen</span>'), false, 'Option A 底部列表不得重复渲染当前活跃模型');
      assert.equal(listHtml.includes('class="hud-stage-badge"'), false, 'Option A 底部列表不应出现当前活跃徽章');
      assert.equal(listHtml.includes('class="hud-stage-label"'), true);
    }

    // 3b. 验证通用待介入执行阶段（不写死 Hydrogen）、统一单标题平铺列表（无二次 history 标题）与角色前缀保留（保留 .hud-stage-label 防徽章裁切）
    assert.match(HUD_STYLES_CSS, /\.hud-stage-label\s*\{[^}]*text-overflow:\s*ellipsis/);
    assert.match(HUD_STYLES_CSS, /\.hud-stage-badge\s*\{[^}]*flex:\s*0\s+0\s+auto/);

    const historyMetrics = {
      availability: 'ready',
      session: { turns: 5, steps: 22, compactionCount: 0 },
      tokens: { totalTokens: 1200000, cacheHitRate: 0.88 },
      context: {
        hasUsageData: true,
        modelId: 'gemini-4-carbon',
        modelDisplayName: 'Orchestrator (Carbon)',
        modelShortLabel: 'Carbon',
        modelCompactLabel: 'C',
        isMultiModel: true,
        isOrchestrator: true,
        usedTokens: 256000,
        peakContextTokens: 256000,
        capacityTokens: 512000,
        isFallbackCapacity: false,
        usedRatio: 0.5,
        usedRatioFormatted: '50%',
        breakdown: { cachedContextTokens: 250000, uncachedContextTokens: 6000, latestOutputTokens: 1200 },
        modelStages: [
          {
            slotKey: 'orchestrator:carbon',
            role: 'planner',
            section: 'primary',
            modelId: 'gemini-4-carbon',
            modelDisplayName: 'Orchestrator (Carbon)',
            shortLabel: 'Carbon',
            compactLabel: 'C',
            hasUsageData: true,
            isActive: true,
            usedTokens: 256000,
            peakContextTokens: 256000,
            capacityTokens: 512000,
            isFallbackCapacity: false,
            usedRatio: 0.5,
            usedRatioFormatted: '50%',
          },
          {
            slotKey: 'orchestrator:executor_pending',
            role: 'executor',
            section: 'primary',
            modelId: 'pending',
            modelDisplayName: '',
            shortLabel: '',
            compactLabel: '',
            hasUsageData: false,
            isActive: false,
            usedTokens: 0,
            peakContextTokens: 0,
            capacityTokens: 512000,
            isFallbackCapacity: false,
            usedRatio: 0,
            usedRatioFormatted: '0%',
          },
          {
            slotKey: 'model:gemini-4-hydrogen',
            role: 'model',
            section: 'history',
            modelId: 'gemini-4-hydrogen',
            modelDisplayName: 'Gemini 4 Hydrogen (High)',
            shortLabel: 'Hydrogen',
            compactLabel: 'H',
            hasUsageData: true,
            isActive: false,
            usedTokens: 320000,
            peakContextTokens: 320000,
            capacityTokens: 512000,
            isFallbackCapacity: false,
            usedRatio: 320000 / 512000,
            usedRatioFormatted: '62.5%',
          },
          {
            slotKey: 'model:gemini-3.8-flash',
            role: 'model',
            section: 'history',
            modelId: 'gemini-3.8-flash',
            modelDisplayName: 'Gemini 3.8 Flash (High)',
            shortLabel: 'Flash',
            compactLabel: 'F',
            hasUsageData: true,
            isActive: false,
            usedTokens: 100000,
            peakContextTokens: 100000,
            capacityTokens: 1000000,
            isFallbackCapacity: true,
            usedRatio: 0.1,
            usedRatioFormatted: '10%',
          },
          {
            slotKey: 'model:claude-sonnet-4-6',
            role: 'model',
            section: 'history',
            modelId: 'claude-sonnet-4-6',
            modelDisplayName: 'Claude Sonnet 4.6',
            shortLabel: 'Sonnet',
            compactLabel: 'S',
            hasUsageData: true,
            isActive: false,
            usedTokens: 50000,
            peakContextTokens: 50000,
            capacityTokens: 200000,
            isFallbackCapacity: true,
            usedRatio: 0.25,
            usedRatioFormatted: '25%',
          },
        ],
      },
    };

    for (const lang of ['zh', 'en']) {
      const inst = renderWithLang(historyMetrics, lang);
      assert.equal(
        inst.shadow.querySelector('#pop-ctx-prefix').textContent,
        lang === 'en' ? 'Current Context · Carbon ' : '当前上下文 · Carbon '
      );
      const popRole = inst.shadow.querySelector('#pop-ctx-role');
      assert.equal(popRole.hasAttribute('hidden'), false);
      assert.equal(popRole.classList.contains('is-role-planner'), true);
      assert.equal(popRole.textContent, lang === 'en' ? 'Plan' : '规划');
      assert.equal(
        inst.shadow.querySelector('#lbl-ctx-stages').textContent,
        lang === 'en' ? 'Prior Model Context' : '曾用模型上下文'
      );
      const listHtml = inst.shadow.querySelector('#hud-ctx-stages-list').innerHTML;
      assert.equal(listHtml.includes(lang === 'en' ? 'Exec Stage' : '执行阶段'), true);
      assert.equal(listHtml.includes(lang === 'en' ? 'Pending' : '待介入'), true);
      assert.equal(listHtml.includes('hud-ctx-history-title'), false, '统一列表不应再渲染二次 history 标题');
      assert.equal(listHtml.includes('<span class="hud-stage-label">Carbon</span>'), false, 'Option A 底部列表不得重复渲染当前活跃规划模型');
      assert.equal(listHtml.includes('<span class="hud-stage-label">Hydrogen (High)</span>'), true);
      assert.equal(listHtml.includes('<span class="hud-stage-label">3.8 Flash (High)</span>'), true);
      assert.equal(listHtml.includes('<span class="hud-stage-label">Sonnet 4.6</span>'), true);

      // 同步覆盖真实 DOM 节点路径 (useDomNodes=true)
      const domDoc = { createElement: (tag) => new FakeElement(tag) };
      const domList = new FakeElement('div', domDoc);
      domList.replaceChildren = (...items) => {
        domList.children = items;
      };
      inst.renderModelStagesList(domList, historyMetrics.context.modelStages, false);
      const historyNodes = domList.children.filter((n) => n.className === 'hud-ctx-history-title');
      assert.equal(historyNodes.length, 0);
      const stageNodes = domList.children.filter((n) => n.classList.contains('hud-stage-item'));
      assert.equal(stageNodes.length, 5);
      const firstLabel = stageNodes[0].children[0].children[0].children[1];
      assert.equal(firstLabel.className, 'hud-stage-label');
    }

    // 3c. 验证全 pending 非活跃列表使用“待切换模型 / Pending Model”，以及无模型短名时的顶部前缀兜底
    const pendingOnlyMetrics = {
      availability: 'ready',
      session: { turns: 1, steps: 2, compactionCount: 0 },
      tokens: { totalTokens: 10000, cacheHitRate: 0.5 },
      context: {
        hasUsageData: true,
        modelId: 'gemini-4-carbon',
        modelDisplayName: 'Orchestrator (Carbon)',
        modelShortLabel: 'Carbon',
        modelCompactLabel: 'C',
        isMultiModel: true,
        isOrchestrator: true,
        usedTokens: 5000,
        peakContextTokens: 5000,
        capacityTokens: 512000,
        usedRatio: 5000 / 512000,
        usedRatioFormatted: '0.98%',
        breakdown: { cachedContextTokens: 2000, uncachedContextTokens: 3000, latestOutputTokens: 200 },
        modelStages: [
          {
            slotKey: 'orchestrator:carbon',
            role: 'planner',
            section: 'primary',
            modelId: 'gemini-4-carbon',
            modelDisplayName: 'Orchestrator (Carbon)',
            shortLabel: 'Carbon',
            compactLabel: 'C',
            hasUsageData: true,
            isActive: true,
            usedTokens: 5000,
            peakContextTokens: 5000,
            capacityTokens: 512000,
            usedRatio: 5000 / 512000,
            usedRatioFormatted: '0.98%',
          },
          {
            slotKey: 'orchestrator:executor_pending',
            role: 'executor',
            section: 'primary',
            modelId: 'pending',
            modelDisplayName: '',
            shortLabel: '',
            compactLabel: '',
            hasUsageData: false,
            isActive: false,
            usedTokens: 0,
            peakContextTokens: 0,
            capacityTokens: 512000,
            usedRatio: 0,
            usedRatioFormatted: '0%',
          },
        ],
      },
    };
    for (const lang of ['zh', 'en']) {
      const pendingInst = renderWithLang(pendingOnlyMetrics, lang);
      assert.equal(
        pendingInst.shadow.querySelector('#pop-ctx-prefix').textContent,
        lang === 'en' ? 'Current Context · Carbon ' : '当前上下文 · Carbon '
      );
      const pendingRole = pendingInst.shadow.querySelector('#pop-ctx-role');
      assert.equal(pendingRole.hasAttribute('hidden'), false);
      assert.equal(pendingRole.textContent, lang === 'en' ? 'Plan' : '规划');
      assert.equal(
        pendingInst.shadow.querySelector('#lbl-ctx-stages').textContent,
        lang === 'en' ? 'Pending Model' : '待切换模型'
      );
      const bareInst = renderWithLang({
        ...pendingOnlyMetrics,
        context: {
          ...pendingOnlyMetrics.context,
          modelId: 'pending',
          modelDisplayName: '',
          modelShortLabel: '',
          modelCompactLabel: '',
        },
      }, lang);
      assert.equal(
        bareInst.shadow.querySelector('#pop-ctx-prefix').textContent,
        lang === 'en' ? 'Current Context ' : '当前上下文 '
      );
      assert.equal(bareInst.shadow.querySelector('#pop-ctx-role').hasAttribute('hidden'), true);
    }

    // 4. 验证渲染阶段的模型名 XSS 防护转义
    const xssInst = renderWithLang({
      availability: 'ready',
      session: { turns: 1, steps: 1, compactionCount: 0 },
      tokens: { totalTokens: 100, cacheHitRate: 0 },
      context: {
        hasUsageData: true,
        modelId: 'custom',
        modelDisplayName: '<img src=x onerror=alert(1)>',
        modelShortLabel: '<script>',
        modelCompactLabel: 'X',
        isMultiModel: true,
        usedTokens: 1000,
        peakContextTokens: 1000,
        capacityTokens: 200000,
        isFallbackCapacity: true,
        usedRatio: 0.005,
        usedRatioFormatted: '0.5%',
        breakdown: { cachedContextTokens: 0, uncachedContextTokens: 1000, latestOutputTokens: 10 },
        modelStages: [
          {
            slotKey: 'model:opus-history',
            role: 'model',
            modelId: 'opus',
            modelDisplayName: 'Claude Opus 4.6',
            shortLabel: 'Opus',
            compactLabel: 'O',
            hasUsageData: true,
            isActive: false,
            usedTokens: 500,
            peakContextTokens: 500,
            capacityTokens: 200000,
            isFallbackCapacity: true,
            usedRatio: 0.0025,
            usedRatioFormatted: '0.25%',
          },
          {
            slotKey: 'model:xss',
            role: 'model',
            modelId: 'xss',
            modelDisplayName: '<img src=x onerror=alert(1)>',
            shortLabel: '<script>',
            compactLabel: 'X',
            hasUsageData: true,
            isActive: false,
            usedTokens: 1000,
            peakContextTokens: 1000,
            capacityTokens: 200000,
            isFallbackCapacity: true,
            usedRatio: 0.005,
            usedRatioFormatted: '0.5%',
          },
          {
            slotKey: 'model:active',
            role: 'model',
            modelId: 'active',
            modelDisplayName: 'Gemini 4 Hydrogen (High)',
            shortLabel: 'Hydrogen',
            compactLabel: 'H',
            hasUsageData: true,
            isActive: true,
            usedTokens: 2000,
            peakContextTokens: 2000,
            capacityTokens: 200000,
            isFallbackCapacity: false,
            usedRatio: 0.01,
            usedRatioFormatted: '1%',
          },
        ],
      },
    });
    const xssHtml = xssInst.shadow.querySelector('#hud-ctx-stages-list').innerHTML;
    assert.equal(xssHtml.includes('<img'), false, '不得出现未转义的 <img> 标签');
    assert.equal(xssHtml.includes('&lt;img src=x onerror=alert(1)&gt;'), true);

    // 5. 验证 AntigravityHudManager.resolveActiveModel 按钮回退识别 Orchestrator
    const mgr = new AntigravityHudManager();
    const fakeComposer = new FakeElement('div');
    fakeComposer.className = 'surface-composer';
    const fakeBtn = new FakeElement('button');
    fakeBtn.textContent = '+ Orchestrator (Carbon)';
    fakeComposer.appendChild(fakeBtn);
    const fakeView = new FakeElement('div');
    fakeView.appendChild(fakeComposer);
    assert.equal(mgr.resolveActiveModel(fakeView, 1), '+ Orchestrator (Carbon)');
  });

  it('左侧聊天分栏缩窄且右侧窗口覆盖时，HUD 宿主按可见分栏边界自动夹紧宽度并切换紧凑档位', () => {
    const prevWin = globalThis.window;
    globalThis.window = { innerWidth: 1200, innerHeight: 800, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) };
    const doc = new FakeElement('document');
    doc.createElement = (tag) => new FakeElement(tag, doc);
    const splitRoot = new FakeElement('div', doc);
    splitRoot.setAttribute('data-split-root', 'true');
    splitRoot._rect = { left: 0, top: 0, width: 1200, height: 800, right: 1200, bottom: 800 };

    const leftSlot = new FakeElement('div', doc);
    leftSlot._rect = { left: 0, top: 0, width: 280, height: 800, right: 280, bottom: 800 };
    const rightPane = new FakeElement('div', doc);
    rightPane._rect = { left: 280, top: 0, width: 920, height: 800, right: 1200, bottom: 800 };

    const convView = new FakeElement('div', doc);
    convView.setAttribute('data-testid', 'conversation-view');
    convView._rect = { left: 0, top: 0, width: 460, height: 800, right: 460, bottom: 800 };
    const composer = new FakeElement('div', doc);
    composer.setAttribute('data-testid', 'agent-input-box');
    // 模拟输入框因缺少 min-width:0 向右溢出至 440px（超出左分栏 280px 边界，被右窗格覆盖）
    composer._rect = { left: 16, top: 700, width: 424, height: 24, right: 440, bottom: 724 };

    convView.appendChild(composer);
    leftSlot.appendChild(convView);
    splitRoot.appendChild(leftSlot);
    splitRoot.appendChild(rightPane);

    const inst = new HudInstance('pane-split-clamp', { isPrimaryPane: true });
    try {
      inst.mount(composer);
      assert.equal(inst.host.style.maxWidth, '264px', 'HUD 宿主宽度必须夹紧至右侧分栏左边界 (280 - 16 = 264px)');
      assert.equal(inst.host.style.alignSelf, 'flex-start');
      assert.equal(
        inst.shadow.querySelector('.hud-container').classList.contains('is-ultra-compact'),
        true,
        '可见分栏宽度 264px (<360px) 应自动进入 is-ultra-compact 紧凑态'
      );

      // 继续缩窄左分栏至 240px（可见宽 224px < 260px），应进入 is-micro-compact 极微态
      leftSlot._rect = { left: 0, top: 0, width: 240, height: 800, right: 240, bottom: 800 };
      rightPane._rect = { left: 240, top: 0, width: 960, height: 800, right: 1200, bottom: 800 };
      inst.reconcile(composer);
      assert.equal(inst.host.style.maxWidth, '224px');
      assert.equal(inst.shadow.querySelector('.hud-container').classList.contains('is-micro-compact'), true);
    } finally {
      globalThis.window = prevWin;
      inst.dispose();
    }
  });

  it('多模型阶段与本对话曾用模型渲染三档压缩胶囊，且当前模型峰值与历史模型压缩解耦', () => {
    assert.match(HUD_STYLES_CSS, /\.hud-stage-compaction\s*\{[^}]*flex:\s*0\s+0\s+auto/);
    assert.match(HUD_STYLES_CSS, /\.hud-stage-compaction\.is-compaction-low\s*\{/);
    assert.match(HUD_STYLES_CSS, /\.hud-stage-compaction\.is-compaction-warn\s*\{/);
    assert.match(HUD_STYLES_CSS, /\.hud-stage-compaction\.is-compaction-danger\s*\{/);

    const buildMultiCompMetrics = (activeCompCount) => ({
      availability: 'ready',
      session: { turns: 8, steps: 42, compactionCount: 6 + activeCompCount },
      tokens: { totalTokens: 2400000, cacheHitRate: 0.91 },
      context: {
        hasUsageData: true,
        modelId: 'gemini-4-carbon',
        modelDisplayName: 'Orchestrator (Carbon)',
        modelShortLabel: 'Carbon',
        modelCompactLabel: 'C',
        isMultiModel: true,
        isOrchestrator: true,
        activeModelCompactionCount: activeCompCount,
        usedTokens: 256000,
        usedTokensFormatted: '256,000',
        peakContextTokens: 256000,
        peakContextFormatted: '256,000',
        capacityTokens: 512000,
        isFallbackCapacity: false,
        usedRatio: 0.5,
        usedRatioFormatted: '50%',
        breakdown: { cachedContextTokens: 240000, uncachedContextTokens: 16000, latestOutputTokens: 1200 },
        modelStages: [
          {
            slotKey: 'orchestrator:carbon',
            role: 'planner',
            section: 'primary',
            modelId: 'gemini-4-carbon',
            modelDisplayName: 'Orchestrator (Carbon)',
            shortLabel: 'Carbon',
            compactLabel: 'C',
            hasUsageData: true,
            isActive: true,
            ...(activeCompCount > 0 ? { compactionCount: activeCompCount } : {}),
            usedTokens: 256000,
            peakContextTokens: 256000,
            capacityTokens: 512000,
            isFallbackCapacity: false,
            usedRatio: 0.5,
            usedRatioFormatted: '50%',
          },
          {
            slotKey: 'orchestrator:hydrogen',
            role: 'executor',
            section: 'primary',
            modelId: 'gemini-4-hydrogen',
            modelDisplayName: 'Gemini 4 Hydrogen (Orchestrator)',
            shortLabel: 'Hydrogen',
            compactLabel: 'H',
            hasUsageData: true,
            isActive: false,
            compactionCount: 1,
            usedTokens: 410000,
            peakContextTokens: 490000,
            capacityTokens: 512000,
            isFallbackCapacity: false,
            usedRatio: 0.801,
            usedRatioFormatted: '80.1%',
          },
          {
            slotKey: 'model:claude-opus-4-6-thinking',
            role: 'model',
            section: 'history',
            modelId: 'claude-opus-4-6-thinking',
            modelDisplayName: 'Claude Opus 4.6 (Thinking)',
            shortLabel: 'Opus 4.6',
            compactLabel: 'O4.6',
            hasUsageData: true,
            isActive: false,
            compactionCount: 2,
            usedTokens: 185000,
            peakContextTokens: 196000,
            capacityTokens: 200000,
            isFallbackCapacity: false,
            usedRatio: 0.925,
            usedRatioFormatted: '92.5%',
          },
          {
            slotKey: 'model:gemini-3.1-pro-high',
            role: 'model',
            section: 'history',
            modelId: 'gemini-3.1-pro-high',
            modelDisplayName: 'Gemini 3.1 Pro (High)',
            shortLabel: '3.1 Pro',
            compactLabel: '3.1P',
            hasUsageData: true,
            isActive: false,
            compactionCount: 3,
            usedTokens: 620000,
            peakContextTokens: 980000,
            capacityTokens: 1000000,
            isFallbackCapacity: false,
            usedRatio: 0.62,
            usedRatioFormatted: '62%',
          },
        ],
      },
    });

    for (const lang of ['zh', 'en']) {
      // A. 当前活跃 Carbon/Neon 自身 0 次压缩：常驻胶囊必须隐藏徽标（不得误挂搭档/历史模型压缩数），会话总压缩数 6 展示于对话统计弹窗
      const instZeroActive = new HudInstance(`ctx-stage-comp-0-${lang}`, { languageMode: lang });
      instZeroActive.shadow = new FakeShadowRoot('open', null);
      instZeroActive.shadow.innerHTML = instZeroActive.buildHudHtml();
      const payload0 = buildMultiCompMetrics(0);
      instZeroActive.applyMetricsToDom(payload0);

      const sessionBadge = instZeroActive.shadow.querySelector('#hud-compaction-badge');
      assert.equal(sessionBadge.hasAttribute('hidden'), true, '当前展示模型未压缩时，常驻胶囊不得显示其他模型的压缩徽标');
      assert.equal(sessionBadge.textContent, '');
      assert.equal(instZeroActive.shadow.querySelector('.capsule-context').classList.contains('has-compaction'), false);
      assert.equal(
        instZeroActive.shadow.querySelector('.capsule-context').getAttribute('aria-label').includes(lang === 'en' ? 'Compacted' : '已压缩'),
        false
      );
      assert.equal(instZeroActive.shadow.querySelector('#row-session-compactions'), null);
      assert.equal(
        instZeroActive.shadow.querySelector('#hud-popover-session').getAttribute('data-exact-summary').includes('compactions=6'),
        true
      );
      assert.equal(
        instZeroActive.shadow.querySelector('#val-ctx-peak').textContent,
        '256K tok',
        '当前模型未发生压缩时，当前模型峰值行不得展示曾用模型的压缩后缀'
      );

      // HTML 字符串渲染路径验证：1/2/3 次三档数字圆圈徽章、aria-label 完整语义与零 title 属性
      const listHtml = instZeroActive.shadow.querySelector('#hud-ctx-stages-list').innerHTML;
      assert.equal(listHtml.includes('title='), false);
      assert.equal(
        listHtml.includes(
          lang === 'en'
            ? '<span class="hud-stage-compaction is-compaction-low" data-compaction-tier="low" aria-label="Compacted once">1</span>'
            : '<span class="hud-stage-compaction is-compaction-low" data-compaction-tier="low" aria-label="已压缩 1 次">1</span>'
        ),
        true
      );
      assert.equal(
        listHtml.includes(
          lang === 'en'
            ? '<span class="hud-stage-compaction is-compaction-warn" data-compaction-tier="warn" aria-label="Compacted 2 times">2</span>'
            : '<span class="hud-stage-compaction is-compaction-warn" data-compaction-tier="warn" aria-label="已压缩 2 次">2</span>'
        ),
        true
      );
      assert.equal(
        listHtml.includes(
          lang === 'en'
            ? '<span class="hud-stage-compaction is-compaction-danger" data-compaction-tier="danger" aria-label="Compacted 3 times">3</span>'
            : '<span class="hud-stage-compaction is-compaction-danger" data-compaction-tier="danger" aria-label="已压缩 3 次">3</span>'
        ),
        true
      );

      // DOM 节点路径 (useDomNodes=true) 验证：保持子节点索引契约且 .hud-stage-badge 仅用于活跃标识
      const findByClass = (root, cls) => {
        if (!root) return null;
        if (root.classList?.contains(cls)) return root;
        for (const ch of root.children || []) {
          const hit = findByClass(ch, cls);
          if (hit) return hit;
        }
        return null;
      };
      const domDoc = { createElement: (tag) => new FakeElement(tag) };
      const domList = new FakeElement('div', domDoc);
      domList.replaceChildren = (...items) => {
        domList.children = items;
      };
      instZeroActive.renderModelStagesList(domList, payload0.context.modelStages, false);
      const stageNodes = domList.children.filter((n) => n.classList.contains('hud-stage-item'));
      assert.equal(stageNodes.length, 4);
      // Carbon (0 次压缩)：仅有 dot + label + active badge
      assert.equal(stageNodes[0].getAttribute('data-stage-compactions'), null);
      assert.equal(stageNodes[0].children[0].children[0].children[1].className, 'hud-stage-label');
      assert.equal(findByClass(stageNodes[0], 'hud-stage-badge')?.textContent, lang === 'en' ? 'Active' : '当前');
      assert.equal(findByClass(stageNodes[0], 'hud-stage-compaction'), null);
      // Hydrogen (1 次 low)、Opus 历史模型 (2 次 warn)、3.1 Pro 历史模型 (3 次 danger)
      assert.equal(stageNodes[1].getAttribute('data-stage-compactions'), '1');
      assert.equal(findByClass(stageNodes[1], 'hud-stage-compaction')?.getAttribute('data-compaction-tier'), 'low');
      assert.equal(findByClass(stageNodes[1], 'hud-stage-compaction')?.textContent, '1');
      assert.equal(stageNodes[2].getAttribute('data-stage-compactions'), '2');
      assert.equal(findByClass(stageNodes[2], 'hud-stage-compaction')?.getAttribute('data-compaction-tier'), 'warn');
      assert.equal(findByClass(stageNodes[2], 'hud-stage-compaction')?.textContent, '2');
      assert.equal(stageNodes[3].getAttribute('data-stage-compactions'), '3');
      assert.equal(findByClass(stageNodes[3], 'hud-stage-compaction')?.getAttribute('data-compaction-tier'), 'danger');
      assert.equal(findByClass(stageNodes[3], 'hud-stage-compaction')?.textContent, '3');

      // B. 当前活跃模型自身发生 2 次压缩：常驻胶囊与 #val-ctx-peak 均仅反映当前模型的 2 次，而对话统计弹窗展示全会话总计 8 次
      const instActiveComp = new HudInstance(`ctx-stage-comp-2-${lang}`, { languageMode: lang });
      instActiveComp.shadow = new FakeShadowRoot('open', null);
      instActiveComp.shadow.innerHTML = instActiveComp.buildHudHtml();
      const payload2 = buildMultiCompMetrics(2);
      instActiveComp.applyMetricsToDom(payload2);
      assert.equal(instActiveComp.shadow.querySelector('#hud-compaction-badge').hasAttribute('hidden'), false);
      assert.equal(instActiveComp.shadow.querySelector('#hud-compaction-badge').getAttribute('data-compaction-tier'), 'warn');
      assert.equal(instActiveComp.shadow.querySelector('#hud-compaction-badge').textContent, '2');
      assert.equal(
        instActiveComp.shadow.querySelector('#val-ctx-peak').textContent,
        lang === 'en' ? '256K tok (2x compacted)' : '256K tok (已压缩 2 次)'
      );
      instActiveComp.renderModelStagesList(domList, payload2.context.modelStages, true);
      const activeStageNode = domList.children.filter((n) => n.classList.contains('hud-stage-item'))[0];
      assert.equal(findByClass(activeStageNode, 'hud-stage-badge')?.textContent, lang === 'en' ? 'Active' : '当前');
      assert.equal(findByClass(activeStageNode, 'hud-stage-compaction')?.textContent, '2');
      assert.equal(
        findByClass(activeStageNode, 'hud-stage-compaction')?.getAttribute('aria-label'),
        lang === 'en' ? 'Compacted 2 times' : '已压缩 2 次'
      );

      // C. 非 Orchestrator 3 模型切换场景：标题统一为“本对话曾用模型 / Models in Session”，自动剔除当前模型防重复，且保留曾经担任 planner/executor 的角色前缀
      const nonOrchInst = new HudInstance(`non-orch-dedup-${lang}`, { languageMode: lang });
      nonOrchInst.shadow = new FakeShadowRoot('open', null);
      nonOrchInst.shadow.innerHTML = nonOrchInst.buildHudHtml();
      nonOrchInst.applyMetricsToDom({
        availability: 'ready',
        session: { turns: 4, steps: 20, compactionCount: 2 },
        tokens: { totalTokens: 124_000_000, cacheHitRate: 0.93 },
        context: {
          hasUsageData: true,
          modelId: 'gemini-4-hydrogen',
          modelDisplayName: 'Gemini 4 Hydrogen (High)',
          modelShortLabel: 'Hydrogen',
          modelCompactLabel: 'H',
          isMultiModel: true,
          isOrchestrator: false,
          activeModelCompactionCount: 2,
          usedTokens: 53200,
          peakContextTokens: 510000,
          capacityTokens: 512000,
          usedRatio: 53200 / 512000,
          usedRatioFormatted: '10.4%',
          breakdown: { cachedContextTokens: 50200, uncachedContextTokens: 2990, latestOutputTokens: 1630 },
          modelStages: [
            {
              slotKey: 'model:claude-opus-5-5',
              role: 'model',
              section: 'primary',
              modelId: 'claude-opus-5-5',
              modelDisplayName: 'Claude Opus 5.5 (Medium)',
              shortLabel: 'Opus',
              compactLabel: 'O',
              hasUsageData: true,
              isActive: false,
              compactionCount: 1,
              usedTokens: 57900,
              peakContextTokens: 57900,
              capacityTokens: 840000,
              usedRatio: 57900 / 840000,
              usedRatioFormatted: '6.9%',
            },
            {
              slotKey: 'model:gemini-4-carbon',
              role: 'planner',
              section: 'primary',
              modelId: 'gemini-4-carbon',
              modelDisplayName: 'Gemini 4 Carbon (Medium)',
              shortLabel: 'Carbon',
              compactLabel: 'C',
              hasUsageData: true,
              isActive: false,
              usedTokens: 272000,
              peakContextTokens: 272000,
              capacityTokens: 512000,
              usedRatio: 272000 / 512000,
              usedRatioFormatted: '53.1%',
            },
            {
              slotKey: 'model:gemini-4-hydrogen',
              role: 'model',
              section: 'primary',
              modelId: 'gemini-4-hydrogen',
              modelDisplayName: 'Gemini 4 Hydrogen (High)',
              shortLabel: 'Hydrogen',
              compactLabel: 'H',
              hasUsageData: true,
              isActive: true,
              compactionCount: 2,
              usedTokens: 53200,
              peakContextTokens: 510000,
              capacityTokens: 512000,
              usedRatio: 53200 / 512000,
              usedRatioFormatted: '10.4%',
            },
          ],
        },
      });
      assert.equal(
        nonOrchInst.shadow.querySelector('#pop-ctx-prefix').textContent,
        lang === 'en' ? 'Current Context · Hydrogen ' : '当前上下文 · Hydrogen '
      );
      assert.equal(nonOrchInst.shadow.querySelector('#pop-ctx-role').hasAttribute('hidden'), true);
      assert.equal(
        nonOrchInst.shadow.querySelector('#lbl-ctx-stages').textContent,
        lang === 'en' ? 'Prior Model Context' : '曾用模型上下文'
      );
      const nonOrchListHtml = nonOrchInst.shadow.querySelector('#hud-ctx-stages-list').innerHTML;
      assert.equal(nonOrchListHtml.includes('Opus 5.5 (Medium)'), true);
      assert.equal(nonOrchListHtml.includes('<span class="hud-stage-label">Carbon</span>'), true);
      assert.equal(nonOrchListHtml.includes(lang === 'en' ? 'class="hud-role-badge is-role-planner">Plan<' : 'class="hud-role-badge is-role-planner">规划<'), true);
      assert.equal(nonOrchListHtml.includes('Hydrogen (High)'), false, '非 Orchestrator 下半区必须剔除当前已激活模型防重复');
      assert.equal(
        nonOrchListHtml.includes(
          lang === 'en' ? 'aria-label="Compacted once">1<' : 'aria-label="已压缩 1 次">1<'
        ),
        true
      );
      assert.equal(
        nonOrchInst.shadow.querySelector('#hud-popover-context').getAttribute('data-exact-summary').includes('modelCompactions=2'),
        true
      );

      nonOrchInst.applyMetricsToDom({
        availability: 'unavailable',
        conversationId: 'conv-gone',
        session: { turns: 0, steps: 0, compactionCount: 3 },
        tokens: {},
        context: { hasUsageData: false },
      });
      assert.equal(nonOrchInst.shadow.querySelector('#hud-compaction-badge').hasAttribute('hidden'), true);
      assert.equal(nonOrchInst.shadow.querySelector('.capsule-context').classList.contains('has-compaction'), false);
    }
  });

  it('OPT-01：独立子智能体轨迹分栏 (isSubagentTrajectory) 保留后端 isStreaming，普通分屏 (isSubpane) 不误亮', () => {
    const subInst = new HudInstance('pane-sub-traj', { isSubpane: true });
    const subHost = new FakeElement('div');
    const subShadow = subHost.attachShadow({ mode: 'open' });
    subHost.shadowRoot = subShadow;
    subInst.host = subHost;
    subInst.shadow = subShadow;
    subShadow.innerHTML = subInst.buildHudHtml();
    subInst.switchConversation('sub-traj-conv', 'gemini-3.8-flash', false);

    subInst.updateMetrics({
      conversationId: 'sub-traj-conv',
      sessionRevision: subInst.getSessionRevision(),
      updatedAt: Date.now(),
      isStreaming: true,
      activityPhase: 'generating',
      session: {
        isSubagentTrajectory: true,
        turns: 1,
        steps: 2,
        activeModelStepCount: 0,
        activeToolStepCount: 0,
        currentTurnDurationSeconds: 1,
      },
    });
    assert.equal(subInst.backendIsStreaming, true);
    assert.equal(subInst.isStreaming, true);
    assert.equal(subInst.activityPhase, 'generating');
    assert.ok(subInst.turnClockTimer !== null, '子智能体分栏后端流式期间必须保持跑表运行');

    // 两步交接期仅发生模型名变动且 DOM 仍无停止按钮时，不得因 domIsStreaming=false 停表冻结
    subInst.notifyModelOrStreamingChange('gemini-4-argon', false);
    assert.equal(subInst.isStreaming, true);
    assert.equal(subInst.hasActiveWork, true);
    assert.ok(subInst.turnClockTimer !== null, '模型切换通知不得冻结正在运行的子智能体轨迹跑表');

    // 若 DOM 经历从 true -> false 显式结束一轮，同步复位 backendIsStreaming
    subInst.notifyModelOrStreamingChange('gemini-4-argon', true);
    subInst.notifyModelOrStreamingChange('gemini-4-argon', false);
    assert.equal(subInst.backendIsStreaming, false);
    assert.equal(subInst.isStreaming, false);

    // 对比：普通分屏对话 (isSubpane=true, isSubagentTrajectory=false) 挂着后台子代理时，不得把前台小圆点点亮
    const splitMain = new HudInstance('pane-split-main', { isSubpane: true });
    const mainHost = new FakeElement('div');
    const mainShadow = mainHost.attachShadow({ mode: 'open' });
    mainHost.shadowRoot = mainShadow;
    splitMain.host = mainHost;
    splitMain.shadow = mainShadow;
    mainShadow.innerHTML = splitMain.buildHudHtml();
    splitMain.switchConversation('split-main-conv', 'gemini-3.8-flash', false);
    splitMain.updateMetrics({
      conversationId: 'split-main-conv',
      sessionRevision: splitMain.getSessionRevision(),
      updatedAt: Date.now(),
      isStreaming: true,
      isSubagentRunning: true,
      runningSubagentCount: 1,
      activityPhase: 'idle',
      session: {
        isSubagentTrajectory: false,
        turns: 1,
        steps: 2,
        activeModelStepCount: 0,
        activeToolStepCount: 0,
      },
    });
    assert.equal(splitMain.isStreaming, false, '普通分屏主会话不得因后台子代理将前台 isStreaming 抬成 true');
    assert.equal(splitMain.activityPhase, 'idle');
    assert.equal(splitMain.isSubagentRunning, true);

    subInst.dispose();
    splitMain.dispose();
  });

  it('2.34.0 DOM data-context-window 探针、收窄 MutationObserver、syncAllSessions 刷新代际防竞态与通用阶段短名', () => {
    const observedCalls = [];
    const OrigMO = globalThis.MutationObserver;
    const origDoc = globalThis.document;
    globalThis.MutationObserver = class {
      constructor(cb) { this.cb = cb; }
      observe(target, opts) { observedCalls.push({ target, opts }); }
      disconnect() {}
    };
    const fakeBody = { nodeType: 1, querySelectorAll: () => [] };
    const fakeDocEl = { nodeType: 1 };
    globalThis.document = {
      body: fakeBody,
      documentElement: fakeDocEl,
      hidden: false,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    try {
      const bridgeEvents = [];
      const manager = new AntigravityHudManager({
        onBridgeEvent: (e) => bridgeEvents.push(e),
      });
      manager.start();

      // 1. 验证 document.body subtree MutationObserver 不再监听全子树 style / class
      const subtreeObs = observedCalls.find((c) => c.target === fakeBody && c.opts?.subtree === true);
      assert.ok(subtreeObs, '应存在 document.body subtree observer');
      assert.equal(subtreeObs.opts.attributeFilter.includes('style'), false, 'subtree observer 不得监听 style');
      assert.equal(subtreeObs.opts.attributeFilter.includes('class'), false, 'subtree observer 不得监听 class');
      assert.equal(subtreeObs.opts.attributeFilter.includes('data-context-window'), true);

      // 2. 验证 data-context-window 解析与非品牌硬编码触发器解析
      assert.equal(manager.parseContextWindowTokens('512k'), 512_000);
      assert.equal(manager.parseContextWindowTokens('1M'), 1_000_000);
      assert.equal(manager.parseContextWindowTokens('256000'), 256_000);
      assert.equal(manager.parseContextWindowTokens('invalid'), undefined);

      const mockTrigger = new FakeElement('button');
      mockTrigger.setAttribute('data-testid', 'model-selector-trigger');
      mockTrigger.setAttribute('data-context-window', '512k');
      mockTrigger.setAttribute('aria-label', 'Select model, current: Orchestrator Gemini 4 Neon High');
      mockTrigger.textContent = 'Orchestrator Gemini 4 Neon High';
      const mockView = new FakeElement('div');
      mockView.appendChild(mockTrigger);
      assert.equal(manager.resolveActiveModel(mockView, 1), 'Orchestrator Gemini 4 Neon High');
      assert.equal(manager.resolveActiveModelCapacity(mockView, 1), 512_000);

      // 3. 验证 syncAllSessions 推进 sessionRevision 防止旧在途轮询包倒灌覆盖
      const inst = new HudInstance('pane-sync', {
        paneSlotId: 'pane-sync',
        onBridgeEvent: (e) => bridgeEvents.push(e),
        allocateRevision: () => manager.allocateSessionRevision(),
      });
      const host = new FakeElement('div');
      const shadow = host.attachShadow({ mode: 'open' });
      host.shadowRoot = shadow;
      inst.host = host;
      inst.shadow = shadow;
      shadow.innerHTML = inst.buildHudHtml();
      const rev1 = inst.switchConversation('conv-sync-race', 'Orchestrator Gemini 4 Neon High', false, false, 0, null, 'idle', 512_000);
      assert.equal(bridgeEvents.at(-1)?.modelCapacity, 512_000);
      assert.equal(inst.updateMetrics({
        conversationId: 'conv-sync-race',
        paneSlotId: 'pane-sync',
        sessionRevision: rev1,
        metricsSequence: 200,
        updatedAt: Date.now(),
        context: { hasUsageData: true, usedTokens: 90_000, capacityTokens: 512_000, usedRatio: 90_000 / 512_000 },
      }), true);

      manager.instances.set('pane-sync', inst);
      manager.reconcileMounts = () => {};
      manager.syncAllSessions();
      const rev2 = inst.getSessionRevision();
      assert.ok(rev2 > rev1, 'syncAllSessions 必须推进单调 sessionRevision');
      // 旧代际在途乱序旧包 (rev1, seq=150) 必须被严格拒收
      assert.equal(inst.updateMetrics({
        conversationId: 'conv-sync-race',
        paneSlotId: 'pane-sync',
        sessionRevision: rev1,
        metricsSequence: 150,
        updatedAt: Date.now(),
        context: { hasUsageData: true, usedTokens: 10_000, capacityTokens: 512_000, usedRatio: 10_000 / 512_000 },
      }), false, '旧代际在途轮询包不得覆盖最新状态');
      assert.equal(inst.lastMetrics.context.usedTokens, 90_000);

      // 4. 验证通用阶段短名（含 Orchestrator 前缀、第三方厂商前缀与未知待介入规划阶段中性文案）
      const listEl = new FakeElement('div');
      inst.renderModelStagesList(
        listEl,
        [
          { slotKey: 'orchestrator:planner_pending', role: 'planner', modelId: 'pending', shortLabel: '', hasUsageData: false, isActive: false },
          { slotKey: 'model:openai-gpt-5-2', role: 'model', modelId: 'gpt-5.2', modelDisplayName: 'Orchestrator OpenAI GPT-5.2', shortLabel: 'GPT-5.2', hasUsageData: true, isActive: true, usedTokens: 50_000, capacityTokens: 200_000, usedRatio: 0.25 },
        ],
        false
      );
      assert.match(listEl.innerHTML, /规划阶段/);
      assert.match(listEl.innerHTML, /GPT-5\.2/);
      assert.equal(/Orchestrator|OpenAI/.test(listEl.innerHTML), false);

      inst.dispose();
      manager.dispose();
    } finally {
      globalThis.MutationObserver = OrigMO;
      globalThis.document = origDoc;
    }
  });

  it('scoped composer characterData 监听在模型按钮纯文本更新时立即触发 MODEL_CHANGED 并忽略编辑器输入与完整清理', async () => {
    const observers = [];
    const OrigMO = globalThis.MutationObserver;
    const OrigRO = globalThis.ResizeObserver;
    const origDoc = globalThis.document;
    const origWin = globalThis.window;

    globalThis.MutationObserver = class {
      constructor(cb) {
        this.cb = cb;
        this.records = [];
        this.disconnected = false;
        observers.push(this);
      }
      observe(target, opts) {
        this.records.push({ target, opts });
      }
      disconnect() {
        this.disconnected = true;
      }
    };
    globalThis.ResizeObserver = class {
      observe() {}
      disconnect() {}
    };

    const doc = new FakeElement('document');
    doc.body = new FakeElement('body', doc);
    doc.documentElement = new FakeElement('html', doc);
    doc.hidden = false;
    doc.createElement = (tag) => new FakeElement(tag, doc);
    doc.querySelectorAll = (sel) => doc.body.querySelectorAll(sel);
    doc.querySelector = (sel) => doc.body.querySelector(sel);
    doc.addEventListener = () => {};
    doc.removeEventListener = () => {};
    globalThis.document = doc;
    globalThis.window = {
      innerWidth: 1280,
      innerHeight: 800,
      location: { pathname: '/c/11111111-2222-3333-4444-555555555555' },
      matchMedia: () => ({ matches: true }),
      getComputedStyle: () => ({ visibility: 'visible', display: 'block', paddingBottom: '0px' }),
      addEventListener: () => {},
    };

    try {
      const view = new FakeElement('div', doc);
      view.setAttribute('data-testid', 'conversation-view');
      view.setAttribute('data-cascade-id', 'cascade-composer-text');
      view.setAttribute('data-conversation-id', 'conv-composer-text-1');

      const composer = new FakeElement('div', doc);
      composer.className = 'surface-composer';

      const editor = new FakeElement('div', doc);
      editor.setAttribute('contenteditable', 'true');
      const editorParagraph = new FakeElement('p', doc);
      editor.appendChild(editorParagraph);
      const editorTextNode = { nodeType: 3, parentNode: editorParagraph, parentElement: editorParagraph, data: 'hello' };

      const modelBtn = new FakeElement('button', doc);
      modelBtn.setAttribute('data-testid', 'model-selector-trigger');
      const modelLabelSpan = new FakeElement('span', doc);
      modelBtn.appendChild(modelLabelSpan);
      modelBtn.textContent = 'Claude Sonnet 4.5';
      const modelTextNode = { nodeType: 3, parentNode: modelLabelSpan, parentElement: modelLabelSpan, data: 'Claude Sonnet 4.5' };

      const hudHostInner = new FakeElement('div', doc);
      hudHostInner.className = '__gravitybox_hud_host__';
      const hudTextNode = { nodeType: 3, parentNode: hudHostInner, parentElement: hudHostInner, data: '46%' };

      composer.appendChild(editor);
      composer.appendChild(modelBtn);
      composer.appendChild(hudHostInner);
      view.appendChild(composer);
      doc.body.appendChild(view);

      const bridgeEvents = [];
      const manager = new AntigravityHudManager({
        onBridgeEvent: (e) => bridgeEvents.push(e),
      });
      manager.start();

      // 1. 验证 document.body subtree observer 依然没有 characterData / style / class
      const bodySubtreeObs = observers.find((o) =>
        o.records.some((r) => r.target === doc.body && r.opts?.subtree === true)
      );
      assert.ok(bodySubtreeObs, '应存在 document.body subtree observer');
      const bodySubtreeOpts = bodySubtreeObs.records.find((r) => r.target === doc.body && r.opts?.subtree === true).opts;
      assert.equal(Boolean(bodySubtreeOpts.characterData), false, 'document.body subtree observer 不得开启 characterData');
      assert.equal(bodySubtreeOpts.attributeFilter.includes('style'), false, 'document.body subtree observer 不得监听 style');
      assert.equal(bodySubtreeOpts.attributeFilter.includes('class'), false, 'document.body subtree observer 不得监听 class');

      // 2. 验证 scoped composer observer 已挂载且仅对 composer 启用 characterData + subtree
      const composerObs = manager.composerTextObservers.get(composer);
      assert.ok(composerObs, '应为活跃 composer 创建 scoped characterData observer');
      assert.deepEqual(composerObs.records[0], {
        target: composer,
        opts: { characterData: true, subtree: true },
      });

      let reconcileCallCount = 0;
      const origReconcile = manager.reconcileMounts.bind(manager);
      manager.reconcileMounts = (...args) => {
        reconcileCallCount += 1;
        return origReconcile(...args);
      };

      // 3. 验证 composer 内 [contenteditable="true"] 与 .__gravitybox_hud_host__ 的 characterData 变化不会触发 reconcileMounts
      composerObs.cb([{ type: 'characterData', target: editorTextNode }]);
      assert.equal(manager.reconcileTimer, null, '编辑器内 characterData 变化不得调度 reconcileTimer');
      composerObs.cb([{ type: 'characterData', target: hudTextNode }]);
      assert.equal(manager.reconcileTimer, null, 'HUD 宿主内 characterData 变化不得调度 reconcileTimer');
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(reconcileCallCount, 0, '编辑器或 HUD 宿主内 characterData 变化不得触发 reconcileMounts');

      // 4. 验证 model-selector-trigger 按钮内 TextNode 更新不等待 650ms routeTimer，在 20ms 调度后触发 reconcileMounts 并发出 MODEL_CHANGED
      bridgeEvents.length = 0;
      modelBtn.textContent = 'Orchestrator Gemini 4 Neon High';
      modelTextNode.data = 'Orchestrator Gemini 4 Neon High';
      const triggerAt = Date.now();
      composerObs.cb([{ type: 'characterData', target: modelTextNode }]);
      assert.notEqual(manager.reconcileTimer, null, '模型按钮 characterData 变化应立即调度 reconcileTimer');

      while (Date.now() - triggerAt < 300) {
        if (bridgeEvents.some((e) => e.type === 'MODEL_CHANGED')) break;
        await new Promise((r) => setTimeout(r, 15));
      }
      const elapsedMs = Date.now() - triggerAt;
      const modelChanged = bridgeEvents.find((e) => e.type === 'MODEL_CHANGED');
      assert.ok(modelChanged, '应发出 MODEL_CHANGED 事件');
      assert.equal(modelChanged.modelId, 'Orchestrator Gemini 4 Neon High');
      assert.ok(reconcileCallCount >= 1, '应已触发 reconcileMounts');
      assert.ok(elapsedMs < 400, `应远快于 650ms routeTimer（实际 ${elapsedMs}ms）`);

      // 5. 验证 setEnabled(false)、setRouteExcluded(true)、空 views 与 dispose() 均会断开并清空所有 scoped composer observers
      manager.setEnabled(false);
      assert.equal(composerObs.disconnected, true, 'setEnabled(false) 必须 disconnect scoped composer observer');
      assert.equal(manager.composerTextObservers.size, 0, 'setEnabled(false) 必须清空 composerTextObservers');

      manager.setEnabled(true);
      const reattachedObs = manager.composerTextObservers.get(composer);
      assert.ok(reattachedObs, '重新启用后应重新挂载 scoped composer observer');
      assert.equal(reattachedObs.disconnected, false);

      manager.setRouteExcluded(true);
      assert.equal(reattachedObs.disconnected, true, 'setRouteExcluded(true) 必须 disconnect scoped composer observer');
      assert.equal(manager.composerTextObservers.size, 0, 'setRouteExcluded(true) 必须清空 composerTextObservers');

      manager.setRouteExcluded(false);
      const thirdObs = manager.composerTextObservers.get(composer);
      assert.ok(thirdObs, '解除路由排除后应重新挂载 scoped composer observer');
      assert.equal(thirdObs.disconnected, false);

      // 6. 验证空 views / 分栏移除时断开并清理已移除 composer 的 observer
      origReconcile([]);
      assert.equal(thirdObs.disconnected, true, '空 views 协调必须 disconnect scoped composer observer');
      assert.equal(manager.composerTextObservers.size, 0, '空 views 协调必须清空 composerTextObservers');

      origReconcile([view]);
      const fourthObs = manager.composerTextObservers.get(composer);
      assert.ok(fourthObs, '恢复分栏后应重新挂载 scoped composer observer');

      manager.dispose();
      assert.equal(fourthObs.disconnected, true, 'dispose() 必须 disconnect scoped composer observer');
      assert.equal(manager.composerTextObservers.size, 0, 'dispose() 必须清空 composerTextObservers');
    } finally {
      globalThis.MutationObserver = OrigMO;
      globalThis.ResizeObserver = OrigRO;
      globalThis.document = origDoc;
      globalThis.window = origWin;
    }
  });

  it('P1-1 回归：流式运行中重挂 mount() 保留三组活体时钟锚点并触发 REQUEST_REFRESH，且 0 秒起步轮次 tickTurnClock 正常推进 turnHighWaterMark', () => {
    const doc = new FakeElement('document');
    doc.body = new FakeElement('body', doc);
    doc.documentElement = new FakeElement('html', doc);
    doc.hidden = false;
    doc.visibilityState = 'visible';
    doc.createElement = (tag) => new FakeElement(tag, doc);
    doc.addEventListener = () => {};
    doc.removeEventListener = () => {};
    const origDoc = globalThis.document;
    const origWin = globalThis.window;
    globalThis.document = doc;
    globalThis.window = {
      innerWidth: 1280,
      innerHeight: 800,
      matchMedia: () => ({ matches: false }),
      getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
      addEventListener: () => {},
    };
    try {
      const bridgeEvents = [];
      const composer = new FakeElement('div', doc);
      composer.className = 'surface-composer';
      doc.body.appendChild(composer);

      const inst = new HudInstance('pane-p11', {
        paneSlotId: 'pane-p11',
        onBridgeEvent: (e) => bridgeEvents.push(e),
      });
      inst.mount(composer);
      const rev = inst.switchConversation('conv-p11', 'gemini-3.8-flash', true, false, 0, null, 'generating');

      // 0 秒起步轮次进入流式
      inst.updateMetrics({
        conversationId: 'conv-p11',
        paneSlotId: 'pane-p11',
        sessionRevision: rev,
        metricsSequence: 1,
        updatedAt: Date.now(),
        availability: 'ready',
        isStreaming: true,
        activityPhase: 'generating',
        session: {
          turns: 1,
          steps: 2,
          modelDurationSeconds: 0,
          inFlightModelDurationSeconds: 0,
          activeModelStepCount: 1,
          toolDurationSeconds: 0,
          inFlightToolDurationSeconds: 0,
          activeToolStepCount: 0,
          currentTurnDurationSeconds: 0,
        },
      });
      assert.equal(inst.turnHighWaterMark?.seconds, 0);

      // 模拟时钟向前推进 45 秒后触发 tickTurnClock：0 秒起步轮次也必须推进 turnHighWaterMark
      const pastMs = Date.now() - 45_000;
      inst.turnClockAnchor.anchorMs = pastMs;
      inst.modelClockAnchor.anchorMs = pastMs;
      inst.tickTurnClock();
      assert.ok(
        (inst.turnHighWaterMark?.seconds ?? 0) >= 44,
        `0 秒起步轮次 tickTurnClock 必须更新 turnHighWaterMark，实际=${inst.turnHighWaterMark?.seconds}`
      );

      // 模拟 DOM 重绘导致 host 脱离后触发 reconcile -> mount()，验证三组时钟锚点保留且不倒退并触发 REQUEST_REFRESH
      bridgeEvents.length = 0;
      const newComposer = new FakeElement('div', doc);
      newComposer.className = 'surface-composer';
      doc.body.appendChild(newComposer);
      inst.host.remove();
      inst.reconcile(newComposer);

      assert.ok(inst.turnClockAnchor, '重挂后必须保留 turnClockAnchor');
      assert.ok(inst.modelClockAnchor, '重挂后必须保留 modelClockAnchor');
      const liveTurnAfterRemount =
        inst.turnClockAnchor.baseSeconds + (Date.now() - inst.turnClockAnchor.anchorMs) / 1000;
      const liveModelAfterRemount = inst.getLiveClockSeconds(inst.modelClockAnchor, Date.now());
      assert.ok(liveTurnAfterRemount >= 44, `重挂后本轮用时不得归零倒退，实际=${liveTurnAfterRemount}`);
      assert.ok(liveModelAfterRemount >= 44, `重挂后模型用时不得归零倒退，实际=${liveModelAfterRemount}`);
      assert.ok(
        bridgeEvents.some((e) => e.type === 'REQUEST_REFRESH' && e.conversationId === 'conv-p11'),
        '活跃重挂后应发出 REQUEST_REFRESH 向后端校准'
      );
      inst.dispose();
    } finally {
      globalThis.document = origDoc;
      globalThis.window = origWin;
    }
  });

  it('P1-3 回归：remote_unbridged 卡片 #val-turn-dur 正确展示观测耗时、idle 保留高水位，并在下轮流式重启时清零重计', () => {
    const inst = new HudInstance('pane-p13', {
      paneSlotId: 'pane-p13',
      locale: 'zh-Hans',
      languageMode: 'zh',
    });
    const host = new FakeElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    host.shadowRoot = shadow;
    inst.host = host;
    inst.shadow = shadow;
    shadow.innerHTML = inst.buildHudHtml();

    const rev = inst.switchConversation('conv-ssh-p13', 'gemini-3.8-flash', true, false, 0, null, 'generating');
    inst.updateMetrics({
      conversationId: 'conv-ssh-p13',
      paneSlotId: 'pane-p13',
      sessionRevision: rev,
      metricsSequence: 1,
      updatedAt: Date.now(),
      availability: 'remote_unbridged',
      sourceKind: 'remote',
      remoteHostLabel: 'prod-box',
      isStreaming: true,
      activityPhase: 'generating',
      session: { turns: 0, steps: 0, currentTurnDurationSeconds: 0 },
    });

    // 模拟已运行 15 秒并再次收到 remote_unbridged 流式快照：卡片 #val-turn-dur 不得被抹成 '—'
    inst.turnClockAnchor.anchorMs = Date.now() - 15_000;
    inst.tickTurnClock();
    inst.updateMetrics({
      conversationId: 'conv-ssh-p13',
      paneSlotId: 'pane-p13',
      sessionRevision: rev,
      metricsSequence: 2,
      updatedAt: Date.now(),
      availability: 'remote_unbridged',
      sourceKind: 'remote',
      remoteHostLabel: 'prod-box',
      isStreaming: true,
      activityPhase: 'generating',
      session: { turns: 0, steps: 0, currentTurnDurationSeconds: 0 },
    });
    assert.match(shadow.querySelector('#val-turn-dur').textContent, /1[56]秒/, '流式期卡片 #val-turn-dur 必须展示观测耗时而非 —');
    assert.match(shadow.querySelector('#hud-txt-session .hud-turn-dur').textContent, /已观测.*1[56]s/);

    // 流式结束收到 idle 包：必须保留最近一次观测高水位而不归零
    inst.notifyModelOrStreamingChange('gemini-3.8-flash', false, false, 0, null, 'idle');
    inst.updateMetrics({
      conversationId: 'conv-ssh-p13',
      paneSlotId: 'pane-p13',
      sessionRevision: rev,
      metricsSequence: 3,
      updatedAt: Date.now(),
      availability: 'remote_unbridged',
      sourceKind: 'remote',
      remoteHostLabel: 'prod-box',
      isStreaming: false,
      activityPhase: 'idle',
      session: { turns: 0, steps: 0, currentTurnDurationSeconds: 0 },
    });
    assert.ok((inst.turnHighWaterMark?.seconds ?? 0) >= 14, 'idle 后 remote_unbridged 必须保留观测高水位');
    assert.match(shadow.querySelector('#val-turn-dur').textContent, /1[56]秒/, 'idle 后卡片 #val-turn-dur 应保留观测耗时');
    assert.match(shadow.querySelector('#hud-txt-session .hud-turn-dur').textContent, /已观测.*1[56]s/);

    // 下一轮流式重启时应清零旧高水位，从 0 秒重新开始观测计时
    inst.notifyModelOrStreamingChange('gemini-3.8-flash', true, false, 0, null, 'generating');
    assert.ok((inst.turnClockAnchor?.baseSeconds ?? 99) < 2, '下轮 remote_unbridged 流式重启应从 0 秒重新计时');
    inst.dispose();
  });

  it('P2-2 回归：tickTurnClock 推进模型/工具计时更新 #hud-popover-session 的 data-exact-summary 时保留 compactions 字段', () => {
    const inst = new HudInstance('pane-p22', {
      paneSlotId: 'pane-p22',
      locale: 'zh-Hans',
      languageMode: 'zh',
    });
    const host = new FakeElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    host.shadowRoot = shadow;
    inst.host = host;
    inst.shadow = shadow;
    shadow.innerHTML = inst.buildHudHtml();

    const rev = inst.switchConversation('conv-p22', 'gemini-3.8-flash', true, false, 0, null, 'generating');
    inst.updateMetrics({
      conversationId: 'conv-p22',
      paneSlotId: 'pane-p22',
      sessionRevision: rev,
      metricsSequence: 1,
      updatedAt: Date.now(),
      availability: 'live',
      isStreaming: true,
      activityPhase: 'generating',
      session: {
        turns: 4,
        steps: 12,
        compactionCount: 3,
        modelDurationSeconds: 10,
        toolDurationSeconds: 5,
        inFlightModelDurationSeconds: 1,
        inFlightToolDurationSeconds: 0,
        activeModelStepCount: 1,
        activeToolStepCount: 0,
        currentTurnDurationSeconds: 1,
        averageTtftSeconds: 1.25,
        outputTps: 65.5,
      },
      tokens: { totalTokens: 5000, cacheHitRate: 0.5 },
      context: { hasUsageData: true, usedTokens: 5000, capacityTokens: 1000000, usedRatio: 0.005 },
    });

    const popSession = shadow.querySelector('#hud-popover-session');
    assert.match(popSession.getAttribute('data-exact-summary') || '', /compactions=3/, '初始渲染应含 compactions=3');

    // 模拟 3 秒后 tickTurnClock 推进模型时钟
    inst.modelClockAnchor.anchorMs = Date.now() - 3_000;
    inst.tickTurnClock();
    const afterTick = popSession.getAttribute('data-exact-summary') || '';
    assert.match(afterTick, /turns=4; steps=12;/);
    assert.match(afterTick, /compactions=3$/, 'tickTurnClock 更新 data-exact-summary 不得丢失 compactions 字段');
    inst.dispose();
  });
});
