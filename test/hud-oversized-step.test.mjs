import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ConversationMetricsEngine,
  parseStepMetadataBlob,
} from '../dist/hud.js';
import {
  projectProtobuf,
  HUD_STEP_METADATA_PROJECTION,
} from '../dist/protobuf-projection.js';
import { runHudDbScanInWorker } from '../dist/sqlite-read.js';

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

function modelStepMeta({
  start = 1000,
  end = 1005,
  execution = 'exec-1',
  rawInputTokens = 1000,
  cachedReadTokens = 10000,
  outputTokens = 200,
} = {}) {
  return Buffer.from([
    ...seconds(1, start),
    ...seconds(6, start + 1),
    ...seconds(7, end),
    ...message(9, usageBytes({ rawInputTokens, cachedReadTokens, outputTokens })),
    ...string(12, execution),
  ]);
}

function generationBlob({
  indices,
  execution,
  responseModel,
  modelDisplayName,
  modelEnum,
  maxContextTokens = 256000,
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
  const db = trackDb(t, new DatabaseSync(path.join(dir, `${id}.db`)));
  t.after(() => { try { db.close(); } catch {} });
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
  return db;
}

test('oversized write_file step_type=132 does not freeze HUD turns, context/model, or incremental stepPrefixCutoffIdx', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-hud-oversized-step-'));
  t.after(() => { closeTrackedDbs(t); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });

  const mainId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const db = createWalDb(t, dir, mainId);
  const engine = new ConversationMetricsEngine({ conversationsDir: dir });

  // Turn 1: user prompt + Carbon model step + oversized write_file (field 4.3 > 64KB)
  db.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (0, 14, 3, ?)').run(
    Buffer.from(seconds(1, 1000))
  );
  db.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (1, 15, 3, ?)').run(
    modelStepMeta({
      start: 1001,
      end: 1006,
      execution: 'exec-t1',
      rawInputTokens: 1000,
      cachedReadTokens: 10000,
      outputTokens: 200,
    })
  );
  const g1 = generationBlob({
    indices: [1],
    execution: 'exec-t1',
    responseModel: 'gemini-pro-orchestrator',
    modelDisplayName: 'Orchestrator (Carbon)',
    modelEnum: 1667,
    rawInputTokens: 1000,
    cachedReadTokens: 10000,
    outputTokens: 200,
  });
  db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (0, ?, ?)').run(g1, g1.length);

  const oversizedArgs = JSON.stringify({
    TargetFile: '/tmp/report.md',
    Content: 'x'.repeat(80_000),
  });
  const oversizedToolMeta = Buffer.from([
    ...seconds(1, 1007),
    ...message(4, [...string(2, 'write_file'), ...string(3, oversizedArgs)]),
    ...seconds(7, 1008),
    ...seconds(8, 1009),
    ...string(12, 'exec-t1'),
    ...seconds(32, 1007),
  ]);
  assert.ok(oversizedToolMeta.length > 65_536);
  db.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (2, 132, 3, ?)').run(
    oversizedToolMeta
  );

  const turn1 = await engine.getConversationMetrics({ conversationId: mainId });
  assert.equal(turn1.availability, 'ready');
  assert.equal(turn1.session.turns, 1);
  assert.equal(turn1.session.steps, 3);
  assert.equal(turn1.context.usedTokens, 11_000);
  assert.equal(turn1.context.capacityTokens, 256_000);
  assert.equal(turn1.context.modelDisplayName, 'Orchestrator (Carbon)');

  const scan1 = await runHudDbScanInWorker({
    dbPath: path.join(dir, `${mainId}.db`),
    inlineBlobLimitBytes: 65_536,
  });
  assert.equal(scan1.stepsMode, 'full');
  assert.equal(scan1.stepPrefixCutoffIdx, 1);
  assert.ok(scan1.stepPrefixDigest.length > 0);

  // Turn 2: new user turn + Hydrogen (High) model step after the oversized step
  db.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (3, 14, 3, ?)').run(
    Buffer.from(seconds(1, 2000))
  );
  db.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (4, 15, 3, ?)').run(
    modelStepMeta({
      start: 2001,
      end: 2006,
      execution: 'exec-t2',
      rawInputTokens: 2500,
      cachedReadTokens: 45000,
      outputTokens: 400,
    })
  );
  const g2 = generationBlob({
    indices: [4],
    execution: 'exec-t2',
    responseModel: 'gemini-4-hydrogen',
    modelDisplayName: 'Gemini 4 Hydrogen (High)',
    modelEnum: 1525,
    rawInputTokens: 2500,
    cachedReadTokens: 45000,
    outputTokens: 400,
  });
  db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (1, ?, ?)').run(g2, g2.length);

  const turn2 = await engine.getConversationMetrics({ conversationId: mainId });
  assert.equal(turn2.availability, 'ready');
  assert.equal(turn2.session.turns, 2);
  assert.equal(turn2.session.steps, 5);
  assert.equal(turn2.context.usedTokens, 47_500);
  assert.equal(turn2.context.modelDisplayName, 'Gemini 4 Hydrogen (High)');
  assert.equal(turn2.tokens.totalTokens, 11_200 + 47_900);

  const scan2 = await runHudDbScanInWorker({
    dbPath: path.join(dir, `${mainId}.db`),
    inlineBlobLimitBytes: 65_536,
    prevStepPrefixCutoffIdx: scan1.stepPrefixCutoffIdx,
    prevStepPrefixDigest: scan1.stepPrefixDigest,
    prevGenDigest: scan1.genDigest,
    prevGenPrefixCutoffIdx: scan1.genPrefixCutoffIdx,
    prevGenPrefixDigest: scan1.genPrefixDigest,
  });
  assert.equal(scan2.stepsMode, 'append');
  assert.deepEqual(
    scan2.appendedSteps.map((s) => s.idx),
    [1, 2, 3, 4]
  );
  assert.equal(scan2.stepPrefixCutoffIdx, 3);

  // Append one more step and verify oversized idx=2 stays absorbed in the prefix
  db.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (5, 132, 3, ?)').run(
    Buffer.from([...seconds(1, 2007), ...message(4, string(2, 'read_file')), ...seconds(8, 2008)])
  );
  const scan3 = await runHudDbScanInWorker({
    dbPath: path.join(dir, `${mainId}.db`),
    inlineBlobLimitBytes: 65_536,
    prevStepPrefixCutoffIdx: scan2.stepPrefixCutoffIdx,
    prevStepPrefixDigest: scan2.stepPrefixDigest,
    prevGenDigest: scan2.genDigest,
    prevGenPrefixCutoffIdx: scan2.genPrefixCutoffIdx,
    prevGenPrefixDigest: scan2.genPrefixDigest,
  });
  assert.equal(scan3.stepsMode, 'append');
  assert.equal(scan3.stepPrefixCutoffIdx, 4);
  assert.deepEqual(
    scan3.appendedSteps.map((s) => s.idx),
    [3, 4, 5]
  );
});

test('subagent step_type=132 with >64KB field 4.8 result still preserves 4.2 & 4.3 and aggregates child DB', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-hud-oversized-subagent-'));
  t.after(() => { closeTrackedDbs(t); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); });

  const mainId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const childId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const mainDb = createWalDb(t, dir, mainId);
  const childDb = createWalDb(t, dir, childId, mainId);

  mainDb.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (0, 14, 3, ?)').run(
    Buffer.from(seconds(1, 1000))
  );
  const subagentMeta = Buffer.from([
    ...seconds(1, 1001),
    ...message(4, [
      ...string(2, 'invoke_subagent'),
      ...string(3, JSON.stringify({ conversationId: childId })),
      ...string(8, 'R'.repeat(75_000)),
    ]),
    ...seconds(7, 1020),
    ...seconds(8, 1020),
    ...seconds(32, 1002),
  ]);
  assert.ok(subagentMeta.length > 65_536);
  mainDb.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (1, 132, 3, ?)').run(
    subagentMeta
  );

  childDb.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (0, 15, 3, ?)').run(
    modelStepMeta({
      start: 1003,
      end: 1018,
      execution: 'child-exec-1',
      rawInputTokens: 3000,
      cachedReadTokens: 7000,
      outputTokens: 500,
    })
  );

  const scan = await runHudDbScanInWorker({
    dbPath: path.join(dir, `${mainId}.db`),
    inlineBlobLimitBytes: 65_536,
  });
  const parsedSubagentStep = parseStepMetadataBlob(
    scan.appendedSteps[1].idx,
    scan.appendedSteps[1].step_type,
    scan.appendedSteps[1].status,
    scan.appendedSteps[1].metadata
  );
  assert.equal(parsedSubagentStep.toolCallName, 'invoke_subagent');
  assert.equal(parsedSubagentStep.isSubagentStep, true);
  assert.deepEqual(parsedSubagentStep.childConversationIds, [childId]);

  const engine = new ConversationMetricsEngine({ conversationsDir: dir });
  const metrics = await engine.getConversationMetrics({ conversationId: mainId });
  assert.equal(metrics.availability, 'ready');
  assert.equal(metrics.session.subagentCount, 1);
  assert.equal(metrics.session.subagentSteps, 1);
  assert.equal(metrics.session.steps, 3);
  assert.equal(metrics.tokens.totalTokens, 10_500);
});

test('default projectProtobuf without skipOversizedLeafFields still throws proto.err.field_bytes_limit', () => {
  const stepBuf = Buffer.from([
    ...seconds(1, 1000),
    ...message(4, [
      ...string(2, 'write_file'),
      ...string(3, 'a'.repeat(70_000)),
    ]),
    ...string(12, 'exec-strict'),
  ]);

  assert.throws(
    () =>
      projectProtobuf(
        stepBuf.length,
        (offset, length) => stepBuf.subarray(offset, offset + length),
        HUD_STEP_METADATA_PROJECTION
      ),
    /安全上限/
  );

  const permissive = projectProtobuf(
    stepBuf.length,
    (offset, length) => stepBuf.subarray(offset, offset + length),
    HUD_STEP_METADATA_PROJECTION,
    { skipOversizedLeafFields: true }
  );
  const parsed = parseStepMetadataBlob(1, 132, 3, permissive.data);
  assert.equal(parsed.toolCallName, 'write_file');
  assert.equal(parsed.createdAtSeconds, 1000);
  assert.equal(parsed.executionId, Buffer.from('exec-strict').toString('hex'));
});
