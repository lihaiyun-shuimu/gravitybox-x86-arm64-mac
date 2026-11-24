import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import {
  CdpHudBridge,
  ConversationMetricsEngine,
  buildConversationHudMetrics,
} from '../dist/hud.js';
import {
  runHudDbScanInWorker,
  runSummariesLookupInWorker,
  runUsageDbScanInWorker,
} from '../dist/sqlite-read.js';
import { readForkParentMetadata } from '../dist/sqlite-worker.js';
import {
  computeRemoteConversationHudMetrics,
  isStrictSubagentSummary,
} from '../dist/ssh-remote-rpc.js';

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

function encodeVarintField(fieldNum, val) {
  return [...encodeVarint((fieldNum << 3) | 0), ...encodeVarint(val)];
}

function encodeBytesField(fieldNum, buf) {
  return [...encodeVarint((fieldNum << 3) | 2), ...encodeVarint(buf.length), ...buf];
}

function encodeStringField(fieldNum, str) {
  return encodeBytesField(fieldNum, Buffer.from(str, 'utf8'));
}

function encodeTimestampField(fieldNum, seconds, nanos = 0) {
  const inner = [...encodeVarintField(1, seconds), ...(nanos ? encodeVarintField(2, nanos) : [])];
  return encodeBytesField(fieldNum, inner);
}

function encodeDurationField(fieldNum, seconds, nanos = 0) {
  const inner = [...encodeVarintField(1, seconds), ...(nanos ? encodeVarintField(2, nanos) : [])];
  return encodeBytesField(fieldNum, inner);
}

function encodeUsageInner({
  rawInput = 0,
  outputTokens = 0,
  cacheWriteTokens = 0,
  cachedTokens = 0,
  reasoningTokens = 0,
  candidateTokens = 0,
}) {
  return [
    ...encodeVarintField(2, rawInput),
    ...encodeVarintField(3, outputTokens),
    ...encodeVarintField(4, cacheWriteTokens),
    ...encodeVarintField(5, cachedTokens),
    ...encodeVarintField(9, reasoningTokens),
    ...encodeVarintField(10, candidateTokens),
  ];
}

function encodeParentRef({
  parentTrajectoryId,
  forkStepIndex,
  referenceType = 2,
  parentCascadeId,
}) {
  const bytes = [];
  if (parentTrajectoryId !== undefined) bytes.push(...encodeStringField(1, parentTrajectoryId));
  if (forkStepIndex !== undefined) bytes.push(...encodeVarintField(2, forkStepIndex));
  if (referenceType !== undefined) bytes.push(...encodeVarintField(5, referenceType));
  if (parentCascadeId !== undefined) bytes.push(...encodeStringField(6, parentCascadeId));
  return Buffer.from(bytes);
}

function encodeGenMetadata({
  stepIndices = [],
  executionId,
  responseModel,
  modelDisplayName,
  usage,
  ttftSeconds,
  streamingSeconds,
  maxContextTokens,
  startedAtSeconds,
}) {
  const chatModelBytes = [];
  if (usage) {
    chatModelBytes.push(...encodeBytesField(4, encodeUsageInner(usage)));
  }
  if (startedAtSeconds || maxContextTokens) {
    const startMetaBytes = [];
    if (startedAtSeconds) {
      startMetaBytes.push(...encodeTimestampField(4, startedAtSeconds));
    }
    if (maxContextTokens) {
      startMetaBytes.push(...encodeBytesField(10, encodeVarintField(4, maxContextTokens)));
    }
    chatModelBytes.push(...encodeBytesField(9, startMetaBytes));
  }
  if (ttftSeconds !== undefined) {
    chatModelBytes.push(...encodeDurationField(11, ttftSeconds));
  }
  if (streamingSeconds !== undefined) {
    chatModelBytes.push(...encodeDurationField(12, streamingSeconds));
  }
  if (responseModel) {
    chatModelBytes.push(...encodeStringField(19, responseModel));
  }
  if (modelDisplayName) {
    chatModelBytes.push(...encodeStringField(21, modelDisplayName));
  }
  const outer = [];
  if (chatModelBytes.length > 0) {
    outer.push(...encodeBytesField(1, chatModelBytes));
  }
  for (const si of stepIndices) {
    outer.push(...encodeVarintField(2, si));
  }
  if (executionId) {
    outer.push(...encodeBytesField(4, Buffer.from(executionId, 'hex')));
  }
  return Buffer.from(outer);
}

function encodeStep15Meta({
  createdAt,
  viewableAt,
  finishedAt,
  completedAt,
  usage,
  executionId,
}) {
  const bytes = [];
  if (createdAt !== undefined) bytes.push(...encodeTimestampField(1, createdAt));
  if (viewableAt !== undefined) bytes.push(...encodeTimestampField(6, viewableAt));
  if (finishedAt !== undefined) bytes.push(...encodeTimestampField(7, finishedAt));
  if (completedAt !== undefined) bytes.push(...encodeTimestampField(8, completedAt));
  if (usage) bytes.push(...encodeBytesField(9, encodeUsageInner(usage)));
  if (executionId) bytes.push(...encodeBytesField(12, Buffer.from(executionId, 'hex')));
  return Buffer.from(bytes);
}

function encodeToolCallMeta({ createdAt, startedAt, completedAt, name, argsJson = '{}' }) {
  const bytes = [];
  if (createdAt !== undefined) bytes.push(...encodeTimestampField(1, createdAt));
  if (name) {
    bytes.push(
      ...encodeBytesField(4, [...encodeStringField(2, name), ...encodeStringField(3, argsJson)])
    );
  }
  if (completedAt !== undefined) bytes.push(...encodeTimestampField(8, completedAt));
  if (startedAt !== undefined) bytes.push(...encodeTimestampField(32, startedAt));
  return Buffer.from(bytes);
}

function createConvSchema(db) {
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
      data BLOB
    );
    CREATE TABLE trajectory_meta (
      trajectory_id TEXT PRIMARY KEY,
      cascade_id TEXT,
      trajectory_type INTEGER,
      source INTEGER
    );
    CREATE TABLE trajectory_metadata_blob (
      id TEXT PRIMARY KEY,
      data BLOB
    );
    CREATE TABLE parent_references (
      idx INTEGER PRIMARY KEY,
      data BLOB
    );
  `);
}

test('(a) 主对话完全隔离 BTW：即使 BTW 出现在 conversation_parents 中，主对话与 summariesLookup 均不得把 BTW 计入子智能体', async (t) => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-btw-a-'));
  const openDbs = [];
  const trackDb = (p) => { const d = new DatabaseSync(p); openDbs.push(d); return d; };
  t.after(() => {
    for (const d of openDbs) { try { d.close(); } catch {} }
    fs.rmSync(baseDir, { recursive: true, force: true });
  });
  const convDir = path.join(baseDir, 'conversations');
  fs.mkdirSync(convDir, { recursive: true });

  const mainId = '11111111-1111-4111-8111-111111111111';
  const subId = '22222222-2222-4222-8222-222222222222';
  const btwId = '33333333-3333-4333-8333-333333333333';
  const mainTrajId = 'aaaa1111-1111-4111-8111-111111111111';
  const btwTrajId = 'bbbb3333-3333-4333-8333-333333333333';
  const nowSec = Math.floor(Date.now() / 1000);

  // conversation_summaries.db: subagent 在两张表都有；BTW 只在 conversation_parents，不在 conversation_summaries
  const sumDbPath = path.join(baseDir, 'conversation_summaries.db');
  const sumDb = trackDb(sumDbPath);
  sumDb.exec(`
    CREATE TABLE conversation_parents (conversation_id TEXT PRIMARY KEY, parent_id TEXT NOT NULL);
    CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      parent_conversation_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT ''
    );
  `);
  sumDb.prepare('INSERT INTO conversation_parents VALUES (?, ?)').run(subId, mainId);
  sumDb.prepare('INSERT INTO conversation_parents VALUES (?, ?)').run(btwId, mainId);
  sumDb.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?)').run(
    subId,
    mainId,
    'CASCADE_RUN_STATUS_IDLE'
  );

  // 验证 executeSummariesLookup 不把 BTW 放入 childIds
  const lookupRes = await runSummariesLookupInWorker({
    dbPath: sumDbPath,
    parentIds: [mainId],
  });
  assert.ok(lookupRes?.foundTable);
  assert.deepEqual(lookupRes.childIds, [subId]);

  // 无 conversation_summaries 表时的向后兼容
  const legacySumPath = path.join(baseDir, 'legacy_summaries.db');
  const legacySumDb = trackDb(legacySumPath);
  legacySumDb.exec('CREATE TABLE conversation_parents (conversation_id TEXT PRIMARY KEY, parent_id TEXT NOT NULL);');
  legacySumDb.prepare('INSERT INTO conversation_parents VALUES (?, ?)').run(subId, mainId);
  const legacyLookup = await runSummariesLookupInWorker({ dbPath: legacySumPath, parentIds: [mainId] });
  assert.deepEqual(legacyLookup?.childIds, [subId]);

  // 主对话 DB
  const mainDb = trackDb(path.join(convDir, `${mainId}.db`));
  createConvSchema(mainDb);
  mainDb.prepare('INSERT INTO trajectory_meta VALUES (?, ?, ?, 1)').run(mainTrajId, mainId, 4);
  mainDb.prepare('INSERT INTO steps VALUES (0, 14, 3, ?, NULL, NULL)').run(
    Buffer.from(encodeTimestampField(1, nowSec - 100))
  );
  mainDb.prepare('INSERT INTO steps VALUES (1, 15, 3, ?, NULL, NULL)').run(
    encodeStep15Meta({
      createdAt: nowSec - 99,
      finishedAt: nowSec - 95,
      usage: { rawInput: 1000, cachedTokens: 2000, outputTokens: 200 },
      executionId: 'aa01',
    })
  );
  // 即使在主对话里通过 DOM hint 或某种引用提到了 btwId，主对话 child-DB 硬守卫也必须跳过 BTW
  mainDb.prepare('INSERT INTO steps VALUES (2, 132, 3, ?, NULL, NULL)').run(
    encodeToolCallMeta({
      createdAt: nowSec - 94,
      startedAt: nowSec - 94,
      completedAt: nowSec - 93,
      name: 'invoke_subagent',
      argsJson: JSON.stringify({ id: subId }),
    })
  );

  // 真实子智能体 DB
  const subDb = trackDb(path.join(convDir, `${subId}.db`));
  createConvSchema(subDb);
  subDb.prepare('INSERT INTO trajectory_meta VALUES (?, ?, ?, 1)').run(subId, subId, 4);
  subDb.prepare('INSERT INTO trajectory_metadata_blob VALUES (?, ?)').run(
    'main',
    Buffer.from(encodeStringField(5, mainId))
  );
  subDb.prepare('INSERT INTO steps VALUES (0, 14, 3, ?, NULL, NULL)').run(
    Buffer.from(encodeTimestampField(1, nowSec - 90))
  );
  subDb.prepare('INSERT INTO steps VALUES (1, 15, 3, ?, NULL, NULL)').run(
    encodeStep15Meta({
      createdAt: nowSec - 89,
      finishedAt: nowSec - 87,
      usage: { rawInput: 500, cachedTokens: 0, outputTokens: 50 },
      executionId: 'bb01',
    })
  );

  // BTW DB (trajectory_type=22)，包含克隆前缀 + 自身新步骤（巨额 token，绝不能污染主对话）
  const btwDb = trackDb(path.join(convDir, `${btwId}.db`));
  createConvSchema(btwDb);
  btwDb.prepare('INSERT INTO trajectory_meta VALUES (?, ?, ?, 1)').run(btwTrajId, btwId, 22);
  btwDb.prepare('INSERT INTO parent_references VALUES (0, ?)').run(
    encodeParentRef({
      parentTrajectoryId: mainTrajId,
      forkStepIndex: 1,
      referenceType: 2,
      parentCascadeId: mainId,
    })
  );
  btwDb.prepare('INSERT INTO steps VALUES (0, 14, 3, ?, NULL, NULL)').run(
    Buffer.from(encodeTimestampField(1, nowSec - 100))
  );
  btwDb.prepare('INSERT INTO steps VALUES (1, 15, 3, ?, NULL, NULL)').run(
    encodeStep15Meta({
      createdAt: nowSec - 99,
      finishedAt: nowSec - 95,
      usage: { rawInput: 1000, cachedTokens: 2000, outputTokens: 200 },
      executionId: 'aa01',
    })
  );
  btwDb.prepare('INSERT INTO steps VALUES (2, 14, 3, ?, NULL, NULL)').run(
    Buffer.from(encodeTimestampField(1, nowSec - 50))
  );
  btwDb.prepare('INSERT INTO steps VALUES (3, 15, 2, ?, NULL, NULL)').run(
    encodeStep15Meta({
      createdAt: nowSec - 49,
      usage: { rawInput: 999999, cachedTokens: 0, outputTokens: 88888 },
      executionId: 'cc01',
    })
  );

  const engine = new ConversationMetricsEngine({ conversationsDir: convDir });
  // 即使前端误传 btwId 在 domHintChildIds 中，主对话硬守卫也必须跳过它
  const mainMetrics = await engine.getConversationMetrics({
    conversationId: mainId,
    isStreaming: false,
    childConversationIds: [subId, btwId],
  });

  assert.equal(mainMetrics.session.subagentCount, 1);
  assert.equal(mainMetrics.session.subagentSteps, 2);
  assert.equal(mainMetrics.isSubagentRunning, false);
  assert.equal(mainMetrics.runningSubagentCount, 0);
  // 主对话 token = (1000+2000+200) + 子智能体 (500+50) = 3750，绝不含 BTW 的 999999/88888
  assert.equal(mainMetrics.tokens.totalTokens, 3750);
  assert.equal(mainMetrics.session.isBtwTrajectory, undefined);
});

test('(b) & (c) & (d) BTW 精确切片 idx > forkStepIndex、零新步回退上下文基线、升级后连续以及 BTW 自身子智能体聚合', async (t) => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-btw-bcd-'));
  const openDbs = [];
  const trackDb = (p) => { const d = new DatabaseSync(p); openDbs.push(d); return d; };
  t.after(() => {
    for (const d of openDbs) { try { d.close(); } catch {} }
    fs.rmSync(baseDir, { recursive: true, force: true });
  });
  const convDir = path.join(baseDir, 'conversations');
  fs.mkdirSync(convDir, { recursive: true });

  const mainId = '44444444-4444-4444-8444-444444444444';
  const mainTrajId = 'cccc4444-4444-4444-8444-444444444444';
  const btwNewId = '55555555-5555-4555-8555-555555555555';
  const btwNewTrajId = 'dddd5555-5555-4555-8555-555555555555';
  const btwActiveId = '66666666-6666-4666-8666-666666666666';
  const btwActiveTrajId = 'eeee6666-6666-4666-8666-666666666666';
  const parentSubId = '77777777-7777-4777-8777-777777777777';
  const btwSubId = '88888888-8888-4888-8888-888888888888';
  const nowSec = Math.floor(Date.now() / 1000);

  // 辅助子代理 DB：一个挂在 mainId（预分叉克隆），一个挂在 btwActiveId（BTW 自己派生的子代理）
  const parentSubDb = trackDb(path.join(convDir, `${parentSubId}.db`));
  createConvSchema(parentSubDb);
  parentSubDb.prepare('INSERT INTO trajectory_meta VALUES (?, ?, ?, 1)').run(parentSubId, parentSubId, 4);
  parentSubDb.prepare('INSERT INTO trajectory_metadata_blob VALUES (?, ?)').run(
    'main',
    Buffer.from(encodeStringField(5, mainId))
  );
  parentSubDb.prepare('INSERT INTO steps VALUES (0, 15, 3, ?, NULL, NULL)').run(
    encodeStep15Meta({
      createdAt: nowSec - 180,
      finishedAt: nowSec - 175,
      usage: { rawInput: 40000, outputTokens: 4000 },
    })
  );

  const btwSubDb = trackDb(path.join(convDir, `${btwSubId}.db`));
  createConvSchema(btwSubDb);
  btwSubDb.prepare('INSERT INTO trajectory_meta VALUES (?, ?, ?, 1)').run(btwSubId, btwSubId, 4);
  btwSubDb.prepare('INSERT INTO trajectory_metadata_blob VALUES (?, ?)').run(
    'main',
    Buffer.from(encodeStringField(5, btwActiveId))
  );
  btwSubDb.prepare('INSERT INTO steps VALUES (0, 14, 3, ?, NULL, NULL)').run(
    Buffer.from(encodeTimestampField(1, nowSec - 30))
  );
  btwSubDb.prepare('INSERT INTO steps VALUES (1, 15, 3, ?, NULL, NULL)').run(
    encodeStep15Meta({
      createdAt: nowSec - 29,
      finishedAt: nowSec - 26,
      usage: { rawInput: 200, cachedTokens: 800, outputTokens: 100 },
    })
  );

  // (c) 刚分叉尚未发消息的 BTW (0 post-fork steps):
  // 前缀 idx 0..3 包含 1 个 USER_INPUT、1 个 CHECKPOINT 压缩、1 个模型步 (100k context)、1 个工具步
  const btwNewDb = trackDb(path.join(convDir, `${btwNewId}.db`));
  createConvSchema(btwNewDb);
  btwNewDb.prepare('INSERT INTO trajectory_meta VALUES (?, ?, ?, 1)').run(btwNewTrajId, btwNewId, 22);
  btwNewDb.prepare('INSERT INTO parent_references VALUES (0, ?)').run(
    encodeParentRef({
      parentTrajectoryId: mainTrajId,
      forkStepIndex: 3,
      referenceType: 2,
      parentCascadeId: mainId,
    })
  );
  btwNewDb.prepare('INSERT INTO steps VALUES (0, 14, 3, ?, NULL, NULL)').run(
    Buffer.from(encodeTimestampField(1, nowSec - 200))
  );
  btwNewDb.prepare('INSERT INTO steps VALUES (1, 15, 3, ?, NULL, NULL)').run(
    encodeStep15Meta({
      createdAt: nowSec - 199,
      viewableAt: nowSec - 198,
      finishedAt: nowSec - 190,
      usage: { rawInput: 12_000, cachedTokens: 88_000, outputTokens: 1_500 },
      executionId: 'aa10',
    })
  );
  btwNewDb.prepare('INSERT INTO gen_metadata VALUES (0, ?)').run(
    encodeGenMetadata({
      stepIndices: [1],
      executionId: 'aa10',
      responseModel: 'claude-sonnet-4-6',
      modelDisplayName: 'Claude Sonnet 4.6',
      maxContextTokens: 200_000,
      ttftSeconds: 1,
      streamingSeconds: 8,
      startedAtSeconds: nowSec - 199,
      usage: { rawInput: 12_000, cachedTokens: 88_000, outputTokens: 1_500 },
    })
  );
  btwNewDb.prepare('INSERT INTO steps VALUES (2, 23, 3, ?, NULL, NULL)').run(
    Buffer.from(encodeTimestampField(1, nowSec - 189))
  );
  btwNewDb.prepare('INSERT INTO steps VALUES (3, 16, 3, ?, NULL, NULL)').run(
    encodeToolCallMeta({
      createdAt: nowSec - 188,
      startedAt: nowSec - 187,
      completedAt: nowSec - 182,
      name: 'read_file',
    })
  );
  // 预分叉无匹配计费 generation (stepIndices=[2]) 必须被过滤
  btwNewDb.prepare('INSERT INTO gen_metadata VALUES (1, ?)').run(
    encodeGenMetadata({
      stepIndices: [2],
      responseModel: 'claude-sonnet-4-6',
      startedAtSeconds: nowSec - 189,
      usage: { rawInput: 5000, cachedTokens: 10000, outputTokens: 500 },
    })
  );
  // 预分叉无 stepIndices 但时间戳 <= preFork maxTs 的孤立 generation 也必须被过滤
  btwNewDb.prepare('INSERT INTO gen_metadata VALUES (2, ?)').run(
    encodeGenMetadata({
      stepIndices: [],
      responseModel: 'claude-sonnet-4-6',
      startedAtSeconds: nowSec - 185,
      usage: { rawInput: 7000, cachedTokens: 0, outputTokens: 700 },
    })
  );

  const engine = new ConversationMetricsEngine({ conversationsDir: convDir });
  const newlyForkedMetrics = await engine.getConversationMetrics({
    conversationId: btwNewId,
    isStreaming: false,
  });

  assert.equal(newlyForkedMetrics.session.isBtwTrajectory, true);
  assert.equal(newlyForkedMetrics.session.isSubagentTrajectory, undefined);
  assert.equal(newlyForkedMetrics.session.turns, 0);
  assert.equal(newlyForkedMetrics.session.steps, 0);
  assert.equal(newlyForkedMetrics.session.modelSteps, 0);
  assert.equal(newlyForkedMetrics.session.toolSteps, 0);
  assert.equal(newlyForkedMetrics.session.compactionCount, 0);
  assert.equal(newlyForkedMetrics.session.modelDurationSeconds, 0);
  assert.equal(newlyForkedMetrics.session.toolDurationSeconds, 0);
  assert.equal(newlyForkedMetrics.tokens.totalTokens, 0);
  assert.equal(newlyForkedMetrics.tokens.estimatedCostUsd, undefined);
  // 上下文回退继承分叉前最后一条有效模型步的基线
  assert.equal(newlyForkedMetrics.context.hasUsageData, true);
  assert.equal(newlyForkedMetrics.context.modelId, 'claude-sonnet-4-6');
  assert.equal(newlyForkedMetrics.context.usedTokens, 100_000);
  assert.equal(newlyForkedMetrics.context.capacityTokens, 200_000);
  assert.equal(newlyForkedMetrics.context.usedRatio, 0.5);
  assert.equal(newlyForkedMetrics.context.breakdown.cachedContextTokens, 88_000);
  assert.equal(newlyForkedMetrics.context.breakdown.uncachedContextTokens, 12_000);

  // (b) 有分叉后自身对话轮次/步骤/Token/耗时/费用 + 预分叉父子代理不计入 + BTW 自身子代理计入
  const btwActiveDbPath = path.join(convDir, `${btwActiveId}.db`);
  const btwActiveDb = trackDb(btwActiveDbPath);
  createConvSchema(btwActiveDb);
  btwActiveDb.prepare('INSERT INTO trajectory_meta VALUES (?, ?, ?, 1)').run(
    btwActiveTrajId,
    btwActiveId,
    22
  );
  btwActiveDb.prepare('INSERT INTO parent_references VALUES (0, ?)').run(
    encodeParentRef({
      parentTrajectoryId: mainTrajId,
      forkStepIndex: 2,
      referenceType: 2,
      parentCascadeId: mainId,
    })
  );
  // 预分叉克隆前缀 idx 0..2（包含 parentSubId 的调度步，绝不能被 BTW 聚合）
  btwActiveDb.prepare('INSERT INTO steps VALUES (0, 14, 3, ?, NULL, NULL)').run(
    Buffer.from(encodeTimestampField(1, nowSec - 200))
  );
  btwActiveDb.prepare('INSERT INTO steps VALUES (1, 15, 3, ?, NULL, NULL)').run(
    encodeStep15Meta({
      createdAt: nowSec - 199,
      finishedAt: nowSec - 190,
      usage: { rawInput: 50_000, cachedTokens: 50_000, outputTokens: 2_000 },
      executionId: 'aa20',
    })
  );
  btwActiveDb.prepare('INSERT INTO gen_metadata VALUES (0, ?)').run(
    encodeGenMetadata({
      stepIndices: [1],
      executionId: 'aa20',
      responseModel: 'claude-sonnet-4-6',
      maxContextTokens: 200_000,
      ttftSeconds: 1,
      streamingSeconds: 8,
      startedAtSeconds: nowSec - 199,
      usage: { rawInput: 50_000, cachedTokens: 50_000, outputTokens: 2_000 },
    })
  );
  btwActiveDb.prepare('INSERT INTO steps VALUES (2, 132, 3, ?, NULL, NULL)').run(
    encodeToolCallMeta({
      createdAt: nowSec - 189,
      startedAt: nowSec - 189,
      completedAt: nowSec - 180,
      name: 'invoke_subagent',
      argsJson: JSON.stringify({ id: parentSubId }),
    })
  );
  // 分叉后 BTW 自身步骤 idx 3..6（1 turn, 1 model step, 1 tool step + btwSubId）
  btwActiveDb.prepare('INSERT INTO steps VALUES (3, 14, 3, ?, NULL, NULL)').run(
    Buffer.from(encodeTimestampField(1, nowSec - 50))
  );
  btwActiveDb.prepare('INSERT INTO steps VALUES (4, 15, 3, ?, NULL, NULL)').run(
    encodeStep15Meta({
      createdAt: nowSec - 48,
      viewableAt: nowSec - 47,
      finishedAt: nowSec - 43,
      usage: { rawInput: 1_000, cachedTokens: 100_000, outputTokens: 300 },
      executionId: 'dd10',
    })
  );
  btwActiveDb.prepare('INSERT INTO gen_metadata VALUES (1, ?)').run(
    encodeGenMetadata({
      stepIndices: [4],
      executionId: 'dd10',
      responseModel: 'gemini-3.8-flash',
      modelDisplayName: 'Gemini 3.8 Flash',
      maxContextTokens: 256_000,
      ttftSeconds: 1,
      streamingSeconds: 4,
      startedAtSeconds: nowSec - 48,
      usage: { rawInput: 1_000, cachedTokens: 100_000, outputTokens: 300 },
    })
  );
  btwActiveDb.prepare('INSERT INTO steps VALUES (5, 16, 3, ?, NULL, NULL)').run(
    encodeToolCallMeta({
      createdAt: nowSec - 42,
      startedAt: nowSec - 42,
      completedAt: nowSec - 39,
      name: 'read_file',
    })
  );
  btwActiveDb.prepare('INSERT INTO steps VALUES (6, 132, 3, ?, NULL, NULL)').run(
    encodeToolCallMeta({
      createdAt: nowSec - 38,
      startedAt: nowSec - 38,
      completedAt: nowSec - 25,
      name: 'invoke_subagent',
      argsJson: JSON.stringify({ id: btwSubId }),
    })
  );
  // 分叉后孤立无 stepIndices 且 timestamp > maxPreForkTs 的额外 generation 也应保留
  btwActiveDb.prepare('INSERT INTO gen_metadata VALUES (2, ?)').run(
    encodeGenMetadata({
      stepIndices: [],
      responseModel: 'gemini-3.8-flash',
      startedAtSeconds: nowSec - 20,
      usage: { rawInput: 50, cachedTokens: 0, outputTokens: 10 },
    })
  );

  const activeBtwMetrics = await engine.getConversationMetrics({
    conversationId: btwActiveId,
    isStreaming: false,
  });

  assert.equal(activeBtwMetrics.session.isBtwTrajectory, true);
  assert.equal(activeBtwMetrics.session.isSubagentTrajectory, undefined);
  assert.equal(activeBtwMetrics.session.turns, 1);
  // BTW 自身 4 步 (idx 3,4,5,6) + btwSubId 2 步 = 6 步（绝不含 idx 0..2 及 parentSubId）
  assert.equal(activeBtwMetrics.session.subagentCount, 1);
  assert.equal(activeBtwMetrics.session.subagentSteps, 2);
  assert.equal(activeBtwMetrics.session.steps, 6);
  // Token = BTW step 4 (1000+100000+300) + btwSubId (200+800+100) + post-fork unmatched (50+10) = 102460
  assert.equal(activeBtwMetrics.tokens.totalTokens, 102_460);
  // 耗时 = BTW model (5s) + BTW tools (3s + 13s = 16s) + btwSub model (3s) = 8s model, 16s tool
  assert.equal(activeBtwMetrics.session.modelDurationSeconds, 8);
  assert.equal(activeBtwMetrics.session.toolDurationSeconds, 16);
  assert.ok(activeBtwMetrics.tokens.estimatedCostUsd > 0);
  assert.equal(activeBtwMetrics.context.modelId, 'gemini-3.8-flash');
  assert.equal(activeBtwMetrics.context.usedTokens, 101_000);
  assert.equal(activeBtwMetrics.context.capacityTokens, 256_000);

  // (d) Promote BTW -> trajectory_type = 4 但仍保留外部 parent_references，读数必须保持连续一致
  btwActiveDb.prepare('UPDATE trajectory_meta SET trajectory_type = 4 WHERE trajectory_id = ?').run(
    btwActiveTrajId
  );
  // 触发文件 mtime 变化以使缓存失效重新读取
  const futureTime = new Date(Date.now() + 2000);
  fs.utimesSync(btwActiveDbPath, futureTime, futureTime);

  const promotedMetrics = await engine.getConversationMetrics({
    conversationId: btwActiveId,
    isStreaming: false,
  });
  assert.equal(promotedMetrics.session.isBtwTrajectory, undefined);
  assert.equal(promotedMetrics.session.isSubagentTrajectory, undefined);
  assert.equal(promotedMetrics.session.turns, activeBtwMetrics.session.turns);
  assert.equal(promotedMetrics.session.steps, activeBtwMetrics.session.steps);
  assert.equal(promotedMetrics.tokens.totalTokens, activeBtwMetrics.tokens.totalTokens);
  assert.equal(promotedMetrics.session.modelDurationSeconds, activeBtwMetrics.session.modelDurationSeconds);
  assert.equal(promotedMetrics.session.toolDurationSeconds, activeBtwMetrics.session.toolDurationSeconds);
  assert.equal(promotedMetrics.tokens.estimatedCostUsd, activeBtwMetrics.tokens.estimatedCostUsd);
});

test('(e) 普通 trajectory_type=4 自引用及 uint64 -1 forkStepIndex 不得被误判为 BTW 或切片', async (t) => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-btw-e-'));
  const openDbs = [];
  const trackDb = (p) => { const d = new DatabaseSync(p); openDbs.push(d); return d; };
  t.after(() => {
    for (const d of openDbs) { try { d.close(); } catch {} }
    fs.rmSync(baseDir, { recursive: true, force: true });
  });
  const convDir = path.join(baseDir, 'conversations');
  fs.mkdirSync(convDir, { recursive: true });

  const normalId = '99999999-9999-4999-8999-999999999999';
  const normalTrajId = 'ffff9999-9999-4999-8999-999999999999';
  const externalFakeId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const nowSec = Math.floor(Date.now() / 1000);

  const dbPath = path.join(convDir, `${normalId}.db`);
  const db = trackDb(dbPath);
  createConvSchema(db);
  db.prepare('INSERT INTO trajectory_meta VALUES (?, ?, ?, 1)').run(normalTrajId, normalId, 4);
  // Trap 1a: parentCascadeId === selfCascadeId 且有效 forkStepIndex=1
  db.prepare('INSERT INTO parent_references VALUES (0, ?)').run(
    encodeParentRef({
      parentTrajectoryId: normalTrajId,
      forkStepIndex: 1,
      referenceType: 2,
      parentCascadeId: normalId,
    })
  );
  // Trap 1b: 外部 parentCascadeId 但 forkStepIndex = uint64(-1) (0xffffffffffffffffn)
  db.prepare('INSERT INTO parent_references VALUES (1, ?)').run(
    encodeParentRef({
      parentTrajectoryId: '12345678-1234-4123-8123-123456789012',
      forkStepIndex: 0xffffffffffffffffn,
      referenceType: 2,
      parentCascadeId: externalFakeId,
    })
  );
  // Trap 1c: 非法 36 位 UUID 的 parentCascadeId
  db.prepare('INSERT INTO parent_references VALUES (2, ?)').run(
    encodeParentRef({
      parentTrajectoryId: 'not-a-uuid',
      forkStepIndex: 1,
      referenceType: 2,
      parentCascadeId: 'not-a-valid-uuid',
    })
  );
  db.prepare('INSERT INTO steps VALUES (0, 14, 3, ?, NULL, NULL)').run(
    Buffer.from(encodeTimestampField(1, nowSec - 20))
  );
  db.prepare('INSERT INTO steps VALUES (1, 15, 3, ?, NULL, NULL)').run(
    encodeStep15Meta({
      createdAt: nowSec - 19,
      finishedAt: nowSec - 15,
      usage: { rawInput: 400, cachedTokens: 600, outputTokens: 100 },
      executionId: 'ee01',
    })
  );
  db.prepare('INSERT INTO gen_metadata VALUES (0, ?)').run(
    encodeGenMetadata({
      stepIndices: [1],
      executionId: 'ee01',
      responseModel: 'gemini-3.8-flash',
      usage: { rawInput: 400, cachedTokens: 600, outputTokens: 100 },
    })
  );

  // 直接校验 readForkParentMetadata 与两个 worker 扫描函数
  const directMeta = readForkParentMetadata(db, normalId);
  assert.equal(directMeta.trajectoryType, 4);
  assert.equal(directMeta.forkStepIndex, undefined);
  assert.equal(directMeta.forkParentCascadeId, undefined);

  const hudScan = await runHudDbScanInWorker({ dbPath, inlineBlobLimitBytes: 65_536 });
  assert.equal(hudScan.trajectoryType, 4);
  assert.equal(hudScan.forkStepIndex, undefined);
  assert.equal(hudScan.forkParentCascadeId, undefined);

  const usageScan = await runUsageDbScanInWorker({ dbPath });
  assert.equal(usageScan.ok, true);
  assert.equal(usageScan.trajectoryType, 4);
  assert.equal(usageScan.forkStepIndex, undefined);
  assert.equal(usageScan.forkParentCascadeId, undefined);

  // MetricsEngine 完整保留第 0..1 步，绝不切片
  const engine = new ConversationMetricsEngine({ conversationsDir: convDir });
  const metrics = await engine.getConversationMetrics({
    conversationId: normalId,
    isStreaming: false,
  });
  assert.equal(metrics.session.isBtwTrajectory, undefined);
  assert.equal(metrics.session.isSubagentTrajectory, undefined);
  assert.equal(metrics.session.turns, 1);
  assert.equal(metrics.session.steps, 2);
  assert.equal(metrics.tokens.totalTokens, 1100);
});

test('(f) CdpHudBridge 独立管理 paneKind: "btw" 生命周期与指标隔离 + 远端 BTW 识别隔离', async (t) => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-btw-f-'));
  const openDbs = [];
  let bridge;
  const trackDb = (p) => { const d = new DatabaseSync(p); openDbs.push(d); return d; };
  t.after(() => {
    try { bridge?.dispose(); } catch {}
    for (const d of openDbs) { try { d.close(); } catch {} }
    fs.rmSync(baseDir, { recursive: true, force: true });
  });
  const convDir = path.join(baseDir, 'conversations');
  fs.mkdirSync(convDir, { recursive: true });

  const mainId = '10101010-1010-4010-8010-101010101010';
  const btwId = '20202020-2020-4020-8020-202020202020';
  const nowSec = Math.floor(Date.now() / 1000);

  const mainDb = trackDb(path.join(convDir, `${mainId}.db`));
  const btwDb = trackDb(path.join(convDir, `${btwId}.db`));
  createConvSchema(mainDb);
  createConvSchema(btwDb);

  mainDb.prepare('INSERT INTO trajectory_meta VALUES (?, ?, ?, 1)').run(mainId, mainId, 4);
  mainDb.prepare('INSERT INTO steps VALUES (0, 14, 3, ?, NULL, NULL)').run(
    Buffer.from(encodeTimestampField(1, nowSec - 50))
  );
  mainDb.prepare('INSERT INTO steps VALUES (1, 15, 3, ?, NULL, NULL)').run(
    encodeStep15Meta({
      createdAt: nowSec - 49,
      finishedAt: nowSec - 45,
      usage: { rawInput: 200, cachedTokens: 800, outputTokens: 50 },
    })
  );

  btwDb.prepare('INSERT INTO trajectory_meta VALUES (?, ?, ?, 1)').run(btwId, btwId, 22);
  btwDb.prepare('INSERT INTO parent_references VALUES (0, ?)').run(
    encodeParentRef({
      parentTrajectoryId: mainId,
      forkStepIndex: 1,
      referenceType: 2,
      parentCascadeId: mainId,
    })
  );
  btwDb.prepare('INSERT INTO steps VALUES (0, 14, 3, ?, NULL, NULL)').run(
    Buffer.from(encodeTimestampField(1, nowSec - 50))
  );
  btwDb.prepare('INSERT INTO steps VALUES (1, 15, 3, ?, NULL, NULL)').run(
    encodeStep15Meta({
      createdAt: nowSec - 49,
      finishedAt: nowSec - 45,
      usage: { rawInput: 200, cachedTokens: 800, outputTokens: 50 },
    })
  );
  btwDb.prepare('INSERT INTO steps VALUES (2, 14, 3, ?, NULL, NULL)').run(
    Buffer.from(encodeTimestampField(1, nowSec - 10))
  );

  const sent = [];
  const engine = new ConversationMetricsEngine({ conversationsDir: convDir });
  bridge = new CdpHudBridge({ engine, pollIntervalMs: 0 });

  await bridge.attachToTarget(
    'win-1',
    {
      send: async () => ({}),
      evaluate: async expr => {
        sent.push(expr);
        return true;
      },
    },
    () => 1
  );

  bridge.handleRawBindingPayload(
    'win-1',
    JSON.stringify({
      type: 'SESSION_ATTACHED',
      cascadeId: 'main-pane',
      paneSlotId: 'main-slot',
      paneKind: 'main',
      conversationId: mainId,
      sessionRevision: 1,
      isStreaming: false,
      modelId: 'gemini-3.8-flash',
      timestamp: Date.now(),
    })
  );

  bridge.handleRawBindingPayload(
    'win-1',
    JSON.stringify({
      type: 'SESSION_ATTACHED',
      cascadeId: 'side-pane',
      paneSlotId: 'side-slot',
      paneKind: 'btw',
      conversationId: btwId,
      sessionRevision: 1,
      isStreaming: true,
      activityPhase: 'generating',
      modelId: 'claude-sonnet-4-6',
      timestamp: Date.now(),
    })
  );

  await new Promise(resolve => setTimeout(resolve, 150));

  const panes = bridge.getActivePanes();
  assert.equal(panes.length, 2);
  const mainPane = panes.find(p => p.paneSlotId === 'main-slot');
  const btwPane = panes.find(p => p.paneSlotId === 'side-slot');
  assert.equal(mainPane?.paneKind, 'main');
  assert.equal(mainPane?.isStreaming, false);
  assert.equal(btwPane?.paneKind, 'btw');
  assert.equal(btwPane?.isStreaming, true);

  assert.ok(sent.some(s => s.includes(`"paneSlotId":"main-slot"`) && s.includes(`"totalTokens":1050`)));
  assert.ok(sent.some(s => s.includes(`"paneSlotId":"side-slot"`) && s.includes(`"isBtwTrajectory":true`) && s.includes(`"totalTokens":0`)));

  // 关闭 BTW 侧栏不应影响主栏
  bridge.handleRawBindingPayload(
    'win-1',
    JSON.stringify({
      type: 'SESSION_DETACHED',
      cascadeId: 'side-pane',
      paneSlotId: 'side-slot',
      paneKind: 'btw',
      conversationId: btwId,
      sessionRevision: 1,
      timestamp: Date.now(),
    })
  );
  assert.equal(bridge.getActivePanes().length, 1);
  assert.equal(bridge.getActivePanes()[0]?.paneSlotId, 'main-slot');

  // 远端 BTW 识别与隔离
  assert.equal(
    isStrictSubagentSummary(btwId, {
      cascadeId: btwId,
      stepCount: 3,
      parentConversationId: mainId,
      trajectoryType: 22,
    }),
    false
  );
  assert.equal(
    isStrictSubagentSummary(btwId, {
      cascadeId: btwId,
      stepCount: 3,
      rootConversationId: mainId,
      trajectoryType: 'TRAJECTORY_TYPE_SIDE_QUESTION',
    }),
    false
  );
  const remoteBtw = computeRemoteConversationHudMetrics({
    conversationId: btwId,
    isStreaming: false,
    summary: {
      cascadeId: btwId,
      stepCount: 1,
      parentConversationId: mainId,
      trajectoryType: 22,
    },
    steps: [],
    generatorMetadata: [],
  });
  assert.equal(remoteBtw.session.isBtwTrajectory, true);
  assert.equal(remoteBtw.session.isSubagentTrajectory, undefined);
});
