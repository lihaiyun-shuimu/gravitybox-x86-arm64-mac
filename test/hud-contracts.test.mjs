import test from "node:test";
import { describe as describeContractGroup } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as hudExports from "../dist/hud.js";
import { clearObservedIdeModelsForTest, registerObservedIdeModels } from "../dist/model-catalog.js";
import { AntigravityHudManager } from "../runtime/hud-manager.js";
const { computeTps, parseProtobufTimestamp, parseStepMetadataBlob, parseLatestGenMetadataBlob, ConversationMetricsEngine, buildConversationHudMetrics, resolveModelCapacity } = hudExports;

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("HUD 指标 · hud-empirical-v2", { concurrency: false }, async () => {
const { DatabaseSync } = await import('node:sqlite');

function encodeVarint(val) {
  const bytes = [];
  let v = BigInt(val);
  while (v >= 0x80n) {
    bytes.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  bytes.push(Number(v));
  return bytes;
}

function encodeStringField(fieldNum, str) {
  const buf = Buffer.from(str, 'utf8');
  return [...encodeVarint((fieldNum << 3) | 2), ...encodeVarint(buf.length), ...buf];
}

function encodeTimestampField(fieldNum, seconds, nanos = 0) {
  const inner = [
    0x08, ...encodeVarint(seconds),
    0x10, ...encodeVarint(nanos)
  ];
  return [(fieldNum << 3) | 2, ...encodeVarint(inner.length), ...inner];
}

function encodeUsageField9({ rawInput = 0, outputTokens = 0, cacheWriteTokens = 0, cachedTokens = 0, reasoningTokens = 0, candidateTokens = 0 }) {
  const inner = [
    (2 << 3) | 0, ...encodeVarint(rawInput),
    (3 << 3) | 0, ...encodeVarint(outputTokens),
    (4 << 3) | 0, ...encodeVarint(cacheWriteTokens),
    (5 << 3) | 0, ...encodeVarint(cachedTokens),
    (9 << 3) | 0, ...encodeVarint(reasoningTokens),
    (10 << 3) | 0, ...encodeVarint(candidateTokens)
  ];
  return [(9 << 3) | 2, ...encodeVarint(inner.length), ...inner];
}

test('复验 1: 真实单步上下文明细在极端边界下满足非负性与严格守恒性（废弃 computeCascadeContextBreakdown 已移除）', () => {
  assert.equal('computeCascadeContextBreakdown' in hudExports, false);
  const testCapacities = [200000, 262144, 128000, 1048576];
  const testInputs = [
    0, 1, 500, 1900, 1901, 5000, 9500, 9501, 150000, 200000, 226000
  ];

  for (const cap of testCapacities) {
    for (const u of testInputs) {
      const cached = Math.floor(u * 0.7);
      const rawInput = u - cached;
      const m = buildConversationHudMetrics({
        conversationId: 'ctx-conservation',
        modelId: 'gemini-3.8-flash',
        modelCapacity: cap,
        steps: [
          {
            idx: 1,
            stepType: 15,
            status: 3,
            hasUsage: true,
            rawInputTokens: rawInput,
            cachedReadTokens: cached,
            cacheWriteTokens: 0,
            outputTokens: 64,
          },
        ],
      });
      const bd = m.context.breakdown;
      assert.ok(bd.cachedContextTokens >= 0);
      assert.ok(bd.uncachedContextTokens >= 0);
      assert.ok(bd.cachedContextRatio >= 0);
      assert.ok(bd.uncachedContextRatio >= 0);
      assert.equal(bd.cachedContextTokens + bd.uncachedContextTokens, u, `Token 分解总和必须严格等于输入 U (u=${u}, cap=${cap})`);
      if (u <= cap) {
        assert.ok(Math.abs((bd.cachedContextRatio + bd.uncachedContextRatio) - m.context.usedRatio * 100) < 1e-9);
      }
    }
  }
});

test('复验 2: parseLatestGenMetadataBlob 真实解析 gen_metadata 模型标识、ContextWindowMetadata 与权威流式 Duration', () => {
  // 构造 ChatStartMetadata (field 9) -> ContextWindowMetadata (field 10: field 1 estimated=185000, field 4 max=200000)
  const cwMeta = [
    (1 << 3) | 0, ...encodeVarint(185000),
    (4 << 3) | 0, ...encodeVarint(200000),
  ];
  const chatStartMeta = [
    (10 << 3) | 2, ...encodeVarint(cwMeta.length), ...cwMeta,
  ];
  const chatModelMeta = [
    ...encodeStringField(19, 'gemini-3.8-flash-tiered'),
    ...encodeStringField(21, 'Gemini 3.8 Flash'),
    (9 << 3) | 2, ...encodeVarint(chatStartMeta.length), ...chatStartMeta,
    ...encodeTimestampField(11, 2, 500_000_000), // field 11: time_to_first_token = 2.5s
    ...encodeTimestampField(12, 8, 250_000_000), // field 12: streaming_duration = 8.25s
  ];
  const genBlob = new Uint8Array([
    (1 << 3) | 2, ...encodeVarint(chatModelMeta.length), ...chatModelMeta,
  ]);

  const parsed = parseLatestGenMetadataBlob(genBlob);
  assert.equal(parsed.responseModel, 'gemini-3.8-flash-tiered');
  assert.equal(parsed.modelDisplayName, 'Gemini 3.8 Flash');
  assert.equal(parsed.estimatedTokensUsed, 185000);
  assert.equal(parsed.maxContextTokens, 200000);
  assert.equal(parsed.timeToFirstTokenSeconds, 2.5);
  assert.equal(parsed.streamingDurationSeconds, 8.25);
});

test('复验 3: 有效输出速度保留原始精度、拒绝无效耗时且不设置人为速度上限', () => {
  assert.equal(computeTps(0, 100).status, 'pending_or_fallback');
  assert.equal(computeTps(NaN, 100).formatted, '—');
  assert.equal(computeTps(2, Infinity).formatted, '—');
  assert.equal(computeTps(0.05, 50).outputTps, 1000);
  assert.equal(computeTps(0.1, 100).formatted, '1K tok/s');
  const normal = computeTps(3, 100);
  assert.equal(normal.outputTps, 100 / 3);
  assert.equal(normal.formatted, '33.3 tok/s');
});

test('复验 4: 64 位 BigInt 无符号 Varint 解码、未知 WireType 跳过与 Protobuf 完整解析', () => {
  const sec = 1794282255n;
  const nanos = 123456789n;
  const tsBytes = new Uint8Array([
    0x08, ...encodeVarint(sec),
    0x10, ...encodeVarint(nanos)
  ]);
  const parsedTs = parseProtobufTimestamp(tsBytes);
  const expectedTs = Number(sec) + Number(nanos) / 1e9;
  assert.ok(Math.abs(parsedTs - expectedTs) < 1e-6);

  const date = new Date(parsedTs * 1000);
  assert.equal(Number.isNaN(date.getTime()), false);
  assert.equal(date.getUTCFullYear(), 2026);

  // 验证完整 step metadata blob 解码 (含 field 1, 6, 8, 9 及夹杂 wireType 5 固定 32 位字段)
  const blob = new Uint8Array([
    ...encodeTimestampField(1, 1794282200, 0),
    (3 << 3) | 5, 0x01, 0x02, 0x03, 0x04, // wireType 5 未知字段应安全跳过
    ...encodeTimestampField(6, 1794282205, 500_000_000),
    ...encodeTimestampField(8, 1794282215, 500_000_000),
    ...encodeUsageField9({
      rawInput: 24000,
      outputTokens: 600,
      cacheWriteTokens: 0,
      cachedTokens: 48000,
      reasoningTokens: 200,
      candidateTokens: 400
    })
  ]);
  const step = parseStepMetadataBlob(10, 15, 2, blob);
  assert.equal(step.startTimeSeconds, 1794282200);
  assert.equal(step.firstTokenSeconds, 1794282205.5);
  assert.equal(step.endTimeSeconds, 1794282215.5);
  assert.equal(step.rawInputTokens, 24000);
  assert.equal(step.cachedReadTokens, 48000);
  assert.equal(step.outputTokens, 600);
  assert.equal(step.reasoningTokens + step.candidateTokens, step.outputTokens);
});

test('复验 5: ConversationMetricsEngine 两级 lstat 门控、子智能体会话聚合与 SQLite 单语句增量读取验证', async () => {
  const tmpDir = path.join(os.tmpdir(), `gravitybox-hud-engine-${Date.now()}`);
  const convDir = path.join(tmpDir, 'antigravity', 'conversations');
  fs.mkdirSync(convDir, { recursive: true });
  const convId = '4ec6348d-0f58-49db-8aed-6f67dbb78f5d';
  const childConvId = '99999999-1111-4444-8888-aaaaaaaaaaaa';
  const dbFile = path.join(convDir, `${convId}.db`);
  const childDbFile = path.join(convDir, `${childConvId}.db`);

  try {
    const db = new DatabaseSync(dbFile);
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE steps (
        idx INTEGER PRIMARY KEY,
        step_type INTEGER NOT NULL,
        status INTEGER NOT NULL,
        metadata BLOB,
        data BLOB
      );
      CREATE TABLE gen_metadata (
        idx INTEGER PRIMARY KEY,
        data BLOB
      );
    `);

    const step1Blob = Buffer.from([
      ...encodeTimestampField(1, 1794282000, 0),
      ...encodeTimestampField(6, 1794282002, 0),
      ...encodeTimestampField(8, 1794282012, 0),
      ...encodeUsageField9({
        rawInput: 10000,
        cachedTokens: 90000,
        outputTokens: 500,
        reasoningTokens: 100,
        candidateTokens: 400
      })
    ]);

    db.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, ?, ?, ?)').run(1, 14, 3, null);
    db.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, ?, ?, ?)').run(2, 15, 3, step1Blob);

    const engine = new ConversationMetricsEngine({ geminiDir: tmpDir });
    const m1 = await engine.getConversationMetrics({
      conversationId: convId,
      sessionRevision: 1,
      modelId: 'gemini-3.8-flash',
      isStreaming: false
    });

    assert.equal(m1.session.turns, 1);
    assert.equal(m1.session.steps, 2);
    assert.equal(m1.tokens.totalTokens, 100500);
    assert.equal(m1.tokens.cacheHitRateFormatted, '90%');
    assert.equal(m1.session.outputTpsFormatted, '41.7 tok/s');
    assert.equal(m1.context.usedTokens, 100000);
    assert.equal(m1.context.capacityTokens, 200000);
    assert.equal(m1.context.usedRatioFormatted, '50%');
    assert.equal(m1.context.breakdown.cachedContextTokens, 90000);
    assert.equal(m1.context.breakdown.uncachedContextTokens, 10000);

    // 验证宿主执行 wal_checkpoint(TRUNCATE) 绝不被阻塞 (busy: 0)
    const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    assert.equal(checkpoint.busy, 0, 'ConversationMetricsEngine 单语句 Auto-Commit 绝不阻塞 wal_checkpoint');

    // 追加新步骤并模拟启动一个子智能体 (step_type = 127 INVOKE_SUBAGENT，引用 childConvId)
    const step2Blob = Buffer.from([
      ...encodeTimestampField(1, 1794282020, 0),
      ...encodeTimestampField(6, 1794282021, 0),
      ...encodeTimestampField(8, 1794282031, 0),
      ...encodeUsageField9({
        rawInput: 20000,
        cachedTokens: 180000,
        outputTokens: 1000,
        reasoningTokens: 300,
        candidateTokens: 700
      })
    ]);
    db.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, ?, ?, ?)').run(3, 15, 3, step2Blob);

    // 建立子智能体会话数据库 childDbFile (正在运行 status = 2)
    const childDb = new DatabaseSync(childDbFile);
    childDb.exec(`
      CREATE TABLE steps (
        idx INTEGER PRIMARY KEY,
        step_type INTEGER NOT NULL,
        status INTEGER NOT NULL,
        metadata BLOB
      );
    `);
    const childStepBlob = Buffer.from([
      ...encodeTimestampField(1, 1794282032, 0),
      ...encodeTimestampField(6, 1794282033, 0),

      ...encodeUsageField9({
        rawInput: 5000,
        cachedTokens: 45000,
        outputTokens: 250,
        reasoningTokens: 50,
        candidateTokens: 200
      })
    ]);
    childDb.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, ?, ?, ?)').run(1, 14, 3, null);
    childDb.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, ?, ?, ?)').run(2, 15, 2, childStepBlob);

    const subagentDataBlob = Buffer.from(encodeStringField(5, childConvId));
    db.prepare('INSERT INTO steps (idx, step_type, status, metadata, data) VALUES (?, ?, ?, ?, ?)').run(
      4,
      127,
      2,
      null,
      subagentDataBlob
    );

    const m2 = await engine.getConversationMetrics({
      conversationId: convId,
      sessionRevision: 2,
      modelId: 'gemini-3.8-flash',
      isStreaming: false
    });
    // 主会话 4 步 + 子会话 2 步 = 6 步；且子智能体正在运行，isSubagentRunning & isStreaming 自动为 true
    assert.equal(m2.session.steps, 6, '总步数应包含关联子智能体会话的步数');
    assert.equal(m2.session.subagentSteps, 2, 'subagentSteps 应精确报告子智能体完整步数而非残差');
    assert.equal(m2.isSubagentRunning, true, 'SQLite 中子智能体步骤未完成时应自动标记 isSubagentRunning=true');
    assert.equal(m2.isStreaming, true, '子智能体运行时 isStreaming 必须为 true');
    assert.equal(m2.tokens.totalTokens, 100500 + 201000 + 50250, '累计 Token 应自动汇总子智能体消耗');
    // 主会话当前单步上下文仍保持主会话最后一步的 200,000 tok (100%)，不被子智能体的 50,000 tok 覆盖
    assert.equal(m2.context.usedTokens, 200000);
    assert.equal(m2.context.usedRatioFormatted, '100%');

    // 验证 Antigravity 2.30.0 真实表结构 (无 data 列，使用 render_info + trajectory_metadata_blob) 与防无关 UUID 串号污染
    const realMainId = '11111111-2222-4333-8444-555555555555';
    const realChildId = '66666666-7777-4888-8999-000000000000';
    const unrelatedId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const realMainDb = new DatabaseSync(path.join(convDir, `${realMainId}.db`));
    realMainDb.exec(`
      CREATE TABLE trajectory_meta (trajectory_id TEXT PRIMARY KEY, cascade_id TEXT, trajectory_type INTEGER);
      CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER NOT NULL, status INTEGER NOT NULL, metadata BLOB, render_info BLOB, step_payload BLOB);
      CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER NOT NULL DEFAULT 0);
    `);
    realMainDb.prepare('INSERT INTO trajectory_meta VALUES (?, ?, ?)').run('ffffffff-1111-4222-8333-444444444444', realMainId, 1);
    realMainDb.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, ?, ?, ?)').run(0, 14, 3, null);
    // 普通 run_command 工具参数中出现 unrelatedId，绝不能被误判为子智能体
    const runCmdToolCall = [
      ...encodeStringField(2, 'run_command'),
      ...encodeStringField(3, JSON.stringify({ cmd: `echo ${unrelatedId}` })),
    ];
    const runCmdMeta = Buffer.from([
      ...encodeTimestampField(1, 1794283000, 0),
      ...encodeTimestampField(8, 1794283001, 0),
      (4 << 3) | 2, ...encodeVarint(runCmdToolCall.length), ...runCmdToolCall,
    ]);
    realMainDb.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, ?, ?, ?)').run(1, 132, 3, runCmdMeta);
    // 真实 invoke_subagent 步骤：子会话 ID 存放在 render_info 列
    const invokeToolCall = [
      ...encodeStringField(2, 'invoke_subagent'),
      ...encodeStringField(3, JSON.stringify({ role: 'Investigator' })),
    ];
    const invokeMeta = Buffer.from([
      ...encodeTimestampField(1, 1794283002, 0),
      ...encodeTimestampField(8, 1794283010, 0),
      (4 << 3) | 2, ...encodeVarint(invokeToolCall.length), ...invokeToolCall,
    ]);
    const invokeRenderInfo = Buffer.from(encodeStringField(1, realChildId));
    realMainDb.prepare('INSERT INTO steps (idx, step_type, status, metadata, render_info) VALUES (?, ?, ?, ?, ?)').run(2, 132, 3, invokeMeta, invokeRenderInfo);

    // 创建无关会话数据库 (含 999,999 token，其 trajectory_metadata_blob 不指向 realMainId)
    const unrelatedDb = new DatabaseSync(path.join(convDir, `${unrelatedId}.db`));
    unrelatedDb.exec(`
      CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER NOT NULL, status INTEGER NOT NULL, metadata BLOB);
      CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB);
    `);
    unrelatedDb.prepare('INSERT INTO trajectory_metadata_blob VALUES (?, ?)').run('main', Buffer.from(encodeStringField(5, unrelatedId)));
    unrelatedDb.prepare('INSERT INTO steps VALUES (?, ?, ?, ?)').run(1, 15, 3, Buffer.from(encodeUsageField9({ rawInput: 999999, outputTokens: 1 })));

    // 创建真实子智能体数据库 (其 trajectory_metadata_blob 指向父会话 realMainId)
    const realChildDb = new DatabaseSync(path.join(convDir, `${realChildId}.db`));
    realChildDb.exec(`
      CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER NOT NULL, status INTEGER NOT NULL, metadata BLOB);
      CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB);
    `);
    realChildDb.prepare('INSERT INTO trajectory_metadata_blob VALUES (?, ?)').run('main', Buffer.from(encodeStringField(5, realMainId)));
    realChildDb.prepare('INSERT INTO steps VALUES (?, ?, ?, ?)').run(1, 15, 3, Buffer.from([
      ...encodeTimestampField(1, 1794283003, 0),
      ...encodeTimestampField(8, 1794283009, 0),
      ...encodeUsageField9({ rawInput: 4000, cachedTokens: 16000, outputTokens: 200, reasoningTokens: 50, candidateTokens: 150 })
    ]));

    const mReal = await engine.getConversationMetrics({
      conversationId: realMainId,
      sessionRevision: 1,
      modelId: 'gemini-3.8-flash',
    });
    assert.equal(mReal.session.subagentCount, 1, '仅归属核验通过的真实子智能体计入 subagentCount，run_command 中的无关 UUID 被拦截');
    assert.equal(mReal.session.subagentSteps, 1);
    assert.equal(mReal.session.steps, 4, '主会话 3 步 + 真实子智能体 1 步 = 4 步');
    assert.equal(mReal.tokens.totalTokens, 20200, '绝不混入 unrelatedDb 的 1,000,000 token');

    // 验证 claude-opus-5-5 并行审计团队 (step_type = 132 GENERIC StepRenderInfo.AgentRef x 6 + 超 64KB render_info 投影)
    // 与 gen_metadata 压缩步/缺失 field 9/同轮重试/cacheWriteTokens 全量守恒对账（菜单栏 15.9M vs HUD 一致）
    const opusMainId = 'f073e34e-fa07-4df6-9b98-e5acb9fbc3fa';
    const opusChildIds = [
      '10000000-fa07-4df6-9b98-000000000001',
      '10000000-fa07-4df6-9b98-000000000002',
      '10000000-fa07-4df6-9b98-000000000003',
      '10000000-fa07-4df6-9b98-000000000004',
      '10000000-fa07-4df6-9b98-000000000005',
      '10000000-fa07-4df6-9b98-000000000006',
    ];
    const encodeSubmessage = (fieldNum, innerBytes) => [
      ...encodeVarint((fieldNum << 3) | 2),
      ...encodeVarint(innerBytes.length),
      ...innerBytes,
    ];
    const encodeGenMetadataRow = ({ stepIndices = [], execHex = '', modelId = 'claude-opus-5-5-medium', displayName = 'Claude Opus 5.5', startedSec = 1794284000, rawInput = 0, cachedTokens = 0, cacheWriteTokens = 0, outputTokens = 0 }) => {
      const usageInner = [
        (2 << 3) | 0, ...encodeVarint(rawInput),
        (3 << 3) | 0, ...encodeVarint(outputTokens),
        (4 << 3) | 0, ...encodeVarint(cacheWriteTokens),
        (5 << 3) | 0, ...encodeVarint(cachedTokens),
      ];
      const chatStart = [...encodeTimestampField(4, startedSec, 0)];
      const chatModel = [
        ...encodeSubmessage(4, usageInner),
        ...encodeSubmessage(9, chatStart),
        ...encodeStringField(19, modelId),
        ...encodeStringField(21, displayName),
      ];
      const packedIndices = stepIndices.flatMap((idxVal) => encodeVarint(idxVal));
      const execBytes = execHex ? [...Buffer.from(execHex, 'hex')] : [];
      return Buffer.from([
        ...encodeSubmessage(1, chatModel),
        ...(packedIndices.length ? encodeSubmessage(2, packedIndices) : []),
        ...(execBytes.length ? encodeSubmessage(4, execBytes) : []),
      ]);
    };

    const opusMainDb = new DatabaseSync(path.join(convDir, `${opusMainId}.db`));
    opusMainDb.exec(`
      CREATE TABLE trajectory_meta (trajectory_id TEXT PRIMARY KEY, cascade_id TEXT, trajectory_type INTEGER);
      CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER NOT NULL, status INTEGER NOT NULL, metadata BLOB, render_info BLOB, step_payload BLOB);
      CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
    `);
    opusMainDb.prepare('INSERT INTO trajectory_meta VALUES (?, ?, ?)').run(opusMainId, opusMainId, 1);
    opusMainDb.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, ?, ?, ?)').run(0, 14, 3, null);
    // 主会话 step 1: 内联 field 9 未写 cacheWriteTokens (=0)，而 gen_metadata idx=0 含 cacheWriteTokens=90,000
    const mainExec1 = 'aa11bb22cc33dd44';
    const mainStep1Meta = Buffer.from([
      ...encodeTimestampField(1, 1794284001, 0),
      ...encodeTimestampField(8, 1794284010, 0),
      ...encodeUsageField9({ rawInput: 105000, cachedTokens: 492000, cacheWriteTokens: 0, outputTokens: 12000 }),
      ...encodeSubmessage(12, Buffer.from(mainExec1, 'hex')),
    ]);
    opusMainDb.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, ?, ?, ?)').run(1, 15, 3, mainStep1Meta);
    opusMainDb.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(0, encodeGenMetadataRow({
      stepIndices: [1],
      execHex: mainExec1,
      rawInput: 105000,
      cachedTokens: 492000,
      cacheWriteTokens: 90000,
      outputTokens: 12000,
    }));

    // 主会话 step 2: 并行审计调度 GENERIC (step_type=132)，无 invoke_subagent toolCall，
    // render_info 前部填充 70KB Markdown（触发 >64KB 投影），尾部通过 TitlePart.field5 与 ContentBlock.field4 挂载 6 个 AgentRef
    const bigMarkdownBlock = encodeSubmessage(10, encodeStringField(1, 'x'.repeat(70_000)));
    const agentRefParts = opusChildIds.flatMap((cid, i) => {
      const agentRef = encodeStringField(1, cid);
      return i < 3
        ? encodeSubmessage(9, encodeSubmessage(5, agentRef))
        : encodeSubmessage(10, encodeSubmessage(4, agentRef));
    });
    const parallelAuditRenderInfo = Buffer.from([...bigMarkdownBlock, ...agentRefParts]);
    opusMainDb.prepare('INSERT INTO steps (idx, step_type, status, metadata, render_info) VALUES (?, ?, ?, ?, ?)').run(
      2,
      132,
      3,
      Buffer.from([...encodeTimestampField(1, 1794284012, 0), ...encodeTimestampField(8, 1794284120, 0)]),
      parallelAuditRenderInfo
    );
    // 主会话 step 3: 上下文压缩 CHECKPOINT (step_type=23)，计费仅存于 gen_metadata idx=1 (201,000 tok)
    opusMainDb.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, ?, ?, ?)').run(3, 23, 3, null);
    opusMainDb.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(1, encodeGenMetadataRow({
      stepIndices: [3],
      execHex: 'ee55ff6677889900',
      rawInput: 20000,
      cachedTokens: 150000,
      cacheWriteTokens: 30000,
      outputTokens: 1000,
    }));

    // 6 个已停止的并行子智能体库（模拟 Individual quota reached 终止后，无活跃步，但各自消耗 2,500,000 tok）
    const opusChildDbs = [];
    for (let i = 0; i < opusChildIds.length; i++) {
      const cid = opusChildIds[i];
      const cdb = new DatabaseSync(path.join(convDir, `${cid}.db`));
      cdb.exec(`
        CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER NOT NULL, status INTEGER NOT NULL, metadata BLOB);
        CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB);
        CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
      `);
      cdb.prepare('INSERT INTO trajectory_metadata_blob VALUES (?, ?)').run('main', Buffer.from(encodeStringField(5, opusMainId)));
      if (i === 0) {
        // 子库 0：step 1 缺失内联 field 9，且存在一次配额重试未关联的 gen_metadata 行 (1,000,000 + 1,500,000 = 2,500,000)
        cdb.prepare('INSERT INTO steps VALUES (?, ?, ?, ?)').run(1, 15, 3, Buffer.from([
          ...encodeTimestampField(1, 1794284020, 0),
          ...encodeTimestampField(8, 1794284050, 0),
        ]));
        cdb.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(0, encodeGenMetadataRow({
          stepIndices: [1],
          rawInput: 100000,
          cachedTokens: 800000,
          cacheWriteTokens: 80000,
          outputTokens: 20000,
        }));
        cdb.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(1, encodeGenMetadataRow({
          stepIndices: [],
          rawInput: 150000,
          cachedTokens: 1200000,
          cacheWriteTokens: 120000,
          outputTokens: 30000,
        }));
      } else {
        // 子库 1~5：标准模型步 + 对齐的 gen_metadata，不得发生双倍重复计费 (各 2,500,000 tok)
        const execHex = `001122334455660${i}`;
        cdb.prepare('INSERT INTO steps VALUES (?, ?, ?, ?)').run(1, 15, 3, Buffer.from([
          ...encodeTimestampField(1, 1794284020 + i, 0),
          ...encodeTimestampField(8, 1794284060 + i, 0),
          ...encodeUsageField9({ rawInput: 250000, cachedTokens: 2000000, cacheWriteTokens: 200000, outputTokens: 50000 }),
          ...encodeSubmessage(12, Buffer.from(execHex, 'hex')),
        ]));
        cdb.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(0, encodeGenMetadataRow({
          stepIndices: [1],
          execHex,
          rawInput: 250000,
          cachedTokens: 2000000,
          cacheWriteTokens: 200000,
          outputTokens: 50000,
        }));
      }
      opusChildDbs.push(cdb);
    }

    const mOpus = await engine.getConversationMetrics({
      conversationId: opusMainId,
      sessionRevision: 1,
      modelId: 'claude-opus-5-5-medium',
      isStreaming: false,
      isSubagentRunning: false,
    });
    // 主库 (699,000 + 201,000 = 900,000) + 6 个并行审计子智能体 (6 * 2,500,000 = 15,000,000) = 15,900,000 (15.9M)
    assert.equal(mOpus.session.subagentCount, 6, 'StepRenderInfo.AgentRef 应完整识别全部 6 个已结束并行审计子智能体');
    assert.equal(mOpus.tokens.totalTokens, 15_900_000, 'HUD 总 Token 必须与菜单栏 gen_metadata 全口径严格一致 (15.9M)');
    assert.equal(mOpus.tokens.totalTokensCompact, '15.9M tok');
    assert.equal(mOpus.tokens.cacheWriteTokens, 90000 + 30000 + 6 * 200000);

    for (const cdb of opusChildDbs) cdb.close();
    opusMainDb.close();
    realChildDb.close();
    unrelatedDb.close();
    realMainDb.close();
    engine.clearCache();
    childDb.close();
    db.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
});

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("HUD 指标 · hud-metrics-boundary", { concurrency: false }, async () => {
test('Case A: 新会话空状态 (0 Token, 0 轮次, 0 步数) - 真实引擎模块验证', () => {
  const m = buildConversationHudMetrics({
    conversationId: 'conv-empty',
    sessionRevision: 1,
    steps: [],
    modelId: 'gemini-3.8-flash',
    isStreaming: false
  });
  assert.equal(m.session.turns, 0);
  assert.equal(m.session.steps, 0);
  assert.equal(m.tokens.totalTokens, 0);
  assert.equal(m.tokens.cacheHitRate, 0, '缓存命中率分母为 0 时应安全返回 0 而不是 NaN');
  assert.equal(Number.isNaN(m.tokens.cacheHitRate), false);
  assert.equal(m.session.averageTtftFormatted, '—');
  assert.equal(m.session.outputTpsFormatted, '—');
  assert.equal(Number.isFinite(m.session.outputTps), true);
  assert.equal(m.context.usedRatio, 0);
  assert.equal(m.context.usedRatioFormatted, '0%');
  assert.equal(m.context.capacityTokens, 200000, 'Antigravity 标准上下文容量应为 200K 而非虚假 1M');
  assert.equal(m.context.capacityTokensCompact, '~200K');
});

test('Case B: 进行中的步骤不参与已完成请求的速度计算 - 真实引擎模块验证', () => {
  const steps = [{
    idx: 1,
    stepType: 15,
    status: 2,
    startTimeSeconds: 100.0,
    firstTokenSeconds: 101.0,
    endTimeSeconds: 101.001, // 活跃生成时间 = 0.001s < 0.1s
    rawInputTokens: 1000,
    cachedReadTokens: 2000,
    cacheWriteTokens: 0,
    outputTokens: 50,
    reasoningTokens: 0,
    candidateTokens: 50
  }];

  const m = buildConversationHudMetrics({
    conversationId: 'conv-instant',
    sessionRevision: 1,
    steps,
    modelId: 'gemini-3.8-flash',
    isStreaming: false
  });
  assert.equal(Number.isFinite(m.session.outputTps), true, 'TPS 不能为 Infinity');
  assert.equal(m.session.outputTpsFormatted, '—', '未完成请求没有可核验完整耗时，显示破折号');

  // 流式状态下瞬时窗口展示 "计算中..."
  const mStreaming = buildConversationHudMetrics({
    conversationId: 'conv-instant',
    sessionRevision: 2,
    steps,
    modelId: 'gemini-3.8-flash',
    isStreaming: true
  });
  assert.equal(mStreaming.session.outputTpsFormatted, '计算中...');
});

test('Case C: 真实单步上下文构成 (缓存复用 vs 本步新增输入) - 零虚构 1.9K/7.6K 基线', () => {
  const steps = [{
    idx: 1,
    stepType: 15,
    status: 2,
    startTimeSeconds: 100.0,
    firstTokenSeconds: 101.0,
    endTimeSeconds: 102.0,
    rawInputTokens: 8312,
    cachedReadTokens: 218100,
    cacheWriteTokens: 0,
    outputTokens: 1240,
    reasoningTokens: 440,
    candidateTokens: 800
  }];

  const m = buildConversationHudMetrics({
    conversationId: 'conv-real-context',
    sessionRevision: 1,
    steps,
    modelId: 'Gemini 3.8 Flash High'
  });
  assert.equal(m.context.usedTokens, 226412);
  assert.equal(m.context.peakContextTokens, 226412);
  assert.equal(m.context.capacityTokens, 200000, '观测峰值不得推导窗口容量');
  assert.equal(m.context.capacityTokensCompact, '~200K');
  assert.equal(m.context.isFallbackCapacity, true);
  assert.equal(m.context.breakdown.cachedContextTokens, 218100, '缓存复用上下文必须 100% 源自最后一步 cachedReadTokens');
  assert.equal(m.context.breakdown.uncachedContextTokens, 8312, '本步新增输入必须 100% 源自最后一步 rawInputTokens');
  assert.equal(m.context.breakdown.latestOutputTokens, 1240, '本步生成输出必须 100% 源自最后一步 outputTokens');
  assert.ok(m.context.breakdown.systemRatio >= 0);
  assert.ok(m.context.breakdown.toolRatio >= 0);
  assert.equal(m.context.breakdown.messageRatio, 0);
});

test('Case D: 超出默认阈值与未知模型 ~200K 回退及显式 DB 容量覆盖', () => {
  const steps = [{
    idx: 1,
    stepType: 15,
    status: 2,
    startTimeSeconds: 100.0,
    firstTokenSeconds: 101.0,
    endTimeSeconds: 105.0,
    rawInputTokens: 50000,
    cachedReadTokens: 100000,
    cacheWriteTokens: 0,
    outputTokens: 1000,
    reasoningTokens: 200,
    candidateTokens: 800
  }];

  const mUnknown = buildConversationHudMetrics({
    conversationId: 'conv-unknown',
    sessionRevision: 1,
    steps,
    modelId: 'custom-unknown-llm-v9'
  });
  assert.equal(mUnknown.context.capacityTokens, 200000);
  assert.equal(mUnknown.context.capacityTokensCompact, '~200K', '未知模型容量应回退为 ~200K 而非虚假 1M');
  assert.equal(mUnknown.context.usedRatio, 0.75);
  assert.equal(mUnknown.context.usedRatioFormatted, '75%');

  // 当底层 gen_metadata 显式提供 maxContextTokens 时严格以底层数据为准
  const mExplicit = buildConversationHudMetrics({
    conversationId: 'conv-explicit-cap',
    sessionRevision: 1,
    steps,
    modelId: 'gemini-3.8-flash',
    genMetadata: {
      maxContextTokens: 160000,
      modelDisplayName: 'Gemini 3.8 Flash'
    }
  });
  assert.equal(mExplicit.context.capacityTokens, 160000);
  assert.equal(mExplicit.context.capacityTokensCompact, '160K');
  assert.equal(mExplicit.context.hasExplicitDbCapacity, true);
});

test('Case E: 客户端时间戳逆序、多类型工具步耗时聚合与实机真实数据严密对账', () => {
  const steps = [
    {
      idx: 1,
      stepType: 15,
      status: 3,
      startTimeSeconds: 105.0,
      firstTokenSeconds: null,
      endTimeSeconds: 102.0, // 逆序
      rawInputTokens: 1000,
      cachedReadTokens: 1000,
      cacheWriteTokens: 0,
      outputTokens: 100,
      reasoningTokens: 0,
      candidateTokens: 100
    },
    {
      idx: 2,
      stepType: 132,
      status: 3,
      startTimeSeconds: 200.0,
      firstTokenSeconds: null,
      endTimeSeconds: 195.0, // 工具逆序
      rawInputTokens: 0,
      cachedReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      candidateTokens: 0
    },
    {
      idx: 3,
      stepType: 21, // CORTEX_STEP_TYPE_RUN_COMMAND
      status: 3,
      startTimeSeconds: 300.0,
      firstTokenSeconds: null,
      endTimeSeconds: 304.5
    },
    {
      idx: 4,
      stepType: 23, // CORTEX_STEP_TYPE_CHECKPOINT (上下文压缩)
      status: 3,
      startTimeSeconds: 305.0,
      firstTokenSeconds: null,
      endTimeSeconds: 305.2
    }
  ];

  const m = buildConversationHudMetrics({
    conversationId: 'conv-clock-skew',
    sessionRevision: 1,
    steps
  });
  assert.equal(m.session.modelDurationSeconds, 0, '模型用时遭遇时间逆序时应截断为 0');
  assert.equal(m.session.toolDurationSeconds, 4.5, '非 132 的真实工具步骤 (如 RUN_COMMAND=21) 耗时必须纳入统计');
  assert.equal(m.session.toolSteps, 2);
  assert.equal(m.session.compactionCount, 1, 'CHECKPOINT (step_type=23) 应被准确记录为上下文压缩次数');
  assert.equal(m.session.averageTtftFormatted, '—', '缺少首 token 时 TTFT 显示为破折号');

  // 实机真机测试截图 3 对账: 708,929 + 22,416,293 + 70,856 = 23,196,078 (97% 命中)
  const realMachineSteps = [
    { idx: 1, stepType: 101, status: 3, startTimeSeconds: 1, firstTokenSeconds: null, endTimeSeconds: 1, rawInputTokens: 0, cachedReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, candidateTokens: 0 },
    { idx: 2, stepType: 15, status: 3, startTimeSeconds: 10, firstTokenSeconds: 15.6, endTimeSeconds: 237.0, rawInputTokens: 708929, cachedReadTokens: 22416293, cacheWriteTokens: 0, outputTokens: 70856, reasoningTokens: 20856, candidateTokens: 50000 }
  ];
  const mRef = buildConversationHudMetrics({
    conversationId: 'conv-real-machine',
    sessionRevision: 1,
    steps: realMachineSteps,
    modelId: '+ Gemini 3.8 Flash High ^'
  });
  assert.equal(mRef.tokens.totalTokens, 23196078);
  assert.equal(mRef.tokens.totalTokensCompact, '23.2M tok');
  assert.equal(mRef.tokens.totalTokensFormatted, '23,196,078 tok');
  assert.equal(mRef.tokens.cacheHitRateFormatted, '96.9%');
  assert.equal(mRef.session.averageTtftFormatted, '5.6 秒');
  assert.equal(mRef.session.outputTpsFormatted, '312 tok/s');
  assert.equal(mRef.context.modelId, 'gemini-3.8-flash');
  assert.equal(mRef.context.modelDisplayName, 'Gemini 3.8 Flash');

  // 验证模型容量目录映射 (Antigravity 真实标准阈值)
  assert.equal(resolveModelCapacity('gemini-3.8-flash').capacityCompact, '200K');
  assert.equal(resolveModelCapacity('gemini-3.1-pro').capacityCompact, '200K');
  assert.equal(resolveModelCapacity('claude-3-7-sonnet').capacityCompact, '200K');
  assert.equal(resolveModelCapacity('gpt-4o').capacityCompact, '128K');
});

test('Case F: 推理输出使用完整请求耗时，不推算思维链时间或改写原始可见等待', () => {
  // 复现用户实机截图数据:
  // 模型总用时 = 22 分 43 秒 (1,363s)，其中 viewable_at - created_at = 1,179s (含 TTFT + 50,329 思维链 token)，
  // completed_at - viewable_at = 184.09s (仅含 15,023 回复 token)，总输出 = 65,352 tok (50,329 思维链 + 15,023 回复)
  const thinkingSessionSteps = [
    { idx: 1, stepType: 14, status: 3, startTimeSeconds: 1, endTimeSeconds: 1 },
    {
      idx: 2,
      stepType: 15,
      status: 3,
      startTimeSeconds: 100.0,
      firstTokenSeconds: 100.0 + 1178.91, // viewable_at: 思维链结束时刻
      endTimeSeconds: 100.0 + 1363.0,     // finished_generating_at: 回复结束时刻 (dtPost = 184.09s)
      rawInputTokens: 442089,
      cachedReadTokens: 14997295,
      cacheWriteTokens: 0,
      outputTokens: 65352,
      reasoningTokens: 50329,
      candidateTokens: 15023,
    },
  ];

  const m = buildConversationHudMetrics({
    conversationId: 'conv-thinking-calibrated',
    sessionRevision: 1,
    steps: thinkingSessionSteps,
    modelId: 'Gemini 3.8 Flash High',
  });

  assert.equal(m.tokens.totalTokens, 15504736);
  assert.equal(m.tokens.cacheHitRateFormatted, '97.1%');
  assert.equal(m.session.modelDurationFormatted, '22分43秒');
  // 校准后 TPS 必须反映真实物理流式速率 (~82 tok/s)，绝不再出现将 65,352 除以 184s 得出的 355 tok/s
  assert.equal(m.session.outputTps, 65352 / 1363);
  assert.equal(m.session.outputTpsFormatted, '47.9 tok/s');
  assert.equal(m.session.averageTtftFormatted, '1.18K 秒');
});

test('Case G: Orchestrator (Carbon / Hydrogen) 双阶段分模型独立水位与峰值隔离 + 手动切换未发言模型不串算容量', () => {
  const carbonStep = {
    idx: 1,
    stepType: 15,
    status: 3,
    hasUsage: true,
    startTimeSeconds: 100,
    endTimeSeconds: 110,
    rawInputTokens: 2485,
    cachedReadTokens: 459413,
    cacheWriteTokens: 0,
    outputTokens: 16074,
    generation: {
      modelEnum: 1667,
      responseModel: 'gemini-pro-orchestrator',
      modelDisplayName: 'Orchestrator (Carbon)',
      maxContextTokens: 512000,
    },
  };

  // 1. 仅跑完 Carbon 规划阶段（461,898 / 512,000）
  const phase1 = buildConversationHudMetrics({
    conversationId: 'conv-orch-dual',
    sessionRevision: 1,
    modelId: 'Orchestrator (Carbon)',
    steps: [{ idx: 0, stepType: 14, status: 3 }, carbonStep],
  });
  assert.equal(phase1.context.isOrchestrator, true);
  assert.equal(phase1.context.isMultiModel, true);
  assert.equal(phase1.context.modelShortLabel, 'Carbon');
  assert.equal(phase1.context.modelCompactLabel, 'C');
  assert.equal(phase1.context.usedTokens, 461898);
  assert.equal(phase1.context.peakContextTokens, 461898);
  assert.equal(phase1.context.capacityTokens, 512000);
  assert.equal(phase1.context.modelStages?.length, 2);
  assert.equal(phase1.context.modelStages?.[0]?.role, 'planner');
  assert.equal(phase1.context.modelStages?.[0]?.shortLabel, 'Carbon');
  assert.equal(phase1.context.modelStages?.[0]?.isActive, true);
  assert.equal(phase1.context.modelStages?.[0]?.hasUsageData, true);
  assert.equal(phase1.context.modelStages?.[0]?.usedTokens, 461898);
  assert.equal(phase1.context.modelStages?.[1]?.slotKey, 'orchestrator:executor_pending');
  assert.equal(phase1.context.modelStages?.[1]?.role, 'executor');
  assert.equal(phase1.context.modelStages?.[1]?.modelId, 'pending');
  assert.equal(phase1.context.modelStages?.[1]?.shortLabel, '');
  assert.equal(phase1.context.modelStages?.[1]?.section, 'primary');
  assert.equal(phase1.context.modelStages?.[1]?.isActive, false);
  assert.equal(phase1.context.modelStages?.[1]?.hasUsageData, false);
  assert.equal(phase1.context.modelStages?.[1]?.capacityTokens, 512000);

  // 2. 切入 Hydrogen 执行首步（401,280 / 512,000）：Hydrogen 自身峰值严禁混入 Carbon 的 461,898
  const hydrogenStep1 = {
    idx: 2,
    stepType: 15,
    status: 3,
    hasUsage: true,
    startTimeSeconds: 112,
    endTimeSeconds: 118,
    rawInputTokens: 401280,
    cachedReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 516,
    generation: {
      modelEnum: 1669,
      responseModel: 'gemini-flash-worker-agy',
      modelDisplayName: 'Gemini 4 Hydrogen (Orchestrator)',
      maxContextTokens: 512000,
    },
  };
  const phase2 = buildConversationHudMetrics({
    conversationId: 'conv-orch-dual',
    sessionRevision: 2,
    modelId: 'Orchestrator (Carbon)',
    steps: [{ idx: 0, stepType: 14, status: 3 }, carbonStep, hydrogenStep1],
  });
  assert.equal(phase2.context.modelShortLabel, 'Hydrogen');
  assert.equal(phase2.context.modelCompactLabel, 'H');
  assert.equal(phase2.context.usedTokens, 401280);
  assert.equal(phase2.context.peakContextTokens, 401280, 'Hydrogen 当前模型峰值不得混入 Carbon 的 461,898');
  assert.equal(phase2.context.sessionPeakContextTokens, 461898);
  assert.equal(phase2.context.modelStages?.length, 2);
  assert.equal(phase2.context.modelStages?.[0]?.shortLabel, 'Carbon');
  assert.equal(phase2.context.modelStages?.[0]?.usedTokens, 461898);
  assert.equal(phase2.context.modelStages?.[0]?.peakContextTokens, 461898);
  assert.equal(phase2.context.modelStages?.[0]?.isActive, false);
  assert.equal(phase2.context.modelStages?.[1]?.shortLabel, 'Hydrogen');
  assert.equal(phase2.context.modelStages?.[1]?.usedTokens, 401280);
  assert.equal(phase2.context.modelStages?.[1]?.peakContextTokens, 401280);
  assert.equal(phase2.context.modelStages?.[1]?.isActive, true);

  // 3. Hydrogen 涨到 467,900：两模型水位与各自峰值独立更新
  const hydrogenStep2 = {
    idx: 3,
    stepType: 15,
    status: 3,
    hasUsage: true,
    startTimeSeconds: 120,
    endTimeSeconds: 126,
    rawInputTokens: 2425,
    cachedReadTokens: 465475,
    cacheWriteTokens: 0,
    outputTokens: 3732,
    generation: {
      modelEnum: 1669,
      responseModel: 'gemini-flash-worker-agy',
      modelDisplayName: 'Gemini 4 Hydrogen (Orchestrator)',
      maxContextTokens: 512000,
    },
  };
  const phase3 = buildConversationHudMetrics({
    conversationId: 'conv-orch-dual',
    sessionRevision: 3,
    modelId: 'Orchestrator (Carbon)',
    steps: [{ idx: 0, stepType: 14, status: 3 }, carbonStep, hydrogenStep1, hydrogenStep2],
  });
  assert.equal(phase3.context.usedTokens, 467900);
  assert.equal(phase3.context.peakContextTokens, 467900);
  assert.equal(phase3.context.usedRatioFormatted, '91.4%');
  assert.equal(phase3.context.modelStages?.[0]?.usedTokens, 461898);
  assert.equal(phase3.context.modelStages?.[0]?.usedRatioFormatted, '90.2%');
  assert.equal(phase3.context.modelStages?.[1]?.usedTokens, 467900);
  assert.equal(phase3.context.modelStages?.[1]?.peakContextTokens, 467900);

  // 4. 手动切换至尚未发言的 Claude Sonnet 4.6（200K）：不得拿 Hydrogen 的 467,900 除以 200,000
  const switchedPending = buildConversationHudMetrics({
    conversationId: 'conv-orch-dual',
    sessionRevision: 4,
    modelId: 'Claude Sonnet 4.6',
    steps: [{ idx: 0, stepType: 14, status: 3 }, carbonStep, hydrogenStep1, hydrogenStep2],
  });
  assert.equal(switchedPending.context.modelShortLabel, 'Hydrogen');
  assert.equal(switchedPending.context.usedTokens, 467900);
  assert.equal(switchedPending.context.capacityTokens, 512000, '未产生新步前不得拿新模型 200K 覆盖旧用量分母');
  assert.equal(switchedPending.context.usedRatioFormatted, '91.4%');
  assert.equal(switchedPending.context.modelStages?.length, 3);
  assert.equal(switchedPending.context.modelStages?.[2]?.modelId, 'claude-sonnet-4-6');
  assert.equal(switchedPending.context.modelStages?.[2]?.hasUsageData, false);
  assert.equal(switchedPending.context.modelStages?.[2]?.capacityTokens, 200000);
  assert.equal(switchedPending.context.modelStages?.[2]?.section, 'primary');
});

test('Case H: 独立 Hydrogen 切入未知执行器的 Orchestrator 仅显示通用待介入执行阶段与统一主列表，执行器介入后去重', () => {
  const standaloneHydrogenStep = {
    idx: 1,
    stepType: 15,
    status: 3,
    hasUsage: true,
    startTimeSeconds: 50,
    endTimeSeconds: 60,
    rawInputTokens: 20000,
    cachedReadTokens: 80000,
    cacheWriteTokens: 0,
    outputTokens: 500,
    generation: {
      responseModel: 'gemini-4-hydrogen',
      modelDisplayName: 'Gemini 4 Hydrogen (High)',
      maxContextTokens: 200000,
    },
  };
  const carbonStep = {
    idx: 3,
    stepType: 15,
    status: 3,
    hasUsage: true,
    startTimeSeconds: 100,
    endTimeSeconds: 110,
    rawInputTokens: 5000,
    cachedReadTokens: 455000,
    cacheWriteTokens: 0,
    outputTokens: 2000,
    generation: {
      modelEnum: 1667,
      responseModel: 'gemini-pro-orchestrator',
      modelDisplayName: 'Orchestrator (Carbon)',
      maxContextTokens: 512000,
    },
  };
  const hydrogenExecStep = {
    idx: 4,
    stepType: 15,
    status: 3,
    hasUsage: true,
    startTimeSeconds: 112,
    endTimeSeconds: 120,
    rawInputTokens: 300000,
    cachedReadTokens: 100000,
    cacheWriteTokens: 0,
    outputTokens: 1500,
    generation: {
      modelEnum: 1669,
      responseModel: 'gemini-flash-worker-agy',
      modelDisplayName: 'Gemini 4 Hydrogen (Orchestrator)',
      maxContextTokens: 512000,
    },
  };

  // 1. 仅选中 Orchestrator (Carbon)，尚未跑 Carbon 与执行器：Carbon(primary) + pending(primary) + 历史 Hydrogen(primary)
  const pendingCarbon = buildConversationHudMetrics({
    conversationId: 'conv-standalone-to-orch',
    sessionRevision: 1,
    modelId: 'Orchestrator (Carbon)',
    steps: [{ idx: 0, stepType: 14, status: 3 }, standaloneHydrogenStep],
  });
  assert.equal(pendingCarbon.context.isOrchestrator, true);
  assert.equal(pendingCarbon.context.modelStages?.length, 3);
  assert.equal(pendingCarbon.context.modelStages?.[0]?.slotKey, 'orchestrator:carbon');
  assert.equal(pendingCarbon.context.modelStages?.[0]?.section, 'primary');
  assert.equal(pendingCarbon.context.modelStages?.[1]?.slotKey, 'orchestrator:executor_pending');
  assert.equal(pendingCarbon.context.modelStages?.[1]?.shortLabel, '');
  assert.equal(pendingCarbon.context.modelStages?.[1]?.section, 'primary');
  assert.equal(pendingCarbon.context.modelStages?.[2]?.slotKey, 'model:gemini-4-hydrogen');
  assert.equal(pendingCarbon.context.modelStages?.[2]?.section, 'primary');
  assert.equal(pendingCarbon.context.modelStages?.filter((s) => s.modelId === 'gemini-4-hydrogen').length, 1);

  // 2. Carbon 规划阶段完成、执行器仍未运行：统一在 primary 列表中保留历史 Hydrogen，总计仅 1 个 Hydrogen
  const beforeExecutor = buildConversationHudMetrics({
    conversationId: 'conv-standalone-to-orch',
    sessionRevision: 2,
    modelId: 'Orchestrator (Carbon)',
    steps: [
      { idx: 0, stepType: 14, status: 3 },
      standaloneHydrogenStep,
      { idx: 2, stepType: 14, status: 3 },
      carbonStep,
    ],
  });
  assert.equal(beforeExecutor.context.isOrchestrator, true);
  assert.equal(beforeExecutor.context.modelStages?.length, 3);
  assert.equal(beforeExecutor.context.modelStages?.[0]?.slotKey, 'orchestrator:carbon');
  assert.equal(beforeExecutor.context.modelStages?.[0]?.section, 'primary');
  assert.equal(beforeExecutor.context.modelStages?.[0]?.isActive, true);
  assert.equal(beforeExecutor.context.modelStages?.[1]?.slotKey, 'orchestrator:executor_pending');
  assert.equal(beforeExecutor.context.modelStages?.[1]?.shortLabel, '');
  assert.equal(beforeExecutor.context.modelStages?.[1]?.section, 'primary');
  assert.equal(beforeExecutor.context.modelStages?.[1]?.capacityTokens, 512000);
  assert.equal(beforeExecutor.context.modelStages?.[2]?.slotKey, 'model:gemini-4-hydrogen');
  assert.equal(beforeExecutor.context.modelStages?.[2]?.section, 'primary');
  assert.equal(beforeExecutor.context.modelStages?.filter((s) => s.modelId === 'gemini-4-hydrogen').length, 1);

  // 3. Hydrogen 执行器运行后：历史独立 Hydrogen 被去重吸收，仅保留 Carbon + Orchestrator Hydrogen 2 个主阶段
  const afterExecutor = buildConversationHudMetrics({
    conversationId: 'conv-standalone-to-orch',
    sessionRevision: 3,
    modelId: 'Orchestrator (Carbon)',
    steps: [
      { idx: 0, stepType: 14, status: 3 },
      standaloneHydrogenStep,
      { idx: 2, stepType: 14, status: 3 },
      carbonStep,
      hydrogenExecStep,
    ],
  });
  assert.equal(afterExecutor.context.isOrchestrator, true);
  assert.equal(afterExecutor.context.modelStages?.length, 2);
  assert.equal(afterExecutor.context.modelStages?.[0]?.slotKey, 'orchestrator:carbon');
  assert.equal(afterExecutor.context.modelStages?.[0]?.section, 'primary');
  assert.equal(afterExecutor.context.modelStages?.[1]?.slotKey, 'orchestrator:hydrogen');
  assert.equal(afterExecutor.context.modelStages?.[1]?.role, 'executor');
  assert.equal(afterExecutor.context.modelStages?.[1]?.section, 'primary');
  assert.equal(afterExecutor.context.modelStages?.[1]?.isActive, true);
  assert.equal(afterExecutor.context.modelStages?.filter((s) => s.modelId === 'gemini-4-hydrogen').length, 1);
});

test('Case I: Orchestrator 后新轮切回独立 Gemini 4 Hydrogen (High) 保持非 Orchestrator 上下文上限并保留曾用 executor 角色去重', () => {
  const carbonStep = {
    idx: 1,
    stepType: 15,
    status: 3,
    hasUsage: true,
    startTimeSeconds: 100,
    endTimeSeconds: 110,
    rawInputTokens: 2000,
    cachedReadTokens: 458000,
    cacheWriteTokens: 0,
    outputTokens: 1000,
    generation: {
      modelEnum: 1667,
      responseModel: 'gemini-pro-orchestrator',
      modelDisplayName: 'Orchestrator (Carbon)',
      maxContextTokens: 512000,
    },
  };
  const hydrogenExecStep = {
    idx: 2,
    stepType: 15,
    status: 3,
    hasUsage: true,
    startTimeSeconds: 112,
    endTimeSeconds: 120,
    rawInputTokens: 350000,
    cachedReadTokens: 50000,
    cacheWriteTokens: 0,
    outputTokens: 800,
    generation: {
      modelEnum: 1669,
      responseModel: 'gemini-flash-worker-agy',
      modelDisplayName: 'Gemini 4 Hydrogen (Orchestrator)',
      maxContextTokens: 512000,
    },
  };
  const standaloneTurn2Step = {
    idx: 4,
    stepType: 15,
    status: 3,
    hasUsage: true,
    startTimeSeconds: 200,
    endTimeSeconds: 210,
    rawInputTokens: 60000,
    cachedReadTokens: 20000,
    cacheWriteTokens: 0,
    outputTokens: 300,
    generation: {
      responseModel: 'gemini-4-hydrogen',
      modelDisplayName: 'Gemini 4 Hydrogen (High)',
      maxContextTokens: 200000,
    },
  };

  const res = buildConversationHudMetrics({
    conversationId: 'conv-orch-to-standalone-hydrogen',
    sessionRevision: 1,
    modelId: 'Gemini 4 Hydrogen (High)',
    steps: [
      { idx: 0, stepType: 14, status: 3 },
      carbonStep,
      hydrogenExecStep,
      { idx: 3, stepType: 14, status: 3 },
      standaloneTurn2Step,
    ],
  });

  assert.equal(Boolean(res.context.isOrchestrator), false);
  assert.equal(res.context.isMultiModel, true);
  assert.equal(res.context.modelId, 'gemini-4-hydrogen');
  assert.equal(res.context.usedTokens, 80000);
  assert.equal(res.context.capacityTokens, 200000);
  assert.equal(res.context.modelStages?.length, 2);
  assert.equal(res.context.modelStages?.[0]?.slotKey, 'orchestrator:carbon');
  assert.equal(res.context.modelStages?.[0]?.role, 'planner');
  assert.equal(res.context.modelStages?.[0]?.section, 'primary');
  assert.equal(res.context.modelStages?.[0]?.isActive, false);
  assert.equal(res.context.modelStages?.[1]?.slotKey, 'orchestrator:hydrogen');
  assert.equal(res.context.modelStages?.[1]?.role, 'executor');
  assert.equal(res.context.modelStages?.[1]?.section, 'primary');
  assert.equal(res.context.modelStages?.[1]?.isActive, true);
  assert.equal(res.context.modelStages?.[1]?.usedTokens, 80000);
  assert.equal(res.context.modelStages?.filter((s) => s.modelId === 'gemini-4-hydrogen').length, 1);

  // 同理，若第 2 轮步骤仅通过 step.modelName / modelId 传入（无 generation），仍必须保留独立模型 200K 上限且保留 executor 角色标记
  const resFallbackModel = buildConversationHudMetrics({
    conversationId: 'conv-orch-to-standalone-hydrogen-fallback',
    sessionRevision: 2,
    modelId: 'Gemini 4 Hydrogen (High)',
    steps: [
      { idx: 0, stepType: 14, status: 3 },
      carbonStep,
      hydrogenExecStep,
      { idx: 3, stepType: 14, status: 3 },
      { ...standaloneTurn2Step, generation: undefined, modelName: 'Gemini 4 Hydrogen (High)' },
    ],
  });
  assert.equal(Boolean(resFallbackModel.context.isOrchestrator), false);
  assert.equal(resFallbackModel.context.capacityTokens, 200000);
  assert.equal(resFallbackModel.context.modelStages?.length, 2);
  assert.equal(resFallbackModel.context.modelStages?.[1]?.slotKey, 'orchestrator:hydrogen');
  assert.equal(resFallbackModel.context.modelStages?.[1]?.role, 'executor');
  assert.equal(resFallbackModel.context.modelStages?.[1]?.isActive, true);
  assert.equal(resFallbackModel.context.modelStages?.filter((s) => s.modelId === 'gemini-4-hydrogen').length, 1);
});

test('Case J: 独立 Hydrogen (167K/512K) 切入 Neon+Hydrogen Orchestrator 规划阶段立即吸收不重复、执行后阶段数与角色稳定', (t) => {
  t.after(() => clearObservedIdeModelsForTest());
  clearObservedIdeModelsForTest();
  registerObservedIdeModels([
    { modelId: 'gemini-4-neon', displayName: 'Gemini 4 Neon (High)', modelOrAlias: 'MODEL_PLACEHOLDER_M532', modelEnum: 1532 },
    { modelId: 'gemini-4-hydrogen', displayName: 'Gemini 4 Hydrogen (XHigh)', modelOrAlias: 'MODEL_PLACEHOLDER_M528', modelEnum: 1528 },
  ]);

  const standaloneHydrogenStep = {
    idx: 1,
    stepType: 15,
    status: 3,
    hasUsage: true,
    startTimeSeconds: 50,
    endTimeSeconds: 60,
    rawInputTokens: 17000,
    cachedReadTokens: 150000,
    cacheWriteTokens: 0,
    outputTokens: 600,
    generation: {
      responseModel: 'gemini-4-hydrogen',
      modelDisplayName: 'Gemini 4 Hydrogen (High)',
      maxContextTokens: 512000,
    },
  };
  const neonPlannerStep = {
    idx: 3,
    stepType: 15,
    status: 3,
    hasUsage: true,
    startTimeSeconds: 100,
    endTimeSeconds: 112,
    rawInputTokens: 8000,
    cachedReadTokens: 92000,
    cacheWriteTokens: 0,
    outputTokens: 900,
    generation: {
      modelEnum: 1532,
      planModelEnum: 1532,
      executionModelEnum: 1528,
      responseModel: 'gemini-4-neon',
      modelDisplayName: 'Gemini 4 Neon (High)',
      maxContextTokens: 512000,
    },
  };
  const hydrogenExecStep = {
    idx: 4,
    stepType: 15,
    status: 3,
    hasUsage: true,
    startTimeSeconds: 115,
    endTimeSeconds: 122,
    rawInputTokens: 12000,
    cachedReadTokens: 168000,
    cacheWriteTokens: 0,
    outputTokens: 700,
    generation: {
      modelEnum: 1528,
      planModelEnum: 1528,
      executionModelEnum: 1528,
      responseModel: 'gemini-4-hydrogen',
      modelDisplayName: 'Gemini 4 Hydrogen (XHigh)',
      maxContextTokens: 512000,
    },
  };

  // 0. 刚切换至 Orchestrator (Neon 规划 + Hydrogen 待介入执行器)、Neon 尚未发言前：直接吸收历史 Hydrogen 至 executor 槽位，不出现待介入重复行
  const beforeNeonPlan = buildConversationHudMetrics({
    conversationId: 'conv-orch-hydrogen-absorb-preplan',
    sessionRevision: 0,
    modelId: 'Orchestrator Gemini 4 Neon High',
    executorMetadata: {
      planModelEnum: 1532,
      executionModelEnum: 1528,
      checkpointMaxTokenLimit: 512000,
    },
    steps: [{ idx: 0, stepType: 14, status: 3 }, standaloneHydrogenStep],
  });
  assert.equal(beforeNeonPlan.context.isOrchestrator, true);
  assert.equal(beforeNeonPlan.context.modelStages?.length, 2);
  assert.equal(beforeNeonPlan.context.modelStages?.filter((s) => s.modelId === 'gemini-4-hydrogen').length, 1);
  assert.equal(beforeNeonPlan.context.modelStages?.[0]?.slotKey, 'orchestrator:neon');
  assert.equal(beforeNeonPlan.context.modelStages?.[0]?.role, 'planner');
  assert.equal(beforeNeonPlan.context.modelStages?.[0]?.hasUsageData, false);
  assert.equal(beforeNeonPlan.context.modelStages?.[0]?.capacityTokens, 512000);
  assert.equal(beforeNeonPlan.context.modelStages?.[0]?.isActive, false);
  assert.equal(beforeNeonPlan.context.modelStages?.[1]?.slotKey, 'orchestrator:hydrogen');
  assert.equal(beforeNeonPlan.context.modelStages?.[1]?.role, 'executor');
  assert.equal(beforeNeonPlan.context.modelStages?.[1]?.hasUsageData, true);
  assert.equal(beforeNeonPlan.context.modelStages?.[1]?.usedTokens, 167000);
  assert.equal(beforeNeonPlan.context.modelStages?.[1]?.isActive, true);

  // 1. 先运行独立 Hydrogen (167K / 512K)，再进入 Orchestrator (Neon 规划 + Hydrogen 待介入执行器)
  const planningPhase = buildConversationHudMetrics({
    conversationId: 'conv-orch-hydrogen-absorb-planning',
    sessionRevision: 1,
    modelId: 'Orchestrator Gemini 4 Neon High',
    executorMetadata: {
      planModelEnum: 1532,
      executionModelEnum: 1528,
      checkpointMaxTokenLimit: 512000,
    },
    steps: [
      { idx: 0, stepType: 14, status: 3 },
      standaloneHydrogenStep,
      { idx: 2, stepType: 14, status: 3 },
      neonPlannerStep,
    ],
  });
  assert.equal(planningPhase.context.isOrchestrator, true);
  assert.equal(planningPhase.context.modelStages?.length, 2, '规划阶段不得同时出现 pending executor 与历史 Hydrogen');
  assert.equal(planningPhase.context.modelStages?.filter((s) => s.modelId === 'gemini-4-hydrogen').length, 1);
  assert.equal(planningPhase.context.modelStages?.[0]?.slotKey, 'orchestrator:neon');
  assert.equal(planningPhase.context.modelStages?.[0]?.role, 'planner');
  assert.equal(planningPhase.context.modelStages?.[0]?.section, 'primary');
  assert.equal(planningPhase.context.modelStages?.[0]?.isActive, true);
  assert.equal(planningPhase.context.modelStages?.[1]?.slotKey, 'orchestrator:hydrogen');
  assert.equal(planningPhase.context.modelStages?.[1]?.role, 'executor');
  assert.equal(planningPhase.context.modelStages?.[1]?.section, 'primary');
  assert.equal(planningPhase.context.modelStages?.[1]?.hasUsageData, true);
  assert.equal(planningPhase.context.modelStages?.[1]?.usedTokens, 167000);
  assert.equal(planningPhase.context.modelStages?.[1]?.capacityTokens, 512000);
  assert.equal(planningPhase.context.modelStages?.[1]?.isActive, false);

  // 2. Hydrogen 执行器实际运行一步后：阶段总数保持 2、角色保持 executor、无跳变或突然消失
  const execPhase = buildConversationHudMetrics({
    conversationId: 'conv-orch-hydrogen-absorb-planning',
    sessionRevision: 2,
    modelId: 'Orchestrator Gemini 4 Neon High',
    executorMetadata: {
      planModelEnum: 1532,
      executionModelEnum: 1528,
      checkpointMaxTokenLimit: 512000,
    },
    steps: [
      { idx: 0, stepType: 14, status: 3 },
      standaloneHydrogenStep,
      { idx: 2, stepType: 14, status: 3 },
      neonPlannerStep,
      hydrogenExecStep,
    ],
  });
  assert.equal(execPhase.context.isOrchestrator, true);
  assert.equal(execPhase.context.modelStages?.length, 2);
  assert.equal(execPhase.context.modelStages?.filter((s) => s.modelId === 'gemini-4-hydrogen').length, 1);
  assert.equal(execPhase.context.modelStages?.[0]?.role, 'planner');
  assert.equal(execPhase.context.modelStages?.[0]?.isActive, false);
  assert.equal(execPhase.context.modelStages?.[1]?.slotKey, 'orchestrator:hydrogen');
  assert.equal(execPhase.context.modelStages?.[1]?.role, 'executor');
  assert.equal(execPhase.context.modelStages?.[1]?.section, 'primary');
  assert.equal(execPhase.context.modelStages?.[1]?.isActive, true);
  assert.equal(execPhase.context.modelStages?.[1]?.usedTokens, 180000);
  assert.equal(execPhase.context.modelStages?.[1]?.peakContextTokens, 180000);
});

test('Case K: Orchestrator (Neon + Hydrogen) 后切至第 3 个模型 Claude，Neon/Hydrogen 仍保留 planner/executor 角色', (t) => {
  t.after(() => clearObservedIdeModelsForTest());
  clearObservedIdeModelsForTest();
  registerObservedIdeModels([
    { modelId: 'gemini-4-neon', displayName: 'Gemini 4 Neon (High)', modelOrAlias: 'MODEL_PLACEHOLDER_M532', modelEnum: 1532 },
    { modelId: 'gemini-4-hydrogen', displayName: 'Gemini 4 Hydrogen (XHigh)', modelOrAlias: 'MODEL_PLACEHOLDER_M528', modelEnum: 1528 },
  ]);

  const neonPlannerStep = {
    idx: 1,
    stepType: 15,
    status: 3,
    hasUsage: true,
    startTimeSeconds: 100,
    endTimeSeconds: 110,
    rawInputTokens: 5000,
    cachedReadTokens: 85000,
    cacheWriteTokens: 0,
    outputTokens: 600,
    generation: {
      modelEnum: 1532,
      planModelEnum: 1532,
      executionModelEnum: 1528,
      responseModel: 'gemini-4-neon',
      modelDisplayName: 'Gemini 4 Neon (High)',
      maxContextTokens: 512000,
    },
  };
  const hydrogenExecStep = {
    idx: 2,
    stepType: 15,
    status: 3,
    hasUsage: true,
    startTimeSeconds: 112,
    endTimeSeconds: 120,
    rawInputTokens: 10000,
    cachedReadTokens: 120000,
    cacheWriteTokens: 0,
    outputTokens: 700,
    generation: {
      modelEnum: 1528,
      planModelEnum: 1528,
      executionModelEnum: 1528,
      responseModel: 'gemini-4-hydrogen',
      modelDisplayName: 'Gemini 4 Hydrogen (XHigh)',
      maxContextTokens: 512000,
    },
  };
  const claudeStep = {
    idx: 4,
    stepType: 15,
    status: 3,
    hasUsage: true,
    startTimeSeconds: 200,
    endTimeSeconds: 210,
    rawInputTokens: 15000,
    cachedReadTokens: 45000,
    cacheWriteTokens: 0,
    outputTokens: 500,
    generation: {
      responseModel: 'claude-opus-4-6-thinking',
      modelDisplayName: 'Claude Opus 4.6 (Thinking)',
      maxContextTokens: 200000,
    },
  };

  const switchedToClaude = buildConversationHudMetrics({
    conversationId: 'conv-orch-then-claude',
    sessionRevision: 1,
    modelId: 'Claude Opus 4.6 (Thinking)',
    steps: [
      { idx: 0, stepType: 14, status: 3 },
      neonPlannerStep,
      hydrogenExecStep,
      { idx: 3, stepType: 14, status: 3 },
      claudeStep,
    ],
  });
  assert.equal(Boolean(switchedToClaude.context.isOrchestrator), false);
  assert.equal(switchedToClaude.context.isMultiModel, true);
  assert.equal(switchedToClaude.context.modelStages?.length, 3);
  assert.equal(switchedToClaude.context.modelStages?.[0]?.modelId, 'gemini-4-neon');
  assert.equal(switchedToClaude.context.modelStages?.[0]?.role, 'planner');
  assert.equal(switchedToClaude.context.modelStages?.[0]?.section, 'primary');
  assert.equal(switchedToClaude.context.modelStages?.[0]?.isActive, false);
  assert.equal(switchedToClaude.context.modelStages?.[1]?.modelId, 'gemini-4-hydrogen');
  assert.equal(switchedToClaude.context.modelStages?.[1]?.role, 'executor');
  assert.equal(switchedToClaude.context.modelStages?.[1]?.section, 'primary');
  assert.equal(switchedToClaude.context.modelStages?.[1]?.isActive, false);
  assert.equal(switchedToClaude.context.modelStages?.[2]?.modelId, 'claude-opus-4-6');
  assert.equal(switchedToClaude.context.modelStages?.[2]?.role, 'model');
  assert.equal(switchedToClaude.context.modelStages?.[2]?.section, 'primary');
  assert.equal(switchedToClaude.context.modelStages?.[2]?.isActive, true);
});

test('Case L: 独立模型切至 Orchestrator/新模型思考与首步流式瞬时切换矩阵 (Scenarios 1-6)', async (t) => {
  t.after(() => clearObservedIdeModelsForTest());
  clearObservedIdeModelsForTest();
  registerObservedIdeModels([
    { modelId: 'gemini-4-neon', displayName: 'Gemini 4 Neon (High)', modelOrAlias: 'MODEL_PLACEHOLDER_M532', modelEnum: 1532 },
    { modelId: 'gemini-4-hydrogen', displayName: 'Gemini 4 Hydrogen (XHigh)', modelOrAlias: 'MODEL_PLACEHOLDER_M528', modelEnum: 1528 },
  ]);

  const standaloneHydrogenTurn1 = {
    idx: 1,
    stepType: 15,
    status: 3,
    hasUsage: true,
    startTimeSeconds: 50,
    endTimeSeconds: 60,
    rawInputTokens: 12000,
    cachedReadTokens: 80000,
    cacheWriteTokens: 0,
    outputTokens: 500,
    generation: {
      responseModel: 'gemini-4-hydrogen',
      modelDisplayName: 'Gemini 4 Hydrogen (High)',
      maxContextTokens: 200000,
    },
  };

  // Scenario 1: Turn 1 standalone Hydrogen -> switch to Orchestrator Neon & Turn 2 started (stepType: 14, isStreaming: true, executorMetadata) before Neon usage
  const s1 = buildConversationHudMetrics({
    conversationId: 'conv-s1-switch-to-orch',
    sessionRevision: 1,
    modelId: 'Orchestrator Gemini 4 Neon High',
    isStreaming: true,
    executorMetadata: {
      planModelEnum: 1532,
      executionModelEnum: 1528,
      checkpointMaxTokenLimit: 512000,
    },
    steps: [
      { idx: 0, stepType: 14, status: 3 },
      standaloneHydrogenTurn1,
      { idx: 2, stepType: 14, status: 3 },
    ],
  });
  assert.equal(s1.context.modelShortLabel, 'Neon');
  assert.equal(s1.context.modelId, 'gemini-4-neon');
  assert.equal(s1.context.hasUsageData, false);
  assert.equal(s1.context.usedTokens, 0);
  assert.equal(s1.context.usedRatio, 0);
  assert.equal(s1.context.capacityTokens, 512000);
  assert.equal(s1.context.modelStages?.length, 2);
  assert.equal(s1.context.modelStages?.[0]?.modelId, 'gemini-4-neon');
  assert.equal(s1.context.modelStages?.[0]?.isActive, true);
  assert.equal(s1.context.modelStages?.[0]?.hasUsageData, false);
  assert.equal(s1.context.modelStages?.[1]?.modelId, 'gemini-4-hydrogen');
  assert.equal(s1.context.modelStages?.[1]?.isActive, false);
  assert.equal(s1.context.modelStages?.[1]?.usedTokens, 92000);
  assert.equal(s1.context.modelStages?.[1]?.capacityTokens, 200000, 'Turn 1 Hydrogen 应保留自身 200K 显式上限，不被 Turn 2 executorMetadata 污染');

  // Scenario 2a (单元测试): Turn 2 Neon stepType: 15, status: 2, hasUsage: false 且含 estimatedTokensUsed: 120000
  const neonEstimatedStep = {
    idx: 3,
    stepType: 15,
    status: 2,
    hasUsage: false,
    startTimeSeconds: 100,
    rawInputTokens: 99999,
    cachedReadTokens: 88888,
    outputTokens: 77777,
    generation: {
      modelEnum: 1532,
      planModelEnum: 1532,
      executionModelEnum: 1528,
      responseModel: 'gemini-4-neon',
      modelDisplayName: 'Gemini 4 Neon (High)',
      maxContextTokens: 512000,
      estimatedTokensUsed: 120000,
    },
  };
  const s2Unit = buildConversationHudMetrics({
    conversationId: 'conv-s2-estimated-ctx',
    sessionRevision: 1,
    modelId: 'Orchestrator Gemini 4 Neon High',
    isStreaming: true,
    executorMetadata: {
      planModelEnum: 1532,
      executionModelEnum: 1528,
      checkpointMaxTokenLimit: 512000,
    },
    steps: [
      { idx: 0, stepType: 14, status: 3 },
      standaloneHydrogenTurn1,
      { idx: 2, stepType: 14, status: 3 },
      neonEstimatedStep,
    ],
  });
  assert.equal(s2Unit.context.modelShortLabel, 'Neon');
  assert.equal(s2Unit.context.modelId, 'gemini-4-neon');
  assert.equal(s2Unit.context.hasUsageData, true);
  assert.equal(s2Unit.context.usedTokens, 120000);
  assert.equal(s2Unit.session.samples?.usage, 1, 'estimatedTokensUsed 不得污染 usageSampleCount');

  // Scenario 2b (端到端临时 SQLite DB): 经过 ConversationMetricsEngine.getConversationMetrics 验证 gen_metadata 回填 estimatedTokensUsed
  const { DatabaseSync } = await import('node:sqlite');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gravitybox-hud-s2-'));
  try {
    const convId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const dbPath = path.join(tmpDir, `${convId}.db`);
    const encodeVarint = (val) => {
      const bytes = [];
      let v = BigInt(val);
      while (v >= 0x80n) {
        bytes.push(Number((v & 0x7fn) | 0x80n));
        v >>= 7n;
      }
      bytes.push(Number(v));
      return bytes;
    };
    const encodeSubmessage = (fieldNum, innerBytes) => [
      ...encodeVarint((fieldNum << 3) | 2),
      ...encodeVarint(innerBytes.length),
      ...innerBytes,
    ];
    const encodeStr = (fieldNum, str) => encodeSubmessage(fieldNum, [...Buffer.from(str, 'utf8')]);
    const encodeTs = (fieldNum, seconds) => encodeSubmessage(fieldNum, [0x08, ...encodeVarint(seconds), 0x10, 0x00]);
    const encodeUsage = ({ rawInput = 0, outputTokens = 0, cachedTokens = 0 }) =>
      encodeSubmessage(9, [
        (2 << 3) | 0, ...encodeVarint(rawInput),
        (3 << 3) | 0, ...encodeVarint(outputTokens),
        (5 << 3) | 0, ...encodeVarint(cachedTokens),
      ]);

    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER NOT NULL, status INTEGER NOT NULL, metadata BLOB);
      CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
      CREATE TABLE executor_metadata (id TEXT PRIMARY KEY, data BLOB);
    `);

    const execHex1 = '1122334455667788';
    const execHex2 = '99aabbccddeeff00';
    db.prepare('INSERT INTO steps VALUES (?, ?, ?, ?)').run(0, 14, 3, null);
    db.prepare('INSERT INTO steps VALUES (?, ?, ?, ?)').run(
      1,
      15,
      3,
      Buffer.from([
        ...encodeTs(1, 1794285000),
        ...encodeTs(8, 1794285008),
        ...encodeUsage({ rawInput: 12000, cachedTokens: 80000, outputTokens: 500 }),
        ...encodeSubmessage(12, [...Buffer.from(execHex1, 'hex')]),
      ])
    );
    db.prepare('INSERT INTO steps VALUES (?, ?, ?, ?)').run(2, 14, 3, null);
    db.prepare('INSERT INTO steps VALUES (?, ?, ?, ?)').run(
      3,
      15,
      2,
      Buffer.from([
        ...encodeTs(1, 1794285010),
        ...encodeSubmessage(12, [...Buffer.from(execHex2, 'hex')]),
      ])
    );

    // gen_metadata 0: Turn 1 Hydrogen usage + 200K 上限
    const hCwMeta = [(4 << 3) | 0, ...encodeVarint(200000)];
    const hChatModel = [
      ...encodeSubmessage(4, [
        (2 << 3) | 0, ...encodeVarint(12000),
        (3 << 3) | 0, ...encodeVarint(500),
        (5 << 3) | 0, ...encodeVarint(80000),
      ]),
      ...encodeSubmessage(9, encodeSubmessage(10, hCwMeta)),
      ...encodeStr(19, 'gemini-4-hydrogen'),
      ...encodeStr(21, 'Gemini 4 Hydrogen (High)'),
    ];
    db.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(
      0,
      Buffer.from([
        ...encodeSubmessage(1, hChatModel),
        ...encodeSubmessage(2, encodeVarint(1)),
        ...encodeSubmessage(4, [...Buffer.from(execHex1, 'hex')]),
      ])
    );

    // gen_metadata 1: Turn 2 Neon 仅有模型标识（无 estimatedTokensUsed、无 usage）
    const nPlannerCfg = [
      (1 << 3) | 0, ...encodeVarint(1532),
      ...encodeSubmessage(60, [(1 << 3) | 0, ...encodeVarint(1528)]),
    ];
    const nChatModelIdentity = [
      (3 << 3) | 0, ...encodeVarint(1532),
      ...encodeSubmessage(9, encodeSubmessage(10, [(4 << 3) | 0, ...encodeVarint(512000)])),
      ...encodeStr(19, 'gemini-4-neon'),
      ...encodeStr(21, 'Gemini 4 Neon (High)'),
    ];
    db.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(
      1,
      Buffer.from([
        ...encodeSubmessage(1, nChatModelIdentity),
        ...encodeSubmessage(2, encodeVarint(3)),
        ...encodeSubmessage(3, nPlannerCfg),
        ...encodeSubmessage(4, [...Buffer.from(execHex2, 'hex')]),
      ])
    );

    // gen_metadata 2: 后续关联同一 executionId 的 gen_metadata 回填 estimatedTokensUsed=120000，且不覆盖原有模型身份
    const nChatModelEstOnly = [
      ...encodeSubmessage(9, encodeSubmessage(10, [(1 << 3) | 0, ...encodeVarint(120000)])),
    ];
    db.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(
      2,
      Buffer.from([
        ...encodeSubmessage(1, nChatModelEstOnly),
        ...encodeSubmessage(2, encodeVarint(3)),
        ...encodeSubmessage(4, [...Buffer.from(execHex2, 'hex')]),
      ])
    );

    // executor_metadata: Turn 2 Orchestrator (Neon=1532 + Hydrogen=1528, 512K)
    const execBlob = Buffer.from(
      encodeSubmessage(10, [
        ...encodeSubmessage(1, nPlannerCfg),
        ...encodeSubmessage(2, [(5 << 3) | 0, ...encodeVarint(512000)]),
      ])
    );
    db.prepare('INSERT INTO executor_metadata VALUES (?, ?)').run('main', execBlob);

    const engine = new ConversationMetricsEngine({ conversationsDir: tmpDir });
    const e2eMetrics = await engine.getConversationMetrics({
      conversationId: convId,
      sessionRevision: 1,
      modelId: 'Orchestrator Gemini 4 Neon High',
      isStreaming: true,
    });
    assert.equal(e2eMetrics.context.modelShortLabel, 'Neon');
    assert.equal(e2eMetrics.context.modelId, 'gemini-4-neon');
    assert.equal(e2eMetrics.context.hasUsageData, true);
    assert.equal(e2eMetrics.context.usedTokens, 120000);
    assert.equal(e2eMetrics.context.capacityTokens, 512000);
    assert.equal(e2eMetrics.tokens.totalTokens, 92500, 'estimatedTokensUsed 不得污染 totalTokens');
    assert.equal(e2eMetrics.session.samples?.usage, 1, 'estimatedTokensUsed 不得污染 usageSampleCount');
    assert.equal(e2eMetrics.context.modelStages?.[1]?.capacityTokens, 200000);
    engine.clearCache();
    db.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // Scenario 3 (防误切 A): Turn 1 Hydrogen 仍在流式生成中，用户预先下拉切换 Orchestrator Neon -> 必须停留在 Hydrogen
  const s3 = buildConversationHudMetrics({
    conversationId: 'conv-s3-anti-premature-switch',
    sessionRevision: 1,
    modelId: 'Orchestrator Gemini 4 Neon High',
    isStreaming: true,
    executorMetadata: {
      planModelEnum: 1532,
      executionModelEnum: 1528,
      checkpointMaxTokenLimit: 512000,
    },
    steps: [
      { idx: 0, stepType: 14, status: 3 },
      { ...standaloneHydrogenTurn1, status: 2 },
    ],
  });
  assert.equal(s3.context.modelShortLabel, 'Hydrogen');
  assert.equal(s3.context.modelId, 'gemini-4-hydrogen');
  assert.equal(s3.context.hasUsageData, true);
  assert.equal(s3.context.usedTokens, 92000);

  // Scenario 4 (防误切 B): Turn 2 Neon 规划完毕，Hydrogen 执行器已运行或正在工具思考 -> 不得跳回 Neon
  const neonTurn2Step = {
    idx: 3,
    stepType: 15,
    status: 3,
    hasUsage: true,
    startTimeSeconds: 100,
    endTimeSeconds: 110,
    rawInputTokens: 5000,
    cachedReadTokens: 90000,
    cacheWriteTokens: 0,
    outputTokens: 600,
    generation: {
      modelEnum: 1532,
      planModelEnum: 1532,
      executionModelEnum: 1528,
      responseModel: 'gemini-4-neon',
      modelDisplayName: 'Gemini 4 Neon (High)',
      maxContextTokens: 512000,
    },
  };
  const hydrogenTurn2ExecStep = {
    idx: 4,
    stepType: 15,
    status: 3,
    hasUsage: true,
    startTimeSeconds: 112,
    endTimeSeconds: 118,
    rawInputTokens: 10000,
    cachedReadTokens: 130000,
    cacheWriteTokens: 0,
    outputTokens: 700,
    generation: {
      modelEnum: 1528,
      planModelEnum: 1528,
      executionModelEnum: 1528,
      responseModel: 'gemini-4-hydrogen',
      modelDisplayName: 'Gemini 4 Hydrogen (XHigh)',
      maxContextTokens: 512000,
    },
  };
  const s4 = buildConversationHudMetrics({
    conversationId: 'conv-s4-executor-stays-hydrogen',
    sessionRevision: 1,
    modelId: 'Orchestrator Gemini 4 Neon High',
    isStreaming: true,
    executorMetadata: {
      planModelEnum: 1532,
      executionModelEnum: 1528,
      checkpointMaxTokenLimit: 512000,
    },
    steps: [
      { idx: 0, stepType: 14, status: 3 },
      standaloneHydrogenTurn1,
      { idx: 2, stepType: 14, status: 3 },
      neonTurn2Step,
      hydrogenTurn2ExecStep,
      { idx: 5, stepType: 21, status: 2, startTimeSeconds: 119 },
    ],
  });
  assert.equal(s4.context.modelShortLabel, 'Hydrogen');
  assert.equal(s4.context.modelId, 'gemini-4-hydrogen');
  assert.equal(s4.context.usedTokens, 140000);

  // Scenario 5 (切回历史模型): Turn 1 Neon -> Turn 2 Hydrogen -> Turn 3 刚切回 Neon 发起流式 -> 立即激活 Neon 并恢复 Turn 1 自有上下文水位
  const neonTurn1Step = {
    idx: 1,
    stepType: 15,
    status: 3,
    hasUsage: true,
    startTimeSeconds: 20,
    endTimeSeconds: 30,
    rawInputTokens: 5000,
    cachedReadTokens: 90000,
    cacheWriteTokens: 0,
    outputTokens: 400,
    generation: {
      responseModel: 'gemini-4-neon',
      modelDisplayName: 'Gemini 4 Neon (High)',
      maxContextTokens: 512000,
    },
  };
  const hydrogenTurn2Standalone = {
    idx: 3,
    stepType: 15,
    status: 3,
    hasUsage: true,
    startTimeSeconds: 50,
    endTimeSeconds: 60,
    rawInputTokens: 12000,
    cachedReadTokens: 80000,
    cacheWriteTokens: 0,
    outputTokens: 500,
    generation: {
      responseModel: 'gemini-4-hydrogen',
      modelDisplayName: 'Gemini 4 Hydrogen (High)',
      maxContextTokens: 200000,
    },
  };
  const s5 = buildConversationHudMetrics({
    conversationId: 'conv-s5-switch-back-to-prior',
    sessionRevision: 1,
    modelId: 'Gemini 4 Neon (High)',
    isStreaming: true,
    steps: [
      { idx: 0, stepType: 14, status: 3 },
      neonTurn1Step,
      { idx: 2, stepType: 14, status: 3 },
      hydrogenTurn2Standalone,
      { idx: 4, stepType: 14, status: 3 },
    ],
  });
  assert.equal(s5.context.modelShortLabel, 'Neon');
  assert.equal(s5.context.modelId, 'gemini-4-neon');
  assert.equal(s5.context.hasUsageData, true);
  assert.equal(s5.context.usedTokens, 95000, '切回历史模型时应恢复 Turn 1 Neon 自有上下文用量');
  assert.equal(s5.context.capacityTokens, 512000);

  // Scenario 6 (中止新轮): Turn 2 在无 usage 前被中止 (status 4/6/7, isStreaming: false) -> 不得卡死在空 Neon 槽位
  for (const abortedStatus of [4, 6, 7]) {
    const s6 = buildConversationHudMetrics({
      conversationId: `conv-s6-aborted-${abortedStatus}`,
      sessionRevision: 1,
      modelId: 'Orchestrator Gemini 4 Neon High',
      isStreaming: false,
      executorMetadata: {
        planModelEnum: 1532,
        executionModelEnum: 1528,
        checkpointMaxTokenLimit: 512000,
      },
      steps: [
        { idx: 0, stepType: 14, status: 3 },
        standaloneHydrogenTurn1,
        { idx: 2, stepType: 14, status: 3 },
        { idx: 3, stepType: 15, status: abortedStatus, hasUsage: false },
      ],
    });
    assert.equal(s6.context.modelShortLabel, 'Hydrogen', `status=${abortedStatus} 中止后不应卡在空 Neon 槽位`);
    assert.equal(s6.context.modelId, 'gemini-4-hydrogen');
    assert.equal(s6.context.hasUsageData, true);
    assert.equal(s6.context.usedTokens, 92000);
  }
});
});

describeContractGroup("HUD 前端探针 · resolveSubagentState 等待/阻塞态过滤", { concurrency: false }, async () => {
  class MockDomNode {
    constructor(tagName = 'div', attrs = {}, text = '') {
      this.tagName = tagName.toUpperCase();
      this.attributes = new Map();
      this.children = [];
      this.parentNode = null;
      this.classList = new Set();
      this._textContent = text;
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class') {
          String(v).split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c));
        } else {
          this.attributes.set(k, String(v));
        }
      }
    }
    get textContent() {
      if (this._textContent) return this._textContent;
      return this.children.map((c) => c.textContent).join('');
    }
    set textContent(v) {
      this._textContent = String(v ?? '');
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
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    }
    matchesSingle(part) {
      const p = part.trim();
      if (!p) return false;
      if (/^[a-zA-Z]+$/.test(p)) return this.tagName === p.toUpperCase();
      if (p.startsWith('.')) return this.classList.has(p.slice(1));
      const hasAttr = p.match(/^\[([a-zA-Z0-9_-]+)\]$/);
      if (hasAttr) return this.hasAttribute(hasAttr[1]);
      const exactAttr = p.match(/^\[([a-zA-Z0-9_-]+)="([^"]+)"\]$/);
      if (exactAttr) return this.getAttribute(exactAttr[1]) === exactAttr[2];
      const prefAttr = p.match(/^\[([a-zA-Z0-9_-]+)\^="([^"]+)"\]$/);
      if (prefAttr) return (this.getAttribute(prefAttr[1]) || '').startsWith(prefAttr[2]);
      const subAttr = p.match(/^\[([a-zA-Z0-9_-]+)\*="([^"]+)"(?:\s+i)?\]$/);
      if (subAttr) return (this.getAttribute(subAttr[1]) || '').toLowerCase().includes(subAttr[2].toLowerCase());
      return false;
    }
    matches(sel) {
      return String(sel).split(',').some((part) => this.matchesSingle(part));
    }
    closest(sel) {
      let cur = this;
      while (cur) {
        if (cur.matches(sel)) return cur;
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
        for (const child of node.children) {
          if (child.matches(sel)) out.push(child);
          visit(child);
        }
      };
      visit(this);
      return out;
    }
  }

  function makeChip(name, dotState, extraChildren = []) {
    const chip = new MockDomNode('button', { 'aria-label': `Open Subagent: ${name}` });
    if (dotState !== null && dotState !== undefined) {
      chip.appendChild(new MockDomNode('span', { 'data-agent-state-dot': dotState }));
    }
    for (const child of extraChildren) chip.appendChild(child);
    return chip;
  }

  test('data-agent-state-dot 为 waiting / standing_by / blocked / needs_attention 等等待与阻塞态不被计入 running', () => {
    const mgr = new AntigravityHudManager();
    try {
      const nonRunningStates = [
        'waiting',
        'standing_by',
        'standing-by',
        'standing by',
        'STANDING_BY',
        'blocked',
        'needs_you',
        'needs-you',
        'needs you',
        'needs_attention',
        'needs-attention',
        'Needs Attention',
        'needs_approval',
        'needs_input',
      ];
      for (const state of nonRunningStates) {
        const view = new MockDomNode('div', { 'data-testid': 'conversation-view' });
        view.appendChild(makeChip(`Worker-${state}`, state));
        const res = mgr.resolveSubagentState(view, { isSubpane: false });
        assert.equal(res.isSubagentRunning, false, `dotState="${state}" 不应判定为运行中`);
        assert.equal(res.runningSubagentCount, 0, `dotState="${state}" 计数应为 0`);
      }

      // 混合场景：1 个 running + 4 个分别处于 waiting / standing_by / blocked / needs_attention，仅计 1
      const mixedView = new MockDomNode('div', { 'data-testid': 'conversation-view' });
      mixedView.appendChild(makeChip('Worker-Waiting', 'waiting'));
      mixedView.appendChild(makeChip('Worker-StandingBy', 'standing_by'));
      mixedView.appendChild(makeChip('Worker-Blocked', 'blocked'));
      mixedView.appendChild(makeChip('Worker-NeedsAttention', 'needs_attention'));
      mixedView.appendChild(makeChip('Worker-Active', 'running'));
      const mixedRes = mgr.resolveSubagentState(mixedView, { isSubpane: false });
      assert.equal(mixedRes.isSubagentRunning, true);
      assert.equal(mixedRes.runningSubagentCount, 1);
    } finally {
      mgr.dispose();
    }
  });

  test('agent-status-waiting / agent-status-blocked / agent-status-paused 在 agentRefs 与 activeToolNodes 中均被排除', () => {
    const mgr = new AntigravityHudManager();
    try {
      for (const statusTestId of ['agent-status-waiting', 'agent-status-blocked', 'agent-status-paused']) {
        const view = new MockDomNode('div', { 'data-testid': 'conversation-view' });
        // agentRefs 芯片即使残留 spinner，命中等待/阻塞/暂停图标也必须排除
        view.appendChild(
          makeChip('Swarm-Member', null, [
            new MockDomNode('span', { 'data-testid': statusTestId }),
            new MockDomNode('span', { 'data-testid': 'status-loading-spinner' }),
          ])
        );
        // activeToolNodes 卡片命中等待/阻塞/暂停图标也必须排除
        const card = new MockDomNode('div', { 'data-testid': 'browser-subagent-row' });
        card.appendChild(new MockDomNode('span', { 'data-testid': statusTestId }));
        card.appendChild(new MockDomNode('span', { class: 'animate-spin' }));
        view.appendChild(card);

        const res = mgr.resolveSubagentState(view, { isSubpane: false });
        assert.equal(res.isSubagentRunning, false, `${statusTestId} 不应计入 running`);
        assert.equal(res.runningSubagentCount, 0, `${statusTestId} 计数应为 0`);
      }
    } finally {
      mgr.dispose();
    }
  });

  test('idle-status-text 为 "1 subagent running" 与等待/阻塞态芯片及提示共存时准确返回 runningSubagentCount: 1', () => {
    const mgr = new AntigravityHudManager();
    try {
      const view = new MockDomNode('div', { 'data-testid': 'conversation-view' });
      const idleText = new MockDomNode('div', { 'data-testid': 'idle-status-text' }, '1 subagent running');
      view.appendChild(idleText);
      view.appendChild(makeChip('native-ui', 'running'));
      view.appendChild(makeChip('i18n-backend', 'standing_by'));
      view.appendChild(makeChip('verifier', 'waiting'));
      view.appendChild(
        makeChip('coordinator', 'needs_attention', [
          new MockDomNode('span', { 'data-testid': 'agent-status-blocked' }),
        ])
      );

      const res1 = mgr.resolveSubagentState(view, { isSubpane: false });
      assert.equal(res1.isSubagentRunning, true);
      assert.equal(res1.runningSubagentCount, 1);

      // 同一 idle-status-text 含 blocked / waiting 并存文案时仍准确提取 running 计数
      idleText.textContent = '1 subagent running, 2 blocked';
      const res2 = mgr.resolveSubagentState(view, { isSubpane: false });
      assert.equal(res2.isSubagentRunning, true);
      assert.equal(res2.runningSubagentCount, 1);

      idleText.textContent = '2 subagents blocked, 1 subagent running';
      const res3 = mgr.resolveSubagentState(view, { isSubpane: false });
      assert.equal(res3.isSubagentRunning, true);
      assert.equal(res3.runningSubagentCount, 1);

      // 仅有 blocked/waiting 提示且无运行态芯片时返回 0
      const blockedOnlyView = new MockDomNode('div', { 'data-testid': 'conversation-view' });
      blockedOnlyView.appendChild(new MockDomNode('div', { 'data-testid': 'idle-status-text' }, '2 subagents blocked'));
      blockedOnlyView.appendChild(makeChip('i18n-backend', 'standing_by'));
      blockedOnlyView.appendChild(makeChip('verifier', 'blocked'));
      const res4 = mgr.resolveSubagentState(blockedOnlyView, { isSubpane: false });
      assert.equal(res4.isSubagentRunning, false);
      assert.equal(res4.runningSubagentCount, 0);

      // P1-04 回归：agentRefs 芯片明确处于 standing_by / waiting / blocked 时，即便含装饰性 .animate-spin / .spinner 也必须短路排除；
      // 而 2.33.0 四点加载动画（status-loading-spinner 内含空值 data-agent-state-dot=""）仍正常识别为运行中
      const spinnerStandbyView = new MockDomNode('div', { 'data-testid': 'conversation-view' });
      spinnerStandbyView.appendChild(
        makeChip('standby-with-spinner', 'standing_by', [new MockDomNode('span', { class: 'animate-spin' })])
      );
      spinnerStandbyView.appendChild(
        makeChip('blocked-with-spinner', 'blocked', [new MockDomNode('span', { class: 'spinner' })])
      );
      const resStandbySpin = mgr.resolveSubagentState(spinnerStandbyView, { isSubpane: false });
      assert.equal(resStandbySpin.isSubagentRunning, false, '非运行态 dot 芯片含装饰 spinner 时必须短路排除');
      assert.equal(resStandbySpin.runningSubagentCount, 0);

      const fourDotSpinner = new MockDomNode('span', { 'data-testid': 'status-loading-spinner' });
      fourDotSpinner.appendChild(new MockDomNode('span', { 'data-agent-state-dot': '' }));
      spinnerStandbyView.appendChild(makeChip('active-233-four-dot', null, [fourDotSpinner]));
      const resFourDot = mgr.resolveSubagentState(spinnerStandbyView, { isSubpane: false });
      assert.equal(resFourDot.isSubagentRunning, true, '空值 data-agent-state-dot 的 2.33.0 四点加载器仍应计入运行中');
      assert.equal(resFourDot.runningSubagentCount, 1);
    } finally {
      mgr.dispose();
    }
  });

  test('MutationObserver attributeFilter 包含 data-agent-state-dot 以即时感知子智能体圆点状态切换', () => {
    const prevDoc = globalThis.document;
    const prevMo = globalThis.MutationObserver;
    const observedConfigs = [];
    globalThis.MutationObserver = class FakeMutationObserver {
      observe(target, config) {
        observedConfigs.push({ target, config });
      }
      disconnect() {}
    };
    globalThis.document = {
      body: new MockDomNode('body'),
      documentElement: new MockDomNode('html'),
      querySelectorAll: () => [],
      addEventListener() {},
      removeEventListener() {},
    };
    const mgr = new AntigravityHudManager();
    try {
      mgr.start();
      const bodyConfig = observedConfigs.find((item) => item.target === globalThis.document.body)?.config;
      assert.ok(bodyConfig, '应监听 document.body');
      assert.ok(
        Array.isArray(bodyConfig.attributeFilter) && bodyConfig.attributeFilter.includes('data-agent-state-dot'),
        'attributeFilter 必须包含 data-agent-state-dot'
      );
    } finally {
      mgr.dispose();
      globalThis.document = prevDoc;
      globalThis.MutationObserver = prevMo;
    }
  });
});

