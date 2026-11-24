import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CdpHudBridge,
  ConversationMetricsEngine,
  buildConversationHudMetrics,
} from '../dist/hud.js';
import { runHudDbScanInWorker } from '../dist/sqlite-read.js';
import { Controller } from '../dist/controller.js';
import { dictionaryFromEntries } from '../dist/dictionary.js';
import { HudInstance } from '../runtime/hud-instance.js';
import { AntigravityHudManager } from '../runtime/hud-manager.js';
import { HUD_STYLES_CSS } from '../runtime/hud-styles.js';

const { DatabaseSync } = await import('node:sqlite');

function varint(value) {
  let remaining = BigInt(value);
  const bytes = [];
  do {
    const byte = Number(remaining & 127n);
    remaining >>= 7n;
    bytes.push(byte | (remaining ? 128 : 0));
  } while (remaining);
  return bytes;
}

const scalar = (field, value) => [...varint(field * 8), ...varint(value)];
const message = (field, bytes) => [...varint(field * 8 + 2), ...varint(bytes.length), ...bytes];
const string = (field, value) => message(field, Buffer.from(value));

function seconds(field, value) {
  const whole = Math.floor(value);
  return message(field, [...scalar(1, whole), ...scalar(2, Math.round((value - whole) * 1e9))]);
}

function usageBytes(value) {
  return [
    ...scalar(2, value.rawInputTokens),
    ...scalar(3, value.outputTokens),
    ...scalar(4, value.cacheWriteTokens ?? 0),
    ...scalar(5, value.cachedReadTokens),
    ...scalar(9, value.reasoningTokens ?? 0),
    ...scalar(10, value.candidateTokens ?? value.outputTokens),
  ];
}

function generationBlob({
  indices,
  execution,
  responseModel,
  modelDisplayName,
  modelEnum,
  maxContextTokens = 200_000,
  rawInputTokens,
  cachedReadTokens,
  outputTokens,
  ttft = 1,
  streaming = 4,
}) {
  return Buffer.from([
    ...message(1, [
      ...scalar(3, modelEnum),
      ...message(4, usageBytes({ rawInputTokens, cachedReadTokens, outputTokens })),
      ...message(9, message(10, [
        ...scalar(1, rawInputTokens + cachedReadTokens),
        ...scalar(4, maxContextTokens),
      ])),
      ...seconds(11, ttft),
      ...seconds(12, streaming),
      ...string(19, responseModel),
      ...string(21, modelDisplayName),
    ]),
    ...message(2, indices.flatMap(varint)),
    ...string(4, execution),
  ]);
}

const openDbsByTest = new WeakMap();
function trackDb(t, db) {
  let list = openDbsByTest.get(t);
  if (!list) { list = []; openDbsByTest.set(t, list); }
  list.push(db);
  return db;
}
function closeTrackedDbs(t) {
  const list = openDbsByTest.get(t);
  if (!list) return;
  for (const db of list.splice(0)) { try { db.close(); } catch {} }
}

function createWalDb(t, dir, id, parentId) {
  const dbPath = path.join(dir, `${id}.db`);
  const db = trackDb(t, new DatabaseSync(dbPath));
  t.after(() => {
    try {
      db.close();
    } catch {}
  });
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE steps (
      idx INTEGER PRIMARY KEY,
      step_type INTEGER NOT NULL,
      status INTEGER NOT NULL,
      metadata BLOB,
      render_info BLOB,
      step_payload BLOB
    );
    CREATE TABLE gen_metadata (
      idx INTEGER PRIMARY KEY,
      data BLOB,
      size INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE trajectory_meta (
      trajectory_id TEXT PRIMARY KEY,
      cascade_id TEXT,
      trajectory_type INTEGER
    );
    CREATE TABLE trajectory_metadata_blob (
      id TEXT PRIMARY KEY,
      data BLOB
    );
  `);
  db.prepare('INSERT INTO trajectory_meta VALUES (?, ?, ?)').run(id, id, 0);
  if (parentId) {
    const parentBlob = Buffer.from([...string(5, parentId), ...string(6, parentId)]);
    db.prepare('INSERT INTO trajectory_metadata_blob VALUES (?, ?)').run('main', parentBlob);
  }
  return { db, dbPath };
}

function bumpDbMtime(dbPath, deltaMs) {
  for (const suffix of ['', '-wal', '-shm']) {
    const target = `${dbPath}${suffix}`;
    if (fs.existsSync(target)) {
      const st = fs.statSync(target);
      const nextSec = (st.mtimeMs + deltaMs) / 1000;
      fs.utimesSync(target, nextSec, nextSec);
    }
  }
}

class FakeElement {
  constructor(tagName = 'div', ownerDoc = null) {
    this.tagName = tagName.toUpperCase();
    this.nodeType = 1;
    this.ownerDocument = ownerDoc;
    this.attributes = new Map();
    this.style = { cssText: '' };
    this.children = [];
    this.parentNode = null;
    this.shadowRoot = null;
    this.listeners = new Map();
    this.classList = {
      _set: new Set(),
      add: (...tokens) => tokens.forEach((tok) => this.classList._set.add(tok)),
      remove: (...tokens) => tokens.forEach((tok) => this.classList._set.delete(tok)),
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
      .forEach((tok) => this.classList._set.add(tok));
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
  attachShadow() {
    const sr = new FakeShadowRoot(this);
    this.shadowRoot = sr;
    return sr;
  }
  insertAdjacentElement(pos, el) {
    if (pos === 'afterend' && this.parentNode) {
      const idx = this.parentNode.children.indexOf(this);
      if (idx !== -1) {
        this.parentNode.children.splice(idx + 1, 0, el);
        el.parentNode = this.parentNode;
      }
    }
  }
  appendChild(el) {
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
    if (opts?.signal) opts.signal.addEventListener('abort', () => set.delete(fn));
  }
  removeEventListener(type, fn) {
    this.listeners.get(type)?.delete(fn);
  }
  dispatchEvent(evt) {
    const set = this.listeners.get(evt.type);
    if (set) for (const fn of [...set]) fn(evt);
    return true;
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
    if (p === 'button') return this.tagName === 'BUTTON';
    if (p === '.surface-composer') return this.classList.contains('surface-composer');
    if (p === '.animate-shimmer-text') return this.classList.contains('animate-shimmer-text');
    if (p === '[data-agent-state-dot]') return this.hasAttribute('data-agent-state-dot');
    if (p === '[data-subagent-id]') return this.hasAttribute('data-subagent-id');
    if (p === '[data-select-popup]') return this.hasAttribute('data-select-popup');
    const exactAttr = p.match(/^\[([a-zA-Z0-9_-]+)="([^"]+)"\]$/);
    if (exactAttr) return this.getAttribute(exactAttr[1]) === exactAttr[2];
    const prefAttr = p.match(/^\[([a-zA-Z0-9_-]+)\^="([^"]+)"\]$/);
    if (prefAttr) return (this.getAttribute(prefAttr[1]) || '').startsWith(prefAttr[2]);
    const subAttr = p.match(/^\[([a-zA-Z0-9_-]+)\*="([^"]+)"(?:\s+i)?\]$/);
    if (subAttr) {
      const val = (this.getAttribute(subAttr[1]) || '').toLowerCase();
      return val.includes(subAttr[2].toLowerCase());
    }
    return false;
  }
  matches(sel) {
    return String(sel)
      .split(',')
      .some((part) => this.matchesSingle(part));
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
        if (child.matches(sel)) out.push(child);
        visit(child);
      }
    };
    visit(this);
    return out;
  }
}

class FakeShadowRoot {
  constructor(host) {
    this.host = host;
    this._innerHTML = '';
    this.elementsBySel = new Map();
    this.capsules = [];
    this.popovers = [];
    this.container = new FakeElement('div');
    this.container.className = 'hud-container';
  }
  get innerHTML() {
    return this._innerHTML;
  }
  set innerHTML(html) {
    this._innerHTML = String(html ?? '');
    this.elementsBySel.clear();
    this.capsules = [];
    this.popovers = [];
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

test('P0-01: 增量前缀复用克隆原始步骤，gen_metadata 原地刷新已入前缀的模型步时准确更新用量且不锁死或双计', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-hud-p001-'));
  t.after(() => { closeTrackedDbs(t); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });

  const convId = '11111111-1111-4111-8111-111111111111';
  const { db, dbPath } = createWalDb(t, dir, convId);
  const engine = new ConversationMetricsEngine({ conversationsDir: dir });

  db.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (0, 14, 3, ?)').run(
    Buffer.from(seconds(1, 1000))
  );
  // idx=1 无内联 usage，完全依赖第 2 遍从 gen_metadata 回填 hasUsage 与 Token
  db.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (1, 15, 3, ?)').run(
    Buffer.from([...seconds(1, 1001), ...seconds(7, 1005), ...string(12, 'exec-prefix-1')])
  );
  for (const idx of [2, 3, 4]) {
    db.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, 132, 3, ?)').run(
      idx,
      Buffer.from([...seconds(1, 1005 + idx), ...message(4, string(2, 'read_file')), ...seconds(8, 1006 + idx)])
    );
  }
  const gInitial = generationBlob({
    indices: [1],
    execution: 'exec-prefix-1',
    responseModel: 'claude-sonnet-4-6',
    modelDisplayName: 'Claude Sonnet 4.6',
    modelEnum: 101,
    rawInputTokens: 1000,
    cachedReadTokens: 5000,
    outputTokens: 100,
  });
  db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (0, ?, ?)').run(gInitial, gInitial.length);

  const m1 = await engine.getConversationMetrics({ conversationId: convId });
  assert.equal(m1.tokens.totalTokens, 6100);
  assert.equal(m1.context.usedTokens, 6000);

  // 原地刷新 gen_metadata idx=0 的用量，并追加新工具步触发 stepsMode='append'（idx=1 已在静态前缀中）
  const gRefreshed = generationBlob({
    indices: [1],
    execution: 'exec-prefix-1',
    responseModel: 'claude-sonnet-4-6',
    modelDisplayName: 'Claude Sonnet 4.6',
    modelEnum: 101,
    rawInputTokens: 1500,
    cachedReadTokens: 8500,
    outputTokens: 300,
  });
  db.prepare('UPDATE gen_metadata SET data = ?, size = ? WHERE idx = 0').run(gRefreshed, gRefreshed.length);
  db.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (5, 132, 3, ?)').run(
    Buffer.from([...seconds(1, 1020), ...message(4, string(2, 'read_file')), ...seconds(8, 1021)])
  );
  bumpDbMtime(dbPath, 5000);

  const m2 = await engine.getConversationMetrics({ conversationId: convId });
  assert.equal(m2.session.steps, 6);
  assert.equal(m2.tokens.totalTokens, 10_300);
  assert.equal(m2.context.usedTokens, 10_000);
});

test('P2-01: 超大步骤被增量前缀吸收的同时，首尾边缘字节变更会触发前缀失效并回退全量重扫', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-hud-p201-'));
  t.after(() => { closeTrackedDbs(t); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });

  const convId = '22222222-2222-4222-8222-222222222222';
  const { db, dbPath } = createWalDb(t, dir, convId);

  const buildOversizedBlob = (endSec) =>
    Buffer.from([
      ...seconds(1, 1001),
      ...message(4, [...string(2, 'write_file'), ...string(3, 'Z'.repeat(70_000))]),
      ...seconds(8, endSec),
    ]);

  db.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (0, 14, 3, ?)').run(
    Buffer.from(seconds(1, 1000))
  );
  const blob1 = buildOversizedBlob(1010);
  db.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (1, 132, 3, ?)').run(blob1);
  for (const idx of [2, 3, 4]) {
    db.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, 132, 3, ?)').run(
      idx,
      Buffer.from([...seconds(1, 1010 + idx), ...seconds(8, 1011 + idx)])
    );
  }

  const scan1 = await runHudDbScanInWorker({ dbPath, inlineBlobLimitBytes: 65_536 });
  assert.equal(scan1.stepPrefixCutoffIdx, 3);

  // 原地改写 idx=1 尾部完成时间戳（保持相同字节长度与 status=3）
  const blob2 = buildOversizedBlob(1019);
  assert.equal(blob1.length, blob2.length);
  db.prepare('UPDATE steps SET metadata = ? WHERE idx = 1').run(blob2);
  db.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (5, 132, 3, ?)').run(
    Buffer.from([...seconds(1, 1030), ...seconds(8, 1031)])
  );

  const scan2 = await runHudDbScanInWorker({
    dbPath,
    inlineBlobLimitBytes: 65_536,
    prevStepPrefixCutoffIdx: scan1.stepPrefixCutoffIdx,
    prevStepPrefixDigest: scan1.stepPrefixDigest,
  });
  assert.equal(scan2.stepsMode, 'full', '超大步骤尾部字节变更必须使前缀摘要失效并触发 full 重扫');
});

test('P1-03: 新轮 step_type=14 时间戳为 null 且首步未落盘时，不得把上一轮晚结束的已完结子代理步骤吸纳进新轮', () => {
  const parentSteps = [
    { idx: 0, stepType: 14, status: 3, createdAtSeconds: 1000, completedAtSeconds: 1000, hasUsage: false },
    {
      idx: 1,
      stepType: 132,
      status: 3,
      createdAtSeconds: 1001,
      completedAtSeconds: 1015,
      hasUsage: false,
      isSubagentStep: true,
      toolCallName: 'invoke_subagent',
    },
    { idx: 2, stepType: 15, status: 3, createdAtSeconds: 1016, completedAtSeconds: 1020, hasUsage: false },
    { idx: 3, stepType: 2, status: 3, createdAtSeconds: 1020, completedAtSeconds: 1020, hasUsage: false },
    // 第 2 轮刚写入 USER_INPUT，实机常见时间戳全为 null
    { idx: 4, stepType: 14, status: 3, createdAtSeconds: null, completedAtSeconds: null, hasUsage: false },
  ];
  // 上一轮子智能体的收尾步骤在 1025s 才完结（晚于主轮末步 1020s）
  const childSteps = [
    { idx: 0, stepType: 15, status: 3, createdAtSeconds: 1018, completedAtSeconds: 1025, hasUsage: false },
  ];
  const allSteps = [...parentSteps, ...childSteps];

  const metrics = buildConversationHudMetrics({
    conversationId: 'conv-p103',
    observedAt: 1_100_000,
    isStreaming: true,
    activityPhase: 'generating',
    isSubagentRunning: false,
    steps: allSteps,
    contextSteps: parentSteps,
    subagentCount: 1,
    subagentSteps: 1,
  });

  assert.equal(metrics.session.turns, 2);
  assert.equal(metrics.session.awaitingFirstTurnStep, true);
  assert.equal(metrics.session.currentTurnDurationSeconds, 0);
});

test('P2-05: CdpHudBridge 保留跨消息 autoHealAttempts 上限，隔离 ready 流式包 observedAt 抖动并感知 inFlight 锚点跃迁', async () => {
  const sent = [];
  let availability = 'partial';
  let observedAt = 1_700_000_000_000;
  let turnDuration = undefined;

  const bridge = new CdpHudBridge({
    pollIntervalMs: 0,
    engine: {
      getConversationMetrics: async (options) => {
        const m = buildConversationHudMetrics({ ...options, observedAt, steps: [] });
        m.availability = availability;
        m.isStreaming = availability === 'ready';
        m.session.activeModelStepCount = availability === 'ready' ? 1 : 0;
        m.session.currentTurnDurationSeconds = turnDuration;
        return m;
      },
      clearCache() {},
    },
  });

  await bridge.attachToTarget(
    't-heal',
    {
      send: async () => ({}),
      evaluate: async (expr) => {
        sent.push(expr);
        return true;
      },
    },
    () => 1
  );

  for (let i = 0; i < 7; i++) {
    observedAt += 100;
    bridge.handleRawBindingPayload(
      't-heal',
      JSON.stringify({
        type: 'REQUEST_REFRESH',
        cascadeId: 'pane-1',
        paneSlotId: 'left',
        conversationId: 'conv-heal',
        sessionRevision: 1,
        isStreaming: false,
        activityPhase: 'idle',
        timestamp: Date.now() + i,
      })
    );
    await new Promise((r) => setImmediate(r));
  }
  const paneAfterPartial = bridge.getActivePanes().find((p) => p.paneSlotId === 'left');
  assert.equal(paneAfterPartial.autoHealAttempts, 5, '跨 REQUEST_REFRESH 消息必须保留 autoHealAttempts 并封顶在 5');

  // 切入 ready 流式态（turnDuration 尚未锚定）：清零 autoHealAttempts 并推送
  availability = 'ready';
  turnDuration = undefined;
  await bridge.pollActiveSessions(true);
  assert.equal(bridge.getActivePanes().find((p) => p.paneSlotId === 'left').autoHealAttempts, 0);
  const countBeforeAnchor = sent.length;

  // undefined -> number 锚点跃迁必须突破流式挂钟抑制并立即推送
  turnDuration = 0.4;
  await bridge.pollActiveSessions(true);
  const countAfterAnchor = sent.length;
  assert.equal(countAfterAnchor, countBeforeAnchor + 1);

  // 仅 observedAt 与流式挂钟秒数递增时，指纹必须幂等拦截冗余推送
  observedAt += 5000;
  turnDuration = 2.9;
  await bridge.pollActiveSessions(true);
  assert.equal(sent.length, countAfterAnchor);

  bridge.dispose();
});

test('P2-06: 混合子代理历史冷启动仍执行一次性反向嗅探，且父会话空闲时子代理 12s 保活立即释放', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-hud-p206-'));
  t.after(() => { closeTrackedDbs(t); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });

  const mainId = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
  const explicitChildId = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
  const implicitChildId = 'cccccccc-3333-4333-8333-cccccccccccc';

  const { db: mainDb } = createWalDb(t, dir, mainId);
  const { db: childADb } = createWalDb(t, dir, explicitChildId, mainId);
  const { db: childBDb, dbPath: childBPath } = createWalDb(t, dir, implicitChildId, mainId);

  mainDb.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (0, 14, 3, ?)').run(
    Buffer.from(seconds(1, 1000))
  );
  // 主库仅显式记录了 explicitChildId，implicitChildId 仅靠子库 trajectory_metadata_blob 反向关联
  mainDb.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (1, 132, 3, ?)').run(
    Buffer.from([
      ...seconds(1, 1001),
      ...message(4, [...string(2, 'invoke_subagent'), ...string(3, JSON.stringify({ id: explicitChildId }))]),
      ...seconds(8, 1010),
    ])
  );
  childADb.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (0, 15, 3, ?)').run(
    Buffer.from([...seconds(1, 1002), ...seconds(7, 1005), ...message(9, usageBytes({ rawInputTokens: 500, cachedReadTokens: 0, outputTokens: 50 }))])
  );
  childBDb.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (0, 15, 1, ?)').run(
    Buffer.from([...seconds(1, 1003), ...message(9, usageBytes({ rawInputTokens: 700, cachedReadTokens: 0, outputTokens: 70 }))])
  );

  const engine = new ConversationMetricsEngine({ conversationsDir: dir });
  // 冷启动（isSubagentRunning=false）读取混合历史会话：两个子库均须被发现
  const cold = await engine.getConversationMetrics({
    conversationId: mainId,
    isSubagentRunning: false,
    observedAt: 1_005_000,
  });
  assert.equal(cold.session.subagentCount, 2);
  assert.equal(cold.isSubagentRunning, true);

  // 子库 B 完结为 status=3，且父会话 isSubagentRunning=false、无活跃子代理步时，不得残留 12s 假运行态
  childBDb.prepare('UPDATE steps SET status = 3, metadata = ? WHERE idx = 0').run(
    Buffer.from([...seconds(1, 1003), ...seconds(7, 1008), ...message(9, usageBytes({ rawInputTokens: 700, cachedReadTokens: 0, outputTokens: 70 }))])
  );
  bumpDbMtime(childBPath, 5000);

  const settled = await engine.getConversationMetrics({
    conversationId: mainId,
    isSubagentRunning: false,
    observedAt: 1_009_000,
  });
  assert.equal(settled.isSubagentRunning, false);
});

test('P2-07: >3 模型切换回早期模型时保留活跃阶段槽位，且空闲态切换选择器模型不改写历史步骤估算费用', () => {
  const models = [
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', enumVal: 201 },
    { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', enumVal: 202 },
    { id: 'gemini-3-1-pro', name: 'Gemini 3.1 Pro', enumVal: 203 },
    { id: 'gpt-5-4', name: 'GPT-5.4', enumVal: 204 },
  ];
  const steps = [];
  models.forEach((m, i) => {
    steps.push({
      idx: i * 2,
      stepType: 14,
      status: 3,
      createdAtSeconds: 1000 + i * 20,
      completedAtSeconds: 1000 + i * 20,
      hasUsage: false,
    });
    steps.push({
      idx: i * 2 + 1,
      stepType: 15,
      status: 3,
      createdAtSeconds: 1001 + i * 20,
      completedAtSeconds: 1005 + i * 20,
      hasUsage: true,
      rawInputTokens: 2000 + i * 500,
      cachedReadTokens: 10_000,
      outputTokens: 200,
      generation: {
        genIdx: i,
        stepIndices: [i * 2 + 1],
        responseModel: m.id,
        modelDisplayName: m.name,
        modelEnum: m.enumVal,
        ttftSeconds: 1,
        streamingDurationSeconds: 4,
      },
    });
  });

  // 用户在选择器切回最早用过的 Claude Sonnet 4.6（非 Orchestrator 保留 1 激活 + 最多 3 历史 = 4 项，pinnedInput 保证切回早期模型仍在列）
  const switchedBack = buildConversationHudMetrics({
    conversationId: 'conv-p207-stages',
    modelId: 'claude-sonnet-4-6',
    steps,
    contextSteps: steps,
  });
  assert.equal(switchedBack.context.modelStages.length, 4);
  assert.equal(
    switchedBack.context.modelStages.some((st) => st.modelId.includes('sonnet') && st.usedTokens === 12_000),
    true,
    '切回早期已发言模型时不得被裁掉历史阶段槽位'
  );

  // 第 5 个未发言模型 + 流式期（新步未落盘）切换选择器：已完结末步不得随选择器重算改价
  const fifthPicker = buildConversationHudMetrics({
    conversationId: 'conv-p207-stages',
    modelId: 'claude-opus-4-6',
    isStreaming: true,
    steps: [
      ...steps,
      {
        idx: 8,
        stepType: 15,
        status: 3,
        createdAtSeconds: 1100,
        completedAtSeconds: 1105,
        hasUsage: true,
        rawInputTokens: 30_000,
        cachedReadTokens: 0,
        outputTokens: 1_000,
      },
    ],
  });
  const fifthPickerBaseline = buildConversationHudMetrics({
    conversationId: 'conv-p207-stages',
    modelId: 'gpt-5-4',
    isStreaming: false,
    steps: [
      ...steps,
      {
        idx: 8,
        stepType: 15,
        status: 3,
        createdAtSeconds: 1100,
        completedAtSeconds: 1105,
        hasUsage: true,
        rawInputTokens: 30_000,
        cachedReadTokens: 0,
        outputTokens: 1_000,
      },
    ],
  });
  assert.equal(fifthPicker.tokens.estimatedCostUsd, fifthPickerBaseline.tokens.estimatedCostUsd);

  // 费用稳定性：第 1 步缺失 generation，第 2 步为 Sonnet；idle 态把选择器切为昂贵模型不得篡改历史费用
  const costSteps = [
    { idx: 0, stepType: 14, status: 3, createdAtSeconds: 1000, completedAtSeconds: 1000, hasUsage: false },
    {
      idx: 1,
      stepType: 15,
      status: 3,
      createdAtSeconds: 1001,
      completedAtSeconds: 1004,
      hasUsage: true,
      rawInputTokens: 50_000,
      cachedReadTokens: 0,
      outputTokens: 5_000,
    },
    {
      idx: 2,
      stepType: 15,
      status: 3,
      createdAtSeconds: 1005,
      completedAtSeconds: 1009,
      hasUsage: true,
      rawInputTokens: 10_000,
      cachedReadTokens: 0,
      outputTokens: 1_000,
      generation: {
        genIdx: 0,
        stepIndices: [2],
        responseModel: 'claude-sonnet-4-6',
        modelDisplayName: 'Claude Sonnet 4.6',
      },
    },
  ];
  const mSonnetPicker = buildConversationHudMetrics({
    conversationId: 'conv-p207-cost',
    modelId: 'claude-sonnet-4-6',
    steps: costSteps,
    contextSteps: costSteps,
  });
  const mOpusPicker = buildConversationHudMetrics({
    conversationId: 'conv-p207-cost',
    modelId: 'claude-opus-4-6',
    steps: costSteps,
    contextSteps: costSteps,
  });
  assert.equal(mOpusPicker.tokens.estimatedCostUsd, mSonnetPicker.tokens.estimatedCostUsd);
});

test('P1-05: Controller.pause 就地切换 HUD-only 不断开 CDP，且 queueBootstrap 保留快捷键切换后的英文模式', async () => {
  const engineSrc = fs.readFileSync(new URL('../runtime/engine.js', import.meta.url), 'utf8');
  const keepMatches = engineSrc.match(/if\s*\(\s*!opts\?\.keepHud\s*\)/g) || [];
  assert.equal(keepMatches.length >= 2, true, 'HUD-only 与完整引擎两个 dispose 分支均须支持 keepHud');

  const dict = dictionaryFromEntries({ Settings: '设置' });
  const fixtureOrigin = 'http://localhost:43210';
  const controller = new Controller({
    appPath: path.join(os.tmpdir(), 'gb-nonexistent.app'),
    profile: path.join(os.tmpdir(), 'gb-nonexistent-profile'),
    dictionary: dict,
    hudEnabled: true,
    locale: 'zh-Hans',
    configuredLanguage: 'zh-Hans',
    fixture: { origin: fixtureOrigin },
    onStatus: () => {},
  });

  const evaluated = [];
  let cdpClosed = false;
  const fakeSession = {
    targetId: 'target-p105',
    url: `${fixtureOrigin}/fixture`,
    contextId: 7,
    registration: 'reg-1',
    languageMode: 'en',
    detaching: false,
    updateChain: Promise.resolve(),
    cdp: {
      send: async (method) => {
        if (method === 'Page.getFrameTree') {
          return { frameTree: { frame: { id: 'main-frame', url: `${fixtureOrigin}/fixture` } } };
        }
        if (method === 'Page.addScriptToEvaluateOnNewDocument') {
          return { identifier: 'reg-2' };
        }
        return {};
      },
      evaluate: async (expr) => {
        evaluated.push(expr);
        if (expr === 'globalThis.__GRAVITYBOX_ENGINE_V1__?.state()') {
          return { active: true, version: dict.version, runtimeId: controller.runtimeId, languageMode: 'en' };
        }
        return true;
      },
      close: () => {
        cdpClosed = true;
      },
    },
  };

  try {
    controller.pages.set('target-p105', fakeSession);
    await controller.queueBootstrap(fakeSession);
    assert.equal(fakeSession.languageMode, 'en');
    assert.equal(
      evaluated.some((e) => e.includes('setLanguage?.("en")')),
      true,
      '快捷键处于英文态时 queueBootstrap 必须让 HUD 保持英文'
    );

    evaluated.length = 0;
    await controller.transitionActiveSessionsToHudOnly();
    assert.equal(cdpClosed, false, 'pause 切换到 HUD-only 时不得关闭现有页面 CDP 连接');
    assert.equal(controller.pages.has('target-p105'), true);
    assert.equal(
      evaluated.some((e) => e.includes('dispose?.({keepHud:true})')),
      true,
      '必须通过 dispose({keepHud:true}) 无闪烁保留 HUD 实例'
    );
  } finally {
    controller.pages.clear();
    await controller.stop();
  }
});

test('P1-01 & P1-02 & P2-02 & P2-03 & P2-08: HudInstance 高水位收敛、闲置后瞬时流式封顶、首轮 0->1 迁移、唤醒重扫时序与样式/单复数修复', async () => {
  assert.match(HUD_STYLES_CSS, /@container hud \(max-width:\s*259\.98px\)/);

  // 实测 dist/engine.js 合并产物（含 deep-scan.js 覆盖层）下 dispose({ keepHud: true }) 必须完整保留 HUD
  const engineBundleSrc = fs.readFileSync(new URL('../dist/engine.js', import.meta.url), 'utf8');
  let hudDisposeCalls = 0;
  const { runInNewContext } = await import('node:vm');
  const createEngineSandbox = () => {
    const mockDoc = new FakeElement('document');
    mockDoc.body = new FakeElement('body', mockDoc);
    mockDoc.documentElement = new FakeElement('html', mockDoc);
    mockDoc.getElementById = () => null;
    const loc = { origin: 'http://localhost', pathname: '/', search: '', hash: '', href: 'http://localhost/' };
    const win = {
      location: loc,
      addEventListener() {},
      removeEventListener() {},
      getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    };
    const sandbox = {
      window: win,
      location: loc,
      document: mockDoc,
      Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
      MutationObserver: class {
        observe() {}
        disconnect() {}
      },
      CSS: { escape: (s) => String(s) },
      URL,
      WeakRef,
      WeakMap,
      Map,
      Set,
      setTimeout: () => 1,
      clearTimeout: () => {},
      setInterval: () => 1,
      clearInterval: () => {},
      __GRAVITYBOX_HUD_V1__: {
        active: true,
        reconcileMounts() {},
        setLanguage() {},
        setEnabled() {},
        dispose() {
          hudDisposeCalls++;
        },
      },
      __GRAVITYBOX_BOOT__: { origin: 'http://localhost', active: false, dictionary: {} },
    };
    sandbox.globalThis = sandbox;
    return sandbox;
  };

  const sandbox1 = createEngineSandbox();
  runInNewContext(engineBundleSrc, sandbox1, { filename: 'dist-engine-keephud-test-1.js' });
  assert.equal(Boolean(sandbox1.__GRAVITYBOX_ENGINE_V1__), true);
  assert.equal(typeof sandbox1.__GRAVITYBOX_HUD_V1__.__hudBuildSig, 'string');
  assert.equal(hudDisposeCalls, 0, '同版本重注入启动时不应对活跃 HUD 触发 dispose');
  sandbox1.__GRAVITYBOX_ENGINE_V1__.dispose({ keepHud: true });
  assert.equal(hudDisposeCalls, 0, '合并 deep-scan.js 后的 engine.dispose({ keepHud: true }) 不得销毁 HUD');

  const sandbox2 = createEngineSandbox();
  runInNewContext(engineBundleSrc, sandbox2, { filename: 'dist-engine-keephud-test-2.js' });
  assert.equal(Boolean(sandbox2.__GRAVITYBOX_ENGINE_V1__), true);
  sandbox2.__GRAVITYBOX_ENGINE_V1__.dispose();
  assert.equal(hudDisposeCalls, 1, '未传 keepHud: true 时 dispose() 必须正常连带销毁 HUD');

  let resumeCalledBeforeTick = false;
  let resumeHook = null;
  const inst = new HudInstance('pane-audit', {
    languageMode: 'en',
    onVisibilityResume: () => {
      if (resumeHook) resumeHook();
    },
  });
  const doc = new FakeElement('document');
  doc.createElement = (tag) => new FakeElement(tag, doc);
  const wrapper = new FakeElement('div', doc);
  const composer = new FakeElement('div', doc);
  composer.setAttribute('data-testid', 'agent-input-box');
  wrapper.appendChild(composer);

  try {
    inst.mount(composer);
    inst.currentConvId = 'conv-audit';

    // P2-08b: 英文 1 step / 2 steps 单复数校验
    inst.updateMetrics({
      conversationId: 'conv-audit',
      availability: 'ready',
      isStreaming: false,
      activityPhase: 'idle',
      isSubagentRunning: false,
      session: {
        turns: 0,
        steps: 0,
        subagentCount: 1,
        subagentSteps: 1,
        currentTurnDurationSeconds: 0,
      },
      tokens: { totalTokens: 0 },
      context: { hasUsageData: false },
    });
    assert.equal(inst.shadow.querySelector('#val-subagent-status').textContent, '1 scheduled (1 step)');

    // P2-02: turns 0 -> 1 延迟落库期间高水位平滑迁移不丢失
    inst.turnHighWaterMark = { convId: 'conv-audit', turns: 0, seconds: 5.4 };
    inst.updateMetrics({
      conversationId: 'conv-audit',
      availability: 'ready',
      isStreaming: true,
      activityPhase: 'generating',
      session: {
        turns: 1,
        steps: 2,
        activeModelStepCount: 1,
        currentTurnDurationSeconds: 3.1,
      },
      tokens: { totalTokens: 100 },
      context: { hasUsageData: false },
    });
    assert.equal(inst.turnHighWaterMark.turns, 1);
    assert.equal(inst.turnHighWaterMark.seconds >= 5.4, true);

    // P1-01: 含真实子智能体高水位 (hasSubagent: true) 但当前无活跃子智能体时，收到权威 idle 包必须收敛回后端真实耗时
    inst.turnHighWaterMark = { turns: 2, seconds: 2688, hasSubagent: true };
    inst.updateMetrics({
      conversationId: 'conv-audit',
      availability: 'ready',
      isStreaming: false,
      activityPhase: 'idle',
      isSubagentRunning: false,
      session: {
        turns: 2,
        steps: 93,
        hasSubagentInTurn: true,
        activeSubagentStepCount: 0,
        subagentCount: 2,
        subagentSteps: 4,
        currentTurnDurationSeconds: 404.46,
      },
      tokens: { totalTokens: 50_000 },
      context: { hasUsageData: false },
    });
    assert.equal(inst.turnHighWaterMark, null, '历史子代理轮进入权威 idle 后必须释放高水位并收敛回真实耗时');
    assert.equal(inst.shadow.querySelector('#hud-txt-session .hud-turn-dur').textContent, '· Turn 6m');
    assert.equal(inst.shadow.querySelector('#val-subagent-status').textContent, '2 scheduled (4 steps)');

    // Turn 1 idle (20s) 后发起 Turn 2 且 SQLite 尚未落盘新 USER_INPUT（turns 仍为 2）：必须从 0s 起跳而非继承 404s
    inst.notifyModelOrStreamingChange(null, true, false, 0, null, 'generating');
    assert.equal(inst.turnClockAnchor?.baseSeconds < 1, true, '新轮未落盘起跳时不得继承上一轮已完结耗时');
    assert.equal(inst.shadow.querySelector('#hud-txt-session .hud-turn-dur').textContent, '· Turn 0s');
    inst.notifyModelOrStreamingChange(null, false, false, 0, null, 'idle');

    // P1-02: 闲置收敛在 404.46s (steps=93) 后，若 5 分钟后误触发瞬时 isStreaming=true 且无新步/活跃步，严禁跳变到 704s
    inst.notifyModelOrStreamingChange(null, true, false, 0, null, 'generating');
    inst.updateMetrics({
      conversationId: 'conv-audit',
      availability: 'ready',
      isStreaming: true,
      activityPhase: 'generating',
      isSubagentRunning: false,
      session: {
        turns: 2,
        steps: 93,
        activeModelStepCount: 0,
        activeToolStepCount: 0,
        currentTurnDurationSeconds: 704.46,
      },
      tokens: { totalTokens: 50_000 },
      context: { hasUsageData: false },
    });
    assert.equal(
      (inst.turnHighWaterMark?.seconds ?? 0) < 410,
      true,
      `闲置后无新步瞬时流式不得把 704s 写入高水位，实际=${inst.turnHighWaterMark?.seconds}`
    );
    inst.notifyModelOrStreamingChange(null, false, false, 0, null, 'idle');

    // P1-01 (turnAborted): 有非零权威耗时时收敛，0s 缺时间戳时保留高水位兜底
    inst.turnHighWaterMark = { turns: 3, seconds: 55, hasSubagent: false };
    inst.updateMetrics({
      conversationId: 'conv-audit',
      availability: 'ready',
      isStreaming: false,
      activityPhase: 'idle',
      session: {
        turns: 3,
        steps: 96,
        turnAborted: true,
        currentTurnDurationSeconds: 18,
      },
      tokens: { totalTokens: 52_000 },
      context: { hasUsageData: false },
    });
    assert.equal(inst.turnHighWaterMark, null);
    assert.equal(inst.shadow.querySelector('#hud-txt-session .hud-turn-dur').textContent, '· Turn 18s');

    inst.turnHighWaterMark = { turns: 4, seconds: 12, hasSubagent: false };
    inst.updateMetrics({
      conversationId: 'conv-audit',
      availability: 'ready',
      isStreaming: false,
      activityPhase: 'idle',
      session: {
        turns: 4,
        steps: 98,
        turnAborted: true,
        currentTurnDurationSeconds: 0,
      },
      tokens: { totalTokens: 52_000 },
      context: { hasUsageData: false },
    });
    assert.equal(inst.turnHighWaterMark?.seconds, 12);
    assert.equal(inst.shadow.querySelector('#hud-txt-session .hud-turn-dur').textContent, '· Turn 12s');

    // P2-03: visibilitychange 唤醒时先调用 onVisibilityResume 校准 idle，不抢跑旧 turnClockAnchor
    inst.turnClockAnchor = {
      baseSeconds: 10,
      anchorMs: Date.now() - 120_000,
    };
    resumeHook = () => {
      resumeCalledBeforeTick = true;
      inst.stopTurnClock();
    };
    const prevDoc = globalThis.document;
    try {
      const fakeDoc = new FakeElement('document');
      fakeDoc.hidden = false;
      fakeDoc.visibilityState = 'visible';
      globalThis.document = fakeDoc;
      inst.bindEvents();
      fakeDoc.dispatchEvent({ type: 'visibilitychange' });
      assert.equal(resumeCalledBeforeTick, true);
      assert.equal(inst.turnClockAnchor, null);
    } finally {
      globalThis.document = prevDoc;
    }
  } finally {
    inst.dispose();
  }
});

test('P1-04 & P2-04: AntigravityHudManager 隔离嵌套子分栏/工具卡/语音与菜单按钮误报、校验状态圆点值、清理定时器并隔离双主分栏子代理 ID', () => {
  const mgr = new AntigravityHudManager();
  try {
    // 1. P1-04: 主分栏内嵌套子分栏与工具卡片的 loading/shimmer 不得污染主分栏 activityPhase，缺 composer 时不扫整页裸 Stop/Cancel
    const mainView = new FakeElement('div');
    mainView.setAttribute('data-testid', 'conversation-view');

    const nestedSubpane = new FakeElement('div');
    nestedSubpane.setAttribute('data-testid', 'subagent-tab-conversation');
    const subLoading = new FakeElement('div');
    subLoading.setAttribute('data-testid', 'agent-loading');
    nestedSubpane.appendChild(subLoading);
    mainView.appendChild(nestedSubpane);

    const toolCard = new FakeElement('div');
    toolCard.setAttribute('data-testid', 'tool-call');
    const shimmer = new FakeElement('span');
    shimmer.className = 'animate-shimmer-text';
    shimmer.textContent = 'Running step...';
    toolCard.appendChild(shimmer);
    mainView.appendChild(toolCard);

    const strayStopBtn = new FakeElement('button');
    strayStopBtn.setAttribute('aria-label', 'Stop');
    mainView.appendChild(strayStopBtn);

    assert.equal(mgr.resolveActivityPhase(mainView, { isRunning: false }, { isSubpane: false }), 'idle');

    // 挂载 composer 后，语音录制按钮与菜单项内的 Cancel 不得误报，真实 Stop generating 按钮正常识别
    const composer = new FakeElement('div');
    composer.className = 'surface-composer';
    const voiceBtn = new FakeElement('button');
    voiceBtn.setAttribute('aria-label', 'Stop voice dictation');
    composer.appendChild(voiceBtn);

    const menu = new FakeElement('div');
    menu.setAttribute('role', 'menu');
    const menuCancel = new FakeElement('button');
    menuCancel.setAttribute('role', 'menuitem');
    menuCancel.textContent = 'Cancel';
    menu.appendChild(menuCancel);
    composer.appendChild(menu);
    mainView.appendChild(composer);

    assert.equal(mgr.resolveActivityPhase(mainView, { isRunning: false }, { isSubpane: false }), 'idle');

    toolCard.remove();
    const realStopBtn = new FakeElement('button');
    realStopBtn.setAttribute('aria-label', 'Stop generating');
    composer.appendChild(realStopBtn);
    assert.equal(mgr.resolveActivityPhase(mainView, { isRunning: false }, { isSubpane: false }), 'generating');

    // 2. P2-04: 引用芯片内 [data-agent-state-dot="idle" | "completed" | "error"] 不得误报子智能体活跃
    const subView = new FakeElement('div');
    const idleChip = new FakeElement('button');
    idleChip.setAttribute('aria-label', 'Open Subagent: Worker A');
    const idleDot = new FakeElement('span');
    idleDot.setAttribute('data-agent-state-dot', 'idle');
    idleChip.appendChild(idleDot);
    const errChip = new FakeElement('button');
    errChip.setAttribute('aria-label', 'Open Subagent: Worker B');
    const errDot = new FakeElement('span');
    errDot.setAttribute('data-agent-state-dot', 'error');
    errChip.appendChild(errDot);
    subView.appendChild(idleChip);
    subView.appendChild(errChip);
    assert.equal(mgr.resolveSubagentState(subView, { isSubpane: false }).isSubagentRunning, false);

    const activeChip = new FakeElement('button');
    activeChip.setAttribute('aria-label', 'Open Subagent: Worker C');
    const runningDot = new FakeElement('span');
    runningDot.setAttribute('data-agent-state-dot', 'running');
    activeChip.appendChild(runningDot);
    subView.appendChild(activeChip);
    assert.equal(mgr.resolveSubagentState(subView, { isSubpane: false }).isSubagentRunning, true);

    // 3. P2-04: 双主分栏下 collectDomSubagentIds 严格按分栏隔离，不跨栏串扰
    const subIdA = '12121212-1212-4212-8212-121212121212';
    const subIdB = '34343434-3434-4434-8434-343434343434';
    const leftPane = new FakeElement('div');
    const leftSubNode = new FakeElement('div');
    leftSubNode.id = `subagentView-${subIdA}`;
    leftPane.appendChild(leftSubNode);

    const rightPane = new FakeElement('div');
    const rightSubNode = new FakeElement('div');
    rightSubNode.id = `subagentView-${subIdB}`;
    rightPane.appendChild(rightSubNode);

    assert.deepEqual(mgr.collectDomSubagentIds(leftPane, 2), [subIdA]);
    assert.deepEqual(mgr.collectDomSubagentIds(rightPane, 2), [subIdB]);

    // 4. P2-04: setRouteExcluded(true) 立即清理挂起的 reconcileTimer
    mgr.reconcileTimer = setTimeout(() => {}, 60_000);
    mgr.setRouteExcluded(true);
    assert.equal(mgr.reconcileTimer, null);

    // 5. 1 主分栏 + 1 子智能体分栏共存时，主分栏仍允许从 URL /c/<uuid> 解析会话 ID
    const prevWin = globalThis.window;
    const prevDoc = globalThis.document;
    try {
      const fakeDoc = new FakeElement('document');
      fakeDoc.createElement = (tag) => new FakeElement(tag, fakeDoc);
      const mainPane = new FakeElement('div', fakeDoc);
      mainPane.setAttribute('data-testid', 'conversation-view');
      const mainComp = new FakeElement('div', fakeDoc);
      mainComp.className = 'surface-composer';
      mainPane.appendChild(mainComp);

      const subPane = new FakeElement('div', fakeDoc);
      subPane.setAttribute('data-testid', 'subagent-tab-conversation');
      subPane.setAttribute('data-media-drop-scope', 'subpane');
      subPane.setAttribute('data-cascade-id', 'dddddddd-4444-4444-8444-dddddddddddd');
      subPane._rect = { left: 400, top: 0, width: 420, height: 700, right: 820, bottom: 700 };
      const subComp = new FakeElement('div', fakeDoc);
      subComp.className = 'surface-composer';
      subPane.appendChild(subComp);

      globalThis.window = {
        innerWidth: 1200,
        innerHeight: 800,
        location: { pathname: '/c/eeeeeeee-5555-4555-8555-eeeeeeeeeeee', search: '', hash: '' },
        getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
      };
      globalThis.document = fakeDoc;
      mgr.setRouteExcluded(false);
      mgr.reconcileMounts([mainPane, subPane]);
      const convIds = [...mgr.instances.values()].map((i) => i.getCurrentConvId());
      assert.equal(convIds.includes('eeeeeeee-5555-4555-8555-eeeeeeeeeeee'), true);
      assert.equal(convIds.includes('dddddddd-4444-4444-8444-dddddddddddd'), true);
    } finally {
      globalThis.window = prevWin;
      globalThis.document = prevDoc;
    }
  } finally {
    mgr.dispose();
  }
});

test('1.1.1 终审回归: conversation_summaries.db 10 子代理精确发现、分批 runningSubagentCount=1、subagents/tasks 合并态、reconcile 重绑 ResizeObserver、未定价前缀与 status=4 中止', async (t) => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-hud-111-batch2-'));
  t.after(() => { closeTrackedDbs(t); fs.rmSync(baseDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });
  const convDir = path.join(baseDir, 'conversations');
  fs.mkdirSync(convDir, { recursive: true });

  const mainId = '10101010-1111-4111-8111-101010101010';
  const childIds = Array.from({ length: 10 }, (_, idx) => {
    const suffix = String(idx + 1).padStart(2, '0');
    return `20202020-2222-4222-8222-2020202020${suffix}`;
  });

  const summariesDbPath = path.join(baseDir, 'conversation_summaries.db');
  const summariesDb = trackDb(t, new DatabaseSync(summariesDbPath));
  t.after(() => {
    try {
      summariesDb.close();
    } catch {}
  });
  summariesDb.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE conversation_parents (
      child_id TEXT PRIMARY KEY,
      parent_id TEXT NOT NULL
    );
    CREATE INDEX idx_conversation_parents_parent ON conversation_parents(parent_id);
    CREATE TABLE conversation_summaries (
      id TEXT PRIMARY KEY,
      status TEXT,
      updated_at INTEGER
    );
  `);
  const insertParent = summariesDb.prepare('INSERT INTO conversation_parents (child_id, parent_id) VALUES (?, ?)');
  const insertSummary = summariesDb.prepare('INSERT INTO conversation_summaries (id, status, updated_at) VALUES (?, ?, ?)');
  childIds.forEach((cid, i) => {
    insertParent.run(cid, mainId);
    const st = i === 0 ? 'CASCADE_RUN_STATUS_RUNNING' : i <= 5 ? 'CASCADE_RUN_STATUS_IDLE' : 'CASCADE_RUN_STATUS_KILLED';
    insertSummary.run(cid, st, 2000 + i);
  });

  const { db: mainDb } = createWalDb(t, convDir, mainId);
  mainDb.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (0, 14, 3, ?)').run(
    Buffer.from(seconds(1, 2000))
  );
  mainDb.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (1, 132, 1, ?)').run(
    Buffer.from([
      ...seconds(1, 2001),
      ...message(4, [...string(2, 'invoke_subagent'), ...string(3, JSON.stringify({ conversation_id: childIds[1] }))]),
    ])
  );
  mainDb.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (2, 132, 1, ?)').run(
    Buffer.from([
      ...seconds(1, 2010),
      ...message(4, [...string(2, 'invoke_subagent'), ...string(3, JSON.stringify({ conversation_id: childIds[0] }))]),
    ])
  );
  mainDb.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (3, 15, 3, ?)').run(
    Buffer.from([...seconds(1, 2011), ...seconds(7, 2015), ...string(12, 'exec-priced')])
  );
  mainDb.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (4, 15, 3, ?)').run(
    Buffer.from([...seconds(1, 2016), ...seconds(7, 2019), ...string(12, 'exec-unpriced')])
  );
  const gPriced = generationBlob({
    indices: [3],
    execution: 'exec-priced',
    responseModel: 'claude-sonnet-4-6',
    modelDisplayName: 'Claude Sonnet 4.6',
    modelEnum: 101,
    rawInputTokens: 10_000,
    cachedReadTokens: 0,
    outputTokens: 1_000,
  });
  const gUnpriced = generationBlob({
    indices: [4],
    execution: 'exec-unpriced',
    responseModel: 'future-unknown-model-99',
    modelDisplayName: 'Future Unknown Model 99',
    modelEnum: 9999,
    rawInputTokens: 5_000,
    cachedReadTokens: 0,
    outputTokens: 500,
  });
  mainDb.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (0, ?, ?)').run(gPriced, gPriced.length);
  mainDb.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (1, ?, ?)').run(gUnpriced, gUnpriced.length);

  for (let i = 0; i < 6; i++) {
    const { db: cDb } = createWalDb(t, convDir, childIds[i], mainId);
    const st = i === 0 ? 1 : 3;
    const meta = i === 0
      ? Buffer.from([...seconds(1, 2012), ...message(9, usageBytes({ rawInputTokens: 400, cachedReadTokens: 0, outputTokens: 40 }))])
      : Buffer.from([...seconds(1, 2002 + i), ...seconds(7, 2005 + i), ...message(9, usageBytes({ rawInputTokens: 300, cachedReadTokens: 0, outputTokens: 30 }))]);
    cDb.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (0, 15, ?, ?)').run(st, meta);
  }

  const engine = new ConversationMetricsEngine({ conversationsDir: convDir });
  const m = await engine.getConversationMetrics({
    conversationId: mainId,
    isSubagentRunning: true,
    runningSubagentCount: 1,
    observedAt: 2_020_000,
  });

  assert.equal(m.session.subagentCount, 10, '通过 conversation_summaries.db 精确发现全部 10 个子智能体（含未落独立 .db 的已取消项）');
  assert.equal(m.runningSubagentCount, 1, '第 1 批子代理已完结时不得把旧父步骤叠加成 ⑂ 2');
  assert.equal(m.tokens.hasUnpricedSteps, true);
  assert.equal(m.tokens.estimatedCostUsd > 0, true);

  const abortedMetrics = buildConversationHudMetrics({
    conversationId: 'conv-status4',
    steps: [
      { idx: 0, stepType: 14, status: 3, createdAtSeconds: 1000, completedAtSeconds: 1000, hasUsage: false },
      { idx: 1, stepType: 15, status: 4, createdAtSeconds: 1001, completedAtSeconds: 1006, hasUsage: false },
    ],
  });
  assert.equal(abortedMetrics.session.turnAborted, true);

  const mgr = new AntigravityHudManager();
  try {
    const view = new FakeElement('div');
    view.setAttribute('data-testid', 'conversation-view');
    const idleText = new FakeElement('span');
    idleText.setAttribute('data-testid', 'idle-status-text');
    idleText.textContent = '2 subagents/tasks running';
    view.appendChild(idleText);

    const residualLoading = new FakeElement('div');
    residualLoading.setAttribute('data-testid', 'agent-loading');
    view.appendChild(residualLoading);

    const subChip = new FakeElement('button');
    subChip.setAttribute('aria-label', 'Open Subagent: Swarm Worker (fact-verifier)');
    const subDot = new FakeElement('span');
    subDot.setAttribute('data-agent-state-dot', 'running');
    subChip.appendChild(subDot);
    view.appendChild(subChip);

    const bgTaskSpinner = new FakeElement('span');
    bgTaskSpinner.setAttribute('data-testid', 'status-task-running');
    view.appendChild(bgTaskSpinner);

    const nestedSubTab = new FakeElement('div');
    nestedSubTab.setAttribute('data-testid', 'subagent-tab-conversation');
    nestedSubTab.setAttribute('data-cascade-id', childIds[0]);
    view.appendChild(nestedSubTab);

    const subState = mgr.resolveSubagentState(view, { isSubpane: false });
    assert.equal(subState.isSubagentRunning, true);
    assert.equal(subState.runningSubagentCount, 1, '合并文案 2 subagents/tasks running + 后台终端任务不得虚增为 2');
    assert.equal(mgr.resolveActivityPhase(view, { isRunning: true }, { isSubpane: false }), 'idle', '无停止按钮且处于后台等待文案时，残留 agent-loading 不得把主圆点染蓝');
  } finally {
    mgr.dispose();
  }

  const observedTargets = [];
  const disconnectedTargets = [];
  const prevRO = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor() {
      this._target = null;
    }
    observe(el) {
      this._target = el;
      observedTargets.push(el);
    }
    disconnect() {
      disconnectedTargets.push(this._target);
    }
  };
  try {
    const doc = new FakeElement('document');
    doc.createElement = (tag) => new FakeElement(tag, doc);
    const parent = new FakeElement('div', doc);
    const comp1 = new FakeElement('div', doc);
    const comp2 = new FakeElement('div', doc);
    parent.appendChild(comp1);
    parent.appendChild(comp2);

    const inst = new HudInstance('pane-ro', { languageMode: 'en' });
    try {
      inst.mount(comp1);
      assert.equal(observedTargets.at(-1), comp1);
      inst.reconcile(comp2);
      assert.equal(disconnectedTargets.includes(comp1), true);
      assert.equal(observedTargets.at(-1), comp2, 'reconcile 迁移到新 composer 时必须重新绑定 ResizeObserver');

      inst.currentConvId = mainId;
      inst.updateMetrics(m);
      assert.equal(inst.shadow.querySelector('#hud-txt-session .hud-subagent-count').textContent, '', '单子智能体运行态胶囊保持极简仅显示 ⑂ 图标而不显示虚高的 2');
      assert.equal(inst.shadow.querySelector('#val-subagent-status').textContent, '1 running (6 steps)');
      assert.match(inst.shadow.querySelector('#val-est-cost').textContent, /^≥ \$/);
    } finally {
      inst.dispose();
    }
  } finally {
    globalThis.ResizeObserver = prevRO;
  }
});
