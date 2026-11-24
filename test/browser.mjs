import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';
import { existsSync } from 'node:fs';
import { TEST_CHROME_PATH } from '../tools/setup-test-browser.mjs';
import { CDP } from '../dist/cdp.js';
import { DEEP_STEPS } from '../dist/deep-scan.js';
import { DatabaseSync } from 'node:sqlite';
import { ProtobufWriter as HudWriter } from '../dist/protobuf.js';
const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const releaseVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
const evidenceDir = join(root, '质检报告', `${releaseVersion}-改造验收`, '浏览器');
await mkdir(evidenceDir, { recursive: true });
const temp = await mkdtemp(join(tmpdir(), 'gravitybox-browser-'));
const profile = join(temp, 'chrome'), state = join(temp, 'state');
const fixture = await readFile(new URL('./fixture.html', import.meta.url));
const server = createServer((req, res) => {
  if (req.url === '/fixture') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(fixture); }
  else { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<title>External page</title><button>Settings</button>'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let chrome, backend, browserEndpoint, port, main, second;
let backendErrors = ''; let chromeErrors = '';
const checks = [];
async function until(fn, timeout = 8000, label = '') {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) { try { const result = await fn(); if (result) return result; } catch (error) { last = error; } await new Promise(resolve => setTimeout(resolve, 40)); }
  const hint = label ? ` [${label}]` : '';
  throw new Error(`等待条件超时${hint}${last ? ': ' + last.message : ''}`);
}
async function command(command) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(join(state, 'control.sock'));
    let buffer = '';
    socket.setTimeout(10000, () => { socket.destroy(); reject(new Error('命令超时')); });
    socket.on('connect', () => socket.write(JSON.stringify(typeof command==='object'?command:{command}) + '\n'));
    socket.on('error', reject);
    socket.on('data', chunk => { buffer += chunk; if (buffer.includes('\n')) { socket.end(); resolve(JSON.parse(buffer.split('\n')[0])); } });
  });
}
async function text(cdp, selector) { return cdp.evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent`); }
async function status() { return JSON.parse(await readFile(join(state, 'status.json'), 'utf8')); }
async function override(entries, atomic = false) {
  const file = join(state, '词典', '个人覆盖.json');
  if (atomic) { await writeFile(file + '.tmp', JSON.stringify(entries)); await rename(file + '.tmp', file); }
  else await writeFile(file, JSON.stringify(entries));
}
async function check(name, fn) {
  try {
    await fn();
    checks.push({ name, passed: true });
    console.log('PASS', name);
  } catch (error) {
    const diagParts = [`FAIL ${name}: ${error?.message || error}`];
    if (backendErrors.trim()) diagParts.push(`backendErrors(tail): ${backendErrors.trim().slice(-600)}`);
    if (chromeErrors.trim()) diagParts.push(`chromeErrors(tail): ${chromeErrors.trim().slice(-600)}`);
    console.error(diagParts.join('\n'));
    throw error;
  }
}
// A body can exist in the initial about:blank document before the requested navigation commits.
async function documentReady(cdp) {
  await until(async () => cdp.evaluate(`document.readyState === 'complete' && !!document.body && location.origin === ${JSON.stringify(origin)}`).catch(() => false), 8000, 'documentReady');
}
async function normalizePage(cdp, { width = 1280, height = 800 } = {}) {
  await cdp.send('Page.enable').catch(() => {});
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }).catch(() => {});
  await cdp.send('Page.bringToFront').catch(() => {});
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] }).catch(() => {});
}
async function openIsolatedPage(path = '/', viewport = {}) {
  const target = await browserCommand('Target.createTarget', { url: origin + path });
  const page = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.id === target.targetId), 8000, `target ${path}`);
  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.connect();
  await normalizePage(cdp, viewport);
  await documentReady(cdp);
  return { target, cdp };
}
async function collectUntranslatedFull(cdp, executionContextId) {
  await until(async () => (await cdp.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__?.state?.()?.pending ?? 0', executionContextId).catch(() => 0)) === 0, 8000, 'engine pending === 0');
  return cdp.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.collectUntranslated({ fullScan: true })', executionContextId);
}
// Keep browser-control transports scoped to one command, independent of page reloads and idle time.
async function browserCommand(method, params) {
  const control = new CDP(browserEndpoint);
  try { await control.connect(); return await control.send(method, params); }
  finally { control.close(); }
}
try {
  await mkdir(profile);
  const chromeBin = process.env.CHROME_BIN || process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || (existsSync(TEST_CHROME_PATH) ? TEST_CHROME_PATH : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  // These fixtures exercise DOM behavior with software rendering, not GPU behavior.
  chrome = spawn(chromeBin, ['--headless=new', '--disable-gpu', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-extensions', `${origin}/fixture`], { stdio: ['ignore', 'ignore', 'pipe'] });
  chrome.stderr.on('data', chunk => { chromeErrors = (chromeErrors + chunk.toString()).slice(-16000); });
  port = await until(async () => { if (chrome.exitCode !== null) throw new Error(`测试浏览器提前退出 (${chrome.exitCode}): ${chromeErrors.slice(-600)}`); return Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); }, 20000);
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  browserEndpoint = version.webSocketDebuggerUrl;
  const page = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(target => target.url === `${origin}/fixture`));
  main = new CDP(page.webSocketDebuggerUrl); await main.connect(); await normalizePage(main); await documentReady(main);
  const initialHeap = await main.send('Runtime.getHeapUsage');
  backend = spawn(process.execPath, ['--max-old-space-size=48', '--max-semi-space-size=2', join(root, 'dist/main.js'), '--state-dir', state, '--fixture-port', String(port), '--fixture-origin', origin,'--home-dir',temp,'--app-support-dir',temp,'--gemini-dir',join(temp,'gemini')], { stdio: ['ignore', 'ignore', 'pipe'],env:{...process.env,GRAVITYBOX_PROBE_LS:'false'} });
  backend.stderr.on('data', chunk => { backendErrors += chunk.toString(); });
  await until(async () => (await status()).mode === 'connected');
  const initialDictionaryVersion = (await status()).dictionaryVersion;
  await check('基础翻译与属性翻译', async () => {
    await until(async () => await text(main, '#settings') === '设置');
    assert.equal(await main.evaluate('document.querySelector("#settings").getAttribute("aria-label")'), '设置');
  });
  await check('深度扫描拒绝未发送草稿、只执行登记入口，并恢复页面和编辑区',async()=>{
    const tree=await main.send('Page.getFrameTree');const context=await main.send('Page.createIsolatedWorld',{frameId:tree.frameTree.frame.id,worldName:'GRAVITYBOX-localization-v1'});
    assert.equal((await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.deepScan.begin([])',context.executionContextId)).ok,false,'A generic non-empty input is an unsaved draft');
    await main.evaluate('document.querySelector("#input").readOnly=true');
    for(const html of ['<input id="generic-draft" value="private" />','<div data-testid="attachment-chip">file</div>','<div class="tab dirty">editor</div>','<button aria-label="Stop generating">Stop generating</button>']) {
      await main.evaluate(`document.body.insertAdjacentHTML('beforeend','<div id="preflight-test">${html}</div>')`);
      assert.equal((await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.deepScan.begin([])',context.executionContextId)).ok,false,'Draft, attachment, dirty editor and generation must block navigation');
      await main.evaluate('document.querySelector("#preflight-test").remove()');
    }
    const plan=await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.deepScan.plan()',context.executionContextId);assert.deepEqual(plan.sort(),DEEP_STEPS.map(s=>s.id).sort());
    await main.evaluate(`document.body.insertAdjacentHTML('beforeend','<div id="deep-test"><textarea aria-label="Message input" id="deep-draft">Private draft</textarea><button data-gravitybox-deep-step="history" id="deep-history">Open list</button><div data-gravitybox-deep-catalog><div><div><div><div><a href="/customizations/plugins/sample-plugin">Sample</a></div></div></div><p>A public description</p><script>secret-script-must-not-leak</script></div></div></div>');document.querySelector('#deep-history').onclick=()=>history.pushState({},'', '?deep=history')`);
    assert.equal((await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.deepScan.begin(["Settings"])',context.executionContextId)).ok,false);assert.equal(await main.evaluate('document.querySelector("#deep-draft").value'),'Private draft');
    await main.evaluate('document.querySelector("#deep-draft").value=""');assert.equal((await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.deepScan.begin(["Settings"])',context.executionContextId)).ok,true);
    assert.equal((await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.deepScan.step("delete")',context.executionContextId)).ok,false);assert.equal((await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.deepScan.step("history")',context.executionContextId)).ok,true);
    const sample=await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.deepScan.sample()',context.executionContextId);assert.ok(sample.plugins.some(p=>p.description==='A public description'));assert.equal(JSON.stringify(sample).includes('secret-script'),false);
    const restored=await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.deepScan.finish()',context.executionContextId);assert.equal(restored.routeRestored,true);assert.equal(restored.editorsMatch,true);
    await main.evaluate('document.querySelector("#deep-test").remove()');
  });
  await check('目录说明异步加载时等待数据就绪，不把空壳页面误记为采集完成',async()=>{
    const tree=await main.send('Page.getFrameTree');const context=await main.send('Page.createIsolatedWorld',{frameId:tree.frameTree.frame.id,worldName:'GRAVITYBOX-localization-v1'});
    await main.evaluate(`document.body.insertAdjacentHTML('beforeend','<div id="late-catalog-test"><button data-gravitybox-deep-step="marketplace" id="late-catalog-open">Open catalogue</button><div data-gravitybox-deep-catalog id="late-catalog-root"></div></div>');document.querySelector('#late-catalog-open').onclick=()=>setTimeout(()=>{document.querySelector('#late-catalog-root').innerHTML='<div><a href="/customizations/plugins/late-plugin">Late Plugin</a><p>A late public description</p></div>'},450)`);
    assert.equal((await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.deepScan.begin([])',context.executionContextId)).ok,true);
    const started=Date.now();const step=await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.deepScan.step("marketplace")',context.executionContextId);assert.equal(step.ok,true);assert.equal(step.limited,false);assert.ok(Date.now()-started>=400);
    const sample=await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.deepScan.sample()',context.executionContextId);assert.ok(sample.plugins.some(p=>p.id==='late-plugin'));assert.equal((await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.deepScan.finish()',context.executionContextId)).editorsMatch,true);
    await main.evaluate('document.querySelector("#late-catalog-test").remove()');
  });
  await check('快捷键避让输入框、重复按键与用户关闭；卸载只清本轮标记',async()=>{
    const tree=await main.send('Page.getFrameTree'),ctx=await main.send('Page.createIsolatedWorld',{frameId:tree.frameTree.frame.id,worldName:'GRAVITYBOX-localization-v1'});
    const before=await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.state().languageMode',ctx.executionContextId);
    await main.evaluate('document.querySelector("#input").focus()');
    assert.equal(await main.evaluate(`document.querySelector('#input').dispatchEvent(new KeyboardEvent('keydown',{key:'l',code:'KeyL',metaKey:true,altKey:true,bubbles:true,cancelable:true}))`),true);
    assert.equal(await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.state().languageMode',ctx.executionContextId),before);
    await main.evaluate('document.activeElement.blur()');
    assert.equal(await main.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'l',code:'KeyL',metaKey:true,altKey:true,repeat:true,bubbles:true,cancelable:true}))`),true);
    assert.equal((await command({command:'shortcut_set',enabled:false})).ok,true);
    assert.equal(await main.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'l',code:'KeyL',metaKey:true,altKey:true,bubbles:true,cancelable:true}))`),true);
    assert.equal(await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.state().languageMode',ctx.executionContextId),before);
    await command({command:'shortcut_set',enabled:true});
    await command('pause');
    await main.evaluate(`document.body.insertAdjacentHTML('beforeend','<button id="own-project" data-testid="project-header">My project</button><button id="external-project" class="gravitybox-project-name" data-testid="project-header">Other project</button>')`);
    await command('resume');
    await until(async()=>await main.evaluate('document.querySelector("#own-project").classList.contains("gravitybox-project-name")'));
    await command('pause');
    assert.equal(await main.evaluate('document.querySelector("#own-project").classList.contains("gravitybox-project-name")'),false);
    assert.equal(await main.evaluate('document.querySelector("#external-project").classList.contains("gravitybox-project-name")'),true);
    assert.equal(await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.getLanguageMode()',ctx.executionContextId),'en');
    await main.evaluate('document.querySelector("#own-project").remove();document.querySelector("#external-project").remove()');await command('resume');await until(async()=>await text(main,'#settings')==='设置');
  });
  await check('聊天、代码、输入框、终端、标题及未知区域保持英文', async () => {
    for (const selector of ['#chat', '#chat-button', '#code', '#terminal', '#title', '#unknown', '#planner-link', '#user-step', '#project-name', '#breadcrumb', '#conversation-title-link']) assert.equal(await text(main, selector), 'Settings');
    /* 真实包用 react-markdown 渲染回复，标题会命中引擎的 h1/h2/h3；正文标题必须保持原文 */
    assert.equal(await text(main, '#chat-heading'), 'Overview');
    assert.equal(await main.evaluate('document.querySelector("#input").value'), 'Settings');
    assert.equal(await main.evaluate('document.querySelector("#input").title'), 'Settings');
    assert.equal(await text(main, '#raw-email-protected'), 'user@example.com');
  });
  await check('实机会话列表结构受保护（标题是 span.truncate，不在 a[href^="/c/"] 内）', async () => {
    assert.equal(await text(main, '#conversation-title'), 'Settings');
  });
  await check('动态模板与插值规则（执行计时、相对时间、计数器与操作项）自动匹配翻译', async () => {
    assert.equal(await text(main, '#worked-for'), '已用时 49秒');
    assert.equal(await text(main, '#see-more'), '查看另外 6 项');
    assert.equal(await text(main, '#tools-enabled'), '已启用 29 个工具');
    assert.equal(await text(main, '#more-actions'), 'Google Drive 的更多操作');
    assert.equal(await text(main, '#time-badge'), '5天前');
    assert.equal(await text(main, '#feedback-sender'), '以 user@example.com 身份发送反馈');
    assert.equal(await text(main, '#browser-opt-title'), '内置浏览器');
    assert.equal(await text(main, '#browser-opt-desc'), '配置链接打开方式与内置浏览器偏好设置。');
    assert.equal(await text(main, '#open-links-in'), '链接打开方式');
    assert.equal(await text(main, '#ext-browser'), '外部浏览器');
  });
  await check('Shadow DOM 内已有界面控件汉化', async () => assert.equal(await main.evaluate('document.querySelector("#shadow").shadowRoot.querySelector("button").textContent'), '设置'));
  await check('用户命名（卡片标题/选项/列表项/技能名）不被翻译或采集，命令菜单与按钮仍翻译', async () => {
    const tree = await main.send('Page.getFrameTree');const context = await main.send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'GRAVITYBOX-localization-v1' });
    await until(async () => await text(main, '#real-ui-button') === '设置');
    /* 真控件继续翻译：命令菜单项与普通按钮 */
    assert.equal(await text(main, '#command-item'), '保存');
    /* 显式约定（data-gravitybox-user-content）与结构识别（实体卡片/选择器/列表行/实体详情链接）都保持英文 */
    assert.equal(await text(main, '#automation-title'), 'Settings');
    assert.equal(await text(main, '#automation-desc'), 'Synthetic private automation description');
    assert.equal(await text(main, '#automation-structural-title'), 'Settings');
    assert.equal(await text(main, '#project-option'), 'Settings');
    assert.equal(await text(main, '#skill-name'), 'History');
    assert.equal(await main.evaluate('document.querySelector("#skill-name").getAttribute("title")'), 'History');
    /* 采集侧复用同一判定：用户命名不进候选，普通界面文案仍被采集 */
    await main.evaluate('document.querySelector("#user-content-card").insertAdjacentHTML("beforeend",\'<button id="collect-probe">Inspect dynamic widget</button>\')');
    await main.evaluate('document.querySelector("#collect-probe").scrollIntoView({block:"center"})');
    const rows = await until(async () => {
      const list = await collectUntranslatedFull(main, context.executionContextId);
      if (list.some(row => row.key === 'Inspect dynamic widget')) return list;
    }, 8000, 'collect-probe');
    assert.ok(rows.some(row => row.key === 'Inspect dynamic widget'), JSON.stringify(rows));
    for (const key of ['Synthetic Private Project Name', 'Synthetic private automation description', 'History']) assert.equal(rows.some(row => row.key === key), false, key);
    await main.evaluate('document.querySelector("#collect-probe").remove();window.scrollTo(0,0)');
  });
  await check('SPA 路由离开白名单立即停译并恢复英文，回到白名单后恢复汉化', async () => {
    await until(async () => await text(main, '#settings') === '设置');
    await main.evaluate('history.pushState({}, "", "/login")');
    await until(async () => await text(main, '#settings') === 'Settings');
    await main.evaluate('document.querySelector("[data-gravitybox-ui]").insertAdjacentHTML("beforeend", \'<button id="login-probe">Settings</button>\')');
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(await text(main, '#login-probe'), 'Settings');
    await main.evaluate('history.pushState({}, "", "/fixture")');
    await until(async () => await text(main, '#settings') === '设置');
    await until(async () => await text(main, '#login-probe') === '设置');
    await main.evaluate('document.querySelector("#login-probe").remove()');
  });
  await check('插件/第三方产品名不被汉化，插件卡片内真控件仍翻译', async () => {
    await until(async () => await text(main, '#plugin-install') === '安装');
    /* 插件名/品牌名保持原文（容器保护 + 品牌 allowlist），卡片内按钮等真控件继续翻译 */
    assert.equal(await text(main, '#plugin-card-title'), 'History');
    assert.equal(await text(main, '#brand-gemini'), 'Gemini');
    assert.equal(await text(main, '#brand-claude'), 'Claude');
  });
  await check('生产引擎按设置作用域解释同词，保留品牌与草稿原文', async () => {
    await main.evaluate(`document.body.insertAdjacentHTML('beforeend', '<section id="term-contract"><button id="global-plan">Plan</button><div role="dialog" aria-label="Settings"><h3 id="settings-plan">Plan</h3><button id="font-brand">Inter</button><textarea id="term-draft">Plan</textarea></div></section>')`);
    try {
      await until(async () => await text(main, '#global-plan') === '规划' && await text(main, '#settings-plan') === '计划');
      assert.equal(await text(main, '#font-brand'), 'Inter');
      assert.equal(await main.evaluate('document.querySelector("#term-draft").value'), 'Plan');
    } finally { await main.evaluate('document.querySelector("#term-contract")?.remove()'); }
  });
  await main.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 840, deviceScaleFactor: 1, mobile: false });
  await check('下拉控件点击后英文内部键保持不变', async () => {
    await main.evaluate('document.querySelector("#dropdown").click();document.querySelector("[data-value]").click()');
    assert.equal(await text(main, '#result'), 'keep-english-key');
  });
  let updateDuration;
  await check('原子保存自动改译，已显示中文无需重启更新', async () => {
    const start = Date.now(); await override({ Settings: '偏好设置', 'Custom action': '自定义操作' }, true);
    await until(async () => await text(main, '#settings') === '偏好设置'); updateDuration = Date.now() - start;
    await until(async () => await text(main, '#custom') === '自定义操作');
    await until(async () => (await status()).dictionaryVersion !== initialDictionaryVersion);
  });
  await check('错误 JSON 保留上一有效词典，并显示错误', async () => {
    const before = (await status()).dictionaryVersion;
    await writeFile(join(state, '词典', '个人覆盖.json'), '{invalid');
    await until(async () => !!(await status()).dictionaryError);
    assert.equal(await text(main, '#settings'), '偏好设置'); assert.equal((await status()).dictionaryVersion, before);
  });
  await check('删除词条恢复原文；删除覆盖回退基础词典', async () => {
    await override({}); await until(async () => await text(main, '#settings') === '设置');
    assert.equal(await text(main, '#custom'), 'Custom action');
  });
  await check('应用动态改写节点被正确识别', async () => {
    await main.evaluate('document.querySelector("#settings").firstChild.nodeValue="Cancel"');
    await until(async () => await text(main, '#settings') === '取消');
  });
  await check('新增按钮自动翻译，移入聊天区后恢复原文', async () => {
    await main.evaluate('const b=document.createElement("button");b.id="late-button";b.textContent="Settings";document.querySelector("#late").append(b)');
    await until(async () => await text(main, '#late-button') === '设置');
    await main.evaluate('document.querySelector("[data-message-author-role]").append(document.querySelector("#late-button"))');
    await until(async () => await text(main, '#late-button') === 'Settings');
  });
  await check('第二窗口自动连接并接收词典更新', async () => {
    const target = await browserCommand('Target.createTarget', { url: `${origin}/fixture` });
    const page = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(page => page.id === target.targetId));
    second = new CDP(page.webSocketDebuggerUrl); await second.connect(); await normalizePage(second); await documentReady(second);
    await until(async () => (await status()).windows === 2);
    await override({ Settings: '窗口同步设置' });
    await until(async () => await text(second, '#settings') === '窗口同步设置');
    await until(async () => await text(main, '#settings') === '取消');
  });
  await check('刷新后采用最新词典自动恢复汉化', async () => {
    await main.send('Page.reload'); await until(async () => await text(main, '#settings') === '窗口同步设置');
  });
  await check('连续热更新与重复应用不叠加引擎', async () => {
    for (let i = 0; i < 12; i++) { await override({ Settings: `设置第${i}版` }); await until(async () => await text(main, '#settings') === `设置第${i}版`); }
    const tree = await main.send('Page.getFrameTree');
    const context = await main.send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'GRAVITYBOX-localization-v1' });
    const metrics = await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.state()', context.executionContextId);
    assert.equal(metrics.observedRoots, 2); assert.ok(metrics.translatedNodes < 100);
    await command('resume');
    const repeated = await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.state()', context.executionContextId);
    assert.equal(repeated.observedRoots, metrics.observedRoots);
  });
  await check('快速连续保存后两个窗口采用同一最终词典', async () => {
    for (let i = 0; i < 6; i++) { await override({ Settings: `快速保存${i}` }, true); await new Promise(resolve => setTimeout(resolve, 40)); }
    await until(async () => await text(main, '#settings') === '快速保存5' && await text(second, '#settings') === '快速保存5');
    assert.deepEqual((await status()).errors, []);
    await override({ Settings: '设置第11版' }); await until(async () => await text(main, '#settings') === '设置第11版');
  });
  await check('写坏词典后重启助手采用持久化的有效词典', async () => {
    await writeFile(join(state, '词典', '个人覆盖.json'), '{invalid');
    await until(async () => !!(await status()).dictionaryError);
    await command('stop'); await until(async () => backend.exitCode === 0);
    backend = spawn(process.execPath, ['--max-old-space-size=48', '--max-semi-space-size=2', join(root, 'dist/main.js'), '--state-dir', state, '--fixture-port', String(port), '--fixture-origin', origin, '--home-dir', temp, '--app-support-dir', temp, '--gemini-dir', join(temp, 'gemini')], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, GRAVITYBOX_PROBE_LS: 'false' } });
    backend.stderr.on('data', chunk => { backendErrors += chunk.toString(); });
    await until(async () => (await status()).mode === 'connected' && !!(await status()).dictionaryError);
    await until(async () => await text(main, '#settings') === '设置第11版');
    await override({ Settings: '设置第11版' });
    await until(async () => !(await status()).dictionaryError);
  });
  await check('暂停恢复英文；恢复连接后重新汉化', async () => {
    assert.equal((await command('pause')).ok, true);
    await until(async () => await text(main, '#settings') === 'Settings' && await text(second, '#settings') === 'Settings', 8000, 'pause restore English');
    assert.equal(await text(main, '#settings'), 'Settings');
    assert.equal(await text(second, '#settings'), 'Settings');
    await command('resume'); await until(async () => await text(main, '#settings') === '设置第11版', 8000, 'resume restore Chinese');
  });
  await check('未知页面不注入，返回受支持页面后恢复', async () => {
    await main.send('Page.navigate', { url: `${origin}/external` });
    await until(async () => (await status()).windows === 1);
    assert.equal(await main.evaluate('document.querySelector("button").textContent'), 'Settings');
    await main.send('Page.navigate', { url: `${origin}/fixture` });
    await until(async () => await text(main, '#settings') === '设置第11版');
  });
  await check('一键中英双语热切换（Toggle）、CSS Micro-Patch 及 data-gravitybox-loc 生效验证', async () => {
    const hasStyle = await main.evaluate('!!document.getElementById("__gravitybox_micro_patch__")');
    assert.equal(hasStyle, true);
    const patchCss = await main.evaluate('document.getElementById("__gravitybox_micro_patch__")?.textContent ?? ""');
    assert.equal(patchCss.includes('font-family'), false, 'CSS Micro-Patch 不得覆盖宿主 font-family 继承链');
    assert.equal(patchCss.includes('-webkit-font-smoothing'), false, 'CSS Micro-Patch 不得覆盖宿主字体抗锯齿模式');

    // 验证翻译节点自动打标，切换语言时能正确撤销。
    const btnLoc = await main.evaluate('document.querySelector("#plain-btn")?.dataset?.gravityboxLoc');
    assert.equal(btnLoc, '1');

    const tree = await main.send('Page.getFrameTree');
    const context = await main.send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'GRAVITYBOX-localization-v1' });
    const toggleToEn = await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.toggleLanguage("en")', context.executionContextId);
    assert.equal(toggleToEn.mode, 'en');
    await until(async () => await text(main, '#settings') === 'Settings', 8000, 'toggleLanguage en');
    const btnLocEn = await main.evaluate('document.querySelector("#plain-btn")?.dataset?.gravityboxLoc');
    assert.equal(btnLocEn, undefined);

    const toggleToZh = await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.toggleLanguage("zh")', context.executionContextId);
    assert.equal(toggleToZh.mode, 'zh');
    await until(async () => await text(main, '#settings') === '设置第11版', 8000, 'toggleLanguage zh');
    const btnLocZh = await main.evaluate('document.querySelector("#plain-btn")?.dataset?.gravityboxLoc');
    assert.equal(btnLocZh, '1');
  });
  await check('复合内联元素整句重组翻译（Inline-Group Contextual Translation）与无损还原', async () => {
    // 验证句子被整句模板翻译，且保留了 code 与 a 等内联节点
    await until(async () => (await text(main, '#delete-prompt'))?.includes('您确定要删除'));
    assert.equal(await text(main, '#delete-prompt'), '您确定要删除 my-branch 吗？');
    const codeTag = await main.evaluate('document.querySelector("#delete-prompt code")?.textContent');
    assert.equal(codeTag, 'my-branch');

    assert.equal(await text(main, '#ai-credits-prompt'), 'AI 额度会在超出模型配额时使用。请在 设置第11版 中查看您当前的 AI 额度。');
    const linkHref = await main.evaluate('document.querySelector("#ai-credits-prompt a")?.getAttribute("href")');
    assert.equal(linkHref, '/settings');

    // 切换英文时复合内联节点无损还原
    const tree = await main.send('Page.getFrameTree');
    const context = await main.send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'GRAVITYBOX-localization-v1' });
    await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.toggleLanguage("en")', context.executionContextId);
    assert.equal(await text(main, '#delete-prompt'), 'Are you sure you want to delete the my-branch?');
    assert.equal(await main.evaluate('document.querySelector("#delete-prompt code")?.textContent'), 'my-branch');

    await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.toggleLanguage("zh")', context.executionContextId);
    assert.equal(await text(main, '#delete-prompt'), '您确定要删除 my-branch 吗？');
  });
  await check('内联模板：两占位符仅安全同序应用；重排/省略保留完整英文并标记 unsupported，整句采集', async () => {
    const tree = await main.send('Page.getFrameTree');const context = await main.send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'GRAVITYBOX-localization-v1' });
    /* 伪词避免碎片被基础词典单独命中；<a> 用于验证不支持时链接文字/交互不被清空 */
    await main.evaluate(`document.body.insertAdjacentHTML('beforeend','<div id="j04-probe" data-gravitybox-ui><p id="j04-same">Snorfle <code>alpha</code> blim <code>beta</code>.</p><p id="j04-reorder">Blorp <a href="/help" id="j04-reorder-link">docs</a> zib <code>beta</code>.</p><p id="j04-omit">Glim <a href="/g" id="j04-omit-link">docs</a> zorp.</p></div>')`);
    await until(async () => await text(main, '#j04-same') === 'Snorfle alpha blim beta.');
    const original = await main.evaluate('globalThis.__GRAVITYBOX_BOOT__.dictionary', context.executionContextId);
    const probe = { ...original, version: 'j04-fix-' + Date.now(), entries: { ...original.entries,
      'Snorfle {0} blim {1}.': '斯诺福 {0} 布林 {1}。',
      'Blorp {0} zib {1}.': '先 {1}，再 {0}。',
      'Glim {0} zorp.': '格利姆。' } };
    await main.evaluate(`globalThis.__GRAVITYBOX_ENGINE_V1__.update(${JSON.stringify(probe)})`, context.executionContextId);
    /* 两占位符、顺序一致且每个非空译文段都有现成文本槽：安全原地应用，顺序正确 */
    await until(async () => await text(main, '#j04-same') === '斯诺福 alpha 布林 beta。');
    assert.equal(await main.evaluate('document.querySelector("#j04-same code")?.textContent'), 'alpha');
    /* 重排（引擎不支持安全重排）与省略占位符：保留完整英文，不半译、不清空链接 */
    await until(async () => await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.state().unsupportedGroups >= 2', context.executionContextId));
    assert.equal(await text(main, '#j04-reorder'), 'Blorp docs zib beta.');
    assert.equal(await text(main, '#j04-omit'), 'Glim docs zorp.');
    assert.equal(await main.evaluate('document.querySelector("#j04-reorder-link")?.textContent'), 'docs');
    assert.equal(await main.evaluate('document.querySelector("#j04-reorder-link")?.getAttribute("href")'), '/help');
    assert.ok(await main.evaluate('document.querySelector("#j04-reorder-link").getClientRects().length > 0'));
    assert.equal(await main.evaluate('!!document.querySelector("#j04-reorder").dataset.gravityboxLoc || !!document.querySelector("#j04-omit").dataset.gravityboxLoc'), false);
    /* 仍整句采集：unsupported 也给出整句 key + layoutWarning，不产生碎片 */
    await main.evaluate('document.querySelector("#j04-probe").scrollIntoView({block:"center"})');
    const rows = await until(async () => {
      const list = await collectUntranslatedFull(main, context.executionContextId);
      if (list.some(item => item.key === 'Blorp {0} zib {1}.') && list.some(item => item.key === 'Glim {0} zorp.')) return list;
    }, 8000, 'j04 unsupported inline keys');
    for (const key of ['Blorp {0} zib {1}.', 'Glim {0} zorp.']) {
      const row = rows.find(item => item.key === key);
      assert.ok(row, key + ' missing: ' + JSON.stringify(rows).slice(0, 400));
      assert.ok(row.layoutWarning && row.layoutWarning.includes('内联'), key + ' layoutWarning');
    }
    for (const fragment of ['Blorp', 'zib', 'Glim', 'zorp']) assert.equal(rows.some(item => item.key === fragment), false, fragment);
    /* 恢复基础词典：同序译文恢复英文，unsupported 句也保持英文，链接仍可见 */
    await main.evaluate(`globalThis.__GRAVITYBOX_ENGINE_V1__.update(${JSON.stringify(original)})`, context.executionContextId);
    await until(async () => await text(main, '#j04-same') === 'Snorfle alpha blim beta.');
    assert.equal(await text(main, '#j04-reorder'), 'Blorp docs zib beta.');
    assert.equal(await main.evaluate('document.querySelector("#j04-reorder-link")?.textContent'), 'docs');
    await main.evaluate('document.querySelector("#j04-probe").remove()');
  });
  await check('内联模板：合法同序但无尾 slot 的译文安全应用，<a> 文字可见可点，英文恢复无损', async () => {
    const tree = await main.send('Page.getFrameTree');const context = await main.send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'GRAVITYBOX-localization-v1' });
    await main.evaluate(`document.body.insertAdjacentHTML('beforeend','<div id="j04-notail-probe" data-gravitybox-ui><p id="j04-notail">Blorks <a href="/docs" id="j04-notail-link">quuxdocs</a></p><p id="j04-two">Glorp <code>alpha</code> blim <code>beta</code></p><p id="j04-tailmiss">Gronk <a href="/docs2" id="j04-tailmiss-link">quuxdocs</a></p></div>')`);
    await until(async () => await text(main, '#j04-notail') === 'Blorks quuxdocs');
    const original = await main.evaluate('globalThis.__GRAVITYBOX_BOOT__.dictionary', context.executionContextId);
    const probe = { ...original, version: 'j04-notail-' + Date.now(), entries: { ...original.entries,
      'Blorks {0}': '阅读{0}',
      'Glorp {0} blim {1}': '{0} 与 {1}',
      /* 合法同序，但译文在占位符之后追加文字：原句没有尾文本 run -> 必须保留完整英文 */
      'Gronk {0}': '{0}，请阅读' } };
    await main.evaluate(`globalThis.__GRAVITYBOX_ENGINE_V1__.update(${JSON.stringify(probe)})`, context.executionContextId);
    /* 无尾 slot（英文以占位符结尾、译文不再追加文字）是合法同序：应用后链接文字保留在 <a> 内 */
    await until(async () => await text(main, '#j04-notail') === '阅读quuxdocs');
    await until(async () => await text(main, '#j04-two') === 'alpha 与 beta');
    assert.equal(await main.evaluate('document.querySelector("#j04-notail-link")?.textContent'), 'quuxdocs');
    assert.equal(await main.evaluate('document.querySelector("#j04-notail-link")?.getAttribute("href")'), '/docs');
    assert.ok(await main.evaluate('document.querySelector("#j04-notail-link").getClientRects().length > 0'));
    assert.notEqual(await main.evaluate('getComputedStyle(document.querySelector("#j04-notail-link")).pointerEvents'), 'none');
    /* 真正缺尾 slot：同序译文 '{0}，请阅读' 需要占位符后的文本 run，但原句没有 -> 完整英文 + unsupported */
    assert.equal(await text(main, '#j04-tailmiss'), 'Gronk quuxdocs');
    assert.ok(await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.state().unsupportedGroups >= 1', context.executionContextId));
    assert.equal(await main.evaluate('document.querySelector("#j04-tailmiss-link")?.textContent'), 'quuxdocs');
    assert.equal(await main.evaluate('document.querySelector("#j04-tailmiss-link")?.getAttribute("href")'), '/docs2');
    assert.ok(await main.evaluate('document.querySelector("#j04-tailmiss-link").getClientRects().length > 0'));
    assert.equal(await main.evaluate('!!document.querySelector("#j04-tailmiss").dataset.gravityboxLoc'), false);
    await main.evaluate('document.querySelector("#j04-notail-probe").scrollIntoView({block:"center"})');
    const tailRows = await until(async () => {
      const list = await collectUntranslatedFull(main, context.executionContextId);
      if (list.some(item => item.key === 'Gronk {0}')) return list;
    }, 8000, 'j04 missing-tail key');
    const tailRow = tailRows.find(item => item.key === 'Gronk {0}');
    assert.ok(tailRow, 'missing-tail whole key absent: ' + JSON.stringify(tailRows).slice(0, 400));
    assert.ok(tailRow.layoutWarning && tailRow.layoutWarning.includes('内联'), 'missing-tail layoutWarning');
    /* 恢复英文：内联结构与链接文字无损 */
    await main.evaluate(`globalThis.__GRAVITYBOX_ENGINE_V1__.update(${JSON.stringify(original)})`, context.executionContextId);
    await until(async () => await text(main, '#j04-notail') === 'Blorks quuxdocs');
    await until(async () => await text(main, '#j04-two') === 'Glorp alpha blim beta');
    assert.equal(await text(main, '#j04-tailmiss'), 'Gronk quuxdocs');
    assert.equal(await main.evaluate('document.querySelector("#j04-tailmiss-link")?.textContent'), 'quuxdocs');
    assert.equal(await main.evaluate('document.querySelector("#j04-notail-link")?.textContent'), 'quuxdocs');
    await main.evaluate('document.querySelector("#j04-notail-probe").remove()');
  });
  await check('内联组防劫持与句子级组合回退：权限/删除确认完整汉化，未收录长句保持英文，MCP短标题正常汉化', async () => {
    await main.evaluate(`document.body.insertAdjacentHTML('beforeend',
      '<div id="inline-combo-probe" data-gravitybox-ui>' +
        '<span id="perm-sub">Configure what the agent can do in local and remote conversations. <a id="perm-link" href="https://example.com">Learn more</a>.</span>' +
        '<p id="del-confirm">Are you sure you want to delete <strong>my-mcp</strong>? This action cannot be undone.</p>' +
        '<span id="unknown-cfg">Configure frobnicator widgets across orbital clusters. <a id="unknown-cfg-link" href="/x">Learn more</a>.</span>' +
        '<h2 id="mcp-cfg-title">Configure chrome-devtools</h2>' +
      '</div>'
    )`);
    await until(async () => await text(main, '#perm-sub') === '配置智能体在本地与远程对话中的操作权限。 了解更多。');
    assert.equal(await main.evaluate('document.querySelector("#perm-link")?.textContent'), '了解更多');
    assert.equal(await main.evaluate('document.querySelector("#perm-link")?.getAttribute("href")'), 'https://example.com');
    await until(async () => await text(main, '#del-confirm') === '您确定要删除 my-mcp 吗？此操作无法撤销。');
    await until(async () => await text(main, '#mcp-cfg-title') === '配置 chrome-devtools');
    const unknownText = await text(main, '#unknown-cfg');
    assert.equal(unknownText.includes('配置 frobnicator'), false, '未收录 Configure 长句绝不可被 Configure {server} 劫持成半中半英: ' + unknownText);
    assert.equal(unknownText.startsWith('Configure frobnicator widgets across orbital clusters.'), true);
    await main.evaluate('document.querySelector("#inline-combo-probe").remove()');
  });
  await check('%s/ICU 占位符不支持时明确披露（能力清单与候选标记）', async () => {
    const tree = await main.send('Page.getFrameTree');const context = await main.send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'GRAVITYBOX-localization-v1' });
    const caps = await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.capabilities()', context.executionContextId);
    assert.ok(caps.unsupported.includes('%s'));
    assert.ok(caps.unsupported.includes('icu-plural'));
    assert.ok(/\{N\}/.test(caps.placeholders.supported.join()));
    assert.equal(await text(main, '#percent-placeholder'), '%s items selected');
    await main.evaluate('document.querySelector("#percent-placeholder").scrollIntoView({block:"center"})');
    const rows = await until(async () => {
      const list = await collectUntranslatedFull(main, context.executionContextId);
      if (list.some(row => row.key === '%s items selected') && list.some(row => /plural/.test(row.key))) return list;
    }, 8000, 'percent and icu placeholders');
    const percent = rows.find(row => row.key === '%s items selected');
    assert.ok(percent, JSON.stringify(rows).slice(0, 400));
    assert.ok(percent.formatWarning && percent.formatWarning.includes('%s'));
    const icu = rows.find(row => /plural/.test(row.key));
    assert.ok(icu && icu.formatWarning, JSON.stringify(rows).slice(0, 400));
    assert.ok(await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.state().capabilities.unsupported.includes("icu-plural")', context.executionContextId));
  });
  await check('模型配额与动态时间子句及模型分组标题汉化', async () => {
    const quotaHtml = `
      <div id="quota-test" role="dialog">
        <h4 id="gemini-header">Gemini Models</h4>
        <h4 id="claude-header">Claude and GPT models</h4>
        <p id="quota-weekly">You have used some of your weekly limit, it will fully refresh in 20 hours, 52 minutes.</p>
        <p id="quota-5h">You have used some of your 5-hour limit, it will fully refresh in 54 minutes.</p>
      </div>
    `;
    await main.evaluate(`document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(quotaHtml)})`);
    await until(async () => await text(main, '#gemini-header') === 'Gemini 系列模型');
    assert.equal(await text(main, '#claude-header'), 'Claude 与 GPT 系列模型');
    assert.equal(await text(main, '#quota-weekly'), '您已使用了部分每周限额，将在 20小时 52分钟 后完全刷新。');
    assert.equal(await text(main, '#quota-5h'), '您已使用了部分5小时限额，将在 54分钟 后完全刷新。');
  });
  await check('真实模型容器仅放行固定标签，动态重置时间和命令展示汉化，模型与正文保持原样', async () => {
    await main.evaluate(`document.body.insertAdjacentHTML('beforeend', '<div id="actual-model-menu" role="menu"><div data-testid="model-selector-panel"><h4 id="actual-model-label">Model</h4><div data-testid="model-option"><span id="actual-model-name">Settings</span><span id="actual-new">New</span></div><div role="menuitem"><span id="actual-usage">View Usage</span></div><div><span id="actual-weekly">Weekly Limit Remaining</span><span id="actual-reset">Resets in 6d 17h</span></div><div data-gravitybox-protect><span id="protected-quota">Weekly Limit Remaining</span></div></div></div><div role="option"><span id="compact-name">compact</span><span id="compact-description">Compact the conversation now (summarize history to free up the context window).</span><span id="teamwork-name">teamwork-preview</span></div>')`);
    await until(async()=>await text(main,'#actual-usage')==='查看用量');
    assert.equal(await text(main,'#actual-model-name'),'Settings');assert.equal(await text(main,'#actual-weekly'),'每周剩余限额');assert.equal(await text(main,'#protected-quota'),'Weekly Limit Remaining');assert.equal(await text(main,'#actual-reset'),'6天 17小时后重置');assert.equal(await text(main,'#compact-name'),'压缩对话');assert.equal(await text(main,'#teamwork-name'),'智能体团队（预览）');
    assert.equal(await text(main,'#actual-new'),'新');
    await main.evaluate(`document.querySelector('#actual-model-menu [data-testid="model-selector-panel"]').insertAdjacentHTML('beforeend','<div role="presentation"><div role="menu"><div role="group"><div role="presentation" id="late-quota-heading">Gemini Models</div><div><span id="late-quota-reset">Resets in 2h 11m</span></div></div></div></div>')`);
    await until(async()=>await text(main,'#late-quota-reset')==='2小时 11分钟后重置');assert.equal(await text(main,'#late-quota-heading'),'Gemini 系列模型');
    const tree=await main.send('Page.getFrameTree');const context=await main.send('Page.createIsolatedWorld',{frameId:tree.frameTree.frame.id,worldName:'GRAVITYBOX-localization-v1'});
    const before=await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.state().scanCount',context.executionContextId);await new Promise(resolve=>setTimeout(resolve,300));assert.equal(await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.state().scanCount',context.executionContextId),before);
    await main.evaluate('document.querySelector("#actual-model-menu").scrollIntoView({block:"start"})');
    const audit=await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.auditUi(["View Usage","Settings","Weekly Limit Remaining"])',context.executionContextId);assert.ok(audit.observations.some(e=>e.key==='View Usage'&&e.state==='verified'));assert.ok(audit.observations.some(e=>e.key==='Resets in {duration}'&&e.state==='verified'));
  });
  await check('模型分组说明保留模型名，动态更新与秒级重置可翻译，受保护内容不变', async () => {
    await main.evaluate(`document.body.insertAdjacentHTML('beforeend','<div id="group-label-fixture" role="tooltip"><div data-testid="model-selector-panel"><span id="group-models">Models within this group: Gemini 3.8 Flash, Claude Sonnet 5.5, GPT-OSS 120B</span><span id="group-seconds">Resets in 3h 21m 9s</span><span id="group-soon">Resets in &lt;1m</span><div data-gravitybox-protect><span id="group-private">Models within this group: Gemini Private</span></div></div></div>')`);
    await until(async () => await text(main, '#group-models') === '此组包含的模型：Gemini 3.8 Flash, Claude Sonnet 5.5, GPT-OSS 120B');
    assert.equal(await text(main, '#group-seconds'), '3小时 21分钟 9秒后重置');
    assert.equal(await text(main, '#group-soon'), '将在 1 分钟内重置');
    assert.equal(await text(main, '#group-private'), 'Models within this group: Gemini Private');
    await main.evaluate(`document.querySelector('#group-models').textContent = 'Models within this group: Gemini 4 Argon (High)'`);
    await until(async () => await text(main, '#group-models') === '此组包含的模型：Gemini 4 Argon (High)');
    await main.evaluate(`document.querySelector('#group-label-fixture').remove()`);
  });
  await check('短暂菜单关闭后仍能保存已审核文案的巡检结果，停止后不再记录',async()=>{
    const tree=await main.send('Page.getFrameTree');const context=await main.send('Page.createIsolatedWorld',{frameId:tree.frameTree.frame.id,worldName:'GRAVITYBOX-localization-v1'});
    await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.startAudit(["View Usage"])',context.executionContextId);
    await main.evaluate(`document.body.insertAdjacentHTML('beforeend','<div id="transient-audit-menu" role="menu"><div data-testid="model-selector-panel"><span id="transient-audit-label">View Usage</span></div></div>');document.querySelector('#transient-audit-menu').scrollIntoView({block:'start'})`);
    await until(async()=>await text(main,'#transient-audit-label')==='查看用量');await main.evaluate('document.querySelector("#transient-audit-menu").remove()');
    const audit=await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.auditUi(["View Usage"])',context.executionContextId);assert.ok(audit.recent.some(e=>e.key==='View Usage'&&e.state==='verified'));assert.equal(JSON.stringify(audit.recent).includes('Settings'),false);
    await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.stopAudit()',context.executionContextId);assert.equal((await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.auditUi(["View Usage"])',context.executionContextId)).auditActive,false);
  });
  await check('页面扫描仅返回清单内的安全界面文案，未知文字和保护内容不出页面',async()=>{
    await main.evaluate(`document.body.insertAdjacentHTML('beforeend','<div data-gravitybox-ui><button id="unknown-ui-probe">Private unknown interface text</button></div><div class="prose"><button>Private protected content</button></div><button style="position:absolute;top:100000px" id="offscreen-audit">Offscreen interface label</button>')`);
    await main.evaluate('document.querySelector("#unknown-ui-probe").scrollIntoView({block:"start"})');
    const tree=await main.send('Page.getFrameTree');const context=await main.send('Page.createIsolatedWorld',{frameId:tree.frameTree.frame.id,worldName:'GRAVITYBOX-localization-v1'});
    const audit=await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.auditUi(["View Usage","Private protected content","Offscreen interface label"])',context.executionContextId);assert.ok(audit.unmatchedCount>0);assert.ok(audit.protectedCount>0);assert.equal(JSON.stringify(audit).includes('Private'),false);assert.equal(JSON.stringify(audit).includes('Offscreen'),false);
    await main.evaluate('document.querySelector("#unknown-ui-probe").parentElement.remove()');
  });
  await check('会话操作按钮元信息汉化，标题和正文中的同名内容保持原样',async()=>{
    await main.evaluate(`document.body.insertAdjacentHTML('beforeend','<div data-testid="conversation-row-sidebar"><span class="truncate" id="action-same-title">Pin conversation</span><button id="pin-ui-probe" aria-label="Pin conversation"></button><div data-gravitybox-protect><button id="protected-pin-probe" aria-label="Pin conversation"></button></div></div>')`);
    await until(async()=>await main.evaluate('document.querySelector("#pin-ui-probe").getAttribute("aria-label")')==='置顶对话');assert.equal(await text(main,'#action-same-title'),'Pin conversation');assert.equal(await main.evaluate('document.querySelector("#protected-pin-probe").getAttribute("aria-label")'),'Pin conversation');
  });
  await check('自定义页独立搜索框与分组元信息可翻译，输入值及未知区域保持原样',async()=>{
    await main.evaluate(`document.body.insertAdjacentHTML('beforeend','<div><input id="standalone-custom-search" placeholder="Search customizations..." value="My private search"><div id="standalone-custom-group" role="group" aria-label="Customizations views"></div><button id="older-message-label">Load older messages, showing 10 of 1311</button></div><div class="prose"><input id="protected-custom-search" placeholder="Search customizations..."></div>')`);
    await until(async()=>await main.evaluate('document.querySelector("#standalone-custom-search").getAttribute("placeholder")')==='搜索自定义项...');assert.equal(await main.evaluate('document.querySelector("#standalone-custom-search").value'),'My private search');assert.equal(await main.evaluate('document.querySelector("#standalone-custom-group").getAttribute("aria-label")'),'自定义项视图');assert.equal(await main.evaluate('document.querySelector("#protected-custom-search").getAttribute("placeholder")'),'Search customizations...');assert.equal(await text(main,'#older-message-label'),'加载更早消息（已显示 10 / 1311 条）');
  });
  await check('⌥⌘L 窗口快捷键双语热切换与候选语境', async () => {
    const tree = await main.send('Page.getFrameTree');
    const context = await main.send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'GRAVITYBOX-localization-v1' });

    // 1. 验证 collectUntranslated 返回包含 { key, kind }
    const uncollected = await collectUntranslatedFull(main, context.executionContextId);
    assert.ok(Array.isArray(uncollected));
    if (uncollected.length > 0) {
      assert.ok('key' in uncollected[0]);
      assert.ok('kind' in uncollected[0]);
    }

    // 2. 模拟 ⌥⌘L 切换到英文
    await main.evaluate(`
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'l',
        code: 'KeyL',
        altKey: true,
        metaKey: true,
        bubbles: true,
        cancelable: true
      }))
    `, context.executionContextId);

    await until(async () => await text(main, '#settings') === 'Settings');

    // 3. 模拟 ⌥⌘L 再次切换回中文
    await main.evaluate(`
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'l',
        code: 'KeyL',
        altKey: true,
        metaKey: true,
        bubbles: true,
        cancelable: true
      }))
    `, context.executionContextId);

    await until(async () => await text(main, '#settings') === '设置第11版');
  });
  await check('真实侧边栏时间徽章在祖先变化后不循环，正文时间文本受保护', async () => {
    await main.evaluate(`document.body.insertAdjacentHTML('beforeend', '<div data-testid="conversation-row-sidebar" id="badge-row"><div><span id="protected-badge">5d</span><span class="truncate" id="time-title">5d</span></div></div><div class="markdown"><span id="time-body">Before</span></div>')`);
    const tree = await main.send('Page.getFrameTree');
    const context = await main.send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'GRAVITYBOX-localization-v1' });
    await until(async () => await text(main, '#protected-badge') === '5天前');
    await main.evaluate('document.querySelector("#badge-row").className="focused";document.querySelector("#time-body").firstChild.nodeValue="5d"');
    await until(async () => (await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.state().pending', context.executionContextId)) === 0);
    assert.equal(await text(main, '#time-title'), '5d'); assert.equal(await text(main, '#time-body'), '5d');
    const before = await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.state().scanCount', context.executionContextId);
    await new Promise(r => setTimeout(r, 450));
    assert.equal(await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.state().scanCount', context.executionContextId), before);
  });
  await check('采集候选重新检查保护状态，排除句中的路径与邮箱', async () => {
    const tree = await main.send('Page.getFrameTree'); const context = await main.send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'GRAVITYBOX-localization-v1' });
    await main.evaluate(`document.body.insertAdjacentHTML('beforeend', '<button id="candidate">Synthetic Private Project Name</button><button id="candidate-path">Open /Users/demo/Private.txt</button><button id="candidate-email">Email person@example.test</button>')`);
    await until(async () => (await collectUntranslatedFull(main, context.executionContextId)).some(e => e.key === 'Synthetic Private Project Name'), 8000, 'candidate Synthetic Private Project Name');
    await main.evaluate('document.querySelector("#candidate").setAttribute("data-gravitybox-protect", "true")');
    const candidates = await collectUntranslatedFull(main, context.executionContextId);
    for (const key of ['Synthetic Private Project Name', 'Open /Users/demo/Private.txt', 'Email person@example.test']) assert.equal(candidates.some(e => e.key === key), false);
    await main.evaluate('["candidate","candidate-path","candidate-email"].forEach(id=>document.getElementById(id).remove())');
  });
  await check('内联组部分动态更新还原旧片段，移除节点释放记录', async () => {
    const tree = await main.send('Page.getFrameTree'); const context = await main.send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'GRAVITYBOX-localization-v1' });
    await main.evaluate('document.querySelector("#delete-prompt").firstChild.nodeValue="Audit preserved "');
    await until(async () => await text(main, '#delete-prompt') === 'Audit preserved my-branch?');
    const baseline = await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.state().translatedNodes', context.executionContextId);
    await main.evaluate(`const section=document.createElement('section'); section.id='remove-probe'; section.setAttribute('data-gravitybox-ui','');section.innerHTML=Array.from({length:200},()=>'<button>Save</button>').join('');document.body.append(section)`);
    await until(async () => (await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.state().translatedNodes', context.executionContextId)) >= baseline + 200);
    await main.evaluate('document.getElementById("remove-probe").remove()');
    await until(async () => (await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.state().translatedNodes', context.executionContextId)) <= baseline);
  });
  await new Promise(resolve => setTimeout(resolve, 300));

  await check('场景词典按角色应用，界面候选包含语境而不收集隐藏或受保护内容',async()=>{
    const tree=await main.send('Page.getFrameTree'),ctx=await main.send('Page.createIsolatedWorld',{frameId:tree.frameTree.frame.id,worldName:'GRAVITYBOX-localization-v1'});
    await override({'@ui:/fixture|button|Open resource':'打开资源','@ui:/fixture|heading|Open resource':'资源开放状态'});
    await main.evaluate(`(()=>{const el=document.createElement('section');el.id='context-test';el.innerHTML='<button id="ctx-button">Open resource</button><h2 id="ctx-heading">Open resource</h2><button id="ctx-new">Inspect dynamic widget</button><button style="display:none">Hidden private widget</button><div data-message-id="private"><button>Private account content</button></div>';document.body.prepend(el)})()`);
    await until(async()=>await text(main,'#ctx-button')==='打开资源');await main.evaluate('window.scrollTo(0,0)');assert.equal(await text(main,'#ctx-heading'),'资源开放状态');
    const rows=await until(async()=>{const list=await collectUntranslatedFull(main,ctx.executionContextId);if(list.some(r=>r.key==='Inspect dynamic widget'))return list;},8000,'ctx Inspect dynamic widget');const row=rows.find(r=>r.key==='Inspect dynamic widget');assert.equal(row.kind,'button');assert.equal(row.route,'/fixture');assert.equal(row.source,'runtime-ui');assert.equal(JSON.stringify(rows).includes('Hidden private'),false);assert.equal(JSON.stringify(rows).includes('Private account'),false);
    await main.evaluate('document.querySelector("#context-test").remove()');await override({});
  });
  await check('动态规则和内联模板记录真实命中，英文对照不被报告为漏译',async()=>{
    const tree=await main.send('Page.getFrameTree'),ctx=await main.send('Page.createIsolatedWorld',{frameId:tree.frameTree.frame.id,worldName:'GRAVITYBOX-localization-v1'});
    await override({'Audit contextual reference {0}.':'审查{0}的上下文参考。'});
    await main.evaluate(`(()=>{const el=document.createElement('div');el.id='rule-test';el.innerHTML='<button id="rule-worked">Worked for 23s</button><div id="rule-inline" role="alert">Audit contextual reference <a href="#read-only">Public docs</a>.</div>';document.body.prepend(el)})()`);
    await until(async()=>/已用时/.test(await text(main,'#rule-worked')));await main.evaluate('window.scrollTo(0,0)');await until(async()=>(await text(main,'#rule-inline'))==='审查Public docs的上下文参考。');
    const rows=await until(async()=>{const r=await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.auditUi(["Worked for {duration}","Audit contextual reference {0}."])',ctx.executionContextId);if(r?.observations?.some(item=>item.key==='Worked for {duration}'&&item.state==='verified'))return r;},6000);assert.ok(rows.observations.some(r=>r.key==='Worked for {duration}'&&r.state==='verified'));assert.ok(rows.observations.some(r=>r.key==='Audit contextual reference {0}.'&&r.state==='verified'),JSON.stringify(rows));
    await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.toggleLanguage("en")',ctx.executionContextId);await until(async()=>['en','mixed'].includes((await status()).languageMode));const english=await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.auditUi(["Worked for {duration}"])',ctx.executionContextId);assert.equal(english.intentionalEnglish,true);assert.equal(english.observations.length,0);
    await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.toggleLanguage("zh")',ctx.executionContextId);await until(async()=>(await status()).languageMode==='zh');await main.evaluate('document.querySelector("#rule-test").remove()');await override({});
  });
  await check('兼容模式保留严格模板与控件译文，仍保护个人内容和复杂内联',async()=>{
    await command('pause');await until(async()=>(await status()).mode==='paused');
    const tree=await main.send('Page.getFrameTree'),ctx=await main.send('Page.createIsolatedWorld',{frameId:tree.frameTree.frame.id,worldName:'GRAVITYBOX-conservative-test'});
    await main.evaluate(`(()=>{const el=document.createElement('div');el.id='conservative-test';el.innerHTML='<button id="conservative-known">Known action</button><button id="conservative-dynamic">Worked for 91s</button><div data-message-id="protected"><button id="conservative-private">Known action</button></div>';document.body.prepend(el)})()`);
    const engine=await readFile(join(root,'dist/engine.js'),'utf8');await main.evaluate(`globalThis.__GRAVITYBOX_BOOT__=${JSON.stringify({origin,path:'/fixture',conservative:true,dictionary:{schema:1,version:'conservative',entries:{'Known action':'已知操作'}}})};
${engine}`,ctx.executionContextId);
    await until(async()=>await text(main,'#conservative-known')==='已知操作');assert.equal(await text(main,'#conservative-dynamic'),'已用时 91秒');assert.equal(await text(main,'#conservative-private'),'Known action');await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.dispose()',ctx.executionContextId);await main.evaluate('document.querySelector("#conservative-test").remove()');await command('resume');await until(async()=>(await status()).mode==='connected');
  });
  await check('插件说明仅在明确的目录卡片应用场景译文，不翻译同文普通段落',async()=>{
    let target,cdp;
    try{
      ({target,cdp}=await openIsolatedPage('/customizations'));const tree=await cdp.send('Page.getFrameTree'),ctx=await cdp.send('Page.createIsolatedWorld',{frameId:tree.frameTree.frame.id,worldName:'GRAVITYBOX-plugin-test'});
      await cdp.evaluate(`document.body.innerHTML='<main><div><a href="/customizations/plugins/public-plugin">Public Plugin</a><p id="plugin-desc">Read and draft public documents.</p><button>Install</button></div><p id="outside-desc">Read and draft public documents.</p></main>'`);
      const engine=await readFile(join(root,'dist/engine.js'),'utf8');await cdp.evaluate(`globalThis.__GRAVITYBOX_BOOT__=${JSON.stringify({origin,path:'/customizations',dictionary:{schema:1,version:'plugin',entries:{'@ui:/customizations|description|Read and draft public documents.':'阅读并起草公共文档。'}}})};
${engine}`,ctx.executionContextId);await until(async()=>await text(cdp,'#plugin-desc')==='阅读并起草公共文档。');assert.equal(await text(cdp,'#outside-desc'),'Read and draft public documents.');await cdp.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.dispose()',ctx.executionContextId);
      const gate=await cdp.send('Page.createIsolatedWorld',{frameId:tree.frameTree.frame.id,worldName:'GRAVITYBOX-gated-test'});
      await cdp.evaluate(`document.body.innerHTML='<button id="gate-known">Known gated action</button>'`);
      await cdp.evaluate(`globalThis.__GRAVITYBOX_BOOT__=${JSON.stringify({origin,path:'/customizations',conservative:true,dictionary:{schema:1,version:'gate',entries:{'Known gated action':'已识别操作'}}})};
${engine}`,gate.executionContextId);assert.equal(await text(cdp,'#gate-known'),'Known gated action');
      await cdp.evaluate(`document.body.insertAdjacentHTML('beforeend','<nav aria-label="Sidebar"><a href="/history">History</a></nav>')`);await until(async()=>await text(cdp,'#gate-known')==='已识别操作');assert.equal(await cdp.evaluate('!!globalThis.__GRAVITYBOX_ENGINE_V1__.deepScan',gate.executionContextId),true);assert.equal((await cdp.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.maintenanceState()',gate.executionContextId)).busy,false);await cdp.evaluate(`document.body.insertAdjacentHTML('beforeend','<textarea id=\"draft-guard\"></textarea>');document.querySelector('#draft-guard').value='Unsent draft'`);assert.equal((await cdp.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.maintenanceState()',gate.executionContextId)).busy,true);assert.equal(await cdp.evaluate(`document.querySelector('#draft-guard').value`),'Unsent draft');await cdp.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.dispose()',gate.executionContextId);assert.equal(await cdp.evaluate('!!globalThis.__GRAVITYBOX_ATTACH_DEEP_SCAN__',gate.executionContextId),false);
      await cdp.send('Page.navigate',{url:origin+'/login'});await until(async()=>await text(cdp,'button')==='Settings');const loginTree=await cdp.send('Page.getFrameTree'),login=await cdp.send('Page.createIsolatedWorld',{frameId:loginTree.frameTree.frame.id,worldName:'GRAVITYBOX-auth-guard-test'});
      await cdp.evaluate(`globalThis.__GRAVITYBOX_BOOT__=${JSON.stringify({origin,path:'/login',dictionary:{schema:1,version:'guard',entries:{Settings:'设置'}}})};
${engine}`,login.executionContextId);assert.equal(await text(cdp,'button'),'Settings');assert.equal(await cdp.evaluate('!!globalThis.__GRAVITYBOX_ENGINE_V1__',login.executionContextId),false);

    }finally{cdp?.close();if(target?.targetId)await browserCommand('Target.closeTarget',{targetId:target.targetId}).catch(error => { chromeErrors += '\nTarget cleanup: ' + error.message; });}
  });
  await check('模型关闭使用受控事件序列，设置关闭只操作本轮容器',async()=>{
    let target,isolated;
    try { ({target,cdp:isolated}=await openIsolatedPage('/customizations'));await isolated.evaluate("document.body.innerHTML=''");const tree=await isolated.send('Page.getFrameTree'),ctx=await isolated.send('Page.createIsolatedWorld',{frameId:tree.frameTree.frame.id,worldName:'GRAVITYBOX-close-guards-test'});
    const engine=await readFile(join(root,'dist/engine.js'),'utf8');
    await isolated.evaluate(`globalThis.__GRAVITYBOX_BOOT__=${JSON.stringify({origin,path:'/customizations',dictionary:{schema:1,version:'close',entries:{}}})};
${engine}`,ctx.executionContextId);
    await isolated.evaluate(`(()=>{const host=document.createElement('section');host.id='close-guards';host.innerHTML='<nav aria-label="Sidebar"><button id="own-settings">Settings</button></nav><button data-testid="model-selector-trigger" id="own-model">Model</button>';document.body.prepend(host);const model=host.querySelector('#own-model');model.onclick=()=>{if(!host.querySelector('[data-testid="model-selector-panel"]')){const p=document.createElement('div');p.dataset.testid='model-selector-panel';p.textContent='Public quota';host.append(p)}};model.onpointerdown=()=>host.querySelector('[data-testid="model-selector-panel"]')?.remove();host.querySelector('#own-settings').onclick=()=>{const pane=document.createElement('section');pane.dataset.testid='settings-root';pane.innerHTML='<h1>Settings</h1><nav><button>General</button><button>Appearance</button></nav><button id="settings-done">Done</button>';host.append(pane);pane.querySelector('#settings-done').onclick=()=>pane.remove()}})()`);
    assert.equal((await isolated.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.deepScan.begin([])',ctx.executionContextId)).ok,true);
    assert.equal((await isolated.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.deepScan.step("model-open")',ctx.executionContextId)).ok,true);
    assert.equal((await isolated.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.deepScan.step("model-close")',ctx.executionContextId)).ok,true);
    assert.equal(await isolated.evaluate('!!document.querySelector("[data-testid=model-selector-panel]")'),false);
    assert.equal((await isolated.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.deepScan.step("settings-open")',ctx.executionContextId)).ok,true);
    assert.equal((await isolated.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.deepScan.step("settings-close")',ctx.executionContextId)).ok,true);
    assert.equal((await isolated.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.deepScan.finish()',ctx.executionContextId)).editorsMatch,true);
    await isolated.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.dispose()',ctx.executionContextId);await isolated.evaluate('document.querySelector("#close-guards").remove()');} finally { isolated?.close();if(target?.targetId)await browserCommand('Target.closeTarget',{targetId:target.targetId}).catch(error => { chromeErrors += '\nTarget cleanup: ' + error.message; });}
  });
  await check('插件说明多文本节点与场景译文粒度一致，普通段落仍受保护',async()=>{
    let target,cdp;
    try{
      ({target,cdp}=await openIsolatedPage('/customizations'));
      await cdp.evaluate(`document.body.innerHTML='<div><a href="/customizations/plugins/chunks">Chunked Plugin</a><p id="block-one">Read public documents.</p><p id="block-two"><span>Draft public documents.</span> Review public documents.</p><button>Install</button></div><p id="not-card">Read public documents.</p>'`);
      const tree=await cdp.send('Page.getFrameTree'),ctx=await cdp.send('Page.createIsolatedWorld',{frameId:tree.frameTree.frame.id,worldName:'GRAVITYBOX-plugin-chunks'}),engine=await readFile(join(root,'dist/engine.js'),'utf8');
      const entries={'@ui:/customizations|description|Read public documents.':'阅读公共文档。','@ui:/customizations|description|Draft public documents.':'起草公共文档。','@ui:/customizations|description|Review public documents.':'审查公共文档。'};
      await cdp.evaluate(`globalThis.__GRAVITYBOX_BOOT__=${JSON.stringify({origin,path:'/customizations',dictionary:{schema:1,version:'chunks',entries}})};
${engine}`,ctx.executionContextId);
      await until(async()=>await text(cdp,'#block-one')==='阅读公共文档。');assert.equal((await text(cdp,'#block-two')).replace(/\s/g,''),'起草公共文档。审查公共文档。');assert.equal(await text(cdp,'#not-card'),'Read public documents.');
      const catalogue=await cdp.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.pluginCatalog()',ctx.executionContextId);assert.deepEqual(catalogue.map(x=>x.description).sort(),['Read public documents.','Draft public documents.','Review public documents.'].sort());
      await cdp.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.dispose()',ctx.executionContextId);
    }finally{cdp?.close();if(target?.targetId)await browserCommand('Target.closeTarget',{targetId:target.targetId}).catch(error => { chromeErrors += '\nTarget cleanup: ' + error.message; });}
  });
  await check('独立设置壳可保守汉化提示与占位符，引导页仍拒绝注入',async()=>{
    let target,cdp;
    try{
      ({target,cdp}=await openIsolatedPage('/settings-standalone'));const engine=await readFile(join(root,'dist/engine.js'),'utf8');
      await cdp.evaluate(`document.body.innerHTML='<section data-testid="settings-root"><nav role="tablist"><button>General</button></nav><input id="standalone-input" placeholder="Find settings" value="Private draft"><div role="tooltip" id="standalone-tooltip">Worked for 12s</div><div class="monaco-editor">Settings</div></section>'`);
      const tree=await cdp.send('Page.getFrameTree'),ctx=await cdp.send('Page.createIsolatedWorld',{frameId:tree.frameTree.frame.id,worldName:'GRAVITYBOX-standalone-test'});
      const boot={origin,path:'/settings-standalone',conservative:true,dictionary:{schema:1,version:'standalone',entries:{General:'通用','Find settings':'查找设置',Settings:'设置'}}};
      await cdp.evaluate(`globalThis.__GRAVITYBOX_BOOT__=${JSON.stringify(boot)};
${engine}`,ctx.executionContextId);
      await until(async()=>await cdp.evaluate('document.querySelector("#standalone-input").placeholder')==='查找设置');assert.equal(await cdp.evaluate('document.querySelector("#standalone-input").value'),'Private draft');assert.equal(await text(cdp,'.monaco-editor'),'Settings');assert.equal(await text(cdp,'#standalone-tooltip'),'已用时 12秒');await cdp.evaluate("history.pushState({},'', '/onboarding');document.querySelector('[data-testid=settings-root]').insertAdjacentHTML('beforeend','<button id=\"auth-sensitive\">Private onboarding heading</button>')");assert.equal((await cdp.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.collectUntranslated()',ctx.executionContextId)).length,0);await cdp.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.dispose()',ctx.executionContextId);
      await cdp.send('Page.navigate',{url:origin+'/onboarding'});await until(async()=>await text(cdp,'button')==='Settings');
      const authTree=await cdp.send('Page.getFrameTree'),auth=await cdp.send('Page.createIsolatedWorld',{frameId:authTree.frameTree.frame.id,worldName:'GRAVITYBOX-onboarding-test'});
      await cdp.evaluate(`document.body.innerHTML='<nav aria-label="Sidebar"><a href="/history">History</a></nav><button>Settings</button>'`);await cdp.evaluate(`globalThis.__GRAVITYBOX_BOOT__=${JSON.stringify({...boot,path:'/onboarding'})};
${engine}`,auth.executionContextId);assert.equal(await cdp.evaluate('!!globalThis.__GRAVITYBOX_ENGINE_V1__',auth.executionContextId),false);assert.equal(await text(cdp,'button'),'Settings');
    }finally{cdp?.close();if(target?.targetId)await browserCommand('Target.closeTarget',{targetId:target.targetId}).catch(error => { chromeErrors += '\nTarget cleanup: ' + error.message; });}
  });
  await check('class 抖动不触发全量 reconcile/重建，保护状态变化仍能纠正', async () => {
    const tree = await main.send('Page.getFrameTree');const context = await main.send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'GRAVITYBOX-localization-v1' });
    await main.evaluate(`(()=>{const host=document.createElement('div');host.id='jitter-probe';let rows='';for(let i=0;i<120;i++)rows+='<button class="row" id="jrow'+i+'">Settings</button>';host.innerHTML=rows+'<div id="jitter-host"></div>';document.body.append(host);const jitter=document.querySelector('#jitter-host');for(let i=0;i<120;i++){const d=document.createElement('div');d.className='jitter';jitter.append(d)}})()`);
    await until(async () => await text(main, '#jrow119') === '设置');
    await new Promise(resolve => setTimeout(resolve, 300));
    const before = await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.state()', context.executionContextId);
    await main.evaluate(`(()=>{const rows=[...document.querySelectorAll('#jitter-host .jitter')];for(let round=0;round<4;round++)for(const row of rows)row.className='jitter round'+round})()`);
    await new Promise(resolve => setTimeout(resolve, 250));
    const after = await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.state()', context.executionContextId);
    assert.equal(after.reconcileChecks, before.reconcileChecks, 'class 抖动不应触发 reconcile');
    assert.ok(after.scanCount <= before.scanCount + 1, 'class 抖动不应重建整页');
    assert.ok(after.maxSliceMs <= 80, 'maxSliceMs=' + after.maxSliceMs);
    /* 保护状态真的变化时仍然纠正：已翻译节点被标记为 markdown 后恢复英文，移除后重新汉化 */
    await main.evaluate('document.querySelector("#jrow0").classList.add("markdown")');
    await until(async () => await text(main, '#jrow0') === 'Settings');
    await main.evaluate('document.querySelector("#jrow0").classList.remove("markdown")');
    await until(async () => await text(main, '#jrow0') === '设置');
    await main.evaluate('document.querySelector("#jitter-probe").remove()');
  });
  await check('词典同步提示只在版本改变后出现，重复应用及英文对照保持安静',async()=>{
    try { await main.send('Page.bringToFront'); } catch {
      main.close();const same=await until(async()=>(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>t.id===page.id));main=new CDP(same.webSocketDebuggerUrl);await main.connect();await main.send('Page.enable');await main.send('Page.bringToFront');
    }
    await new Promise(r=>setTimeout(r,2600));
    try { await main.send('Page.enable'); } catch {
      main.close();const same=await until(async()=>(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>t.id===page.id));main=new CDP(same.webSocketDebuggerUrl);await main.connect();await main.send('Page.enable');
    }
    const tree=await main.send('Page.getFrameTree'),ctx=await main.send('Page.createIsolatedWorld',{frameId:tree.frameTree.frame.id,worldName:'GRAVITYBOX-localization-v1'});
    await main.evaluate(`globalThis.__GB_TOAST_TEST__={...globalThis.__GRAVITYBOX_BOOT__.dictionary,version:'toast-test-'+Date.now()};globalThis.__GRAVITYBOX_ENGINE_V1__.update(globalThis.__GB_TOAST_TEST__)`,ctx.executionContextId);
    await until(async()=>await text(main,'#__gravitybox_toast__')==='GravityBox · 词典已同步更新');await until(async()=>await text(main,'#__gravitybox_toast__')===undefined,3000);
    await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.update(globalThis.__GB_TOAST_TEST__)',ctx.executionContextId);await new Promise(r=>setTimeout(r,200));assert.equal(await text(main,'#__gravitybox_toast__'),undefined);
    await main.evaluate(`globalThis.__GRAVITYBOX_ENGINE_V1__.toggleLanguage('en')`,ctx.executionContextId);await main.evaluate(`globalThis.__GRAVITYBOX_ENGINE_V1__.update({...globalThis.__GB_TOAST_TEST__,version:'toast-english'})`,ctx.executionContextId);await new Promise(r=>setTimeout(r,200));assert.equal(await text(main,'#__gravitybox_toast__'),undefined);await command('pause');await command('resume');await until(async()=>(await status()).mode==='connected');
  });
  await check('页面重载与暂停交错后不遗留引擎，连续恢复仍能正常退出',async()=>{
    for(let n=0;n<3;n++){
      await Promise.all([main.send('Page.reload'),command('pause')]);
      // Chrome may replace the renderer's inspection transport during reload. Rebind the test reader
      // to the same target; the backend and all restoration assertions remain unchanged.
      main.close();const same=await until(async()=>(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>t.id===page.id));main=new CDP(same.webSocketDebuggerUrl);await main.connect();await main.send('Page.enable');
      await until(async()=>await text(main,'#settings')==='Settings');await new Promise(r=>setTimeout(r,180));assert.equal(await text(main,'#settings'),'Settings');
      await command('resume');await until(async()=>await text(main,'#settings')==='设置');
    }
  });
  await check('真实设置结构：兼容模式翻译普通标签和说明、保留代码/链接/项目名，并可在设置已打开时启动',async()=>{
    const target=await browserCommand('Target.createTarget',{url:origin+'/?settingsOpen=true&settingsScreen=General'});let cdp;
    try {
      const page=await until(async()=>(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>t.id===target.targetId));cdp=new CDP(page.webSocketDebuggerUrl);await cdp.connect();await documentReady(cdp);
      const html='<div role="dialog" aria-label="Settings"><button aria-label="Close">Close</button><aside><h1>Settings</h1><button>General</button><button>App Settings</button><button>Appearance</button><h2>Project list</h2><button id="settings-project">Queued Messages</button><button id="settings-expand" class="text-xs mx-4 hover:underline">Show All</button><button id="settings-expand-sm" class="text-sm mx-4 hover:underline">Show All</button><button id="settings-expand-less" class="text-sm mx-4 hover:underline">Show Less</button><h2>Not in a project</h2><button>Chats</button></aside><main><h2>General</h2><div id="settings-description">Configure agent execution, queued message delivery, and permissions.</div><div><span id="settings-queued">Queued Messages</span><div>Configure when follow-up messages are sent.</div><span id="settings-policy">Permission Preset</span><p id="settings-inline">Type <code>/</code> and select <code>plan</code> to have the agent generate a plan.</p><div class="font-mono" style="white-space: pre"><div><span id="settings-code-name">Name</span></div></div><div data-gravitybox-user-content id="settings-private">Permission Preset</div><input value="Queued Messages"></div></main></div><div id="settings-outside">Permission Preset</div>';
      await cdp.evaluate('document.body.innerHTML='+JSON.stringify(html));
      const entries={Name:'名称','Show All':'显示全部','Show less':'收起',Settings:'设置',General:'通用','App Settings':'应用设置',Appearance:'外观','Queued Messages':'排队消息','Permission Preset':'权限预设','Configure when follow-up messages are sent.':'配置何时发送后续追问消息。','Configure agent execution, queued message delivery, and permissions.':'配置智能体执行、排队消息发送及权限。','Type {0} and select {1} to have the agent generate a plan.':'输入 {0} 并选择 {1}，让智能体生成规划。'};
      const engine=await readFile(join(root,'dist/engine.js'),'utf8');await cdp.evaluate('globalThis.__GRAVITYBOX_BOOT__='+JSON.stringify({origin,path:'/',dictionary:{schema:1,version:'real-settings-regression',entries},conservative:true})+';'+engine);
      await until(async()=>await text(cdp,'#settings-queued')==='排队消息');assert.equal(await text(cdp,'#settings-policy'),'权限预设');assert.equal(await text(cdp,'#settings-description'),'配置智能体执行、排队消息发送及权限。');
      assert.equal(await text(cdp,'#settings-inline'),'输入 / 并选择 plan，让智能体生成规划。');assert.equal(await cdp.evaluate('document.querySelector("input").value'),'Queued Messages');assert.equal(await text(cdp,'#settings-project'),'Queued Messages');assert.equal(await text(cdp,'#settings-expand'),'显示全部');assert.equal(await text(cdp,'#settings-expand-sm'),'显示全部');assert.equal(await text(cdp,'#settings-expand-less'),'收起');assert.equal(await text(cdp,'#settings-code-name'),'Name');assert.equal(await text(cdp,'#settings-private'),'Permission Preset');assert.equal(await text(cdp,'#settings-outside'),'Permission Preset');assert.equal(await text(cdp,'code'),' /'.trim());
      await cdp.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.dispose()');assert.equal(await text(cdp,'#settings-queued'),'Queued Messages');assert.equal(await text(cdp,'#settings-inline'),'Type / and select plan to have the agent generate a plan.');
    }finally{cdp?.close();if(target?.targetId)await browserCommand('Target.closeTarget',{targetId:target.targetId}).catch(error => { chromeErrors += '\nTarget cleanup: ' + error.message; });}
  });
  await check('2.31-2.32 适配：新交互卡片选择性保护、新版实体路由、长文案采集与新动态模板', async () => {
    let target,cdp;
    try {
      ({target,cdp}=await openIsolatedPage('/'));
      const longCopy='Run a swarm: several agents working in parallel on one task, each in its own conversation, collaborating through a shared message board. Use when work splits cleanly.';
      const html=`<main><div data-testid="coordinator-worker-card" role="button"><span id="v232-worker-name" class="text-sm truncate">Settings</span><div id="v232-worker-latest" data-testid="coordinator-card-latest-line">Settings</div><button id="v232-worker-stop" title="Stop Subagent">Stop Subagent</button></div><button id="v232-side-popout" data-testid="side-question-popout" aria-label="Open in full conversation"></button><div id="v232-side-user" data-testid="side-question-followup-user">Settings</div><div id="v232-side-thinking" data-testid="side-question-followup-thinking">Thinking...</div><div id="v232-voice-summary" data-testid="voice-transcript-summary">Settings</div><nav aria-label="Sidebar"><a id="v232-link-skill" href="/customizations/marketplaces/official/skills/my-skill">Settings</a><a id="v232-link-bundle" href="/customizations/marketplaces/official/bundles/my-bundle">Settings</a><a id="v232-link-sidecar" href="/customizations/sidecars/my-sidecar">Settings</a><a id="v232-link-trigger" href="/sidecars/triggers/my-trigger">Settings</a><a id="v232-link-nav" href="/customizations">Customizations</a></nav><div role="menu"><div data-testid="model-selector-panel"><span id="v232-model-weekly">Gemini Flash Next Weekly Limit</span><span id="v232-model-daily">Gemini Flash Next Daily Limit</span></div></div><div role="tooltip" id="v232-cancel-q">Cancel Questionnaire and Stop the Agent (Esc)</div><button id="v232-long-btn">${longCopy}</button></main>`;
      await cdp.evaluate('document.body.innerHTML='+JSON.stringify(html));
      const entries={Settings:'设置','Stop Subagent':'停止子智能体','Open in full conversation':'在完整对话中打开','Thinking...':'思考中...',Customizations:'自定义项'};
      const engine=await readFile(join(root,'dist/engine.js'),'utf8');
      await cdp.evaluate('globalThis.__GRAVITYBOX_BOOT__='+JSON.stringify({origin,path:'/',dictionary:{schema:1,version:'v232-regression',entries}})+';'+engine);
      await until(async()=>await text(cdp,'#v232-worker-stop')==='停止子智能体');
      assert.equal(await cdp.evaluate('document.querySelector("#v232-worker-stop").getAttribute("title")'),'停止子智能体');
      assert.equal(await text(cdp,'#v232-worker-name'),'Settings');
      assert.equal(await text(cdp,'#v232-worker-latest'),'Settings');
      assert.equal(await cdp.evaluate('document.querySelector("#v232-side-popout").getAttribute("aria-label")'),'在完整对话中打开');
      assert.equal(await text(cdp,'#v232-side-user'),'Settings');
      assert.equal(await text(cdp,'#v232-side-thinking'),'思考中...');
      assert.equal(await text(cdp,'#v232-voice-summary'),'Settings');
      for(const id of ['#v232-link-skill','#v232-link-bundle','#v232-link-sidecar','#v232-link-trigger'])assert.equal(await text(cdp,id),'Settings');
      assert.equal(await text(cdp,'#v232-link-nav'),'自定义项');
      assert.equal(await text(cdp,'#v232-model-weekly'),'Gemini Flash Next 每周限额');
      assert.equal(await text(cdp,'#v232-model-daily'),'Gemini Flash Next 每日限额');
      assert.equal(await text(cdp,'#v232-cancel-q'),'取消问卷并停止智能体 (Esc)');
      await cdp.evaluate('document.querySelector("#v232-long-btn")?.scrollIntoView({block:"center"})');
      const collected=await until(async()=>{
        const list=await collectUntranslatedFull(cdp);
        if(list.some(item=>item.key===longCopy))return list;
      },8000,'v232 longCopy collectUntranslated');
      assert.equal(collected.some(item=>item.key===longCopy),true,'超过 120 字符的安全界面文案应被 collectUntranslated 采集');
      await cdp.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.dispose()');
    }finally{cdp?.close();if(target?.targetId)await browserCommand('Target.closeTarget',{targetId:target.targetId}).catch(error => { chromeErrors += '\nTarget cleanup: ' + error.message; });}
  });
  await check('引导条款弹窗多文本节点、弯引号与升级套餐说明均可正确汉化并无损恢复', async () => {
    let target, cdp;
    try {
      ({ target, cdp } = await openIsolatedPage('/'));
      await cdp.evaluate(`(() => {
        document.body.innerHTML = '<div role="dialog" aria-modal="true"><h2 id="terms-h2">One last thing before getting started\\u2026</h2><p id="terms-sub">A few things to know, and a couple settings to review.</p><ul><li><span id="terms-opt-title">Optimized for you</span><span id="terms-opt-body"></span></li><li><span id="terms-safe-title">Built to help, not hurt</span><span id="terms-safe-body">Automated safeguards help to protect your conversations from insecure or unsafe content. That being said, users should be aware of potential agentic risks, including data exfiltration.</span></li><li><span id="terms-ctrl-title">You are in control</span><span id="terms-ctrl-body"></span></li></ul><label><input type="checkbox"><span id="terms-improve"><span>Help us improve Antigravity.</span> Allow Google to collect and use your Interactions data, subject to the <a href="https://antigravity.google/terms">Google Antigravity Terms of Service</a> and <a href="https://policies.google.com/privacy">Google Privacy Policy</a>. You can control this from your settings at any point.</span></label><label><input type="checkbox"><span id="terms-stay"></span></label><button id="terms-btn">Continue</button></div><div role="dialog" aria-label="Settings"><aside><h1>Settings</h1><button>General</button><button>Models</button><button>Appearance</button></aside><main><h2>Models</h2><div id="plan-upgrade-desc">You can upgrade to a higher Google AI Ultra plan to receive the highest rate limits.</div></main></div>';
        const opt = document.querySelector('#terms-opt-body');
        opt.append(
          document.createTextNode('Customize your experience across the agent, plugins, and product from the settings and marketplace. We won\\u2019t show you ads or let advertisers influence what '),
          document.createTextNode('Antigravity'),
          document.createTextNode(' says.')
        );
        const ctrl = document.querySelector('#terms-ctrl-body');
        ctrl.append(
          document.createTextNode('Antigravity'),
          document.createTextNode('\\u2019s agents are powerful and will help you get a lot done better and faster than before, but still make sure to verify the actions taken by the agent.')
        );
        const stay = document.querySelector('#terms-stay');
        const stayTitle = document.createElement('span');
        stayTitle.textContent = 'Stay up to date.';
        stay.append(
          stayTitle,
          document.createTextNode(' '),
          document.createTextNode('Sign up for newsletters, tips and tricks, and other notifications about '),
          document.createTextNode('Antigravity'),
          document.createTextNode('.')
        );
      })()`);
      const entries = JSON.parse(await readFile(join(root, 'dict/base.json'), 'utf8'));
      const engine = await readFile(join(root, 'dist/engine.js'), 'utf8');
      await cdp.evaluate('globalThis.__GRAVITYBOX_BOOT__=' + JSON.stringify({ origin, path: '/', dictionary: { schema: 1, version: 'terms-modal-regression', entries } }) + ';' + engine);
      await until(async () => await text(cdp, '#terms-stay') === '获取最新动态。 订阅 Antigravity 的产品动态、实用技巧及其他通知。');
      assert.equal(await text(cdp, '#terms-h2'), '开始前，还有最后几项确认…');
      assert.equal(await text(cdp, '#terms-sub'), '请先了解以下要点，并核对相关设置。');
      assert.equal(await text(cdp, '#terms-opt-title'), '为您优化体验');
      assert.equal(await text(cdp, '#terms-opt-body'), '您可在设置和市场中自定义智能体、插件及产品的整体体验。我们绝不向您展示广告，也不会让广告商左右 Antigravity 的回复。');
      assert.equal(await text(cdp, '#terms-safe-title'), '助力开发，安全护航');
      assert.equal(await text(cdp, '#terms-safe-body'), '自动安全防护机制有助于保护您的对话免受不安全或危险内容的影响。尽管如此，仍请留意智能体可能带来的潜在风险（包括数据外泄）。');
      assert.equal(await text(cdp, '#terms-ctrl-title'), '操作由您掌控');
      assert.equal(await text(cdp, '#terms-ctrl-body'), 'Antigravity 的智能体功能强大，能助您更高效、更出色地完成更多工作，但仍请务必核实其执行的每项操作。');
      assert.equal(await text(cdp, '#terms-improve'), '帮助我们改进 Antigravity。 允许 Google 收集并使用您的交互数据，并遵循 Google Antigravity 服务条款与 Google 隐私政策。您可随时在设置中更改此项。');
      assert.equal(await text(cdp, '#terms-btn'), '继续');
      assert.equal(await text(cdp, '#plan-upgrade-desc'), '您可以升级到更高阶的 Google AI Ultra 套餐以获得最高速率限额。');
      await cdp.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.dispose()');
      assert.equal(await text(cdp, '#terms-stay'), 'Stay up to date. Sign up for newsletters, tips and tricks, and other notifications about Antigravity.');
      assert.equal(await text(cdp, '#terms-opt-body'), 'Customize your experience across the agent, plugins, and product from the settings and marketplace. We won\u2019t show you ads or let advertisers influence what Antigravity says.');
    } finally { cdp?.close(); if (target?.targetId) await browserCommand('Target.closeTarget', { targetId: target.targetId }).catch(error => { chromeErrors += '\nTarget cleanup: ' + error.message; }); }
  });
  await check('1.1.2 补全：项目已存在多片段弹窗、创建项目重复提示行与含 SVG 图标的归档通知均可整句汉化并无损恢复', async () => {
    let target, cdp;
    try {
      ({ target, cdp } = await openIsolatedPage('/'));
      await cdp.evaluate(`(() => {
        document.body.innerHTML = [
          '<div role="dialog" aria-modal="true">',
          '  <h2>Project already exists</h2>',
          '  <div id="dup-single" class="text-foreground"></div>',
          '  <div id="dup-multi" class="text-foreground"></div>',
          '  <button>Back</button><button>Create New</button><button>Use Existing</button>',
          '</div>',
          '<div role="dialog" aria-modal="true">',
          '  <h2>Create a Project</h2>',
          '  <div id="create-dup" class="flex items-center gap-1 text-sm text-muted-foreground select-none"><svg width="13" height="13" aria-label="info"><circle cx="6" cy="6" r="5"></circle></svg><span id="create-dup-prefix">A</span><button id="create-dup-btn" type="button" onclick="window.__dupBtnClicks=(window.__dupBtnClicks||0)+1">project</button><span id="create-dup-suffix">with the same folder exists</span></div>',
          '  <div id="create-dup-similar" class="flex items-center gap-1 text-sm text-muted-foreground select-none"><svg width="13" height="13" aria-label="info"><circle cx="6" cy="6" r="5"></circle></svg><span>A similar</span><button type="button">project</button><span>exists</span></div>',
          '</div>',
          '<div data-sonner-toast="true" role="status">',
          '  <span id="toast-title">Conversation Archived</span>',
          '  <p id="toast-archived">View archived in the sidebar (<svg id="toast-filter-svg" width="14" height="14" aria-label="filter"><path d="M1 2h12"></path></svg> menu).</p>',
          '  <button>Undo</button>',
          '</div>',
          '<div data-testid="empty-state">',
          '  <span id="empty-search">Search conversations with <svg width="14" height="14" aria-label="search"><circle cx="6" cy="6" r="4"></circle></svg> in the top left.</span>',
          '  <span id="empty-archived">View archived in the sidebar <span class="whitespace-nowrap">(<svg width="14" height="14" aria-label="filter"><path d="M1 2h12"></path></svg> menu)</span>.</span>',
          '</div>'
        ].join('');
        const single = document.querySelector('#dup-single');
        const name1 = document.createElement('span');
        name1.textContent = 'gravitybox1.1.1';
        single.append(
          document.createTextNode('Project '),
          name1,
          document.createTextNode(' already exists for this '),
          document.createTextNode('folder'),
          document.createTextNode('. Would you like to continue using it or make a new one?')
        );
        const multi = document.querySelector('#dup-multi');
        const name2 = document.createElement('span');
        name2.textContent = 'gravitybox-multi';
        multi.append(
          document.createTextNode('Project '),
          name2,
          document.createTextNode(' already exists for this '),
          document.createTextNode('combination of folders'),
          document.createTextNode('. Would you like to continue using it or make a new one?')
        );
      })()`);
      const entries = JSON.parse(await readFile(join(root, 'dict/base.json'), 'utf8'));
      const engine = await readFile(join(root, 'dist/engine.js'), 'utf8');
      await cdp.evaluate('globalThis.__GRAVITYBOX_BOOT__=' + JSON.stringify({ origin, path: '/', dictionary: { schema: 1, version: 'v112-ui-fixes', entries } }) + ';' + engine);
      await until(async () => (await text(cdp, '#dup-single')) === '此文件夹已存在项目 gravitybox1.1.1。您想继续使用它，还是新建一个？');
      assert.equal(await text(cdp, '#dup-multi'), '此文件夹组合已存在项目 gravitybox-multi。您想继续使用它，还是新建一个？');
      await until(async () => (await text(cdp, '#create-dup-prefix')) === '已存在使用相同文件夹的' && (await text(cdp, '#create-dup-btn')) === '项目');
      assert.equal(await text(cdp, '#create-dup-suffix'), '');
      await until(async () => (await text(cdp, '#create-dup-similar')) === '已存在类似的项目');
      await cdp.evaluate('document.querySelector("#create-dup-btn").click()');
      assert.equal(await cdp.evaluate('window.__dupBtnClicks'), 1);
      await until(async () => (await text(cdp, '#toast-archived')) === '可在侧边栏（菜单）中查看已归档项。');
      assert.equal(await cdp.evaluate('document.querySelector("#toast-filter-svg")?.tagName.toLowerCase()'), 'svg');
      assert.equal(await cdp.evaluate('document.querySelector("#toast-filter-svg")?.getAttribute("aria-label")'), 'filter');
      assert.equal(await text(cdp, '#empty-search'), '使用左上角的搜索对话。');
      assert.equal(await text(cdp, '#empty-archived'), '可在侧边栏（菜单）中查看已归档项。');
      /* P1-03：未命中词典的复合提示组保持完整英文（不把中间 <button>project</button> 孤立译成“项目”），并按整句模板采集；已翻译组变为未知句式时连带还原 <button> */
      await cdp.evaluate(`document.querySelector('[role="dialog"] + [role="dialog"]').insertAdjacentHTML('beforeend', '<div id="create-dup-untranslated" class="flex items-center gap-1 text-sm"><svg width="13" height="13"><circle cx="6" cy="6" r="5"></circle></svg><span>A</span><button id="create-dup-untranslated-btn" type="button">project</button><span>is invalid</span></div>')`);
      await cdp.evaluate('document.querySelector("#create-dup-untranslated").scrollIntoView({block:"center"})');
      const compCollected = await until(async () => {
        const list = await collectUntranslatedFull(cdp);
        if (list.some(item => item.key === 'A {0} is invalid')) return list;
      }, 8000, 'compositePromptGroup whole-sentence collection');
      assert.equal(await text(cdp, '#create-dup-untranslated-btn'), 'project', '整句未命中时中间按钮不得被孤立翻译为“项目”');
      assert.equal(compCollected.some(item => item.key === 'is invalid'), false, '复合提示组不得拆碎采集局部 span');
      await cdp.evaluate('document.querySelector("#create-dup-suffix").firstChild.nodeValue = "has an invalid location"');
      await until(async () => (await text(cdp, '#create-dup-prefix')) === 'A' && (await text(cdp, '#create-dup-btn')) === 'project');
      assert.equal(await text(cdp, '#create-dup-suffix'), 'has an invalid location');
      assert.equal(await cdp.evaluate('!!document.querySelector("#create-dup").dataset.gravityboxLoc'), false);
      /* F-01 / F-05 回归：单侧 span+button 普通行不被 compositePromptGroup 吞掉；带前置 SVG 装饰图标的按钮正常汉化且不污染 collectUntranslated */
      await cdp.evaluate(`document.body.insertAdjacentHTML('beforeend', [
        '<div role="region">',
        '  <div id="single-side-row" class="flex items-center justify-between"><svg width="13" height="13"><circle cx="6" cy="6" r="5"></circle></svg><span id="single-side-lbl">Theme</span><button id="single-side-btn" type="button">Reset</button></div>',
        '  <button id="svg-btn-abbr" type="button"><svg width="13" height="13"><circle cx="6" cy="6" r="5"></circle></svg> Add MCP Server</button>',
        '  <button id="svg-btn-new" type="button"><svg width="13" height="13"><circle cx="6" cy="6" r="5"></circle></svg> BrandNewSvgAction</button>',
        '</div>'
      ].join(''))`);
      await until(async () => (await text(cdp, '#single-side-lbl')) === '主题' && (await text(cdp, '#single-side-btn')) === '重置');
      await until(async () => (await text(cdp, '#svg-btn-abbr')).includes('添加 MCP 服务器'));
      const svgCollected = await collectUntranslatedFull(cdp);
      assert.equal(svgCollected.some(item => item.key.includes('{0} Add MCP Server')), false, '已翻译的带 SVG 图标按钮（含英文缩写）不得被误采为半翻译混合组');
      assert.equal(svgCollected.some(item => item.key === 'BrandNewSvgAction'), true, '未翻译的带前置 SVG 图标按钮应按纯文本采集');
      assert.equal(svgCollected.some(item => item.key === '{0} BrandNewSvgAction'), false, '前置装饰 SVG 不得污染按钮候选 key');
      assert.equal(svgCollected.some(item => item.key === 'Theme {0}'), false, '单侧 span+button 普通行不得被采集为复合模板');
      /* 动态变更回受支持的复数模板后再次原子成组汉化，并测试双语切换与卸载还原 */
      await cdp.evaluate('document.querySelector("#create-dup-suffix").firstChild.nodeValue = "with the same folders exists"');
      await until(async () => (await text(cdp, '#create-dup-prefix')) === '已存在使用相同文件夹的' && (await text(cdp, '#create-dup-btn')) === '项目' && (await text(cdp, '#create-dup-suffix')) === '');
      await cdp.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.toggleLanguage("en")');
      assert.equal(await text(cdp, '#dup-single'), 'Project gravitybox1.1.1 already exists for this folder. Would you like to continue using it or make a new one?');
      assert.equal(await text(cdp, '#create-dup-prefix'), 'A');
      assert.equal(await text(cdp, '#create-dup-btn'), 'project');
      assert.equal(await text(cdp, '#create-dup-suffix'), 'with the same folders exists');
      assert.equal(await cdp.evaluate('!!document.querySelector("#create-dup").dataset.gravityboxLoc'), false);
      assert.equal(await text(cdp, '#toast-archived'), 'View archived in the sidebar ( menu).');
      await cdp.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.toggleLanguage("zh")');
      assert.equal(await text(cdp, '#toast-archived'), '可在侧边栏（菜单）中查看已归档项。');
      await cdp.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.dispose()');
      assert.equal(await text(cdp, '#dup-single'), 'Project gravitybox1.1.1 already exists for this folder. Would you like to continue using it or make a new one?');
      assert.equal(await text(cdp, '#create-dup-prefix'), 'A');
      assert.equal(await text(cdp, '#toast-archived'), 'View archived in the sidebar ( menu).');
    } finally { cdp?.close(); if (target?.targetId) await browserCommand('Target.closeTarget', { targetId: target.targetId }).catch(error => { chromeErrors += '\nTarget cleanup: ' + error.message; }); }
  });
  await check('2.33.0 新增动态模板规则（规划进度、Cookie/预览、扩展包、语音重试、对比度与异常路径提示）正确汉化与还原', async () => {
    let target, cdp;
    try {
      ({ target, cdp } = await openIsolatedPage('/'));
      const html = [
        '<div role="region">',
        '  <ol id="v233-plan" aria-label="Plan, 2 of 5 steps done"></ol>',
        '  <span id="v233-step" data-testid="new-sidecar-summary">Step 2 of 4</span>',
        '  <span id="v233-cookies">12 cookies</span>',
        '  <button id="v233-del-cookie" aria-label="Delete cookies for example.com"></button>',
        '  <button id="v233-add-bundle" aria-label="Add bundle StarterPack"></button>',
        '  <button id="v233-adding-plugins" aria-label="Adding plugins from official-hub"></button>',
        '  <span id="v233-retry-stt">Retrying transcription (attempt 2)\u2026</span>',
        '  <div id="v233-preview-err">The preview did not respond on port 3000.</div>',
        '  <p id="v233-looser">These plugins in StarterPack may have looser code review. Review their contents before adding the bundle.</p>',
        '  <div role="tooltip" id="v233-contrast">Low contrast ratio (2.4:1). Text may be hard to read.</div>',
        '  <button id="v233-filter" aria-label="Filter skills and rules: All"></button>',
        '  <div role="alert" id="v233-file-err">Can\u2019t create this path \u2014 \u201creadme.md\u201d is a file, not a folder.</div>',
        '  <span id="v233-ssh">You\'re signing in on devbox.example. Your sign-in stays on that machine.</span>',
        '  <button id="v233-grants" aria-label="Permissions, 3 grants"></button>',
        '  <div role="alert" id="v233-bad-folders">2 folders in this project could not be loaded because their locations are invalid.</div>',
        '  <button data-testid="tool-group-collapsible"><span id="v233-thinking-label">Thinking</span><span id="v233-elapsed-sec" data-testid="tool-group-elapsed">42s</span><span id="v233-elapsed-min" data-testid="tool-group-elapsed">1m 12s</span><span id="v233-elapsed-hr" data-testid="tool-group-elapsed">1h 2m 3s</span></button>',
        '  <div data-testid="running-row"><span id="v233-running-min">5m</span></div>',
        '  <span id="v233-ago-sec">42s ago</span>',
        '</div>'
      ].join('');
      await cdp.evaluate('document.body.innerHTML=' + JSON.stringify(html));
      const entries = JSON.parse(await readFile(join(root, 'dict/base.json'), 'utf8'));
      const engine = await readFile(join(root, 'dist/engine.js'), 'utf8');
      await cdp.evaluate('globalThis.__GRAVITYBOX_BOOT__=' + JSON.stringify({ origin, path: '/', dictionary: { schema: 1, version: 'v233-templates', entries } }) + ';' + engine);
      await until(async () => (await text(cdp, '#v233-step')) === '第 2 / 4 步');
      assert.equal(await cdp.evaluate('document.querySelector("#v233-plan").getAttribute("aria-label")'), '规划进度：已完成 2 / 5 步');
      assert.equal(await text(cdp, '#v233-cookies'), '12 个 Cookie');
      assert.equal(await cdp.evaluate('document.querySelector("#v233-del-cookie").getAttribute("aria-label")'), '删除 example.com 的 Cookie');
      assert.equal(await cdp.evaluate('document.querySelector("#v233-add-bundle").getAttribute("aria-label")'), '添加扩展包 StarterPack');
      assert.equal(await cdp.evaluate('document.querySelector("#v233-adding-plugins").getAttribute("aria-label")'), '正在从 official-hub 添加插件');
      assert.equal(await text(cdp, '#v233-retry-stt'), '正在重试语音转写（第 2 次尝试）…');
      assert.equal(await text(cdp, '#v233-preview-err'), '端口 3000 上的预览未响应。');
      assert.equal(await text(cdp, '#v233-looser'), 'StarterPack 中的这些插件可能代码审查较宽松。添加扩展包前请先检查其内容。');
      assert.equal(await text(cdp, '#v233-contrast'), '对比度较低（2.4:1），文字可能不易辨认。');
      assert.equal(await cdp.evaluate('document.querySelector("#v233-filter").getAttribute("aria-label")'), '筛选技能与规则：全部');
      assert.equal(await text(cdp, '#v233-file-err'), '无法创建此路径 — “readme.md”是文件，而非文件夹。');
      assert.equal(await text(cdp, '#v233-ssh'), '您正在 devbox.example 上登录。您的登录状态仅保留在该设备上。');
      assert.equal(await cdp.evaluate('document.querySelector("#v233-grants").getAttribute("aria-label")'), '权限，3 项授权');
      assert.equal(await text(cdp, '#v233-bad-folders'), '此项目中有 2 个文件夹因其位置无效而无法加载。');
      assert.equal(await text(cdp, '#v233-thinking-label'), '正在思考...');
      assert.equal(await text(cdp, '#v233-elapsed-sec'), '42秒');
      assert.equal(await text(cdp, '#v233-elapsed-min'), '1分12秒');
      assert.equal(await text(cdp, '#v233-elapsed-hr'), '1小时2分3秒');
      assert.equal(await text(cdp, '#v233-running-min'), '5分');
      assert.equal(await text(cdp, '#v233-ago-sec'), '42秒前');
      await cdp.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.dispose()');
      assert.equal(await text(cdp, '#v233-step'), 'Step 2 of 4');
      assert.equal(await text(cdp, '#v233-elapsed-sec'), '42s');
      assert.equal(await text(cdp, '#v233-elapsed-min'), '1m 12s');
      assert.equal(await cdp.evaluate('document.querySelector("#v233-plan").getAttribute("aria-label")'), 'Plan, 2 of 5 steps done');
    } finally { cdp?.close(); if (target?.targetId) await browserCommand('Target.closeTarget', { targetId: target.targetId }).catch(error => { chromeErrors += '\nTarget cleanup: ' + error.message; }); }
  });
  await check('设置首帧、同词典刷新、热更新和退出动画保持译文，不跨帧回写英文', async () => {
    let target,cdp;
    try {
      ({target,cdp}=await openIsolatedPage('/'));
      const rows=Array.from({length:320},(_,i)=>`<div data-testid="conversation-row-sidebar"><span class="truncate">Private conversation ${i}</span><span>1d</span></div>`).join('');
      const html='<div role="dialog" aria-label="Settings" id="flash-root"><button aria-label="Close">Close</button><aside><h1 id="flash-heading">Settings</h1><button id="flash-general">General</button><button id="flash-app">Application</button><button>Appearance</button><h2>Project list</h2><button id="flash-project">Application</button>'+rows+'</aside><main><h2>General</h2><span id="flash-label">Permission Preset</span><div id="flash-description">Configure agent execution, queued message delivery, and permissions.</div><p id="flash-inline">Type <code>/</code> and select <code>plan</code> to have the agent generate a plan.</p><div data-testid="shortcut-row-artifactStartComment"><span id="flash-shortcut-artifact">Comment on Selection</span></div><div data-testid="artifact-viewer"><span id="flash-real-artifact">Comment on Selection</span></div><input id="flash-input" value="Permission Preset"><div data-gravitybox-user-content id="flash-private">Permission Preset</div></main></div>';
      const entries={Settings:'设置',Close:'关闭',General:'通用',Application:'应用设置','App Settings':'应用设置',Appearance:'外观','Permission Preset':'权限预设','Comment on Selection':'对选中内容添加评论','Configure agent execution, queued message delivery, and permissions.':'配置智能体执行、排队消息发送及权限。','Type {0} and select {1} to have the agent generate a plan.':'输入 {0} 并选择 {1}，让智能体生成规划。'};
      await cdp.evaluate(`document.body.innerHTML='<nav aria-label="Sidebar"><a href="/history">History</a></nav><div id="flash-mount"></div>';globalThis.__FLASH_HTML__=${JSON.stringify(html)};globalThis.__FLASH_DICT__=${JSON.stringify({schema:1,version:'settings-frames-1',entries})}`);
      const engine=await readFile(join(root,'dist/engine.js'),'utf8');
      await cdp.evaluate(`globalThis.__GRAVITYBOX_BOOT__={origin:${JSON.stringify(origin)},path:'/',dictionary:globalThis.__FLASH_DICT__,conservative:true};\n${engine}`);
      await cdp.evaluate(`globalThis.__flashFrames=async(count=6)=>{const frames=[];for(let i=0;i<count;i++){await new Promise(requestAnimationFrame);frames.push(document.querySelector('#flash-heading')?.textContent==='设置'&&document.querySelector('#flash-general')?.textContent==='通用'&&document.querySelector('#flash-app')?.textContent==='应用设置'&&document.querySelector('#flash-label')?.textContent==='权限预设'&&/^(输入|通过)/.test(document.querySelector('#flash-inline')?.textContent??''));}return frames;}`);
      const first=await cdp.evaluate(`(async()=>{document.querySelector('#flash-mount').innerHTML=globalThis.__FLASH_HTML__;setTimeout(()=>history.pushState({},'','/?settingsOpen=true&settingsScreen=General'),35);return await globalThis.__flashFrames();})()`);
      assert.ok(first.every(Boolean),'DOM-first settings mount exposed English at a paint: '+JSON.stringify(first));
      await until(async()=>await cdp.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.state().pending')===0);
      await cdp.evaluate(`globalThis.__flashEnglishWrites=[];globalThis.__flashObserver=new MutationObserver(records=>{for(const r of records)if(r.target.parentElement?.closest('#flash-inline'))for(const value of [r.oldValue,r.target.nodeValue])if(/Type |and select|to have the agent/.test(value??''))globalThis.__flashEnglishWrites.push(value);});globalThis.__flashObserver.observe(document.querySelector('#flash-inline'),{subtree:true,characterData:true,characterDataOldValue:true});`);
      const repeated=await cdp.evaluate(`(async()=>{for(let i=0;i<3;i++)globalThis.__GRAVITYBOX_ENGINE_V1__.update(globalThis.__FLASH_DICT__);return await globalThis.__flashFrames();})()`);
      assert.ok(repeated.every(Boolean),'Same dictionary refresh exposed English');
      assert.deepEqual(await cdp.evaluate('globalThis.__flashEnglishWrites'),[],'Same dictionary must not restore English text slots');
      const updated=await cdp.evaluate(`(async()=>{globalThis.__FLASH_DICT__={...globalThis.__FLASH_DICT__,version:'settings-frames-2',entries:{...globalThis.__FLASH_DICT__.entries,'Type {0} and select {1} to have the agent generate a plan.':'通过 {0} 与 {1} 生成规划。'}};globalThis.__GRAVITYBOX_ENGINE_V1__.update(globalThis.__FLASH_DICT__);return await globalThis.__flashFrames();})()`);
      assert.ok(updated.every(Boolean),'Dictionary hot reload exposed English');
      assert.deepEqual(await cdp.evaluate('globalThis.__flashEnglishWrites'),[],'Hot reload must commit new inline runs directly');
      assert.equal(await text(cdp,'#flash-inline'),'通过 / 与 plan 生成规划。');
      const closing=await cdp.evaluate(`(async()=>{history.pushState({},'','/');globalThis.__GRAVITYBOX_ENGINE_V1__.refresh();return await globalThis.__flashFrames();})()`);
      assert.ok(closing.every(Boolean),'URL-first exit animation restored English before dialog removal');
      assert.equal(await cdp.evaluate('document.querySelector("#flash-input").value'),'Permission Preset');
      assert.equal(await text(cdp,'#flash-private'),'Permission Preset');
      assert.equal(await text(cdp,'.truncate'),'Private conversation 0');
      assert.equal(await text(cdp,'#flash-project'),'Application','A project name matching the new navigation alias remains protected');
      assert.equal(await text(cdp,'#flash-shortcut-artifact'),'对选中内容添加评论','Shortcut row with artifactStartComment commandId must not be blocked by artifact selector');
      assert.equal(await text(cdp,'#flash-real-artifact'),'Comment on Selection','Real artifact viewer container must remain protected');
      assert.equal(await text(cdp,'code'),'/');
      await cdp.evaluate('globalThis.__flashObserver.disconnect();document.querySelector("#flash-mount").replaceChildren();globalThis.__GRAVITYBOX_ENGINE_V1__.refresh()');
      const reopened=await cdp.evaluate(`(async()=>{history.pushState({},'','/?settingsOpen=true&settingsScreen=General');document.querySelector('#flash-mount').innerHTML=globalThis.__FLASH_HTML__;return await globalThis.__flashFrames();})()`);
      assert.ok(reopened.every(Boolean),'Reopened settings reused a detached scope or exposed English');
      await cdp.evaluate("history.pushState({},'', '/?settingsOpen=true&settingsScreen=Unknown');globalThis.__GRAVITYBOX_ENGINE_V1__.refresh()");
      await until(async()=>await text(cdp,'#flash-label')==='Permission Preset');
      const returned=await cdp.evaluate(`(async()=>{history.pushState({},'','/?settingsOpen=true&settingsScreen=General');globalThis.__GRAVITYBOX_ENGINE_V1__.refresh();return await globalThis.__flashFrames();})()`);
      assert.ok(returned.every(Boolean),'Unsupported screen must invalidate the scope and revalidate on return');
      await cdp.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.dispose()');
      assert.equal(await text(cdp,'#flash-inline'),'Type / and select plan to have the agent generate a plan.');
    } finally { cdp?.close();if(target?.targetId)await browserCommand('Target.closeTarget',{targetId:target.targetId}).catch(error => { chromeErrors += '\nTarget cleanup: ' + error.message; }); }
  });
  await check('设置面板 Orchestrator/Executor Model 行不被 data-testid*="model" 误拦截，下拉选择器仍受保护', async () => {
    let target, cdp;
    try {
      ({ target, cdp } = await openIsolatedPage('/?settingsOpen=true&settingsScreen=Models'));
      const html = `
        <nav aria-label="Sidebar"><a href="/history">History</a></nav>
        <div role="dialog" aria-label="Settings">
          <aside>
            <h1>Settings</h1>
            <button>General</button>
            <button>Application</button>
            <button>Models</button>
          </aside>
          <main>
            <h2>Models</h2>
            <h3 id="orch-sec">Orchestrator Settings</h3>
            <div data-testid="orchestrator-model-row">
              <span id="orch-label">Orchestrator Model</span>
              <span id="orch-desc">Plans the work, makes design decisions, and reviews the result. Pick a top-tier model. You can also pick one per conversation from the Orchestrator row in the model menu.</span>
              <button id="orch-trigger" data-testid="model-selector-trigger">Settings</button>
            </div>
            <div data-testid="executor-model-row">
              <span id="exec-label">Executor Model</span>
              <span id="exec-desc">Carries out the plan: searches, edits, builds, and tests. Pick a faster, cheaper model.</span>
              <button id="exec-trigger" aria-haspopup="menu">Settings</button>
            </div>
          </main>
        </div>
        <div data-testid="orchestrator-model-row"><span id="outside-model-row-text">Orchestrator Model</span></div>
        <div role="menu">
          <div role="menuitem"><span>Gemini 4 Carbon</span> <span id="effort-row-suffix">Medium</span></div>
          <div role="menuitem"><span id="effort-low">Low</span></div>
          <div role="menuitem"><span id="effort-medium">Medium</span></div>
          <div role="menuitem"><span id="effort-high">High</span></div>
          <div role="menuitem"><span id="effort-xhigh">Extra High</span></div>
        </div>
      `;
      const baseDict = JSON.parse(await readFile(join(root, 'dict/base.json'), 'utf8'));
      await cdp.evaluate(`document.body.innerHTML=${JSON.stringify(html)}`);
      const engine = await readFile(join(root, 'dist/engine.js'), 'utf8');
      await cdp.evaluate(`globalThis.__GRAVITYBOX_BOOT__=${JSON.stringify({ origin, path: '/', dictionary: { schema: 1, version: 'orch-model-row-1', entries: baseDict }, conservative: true })};\n${engine}`);
      await until(async () => await text(cdp, '#orch-label') === 'Orchestrator 模型');
      assert.equal(await text(cdp, '#orch-sec'), 'Orchestrator 设置');
      assert.equal(await text(cdp, '#orch-desc'), baseDict['Plans the work, makes design decisions, and reviews the result. Pick a top-tier model. You can also pick one per conversation from the Orchestrator row in the model menu.']);
      assert.equal(await text(cdp, '#exec-label'), 'Executor 模型');
      assert.equal(await text(cdp, '#exec-desc'), '负责执行计划：搜索、编辑、构建与测试。建议选择速度更快、成本更低的模型。');
      assert.equal(await text(cdp, '#orch-trigger'), 'Settings');
      assert.equal(await text(cdp, '#exec-trigger'), 'Settings');
      assert.equal(await text(cdp, '#outside-model-row-text'), 'Orchestrator Model');
      assert.equal(await text(cdp, '#effort-row-suffix'), 'Medium');
      assert.equal(await text(cdp, '#effort-low'), 'Low');
      assert.equal(await text(cdp, '#effort-medium'), 'Medium');
      assert.equal(await text(cdp, '#effort-high'), 'High');
      assert.equal(await text(cdp, '#effort-xhigh'), 'Extra High');
    } finally {
      cdp?.close();
      if (target?.targetId) await browserCommand('Target.closeTarget', { targetId: target.targetId }).catch(error => { chromeErrors += '\nTarget cleanup: ' + error.message; });
    }
  });
  await check('HUD 独立挂载不覆盖输入区、窄屏单行、向上弹出及输入框零焦点争夺', async () => {
    await main.send('Page.bringToFront');
    await main.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    try {
    const tree = await main.send('Page.getFrameTree');
    const ctx = await main.send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'GRAVITYBOX-localization-v1' });
    await main.evaluate(`(() => {
      const convView = document.createElement('div');
      convView.id = 'hud-e2e-fixture';
      convView.setAttribute('data-testid', 'conversation-view');
      convView.setAttribute('data-cascade-id', 'cascade-e2e');
      convView.setAttribute('data-conversation-id', '4ec6348d-0f58-49db-8aed-6f67dbb78f5d');
      convView.style.cssText = 'position:relative;display:flex;flex-direction:column;width:640px;margin:20px auto;';
      convView.innerHTML = '<div id="hud-e2e-msg-wrap" style="position:relative;height:180px;"><button id="hud-e2e-scroll-btn" type="button" aria-label="滚动到底部" style="position:absolute;left:180px;bottom:24px;width:40px;height:40px;z-index:20;border-radius:20px;">↓</button><button id="hud-e2e-stop-prop-btn" type="button" style="position:absolute;right:10px;top:10px;">Outside</button></div><div style="position:relative;z-index:10;display:flex;flex-direction:column;width:100%;"><div data-testid="agent-input-box" id="hud-e2e-box" style="display:flex;flex-direction:column;width:100%;"><div class="surface-composer" id="hud-e2e-composer" style="height:82px;border-radius:21px;"><div id="hud-e2e-editor" contenteditable="true" aria-label="Message input">Draft text</div><button data-testid="model-selector-trigger" data-model-id="gemini-4-argon">Gemini 4 Argon</button></div></div></div>';
      document.body.appendChild(convView);
      document.querySelector('#hud-e2e-stop-prop-btn').addEventListener('pointerdown', (e) => e.stopPropagation());
    })()`);
    await main.evaluate('globalThis.__GRAVITYBOX_HUD_V1__?.reconcileMounts()', ctx.executionContextId);
    await until(async () => await main.evaluate('!!document.querySelector("#__gravitybox_hud_host__")'));

    // 1. 验证 HUD 紧随输入框并占据独立空间，避免覆盖输入区域。
    const layoutInfo = await main.evaluate(`(() => {
      const composer = document.querySelector('#hud-e2e-composer');
      const host = document.querySelector('#__gravitybox_hud_host__');
      const cRect = composer.getBoundingClientRect();
      const hRect = host.getBoundingClientRect();
      return {
        isSiblingAfter: composer.nextElementSibling === host,
        gapTop: Math.round(hRect.top - cRect.bottom),
        hostHeight: Math.round(hRect.height),
        elevation: Math.round(hRect.bottom - cRect.bottom),
        protectedAttr: host.getAttribute('data-gravitybox-protect')
      };
    })()`);
    assert.equal(layoutInfo.isSiblingAfter, true);
    assert.ok(layoutInfo.gapTop >= 0);
    assert.ok(layoutInfo.hostHeight > 0);
    assert.ok(layoutInfo.elevation >= layoutInfo.hostHeight);
    assert.equal(layoutInfo.protectedAttr, 'true');

    // 2. 注入实测基准指标并验证 3 胶囊与向上展开 Popover
    await until(async () => {
      await main.evaluate(`(() => {
        const inst = [...globalThis.__GRAVITYBOX_HUD_V1__.manager.instances.values()][0];
        return globalThis.__gravityboxUpdateHudMetrics({
        conversationId: '4ec6348d-0f58-49db-8aed-6f67dbb78f5d',
        sessionRevision: inst.getSessionRevision(),
        metricsSequence: Math.max(Date.now() + 10_000_000, (inst.lastMetricsSequence || 0) + 1),
        updatedAt: Date.now(),
        isStreaming: false,
        session: {
          turns: 1,
          steps: 142,
          modelDurationSeconds: 3959.126,
          modelDurationFormatted: '1小时5分59秒',
          modelDurationFormattedEn: '1h5m59s',
          toolDurationSeconds: 751,
          toolDurationFormatted: '12分31秒',
          toolDurationFormattedEn: '12m31s',
          averageTtftSeconds: 19.7,
          averageTtftFormatted: '19.7 秒',
          averageTtftFormattedEn: '19.7s',
          outputTps: 90.126,
          outputTpsFormatted: '90.13 tok/s',
          latestStepOutputTps: 107.142,
          latestStepOutputTpsFormatted: '107.14 tok/s',
          latestStepTtftSeconds: 2.345,
          latestStepTtftFormatted: '2.35 秒',
          latestStepTtftFormattedEn: '2.35s',
          currentTurnOutputTps: 98.456,
          currentTurnOutputTpsFormatted: '98.46 tok/s',
          currentTurnTimedSamples: 3,
          currentTurnDurationSeconds: 18.4,
          currentTurnDurationFormatted: '18秒',
          currentTurnDurationFormattedEn: '18s',
          currentTurnDurationCompactZh: '本轮 18s',
          currentTurnDurationCompactEn: 'Turn 18s',
          currentTurnModelDurationSeconds: 14.2,
          currentTurnToolDurationSeconds: 4.2
        },
        tokens: {
          totalTokens: 58593793,
          totalTokensCompact: '58.6M tok',
          totalTokensFormatted: '58,593,793 tok',
          cacheHitRate: 0.9665,
          cacheHitRateFormatted: '97%',
          uncachedInputTokens: 1961501,
          uncachedInputFormatted: '1,961,501 tok',
          cachedReadTokens: 56526799,
          cachedReadFormatted: '56,526,799 tok',
          outputTokens: 105493,
          outputFormatted: '105,493 tok',
          estimatedCostUsd: 0.184,
          estimatedCostFormatted: '~$0.18',
          cacheSavedUsd: 1.024,
          cacheSavedFormatted: '~$1.02'
        },
        context: {
          modelId: 'gemini-4-argon',
          modelDisplayName: 'Gemini 4 Argon',
          usedTokens: 672000,
          usedTokensCompact: '~672K',
          capacityTokens: 1048576,
          capacityTokensCompact: '1M',
          usedRatio: 0.6408,
          usedRatioFormatted: '64%',
          breakdown: {
            systemTokens: 1900,
            systemTokensCompact: '~1.9K',
            systemRatio: 0.181,
            toolTokens: 7600,
            toolTokensCompact: '~7.6K',
            toolRatio: 0.725,
            messageTokens: 662500,
            messageTokensCompact: '~662K',
            messageRatio: 63.181
          }
        }
      }); })()`, ctx.executionContextId);
      const txt = await main.evaluate(`document.querySelector('#__gravitybox_hud_host__')?.shadowRoot?.querySelector('#hud-txt-session')?.textContent.replace(/\\s+/g, ' ').trim()`);
      return txt === '1 轮 · 本轮 18s · 90 tok/s';
    });

    const rendered = await main.evaluate(`(() => {
      const sr = document.querySelector('#__gravitybox_hud_host__').shadowRoot;
      const caps = [...sr.querySelectorAll('.capsule')];
      return {
        c1: sr.querySelector('#hud-txt-session').textContent.replace(/\\s+/g, ' ').trim(),
        c2: sr.querySelector('#hud-txt-tokens').textContent.replace(/\\s+/g, ' ').trim(),
        c3: sr.querySelector('#hud-txt-context').textContent.trim(),
        sameRow: caps.every(c => c.offsetTop === caps[0].offsetTop),
      };
    })()`);
    assert.equal(rendered.c1, '1 轮 · 本轮 18s · 90 tok/s');
    assert.equal(rendered.c2, '58.6M tok · 缓存命中 97%');
    assert.equal(rendered.c3, '64%');
    assert.equal(rendered.sameRow, true);
    const precision = await main.evaluate(`(() => {
      const sr = document.querySelector('#__gravitybox_hud_host__').shadowRoot;
      return {
        speed: sr.querySelector('#val-tps').textContent,
        latestTtft: sr.querySelector('#val-ttft-latest').textContent,
        latestSpeed: sr.querySelector('#val-tps-latest').textContent,
        hasDashedDivider: Boolean(sr.querySelector('#hud-popover-session .hud-popover-divider-dashed')),
        hasTokensDashedDivider: Boolean(sr.querySelector('#hud-popover-tokens .hud-popover-divider-dashed')),
        turnDuration: sr.querySelector('#val-turn-dur').textContent,
        duration: sr.querySelector('#val-model-dur').textContent,
        toolDuration: sr.querySelector('#val-tool-dur').textContent,
        ttft: sr.querySelector('#val-ttft').textContent,
        cache: sr.querySelector('#val-cache-hit').textContent,
        tokensBadge: sr.querySelector('#pop-tokens-badge').textContent,
        cachedRead: sr.querySelector('#val-cached-read').textContent,
        outputTok: sr.querySelector('#val-output-tok').textContent,
        estCost: sr.querySelector('#val-est-cost').textContent,
        cacheSaved: sr.querySelector('#val-cache-saved').textContent,
        context: sr.querySelector('#pop-ctx-pct').textContent,
        ctxCapacity: sr.querySelector('#pop-ctx-capacity').textContent,
        segMsgExists: Boolean(sr.querySelector('#seg-msg')),
        lblSegSysHasDot: Boolean(sr.querySelector('#lbl-seg-sys')?.closest('.hud-popover-label')?.querySelector('.hud-legend-dot')),
        lblSegToolHasDot: Boolean(sr.querySelector('#lbl-seg-tool')?.closest('.hud-popover-label')?.querySelector('.hud-legend-dot')),
        lblSegMsgHasDot: Boolean(sr.querySelector('#lbl-seg-msg')?.closest('.hud-popover-label')?.querySelector('.hud-legend-dot')),
      };
    })()`);
    assert.equal(precision.speed, '90.1 tok/s');
    assert.equal(precision.latestTtft, '2.35 秒');
    assert.equal(precision.latestSpeed, '107 tok/s');
    assert.equal(precision.segMsgExists, true);
    assert.equal(precision.lblSegSysHasDot, true);
    assert.equal(precision.lblSegToolHasDot, true);
    assert.equal(precision.lblSegMsgHasDot, false, '#lbl-seg-msg 旁不得显示误导性绿色圆点');
    assert.equal(precision.hasDashedDivider, true);
    assert.equal(precision.hasTokensDashedDivider, true);
    assert.equal(precision.turnDuration, '18秒');
    assert.equal(precision.duration, '1小时5分59秒');
    assert.equal(precision.toolDuration, '12分31秒');
    assert.equal(precision.ttft, '19.7 秒');
    assert.equal(precision.cache, '96.7%');
    assert.equal(precision.tokensBadge, '58.6M tok');
    assert.equal(precision.cachedRead, '56.5M tok');
    assert.equal(precision.outputTok, '105K tok');
    assert.equal(precision.estCost, '~$0.18');
    assert.equal(precision.cacheSaved, '~$1.02');
    assert.equal(precision.context, '64.1%');
    assert.equal(precision.ctxCapacity, '672K / 1.05M');

    // 3. 验证输入框焦点零争夺与向上展开 Popover
    const focusAndPopover = await main.evaluate(`(() => {
      const editor = document.querySelector('#hud-e2e-editor');
      editor.focus();
      const host = document.querySelector('#__gravitybox_hud_host__');
      const sr = host.shadowRoot;
      const cap1 = sr.querySelector('.capsule-session');
      const capDot = cap1.querySelector('.hud-status-dot');
      const idleCollapsedDotColor = getComputedStyle(capDot).backgroundColor;
      const mdEvt = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
      cap1.dispatchEvent(mdEvt);
      cap1.click();
      const pop1 = sr.querySelector('#hud-popover-session');
      const popDot = pop1.querySelector('.hud-status-dot');
      const idleActiveDotColor = getComputedStyle(capDot).backgroundColor;
      const idlePopoverDotColor = getComputedStyle(popDot).backgroundColor;
      const popRect = pop1.getBoundingClientRect();
      const capRect = cap1.getBoundingClientRect();
      const scrollBtn = document.querySelector('#hud-e2e-scroll-btn');
      const btnRect = scrollBtn.getBoundingClientRect();
      const overlapX = Math.max(popRect.left + 4, Math.min(popRect.right - 4, btnRect.left + btnRect.width / 2));
      const overlapY = Math.max(popRect.top + 4, Math.min(popRect.bottom - 4, btnRect.top + btnRect.height / 2));
      const topHit = document.elementFromPoint(overlapX, overlapY);
      return {
        defaultPrevented: mdEvt.defaultPrevented,
        editorStillFocused: document.activeElement === editor,
        popoverVisible: !pop1.hasAttribute('hidden'),
        isUpward: popRect.bottom <= capRect.top,
        outerOverflow: getComputedStyle(pop1).overflow,
        topLayerAboveZ20Button: topHit === host,
        idleCollapsedDotColor,
        idleActiveDotColor,
        idlePopoverDotColor
      };
    })()`);
    assert.equal(focusAndPopover.defaultPrevented, true, 'mousedown 必须阻止默认行为以防输入框失焦');
    assert.equal(focusAndPopover.editorStillFocused, true, '点击胶囊后输入框必须保持焦点');
    assert.equal(focusAndPopover.popoverVisible, true);
    assert.equal(focusAndPopover.isUpward, true, 'Popover 必须向上展开');
    assert.equal(focusAndPopover.outerOverflow, 'visible', 'Popover 外层必须为 overflow:visible 防止裁切底部小三角');
    assert.equal(focusAndPopover.topLayerAboveZ20Button, true, 'Popover 必须通过 Top Layer 位于 z-index:20 回到底部悬浮按钮之上，绝不被遮挡');
    assert.equal(focusAndPopover.idleActiveDotColor, focusAndPopover.idleCollapsedDotColor, '空闲时点击展开卡片小圆点必须保持灰色不变蓝');
    assert.equal(focusAndPopover.idlePopoverDotColor, focusAndPopover.idleCollapsedDotColor, '空闲时展开卡片内标题圆点也必须保持灰色');

    // 3a. 验证三态圆点：模型思考/输出常亮蓝色 -> 脚本执行蓝色呼吸 -> 两者停止灰色
    await main.evaluate(`(() => {
      const box = document.querySelector('#hud-e2e-composer');
      const cancelBtn = document.createElement('button');
      cancelBtn.id = 'hud-e2e-cancel-btn';
      cancelBtn.setAttribute('data-testid', 'input-cancel-button');
      cancelBtn.setAttribute('aria-label', 'Cancel (⌃C)');
      box.appendChild(cancelBtn);
    })()`);
    await until(async () => await main.evaluate(`(() => {
      const sr = document.querySelector('#__gravitybox_hud_host__').shadowRoot;
      return sr.querySelector('.capsule-session').classList.contains('is-generating') &&
        getComputedStyle(sr.querySelector('.capsule-session .hud-status-dot')).backgroundColor === 'rgb(49, 134, 255)';
    })()`));
    const generatingDotState = await main.evaluate(`(() => {
      const sr = document.querySelector('#__gravitybox_hud_host__').shadowRoot;
      const capStyle = getComputedStyle(sr.querySelector('.capsule-session .hud-status-dot'));
      const popStyle = getComputedStyle(sr.querySelector('#hud-popover-session .hud-status-dot'));
      return {
        capDot: capStyle.backgroundColor,
        popDot: popStyle.backgroundColor,
        capAnim: capStyle.animationName,
        popAnim: popStyle.animationName,
      };
    })()`);
    assert.equal(generatingDotState.capDot, 'rgb(49, 134, 255)', '模型思考/输出时胶囊圆点必须显示常亮蓝色');
    assert.equal(generatingDotState.popDot, 'rgb(49, 134, 255)', '模型思考/输出时展开卡片圆点同步为常亮蓝色');
    assert.equal(generatingDotState.capAnim, 'none', '模型本身思考/输出时圆点保持常亮不呼吸');
    assert.equal(generatingDotState.popAnim, 'none', '展开卡片圆点在模型思考/输出时保持常亮不呼吸');

    await main.evaluate(`(() => {
      const wrap = document.querySelector('#hud-e2e-msg-wrap');
      const scriptIndicator = document.createElement('span');
      scriptIndicator.id = 'hud-e2e-script-running';
      scriptIndicator.className = 'animate-shimmer-text';
      scriptIndicator.textContent = 'Running npm test';
      wrap.appendChild(scriptIndicator);
    })()`);
    try {
      await until(async () => await main.evaluate(`(() => {
        const sr = document.querySelector('#__gravitybox_hud_host__').shadowRoot;
        return sr.querySelector('.capsule-session').classList.contains('is-executing') &&
          getComputedStyle(sr.querySelector('.capsule-session .hud-status-dot')).animationName === 'hud-breathe-dot';
      })()`));
    } catch (error) {
      const diag = await main.evaluate(`(() => {
        const sr = document.querySelector('#__gravitybox_hud_host__')?.shadowRoot;
        const cap = sr?.querySelector('.capsule-session');
        const dot = cap?.querySelector('.hud-status-dot');
        return {
          className: cap?.className || null,
          dotAnim: dot ? getComputedStyle(dot).animationName : null,
          dotBg: dot ? getComputedStyle(dot).backgroundColor : null,
          reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
          hidden: document.hidden,
        };
      })()`).catch(() => null);
      throw new Error(`${error.message} [diag=${JSON.stringify(diag)}]`);
    }
    const executingDotState = await main.evaluate(`(() => {
      const sr = document.querySelector('#__gravitybox_hud_host__').shadowRoot;
      const capStyle = getComputedStyle(sr.querySelector('.capsule-session .hud-status-dot'));
      const popStyle = getComputedStyle(sr.querySelector('#hud-popover-session .hud-status-dot'));
      return {
        capAnim: capStyle.animationName,
        popAnim: popStyle.animationName,
      };
    })()`);
    assert.equal(executingDotState.capAnim, 'hud-breathe-dot', '模型暂停且脚本执行时胶囊圆点必须呈蓝色呼吸');
    assert.equal(executingDotState.popAnim, 'hud-breathe-dot', '模型暂停且脚本执行时展开卡片圆点同步呈蓝色呼吸');

    // 移除 Cancel 按钮后即使工具 shimmer 与 .codicon-loading 仍存在，小圆点也必须立即回到灰色静止
    await main.evaluate(`(() => {
      document.querySelector('#hud-e2e-cancel-btn').remove();
      const wrap = document.querySelector('#hud-e2e-msg-wrap');
      const codicon = document.createElement('span');
      codicon.id = 'hud-e2e-stale-codicon';
      codicon.className = 'codicon-loading';
      wrap.appendChild(codicon);
    })()`);
    await until(async () => await main.evaluate(`(() => {
      const sr = document.querySelector('#__gravitybox_hud_host__').shadowRoot;
      return !sr.querySelector('.capsule-session').classList.contains('is-streaming') &&
        getComputedStyle(sr.querySelector('.capsule-session .hud-status-dot')).animationName === 'none' &&
        getComputedStyle(sr.querySelector('.capsule-session .hud-status-dot')).backgroundColor === 'rgb(113, 113, 122)';
    })()`));
    await main.evaluate(`(() => {
      document.querySelector('#hud-e2e-script-running')?.remove();
      document.querySelector('#hud-e2e-stale-codicon')?.remove();
    })()`);

    // 3b. 验证外部控件 stopPropagation() 的 pointerdown 仍能经捕获阶段自动关闭已固定 Popover
    const dismissedByStopPropOutside = await main.evaluate(`(() => {
      const outsideBtn = document.querySelector('#hud-e2e-stop-prop-btn');
      outsideBtn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }));
      const pop1 = document.querySelector('#__gravitybox_hud_host__').shadowRoot.querySelector('#hud-popover-session');
      return pop1.hasAttribute('hidden');
    })()`);
    assert.equal(dismissedByStopPropOutside, true, '外部调用 stopPropagation 的 pointerdown 仍须在捕获阶段关闭 Popover');

    // 4. 验证 < 360px 窄屏分栏自动切换 .is-ultra-compact 且保持单行
    await main.evaluate(`document.querySelector('#hud-e2e-fixture').style.width = '340px'`);
    await until(async () => await main.evaluate(`document.querySelector('#__gravitybox_hud_host__').shadowRoot.querySelector('.hud-container').classList.contains('is-ultra-compact')`));
    const ultraCompactInfo = await main.evaluate(`(() => {
      const sr = document.querySelector('#__gravitybox_hud_host__').shadowRoot;
      const caps = [...sr.querySelectorAll('.capsule')];
      return {
        turnsDisplay: getComputedStyle(sr.querySelector('.hud-turns')).display,
        turnDotDisplay: getComputedStyle(sr.querySelector('.hud-turn-dot')).display,
        speedDisplay: getComputedStyle(sr.querySelector('.hud-speed')).display,
        cacheDisplay: getComputedStyle(sr.querySelector('.hud-tok-cache')).display,
        sameRow: caps.every(c => c.offsetTop === caps[0].offsetTop)
      };
    })()`);
    assert.equal(ultraCompactInfo.turnsDisplay, 'none');
    assert.equal(ultraCompactInfo.turnDotDisplay, 'none');
    assert.equal(ultraCompactInfo.speedDisplay, 'none');
    assert.equal(ultraCompactInfo.cacheDisplay, 'none');
    assert.equal(ultraCompactInfo.sameRow, true);

    // 5. 验证单色渐深蓝进度条与 1 实心品牌蓝 / 2 实心琥珀 / 3+ 实心正红压缩徽章渲染（含深/浅色统一纯白数字）
    const pushTier = async (compactionCount, usedRatio) => {
      await main.evaluate(`(() => {
        const mgr = globalThis.__GRAVITYBOX_HUD_V1__?.manager;
        const inst = mgr ? [...mgr.instances.values()][0] : null;
        if (!inst || !inst.lastMetrics) return;
        mgr.dispatchMetrics({
          ...inst.lastMetrics,
          conversationId: inst.getCurrentConvId(),
          sessionRevision: inst.getSessionRevision(),
          metricsSequence: Math.max(Date.now() + 10_000_000, (inst.lastMetricsSequence || 0) + 1),
          updatedAt: Date.now(),
          availability: 'ready',
          session: { ...inst.lastMetrics.session, compactionCount: ${compactionCount} },
          context: {
            ...inst.lastMetrics.context,
            hasUsageData: true,
            usedTokens: Math.round(${usedRatio} * 1000000),
            usedRatio: ${usedRatio},
            isFallbackCapacity: false,
          },
        });
      })()`, ctx.executionContextId);
      return await main.evaluate(`(() => {
        const sr = document.querySelector('#__gravitybox_hud_host__').shadowRoot;
        const badge = sr.querySelector('#hud-compaction-badge');
        const fill = sr.querySelector('#hud-meter-fill');
        const bStyle = getComputedStyle(badge);
        return {
          hidden: badge.hasAttribute('hidden'),
          tier: badge.getAttribute('data-compaction-tier'),
          bgImage: bStyle.backgroundImage,
          bgColor: bStyle.backgroundColor,
          fgColor: bStyle.color,
          meterFill: fill.getAttribute('fill'),
        };
      })()`);
    };

    const tier1 = await pushTier(1, 0.15);
    const tier2 = await pushTier(2, 0.55);
    const tier3 = await pushTier(3, 0.92);
    assert.equal(tier1.hidden, false);
    assert.equal(tier1.tier, 'low');
    assert.equal(tier1.bgImage, 'none');
    assert.equal(tier1.bgColor, 'rgb(49, 134, 255)', '浅色模式下 1 次压缩徽章蓝色必须与会话统计小蓝点一致');
    assert.equal(tier1.fgColor, 'rgb(255, 255, 255)', '浅色模式下 1 次压缩徽章数字必须为纯白');
    assert.equal(tier2.tier, 'warn');
    assert.ok(tier2.bgImage.includes('linear-gradient'), '2 次压缩应使用实心琥珀渐变');
    assert.equal(tier2.fgColor, 'rgb(255, 255, 255)', '浅色模式下 2 次压缩徽章数字必须为纯白');
    assert.equal(tier3.tier, 'danger');
    assert.ok(tier3.bgImage.includes('linear-gradient'), '3+ 次压缩应使用实心正红渐变');
    assert.equal(tier3.fgColor, 'rgb(255, 255, 255)', '浅色模式下 3+ 次压缩徽章数字必须为纯白');
    assert.notEqual(tier2.bgImage, tier3.bgImage, '2 次琥珀与 3+ 次正红渐变样式必须清晰区分');
    assert.notEqual(tier1.meterFill, tier3.meterFill, '进度条颜色应随占比加深');
    assert.match(tier3.meterFill, /^rgb\(/, '92% 仍保持单色渐深蓝 rgb() 而非跳变红/黄');
    const [rLow] = tier1.meterFill.match(/\d+/g).map(Number);
    const [rHigh, , bHigh] = tier3.meterFill.match(/\d+/g).map(Number);
    assert.ok(rLow > rHigh && bHigh > rHigh, '92% 时蓝色分量占优且比 15% 更深沉');

    await main.evaluate(`(() => {
      document.documentElement.setAttribute('data-theme', 'dark');
      document.querySelector('#__gravitybox_hud_host__')?.setAttribute('data-theme', 'dark');
    })()`);
    try {
      await pushTier(1, 0.15);
      await until(async () => {
        const cur = await main.evaluate(`(() => {
          const sr = document.querySelector('#__gravitybox_hud_host__').shadowRoot;
          const bStyle = getComputedStyle(sr.querySelector('#hud-compaction-badge'));
          return { bgColor: bStyle.backgroundColor, fgColor: bStyle.color };
        })()`);
        return cur.bgColor === 'rgb(88, 155, 255)' && cur.fgColor === 'rgb(255, 255, 255)';
      }, 2000, 'dark tier 1 badge transition');
      await pushTier(2, 0.55);
      await until(async () => {
        const cur = await main.evaluate(`(() => {
          const sr = document.querySelector('#__gravitybox_hud_host__').shadowRoot;
          const bStyle = getComputedStyle(sr.querySelector('#hud-compaction-badge'));
          return { bgImage: bStyle.backgroundImage, fgColor: bStyle.color };
        })()`);
        return cur.bgImage.includes('linear-gradient') && cur.fgColor === 'rgb(255, 255, 255)';
      }, 2000, 'dark tier 2 badge transition');
      await pushTier(3, 0.92);
      await until(async () => {
        const cur = await main.evaluate(`(() => {
          const sr = document.querySelector('#__gravitybox_hud_host__').shadowRoot;
          const bStyle = getComputedStyle(sr.querySelector('#hud-compaction-badge'));
          return { bgImage: bStyle.backgroundImage, fgColor: bStyle.color };
        })()`);
        return cur.bgImage.includes('linear-gradient') && cur.fgColor === 'rgb(255, 255, 255)';
      }, 2000, 'dark tier 3 badge transition');
    } finally {
      await main.evaluate(`(() => {
        document.documentElement.removeAttribute('data-theme');
        document.querySelector('#__gravitybox_hud_host__')?.removeAttribute('data-theme');
      })()`).catch(() => {});
    }

    // 6. 恢复 640px 宽分栏并验证 Orchestrator 双模型常驻短标、紧凑 7px 留白与真实 DOM 阶段对照渲染
    await main.evaluate(`document.querySelector('#hud-e2e-fixture').style.width = '640px'`);
    await until(async () => await main.evaluate(`!document.querySelector('#__gravitybox_hud_host__').shadowRoot.querySelector('.hud-container').classList.contains('is-ultra-compact')`));
    await main.evaluate(`(() => {
      const mgr = globalThis.__GRAVITYBOX_HUD_V1__?.manager;
      const inst = mgr ? [...mgr.instances.values()][0] : null;
      if (!inst) return;
      mgr.dispatchMetrics({
        conversationId: inst.getCurrentConvId(),
        sessionRevision: inst.getSessionRevision(),
        metricsSequence: Math.max(Date.now() + 10_000_000, (inst.lastMetricsSequence || 0) + 1),
        updatedAt: Date.now(),
        availability: 'ready',
        isStreaming: false,
        session: { turns: 3, steps: 20, compactionCount: 0, modelDurationSeconds: 10, toolDurationSeconds: 5, averageTtftSeconds: 1.2, outputTps: 80, outputTpsFormatted: '80 tok/s', currentTurnDurationSeconds: 5, currentTurnDurationCompactZh: '本轮 5s' },
        tokens: { totalTokens: 1000000, totalTokensCompact: '1M tok', cacheHitRate: 0.9, cacheHitRateFormatted: '90%' },
        context: {
          hasUsageData: true,
          modelId: 'gemini-4-hydrogen',
          modelDisplayName: 'Gemini 4 Hydrogen (Orchestrator)',
          modelShortLabel: 'Hydrogen',
          modelCompactLabel: 'H',
          isMultiModel: true,
          isOrchestrator: true,
          usedTokens: 468000,
          usedTokensCompact: '468K',
          peakContextTokens: 468000,
          capacityTokens: 512000,
          capacityTokensCompact: '512K',
          isFallbackCapacity: false,
          usedRatio: 468000 / 512000,
          usedRatioFormatted: '91.4%',
          breakdown: { cachedContextTokens: 465000, cachedContextRatio: 90.8, uncachedContextTokens: 3000, uncachedContextRatio: 0.6, latestOutputTokens: 3730 },
          modelStages: [
            { slotKey: 'orchestrator:carbon', role: 'planner', modelId: 'gemini-4-carbon', modelDisplayName: 'Orchestrator (Carbon)', shortLabel: 'Carbon', compactLabel: 'C', hasUsageData: true, isActive: false, usedTokens: 462000, peakContextTokens: 462000, capacityTokens: 512000, isFallbackCapacity: false, usedRatio: 462000 / 512000, usedRatioFormatted: '90.2%' },
            { slotKey: 'orchestrator:hydrogen', role: 'executor', modelId: 'gemini-4-hydrogen', modelDisplayName: 'Gemini 4 Hydrogen (Orchestrator)', shortLabel: 'Hydrogen', compactLabel: 'H', hasUsageData: true, isActive: true, usedTokens: 468000, peakContextTokens: 468000, capacityTokens: 512000, isFallbackCapacity: false, usedRatio: 468000 / 512000, usedRatioFormatted: '91.4%' }
          ]
        }
      });
    })()`, ctx.executionContextId);
    const dualBrowserCheck = await main.evaluate(`(() => {
      const sr = document.querySelector('#__gravitybox_hud_host__').shadowRoot;
      const capCtx = sr.querySelector('.capsule-context');
      const caps = [...sr.querySelectorAll('.capsule')];
      const cs = getComputedStyle(capCtx);
      const stageItems = [...sr.querySelectorAll('#hud-ctx-stages-list .hud-stage-item')];
      return {
        sameRow: caps.every(c => c.offsetTop === caps[0].offsetTop),
        paddingLeft: cs.paddingLeft,
        paddingRight: cs.paddingRight,
        tagVisible: !sr.querySelector('#hud-ctx-model-tag').hasAttribute('hidden'),
        fullDisplay: getComputedStyle(sr.querySelector('#hud-ctx-model-full')).display,
        shortDisplay: getComputedStyle(sr.querySelector('#hud-ctx-model-short')).display,
        fullTag: sr.querySelector('#hud-ctx-model-full').textContent.trim(),
        ctxPct: sr.querySelector('#hud-txt-context').textContent.trim(),
        popPrefix: sr.querySelector('#pop-ctx-prefix').textContent,
        popRole: sr.querySelector('#pop-ctx-role')?.textContent,
        popRoleVisible: !sr.querySelector('#pop-ctx-role')?.hasAttribute('hidden'),
        stagesTitle: sr.querySelector('#lbl-ctx-stages')?.textContent,
        stageCount: stageItems.length,
        stageTexts: stageItems.map(el => el.textContent.replace(/\\s+/g, ' ').trim()),
      };
    })()`);
    assert.equal(dualBrowserCheck.sameRow, true, '双模型短标加入后三胶囊仍应严格保持同一行');
    assert.equal(dualBrowserCheck.paddingLeft, '7px');
    assert.equal(dualBrowserCheck.paddingRight, '7px');
    assert.equal(dualBrowserCheck.tagVisible, true);
    assert.notEqual(dualBrowserCheck.fullDisplay, 'none');
    assert.equal(dualBrowserCheck.shortDisplay, 'none');
    assert.equal(dualBrowserCheck.fullTag, 'Hydrogen');
    assert.equal(dualBrowserCheck.ctxPct, '91%');
    assert.equal(dualBrowserCheck.popPrefix, '当前上下文 · Hydrogen ');
    assert.equal(dualBrowserCheck.popRoleVisible, true);
    assert.equal(dualBrowserCheck.popRole, '执行');
    assert.equal(dualBrowserCheck.stagesTitle, '曾用模型上下文');
    assert.equal(dualBrowserCheck.stageCount, 1, 'Option A 底部列表仅保留非活跃模型');
    assert.match(dualBrowserCheck.stageTexts[0], /Carbon\s*规划.*90\.2% · 462K \/ 512K/);

    // 6b. 344px 上下文卡片真实布局校验：验证顶部单行防折行（标题与容量徽章同一行）、微胶囊角色标、统一“曾用模型上下文”单列表与长模型名下压缩徽章防裁切
    const checkLongStageLayout = async ({ activeDisplayName, activeShortLabel, activeCompactLabel = 'H', activeRole = 'executor', nonActiveDisplayName }) => {
      await main.evaluate(`(() => {
        const mgr = globalThis.__GRAVITYBOX_HUD_V1__?.manager;
        const inst = mgr ? [...mgr.instances.values()][0] : null;
        if (!inst) return;
        mgr.dispatchMetrics({
          conversationId: inst.getCurrentConvId(),
          sessionRevision: inst.getSessionRevision(),
          metricsSequence: Math.max(Date.now() + 10_000_000, (inst.lastMetricsSequence || 0) + 1),
          updatedAt: Date.now(),
          availability: 'ready',
          isStreaming: false,
          session: { turns: 4, steps: 22, compactionCount: 0, modelDurationSeconds: 10, toolDurationSeconds: 5, averageTtftSeconds: 1.2, outputTps: 80, outputTpsFormatted: '80 tok/s', currentTurnDurationSeconds: 5, currentTurnDurationCompactZh: '本轮 5s' },
          tokens: { totalTokens: 1200000, totalTokensCompact: '1.2M tok', cacheHitRate: 0.9, cacheHitRateFormatted: '90%' },
          context: {
            hasUsageData: true,
            modelId: 'gemini-4-carbon',
            modelDisplayName: ${JSON.stringify(activeDisplayName)},
            modelShortLabel: ${JSON.stringify(activeShortLabel)},
            modelCompactLabel: ${JSON.stringify(activeCompactLabel)},
            isMultiModel: true,
            isOrchestrator: true,
            usedTokens: 256000,
            usedTokensCompact: '256K',
            peakContextTokens: 256000,
            capacityTokens: 512000,
            capacityTokensCompact: '512K',
            isFallbackCapacity: false,
            usedRatio: 0.5,
            usedRatioFormatted: '50%',
            breakdown: { cachedContextTokens: 250000, cachedContextRatio: 48.8, uncachedContextTokens: 6000, uncachedContextRatio: 1.2, latestOutputTokens: 1200 },
            modelStages: [
              { slotKey: 'orchestrator:carbon', role: ${JSON.stringify(activeRole)}, section: 'primary', modelId: 'gemini-4-carbon', modelDisplayName: ${JSON.stringify(activeDisplayName)}, shortLabel: ${JSON.stringify(activeShortLabel)}, compactLabel: ${JSON.stringify(activeCompactLabel)}, hasUsageData: true, isActive: true, usedTokens: 256000, peakContextTokens: 256000, capacityTokens: 512000, isFallbackCapacity: false, usedRatio: 0.5, usedRatioFormatted: '50%' },
              { slotKey: 'orchestrator:executor_pending', role: 'executor', section: 'primary', modelId: 'pending', modelDisplayName: '', shortLabel: '', compactLabel: '', hasUsageData: false, isActive: false, usedTokens: 0, peakContextTokens: 0, capacityTokens: 512000, isFallbackCapacity: false, usedRatio: 0, usedRatioFormatted: '0%' },
              { slotKey: 'model:gemini-4-hydrogen', role: 'executor', section: 'primary', modelId: 'gemini-4-hydrogen', modelDisplayName: ${JSON.stringify(nonActiveDisplayName)}, shortLabel: ${JSON.stringify(nonActiveDisplayName)}, compactLabel: 'H', hasUsageData: true, isActive: false, compactionCount: 2, usedTokens: 468000, peakContextTokens: 468000, capacityTokens: 512000, isFallbackCapacity: false, usedRatio: 468000 / 512000, usedRatioFormatted: '91.4%' }
            ]
          }
        });
        const sr = document.querySelector('#__gravitybox_hud_host__').shadowRoot;
        const popCtx = sr.querySelector('#hud-popover-context');
        if (popCtx.hasAttribute('hidden')) {
          sr.querySelector('.capsule-context').click();
        }
      })()`, ctx.executionContextId);
      await until(async () => await main.evaluate(`(() => {
        const sr = document.querySelector('#__gravitybox_hud_host__')?.shadowRoot;
        const pop = sr?.querySelector('#hud-popover-context');
        const stageLabel = sr?.querySelector('#hud-ctx-stages-list .hud-stage-item:not(.is-pending) .hud-stage-label');
        if (!pop || pop.hasAttribute('hidden') || !stageLabel) return false;
        return Math.round(pop.getBoundingClientRect().width) === 344;
      })()`));
      return await main.evaluate(`(() => {
        const sr = document.querySelector('#__gravitybox_hud_host__').shadowRoot;
        const popCtx = sr.querySelector('#hud-popover-context');
        const popInner = popCtx.querySelector('.hud-popover-inner');
        const titleEl = popCtx.querySelector('.hud-popover-title');
        const prefixEl = sr.querySelector('#pop-ctx-prefix');
        const roleEl = sr.querySelector('#pop-ctx-role');
        const pctEl = sr.querySelector('#pop-ctx-pct');
        const capEl = sr.querySelector('#pop-ctx-capacity');
        const targetItem = sr.querySelector('#hud-ctx-stages-list .hud-stage-item:not(.is-pending)');
        const nameEl = targetItem?.querySelector('.hud-stage-name');
        const labelEl = targetItem?.querySelector('.hud-stage-label');
        const itemRoleEl = targetItem?.querySelector('.hud-role-badge');
        const compEl = targetItem?.querySelector('.hud-stage-compaction');
        const valEl = targetItem?.querySelector('.hud-stage-val');
        const historyTitle = sr.querySelector('#hud-ctx-stages-list .hud-ctx-history-title');
        const pendingItem = sr.querySelector('#hud-ctx-stages-list .hud-stage-item.is-pending');
        const popRect = popCtx.getBoundingClientRect();
        const innerRect = popInner.getBoundingClientRect();
        const titleRect = titleEl.getBoundingClientRect();
        const prefixRect = prefixEl.getBoundingClientRect();
        const roleRect = roleEl && !roleEl.hasAttribute('hidden') ? roleEl.getBoundingClientRect() : null;
        const pctRect = pctEl.getBoundingClientRect();
        const capRect = capEl.getBoundingClientRect();
        const nameRect = nameEl.getBoundingClientRect();
        const compRect = compEl ? compEl.getBoundingClientRect() : null;
        const valRect = valEl.getBoundingClientRect();
        const overlaps = (a, b) => !(a.right <= b.left + 0.5 || b.right <= a.left + 0.5 || a.bottom <= b.top + 0.5 || b.bottom <= a.top + 0.5);
        return {
          popWidth: Math.round(popRect.width),
          innerOverflowX: popInner.scrollWidth > popInner.clientWidth,
          popPrefix: prefixEl.textContent,
          popRoleText: roleEl?.textContent ?? '',
          popRoleVisible: Boolean(roleEl && !roleEl.hasAttribute('hidden')),
          headerSingleLine: Math.abs(titleRect.top - capRect.top) < 8 && Math.abs(prefixRect.top - capRect.top) < 8,
          headerZeroOverlap: !overlaps(prefixRect, pctRect) && !overlaps(prefixRect, capRect) && !overlaps(pctRect, capRect) && (!roleRect || (!overlaps(prefixRect, roleRect) && !overlaps(roleRect, pctRect) && !overlaps(roleRect, capRect))),
          headerInsideBounds:
            prefixRect.left >= innerRect.left - 0.5 &&
            prefixRect.right <= innerRect.right + 0.5 &&
            (!roleRect || roleRect.right <= innerRect.right + 0.5) &&
            pctRect.right <= innerRect.right + 0.5 &&
            capRect.right <= innerRect.right + 0.5,
          stagesTitle: sr.querySelector('#lbl-ctx-stages')?.textContent,
          historyTitle: historyTitle ? historyTitle.textContent : null,
          activeInListCount: sr.querySelectorAll('#hud-ctx-stages-list .hud-stage-item.is-active').length,
          stageCount: sr.querySelectorAll('#hud-ctx-stages-list .hud-stage-item').length,
          pendingText: pendingItem?.textContent.replace(/\\s+/g, ' ').trim(),
          labelText: labelEl?.textContent,
          itemRoleText: itemRoleEl?.textContent ?? '',
          compText: compEl?.textContent,
          compWidth: compRect?.width ?? 0,
          compRight: compRect?.right ?? 0,
          nameRight: nameRect.right,
          valLeft: valRect.left,
        };
      })()`);
    };

    const layoutStd = await checkLongStageLayout({
      activeDisplayName: 'Orchestrator (Carbon)',
      activeShortLabel: 'Carbon',
      activeCompactLabel: 'C',
      activeRole: 'planner',
      nonActiveDisplayName: 'Hydrogen (High)',
    });
    assert.equal(layoutStd.popWidth, 344);
    assert.equal(layoutStd.innerOverflowX, false, '344px 上下文弹窗不得产生横向滚动条或溢出');
    assert.equal(layoutStd.popPrefix, '当前上下文 · Carbon ');
    assert.equal(layoutStd.popRoleVisible, true);
    assert.equal(layoutStd.popRoleText, '规划');
    assert.equal(layoutStd.headerSingleLine, true, '344px 弹窗顶部标题与容量徽章必须单行对齐不折行');
    assert.equal(layoutStd.headerZeroOverlap, true, '344px 弹窗顶部前缀、角色徽章、百分比与容量徽章不得重叠');
    assert.equal(layoutStd.headerInsideBounds, true, '344px 弹窗顶部元素不得超出内边距边界');
    assert.equal(layoutStd.stagesTitle, '曾用模型上下文');
    assert.equal(layoutStd.historyTitle, null, '统一单列表不应渲染二次 history 标题');
    assert.equal(layoutStd.activeInListCount, 0, 'Option A 底部列表不得包含当前活跃模型');
    assert.equal(layoutStd.stageCount, 2);
    assert.match(layoutStd.pendingText, /执行阶段.*待介入/);
    assert.equal(layoutStd.labelText, 'Hydrogen (High)');
    assert.equal(layoutStd.itemRoleText, '执行');
    assert.equal(layoutStd.compText, '2');
    assert.ok(layoutStd.compWidth > 0 && layoutStd.compWidth <= 20, '阶段压缩数字圆圈徽章必须保持紧凑单圆/小胶囊宽度');
    assert.ok(layoutStd.compRight <= layoutStd.nameRight + 0.5, `压缩徽章不得超出 .hud-stage-name 右边界 (${layoutStd.compRight} <= ${layoutStd.nameRight})`);
    assert.ok(layoutStd.compRight <= layoutStd.valLeft, `压缩徽章不得与右侧数值重叠 (${layoutStd.compRight} <= ${layoutStd.valLeft})`);

    const layoutLong = await checkLongStageLayout({
      activeDisplayName: 'Gemini 4 Very Long Hydrogen Preview (High Thinking)',
      activeShortLabel: 'Very Long Hydrogen Preview',
      activeRole: 'executor',
      nonActiveDisplayName: 'Very Long Hydrogen Preview (High Thinking)',
    });
    assert.equal(layoutLong.popWidth, 344);
    assert.equal(layoutLong.innerOverflowX, false, '长模型名下 344px 上下文弹窗不得横向溢出');
    assert.equal(layoutLong.popPrefix, '当前上下文 · Very Long Hydrogen Preview ');
    assert.equal(layoutLong.popRoleVisible, true);
    assert.equal(layoutLong.popRoleText, '执行');
    assert.equal(layoutLong.headerSingleLine, true, '长模型名下 344px 弹窗顶部仍应单行省略不折行');
    assert.equal(layoutLong.headerZeroOverlap, true, '长模型名下顶部前缀、角色徽章、百分比与容量徽章不得重叠');
    assert.equal(layoutLong.headerInsideBounds, true, '长模型名下顶部元素不得超出内边距边界');
    assert.equal(layoutLong.labelText, 'Very Long Hydrogen Preview (High Thinking)');
    assert.equal(layoutLong.itemRoleText, '执行');
    assert.equal(layoutLong.compText, '2');
    assert.ok(layoutLong.compRight <= layoutLong.nameRight + 0.5, `长模型名下压缩徽章不得被裁切 (${layoutLong.compRight} <= ${layoutLong.nameRight})`);
    assert.ok(layoutLong.compRight <= layoutLong.valLeft, `长模型名下压缩徽章不得与右侧数值重叠 (${layoutLong.compRight} <= ${layoutLong.valLeft})`);

    await main.evaluate(`(() => {
      const sr = document.querySelector('#__gravitybox_hud_host__').shadowRoot;
      const popCtx = sr.querySelector('#hud-popover-context');
      if (!popCtx.hasAttribute('hidden')) {
        sr.querySelector('.capsule-context').click();
      }
    })()`);

    // 7. 缩窄至 400px（<= 440px 紧凑态）：验证模型标签自动切换为单字母徽标 H 且不折行
    await main.evaluate(`document.querySelector('#hud-e2e-fixture').style.width = '400px'`);
    await until(async () => await main.evaluate(`document.querySelector('#__gravitybox_hud_host__').shadowRoot.querySelector('.hud-container').classList.contains('is-compact')`));
    const compactTagCheck = await main.evaluate(`(() => {
      const sr = document.querySelector('#__gravitybox_hud_host__').shadowRoot;
      const caps = [...sr.querySelectorAll('.capsule')];
      return {
        sameRow: caps.every(c => c.offsetTop === caps[0].offsetTop),
        fullDisplay: getComputedStyle(sr.querySelector('#hud-ctx-model-full')).display,
        shortDisplay: getComputedStyle(sr.querySelector('#hud-ctx-model-short')).display,
        shortText: sr.querySelector('#hud-ctx-model-short').textContent.trim(),
      };
    })()`);
    assert.equal(compactTagCheck.sameRow, true, '紧凑分栏下缩为单字母徽标后三胶囊仍应保持同行');
    assert.equal(compactTagCheck.fullDisplay, 'none');
    assert.notEqual(compactTagCheck.shortDisplay, 'none');
    assert.equal(compactTagCheck.shortText, 'H');

    // 8. Orchestrator 切回未压缩 Planner (Neon=0次, Hydrogen=2次) 时：常驻胶囊隐藏压缩徽标，对话统计弹窗显示会话总计「共 2 次」
    await main.evaluate(`document.querySelector('#hud-e2e-fixture').style.width = '560px'`);
    await main.evaluate(`(() => {
      const mgr = globalThis.__GRAVITYBOX_HUD_V1__?.manager;
      const inst = mgr ? [...mgr.instances.values()][0] : null;
      if (!inst) return;
      mgr.dispatchMetrics({
        conversationId: inst.getCurrentConvId(),
        sessionRevision: inst.getSessionRevision(),
        metricsSequence: Math.max(Date.now() + 20_000_000, (inst.lastMetricsSequence || 0) + 1),
        updatedAt: Date.now(),
        availability: 'ready',
        isStreaming: false,
        session: { turns: 6, steps: 28, compactionCount: 2, modelDurationSeconds: 150, toolDurationSeconds: 30, averageTtftSeconds: 1.1, outputTps: 105, outputTpsFormatted: '105 tok/s', currentTurnDurationSeconds: 180, currentTurnDurationCompactZh: '本轮 3m' },
        tokens: { totalTokens: 85300000, totalTokensCompact: '85.3M tok', cacheHitRate: 0.92, cacheHitRateFormatted: '92%' },
        context: {
          hasUsageData: true,
          modelId: 'gemini-4-neon',
          modelDisplayName: 'Orchestrator (Neon)',
          modelShortLabel: 'Neon',
          modelCompactLabel: 'N',
          isMultiModel: true,
          isOrchestrator: true,
          activeModelCompactionCount: 0,
          usedTokens: 344000,
          usedTokensCompact: '344K',
          peakContextTokens: 486000,
          capacityTokens: 512000,
          capacityTokensCompact: '512K',
          isFallbackCapacity: false,
          usedRatio: 344000 / 512000,
          usedRatioFormatted: '67.1%',
          breakdown: { cachedContextTokens: 339000, cachedContextRatio: 66.2, uncachedContextTokens: 5010, uncachedContextRatio: 0.98, latestOutputTokens: 366 },
          modelStages: [
            { slotKey: 'orchestrator:neon', role: 'planner', section: 'primary', modelId: 'gemini-4-neon', modelDisplayName: 'Orchestrator (Neon)', shortLabel: 'Neon', compactLabel: 'N', hasUsageData: true, isActive: true, usedTokens: 344000, peakContextTokens: 486000, capacityTokens: 512000, isFallbackCapacity: false, usedRatio: 344000 / 512000, usedRatioFormatted: '67.1%' },
            { slotKey: 'orchestrator:hydrogen', role: 'executor', section: 'primary', modelId: 'gemini-4-hydrogen', modelDisplayName: 'Gemini 4 Hydrogen (Orchestrator)', shortLabel: 'Hydrogen', compactLabel: 'H', hasUsageData: true, isActive: false, compactionCount: 2, usedTokens: 183000, peakContextTokens: 183000, capacityTokens: 512000, isFallbackCapacity: false, usedRatio: 183000 / 512000, usedRatioFormatted: '35.7%' }
          ]
        }
      });
    })()`, ctx.executionContextId);
    await until(async () => await main.evaluate(`(() => {
      const sr = document.querySelector('#__gravitybox_hud_host__')?.shadowRoot;
      return sr?.querySelector('#hud-ctx-model-full')?.textContent.trim() === 'Neon';
    })()`));
    const orchIsolationCheck = await main.evaluate(`(() => {
      const sr = document.querySelector('#__gravitybox_hud_host__').shadowRoot;
      sr.querySelector('.capsule-session').click();
      const popSession = sr.querySelector('#hud-popover-session');
      const popSessionRect = popSession.getBoundingClientRect();
      const out = {
        modelLabel: sr.querySelector('#hud-ctx-model-full')?.textContent.trim(),
        badgeHidden: sr.querySelector('#hud-compaction-badge')?.hasAttribute('hidden'),
        hasCompClass: sr.querySelector('.capsule-context')?.classList.contains('has-compaction'),
        sessionCompRowExists: Boolean(sr.querySelector('#row-session-compactions')),
        popSessionWidth: Math.round(popSessionRect.width),
        peakText: sr.querySelector('#val-ctx-peak')?.textContent.trim(),
      };
      if (!popSession.hasAttribute('hidden')) sr.querySelector('.capsule-session').click();
      return out;
    })()`);
    assert.equal(orchIsolationCheck.modelLabel, 'Neon');
    assert.equal(orchIsolationCheck.badgeHidden, true, 'Neon 未压缩时常驻胶囊不得显示 Hydrogen 的压缩徽标');
    assert.equal(orchIsolationCheck.hasCompClass, false);
    assert.equal(orchIsolationCheck.sessionCompRowExists, false, '对话统计弹窗不应包含上下文压缩行');
    assert.equal(orchIsolationCheck.popSessionWidth, 296);
    assert.equal(orchIsolationCheck.peakText.includes('已压缩'), false);

    await main.evaluate('document.querySelector("#hud-e2e-fixture").remove()');
    await main.evaluate('globalThis.__GRAVITYBOX_HUD_V1__?.reconcileMounts()', ctx.executionContextId);
    } finally {
      await main.send('Emulation.setEmulatedMedia', { features: [] }).catch(() => {});
    }
  });
  await check('真实 HUD binding→Worker SQLite→分栏投递；同会话双栏、A→B→A 与英文独立运行', async () => {
    const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
    const directory = join(temp, 'gemini', 'antigravity', 'conversations'); await mkdir(directory, { recursive: true });
    const metadata = input => Buffer.concat([
      HudWriter.encodeLengthDelimited(1, HudWriter.encodeVarintField(1, 100)),
      HudWriter.encodeLengthDelimited(7, HudWriter.encodeVarintField(1, 102)),
      HudWriter.encodeLengthDelimited(9, Buffer.concat([HudWriter.encodeVarintField(2, input), HudWriter.encodeVarintField(3, 50)])),
    ]);
    for (let i=0;i<ids.length;i++) {
      const db = new DatabaseSync(join(directory, ids[i]+'.db'));
      db.exec('CREATE TABLE steps(idx INTEGER PRIMARY KEY,step_type INTEGER,status INTEGER,metadata BLOB); CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY,data BLOB);');
      db.prepare('INSERT INTO steps VALUES(0,14,3,NULL)').run();
      db.prepare('INSERT INTO steps VALUES(1,15,3,?)').run(metadata(100+i*100)); db.close();
    }
    const tree = await main.send('Page.getFrameTree');
    const ctx = await main.send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'GRAVITYBOX-localization-v1' });
    await main.evaluate(`document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(ids.map((id,i)=>`<div id="binding-pane-${i}" data-testid="conversation-view" data-cascade-id="${id}" style="position:fixed;top:30px;left:${i*470}px;width:450px;background:white"><div data-testid="agent-input-box"><div class="surface-composer" style="height:50px"><button data-testid="model-selector-trigger" aria-label="Select model, current: Gemini 3.8 Flash">Gemini 3.8 Flash</button></div></div></div>`).join(''))})`);
    const values = () => main.evaluate(`(() => [...globalThis.__GRAVITYBOX_HUD_V1__.manager.instances.values()].map(i => ({ slot:i.paneSlotId, revision:i.sessionRevision, conversation:i.currentConvId, tokens:i.lastMetrics.tokens.totalTokens, availability:i.lastMetrics.availability })))()`, ctx.executionContextId);
    await until(async()=> { const rows=await values(); return rows.length===2 && rows[0].tokens===150 && rows[1].tokens===250; });
    const original = await values(); assert.notEqual(original[0].slot, original[1].slot);
    await until(async()=>await main.evaluate(`document.querySelector('#binding-pane-0 [data-testid="model-selector-trigger"]').getAttribute('aria-label')`)==='选择模型，当前：Gemini 3.8 Flash');
    assert.equal(await text(main, '#binding-pane-0 [data-testid="model-selector-trigger"]'), 'Gemini 3.8 Flash');
    await main.evaluate(`document.querySelector('#binding-pane-0').setAttribute('data-cascade-id', '${ids[1]}')`);
    await until(async()=>{const rows=await values();return rows.length===2&&rows.every(r=>r.conversation===ids[1]&&r.tokens===250);});
    const db = new DatabaseSync(join(directory,ids[0]+'.db'));db.prepare('UPDATE steps SET metadata=? WHERE idx=1').run(metadata(101));db.close();
    await main.evaluate(`document.querySelector('#binding-pane-0').setAttribute('data-cascade-id', '${ids[0]}')`);
    await until(async()=>{const rows=await values();return rows[0]?.conversation===ids[0]&&rows[0].tokens===151;});
    const returned=await values();assert.equal(returned[0].slot,original[0].slot);assert.ok(returned[0].revision>original[0].revision);assert.equal(returned[1].tokens,250);
    await command('pause');
    await until(async()=>await main.evaluate(`globalThis.__GRAVITYBOX_HUD_V1__?.manager?.state().languageMode === 'en'`,ctx.executionContextId));
    await until(async()=>{const rows=await values();return rows.length===2&&rows[0].tokens===151;});
    assert.equal(await text(main,'#settings'),'Settings');
    assert.equal(await main.evaluate(`globalThis.__GRAVITYBOX_HUD_V1__.manager.languageMode`,ctx.executionContextId),'en');
    const enHudAudit = await main.evaluate(`(() => {
      const hosts = [...document.querySelectorAll('#__gravitybox_hud_host__')];
      const texts = [];
      for (const h of hosts) {
        const sr = h.shadowRoot;
        if (!sr) continue;
        for (const el of sr.querySelectorAll('.capsule, .hud-popover')) {
          if (el.getAttribute('aria-label')) texts.push(el.getAttribute('aria-label'));
          if (el.textContent) texts.push(el.textContent);
        }
      }
      return { hostCount: hosts.length, texts };
    })()`);
    assert.ok(enHudAudit.hostCount >= 1);
    assert.equal(enHudAudit.texts.some((t) => /[\u3400-\u9fff]/.test(t)), false, JSON.stringify(enHudAudit));

    await main.evaluate(`(() => {
      const pane0 = document.querySelector('#binding-pane-0');
      if (pane0) pane0.style.width = '480px';
    })()`);
    await main.evaluate(`globalThis.__GRAVITYBOX_HUD_V1__?.reconcileMounts?.()`, ctx.executionContextId);
    await until(async () => await main.evaluate(`(() => {
      const host = document.querySelector('#binding-pane-0 #__gravitybox_hud_host__') || document.querySelector('#__gravitybox_hud_host__');
      const root = host?.shadowRoot?.querySelector('#hud-toolbar');
      const cacheVal = host?.shadowRoot?.querySelector('#hud-txt-tokens .hud-cache-val');
      if (!root?.classList.contains('is-mid-compact') || !cacheVal) return false;
      const cs = getComputedStyle(cacheVal);
      return cs.display !== 'none' && cacheVal.offsetWidth > 0 && cacheVal.textContent.trim().length > 0;
    })()`));
    await main.evaluate(`document.querySelector('#binding-pane-0').remove();document.querySelector('#binding-pane-1').remove()`);await command('resume');
    await until(async()=>await text(main,'#settings')==='设置');
  });
  await check('SSH 弹窗词条、路径白名单、动态进度与多行错误容器拆译', async () => {
    const tree = await main.send('Page.getFrameTree');
    const ctx = await main.send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'GRAVITYBOX-localization-v1' });
    await main.evaluate(`(() => {
      const tpl = document.querySelector('#ssh-modal-fixture');
      const frag = tpl.content.cloneNode(true);
      const p = frag.querySelector('#ssh-dlg-prompt-two-nodes');
      p.append(document.createTextNode('Enter [user@]host[:port], or pick a host from your SSH config.'), document.createTextNode(' Then create the project in its window.'));
      document.body.appendChild(frag);
    })()`);
    await until(async () => await text(main, '#ssh-dlg-title') === '连接到 SSH 主机');
    await until(async () => await text(main, '#ssh-cfg-val') === '~/.ssh/config（默认）');
    assert.equal(await text(main, '#ssh-dlg-prompt-two-nodes'), '输入 [user@]host[:port]，或从您的 SSH 配置中选择主机，然后在该主机窗口中创建项目。');
    assert.equal((await text(main, '#ssh-cfg-lbl')).trim(), 'SSH 配置：');
    assert.equal(await text(main, '#ssh-progress'), '正在连接到 demo-host 上运行中的服务…');
    assert.equal(await text(main, '#ssh-hidden-count'), '2 个已隐藏主机');
    assert.equal(await text(main, '#ssh-toast-title'), '已连接到 demo-host');
    assert.equal(await text(main, '#ssh-user-alias'), 'demo-ssh-host', '用户真实 SSH 主机别名必须保留原文');
    await until(async () => /demo-host 返回：/.test(await text(main, '#ssh-err-text')));
    const errText = await text(main, '#ssh-err-text');
    assert.match(errText, /^CONNECTION_FAILED: 无法连接到 SSH 主机。/);
    assert.match(errText, /demo-host 返回：ssh: connect to host demo-host port 22: Operation timed out/);
    assert.match(errText, /Logs: \/Users\/demo\/Library\/Logs\/Antigravity\/main\.log/);
    const toastMsg = await text(main, '#ssh-toast-msg');
    assert.match(toastMsg, /^SSH_CONFIG_INVALID: SSH 无法使用您的配置文件。/);
    assert.match(toastMsg, /demo-host 返回：bad configuration option/);
    assert.match(toastMsg, /Logs: \/Users\/demo\/Library\/Logs\/Antigravity\/main\.log/);
    assert.equal(typeof await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.state().scanCount', ctx.executionContextId), 'number');
    await main.evaluate('document.querySelector("#ssh-fixture-root").remove()');
  });
  await check('P1-30 ~ P1-35 & P1-37: 弹窗项目名子元素保护、动态编辑器类名回退、监听不泄漏、相对时间防误译、2.34.0 模板与深扫保护', async () => {
    const tree = await main.send('Page.getFrameTree');
    const ctx = await main.send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'GRAVITYBOX-localization-v1' });

    // P1-30: 弹窗内嵌套 span 项目按钮与 role="button" 项目控件保持原文
    await main.evaluate(`(() => {
      document.body.insertAdjacentHTML('beforeend',
        '<div id="p1-runtime-probe">' +
          '<div role="dialog" aria-label="Switch Project">' +
            '<button id="p1-dlg-proj-btn"><span id="p1-dlg-proj-span">Settings</span></button>' +
            '<div role="button" id="p1-dlg-proj-role"><span id="p1-dlg-proj-role-span">Settings</span></div>' +
            '<button id="p1-dlg-normal-btn">Cancel</button>' +
          '</div>' +
          '<div id="p1-dyn-code" data-gravitybox-ui><button id="p1-dyn-code-btn">Settings</button></div>' +
          '<div data-testid="quota-card"><button id="p1-quota-5h">5h</button><button id="p1-quota-7d">7d</button></div>' +
          '<div data-testid="conversation-row-sidebar"><span id="p1-sidebar-rel">13m</span></div>' +
          '<div data-gravitybox-ui>' +
            '<p id="p1-sr-inline">In System Settings, click <strong>+</strong>, choose <strong>Antigravity</strong>, then turn it on.</p>' +
            '<p id="p1-sr-relaunch">Relaunch Antigravity to finish Screen Recording.</p>' +
            '<button id="p1-sub-more">Show 3 more subagents</button>' +
            '<button id="p1-wrap-btn">Enable Word Wrap (Alt+Z)</button>' +
            '<p id="p1-save-err">Failed to save settings: disk full</p>' +
          '</div>' +
          '<div data-message-id="p1-stream-msg" class="markdown"><p id="p1-stream-text">Settings</p></div>' +
        '</div>'
      );
    })()`);

    await until(async () => await text(main, '#p1-dlg-normal-btn') === '取消');
    await until(async () => await text(main, '#p1-dyn-code-btn') === '设置');
    await until(async () => await text(main, '#p1-sidebar-rel') === '13分钟前');
    await until(async () => await text(main, '#p1-sr-relaunch') === '重新启动 Antigravity 以完成屏幕录制配置。');

    // P1-30 断言（含增量修改子节点文本后仍保持英文）
    assert.equal(await text(main, '#p1-dlg-proj-span'), 'Settings');
    assert.equal(await text(main, '#p1-dlg-proj-role-span'), 'Settings');
    await main.evaluate('document.querySelector("#p1-dlg-proj-span").textContent = "Settings"');
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(await text(main, '#p1-dlg-proj-span'), 'Settings');

    // P1-31: 动态添加 .monaco-editor 后必须触发 reconcile 还原英文
    await main.evaluate('document.querySelector("#p1-dyn-code").classList.add("monaco-editor")');
    await until(async () => await text(main, '#p1-dyn-code-btn') === 'Settings');
    await main.evaluate('document.querySelector("#p1-dyn-code").classList.remove("monaco-editor"); document.querySelector("#p1-dyn-code").classList.add("xterm")');
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(await text(main, '#p1-dyn-code-btn'), 'Settings');

    // P1-33: 配额区域 5h / 7d 不被误译为 "5小时前" / "7天前"，侧边栏 13m 与 #time-badge 仍正常
    assert.equal(await text(main, '#p1-quota-5h'), '5h');
    assert.equal(await text(main, '#p1-quota-7d'), '7d');
    assert.equal(await text(main, '#p1-sidebar-rel'), '13分钟前');
    assert.equal(await text(main, '#time-badge'), '5天前');

    // P1-34: 2.34.0 新增内联与动态模板全部准确汉化
    assert.equal(await text(main, '#p1-sr-inline'), '请在系统设置中点击 +，选择 Antigravity，然后开启它。');
    assert.equal(await text(main, '#p1-sub-more'), '显示另外 3 个子智能体');
    assert.equal(await text(main, '#p1-wrap-btn'), '开启自动换行 (Alt+Z)');
    assert.equal(await text(main, '#p1-save-err'), '保存设置失败：disk full');

    // P1-35: 流式受保护正文高频更新保持英文且不触发多余扫描错误
    const beforeScan = await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.state().scanCount', ctx.executionContextId);
    await main.evaluate(`(() => {
      const p = document.querySelector('#p1-stream-text');
      for (let i = 0; i < 20; i++) p.textContent = 'Settings chunk ' + i;
    })()`);
    await new Promise(resolve => setTimeout(resolve, 120));
    const afterScan = await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.state().scanCount', ctx.executionContextId);
    assert.equal(await text(main, '#p1-stream-text'), 'Settings chunk 19');
    assert.ok(afterScan - beforeScan <= 2, `受保护流式正文变更不应高频触发 flush（scanCount 增量=${afterScan - beforeScan}）`);

    // P1-32: 重复注入引擎脚本不重复注册 focus 监听器
    await main.send('Page.bringToFront');
    const engineCode = await readFile(join(root, 'runtime/engine.js'), 'utf8');
    await main.evaluate(`(() => {
      globalThis.__p1FocusOrig = globalThis.__gravityboxWindowFocus;
      globalThis.__p1FocusCalls = 0;
      globalThis.__gravityboxWindowFocus = (...args) => { globalThis.__p1FocusCalls++; return globalThis.__p1FocusOrig?.(...args); };
    })()`, ctx.executionContextId);
    await main.evaluate(engineCode, ctx.executionContextId);
    await main.evaluate(engineCode, ctx.executionContextId);
    await main.evaluate('window.dispatchEvent(new Event("focus"))', ctx.executionContextId);
    const focusCalls = await main.evaluate(`(() => {
      const n = globalThis.__p1FocusCalls;
      globalThis.__gravityboxWindowFocus = globalThis.__p1FocusOrig;
      delete globalThis.__p1FocusOrig;
      delete globalThis.__p1FocusCalls;
      return n;
    })()`, ctx.executionContextId);
    assert.equal(focusCalls, 1, `重复注入后单次 focus 事件仅应触发 1 次回调，实际 ${focusCalls}`);

    // P1-37: deepScan editorHash 覆盖 contenteditable="plaintext-only"
    const savedInputVal = await main.evaluate('document.querySelector("#input").value');
    await main.evaluate(`(() => {
      document.querySelector("#p1-runtime-probe")?.remove();
      document.querySelector("#input").value = "";
      document.body.insertAdjacentHTML("beforeend", '<div id="p1-plain-ed" contenteditable="plaintext-only"></div>');
    })()`);
    const beginRes = await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.deepScan.begin([])', ctx.executionContextId);
    assert.equal(beginRes.ok, true, JSON.stringify(beginRes));
    await main.evaluate('document.querySelector("#p1-plain-ed").textContent = "user typed"');
    const finishRes = await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.deepScan.finish()', ctx.executionContextId);
    assert.equal(finishRes.editorsMatch, false, 'plaintext-only 编辑区内容变化必须被 editorHash 检测到');
    await main.evaluate(`(() => {
      document.querySelector("#p1-plain-ed")?.remove();
      document.querySelector("#input").value = ${JSON.stringify(savedInputVal)};
    })()`);
  });
  await check('P0-01: 节点原位复用进入保护区后自动恢复原文并注销记录，切语言不覆盖用户新值', async () => {
    const tree = await main.send('Page.getFrameTree');
    const ctx = await main.send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'GRAVITYBOX-localization-v1' });
    await main.evaluate(`(() => {
      document.body.insertAdjacentHTML('beforeend',
        '<div id="p0-reuse-wrap">' +
          '<button id="p0-reuse-msg">Settings</button>' +
          '<button id="p0-reuse-role">Settings</button>' +
          '<a id="p0-reuse-link" href="/settings">Settings</a>' +
          '<button id="p0-reuse-user">Settings</button>' +
        '</div>');
    })()`);
    await until(async () =>
      (await text(main, '#p0-reuse-msg')) === '设置' &&
      (await text(main, '#p0-reuse-role')) === '设置' &&
      (await text(main, '#p0-reuse-link')) === '设置' &&
      (await text(main, '#p0-reuse-user')) === '设置'
    );

    // 1. 节点原位加上 data-message-id / data-message-author-role / 会话 href 后，必须恢复原文并注销翻译记录
    await main.evaluate(`(() => {
      document.querySelector('#p0-reuse-msg').setAttribute('data-message-id', 'msg-1');
      document.querySelector('#p0-reuse-role').setAttribute('data-message-author-role', 'user');
      document.querySelector('#p0-reuse-link').setAttribute('href', '/c/12345678-1234-4123-8123-123456789abc');
    })()`);
    await until(async () =>
      (await text(main, '#p0-reuse-msg')) === 'Settings' &&
      (await text(main, '#p0-reuse-role')) === 'Settings' &&
      (await text(main, '#p0-reuse-link')) === 'Settings'
    );

    // 2. 先复用为带保护属性并被用户写入新内容，即使来回切换语言也不得覆盖用户最新正文
    await main.evaluate(`(() => {
      const u = document.querySelector('#p0-reuse-user');
      u.setAttribute('data-message-id', 'msg-user');
      u.firstChild.nodeValue = 'User edited message Settings';
    })()`);
    await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.toggleLanguage("en")', ctx.executionContextId);
    assert.equal(await text(main, '#p0-reuse-user'), 'User edited message Settings');
    assert.equal(await text(main, '#p0-reuse-msg'), 'Settings');
    await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__.toggleLanguage("zh")', ctx.executionContextId);
    assert.equal(await text(main, '#p0-reuse-user'), 'User edited message Settings');
    assert.equal(await text(main, '#p0-reuse-msg'), 'Settings');
    assert.equal(await text(main, '#p0-reuse-role'), 'Settings');
    assert.equal(await text(main, '#p0-reuse-link'), 'Settings');
    await main.evaluate('document.querySelector("#p0-reuse-wrap")?.remove()');
  });
  const resources = (await execute('/bin/ps', ['-p', String(backend.pid), '-o', 'rss=,%cpu=,time='])).stdout.trim();
  const finalStatus = await status();
  const finalHeap = await main.send('Runtime.getHeapUsage');
  await check('退出助手撤销翻译且不退出浏览器', async () => {
    await command('stop'); await until(async () => backend.exitCode === 0);
    const tree=await main.send('Page.getFrameTree');const ctx=await main.send('Page.createIsolatedWorld',{frameId:tree.frameTree.frame.id,worldName:'GRAVITYBOX-localization-v1'});const engineState=await main.evaluate('globalThis.__GRAVITYBOX_ENGINE_V1__?.state()',ctx.executionContextId);assert.equal(await text(main, '#settings'), 'Settings',JSON.stringify({engineState,finalStatus}));
    assert.equal(chrome.exitCode, null);
  });
  await writeFile(join(evidenceDir, 'browser-results.json'), JSON.stringify({ date: new Date().toISOString(), scope: 'isolated headless Chrome fixture, not real Antigravity', browser: version.Browser, checks, updateDurationMs: updateDuration, backendResources: { ps: resources, statusRSSMB: finalStatus.rssMB }, rendererHeap: { initial: initialHeap, final: finalHeap, note: '整个测试页面的 JS 堆，包含测试操作，不能归因全部为翻译引擎；不是整个渲染进程 RSS' }, warnings: backendErrors }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, updateDurationMs: updateDuration, backendResources: resources }));
} catch (error) {
  await writeFile(join(evidenceDir, 'browser-failure.json'), JSON.stringify({ checks, error: error.stack, backendErrors, chromeErrors, browserEndpoint, chromeExit: { code: chrome?.exitCode, signal: chrome?.signalCode } }, null, 2));
  throw error;
} finally {
  if (backend?.exitCode === null) { try { await command('stop'); } catch { backend.kill('SIGTERM'); } }
  main?.close(); second?.close(); chrome?.kill('SIGTERM');
  await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => setTimeout(resolve, 150));
  await rm(temp, { recursive: true, force: true });
}
