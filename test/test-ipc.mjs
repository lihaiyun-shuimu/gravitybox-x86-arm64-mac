import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as pause } from 'node:timers/promises';
import { resolveClientIpcTarget } from '../dist/platform/index.js';

export function isChildExited(child) {
  return !child || child.exitCode !== null || child.signalCode !== null;
}

export async function stopBackendChild(child, timeoutMs = 3000) {
  if (isChildExited(child)) return;
  try {
    child.kill('SIGTERM');
  } catch {}
  await Promise.race([once(child, 'exit').catch(() => {}), pause(timeoutMs)]);
  if (!isChildExited(child)) {
    try {
      child.kill('SIGKILL');
    } catch {}
    await Promise.race([once(child, 'exit').catch(() => {}), pause(1500)]);
  }
}

export async function waitForBackendReady(stateDir, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15000;
  const intervalMs = options.intervalMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const target = await resolveClientIpcTarget(stateDir);
      if (target) {
        await new Promise((resolveConn, rejectConn) => {
          const sock = createConnection(target.endpoint);
          sock.once('connect', () => {
            sock.destroy();
            resolveConn();
          });
          sock.once('error', (err) => {
            sock.destroy();
            rejectConn(err);
          });
          sock.setTimeout(500, () => {
            sock.destroy();
            rejectConn(new Error('probe timeout'));
          });
        });
        return target;
      }
    } catch {}
    await pause(intervalMs);
  }
  throw new Error('backend not ready');
}

export async function sendBackendRpc(stateDir, payload, options = {}) {
  const timeoutMs = options.timeoutMs ?? options.timeout ?? 10000;
  const target = await resolveClientIpcTarget(stateDir);
  if (!target) {
    throw new Error('backend IPC target unavailable');
  }
  const wirePayload =
    target.authToken && payload && typeof payload === 'object' && !Array.isArray(payload) && payload.authToken === undefined
      ? { ...payload, authToken: target.authToken }
      : payload;

  return new Promise((resolveReply, rejectReply) => {
    const sock = createConnection(target.endpoint);
    let buffer = '';
    sock.on('error', rejectReply);
    sock.on('connect', () => {
      sock.write(JSON.stringify(wirePayload) + '\n');
    });
    sock.setTimeout(timeoutMs, () => {
      sock.destroy();
      rejectReply(new Error('timeout'));
    });
    sock.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.includes('\n')) {
        sock.end();
        try {
          resolveReply(JSON.parse(buffer.split('\n')[0]));
        } catch (err) {
          rejectReply(err);
        }
      }
    });
  });
}

export function resolveOpensslBin() {
  if (process.platform !== 'win32') return '/usr/bin/openssl';
  const candidates = [
    process.env.OPENSSL_BIN,
    'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
    'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe',
    'C:\\Program Files\\OpenSSL-Win64\\bin\\openssl.exe',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return 'openssl';
}

export function sqliteExec(dbPath, sql) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

export function sqliteQueryAll(dbPath, sql) {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare(sql).all().map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}
