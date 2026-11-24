import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AntigravityHudManager } from '../runtime/hud-manager.js';
import { HudInstance } from '../runtime/hud-instance.js';
import { resolveVisibleHorizontalBounds } from '../runtime/hud-popover.js';

class FakeStyleDeclaration {
  constructor() {
    this.cssText = '';
  }
}

function splitCombinatorOutsideBrackets(sel) {
  const tokens = [];
  let current = '';
  let depth = 0;
  for (let i = 0; i < sel.length; i++) {
    const ch = sel[i];
    if (ch === '[') depth++;
    else if (ch === ']' && depth > 0) depth--;
    if (depth === 0 && (ch === '>' || /\s/.test(ch))) {
      if (current.trim()) {
        tokens.push({ op: null, part: current.trim() });
        current = '';
      }
      if (ch === '>') {
        if (tokens.length > 0) tokens[tokens.length - 1].nextOp = '>';
      } else if (tokens.length > 0 && !tokens[tokens.length - 1].nextOp) {
        tokens[tokens.length - 1].nextOp = ' ';
      }
    } else {
      current += ch;
    }
  }
  if (current.trim()) {
    tokens.push({ op: null, part: current.trim() });
  }
  return tokens;
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

  get parentElement() {
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
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
    if (this._textContent) return this._textContent;
    return this.children.map((c) => c.textContent).join('');
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

  contains(target) {
    let cur = target;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parentNode;
    }
    return false;
  }

  matchesSingle(part) {
    const p = part.trim();
    if (!p) return false;
    if (p.startsWith('.')) {
      return this.classList.contains(p.slice(1));
    }
    const attrMatches = [...p.matchAll(/\[([a-zA-Z0-9_-]+)(?:([\*\^]?=)"([^"]*)")?\]/g)];
    const tagMatch = p.match(/^([a-zA-Z][a-zA-Z0-9-]*)/);
    if (tagMatch && this.tagName !== tagMatch[1].toUpperCase()) {
      return false;
    }
    if (attrMatches.length > 0) {
      for (const m of attrMatches) {
        const attrName = m[1];
        const op = m[2];
        const expected = m[3];
        if (expected === undefined) {
          if (!this.hasAttribute(attrName)) return false;
        } else if (op === '*=') {
          if (!String(this.getAttribute(attrName) || '').includes(expected)) return false;
        } else if (op === '^=') {
          if (!String(this.getAttribute(attrName) || '').startsWith(expected)) return false;
        } else if (this.getAttribute(attrName) !== expected) {
          return false;
        }
      }
      return true;
    }
    return Boolean(tagMatch);
  }

  matches(sel) {
    const parts = String(sel).split(',');
    return parts.some((part) => {
      const trimmed = part.trim();
      if (!trimmed) return false;
      const tokens = splitCombinatorOutsideBrackets(trimmed);
      if (tokens.length === 0) return false;
      if (!this.matchesSingle(tokens[tokens.length - 1].part)) return false;
      if (tokens.length === 1) return true;
      if (tokens.length === 2 && this.parentNode) {
        const directOnly = tokens[0].nextOp === '>';
        let cur = this.parentNode;
        while (cur) {
          if (cur.matchesSingle?.(tokens[0].part)) return true;
          if (directOnly) break;
          cur = cur.parentNode;
        }
        return false;
      }
      return false;
    });
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
    const visit = (node) => {
      for (const child of node.children || []) {
        if (child.matches(sel)) {
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
      '#lbl-turn-dur',
      '#val-turn-dur',
      '#pop-tokens-title',
      '#pop-tokens-badge',
      '#lbl-tok-total',
      '#val-tok-total',
      '#lbl-tok-input',
      '#val-tok-input',
      '#lbl-tok-output',
      '#val-tok-output',
      '#lbl-tok-reasoning',
      '#val-tok-reasoning',
      '#lbl-tok-cache-read',
      '#val-tok-cache-read',
      '#lbl-tok-cache-write',
      '#val-tok-cache-write',
      '#lbl-tok-cost',
      '#val-tok-cost',
      '#pop-context-title',
      '#pop-context-badge',
      '#lbl-ctx-model',
      '#val-ctx-model',
      '#lbl-ctx-used',
      '#val-ctx-used',
      '#lbl-ctx-remain',
      '#val-ctx-remain',
      '#lbl-ctx-compactions',
      '#val-ctx-compactions',
      '#val-ctx-history',
      '#pop-ctx-breakdown',
      '#ctx-seg-cached',
      '#ctx-seg-uncached',
      '#ctx-seg-free',
      '#ctx-leg-cached',
      '#ctx-leg-uncached',
      '#ctx-leg-free',
    ];
    for (const s of selectors) {
      const el = new FakeElement('span');
      this.elementsBySel.set(s, el);
    }

    for (const id of ['session', 'tokens', 'context']) {
      const cap = new FakeElement('button');
      cap.className = `capsule capsule-${id}`;
      cap.setAttribute('data-capsule-id', id);
      cap._rect = { left: 100, top: 700, width: 120, height: 22, right: 220, bottom: 722 };
      this.capsules.push(cap);
      this.elementsBySel.set(`.capsule-${id}`, cap);
      this.elementsBySel.set(`.capsule[data-capsule-id="${id}"]`, cap);

      const pop = new FakeElement('div');
      pop.className = 'hud-popover';
      pop.id = `hud-popover-${id}`;
      pop.setAttribute('data-popover-id', id);
      pop.setAttribute('hidden', '');
      this.popovers.push(pop);
      this.elementsBySel.set(`#hud-popover-${id}`, pop);

      const inner = new FakeElement('div');
      inner.className = 'hud-popover-inner';
      inner.scrollHeight = 180;
      this.elementsBySel.set(`#hud-popover-${id} .hud-popover-inner`, inner);

      const arrow = new FakeElement('div');
      arrow.id = `arrow-${id}`;
      this.elementsBySel.set(`#arrow-${id}`, arrow);
    }
  }

  querySelector(sel) {
    if (sel === '.hud-container') return this.container || null;
    return this.elementsBySel.get(sel) || null;
  }

  querySelectorAll(sel) {
    if (sel === '.capsule') return this.capsules;
    if (sel === '.hud-popover') return this.popovers;
    const found = this.elementsBySel.get(sel);
    return found ? [found] : [];
  }
}

function createFakeDomEnv(pathname = '/c/11111111-1111-4111-8111-111111111111', search = '') {
  const doc = new FakeElement('document');
  doc.documentElement = new FakeElement('html', doc);
  doc.body = new FakeElement('body', doc);
  doc.appendChild(doc.documentElement);
  doc.documentElement.appendChild(doc.body);
  doc.createElement = (tag) => new FakeElement(tag, doc);

  const win = {
    innerWidth: 1440,
    innerHeight: 900,
    location: { pathname, search, hash: '' },
    getComputedStyle: (el) => ({
      display: el.style?.display || 'block',
      visibility: el.style?.visibility || 'visible',
      opacity: el.style?.opacity || '1',
      paddingLeft: '0',
      paddingRight: '0',
    }),
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  return { doc, win };
}

function createMainPane(doc, { convId, modelId = 'claude-opus-4-6', capacity = 200000 }) {
  const view = new FakeElement('div', doc);
  view.setAttribute('data-testid', 'conversation-view');
  if (convId) view.setAttribute('data-cascade-id', convId);
  view._rect = { left: 0, top: 0, width: 900, height: 900, right: 900, bottom: 900 };

  const inputBox = new FakeElement('div', doc);
  inputBox.setAttribute('data-testid', 'agent-input-box');
  const composer = new FakeElement('div', doc);
  composer.className = 'surface-composer';
  const modelBtn = new FakeElement('button', doc);
  modelBtn.setAttribute('data-testid', 'model-selector-trigger');
  modelBtn.setAttribute('data-model-id', modelId);
  modelBtn.setAttribute('data-context-window', String(capacity));
  modelBtn.textContent = modelId;

  composer.appendChild(modelBtn);
  inputBox.appendChild(composer);
  view.appendChild(inputBox);

  return { view, inputBox, composer, modelBtn };
}

function createBtwSidePane(doc, { convId, modelId = 'gemini-3.8-flash', capacity = 1000000 }) {
  // Header sibling wrapper ABOVE side-question-tab-content (with static stop/promote/delete buttons)
  const wrapper = new FakeElement('div', doc);
  const header = new FakeElement('div', doc);
  const stopHeaderBtn = new FakeElement('button', doc);
  stopHeaderBtn.setAttribute('data-testid', 'side-question-tab-stop');
  stopHeaderBtn.textContent = 'Stop';
  const promoteBtn = new FakeElement('button', doc);
  promoteBtn.setAttribute('data-testid', 'side-question-tab-promote');
  promoteBtn.textContent = 'Promote';
  const deleteBtn = new FakeElement('button', doc);
  deleteBtn.setAttribute('data-testid', 'side-question-tab-delete');
  deleteBtn.textContent = 'Delete';
  header.appendChild(stopHeaderBtn);
  header.appendChild(promoteBtn);
  header.appendChild(deleteBtn);

  const subpane = new FakeElement('div', doc);
  subpane.setAttribute('data-testid', 'side-question-tab-content');
  subpane.setAttribute('data-media-drop-scope', 'subpane');
  subpane._rect = { left: 920, top: 48, width: 500, height: 820, right: 1420, bottom: 868 };

  const btwConv = new FakeElement('div', doc);
  btwConv.setAttribute('data-testid', 'side-question-tab-conversation');
  if (convId) btwConv.setAttribute('data-cascade-id', convId);

  const btwComposerWrap = new FakeElement('div', doc);
  btwComposerWrap.setAttribute('data-testid', 'side-question-tab-composer');
  btwComposerWrap.setAttribute('data-side-panel-composer', '');

  const inputBox = new FakeElement('div', doc);
  inputBox.setAttribute('data-testid', 'agent-input-box');
  const modelBtn = new FakeElement('button', doc);
  modelBtn.setAttribute('data-testid', 'model-selector-trigger');
  modelBtn.setAttribute('data-model-id', modelId);
  modelBtn.setAttribute('data-context-window', String(capacity));
  modelBtn.textContent = modelId;

  inputBox.appendChild(modelBtn);
  btwComposerWrap.appendChild(inputBox);
  subpane.appendChild(btwConv);
  subpane.appendChild(btwComposerWrap);

  wrapper.appendChild(header);
  wrapper.appendChild(subpane);

  return { wrapper, header, subpane, btwConv, btwComposerWrap, inputBox, modelBtn };
}

function withFakeDom(doc, win, fn) {
  const prevWin = globalThis.window;
  const prevDoc = globalThis.document;
  globalThis.window = win;
  globalThis.document = doc;
  try {
    return fn();
  } finally {
    if (prevWin === undefined) delete globalThis.window;
    else globalThis.window = prevWin;
    if (prevDoc === undefined) delete globalThis.document;
    else globalThis.document = prevDoc;
  }
}

describe('HUD BTW (/btw side-question) 前端生命周期与隔离性', { concurrency: false }, () => {
  it('主会话与 BTW 侧栏并行挂载：拥有独立 conversationId、modelId、paneKind 且互不回退 URL', () => {
    const mainUuid = '11111111-1111-4111-8111-111111111111';
    const btwUuid = '22222222-2222-4222-8222-222222222222';
    const { doc, win } = createFakeDomEnv(`/c/${mainUuid}`, `?tab=side_question__${btwUuid}`);

    const main = createMainPane(doc, { convId: mainUuid, modelId: 'claude-opus-4-6', capacity: 200000 });
    const btw = createBtwSidePane(doc, { convId: btwUuid, modelId: 'gemini-3.8-flash', capacity: 1000000 });
    doc.body.appendChild(main.view);
    doc.body.appendChild(btw.wrapper);

    const events = [];
    const mgr = new AntigravityHudManager({ onBridgeEvent: (e) => events.push(e) });

    withFakeDom(doc, win, () => {
      mgr.reconcileMounts();
      assert.equal(mgr.instances.size, 2);

      const instances = [...mgr.instances.values()];
      const mainInst = instances.find((i) => i.paneKind === 'main');
      const btwInst = instances.find((i) => i.paneKind === 'btw');
      assert.ok(mainInst, '应创建 main HUD 实例');
      assert.ok(btwInst, '应创建 btw HUD 实例');

      assert.equal(mainInst.getCurrentConvId(), mainUuid);
      assert.equal(mainInst.currentModelId, 'claude-opus-4-6');
      assert.equal(mainInst.isSubpane, false);

      assert.equal(btwInst.getCurrentConvId(), btwUuid);
      assert.equal(btwInst.currentModelId, 'gemini-3.8-flash');
      assert.equal(btwInst.isSubpane, true);
      assert.deepEqual(btwInst.childConversationIds, []);
      assert.deepEqual(mainInst.childConversationIds, []);

      const attachedMain = events.find((e) => e.type === 'SESSION_ATTACHED' && e.paneKind === 'main');
      const attachedBtw = events.find((e) => e.type === 'SESSION_ATTACHED' && e.paneKind === 'btw');
      assert.equal(attachedMain?.conversationId, mainUuid);
      assert.equal(attachedBtw?.conversationId, btwUuid);

      // Even if resolveConversationId is invoked directly on a BTW element without cascade-id, allowUrl must stay false
      const bareBtw = new FakeElement('div', doc);
      bareBtw.setAttribute('data-testid', 'side-question-tab-conversation');
      assert.equal(mgr.resolveConversationId(bareBtw, null, 1), 'default');
      assert.equal(mgr.resolveConversationId(bareBtw, null, 2), null);
    });

    mgr.dispose();
  });

  it('流式状态完全独立：BTW 流式生成/执行工具不影响主会话圆点，外部 header 静态按钮不误报流式', () => {
    const mainUuid = '11111111-1111-4111-8111-111111111111';
    const btwUuid = '22222222-2222-4222-8222-222222222222';
    const { doc, win } = createFakeDomEnv(`/c/${mainUuid}`, `?tab=side_question__${btwUuid}`);

    const main = createMainPane(doc, { convId: mainUuid });
    const btw = createBtwSidePane(doc, { convId: btwUuid });
    doc.body.appendChild(main.view);
    doc.body.appendChild(btw.wrapper);

    const mgr = new AntigravityHudManager();

    withFakeDom(doc, win, () => {
      // Static header buttons outside side-question-tab-content (and even if tested on wrapper) must NOT trigger streaming
      assert.equal(mgr.resolveActivityPhase(btw.subpane, null, { paneKind: 'btw' }), 'idle');
      assert.equal(mgr.resolveActivityPhase(btw.wrapper, null, { paneKind: 'btw' }), 'idle');

      mgr.reconcileMounts();
      const mainInst = [...mgr.instances.values()].find((i) => i.paneKind === 'main');
      const btwInst = [...mgr.instances.values()].find((i) => i.paneKind === 'btw');

      // 1. BTW enters generating via input-cancel-button inside agent-input-box
      const btwCancel = new FakeElement('button', doc);
      btwCancel.setAttribute('data-testid', 'input-cancel-button');
      btw.inputBox.appendChild(btwCancel);
      mgr.reconcileMounts();

      assert.equal(btwInst.activityPhase, 'generating');
      assert.equal(mainInst.activityPhase, 'idle');
      assert.equal(mainInst.isSubagentRunning, false);

      // 2. BTW executes a tool (ephemeral-tool-status + .animate-shimmer-text) -> executing
      const btwTool = new FakeElement('div', doc);
      btwTool.setAttribute('data-testid', 'ephemeral-tool-status');
      btwTool.textContent = 'Running read_file';
      const btwShimmer = new FakeElement('span', doc);
      btwShimmer.className = 'animate-shimmer-text';
      btwShimmer.textContent = 'Reading file...';
      btw.btwConv.appendChild(btwTool);
      btw.btwConv.appendChild(btwShimmer);
      mgr.reconcileMounts();

      assert.equal(btwInst.activityPhase, 'executing');
      assert.equal(btwInst.isSubagentRunning, false);
      assert.equal(mainInst.activityPhase, 'idle');
      assert.equal(mainInst.isSubagentRunning, false);

      // 3. BTW finishes streaming while stale shimmer remains -> back to idle
      btwCancel.remove();
      mgr.reconcileMounts();
      assert.equal(btwInst.activityPhase, 'idle');

      // 4. BTW streaming via agent-loading + Stop button inside agent-input-box
      const btwLoading = new FakeElement('div', doc);
      btwLoading.setAttribute('data-testid', 'agent-loading');
      btw.btwConv.appendChild(btwLoading);
      assert.equal(mgr.resolveActivityPhase(btw.subpane, null, { paneKind: 'btw' }), 'executing');
      btwTool.remove();
      btwShimmer.remove();
      assert.equal(mgr.resolveActivityPhase(btw.subpane, null, { paneKind: 'btw' }), 'generating');
      btwLoading.remove();

      const stopInComposer = new FakeElement('button', doc);
      stopInComposer.setAttribute('aria-label', 'Stop generating');
      btw.inputBox.appendChild(stopInComposer);
      assert.equal(mgr.resolveActivityPhase(btw.subpane, null, { paneKind: 'btw' }), 'generating');
      stopInComposer.remove();

      // 5. Even if side-question-tab-content is nested inside conversation-view, main MUST ignore it
      main.view.appendChild(btw.subpane);
      btw.inputBox.appendChild(btwCancel);
      btw.btwConv.appendChild(btwTool);
      assert.equal(mgr.resolveSubagentState(main.view, { isSubpane: false }).isSubagentRunning, false);
      assert.equal(mgr.resolveActivityPhase(main.view, null, { isSubpane: false }), 'idle');
    });

    mgr.dispose();
  });

  it('collectDomSubagentIds 严格排除 side_question__ 与 side-question-tab-conversation', () => {
    const mainUuid = '11111111-1111-4111-8111-111111111111';
    const btwUuid = '22222222-2222-4222-8222-222222222222';
    const realSubUuid = '33333333-3333-4333-8333-333333333333';
    const leakedSubInsideBtw = '44444444-4444-4444-8444-444444444444';
    const { doc, win } = createFakeDomEnv(
      `/c/${mainUuid}`,
      `?tab=side_question__${btwUuid}&subagent=${`subagent_convo__${realSubUuid}`}`
    );

    const btw = createBtwSidePane(doc, { convId: btwUuid });
    const subInBtw = new FakeElement('div', doc);
    subInBtw.id = `subagentView-${leakedSubInsideBtw}`;
    btw.btwConv.appendChild(subInBtw);
    doc.body.appendChild(btw.wrapper);

    const mgr = new AntigravityHudManager();
    withFakeDom(doc, win, () => {
      const ids = mgr.collectDomSubagentIds();
      assert.deepEqual(ids, [realSubUuid]);
      assert.equal(ids.includes(btwUuid), false);
      assert.equal(ids.includes(leakedSubInsideBtw), false);
    });
    mgr.dispose();
  });

  it('侧栏切换 Tab（BTW <-> 子智能体 / BTW1 -> BTW2）、关闭侧栏与 Promote 到主会话', () => {
    const mainUuid = '11111111-1111-4111-8111-111111111111';
    const btwUuid1 = '22222222-2222-4222-8222-222222222222';
    const btwUuid2 = '55555555-5555-4555-8555-555555555555';
    const subUuid = '66666666-6666-4666-8666-666666666666';
    const { doc, win } = createFakeDomEnv(`/c/${mainUuid}`);

    const main = createMainPane(doc, { convId: mainUuid });
    const btw = createBtwSidePane(doc, { convId: btwUuid1 });
    doc.body.appendChild(main.view);
    doc.body.appendChild(btw.wrapper);

    const events = [];
    const mgr = new AntigravityHudManager({ onBridgeEvent: (e) => events.push(e) });

    withFakeDom(doc, win, () => {
      mgr.reconcileMounts();
      const sideInst = [...mgr.instances.values()].find((i) => i.paneKind === 'btw');
      const initialSlotId = sideInst.paneSlotId;

      // 1. Switch to second BTW conversation inside same subpane container -> slotId reused
      btw.btwConv.setAttribute('data-cascade-id', btwUuid2);
      mgr.reconcileMounts();
      assert.equal(mgr.instances.get(initialSlotId), sideInst);
      assert.equal(sideInst.paneKind, 'btw');
      assert.equal(sideInst.getCurrentConvId(), btwUuid2);

      // 2. Switch side pane tab from BTW to Subagent inside same subpane container
      btw.btwConv.remove();
      const subTabConv = new FakeElement('div', doc);
      subTabConv.setAttribute('data-testid', 'subagent-tab-conversation');
      subTabConv.setAttribute('data-cascade-id', subUuid);
      btw.subpane.appendChild(subTabConv);
      mgr.reconcileMounts();

      assert.equal(mgr.instances.get(initialSlotId), sideInst);
      assert.equal(sideInst.paneKind, 'subagent');
      assert.equal(sideInst.getCurrentConvId(), subUuid);
      assert.equal(events.at(-1)?.type, 'SESSION_ATTACHED');
      assert.equal(events.at(-1)?.paneKind, 'subagent');

      // 3. Switch back to BTW
      subTabConv.remove();
      btw.btwConv.setAttribute('data-cascade-id', btwUuid1);
      btw.subpane.appendChild(btw.btwConv);
      mgr.reconcileMounts();
      assert.equal(sideInst.paneKind, 'btw');
      assert.equal(sideInst.getCurrentConvId(), btwUuid1);

      // 4. Close side pane -> BTW instance disposed, main stays alive
      btw.subpane.remove();
      mgr.reconcileMounts();
      assert.equal(mgr.instances.size, 1);
      assert.ok(events.some((e) => e.type === 'SESSION_DETACHED' && e.conversationId === btwUuid1 && e.paneKind === 'btw'));

      // 5. Promote BTW to main -> main view switches to btwUuid1 with paneKind: 'main'
      main.view.setAttribute('data-cascade-id', btwUuid1);
      mgr.reconcileMounts();
      const mainInst = [...mgr.instances.values()][0];
      assert.equal(mainInst.paneKind, 'main');
      assert.equal(mainInst.getCurrentConvId(), btwUuid1);
    });

    mgr.dispose();
  });

  it('跨分栏 Popover 互斥：打开 BTW Popover 自动收起主 HUD Popover，反之亦然', () => {
    const mainUuid = '11111111-1111-4111-8111-111111111111';
    const btwUuid = '22222222-2222-4222-8222-222222222222';
    const { doc, win } = createFakeDomEnv(`/c/${mainUuid}`);

    const main = createMainPane(doc, { convId: mainUuid });
    const btw = createBtwSidePane(doc, { convId: btwUuid });
    doc.body.appendChild(main.view);
    doc.body.appendChild(btw.wrapper);

    const mgr = new AntigravityHudManager();

    withFakeDom(doc, win, () => {
      mgr.reconcileMounts();
      const mainInst = [...mgr.instances.values()].find((i) => i.paneKind === 'main');
      const btwInst = [...mgr.instances.values()].find((i) => i.paneKind === 'btw');

      mainInst.pinnedPopoverId = 'session';
      mainInst.showPopover('session');
      assert.equal(mainInst.activePopoverId, 'session');
      assert.equal(mainInst.shadow.querySelector('#hud-popover-session').hasAttribute('hidden'), false);

      // Opening popover on BTW closes main popover
      btwInst.pinnedPopoverId = 'context';
      btwInst.showPopover('context');
      assert.equal(btwInst.activePopoverId, 'context');
      assert.equal(btwInst.shadow.querySelector('#hud-popover-context').hasAttribute('hidden'), false);
      assert.equal(mainInst.activePopoverId, null);
      assert.equal(mainInst.pinnedPopoverId, null);
      assert.equal(mainInst.shadow.querySelector('#hud-popover-session').hasAttribute('hidden'), true);

      // Opening popover on main closes BTW popover
      mainInst.showPopover('tokens');
      assert.equal(mainInst.activePopoverId, 'tokens');
      assert.equal(btwInst.activePopoverId, null);
      assert.equal(btwInst.pinnedPopoverId, null);
      assert.equal(btwInst.shadow.querySelector('#hud-popover-context').hasAttribute('hidden'), true);
    });

    mgr.dispose();
  });

  it('BTW HudInstance 保留 0 轮显示与多轮统计，且 computeMergedActivityPhase 支持 BTW subpaneDbActive', () => {
    const btwInst = new HudInstance('slot-btw', { paneKind: 'btw' });
    assert.equal(btwInst.isSubpane, true);
    assert.equal(btwInst.paneKind, 'btw');

    const host = new FakeElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    host.shadowRoot = shadow;
    btwInst.host = host;
    btwInst.shadow = shadow;
    shadow.innerHTML = btwInst.buildHudHtml();
    btwInst.switchConversation('btw-conv-1', 'gemini-3.8-flash', false);

    // 0 turns with rawSteps > 0 (e.g., pre-first-turn or cancelled first turn) must NOT be hidden like subagent
    btwInst.updateMetrics({
      conversationId: 'btw-conv-1',
      sessionRevision: btwInst.getSessionRevision(),
      updatedAt: Date.now(),
      isStreaming: true,
      activityPhase: 'generating',
      availability: 'live',
      session: {
        turns: 0,
        steps: 2,
        activeModelStepCount: 1,
        activeToolStepCount: 0,
        isSubagentTrajectory: false,
      },
      tokens: { totalTokens: 1200, cacheHitRate: 0.5 },
      context: { hasUsageData: true, usedTokens: 1200, capacityTokens: 1000000, usedRatio: 0.0012 },
    });

    assert.equal(shadow.querySelector('#hud-txt-session .hud-turns').textContent, '0 轮 ');
    assert.equal(btwInst.activityPhase, 'generating', 'BTW 应在 domIsStreaming=false 且 activeModelStepCount>0 时回退 subpaneDbActive');

    // Multi-turn BTW update
    btwInst.updateMetrics({
      conversationId: 'btw-conv-1',
      sessionRevision: btwInst.getSessionRevision(),
      updatedAt: Date.now() + 100,
      isStreaming: false,
      activityPhase: 'idle',
      availability: 'live',
      session: {
        turns: 3,
        steps: 7,
        activeModelStepCount: 0,
        activeToolStepCount: 0,
        isSubagentTrajectory: false,
      },
      tokens: { totalTokens: 4500, cacheHitRate: 0.6 },
      context: { hasUsageData: true, usedTokens: 4500, capacityTokens: 1000000, usedRatio: 0.0045 },
    });
    assert.equal(shadow.querySelector('#hud-txt-session .hud-turns').textContent, '3 轮 ');
    assert.equal(btwInst.activityPhase, 'idle');

    // Confirm subagent pane still hides 0-turn steps
    const subInst = new HudInstance('slot-sub', { paneKind: 'subagent' });
    const subHost = new FakeElement('div');
    const subShadow = subHost.attachShadow({ mode: 'open' });
    subHost.shadowRoot = subShadow;
    subInst.host = subHost;
    subInst.shadow = subShadow;
    subShadow.innerHTML = subInst.buildHudHtml();
    subInst.switchConversation('sub-conv-1', 'gemini-3.8-flash', false);
    subInst.updateMetrics({
      conversationId: 'sub-conv-1',
      sessionRevision: subInst.getSessionRevision(),
      updatedAt: Date.now(),
      availability: 'live',
      session: { turns: 0, steps: 4, isSubagentTrajectory: true },
      tokens: { totalTokens: 1000 },
      context: { hasUsageData: true, usedTokens: 1000, capacityTokens: 1000000, usedRatio: 0.001 },
    });
    assert.equal(subShadow.querySelector('#hud-txt-session .hud-turns').textContent, '');

    btwInst.dispose();
    subInst.dispose();
  });

  it('resolveVisibleHorizontalBounds 识别 side-question-tab-conversation 边界并防止 Popover 越界', () => {
    const doc = new FakeElement('document');
    const btwConv = new FakeElement('div', doc);
    btwConv.setAttribute('data-testid', 'side-question-tab-conversation');
    btwConv._rect = { left: 940, top: 0, width: 480, height: 800, right: 1420, bottom: 800 };
    const anchor = new FakeElement('button', doc);
    btwConv.appendChild(anchor);

    const bounds = resolveVisibleHorizontalBounds(anchor, { innerWidth: 1440, innerHeight: 900 });
    assert.equal(bounds.left, 940);
    assert.equal(bounds.right, 1420);
  });

  it('P0-4 回归：同一 subpane 存在多个子智能体/BTW Tab 时，始终优先绑定当前可见 Tab 与其 composer，避免锁死首个隐藏 Tab', () => {
    const mainUuid = 'aaaaaaaa-1111-4111-8111-111111111111';
    const sub1Uuid = 'bbbbbbbb-2222-4222-8222-222222222222';
    const sub2Uuid = 'cccccccc-3333-4333-8333-333333333333';
    const btwUuid = 'dddddddd-4444-4444-8444-444444444444';
    const { doc, win } = createFakeDomEnv(`/c/${mainUuid}`, '');

    const main = createMainPane(doc, { convId: mainUuid });
    doc.body.appendChild(main.view);

    const subpane = new FakeElement('div', doc);
    subpane.setAttribute('data-media-drop-scope', 'subpane');
    subpane._rect = { left: 920, top: 48, width: 500, height: 820, right: 1420, bottom: 868 };

    // Tab 1 (隐藏的子智能体 Tab，位于 DOM 最前)
    const tab1 = new FakeElement('div', doc);
    tab1.setAttribute('data-testid', 'subagent-tab-conversation');
    tab1.setAttribute('data-cascade-id', sub1Uuid);
    tab1.setAttribute('hidden', '');
    const tab1Input = new FakeElement('div', doc);
    tab1Input.setAttribute('data-testid', 'agent-input-box');
    const tab1Composer = new FakeElement('div', doc);
    tab1Composer.className = 'surface-composer';
    tab1Input.appendChild(tab1Composer);
    tab1.appendChild(tab1Input);

    // Tab 2 (当前可见的子智能体 Tab，位于 DOM 较后位置)
    const tab2 = new FakeElement('div', doc);
    tab2.setAttribute('data-testid', 'subagent-tab-conversation');
    tab2.setAttribute('data-cascade-id', sub2Uuid);
    const tab2Input = new FakeElement('div', doc);
    tab2Input.setAttribute('data-testid', 'agent-input-box');
    const tab2Composer = new FakeElement('div', doc);
    tab2Composer.className = 'surface-composer';
    tab2Input.appendChild(tab2Composer);
    tab2.appendChild(tab2Input);

    // Tab 3 (隐藏的 BTW Tab)
    const tabBtw = new FakeElement('div', doc);
    tabBtw.setAttribute('data-testid', 'side-question-tab-conversation');
    tabBtw.setAttribute('data-cascade-id', btwUuid);
    tabBtw.setAttribute('hidden', '');
    const btwInput = new FakeElement('div', doc);
    btwInput.setAttribute('data-testid', 'agent-input-box');
    const btwComposer = new FakeElement('div', doc);
    btwComposer.className = 'surface-composer';
    btwInput.appendChild(btwComposer);
    tabBtw.appendChild(btwInput);

    subpane.appendChild(tab1);
    subpane.appendChild(tab2);
    subpane.appendChild(tabBtw);
    doc.body.appendChild(subpane);

    const mgr = new AntigravityHudManager({});
    withFakeDom(doc, win, () => {
      mgr.reconcileMounts();
      const subInst = [...mgr.instances.values()].find((i) => i.isSubpane);
      assert.ok(subInst, '应挂载子分栏 HUD 实例');
      assert.equal(subInst.getCurrentConvId(), sub2Uuid, '应绑定到当前可见的 Tab 2 而非首个隐藏 Tab 1');
      assert.equal(subInst.paneKind, 'subagent');
      assert.equal(subInst.targetComposer, tab2Composer, 'HUD 必须挂载在可见 Tab 2 的 composer 下');
      assert.equal(mgr.resolveConversationId(subpane, null, 2, true), sub2Uuid);
      assert.equal(mgr.inferPaneContext(subpane).paneKind, 'subagent');

      // 切换为 BTW Tab 可见、Tab 2 隐藏
      tab2.setAttribute('hidden', '');
      tabBtw.removeAttribute('hidden');
      mgr.reconcileMounts();
      assert.equal(subInst.getCurrentConvId(), btwUuid, '切到 BTW Tab 后应即时切换会话 ID');
      assert.equal(subInst.paneKind, 'btw');
      assert.equal(subInst.targetComposer, btwComposer, '切到 BTW Tab 后 HUD 应迁移到 BTW composer 下');
      assert.equal(mgr.inferPaneContext(subpane).paneKind, 'btw');

      // 切换为 Tab 1 可见、BTW 隐藏
      tabBtw.setAttribute('hidden', '');
      tab1.removeAttribute('hidden');
      mgr.reconcileMounts();
      assert.equal(subInst.getCurrentConvId(), sub1Uuid, '切回 Tab 1 后应正确切换回 sub-1');
      assert.equal(subInst.paneKind, 'subagent');
      assert.equal(subInst.targetComposer, tab1Composer);
    });

    mgr.dispose();
  });

  it('P1-4 回归：MutationObserver 普通正文流式 childList 合并至 140ms 节流，结构/按钮节点保持 20ms 紧急响应', () => {
    const observers = [];
    const scheduledDelays = [];
    const OrigMO = globalThis.MutationObserver;
    const origSetTimeout = globalThis.setTimeout;
    const origClearTimeout = globalThis.clearTimeout;

    const { doc, win } = createFakeDomEnv('/c/11111111-1111-4111-8111-111111111111', '');
    const main = createMainPane(doc, { convId: '11111111-1111-4111-8111-111111111111' });
    const markdownBody = new FakeElement('div', doc);
    markdownBody.className = 'prose';
    main.view.appendChild(markdownBody);
    doc.body.appendChild(main.view);

    globalThis.MutationObserver = class {
      constructor(cb) {
        this.cb = cb;
        this.targets = [];
        observers.push(this);
      }
      observe(target, opts) {
        this.targets.push({ target, opts });
      }
      disconnect() {}
    };
    globalThis.setTimeout = (fn, ms) => {
      scheduledDelays.push(ms);
      return { fn, ms };
    };
    globalThis.clearTimeout = () => {};

    const mgr = new AntigravityHudManager({});
    try {
      withFakeDom(doc, win, () => {
        mgr.start();
        const bodyObs = observers.find((o) =>
          o.targets.some((t) => t.target === doc.body && t.opts?.subtree === true)
        );
        assert.ok(bodyObs, '应创建 document.body subtree MutationObserver');

        // 1. 普通正文 Markdown 流式节点插入 -> 140ms 非紧急节流
        const streamSpan = new FakeElement('span', doc);
        streamSpan.textContent = 'token chunk';
        scheduledDelays.length = 0;
        mgr.reconcileTimer = null;
        bodyObs.cb([{ type: 'childList', target: markdownBody, addedNodes: [streamSpan], removedNodes: [] }]);
        assert.equal(scheduledDelays[0], 140, '普通正文流式 childList 应走 140ms 合并节流');

        // 2. 插入按钮/状态结构节点 -> 20ms 紧急响应
        const cancelBtn = new FakeElement('button', doc);
        cancelBtn.setAttribute('data-testid', 'input-cancel-button');
        scheduledDelays.length = 0;
        mgr.reconcileTimer = null;
        bodyObs.cb([{ type: 'childList', target: markdownBody, addedNodes: [cancelBtn], removedNodes: [] }]);
        assert.equal(scheduledDelays[0], 20, '按钮/状态结构 childList 应保持 20ms 紧急响应');
      });
    } finally {
      mgr.dispose();
      globalThis.MutationObserver = OrigMO;
      globalThis.setTimeout = origSetTimeout;
      globalThis.clearTimeout = origClearTimeout;
    }
  });

  it('P1-6 回归：单主栏与子分栏/BTW 共存时，主分栏模型全局回退跳过子分栏 DOM，杜绝串取子分栏模型与窗口容量', () => {
    const mainUuid = '11111111-1111-4111-8111-111111111111';
    const btwUuid = '22222222-2222-4222-8222-222222222222';
    const { doc, win } = createFakeDomEnv(`/c/${mainUuid}`, '');

    // 构造主分栏（暂时缺少局部模型选择器）+ 右侧 BTW 分栏（自带模型选择器与容量）
    const mainView = new FakeElement('div', doc);
    mainView.setAttribute('data-testid', 'conversation-view');
    mainView.setAttribute('data-cascade-id', mainUuid);
    const mainInput = new FakeElement('div', doc);
    mainInput.setAttribute('data-testid', 'agent-input-box');
    const mainComposer = new FakeElement('div', doc);
    mainComposer.className = 'surface-composer';
    mainInput.appendChild(mainComposer);
    mainView.appendChild(mainInput);
    doc.body.appendChild(mainView);

    const btw = createBtwSidePane(doc, { convId: btwUuid, modelId: 'gemini-3.8-flash', capacity: 1000000 });
    doc.body.appendChild(btw.wrapper);

    const mgr = new AntigravityHudManager({});
    withFakeDom(doc, win, () => {
      assert.equal(mgr.resolveActiveModel(mainView, 1), '', '主分栏无局部模型按钮时不得串取 BTW 子分栏模型');
      assert.equal(mgr.resolveActiveModelCapacity(mainView, 1), undefined, '主分栏不得串取 BTW 子分栏窗口容量');
      assert.equal(mgr.resolveActiveModel(btw.subpane, 2), 'gemini-3.8-flash', 'BTW 子分栏自身模型读取不受影响');
      assert.equal(mgr.resolveActiveModelCapacity(btw.subpane, 2), 1000000);
    });
    mgr.dispose();
  });

  it('P2-1 回归：主分栏内嵌子智能体卡片的 spinner/shimmer 不误把前台纯文本生成拉偏为 executing，前台工具仍保持 executing', () => {
    const mainUuid = '11111111-1111-4111-8111-111111111111';
    const { doc, win } = createFakeDomEnv(`/c/${mainUuid}`, '');
    const main = createMainPane(doc, { convId: mainUuid });
    doc.body.appendChild(main.view);

    // 主会话前台处于流式生成（存在 input-cancel-button）
    const cancelBtn = new FakeElement('button', doc);
    cancelBtn.setAttribute('data-testid', 'input-cancel-button');
    main.composer.appendChild(cancelBtn);

    // 1. 内嵌子智能体卡片（data-testid*="subagent-card" 与 aria-label^="Open Subagent:"）自带 spinner 与 shimmer
    const subCard1 = new FakeElement('div', doc);
    subCard1.setAttribute('data-testid', 'subagent-card');
    const subSpinner1 = new FakeElement('span', doc);
    subSpinner1.setAttribute('data-testid', 'status-loading-spinner');
    const subShimmer1 = new FakeElement('span', doc);
    subShimmer1.className = 'animate-shimmer-text';
    subShimmer1.textContent = 'Running shell command';
    subCard1.appendChild(subSpinner1);
    subCard1.appendChild(subShimmer1);
    main.view.appendChild(subCard1);

    const subCard2 = new FakeElement('div', doc);
    subCard2.setAttribute('aria-label', 'Open Subagent: worker-1');
    const subSpinner2 = new FakeElement('span', doc);
    subSpinner2.setAttribute('data-testid', 'status-loading-spinner');
    subCard2.appendChild(subSpinner2);
    main.view.appendChild(subCard2);

    const mgr = new AntigravityHudManager({});
    withFakeDom(doc, win, () => {
      assert.equal(
        mgr.resolveActivityPhase(main.view, { isSubpane: false, paneKind: 'main' }),
        'generating',
        '内嵌子智能体卡片内的 spinner/shimmer 不得把主会话前台生成误判为 executing'
      );

      // 2. 主会话前台普通工具卡片存在 spinner 时，仍应准确识别为 executing
      const toolCard = new FakeElement('div', doc);
      toolCard.setAttribute('data-testid', 'tool-call');
      const toolSpinner = new FakeElement('span', doc);
      toolSpinner.setAttribute('data-testid', 'status-loading-spinner');
      toolCard.appendChild(toolSpinner);
      main.view.appendChild(toolCard);

      assert.equal(
        mgr.resolveActivityPhase(main.view, { isSubpane: false, paneKind: 'main' }),
        'executing',
        '主会话前台普通工具卡片的 spinner 仍应识别为 executing'
      );
    });
    mgr.dispose();
  });
});
