import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
import { access, mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  IPC_SESSION_FILENAME,
  antigravityLayout,
  atomicRenameWithRetry,
  cleanupIpcEndpoint,
  cleanupIpcSession,
  computeWindowsStateHash16,
  createWindowsIpcSession,
  defaultAntigravityAppPath,
  defaultAntigravityInstallDirs,
  defaultAntigravityProfileDir,
  defaultAppSupportDir,
  defaultGravityBoxCacheDir,
  defaultGravityBoxStateDir,
  defaultTrashDir,
  finalizeIpcEndpointAfterListen,
  ipcSessionPath,
  isNamedPipe,
  isOwnedByCurrentUser,
  isPathUnder,
  isRandomWindowsPipeName,
  isValidIpcAuthToken,
  normalizePathForCompare,
  pathsEqual,
  prepareIpcEndpointForListen,
  prepareWindowsIpcForListen,
  readIpcSession,
  resolveClientIpcTarget,
  resolveIpcEndpoint,
  safeOpenFlagsNoFollow,
  validateIpcEndpointForClient,
  verifyIpcAuthToken,
  writeIpcSession,
} from '../dist/platform/index.js';
import {
  matchingTargetForLanguageServerCommand,
  resolveBundleLayout,
  targetForApp,
} from '../dist/application-target.js';
import { inspectBundle, normalizePeVersionString } from '../dist/discovery.js';
import { readInstalledAppBundleVersion } from '../dist/pricing-catalog-runtime.js';
import {
  AccountsManager,
  MockKeychainAdapter,
  cloudOriginFromCommand,
  cloudProviderContextFromCommand,
  decodeKeychainOauthPayload,
  encodeKeychainOauthPayload,
  syncAccountToKeychain,
  validCachedCloudProviderContext,
} from '../dist/accounts.js';
import {
  clearLiveEndpointCache,
  probeLiveLanguageServerOnce,
} from '../dist/account-probe.js';
import { groupToQuotaGroup, modelQuotaFromNormalized } from '../dist/account-quota.js';
import { AccountSwitchService, DatabaseTransaction } from '../dist/account-switch.js';
import {
  CacheMaintenance,
  hasAntigravityCommand,
  hasBrowserProfileCommand,
  isStrictSubpath,
} from '../dist/maintenance.js';
import { acquireProcessLease } from '../dist/process-lock.js';
import { atomicText } from '../dist/files.js';
import { detectSystemLocales, normalizeLocale, resolveLocale } from '../dist/i18n.js';
import {
  parseEnvProxySnapshot,
  parseWindowsInternetSettingsOutput,
  readSystemProxySnapshot,
  resolveWindowsRegExePath,
  shouldBypassProxy,
} from '../dist/proxy.js';
import {
  matchMainLogRemotePort,
  parseSshTunnelProcesses,
  resolveWindowsPowerShellPath,
} from '../dist/ssh-context.js';
import {
  includeSourceDigestPath,
  includeWindowsSourceDigestPath,
  sourceDigest,
  windowsSourceDigest,
} from '../tools/release-integrity.mjs';

function buildMinimalAsar(filesObj, payloadBuffers) {
  const headerBuf = Buffer.from(JSON.stringify({ files: filesObj }), 'utf8');
  const alignedHeaderSize = Math.ceil((headerBuf.length + 4) / 4) * 4;
  const prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(alignedHeaderSize + 4, 4);
  prefix.writeUInt32LE(alignedHeaderSize, 8);
  prefix.writeUInt32LE(headerBuf.length, 12);
  const paddedHeader = Buffer.alloc(alignedHeaderSize - 4);
  headerBuf.copy(paddedHeader, 0);
  return Buffer.concat([prefix, paddedHeader, ...payloadBuffers]);
}

function sendNdjsonOverPipe(pipePath, payload) {
  return new Promise((resolveReply, rejectReply) => {
    const sock = createConnection(pipePath);
    let buf = '';
    sock.setTimeout(8000);
    sock.on('timeout', () => {
      sock.destroy();
      rejectReply(new Error('IPC timeout'));
    });
    sock.on('error', rejectReply);
    sock.on('connect', () => {
      sock.write(JSON.stringify(payload) + '\n');
    });
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      if (buf.includes('\n')) {
        sock.end();
        try {
          resolveReply(JSON.parse(buf.split('\n')[0]));
        } catch (err) {
          rejectReply(err);
        }
      }
    });
  });
}

test('platform/paths: Windows 与 macOS 路径解析、布局及比较零回归', () => {
  const winEnv = {
    APPDATA: 'C:\\Users\\demo\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\demo\\AppData\\Local',
    ProgramFiles: 'C:\\Program Files',
  };
  assert.equal(defaultAppSupportDir('C:\\Users\\demo', winEnv, 'win32'), 'C:\\Users\\demo\\AppData\\Roaming');
  assert.equal(defaultGravityBoxStateDir('C:\\Users\\demo', winEnv, 'win32'), 'C:\\Users\\demo\\AppData\\Roaming\\GravityBox');
  assert.equal(defaultGravityBoxCacheDir('C:\\Users\\demo', winEnv, 'win32'), 'C:\\Users\\demo\\AppData\\Local\\GravityBox\\Cache');
  assert.equal(defaultAntigravityProfileDir('C:\\Users\\demo', winEnv, 'win32'), 'C:\\Users\\demo\\AppData\\Roaming\\Antigravity');
  assert.equal(defaultTrashDir('C:\\Users\\demo', winEnv, 'win32'), 'C:\\Users\\demo\\AppData\\Local\\GravityBox\\Cache\\maintenance-trash');
  assert.deepEqual(defaultAntigravityInstallDirs('C:\\Users\\demo', winEnv, 'win32'), [
    'C:\\Users\\demo\\AppData\\Local\\Programs',
    'C:\\Program Files',
  ]);

  const pfApp = defaultAntigravityAppPath(
    'C:\\Users\\demo',
    winEnv,
    'win32',
    (p) => p.toLowerCase() === 'c:\\program files\\antigravity\\antigravity.exe',
  );
  assert.equal(pfApp, 'C:\\Program Files\\Antigravity');

  // macOS 路径语义完全保持不变
  assert.equal(defaultAppSupportDir('/Users/demo', {}, 'darwin'), '/Users/demo/Library/Application Support');
  assert.equal(defaultGravityBoxStateDir('/Users/demo', {}, 'darwin'), '/Users/demo/Library/Application Support/GravityBox');
  assert.equal(defaultGravityBoxCacheDir('/Users/demo', {}, 'darwin'), '/Users/demo/Library/Caches/GravityBox');
  assert.equal(defaultTrashDir('/Users/demo', {}, 'darwin'), '/Users/demo/.Trash');
  assert.equal(defaultAntigravityAppPath('/Users/demo', {}, 'darwin'), '/Applications/Antigravity.app');

  // 布局解析
  const winLayout = antigravityLayout('C:\\Users\\demo\\AppData\\Local\\Programs\\Antigravity', 'win32');
  assert.equal(winLayout.executableName, 'Antigravity.exe');
  assert.equal(winLayout.executablePath, 'C:\\Users\\demo\\AppData\\Local\\Programs\\Antigravity\\Antigravity.exe');
  assert.equal(winLayout.asarPath, 'C:\\Users\\demo\\AppData\\Local\\Programs\\Antigravity\\resources\\app.asar');
  assert.equal(winLayout.languageServerPath, 'C:\\Users\\demo\\AppData\\Local\\Programs\\Antigravity\\resources\\bin\\language_server.exe');
  assert.equal(winLayout.infoPlistPath, null);

  const macLayout = resolveBundleLayout('/Applications/Antigravity.app');
  assert.equal(macLayout.executableName, 'Antigravity');
  assert.equal(macLayout.asarPath, '/Applications/Antigravity.app/Contents/Resources/app.asar');
  assert.equal(macLayout.languageServerPath, '/Applications/Antigravity.app/Contents/Resources/bin/language_server');

  // Windows 路径归一化与子路径边界防碰撞
  assert.equal(normalizePathForCompare('\\\\?\\C:\\Users\\Demo\\App\\', 'win32'), 'c:/users/demo/app');
  assert.equal(pathsEqual('C:\\Users\\demo\\Programs\\Antigravity', 'c:/users/demo/programs/antigravity/', 'win32'), true);
  assert.equal(isPathUnder('C:\\Users\\demo\\App\\sub\\file.txt', 'c:/users/demo/app', 'win32'), true);
  assert.equal(isPathUnder('C:\\Users\\demo\\App2\\file.txt', 'C:\\Users\\demo\\App', 'win32'), false);
  if (process.platform === 'win32') {
    assert.equal(isStrictSubpath('C:\\Users\\demo\\App', 'D:\\Users\\demo\\App\\file.txt'), false);
  }
  // isStrictSubpath 必须先 resolve() 相对路径，保持与原版语义一致
  assert.equal(isStrictSubpath('foo', 'foo/bar'), true);
  assert.equal(isStrictSubpath('foo', 'foo/bar/baz.txt'), true);
  assert.equal(isStrictSubpath('foo', 'foo'), false);
  assert.equal(isStrictSubpath('foo', 'foo/../bar'), false);
  assert.equal(isStrictSubpath('foo', 'foobar/baz'), false);
});

test('application-target & account-probe: Windows 引号路径、大小写混合命令行与 .exe 后缀匹配', () => {
  const appPath = 'C:\\Program Files\\Antigravity';
  const target = targetForApp(appPath, 'C:\\Users\\alice');
  assert.equal(target.executable, 'Antigravity.exe');

  const quotedCmd = '"C:\\Program Files\\antigravity\\resources\\bin\\language_server.exe" --app_data_dir antigravity --cloud_code_endpoint https://daily-cloudcode-pa.googleapis.com --subclient_type hub --override_ide_version 2.34.0';
  const unquotedCmd = 'c:\\program files\\antigravity\\resources\\bin\\language_server.exe --app_data_dir antigravity --cloud_code_endpoint=https://daily-cloudcode-pa.googleapis.com --subclient_type=hub';

  assert.equal(matchingTargetForLanguageServerCommand(quotedCmd, target)?.appPath, appPath);
  assert.equal(matchingTargetForLanguageServerCommand(unquotedCmd, target)?.appPath, appPath);
  assert.equal(cloudOriginFromCommand(quotedCmd, target), 'https://daily-cloudcode-pa.googleapis.com');

  const ctx = cloudProviderContextFromCommand(quotedCmd, '2.34.0', target);
  assert.ok(ctx);
  assert.equal(ctx.userAgent, 'antigravity/hub/2.34.0');
  assert.equal(validCachedCloudProviderContext(ctx, '2.34.0', target), true);

  // Insiders 必须被拒绝
  const insidersCmd = '"C:\\Program Files\\Antigravity - Insiders\\resources\\bin\\language_server.exe" --app_data_dir antigravity-insiders --cloud_code_endpoint https://daily-cloudcode-pa.googleapis.com';
  assert.equal(matchingTargetForLanguageServerCommand(insidersCmd, target), null);
  assert.equal(cloudOriginFromCommand(quotedCmd.replace('antigravity ', 'antigravity-insiders '), target), null);
  assert.throws(() => targetForApp('C:\\Users\\alice\\AppData\\Local\\Programs\\Antigravity - Insiders'), /仅支持/);
});

test('platform/ipc: Windows 随机管道名、ipc-session.json 防抢注、timingSafeEqual 鉴权与 macOS 零回归', async (t) => {
  const dirA = 'C:\\Users\\demo\\AppData\\Roaming\\GravityBox';
  const dirB = 'c:\\users\\demo\\appdata\\roaming\\gravitybox\\';
  const pipeA = resolveIpcEndpoint(dirA, 'win32');
  const pipeB = resolveIpcEndpoint(dirB, 'win32');
  assert.equal(isNamedPipe(pipeA), true);
  assert.match(pipeA, /^\\\\\.\\pipe\\gravitybox-[0-9a-f]{24}$/);
  assert.equal(pipeA, pipeB, 'Windows Named Pipe 哈希必须大小写与尾斜杠无关');
  assert.equal(computeWindowsStateHash16(dirA), computeWindowsStateHash16(dirB));
  assert.equal(resolveIpcEndpoint('/Users/demo/Library/Application Support/GravityBox', 'darwin'), '/Users/demo/Library/Application Support/GravityBox/control.sock');
  assert.equal(isNamedPipe('/Users/demo/Library/Application Support/GravityBox/control.sock'), false);

  // macOS resolveClientIpcTarget 保持 control.sock + authToken: null
  const macTarget = await resolveClientIpcTarget('/Users/demo/Library/Application Support/GravityBox', { platform: 'darwin' });
  assert.deepEqual(macTarget, {
    endpoint: '/Users/demo/Library/Application Support/GravityBox/control.sock',
    authToken: null,
    session: null,
  });

  // 随机防抢注会话生成与恒定时间 token 校验（双端纯逻辑均可验证）
  const stateDir = await mkdtemp(join(tmpdir(), 'gb-ipc-session-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const sess1 = createWindowsIpcSession(stateDir, process.pid);
  const sess2 = createWindowsIpcSession(stateDir, process.pid);
  assert.equal(isRandomWindowsPipeName(sess1.pipeName), true);
  assert.equal(isValidIpcAuthToken(sess1.authToken), true);
  assert.notEqual(sess1.pipeName, sess2.pipeName);
  assert.notEqual(sess1.authToken, sess2.authToken);
  assert.equal(verifyIpcAuthToken(sess1.authToken, sess1.authToken), true);
  assert.equal(verifyIpcAuthToken(sess2.authToken, sess1.authToken), false);
  assert.equal(verifyIpcAuthToken('', sess1.authToken), false);
  assert.equal(verifyIpcAuthToken(null, sess1.authToken), false);

  // 原子写入、读取、身份校验回调与按 PID 精确清理
  const writtenPath = await writeIpcSession(stateDir, sess1);
  assert.equal(writtenPath, ipcSessionPath(stateDir));
  assert.ok(writtenPath.endsWith(IPC_SESSION_FILENAME));
  const readBack = await readIpcSession(stateDir);
  assert.deepEqual(readBack, sess1);

  const clientOk = await resolveClientIpcTarget(stateDir, {
    platform: 'win32',
    verifyServerIdentity: async (s) => ({ pipeName: s.pipeName, serverPid: s.pid, sameUserSid: true }),
  });
  assert.equal(clientOk?.endpoint, sess1.pipeName);
  assert.equal(clientOk?.authToken, sess1.authToken);

  await assert.rejects(
    () =>
      resolveClientIpcTarget(stateDir, {
        platform: 'win32',
        verifyServerIdentity: async (s) => ({ pipeName: s.pipeName, serverPid: s.pid, sameUserSid: false }),
      }),
  );

  // 不匹配 PID 时不得误删会话文件
  await cleanupIpcSession(stateDir, process.pid + 99999);
  assert.ok(await readIpcSession(stateDir));
  await cleanupIpcSession(stateDir, process.pid);
  assert.equal(await readIpcSession(stateDir), null);

  if (process.platform !== 'win32') return;

  // Windows 真机 Named Pipe 监听 + 重复实例拒绝 + 清理
  const liveSession = await prepareWindowsIpcForListen(stateDir);
  const srv = createServer((sock) => sock.end());
  await new Promise((res, rej) => {
    srv.once('error', rej);
    srv.listen(liveSession.pipeName, res);
  });
  t.after(() => new Promise((res) => srv.close(() => res())));
  await finalizeIpcEndpointAfterListen(liveSession.pipeName);
  await writeIpcSession(stateDir, liveSession);
  await validateIpcEndpointForClient(liveSession.pipeName);
  await assert.rejects(() => prepareWindowsIpcForListen(stateDir), /运行|running/i);
  await assert.rejects(() => prepareIpcEndpointForListen(liveSession.pipeName), /运行|running/i);
  await cleanupIpcEndpoint(liveSession.pipeName);
  await cleanupIpcSession(stateDir, process.pid);
});

test('main.ts IPC: Windows 随机 Named Pipe 强制校验 authToken、CLI 自动鉴权与退出清理', async (t) => {
  if (process.platform !== 'win32') return;
  const stateDir = await mkdtemp(join(tmpdir(), 'gb-win-main-ipc-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));

  const child = spawn(process.execPath, ['dist/main.js', '--state-dir', stateDir], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill(); } catch {}
    }
  });

  // 等待 ipc-session.json 原子落盘
  let session = null;
  for (let i = 0; i < 80; i++) {
    session = await readIpcSession(stateDir).catch(() => null);
    if (session) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(session, 'Windows 后端启动后必须写出 ipc-session.json');
  assert.equal(isRandomWindowsPipeName(session.pipeName), true);
  assert.equal(isValidIpcAuthToken(session.authToken), true);

  // 1. 缺失 authToken 的未授权请求必须被拒绝
  const unauthRes = await sendNdjsonOverPipe(session.pipeName, { command: 'ping' });
  assert.equal(unauthRes.ok, false);

  // 2. 错误 authToken 必须被拒绝
  const wrongToken = session.authToken.startsWith('0') ? '1' + session.authToken.slice(1) : '0' + session.authToken.slice(1);
  const forgedRes = await sendNdjsonOverPipe(session.pipeName, { command: 'ping', authToken: wrongToken });
  assert.equal(forgedRes.ok, false);

  // 3. 正确 authToken 请求成功
  const okPing = await sendNdjsonOverPipe(session.pipeName, { command: 'ping', authToken: session.authToken });
  assert.equal(okPing.ok, true);
  assert.equal(okPing.pid, session.pid);

  // 4. CLI --command 自动读取 ipc-session.json 鉴权且不泄漏 authToken
  const cliOut = execFileSync(process.execPath, ['dist/main.js', '--state-dir', stateDir, '--command', 'ping'], {
    encoding: 'utf8',
    timeout: 8000,
  });
  assert.equal(cliOut.includes(session.authToken), false, 'CLI 输出不得泄漏 authToken');
  const cliJson = JSON.parse(cliOut.trim());
  assert.equal(cliJson.ok, true);

  // 5. 合法 stop 优雅退出、stderr 为空且清理 ipc-session.json
  const stopRes = await sendNdjsonOverPipe(session.pipeName, { command: 'stop', authToken: session.authToken });
  assert.equal(stopRes.ok, true);
  const exitCode = await new Promise((res) => {
    if (child.exitCode !== null || child.signalCode !== null) return res(child.exitCode);
    child.once('exit', (code) => res(code));
  });
  assert.equal(exitCode, 0);
  assert.equal(stderr.trim(), '');
  assert.equal(stderr.includes(session.authToken), false);
  await assert.rejects(() => access(ipcSessionPath(stateDir)));
});

test('platform/fs & process-lock: 跨平台所有权校验、退避重试重命名与无 lsof 陈旧锁回收', async (t) => {
  assert.equal(isOwnedByCurrentUser({ uid: 0 }, 'win32', undefined), true);
  assert.equal(isOwnedByCurrentUser({ uid: 501 }, 'darwin', 501), true);
  assert.equal(isOwnedByCurrentUser({ uid: 0 }, 'darwin', 501), false);
  assert.equal(safeOpenFlagsNoFollow('win32'), 0);

  // atomicRenameWithRetry 在模拟 Windows EBUSY/EPERM 后成功
  let attempts = 0;
  await atomicRenameWithRetry('src.tmp', 'dst.json', {
    platform: 'win32',
    baseDelayMs: 5,
    maxRetries: 4,
    renameFn: () => {
      attempts += 1;
      if (attempts < 3) {
        const err = new Error('locked');
        err.code = attempts === 1 ? 'EBUSY' : 'EPERM';
        throw err;
      }
    },
  });
  assert.equal(attempts, 3);

  // atomicText 与 atomicRenameWithRetry 均须严格遵循已中止的 AbortSignal
  const abortDir = await mkdtemp(join(tmpdir(), 'gb-win-abort-'));
  t.after(() => rm(abortDir, { recursive: true, force: true }));
  const abortedTarget = join(abortDir, 'should-not-exist.txt');
  const preAborted = new AbortController();
  preAborted.abort(new Error('cancelled-before-write'));
  await assert.rejects(
    () => atomicText(abortedTarget, 'must-not-write', preAborted.signal),
    /cancelled-before-write/,
  );
  await assert.rejects(() => access(abortedTarget));

  let renameCallsAfterAbort = 0;
  await assert.rejects(
    () =>
      atomicRenameWithRetry('src.tmp', 'dst.json', {
        platform: 'win32',
        signal: preAborted.signal,
        renameFn: () => {
          renameCallsAfterAbort += 1;
        },
      }),
    /cancelled-before-write/,
  );
  assert.equal(renameCallsAfterAbort, 0);

  // 进程锁：死 PID 与陈旧半残损锁自动回收
  const dir = await mkdtemp(join(tmpdir(), 'gb-win-lock-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const lockPath = join(dir, 'test.lock');

  await writeFile(lockPath, JSON.stringify({ pid: 99999999, nonce: 'dead-owner' }));
  const lease1 = await acquireProcessLease(lockPath, 3000);
  await lease1.release();

  // 仅在 Windows 上测试无 lsof 残损孤儿锁回收（macOS 仍走 lsof 路径）
  if (process.platform === 'win32') {
    await writeFile(lockPath, 'not-valid-json');
    const oldDate = new Date(Date.now() - 60_000);
    await utimes(lockPath, oldDate, oldDate);
    const lease2 = await acquireProcessLease(lockPath, 3000);
    await lease2.release();
  }
});

test('account-keychain & account-switch: Windows raw UTF-8 JSON 编码、node:sqlite 事务及切号回滚', async (t) => {
  const sampleAcc = {
    email: 'alice@example.invalid',
    token: {
      access_token: 'synthetic-access',
      refresh_token: '1//synthetic-refresh',
      expiry_timestamp: Math.floor(Date.now() / 1000) + 3600,
    },
  };
  const winPayload = encodeKeychainOauthPayload(sampleAcc, 'raw');
  const macPayload = encodeKeychainOauthPayload(sampleAcc, 'go-keyring-base64');
  assert.ok(winPayload.startsWith('{'));
  assert.ok(macPayload.startsWith('go-keyring-base64:'));
  assert.equal(JSON.parse(decodeKeychainOauthPayload(winPayload)).token.email, 'alice@example.invalid');
  assert.equal(JSON.parse(decodeKeychainOauthPayload(macPayload)).token.email, 'alice@example.invalid');

  const winKeychain = new MockKeychainAdapter({ payloadEncoding: 'raw' });
  await syncAccountToKeychain(sampleAcc, winKeychain);
  const storedRaw = await winKeychain.readPassword('gemini', 'antigravity');
  assert.ok(storedRaw && storedRaw.startsWith('{'));
  assert.equal(JSON.parse(storedRaw).id_token_email, 'alice@example.invalid');

  const root = await mkdtemp(join(tmpdir(), 'gb-win-switch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, 'state');
  const profileDir = join(root, 'profile');
  await mkdir(join(profileDir, 'User', 'globalStorage'), { recursive: true });
  const dbPath = join(profileDir, 'User', 'globalStorage', 'state.vscdb');
  const initDb = new DatabaseSync(dbPath);
  try {
    initDb.exec("CREATE TABLE ItemTable(key TEXT PRIMARY KEY, value TEXT); INSERT INTO ItemTable VALUES('unrelated', 'keep');");
  } finally {
    initDb.close();
  }

  const tx = new DatabaseTransaction(dbPath);
  await tx.begin();
  await tx.replace({ antigravityOnboarding: 'true' });
  await tx.finish(false);
  await tx.close();

  const checkConn = new DatabaseSync(dbPath);
  try {
    const checkRows = checkConn.prepare('SELECT key, value FROM ItemTable').all().map((r) => ({ ...r }));
    assert.deepEqual(checkRows, [{ key: 'unrelated', value: 'keep' }]);
  } finally {
    checkConn.close();
  }

  const mgr = new AccountsManager(stateDir);
  const acc = await mgr.upsertAccount({
    email: 'switch-win@example.invalid',
    name: 'Win Switch',
    refreshToken: '1//win-refresh-01',
    accessToken: 'synthetic-win-access',
    expiresIn: 3600,
  });
  const initialRawCred = JSON.stringify({
    token: { access_token: 'prev', refresh_token: '1//prev-win', email: 'prev@example.invalid', expiry_timestamp: 1900000000 },
    id_token_email: 'prev@example.invalid',
  });
  await winKeychain.writePassword('gemini', 'antigravity', initialRawCred);

  const service = new AccountSwitchService(mgr, {
    stateDir,
    profile: profileDir,
    keychain: winKeychain,
    isRunning: async () => false,
  });
  const res = await service.switchAccount(acc.id);
  assert.equal(res.switchedTo, 'switch-win@example.invalid');
  const afterSwitchCred = await winKeychain.readPassword('gemini', 'antigravity');
  assert.ok(afterSwitchCred?.startsWith('{'));
  assert.equal(JSON.parse(afterSwitchCred).id_token_email, 'switch-win@example.invalid');

  const readbackMgr = new AccountsManager(join(root, 'readback'));
  const savedCurrent = await readbackMgr.saveCurrentAccount({
    keychain: winKeychain,
    homeDir: join(root, 'empty-home'),
    appSupportDir: join(root, 'empty-appdata'),
  });
  assert.equal(savedCurrent.email, 'switch-win@example.invalid');

  await service.rollback();
  assert.equal(await winKeychain.readPassword('gemini', 'antigravity'), initialRawCred);

  // 无 state.vscdb（Antigravity 2.x 场景）同样支持切号与回滚
  const noDbProfile = join(root, 'profile-nodb');
  await mkdir(noDbProfile, { recursive: true });
  const noDbState = join(root, 'state-nodb');
  const noDbMgr = new AccountsManager(noDbState);
  const noDbAcc = await noDbMgr.upsertAccount({
    email: 'nodb-win@example.invalid',
    name: 'NoDb Win',
    refreshToken: '1//nodb-refresh',
    accessToken: 'synthetic-nodb-access',
    expiresIn: 3600,
  });
  const noDbKeychain = new MockKeychainAdapter({ payloadEncoding: 'raw' });
  await noDbKeychain.writePassword('gemini', 'antigravity', initialRawCred);
  const noDbService = new AccountSwitchService(noDbMgr, {
    stateDir: noDbState,
    profile: noDbProfile,
    keychain: noDbKeychain,
    isRunning: async () => false,
  });
  await noDbService.switchAccount(noDbAcc.id);
  assert.equal(JSON.parse(await noDbKeychain.readPassword('gemini', 'antigravity')).id_token_email, 'nodb-win@example.invalid');
  await noDbService.rollback();
  assert.equal(await noDbKeychain.readPassword('gemini', 'antigravity'), initialRawCred);
});

test('account-probe: Windows lsInspect 路径多端口探测并严格脱敏 csrfToken', async () => {
  clearLiveEndpointCache();
  const winAppPath = 'C:\\Users\\demo\\AppData\\Local\\Programs\\Antigravity';
  const target = targetForApp(winAppPath, 'C:\\Users\\demo');
  const csrf = 'synthetic-win-peb-csrf-token-36-chars';

  const lsInspectImpl = async () => [
    {
      pid: 1001,
      exePath: 'C:\\Users\\demo\\AppData\\Local\\Programs\\Antigravity - Insiders\\resources\\bin\\language_server.exe',
      cmdLine: '"C:\\Users\\demo\\AppData\\Local\\Programs\\Antigravity - Insiders\\resources\\bin\\language_server.exe" --app_data_dir antigravity-insiders',
      ports: [51001],
      csrfToken: 'insiders-should-ignore',
    },
    {
      pid: 2002,
      exePath: 'C:\\Users\\demo\\AppData\\Local\\Programs\\antigravity\\resources\\bin\\language_server.exe',
      cmdLine: '"C:\\Users\\demo\\AppData\\Local\\Programs\\antigravity\\resources\\bin\\language_server.exe" --app_data_dir antigravity --subclient_type hub',
      ports: [52001, 52002],
      csrfToken: csrf,
    },
  ];

  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    const port = Number(parsed.port);
    const token = init?.headers?.['x-codeium-csrf-token'];
    if (port !== 52002 || token !== csrf) return new Response('nope', { status: 403 });
    if (parsed.pathname.endsWith('/GetUserStatus')) {
      return Response.json({
        userStatus: {
          email: 'win-live@example.invalid',
          name: 'Win User',
          userTier: { id: 'g1-pro-tier', name: 'Google AI Pro' },
          cascadeModelConfigData: {
            clientModelConfigs: [
              {
                label: 'Gemini 3.1 Pro (High)',
                modelOrAlias: { model: 'MODEL_PLACEHOLDER_M37' },
                quotaInfo: { remainingFraction: 0.8, resetTime: new Date(Date.now() + 3600_000).toISOString() },
              },
            ],
          },
        },
      });
    }
    return new Response('{}', { status: 404 });
  };

  const status = await probeLiveLanguageServerOnce(
    target,
    fetchImpl,
    { lsInspectImpl },
    { modelQuotaFromNormalized, groupToQuotaGroup },
  );
  assert.ok(status);
  assert.equal(status.email, 'win-live@example.invalid');
  assert.equal(status.tier, 'PRO');
  assert.equal(JSON.stringify(status).includes(csrf), false, '探测结果不得暴露 csrfToken');
  clearLiveEndpointCache();
});

test('discovery & pricing-catalog-runtime: Windows 安装包无签名正常探测且不误读 Electron version 文件', async (t) => {
  assert.equal(normalizePeVersionString('2.34.0.0'), '2.34.0');
  assert.equal(normalizePeVersionString('2.34.0'), '2.34.0');
  if (process.platform !== 'win32') return;

  const dir = await mkdtemp(join(tmpdir(), 'gb-win-bundle-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const appDir = join(dir, 'Antigravity');
  await mkdir(join(appDir, 'resources'), { recursive: true });
  await writeFile(join(appDir, 'version'), '44.9.1\n');
  await writeFile(join(appDir, 'Antigravity.exe'), Buffer.from('MZ-synthetic-unsigned-placeholder'));
  const pkgBuf = Buffer.from(JSON.stringify({ name: 'antigravity', version: '2.34.0', productName: 'Antigravity' }), 'utf8');
  const asarBuf = buildMinimalAsar({ 'package.json': { size: pkgBuf.length, offset: '0' } }, [pkgBuf]);
  await writeFile(join(appDir, 'resources', 'app.asar'), asarBuf);

  const inspected = await inspectBundle(appDir);
  assert.equal(inspected.version, '2.34.0');
  assert.equal(inspected.legacyPatch, false);

  const installedVer = await readInstalledAppBundleVersion(appDir);
  assert.equal(installedVer, '2.34.0');
});

test('maintenance: Windows 回收站清理成功路径与不可用时自动平滑降级到 fallbackTrashDir 可撤回恢复', async (t) => {
  assert.equal(
    hasAntigravityCommand(
      ['"C:\\Users\\demo\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe" --type=renderer'],
      'C:\\Users\\demo\\AppData\\Local\\Programs\\Antigravity',
    ),
    true,
  );
  assert.equal(
    hasBrowserProfileCommand(
      ['"C:\\Program Files\\Chrome\\chrome.exe" --user-data-dir=c:/users/demo/.gemini/antigravity/browser_profile'],
      'C:\\Users\\demo\\.gemini\\antigravity\\browser_profile',
    ),
    true,
  );
  if (process.platform !== 'win32') return;

  const rootA = await mkdtemp(join(tmpdir(), 'gb-win-trash-ok-'));
  t.after(() => rm(rootA, { recursive: true, force: true }));
  const profileA = join(rootA, 'profile');
  const stateA = join(rootA, 'state');
  await mkdir(join(profileA, 'Cache'), { recursive: true });
  await mkdir(stateA, { recursive: true });
  await writeFile(join(profileA, 'Cache', 'blob.bin'), Buffer.alloc(1024, 5));

  const trashedPaths = [];
  const maintA = new CacheMaintenance(profileA, undefined, async () => false, {
    stateDir: stateA,
    browserRunning: async () => false,
    moveToSystemTrash: async (paths) => {
      trashedPaths.push(...paths);
      for (const p of paths) await rm(p, { recursive: true, force: true });
      return { moved: [...paths] };
    },
  });
  const scanA = await maintA.scan();
  const clearA = await maintA.clear(scanA.token, ['Cache']);
  assert.equal(clearA.ok, true);
  assert.equal(clearA.moved, 1);
  assert.equal(clearA.movedToSystemTrash, true);
  assert.equal(clearA.usingFallbackTrash, false);
  assert.equal(clearA.restorableInApp, false);
  assert.equal(clearA.trashDir, 'Recycle Bin');
  assert.equal(trashedPaths.length, 1);

  const rootB = await mkdtemp(join(tmpdir(), 'gb-win-trash-fb-'));
  t.after(() => rm(rootB, { recursive: true, force: true }));
  const profileB = join(rootB, 'profile');
  const stateB = join(rootB, 'state');
  await mkdir(join(profileB, 'Cache'), { recursive: true });
  await mkdir(stateB, { recursive: true });
  await writeFile(join(profileB, 'Cache', 'restore-me.txt'), 'original-cache-data');

  const maintB = new CacheMaintenance(profileB, undefined, async () => false, {
    stateDir: stateB,
    browserRunning: async () => false,
    moveToSystemTrash: async () => {
      throw new Error('Recycle Bin unavailable');
    },
  });
  const scanB = await maintB.scan();
  const clearB = await maintB.clear(scanB.token, ['Cache']);
  assert.equal(clearB.ok, true);
  assert.equal(clearB.movedToSystemTrash, false);
  assert.equal(clearB.usingFallbackTrash, true);
  assert.equal(clearB.restorableInApp, true);
  assert.ok(clearB.restorePath.includes('maintenance-trash'));

  const restored = await maintB.restore(clearB.snapshotId);
  assert.equal(restored.ok, true);
  assert.equal(await readFile(join(profileB, 'Cache', 'restore-me.txt'), 'utf8'), 'original-cache-data');
});

test('proxy: Windows 注册表系统代理、分协议映射、环境变量回退与 <local> 旁路', async () => {
  const globalReg = `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    127.0.0.1:10808
    ProxyOverride    REG_SZ    <local>;localhost;127.*;10.*;*.corp.invalid
`;
  const snapGlobal = parseWindowsInternetSettingsOutput(globalReg);
  assert.equal(snapGlobal.httpEnabled, true);
  assert.equal(snapGlobal.httpUrl, 'http://127.0.0.1:10808');
  assert.equal(snapGlobal.httpsEnabled, true);
  assert.equal(snapGlobal.httpsUrl, 'http://127.0.0.1:10808');
  assert.deepEqual(snapGlobal.exceptions, ['<local>', 'localhost', '127.*', '10.*', '*.corp.invalid']);

  // <local> 应仅旁路单段内网主机名，不旁路公网域名
  assert.equal(shouldBypassProxy('https://intranet/api', snapGlobal.exceptions, ''), true);
  assert.equal(shouldBypassProxy('https://cloudcode-pa.googleapis.com/v1', snapGlobal.exceptions, ''), false);
  assert.equal(shouldBypassProxy('https://api.corp.invalid/v1', snapGlobal.exceptions, ''), true);

  // 分协议 ProxyServer
  const perProtoReg = `
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    http=127.0.0.1:7890;https=127.0.0.1:7891;socks=127.0.0.1:7892
`;
  const snapPerProto = parseWindowsInternetSettingsOutput(perProtoReg);
  assert.equal(snapPerProto.httpUrl, 'http://127.0.0.1:7890');
  assert.equal(snapPerProto.httpsUrl, 'http://127.0.0.1:7891');
  assert.equal(snapPerProto.socksUrl, 'socks5://127.0.0.1:7892');

  // ProxyEnable=0x0 时忽略 ProxyServer，但保留 PAC AutoConfigURL
  const pacReg = `
    ProxyEnable    REG_DWORD    0x0
    ProxyServer    REG_SZ    127.0.0.1:7890
    AutoConfigURL    REG_SZ    http://127.0.0.1:7890/proxy.pac
`;
  const snapPac = parseWindowsInternetSettingsOutput(pacReg);
  assert.equal(snapPac.httpEnabled, false);
  assert.equal(snapPac.pacEnabled, true);
  assert.equal(snapPac.pacUrl, 'http://127.0.0.1:7890/proxy.pac');

  // 环境变量回退解析
  const envSnap = parseEnvProxySnapshot({
    HTTPS_PROXY: 'http://127.0.0.1:8080',
    NO_PROXY: 'localhost,*.internal.invalid',
  });
  assert.equal(envSnap.httpsEnabled, true);
  assert.equal(envSnap.httpsUrl, 'http://127.0.0.1:8080');
  assert.deepEqual(envSnap.exceptions, ['localhost', '*.internal.invalid']);

  // readSystemProxySnapshot 在注册表未启用时自动回退到环境变量
  const fallbackSnap = await readSystemProxySnapshot({
    execWinReg: async () => '    ProxyEnable    REG_DWORD    0x0\n    ProxyOverride    REG_SZ    <local>\n',
    env: { HTTPS_PROXY: 'http://127.0.0.1:9090' },
  });
  assert.equal(fallbackSnap.httpsEnabled, true);
  assert.equal(fallbackSnap.httpsUrl, 'http://127.0.0.1:9090');
  assert.ok(fallbackSnap.exceptions.includes('<local>'));
});

test('ssh-context & proxy: Windows 系统绝对路径防劫持、OpenSSH 孙进程后代链匹配与 CRLF main.log', async (t) => {
  // SystemRoot -> WINDIR -> C:\Windows 绝对路径解析，彻底防 PATH/CWD 劫持
  assert.equal(resolveWindowsRegExePath({ SystemRoot: 'D:\\WinOS' }), 'D:\\WinOS\\System32\\reg.exe');
  assert.equal(resolveWindowsRegExePath({ WINDIR: 'E:\\Windows' }), 'E:\\Windows\\System32\\reg.exe');
  assert.equal(resolveWindowsRegExePath({}), 'C:\\Windows\\System32\\reg.exe');
  assert.equal(
    resolveWindowsPowerShellPath({ SystemRoot: 'D:\\WinOS' }),
    'D:\\WinOS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  );
  assert.equal(
    resolveWindowsPowerShellPath({ WINDIR: 'E:\\Windows' }),
    'E:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  );
  assert.equal(
    resolveWindowsPowerShellPath({}),
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  );

  // 直接子进程 + 渲染/扩展宿主拉起的孙进程后代链（含空命令行中间节点与环路保护）
  const winPs = [
    '0 0 ',
    '3000 100 "C:\\Users\\demo\\AppData\\Local\\Programs\\Antigravity\\Antigravity.exe"',
    '3050 3000 ',
    '3051 3050 "C:\\Users\\demo\\AppData\\Local\\Programs\\Antigravity\\Antigravity.exe" --type=extensionHost',
    '4201 3000 "C:\\Windows\\System32\\OpenSSH\\ssh.exe" -N -D 127.0.0.1:10888 dev@example.invalid',
    '4203 3051 "C:\\Windows\\System32\\OpenSSH\\ssh.exe" -N -D 127.0.0.1:10889 grandchild@example.invalid',
    '4202 9999 "C:\\Windows\\System32\\OpenSSH\\ssh.exe" -N -D 10999 other@example.invalid',
    '8001 8002 cycle-a',
    '8002 8001 cycle-b',
  ].join('\r\n');
  assert.deepEqual(parseSshTunnelProcesses(winPs, 3000), [{ pid: 4201, socksPort: 10888 }]);
  assert.deepEqual(parseSshTunnelProcesses(winPs, 3000, { includeDescendants: true }), [
    { pid: 4201, socksPort: 10888 },
    { pid: 4203, socksPort: 10889 },
  ]);

  const dir = await mkdtemp(join(tmpdir(), 'gb-win-sshlog-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const logPath = join(dir, 'main.log');
  await writeFile(
    logPath,
    '2026-11-23 20:00:00.123 [info] [SSH] Connected to dev-box at https://127.0.0.1:54321/\r\n',
    'utf8',
  );
  assert.equal(await matchMainLogRemotePort('54321', 'dev-box', { logPath }), true);
  assert.equal(await matchMainLogRemotePort('54322', 'dev-box', { logPath }), false);
});

test('i18n: Windows 系统语言检测走 Intl 且无需 macOS defaults', () => {
  const detected = detectSystemLocales();
  assert.ok(Array.isArray(detected) && detected.length > 0);
  assert.equal(normalizeLocale('zh-CN'), 'zh-Hans');
  assert.equal(normalizeLocale('zh-Hans-CN'), 'zh-Hans');
  assert.equal(resolveLocale('system', ['zh-CN']), 'zh-Hans');
  assert.equal(resolveLocale('system', ['en-US']), 'en');
});

test('release-integrity: macOS/core sourceDigest 严格排除 windows/，windowsSourceDigest 独立感知变更并忽略 target/', async (t) => {
  assert.equal(includeSourceDigestPath('windows/win-helper/src/main.rs'), false);
  assert.equal(includeSourceDigestPath('windows\\app\\src\\App.tsx'), false);
  assert.equal(includeSourceDigestPath('src/main.ts'), true);
  assert.equal(includeWindowsSourceDigestPath('windows/win-helper/src/main.rs'), true);
  assert.equal(includeWindowsSourceDigestPath('windows/win-helper/target/release/gravitybox-win-helper.exe'), false);
  assert.equal(includeWindowsSourceDigestPath('windows/app/node_modules/pkg/index.js'), false);
  assert.equal(includeWindowsSourceDigestPath('src/main.ts'), false);

  const fakeRoot = await mkdtemp(join(tmpdir(), 'gb-release-digest-decouple-'));
  t.after(() => rm(fakeRoot, { recursive: true, force: true }));

  for (const dir of ['src', 'runtime', 'native', 'tools', 'test', 'dict', 'ui-strings', 'assets', 'licenses']) {
    await mkdir(join(fakeRoot, dir), { recursive: true });
    await writeFile(join(fakeRoot, dir, 'placeholder.txt'), `${dir}\n`);
  }
  for (const rootFile of ['package.json', 'package-lock.json', 'tsconfig.json', 'README.md', 'THIRD_PARTY_NOTICES.md']) {
    await writeFile(join(fakeRoot, rootFile), `${rootFile}\n`);
  }
  await mkdir(join(fakeRoot, 'windows', 'win-helper', 'src'), { recursive: true });
  await mkdir(join(fakeRoot, 'windows', 'win-helper', 'target', 'release'), { recursive: true });
  const winSrcPath = join(fakeRoot, 'windows', 'win-helper', 'src', 'main.rs');
  const winTargetPath = join(fakeRoot, 'windows', 'win-helper', 'target', 'release', 'gravitybox-win-helper.exe');
  await writeFile(winSrcPath, 'fn main() {}\n');
  await writeFile(winTargetPath, 'artifact-v1\n');

  const coreDigest1 = await sourceDigest(fakeRoot);
  const winDigest1 = await windowsSourceDigest(fakeRoot);

  // 修改 windows/**/target/ 构建产物：双端指纹均不得变化
  await writeFile(winTargetPath, 'artifact-v2-changed\n');
  assert.equal(await sourceDigest(fakeRoot), coreDigest1);
  assert.equal(await windowsSourceDigest(fakeRoot), winDigest1);

  // 修改 windows/ 源码：macOS/core sourceDigest 绝对不变，windowsSourceDigest 必须变化
  await writeFile(winSrcPath, 'fn main() { println!("v2"); }\n');
  assert.equal(await sourceDigest(fakeRoot), coreDigest1);
  assert.notEqual(await windowsSourceDigest(fakeRoot), winDigest1);
});
