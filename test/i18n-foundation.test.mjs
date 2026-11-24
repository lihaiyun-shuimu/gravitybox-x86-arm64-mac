import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendBackendRpc, stopBackendChild } from './test-ipc.mjs';
import {
  bt,
  detectSystemLocales,
  getActiveLocale,
  listSupportedLocales,
  loadLocalePacks,
  normalizeLocale,
  parseAppleLanguagesOutput,
  resolveInitialRuntimeLanguage,
  resolveLocale,
  setActiveLocale,
  translate,
} from '../dist/i18n.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const i18nDir = join(root, 'assets', 'i18n');

function extractPlaceholders(value) {
  const names = new Set();
  for (const match of String(value).matchAll(/\{([a-zA-Z0-9_.-]+)\}/g)) {
    names.add(match[1]);
  }
  return [...names].sort();
}

test('assets/i18n 语言包结构合法、命名空间 Key 与占位符 100% 对齐', async () => {
  const files = (await readdir(i18nDir)).filter((f) => f.endsWith('.json')).sort();
  assert.ok(files.includes('zh-Hans.json') && files.includes('en.json'), '必须至少包含 zh-Hans 与 en 语言包');

  const rawPacks = new Map();
  for (const file of files) {
    const parsed = JSON.parse(await readFile(join(i18nDir, file), 'utf8'));
    assert.equal(typeof parsed.meta?.code, 'string', `${file} 必须声明 meta.code`);
    assert.equal(file, `${parsed.meta.code}.json`, `${file} 文件名必须与 meta.code 一致`);
    assert.equal(typeof parsed.meta?.nativeName, 'string', `${file} 必须声明 meta.nativeName`);
    assert.equal(typeof parsed.meta?.fallback, 'string', `${file} 必须声明 meta.fallback`);
    assert.equal(typeof parsed.meta?.hasTargetDictionary, 'boolean', `${file} 必须声明 meta.hasTargetDictionary`);
    for (const ns of ['app', 'backend', 'hud']) {
      assert.ok(parsed[ns] && typeof parsed[ns] === 'object' && !Array.isArray(parsed[ns]), `${file} 缺少 ${ns} 命名空间`);
    }
    rawPacks.set(parsed.meta.code, parsed);
  }

  const base = rawPacks.get('en');
  for (const [code, pack] of rawPacks.entries()) {
    for (const ns of ['app', 'backend', 'hud']) {
      const baseKeys = Object.keys(base[ns]).sort();
      const curKeys = Object.keys(pack[ns]).sort();
      assert.deepEqual(curKeys, baseKeys, `${code}.json 的 ${ns} 命名空间 Key 必须与基准 en.json 一致`);
      for (const k of baseKeys) {
        assert.equal(typeof pack[ns][k], 'string', `${code}.json [${ns}.${k}] 必须为字符串`);
        assert.ok(pack[ns][k].length > 0, `${code}.json [${ns}.${k}] 不能为空串`);
        assert.deepEqual(
          extractPlaceholders(pack[ns][k]),
          extractPlaceholders(base[ns][k]),
          `${code}.json [${ns}.${k}] 占位符参数必须与基准一致`
        );
      }
    }
  }
});

test('src/i18n 支持语言规范化、系统语言解析、多级回退与旧偏好迁移', async () => {
  const supported = listSupportedLocales().map((m) => m.code);
  assert.ok(supported.includes('zh-Hans') && supported.includes('en'));

  assert.equal(normalizeLocale('zh-CN'), 'zh-Hans');
  assert.equal(normalizeLocale('zh_SG'), 'zh-Hans');
  assert.equal(normalizeLocale('zh-TW'), 'zh-Hans'); // 未注册 zh-Hant 时回退至 zh-Hans
  assert.equal(normalizeLocale('en-US'), 'en');
  assert.equal(normalizeLocale('en_GB'), 'en');
  assert.equal(normalizeLocale('system'), null);

  assert.equal(resolveLocale('system', ['en-US']), 'en');
  assert.equal(resolveLocale('system', ['zh-Hans-CN']), 'zh-Hans');
  assert.equal(resolveLocale('system', ['fr-FR']), 'en');
  assert.equal(resolveLocale('en', ['zh-Hans-CN']), 'en');

  // 旧配置迁移契约
  assert.deepEqual(
    resolveInitialRuntimeLanguage({ legacyTranslationEnabled: false, systemLocales: ['zh-CN'] }),
    { configuredLanguage: 'en', resolvedLocale: 'en' }
  );
  assert.deepEqual(
    resolveInitialRuntimeLanguage({ legacyTranslationEnabled: true, systemLocales: ['en-US'] }),
    { configuredLanguage: 'zh-Hans', resolvedLocale: 'zh-Hans' }
  );
  assert.deepEqual(
    resolveInitialRuntimeLanguage({ systemLocales: ['en-US'] }),
    { configuredLanguage: 'system', resolvedLocale: 'en' }
  );
  assert.deepEqual(
    resolveInitialRuntimeLanguage({ configuredLanguage: 'zh-Hans', legacyTranslationEnabled: false, systemLocales: ['en-US'] }),
    { configuredLanguage: 'zh-Hans', resolvedLocale: 'zh-Hans' }
  );

  // 扩展新语言包（如 ja -> fallback en）时缺词不崩溃并自动回退
  const temp = await mkdtemp(join(tmpdir(), 'gb-i18n-ext-'));
  try {
    await writeFile(
      join(temp, 'en.json'),
      JSON.stringify({
        meta: { code: 'en', nativeName: 'English', fallback: 'en', hasTargetDictionary: false },
        app: { 'hello.user': 'Hello, {name}!' },
        backend: { 'only.en': 'Fallback English', 'shared.msg': 'English {n}' },
        hud: {},
      })
    );
    await writeFile(
      join(temp, 'ja.json'),
      JSON.stringify({
        meta: { code: 'ja', nativeName: '日本語', fallback: 'en', hasTargetDictionary: false },
        app: {},
        backend: { 'shared.msg': '日本語 {n}' },
        hud: {},
      })
    );
    const customPacks = loadLocalePacks(temp);
    assert.equal(normalizeLocale('ja-JP', customPacks), 'ja');
    assert.equal(resolveLocale('system', ['ja-JP'], customPacks), 'ja');
    assert.equal(translate('ja', 'shared.msg', { n: 3 }, { packs: customPacks }), '日本語 3');
    assert.equal(translate('ja', 'only.en', undefined, { packs: customPacks }), 'Fallback English');
    assert.equal(translate('ja', 'hello.user', { name: 'Antigravity' }, { namespace: 'app', packs: customPacks }), 'Hello, Antigravity!');
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('后端运行时 bt() 与 setActiveLocale() 多语言切换与插值行为正确', () => {
  const previous = getActiveLocale();
  try {
    setActiveLocale('en');
    assert.equal(getActiveLocale(), 'en');
    assert.equal(bt('quota.countdown.soon'), 'Resetting soon');
    assert.equal(bt('quota.countdown.hours_mins', { hours: 2, mins: 15 }), 'Resets in 2h 15m');
    assert.equal(bt('usage.all_accounts'), 'All Accounts');
    assert.equal(bt('scanner.err.access_denied'), 'Directory access denied');
    assert.equal(bt('candidate.route.settings'), 'Settings');
    assert.equal(
      bt('status.connected_adaptive_new', { version: '2.25.0', count: 12 }),
      'Connected (Adaptive mode: v2.25.0, 12 new strings found)'
    );

    setActiveLocale('zh-Hans');
    assert.equal(getActiveLocale(), 'zh-Hans');
    assert.equal(bt('quota.countdown.soon'), '即将重置');
    assert.equal(bt('quota.countdown.hours_mins', { hours: 2, mins: 15 }), '2小时 15分后重置');
    assert.equal(bt('usage.all_accounts'), '全部账号');
    assert.equal(bt('scanner.err.access_denied'), '目录访问受限');
    assert.equal(bt('candidate.route.settings'), '设置');
    assert.equal(
      bt('status.connected_adaptive_new', { version: '2.25.0', count: 12 }),
      '已连接（兼容模式：版本 2.25.0 发现 12 条新词）'
    );
  } finally {
    setActiveLocale(previous);
  }
});

test('macOS 无 LANG 环境或遵循 AppleLanguages 时 system 语言解析与后端 IPC 一致', async () => {
  assert.deepEqual(parseAppleLanguagesOutput('(\n    "zh-Hans-CN",\n    "en-US",\n    ja\n)\n'), ['zh-Hans-CN', 'en-US', 'ja']);
  assert.deepEqual(parseAppleLanguagesOutput('invalid'), []);

  const prevOverride = process.env.GRAVITYBOX_SYSTEM_LOCALES;
  const prevLang = process.env.LANG;
  const prevLcAll = process.env.LC_ALL;
  const prevLcMsg = process.env.LC_MESSAGES;
  try {
    delete process.env.LANG;
    delete process.env.LC_ALL;
    delete process.env.LC_MESSAGES;
    process.env.GRAVITYBOX_SYSTEM_LOCALES = 'zh-Hans-CN,en-US';
    assert.equal(resolveLocale('system'), 'zh-Hans');
    assert.deepEqual(resolveInitialRuntimeLanguage({ configuredLanguage: 'system' }), {
      configuredLanguage: 'system',
      resolvedLocale: 'zh-Hans',
    });

    delete process.env.GRAVITYBOX_SYSTEM_LOCALES;
    if (process.platform === 'darwin') {
      try {
        const appleRaw = execFileSync('/usr/bin/defaults', ['read', '-g', 'AppleLanguages'], { encoding: 'utf8' });
        const expected = parseAppleLanguagesOutput(appleRaw);
        if (expected.length > 0) {
          const detected = detectSystemLocales();
          assert.equal(detected[0], expected[0], 'macOS 下即使未设置 LANG/LC_ALL 也必须优先读取 AppleLanguages');
        }
      } catch {
        // ignore if defaults AppleLanguages is absent on runner
      }
    }
  } finally {
    if (prevOverride === undefined) delete process.env.GRAVITYBOX_SYSTEM_LOCALES;
    else process.env.GRAVITYBOX_SYSTEM_LOCALES = prevOverride;
    if (prevLang === undefined) delete process.env.LANG;
    else process.env.LANG = prevLang;
    if (prevLcAll === undefined) delete process.env.LC_ALL;
    else process.env.LC_ALL = prevLcAll;
    if (prevLcMsg === undefined) delete process.env.LC_MESSAGES;
    else process.env.LC_MESSAGES = prevLcMsg;
  }

  // 验证真实后端进程在无 LANG 环境下通过 --locale system + --system-locales 与 language_set 正确启用中文翻译
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rpc = (directory, payload) => sendBackendRpc(directory, payload, { timeoutMs: 8000 });

  const directory = await mkdtemp(join(tmpdir(), 'gb-i18n-ipc-'));
  await mkdir(join(directory, '词典'), { recursive: true });
  const env = { ...process.env, GRAVITYBOX_PROBE_LS: 'false' };
  delete env.LANG;
  delete env.LC_ALL;
  delete env.LC_MESSAGES;
  delete env.GRAVITYBOX_SYSTEM_LOCALES;

  const child = spawn(
    process.execPath,
    [
      join(root, 'dist', 'main.js'),
      '--state-dir', directory,
      '--locale', 'system',
      '--system-locales', 'zh-Hans-CN,en-US',
      '--app', '/nonexistent',
      '--profile', join(directory, 'no-profile'),
      '--home-dir', directory,
      '--app-support-dir', directory,
      '--gemini-dir', join(directory, 'gemini'),
    ],
    { stdio: ['ignore', 'ignore', 'pipe'], env }
  );
  const closed = new Promise((resolve) => child.once('close', resolve));
  try {
    const deadline = Date.now() + 12000;
    let statusResp;
    while (Date.now() < deadline) {
      try {
        statusResp = await rpc(directory, { command: 'status' });
        if (statusResp?.ok) break;
      } catch {}
      await sleep(30);
    }
    assert.equal(statusResp?.ok, true);
    assert.equal(statusResp.status.configuredLanguage, 'system');
    assert.equal(statusResp.status.locale, 'zh-Hans');
    assert.equal(statusResp.status.translationEnabled, true);

    const switchEn = await rpc(directory, { command: 'language_set', language: 'en' });
    assert.equal(switchEn.ok, true);
    assert.equal(switchEn.status.locale, 'en');
    assert.equal(switchEn.status.translationEnabled, false);

    const switchSys = await rpc(directory, {
      command: 'language_set',
      language: 'system',
      systemLocales: ['zh-Hans-CN', 'en-US'],
    });
    assert.equal(switchSys.ok, true);
    assert.equal(switchSys.status.configuredLanguage, 'system');
    assert.equal(switchSys.status.locale, 'zh-Hans');
    assert.equal(switchSys.status.translationEnabled, true);

    await rpc(directory, { command: 'stop' });
    await closed;
  } finally {
    await stopBackendChild(child);
    await closed;
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('runtime/hud-i18n.js 与 assets/i18n/*.json#hud 保持全量词条逐字一致，normalizeHudLocale 回退规范严格收敛', async () => {
  const [{ HUD_I18N, normalizeHudLocale }, zhPack, enPack] = await Promise.all([
    import('../runtime/hud-i18n.js'),
    readFile(join(i18nDir, 'zh-Hans.json'), 'utf8').then((raw) => JSON.parse(raw)),
    readFile(join(i18nDir, 'en.json'), 'utf8').then((raw) => JSON.parse(raw)),
  ]);

  assert.ok(zhPack.hud && typeof zhPack.hud === 'object');
  assert.ok(enPack.hud && typeof enPack.hud === 'object');
  assert.deepEqual(Object.keys(zhPack.hud).sort(), Object.keys(enPack.hud).sort());
  assert.deepEqual(Object.keys(HUD_I18N['zh-Hans']).sort(), Object.keys(zhPack.hud).sort());
  assert.deepEqual(Object.keys(HUD_I18N.en).sort(), Object.keys(enPack.hud).sort());
  assert.equal(Object.keys(zhPack.hud).length, 84);
  assert.deepEqual(HUD_I18N['zh-Hans'], zhPack.hud);
  assert.deepEqual(HUD_I18N.en, enPack.hud);

  assert.equal(normalizeHudLocale(), 'zh-Hans');
  assert.equal(normalizeHudLocale(''), 'zh-Hans');
  assert.equal(normalizeHudLocale('   '), 'zh-Hans');
  assert.equal(normalizeHudLocale('zh'), 'zh-Hans');
  assert.equal(normalizeHudLocale('zh-CN'), 'zh-Hans');
  assert.equal(normalizeHudLocale('zh-Hans'), 'zh-Hans');
  assert.equal(normalizeHudLocale('en'), 'en');
  assert.equal(normalizeHudLocale('en-US'), 'en');
  assert.equal(normalizeHudLocale('fr-FR'), 'en');
});

test('P2 i18n 清理：files.optional_json_read_failed 双语可用，且 12 个无引用死 Key 已同步移除', async () => {
  const [zhPack, enPack] = await Promise.all([
    readFile(join(i18nDir, 'zh-Hans.json'), 'utf8').then((raw) => JSON.parse(raw)),
    readFile(join(i18nDir, 'en.json'), 'utf8').then((raw) => JSON.parse(raw)),
  ]);
  const prev = getActiveLocale();
  try {
    setActiveLocale('en');
    assert.equal(
      bt('files.optional_json_read_failed', { name: 'prefs.json', error: 'ENOENT' }),
      '[GravityBox] Failed to read optional config prefs.json: ENOENT'
    );
    setActiveLocale('zh-Hans');
    assert.equal(
      bt('files.optional_json_read_failed', { name: 'prefs.json', error: 'ENOENT' }),
      '[GravityBox] 读取可选配置 prefs.json 失败: ENOENT'
    );
  } finally {
    setActiveLocale(prev);
  }

  const deadAppKeys = [
    'common.refreshing',
    'language.en',
    'language.zh-Hans',
    'quota.reset.stale_prefix',
    'quota.menu_summary.part',
    'overview.account.badge_warning',
    'overview.account.badge_stale',
    'overview.account.badge_verified',
    'overview.account.badge_mismatch',
    'overview.account.badge_saved',
  ];
  const deadBackendKeys = ['status.initializing', 'version.missing'];
  for (const pack of [zhPack, enPack]) {
    for (const key of deadAppKeys) {
      assert.equal(Object.hasOwn(pack.app, key), false, `app.${key} 应已移除`);
    }
    for (const key of deadBackendKeys) {
      assert.equal(Object.hasOwn(pack.backend, key), false, `backend.${key} 应已移除`);
    }
  }
});

test('P1-13 & P1-14 & P2-19: app/backend 命名空间禁绝占位符冲突重名键，中文模式暂停网页翻译时保持状态与深度扫描中文语境', async () => {
  const [zhPack, enPack] = await Promise.all([
    readFile(join(i18nDir, 'zh-Hans.json'), 'utf8').then((raw) => JSON.parse(raw)),
    readFile(join(i18nDir, 'en.json'), 'utf8').then((raw) => JSON.parse(raw)),
  ]);

  // P1-13: 显式验证历史重名冲突键已彻底解耦，且任何允许共用的 status.* 键必须保持占位符集合 100% 一致
  const allowedSharedKeys = new Set([
    'quota.countdown.soon',
    'status.connected',
    'status.debug_port_missing',
    'status.legacy_blocked',
    'status.paused',
    'status.stopped',
    'status.waiting',
    'status.waiting_app',
    'status.waiting_window',
  ]);
  for (const [code, pack] of [['en', enPack], ['zh-Hans', zhPack]]) {
    assert.equal(Object.hasOwn(pack.backend, 'quota.standalone.no_permission'), false, `${code} backend 不得与 app 重名 quota.standalone.no_permission`);
    assert.equal(Object.hasOwn(pack.backend, 'quota.countdown.passed'), false, `${code} backend 不得与 app 重名 quota.countdown.passed`);
    assert.equal(typeof pack.backend['quota.standalone.backend_no_permission'], 'string');
    assert.equal(typeof pack.backend['quota.countdown.overdue'], 'string');

    const overlap = Object.keys(pack.app).filter((k) => Object.hasOwn(pack.backend, k));
    for (const k of overlap) {
      assert.ok(allowedSharedKeys.has(k), `${code}.json 出现未授权的 app/backend 重名键: ${k}`);
      assert.deepEqual(
        extractPlaceholders(pack.app[k]),
        extractPlaceholders(pack.backend[k]),
        `${code}.json 重名键 ${k} 的占位符集合必须严格一致`
      );
    }
  }

  // P2-19: 英文 category(s) 语法修正与深度扫描报告文件名双语键就绪
  assert.equal(enPack.app['maintenance.simple.confirm_running_detail'].includes('category(s)'), false);
  assert.equal(enPack.app['maintenance.simple.confirm_running_detail'].includes('categories'), true);
  assert.equal(zhPack.backend['deep_scan.report_filename'], '界面深度扫描报告.md');
  assert.equal(enPack.backend['deep_scan.report_filename'], 'UI-Deep-Scan-Report.md');

  // P1-14: Controller 在 zh-Hans 环境下暂停网页翻译时，status.locale 与文案仍保持中文，不强切为英文
  const { Controller } = await import('../dist/controller.js');
  const { dictionaryFromEntries } = await import('../dist/dictionary.js');
  const ctrl = new Controller({
    appPath: '/nonexistent',
    profile: '/nonexistent-profile',
    dictionary: dictionaryFromEntries({}),
    hudEnabled: false,
    locale: 'zh-Hans',
    configuredLanguage: 'zh-Hans',
    onStatus() {},
  });
  try {
    await ctrl.pause();
    const pausedStatus = ctrl.snapshot();
    assert.equal(pausedStatus.mode, 'paused');
    assert.equal(pausedStatus.translationEnabled, false);
    assert.equal(pausedStatus.locale, 'zh-Hans');
    assert.equal(pausedStatus.message, zhPack.backend['status.paused']);
  } finally {
    await ctrl.stop();
  }
});
