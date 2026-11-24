import test from "node:test";
import { describe as describeContractGroup } from "node:test";
import assert from "node:assert/strict";
import { dictionaryFromEntries, loadDictionaryLayers, migrateLegacyIncrementalDictionaries, DictionaryStore, validateTemplateRules } from "../dist/dictionary.js";
import { coverageMetricSnapshot, coverageScopes, coverageTranslationLookup, createCoverage, extractCoverageStrings, isCoverageNoise, recordCoverageVisit, recountCoverage, resolveCoverageTranslation, shouldHideCoverageRow, filterCoverageEntries } from "../dist/coverage.js";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeRoute, scopedKey, decodeScopedKey, describeContext, previewItemId, selectedPreviewItems } from "../dist/candidates.js";
import { Controller } from "../dist/controller.js";
import { fileURLToPath } from "node:url";
import { validateTranslations } from "../tools/merge-translations.mjs";
import { loadDictLayers } from "../tools/coverage-report.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { extractUiStrings, extractedKind, looksLikeNoise, foldDictionaryKey } from "../dist/bundle.js";
import { extractInlineGroupsAst, inlineSlotViolations, resolveInlineGroupCoverage, validateInlineSlotLayout } from "../tools/extract-inline-groups-ast.mjs";

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("词典与抽取 · audit-p3-coverage", { concurrency: false }, async () => {
const scoped = (route, kind, text) => `@ui:${route}|${kind}|${text}`;
const dictOf = entries => dictionaryFromEntries(entries);
const sum = counts => Object.values(counts ?? {}).reduce((total, count) => total + count, 0);

/* ------------------------------------------------------------------ B16：@ui: 场景键参与资源扫描/补译判断 */

test('B16 资源扫描：只有 @ui: 场景译文的串判 translated，不再判 missing', () => {
  const dictionary = dictOf({ [scoped('/settings', 'button', 'Strong')]: '强', Open: '打开' });
  const report = createCoverage([{ id: '/main.js', scope: 'renderer', source: 'a({label:"Strong",description:"Open"});' }], dictionary, '2.24.0', 'sha');
  const strong = report.entries.find(e => e.key === 'Strong');
  assert.equal(strong.status, 'translated', '场景译文必须参与资源扫描查表');
  assert.equal(strong.translation, '强');
  assert.equal(strong.scoped, true);
  assert.equal(report.entries.some(e => e.key === 'Strong' && ['missing', 'review'].includes(e.status)), false);
  assert.equal(report.entries.find(e => e.key === 'Open').status, 'translated');
});

test('B16 场景解析：已知 route/kind 精确命中优先，未知场景退回普通键，多场景冲突判 review', () => {
  const lookup = coverageTranslationLookup(dictOf({
    [scoped('/settings', 'button', 'Open')]: '设置打开',
    [scoped('/', 'heading', 'Open')]: '主页打开',
    Open: '通用打开',
  }));
  assert.equal(resolveCoverageTranslation('Open', lookup, [{ route: '/settings', kind: 'button' }]).translation, '设置打开');
  assert.equal(resolveCoverageTranslation('Open', lookup, [{ route: '/history', kind: 'button' }]).translation, '通用打开');
  const ambiguousDictionary = dictOf({ [scoped('/settings', 'button', 'Dup')]: '甲', [scoped('/', 'button', 'Dup')]: '乙' });
  const report = createCoverage([{ id: '/main.js', scope: 'renderer', source: 'a({label:"Dup"});' }], ambiguousDictionary, '2.24.0', 'sha');
  const dup = report.entries.find(e => e.key === 'Dup');
  assert.equal(dup.status, 'review', '多个场景译文冲突时人工核对，不能算 missing');
  assert.equal(dup.translation, undefined);
});

test('B16 覆盖率场景解析只接受“可见界面 <route> <kind>”来源', () => {
  assert.deepEqual(coverageScopes({ sources: ['可见界面 /settings button', '/main.js'] }), [{ route: '/settings', kind: 'button' }]);
  assert.deepEqual(coverageScopes({ sources: ['/main.js'] }), []);
});

/* ------------------------------------------------------------------ B14/B15：counts 双计与总览口径 */

test('B14 counts 不再 status/observed 双计：每个词条恰好一个终态，sum === entries.length', () => {
  const dictionary = dictOf({ Translated: '已翻译' });
  const report = createCoverage([{ id: '/main.js', scope: 'renderer', source: 'a({label:"Translated",description:"Missing"});' }], dictionary, '2.24.0', 'sha');
  recordCoverageVisit(report, '/settings', { observations: [{ key: '  Translated  ', state: 'verified' }, { key: 'Missing', state: 'untranslated' }] });
  assert.equal(sum(report.counts), report.entries.length, '互斥终态计数合计必须等于词条数');
  assert.equal(sum(report.statusCounts), report.entries.length, '扫描状态轴同样覆盖全部词条');
  assert.equal(report.counts.verified, 1, 'observed=verified 单独成桶');
  assert.equal(report.counts.untranslated, 1, 'observed=untranslated 单独成桶');
  assert.equal(report.counts.translated ?? 0, 0, '被实机观察的词条不再重复计入 translated');
  assert.equal(report.statusCounts.translated, 1, '扫描状态轴仍保留原 translated');
  assert.equal(report.statusCounts.missing >= 1, true);
  assert.equal(report.observedCounts.verified, 1);
  assert.equal(report.observedCounts.untranslated, 1);
});

test('B14 旧报告（无 statusCounts/observedCounts）重算后可解释，不产生双计', () => {
  const report = createCoverage([{ id: '/main.js', scope: 'renderer', source: 'a({label:"Translated"});' }], dictOf({ Translated: '已翻译' }), '2.24.0', 'sha');
  report.entries[0].observed = 'verified';
  const legacy = { ...report, counts: { translated: 1, verified: 1 }, statusCounts: undefined, observedCounts: undefined };
  recountCoverage(legacy);
  assert.equal(sum(legacy.counts), legacy.entries.length);
  assert.equal(legacy.counts.verified, 1);
  assert.equal(legacy.observedCounts.verified, 1);
});

test('B15 总览口径与覆盖页同源：translated/extracted 且带应用版本、生成时间、词典版本', () => {
  const dictionary = dictOf({ Translated: '已翻译' });
  const report = createCoverage([{ id: '/main.js', scope: 'renderer', source: 'a({label:"Translated",description:"Missing"});' }], dictionary, '2.24.0', 'sha');
  const metric = coverageMetricSnapshot(report);
  assert.equal(metric.available, true);
  assert.equal(metric.extracted, report.entries.length, '分母是已抽取词条数');
  assert.equal(metric.translated, report.counts.translated ?? 0, '与覆盖页 counts.translated 同源');
  assert.equal(metric.covered, (report.counts.translated ?? 0) + (report.counts.verified ?? 0));
  assert.equal(metric.appVersion, '2.24.0');
  assert.equal(metric.generatedAt, report.generatedAt);
  assert.equal(metric.bundleSha256, 'sha');
  assert.equal(metric.dictionaryVersion, dictionary.version);
  assert.equal(metric.review, report.counts.review ?? 0);
  const empty = coverageMetricSnapshot(undefined);
  assert.equal(empty.available, false);
  assert.equal(empty.translated, 0);
  assert.equal(empty.extracted, 0);
});

/* ------------------------------------------------------------------ I07：覆盖率诊断噪声过滤 */

test('I07 噪声判定：先规范化，堆栈/日志/压缩 JS/纯标识符不算待译，正常文案不误伤', () => {
  const noise = [
    '\n\n  Error generating stack: boom',
    ';break;case -2:Wf=Xa?',
    '  at Object.<anonymous> (/app/main.js:1:2)',
    '[AutoUpdater] Checking for update…',
    '--wsl-distro=${distro}',
    'node_modules/react/index.js',
    'application/json',
    'data-testid',
    '!p-0 overflow-hidden',
    '!text-clip',
    '\u001b[33mConnection lost\u001b[0m',
    '[...long stack...]',
    'Local:       ${url}',
    '(display-mode: standalone)',
    'getFile()',
    '\\\\b(?:import|module)',
    '?csrfToken',
    "' here.",
  ];
  for (const key of noise) assert.equal(isCoverageNoise(key), true, `应判为噪声：${key}`);
  const legit = [
    '\n\n  Open a review  ',
    'Save changes',
    'Settings',
    'Resets in {duration}',
    'Open {name} in {count} steps',
    'Gemini 2.5 Flash Image',
    '(no file changes detected)',
    '(Optional)',
    'Show (2)',
    'git pull',
  ];
  for (const key of legit) assert.equal(isCoverageNoise(key), false, `不应判为噪声：${key}`);
});

test('I07 覆盖页行隐藏：只隐藏待译/待确认类噪声行，分类行保留以解释计数', () => {
  assert.equal(shouldHideCoverageRow({ key: 'Error generating stack: x', status: 'review' }), true);
  assert.equal(shouldHideCoverageRow({ key: ';break;case -2:Wf=Xa?', status: 'missing' }), true);
  assert.equal(shouldHideCoverageRow({ key: 'Open a review', status: 'missing' }), false);
  assert.equal(shouldHideCoverageRow({ key: 'Error generating stack: x', status: 'dynamic' }), false);
  assert.equal(shouldHideCoverageRow({ key: 'Error generating stack: x', status: 'translated' }), false);
});

test('I07 抽取：结构化与 literal 候选都先规范化并过滤噪声，键不再带前导空白', () => {
  const source = [
    'const a={label:"Open a review",description:"  Save changes  "};',
    'const b="Error generating stack: boom";',
    'const c=";break;case -2:Wf=Xa?";',
    'const d="  at Object.<anonymous> (/app/main.js:1:2)";',
    'const e="node_modules/react/index.js";',
    'const f="!p-0 overflow-hidden";',
    'const g="  Cancel  ";',
  ].join('');
  const keys = extractCoverageStrings(source).map(entry => entry.key);
  assert.deepEqual([...new Set(keys)].sort(), ['Cancel', 'Open a review', 'Save changes']);
  for (const key of keys) assert.equal(key, key.trim(), '键必须已规范化');
  const report = createCoverage([{ id: '/main.js', scope: 'renderer', source }], dictOf({}), '2.24.0', 'sha');
  const reportKeys = report.entries.map(entry => entry.key);
  for (const noisy of ['Error generating stack: boom', ';break;case -2:Wf=Xa?', 'node_modules/react/index.js', '!p-0 overflow-hidden']) {
    assert.equal(reportKeys.includes(noisy), false, `噪声不得进入覆盖率清单：${noisy}`);
  }
  assert.equal(sum(report.counts), report.entries.length);
});
});

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("词典与抽取 · evolution", { concurrency: false }, async () => {
test('场景键保留占位符、隔离角色和页面，并隐藏私有路径',()=>{
  assert.notEqual(scopedKey('Open {name}','button','/settings'),scopedKey('Open {name}','heading','/'));
  assert.deepEqual(decodeScopedKey(scopedKey('Open {name}','button','/settings')),{key:'Open {name}',kind:'button',route:'/settings'});
  assert.equal(safeRoute('/c/private-id?token=secret'),'/other');assert.equal(decodeScopedKey('@ui:/c/private|button|Open'),undefined);
});

test('版本词典选择最近可用层，不将未来版本覆盖带回旧版；个人覆盖仍最高',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'gravity-dict-version-'));const base=join(dir,'base'),user=join(dir,'user');try{await mkdir(base);await mkdir(user);await writeFile(join(base,'base.json'),'{"Version label":"基础"}');await writeFile(join(base,'2.23.0.json'),'{"Version label":"旧版"}');await writeFile(join(base,'2.24.0.json'),'{"Version label":"未来"}');assert.equal((await loadDictionaryLayers(base,user,'2.23.1')).dictionary.entries['Version label'],'旧版');assert.equal((await loadDictionaryLayers(base,user,'2.25.0')).dictionary.entries['Version label'],'未来');await writeFile(join(user,'个人覆盖.json'),'{"Version label":"个人"}');assert.equal((await loadDictionaryLayers(base,user,'2.23.1')).dictionary.entries['Version label'],'个人');}finally{await rm(dir,{recursive:true,force:true});}
});

test('个人全局覆盖高于 AI 场景补全；移除后恢复已有场景译文',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'gravity-context-personal-'));const base=join(dir,'base'),user=join(dir,'user');try{await mkdir(base);await mkdir(user);await writeFile(join(base,'base.json'),'{}');const context=scopedKey('Open','button','/settings');await writeFile(join(user,'增量补全-2.23.1.json'),JSON.stringify({[context]:'打开资源'}));await writeFile(join(user,'个人覆盖.json'),'{"Open":"我的译文"}');let layers=await loadDictionaryLayers(base,user);assert.equal(layers.dictionary.entries[context],undefined);assert.equal(layers.dictionary.entries.Open,'我的译文');await writeFile(join(user,'个人覆盖.json'),'{}');layers=await loadDictionaryLayers(base,user);assert.equal(layers.dictionary.entries[context],'打开资源');}finally{await rm(dir,{recursive:true,force:true});}
});
});

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("词典与抽取 · phase1-audit-verification", { concurrency: false }, async () => {
test('阶段1验证 - B01: 损坏旧词典不被删除，损坏统一词典不被覆盖', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gb-test-b01-'));
  const brokenContent = '{ broken json content';
  await writeFile(join(root, '增量补全-2.23.1.json'), brokenContent);
  await migrateLegacyIncrementalDictionaries(root);
  const filesAfter = await readdir(root);
  assert.ok(filesAfter.includes('增量补全-2.23.1.json'), '损坏的旧词典必须完整保留在原处');
  const content = await readFile(join(root, '增量补全-2.23.1.json'), 'utf8');
  assert.equal(content, brokenContent, '损坏的旧词典内容不能被修改');
});
});

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("词典与抽取 · polish", { concurrency: false }, async () => {
const dictionary=dictionaryFromEntries({});
const controller=()=>new Controller({appPath:'/unused',profile:'/unused',dictionary,onStatus(){}});
test('预览子集严格限定为批次成员，区别同词的场景，拒绝空/重复/注入 ID',()=>{
 const entries=[{key:'Open',translationKey:scopedKey('Open','button','/settings')},{key:'Open',translationKey:scopedKey('Open','heading','/')}];const ids=entries.map(previewItemId);assert.notEqual(ids[0],ids[1]);assert.deepEqual(selectedPreviewItems(entries,[ids[1]]),[entries[1]]);
 for(const selection of [[],[ids[0],ids[0]],['injected'],null,'all'])assert.throws(()=>selectedPreviewItems(entries,selection));
});
test('来源计数跟随合并后优先级及版本切换，错误重载保留上一份有效数据',async()=>{
 const root=await mkdtemp(join(tmpdir(),'gb-counts-'));const base=join(root,'base'),user=join(root,'user');await mkdir(base);await mkdir(user);const store=new DictionaryStore(base,user);
 try{await writeFile(join(base,'base.json'),JSON.stringify({Save:'保存',Open:'打开'}));await writeFile(join(base,'2.23.2.json'),JSON.stringify({New:'新增'}));await writeFile(join(user,'增量补全-2.23.1.json'),JSON.stringify({Open:'开启'}));await writeFile(join(user,'个人覆盖.json'),JSON.stringify({Save:'存储'}));await store.start();assert.deepEqual(store.layerCounts,{builtin:1,incremental:1,personal:1});await store.selectVersion('2.23.1');assert.deepEqual(store.layerCounts,{builtin:0,incremental:1,personal:1});const version=store.current.version;
  await writeFile(join(user,'个人覆盖.json'),'{broken');await store.reload();assert.equal(store.current.version,version);assert.deepEqual(store.layerCounts,{builtin:0,incremental:1,personal:1});assert.ok(store.lastError);
 }finally{store.close();await rm(root,{recursive:true,force:true});}
});
test('巡检编辑仅允许明确 UI，保留场景，修改后失效旧实机验证且不虚构新验证',async()=>{
 const c=controller();c.coverage={schema:1,dictionaryVersion:dictionary.version,entries:[{key:'Inspect view',status:'missing',confidence:'ui',sources:['可见界面 /settings button'],observed:'untranslated'},{key:'File',status:'native',confidence:'ui',sources:['native']},{key:'Updated {time}',status:'dynamic',confidence:'ui',sources:['内置动态规则']},{key:'Ambiguous label',status:'missing',confidence:'ui',sources:['可见界面 /settings button','可见界面 /history heading']}],counts:{}};
 const edit=await c.prepareCoverageEdit('Inspect view');assert.equal(edit.key,scopedKey('Inspect view','button','/settings'));assert.equal(edit.context,'设置 · 按钮');
 for(const key of ['File','Updated {time}','Ambiguous label','Unknown text'])await assert.rejects(c.prepareCoverageEdit(key));
 c.options.dictionary=dictionaryFromEntries({[edit.key]:'检查视图'});const report=await c.coverageReport();assert.equal(report.entries[0].translation,'检查视图');assert.equal(report.entries[0].status,'translated');assert.equal(report.entries[0].observed,undefined);assert.equal(report.counts.verified,undefined);
});
});

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("词典与抽取 · refactor", { concurrency: false }, async () => {
const root = new URL('../', import.meta.url);
async function state() { const directory = await mkdtemp(join(tmpdir(), 'gb-test-')); await mkdir(join(directory, '词典')); return directory; }

test('运行时与发布门禁采用相同词典优先级', async () => {
  const runtime = await loadDictionaryLayers(fileURLToPath(new URL('dict/', root))); const gate = await loadDictLayers(fileURLToPath(new URL('dict/', root)));
  for (const [key, value] of Object.entries(runtime.dictionary.entries)) assert.equal(gate.entries.get(key).value, value, key);
});
test('个人覆盖优先于增量文件；来源可见', async () => {
  const directory = await state(); const base = join(directory, 'base'); await mkdir(base);
  try { await writeFile(join(base, 'base.json'), '{"Save":"保存"}'); await writeFile(join(directory, '词典', '增量补全-2.23.1.json'), '{"Save":"增量译文"}'); await writeFile(join(directory, '词典', '个人覆盖.json'), '{"Save":"个人译文"}'); const result = await loadDictionaryLayers(base, join(directory, '词典')); assert.equal(result.dictionary.entries.Save, '个人译文'); assert.match(result.sources.Save, /个人覆盖/); }
  finally { await rm(directory, { recursive: true, force: true }); }
});
test('占位符错误不进入 accepted，不能经部分合并绕过', () => { const result = validateTranslations([{ key: 'Save {name}', zh: '保存' }], {}); assert.equal(result.accepted.length, 0); assert.equal(result.rejected.length, 1); });
});

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("词典与抽取 · repair-20261023", { concurrency: false }, async () => {
const run=promisify(execFile);async function fixture(t){const d=await mkdtemp(join(tmpdir(),'gb-repair-'));t.after(async()=>{try{await rm(d,{recursive:true,force:true,maxRetries:10,retryDelay:50});}catch{}});return d;}
test('迁移旧词典只补缺，不回退统一层新译文；合并拒绝损坏及冲突层',async t=>{const d=await fixture(t);await writeFile(join(d,'增量补全.json'),JSON.stringify({Conflict:'新版'}));await writeFile(join(d,'增量补全-2.23.1.json'),JSON.stringify({Conflict:'旧版'}));await migrateLegacyIncrementalDictionaries(d);assert.equal(JSON.parse(await readFile(join(d,'增量补全.json'))).Conflict,'新版');const base=join(d,'base'),pending=join(d,'pending'),input=join(d,'input'),out=join(d,'output');await writeFile(base,'{}');await writeFile(pending,JSON.stringify({entries:[{key:'Synthetic action'}]}));await writeFile(input,JSON.stringify({'Synthetic action':'合成操作'}));for(const original of ['{bad',JSON.stringify({'Synthetic action':'旧译文'})]){await writeFile(out,original);await assert.rejects(run(process.execPath,['tools/merge-translations.mjs','--base',base,'--pending',pending,'--input',input,'--out',out]));assert.equal(await readFile(out,'utf8'),original);}});
});

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("词典与抽取 · ui-evolution", { concurrency: false }, async () => {
test('静态提取保留首个有效组件语义，不把通用文字全部硬编码成 ui',()=>{
 const entries=extractUiStrings('({placeholder:"Find hidden settings",tooltip:"Inspect public status",confirmLabel:"Apply changes",heading:"Connection status"});React.createElement("button",{},"Review changes");');
 for(const [key,kind]of[['Find hidden settings','placeholder'],['Inspect public status','tooltip'],['Apply changes','button'],['Connection status','heading'],['Review changes','button']])assert.equal(extractedKind(entries.find(e=>e.text===key)?.kinds),kind,key);
 assert.equal(extractedKind(['template','prop']),undefined);
});
});

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("词典与抽取 · visual-audit-optimization", { concurrency: false }, async () => {
test('扫描类型与译文状态独立过滤，观察未生效仍计入待译且分页前筛选',()=>{const rows=[{key:'Save changes',status:'missing'},{key:'Cancel',translation:'取消',status:'translated',observed:'verified'},{key:'Existing translation',translation:'已有译文',status:'translated',observed:'untranslated'},{key:'${count} items',status:'dynamic'},{key:'Quit application',status:'native'},{key:'Main settings',translation:'界面设置',status:'visited',viewType:'route'}];const original=JSON.stringify(rows);assert.deepEqual(filterCoverageEntries(rows,'','missing','ui').map(r=>r.key),['Save changes','Existing translation']);assert.deepEqual(filterCoverageEntries(rows,'','all','dynamic').map(r=>r.key),['${count} items']);assert.deepEqual(filterCoverageEntries(rows,'','verified','ui').map(r=>r.key),['Cancel']);assert.deepEqual(filterCoverageEntries(rows,'界面','all','route').map(r=>r.key),['Main settings']);assert.deepEqual(filterCoverageEntries(rows,'','missing','native'),[]);assert.equal(JSON.stringify(rows),original);});
});

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("词典与抽取 · ui-localization-supplement", { concurrency: false }, async () => {
test('版本登记幂等且术语校验共用同一策略源', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { registerSupportedBundle } = await import('../tools/extract-ui-strings.mjs');
  const { PROPER_NOUNS: coverageNouns, GLOSSARY_RULES: coverageGlossary } = await import('../dist/coverage.js');
  const { PROPER_NOUNS: reportNouns } = await import('../tools/coverage-report.mjs');
  const { PROPER_NOUNS: mergeNouns, GLOSSARY_RULES: mergeGlossary } = await import('../tools/merge-translations.mjs');

  // 1. 验证 PROPER_NOUNS 与 GLOSSARY_RULES 在 src/coverage.ts、coverage-report.mjs 与 merge-translations.mjs 指向同一事实源
  assert.strictEqual(reportNouns, coverageNouns);
  assert.strictEqual(mergeNouns, coverageNouns);
  assert.strictEqual(mergeGlossary, coverageGlossary);
  assert.ok(coverageNouns.includes('Aoede') && coverageNouns.includes('Project 4K'));

  // 2. 验证 registerSupportedBundle 能自动登记 2.29.0 等新版本指纹并保持版本升序且幂等
  const dir = await mkdtemp(join(tmpdir(), 'gb-reg-bundle-'));
  try {
    await mkdir(join(dir, 'src'), { recursive: true });
    const mockBundleTs = join(dir, 'src', 'bundle.ts');
    await writeFile(mockBundleTs, "export const SUPPORTED_BUNDLES = new Map([\n  ['2.28.0', '" + "a".repeat(64) + "'],\n]);\n", 'utf8');
    const sha229 = "b".repeat(64);
    const added = await registerSupportedBundle('2.29.0', sha229, dir);
    assert.equal(added, true, '首次登记 2.29.0 应返回 true');
    const duplicate = await registerSupportedBundle('2.29.0', sha229, dir);
    assert.equal(duplicate, false, '重复登记相同指纹应幂等返回 false');
    const updatedContent = await readFile(mockBundleTs, 'utf8');
    assert.ok(updatedContent.includes("['2.29.0', '" + sha229 + "']"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

});

test('基础词典零大小写异译冲突、零术语表违规且无控制台代码脏键', async () => {
  const { GLOSSARY_RULES } = await import('../dist/coverage.js');
  const raw = JSON.parse(await readFile(fileURLToPath(new URL('../dict/base.json', import.meta.url)), 'utf8'));
  const byLower = new Map();
  const glossaryViolations = [];
  const consoleDirty = [];

  for (const [key, value] of Object.entries(raw)) {
    if (!key.startsWith('@ui:')) {
      const lower = key.toLowerCase();
      const list = byLower.get(lower) ?? [];
      list.push([key, value]);
      byLower.set(lower, list);
    }
    const plainKey = key.startsWith('@ui:') ? key.split('|').slice(2).join('|') : key;
    if (!/google chat|chatgpt|wechat/i.test(plainKey)) {
      for (const rule of GLOSSARY_RULES) {
        if (rule.en.test(plainKey) && rule.forbid.some(f => value.includes(f))) {
          glossaryViolations.push({ key, value, rule: rule.note });
        }
      }
    }
    if (/addToBrowserAllowlist|document\.execCommand|ContextScopeItem/.test(key)) {
      consoleDirty.push(key);
    }
  }

  const caseConflicts = [];
  for (const [lower, items] of byLower) {
    if (items.length > 1 && new Set(items.map(([, v]) => v)).size > 1) {
      caseConflicts.push({ lower, items });
    }
  }

  assert.deepEqual(caseConflicts, [], '不应存在大小写不同但译文冲突的词条');
  assert.deepEqual(glossaryViolations, [], '不应存在违反 GLOSSARY_RULES 的译文');
  assert.deepEqual(consoleDirty, [], '不应包含无界面引用的控制台/JS 调试脏键');
});

test('P1-37/P1-39：dict/base.json 无首尾空格，HUD 与 engine.js 术语和 2.32.1 模板防回归', async () => {
  const rootDir = join(fileURLToPath(new URL('.', import.meta.url)), '..');
  const [baseRaw, zhPackRaw, engineSrc, hudMod] = await Promise.all([
    readFile(join(rootDir, 'dict', 'base.json'), 'utf8'),
    readFile(join(rootDir, 'assets', 'i18n', 'zh-Hans.json'), 'utf8'),
    readFile(join(rootDir, 'runtime', 'engine.js'), 'utf8'),
    import('../runtime/hud-i18n.js'),
  ]);
  const baseDict = JSON.parse(baseRaw);
  const zhPack = JSON.parse(zhPackRaw);

  assert.equal(baseDict['Enter'], 'Enter');
  assert.equal(baseDict['Cmd+Enter'], 'Cmd+Enter');
  assert.equal(baseDict['Command+Enter'], 'Command+Enter');
  assert.equal(baseDict['Low'], 'Low');
  assert.equal(baseDict['Medium'], 'Medium');
  assert.equal(baseDict['High'], 'High');
  assert.equal(baseDict['Extra'], 'Extra');
  assert.equal(baseDict['Extra High'], 'Extra High');
  assert.equal(baseDict['Max'], 'Max');
  assert.equal(baseDict['Orchestrator Settings'], 'Orchestrator 设置');
  assert.equal(baseDict['Orchestrator Model'], 'Orchestrator 模型');
  assert.equal(baseDict['Executor Model'], 'Executor 模型');
  assert.equal(baseDict['Input Box'], '对话输入框');
  assert.equal(baseDict['Choose which key sends a message in the chat composer.'], '选择在对话输入框中发送消息的按键。');
  const { classifyCoverage } = await import('../dist/coverage.js');
  assert.equal(classifyCoverage('Enter', 'Enter'), 'preserved');
  assert.equal(classifyCoverage('Cmd+Enter', 'Cmd+Enter'), 'preserved');
  assert.equal(classifyCoverage('Command+Enter', 'Command+Enter'), 'preserved');
  assert.equal(classifyCoverage('Low', 'Low'), 'preserved');
  assert.equal(classifyCoverage('Medium', 'Medium'), 'preserved');
  assert.equal(classifyCoverage('High', 'High'), 'preserved');
  assert.equal(classifyCoverage('Extra', 'Extra'), 'preserved');
  assert.equal(classifyCoverage('Extra High', 'Extra High'), 'preserved');
  assert.equal(classifyCoverage('Max', 'Max'), 'preserved');

  const untrimmed = [];
  for (const [k, v] of Object.entries(baseDict)) {
    if (k !== k.trim() || (typeof v === 'string' && v !== v.trim())) {
      untrimmed.push({ key: k, value: v });
    }
  }
  assert.deepEqual(untrimmed, [], 'dict/base.json 键与译文均不应包含首尾空白字符');

  for (const [k, v] of Object.entries(hudMod.HUD_I18N['zh-Hans'])) {
    assert.equal(String(v).includes('会话'), false, `HUD_I18N["zh-Hans"].${k} 不应出现旧术语“会话”`);
    assert.equal(zhPack.hud[k], v);
  }
  assert.equal(hudMod.HUD_I18N['zh-Hans'].tpsMeasuring, '计算中...');
  assert.equal(hudMod.HUD_I18N.en.tpsMeasuring, 'Measuring…');

  assert.match(engineSrc, /'sessions':\s*'会话'/);
  assert.match(engineSrc, /dialogLabel === '设置'/);
  assert.match(engineSrc, /'gravitybox'/);
  assert.match(engineSrc, /function syncElementLocFlag/);
  assert.match(engineSrc, /⚠️ Failed to render LaTeX: \{reason\}/);
  assert.match(engineSrc, /Working directory: \{path\}/);
  assert.match(engineSrc, /function isElapsedDurationNode/);
  assert.match(engineSrc, /key:\s*"\{count\}\{timeUnit\}",\s*pattern:\s*\/\^\(\\d\+\)\(m\|h\|d\|w\|mo\|y\)\$\//);
});

test('P2-3：loadDictionaryLayers 支持声明式 template-rules.json 热编译且拦截非锚定或嵌套量词风险正则', async () => {
  const { validateTemplateRules } = await import('../dist/dictionary.js');
  const dir = await mkdtemp(join(tmpdir(), 'gb-decl-rules-'));
  try {
    const base = join(dir, 'base');
    const user = join(dir, 'user');
    await mkdir(base, { recursive: true });
    await mkdir(user, { recursive: true });
    await writeFile(join(base, 'base.json'), JSON.stringify({ Save: '保存' }), 'utf8');
    await writeFile(
      join(user, 'template-rules.json'),
      JSON.stringify({
        rules: [
          {
            key: 'Synced {count} workspaces',
            pattern: '^Synced\\s+(\\d+)\\s+workspaces?$',
            flags: 'i',
            replacement: '已同步 $1 个工作区',
          },
          // 未以 ^ 锚定的模式必须拒绝
          {
            key: 'Unanchored {x}',
            pattern: 'Unanchored\\s+(.+)',
            flags: 'i',
            replacement: '未锚定 $1',
          },
          // 嵌套量词 ReDoS 风险模式必须拒绝
          {
            key: 'Unsafe {x}',
            pattern: '^([a-z]+)+$',
            flags: 'i',
            replacement: '危险 $1',
          },
        ],
      }),
      'utf8'
    );

    const validated = validateTemplateRules(JSON.parse(await readFile(join(user, 'template-rules.json'), 'utf8')));
    assert.equal(validated.length, 1);
    assert.equal(validated[0].key, 'Synced {count} workspaces');

    const layered = await loadDictionaryLayers(base, user);
    assert.equal(layered.dictionary.entries.Save, '保存');
    assert.equal(layered.dictionary.templateRules?.length, 1);
    assert.equal(layered.dictionary.templateRules?.[0]?.replacement, '已同步 $1 个工作区');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('P1-15: 栈扫描拦截多层嵌套括号量词 ReDoS 绕过，且 DictionaryStore 降级缓存保留 templateRules', async () => {
  const { hasNestedQuantifiedGroup, validateTemplateRules } = await import('../dist/dictionary.js');

  // 经典多层嵌套分组 ReDoS 绕过必须被精准拦截
  assert.equal(hasNestedQuantifiedGroup('^((?:a+)+)+$'), true);
  assert.equal(hasNestedQuantifiedGroup('^([a-z]+(\\s+[a-z]+)+)+$'), true);
  assert.equal(hasNestedQuantifiedGroup('^((a*)*)$'), true);
  assert.equal(hasNestedQuantifiedGroup('^(a{1,3}){2,}$'), true);
  // 合法平面分组与字符类内的 +/* 不误伤
  assert.equal(hasNestedQuantifiedGroup('^Synced\\s+(\\d+)\\s+workspaces?$'), false);
  assert.equal(hasNestedQuantifiedGroup('^([a-z+]+)\\s+(\\d+)$'), false);

  const filtered = validateTemplateRules({
    rules: [
      { key: 'Nested 1 {x}', pattern: '^((?:a+)+)+$', flags: 'i', replacement: '$1' },
      { key: 'Nested 2 {x}', pattern: '^([a-z]+(\\s+[a-z]+)+)+$', flags: 'i', replacement: '$1' },
      { key: 'Safe {n}', pattern: '^Processed\\s+(\\d+)\\s+items?$', flags: 'i', replacement: '已处理 $1 项' },
    ],
  });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].key, 'Safe {n}');

  // 个人词典损坏触发 DictionaryStore.start(fallback) 降级时，fallback.templateRules 必须完整保留
  const dir = await mkdtemp(join(tmpdir(), 'gb-fallback-rules-'));
  try {
    const base = join(dir, 'base');
    const user = join(dir, 'user');
    await mkdir(base, { recursive: true });
    await mkdir(user, { recursive: true });
    await writeFile(join(base, 'base.json'), '{ broken base json', 'utf8');
    const fallbackDict = dictionaryFromEntries(
      { Save: '保存' },
      [{ key: 'Processed {n} items', pattern: '^Processed\\s+(\\d+)\\s+items?$', flags: 'i', replacement: '已处理 $1 项' }]
    );
    const store = new DictionaryStore(base, user);
    try {
      await store.start(fallbackDict);
      assert.equal(store.current.entries.Save, '保存');
      assert.equal(store.current.templateRules?.length, 1);
      assert.equal(store.current.templateRules?.[0]?.replacement, '已处理 $1 项');
    } finally {
      store.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('P0-3: looksLikeNoise 拦截带斜杠/数字 Tailwind 变体串，且不误伤正常小写英文短语', () => {
  const tailwindNoise = [
    'group-hover/plugin-row:pr-8 group-focus-within/plugin-row:pr-8',
    'pr-2 group-hover/header:pr-16 group-focus-within/header:pr-16',
  ];
  for (const s of tailwindNoise) {
    assert.equal(looksLikeNoise(s), true, `应判为 Tailwind 噪声：${s}`);
  }
  const normalPhrases = ['any time', 'add note', 'Add note', 'Any time', 'git pull'];
  for (const s of normalPhrases) {
    assert.equal(looksLikeNoise(s), false, `不应误杀正常英文短语：${s}`);
  }
});

test('P2-3: runtime/engine.js 与 dist/dictionary.js 的 hasNestedQuantifiedGroup 跨端行为 100% 一致', async () => {
  const { runInNewContext } = await import('node:vm');
  const { hasNestedQuantifiedGroup: distHasNested } = await import('../dist/dictionary.js');
  const engineSrc = await readFile(fileURLToPath(new URL('../runtime/engine.js', import.meta.url)), 'utf8');
  const match = engineSrc.match(
    /function isRepeatableBraceQuantifier\([\s\S]*?\n  function hasNestedQuantifiedGroup\([\s\S]*?\n  \}\r?\n(?=\s*function compileDeclarativeTemplateRules)/
  );
  assert.ok(match, 'runtime/engine.js 中应存在 isRepeatableBraceQuantifier 与 hasNestedQuantifiedGroup');
  const { hasNestedQuantifiedGroup: runtimeHasNested } = runInNewContext(`${match[0]}; ({ hasNestedQuantifiedGroup })`);
  assert.equal(typeof runtimeHasNested, 'function');

  const cases = [
    // 正例（存在嵌套量词 ReDoS 风险，预期 true）
    ['^((?:a+)+)+$', true],
    ['^([a-z]+(\\s+[a-z]+)+)+$', true],
    ['^((a*)*)$', true],
    ['^(a{1,3}){2,}$', true],
    ['^(a+){2}$', true],
    ['^(a+){1,}$', true],
    ['^(a+)?$', true],
    ['^(?:[a-z]+\\s*)+$', true],
    ['^((a{2})+)$', true],
    ['^(?:\\d+)+$', true],
    ['^([\\(\\)a]+)+$', true],
    // 反例（安全正则与边界转义/字符类，预期 false）
    ['^Synced\\s+(\\d+)\\s+workspaces?$', false],
    ['^([a-z+]+)\\s+(\\d+)$', false],
    ['^([a-z*]+)\\s+(a\\+)+$', false],
    ['^(a){1}$', false],
    ['^(a{0,1})+$', false],
    ['^\\((a+)\\)+$', false],
    ['^([\\(\\)a]+)\\s+(\\d+)$', false],
    ['^Processed\\s+(\\d+)\\s+items?$', false],
    ['^(\\d+)(m|h|d|w|mo|y)$', false],
    ['^([a-z]{1,1})$', false],
  ];

  for (const [pattern, expected] of cases) {
    const distResult = distHasNested(pattern);
    const runtimeResult = runtimeHasNested(pattern);
    assert.equal(distResult, expected, `dist hasNestedQuantifiedGroup("${pattern}") 预期 ${expected}`);
    assert.equal(runtimeResult, expected, `runtime hasNestedQuantifiedGroup("${pattern}") 预期 ${expected}`);
    assert.equal(runtimeResult, distResult, `跨端结果不一致：${pattern}`);
  }
});

test('P1-34 & P1-36: 2.34.0 新增词条与模板规则有效，且 proxy.err.* 中英文键与占位符完全对齐', async () => {
  const dict = JSON.parse(await readFile(fileURLToPath(new URL('../dict/base.json', import.meta.url)), 'utf8'));
  const required234Keys = [
    'Enable Word Wrap',
    'Disable Word Wrap',
    'In System Settings, click {0}, choose {1}, then turn it on.',
    'In System Settings, click {0}, choose {1}, then turn it on. Already on? Select {2}, click {3}, then click {4} and add it again.',
    "In System Settings, turn on {0}. If it isn't in the list, drag it in from the small window next to System Settings.",
    "In System Settings, turn on {0}. If it isn't in the list, drag it in from the small window next to System Settings. Already on? Select {1}, click {2}, then drag it back in from the small window.",
  ];
  for (const key of required234Keys) {
    assert.equal(typeof dict[key], 'string', `dict/base.json 应包含 2.34.0 词条：${key}`);
    assert.match(dict[key], /[\u4e00-\u9fff]/, `2.34.0 词条译文应含中文：${key}`);
  }

  const engineSrc = await readFile(fileURLToPath(new URL('../runtime/engine.js', import.meta.url)), 'utf8');
  for (const ruleKey of [
    'Relaunch {app} to finish Screen Recording.',
    'Show {count} more subagents',
    'Enable Word Wrap ({shortcut})',
    'Disable Word Wrap ({shortcut})',
    'Toggle Word Wrap ({shortcut})',
    'Failed to save settings: {reason}',
    'Failed to save project settings: {reason}',
    'Configure {server}',
  ]) {
    assert.ok(engineSrc.includes(ruleKey), `runtime/engine.js 应包含 2.34.0 规则：${ruleKey}`);
  }

  const zh = JSON.parse(await readFile(fileURLToPath(new URL('../assets/i18n/zh-Hans.json', import.meta.url)), 'utf8'));
  const en = JSON.parse(await readFile(fileURLToPath(new URL('../assets/i18n/en.json', import.meta.url)), 'utf8'));
  const proxyKeys = [
    'proxy.err.url_must_be_string',
    'proxy.err.url_empty',
    'proxy.err.url_invalid_chars',
    'proxy.err.url_invalid',
    'proxy.err.unsupported_scheme_named',
    'proxy.err.unsupported_scheme',
    'proxy.err.missing_host',
    'proxy.err.disallowed_path_query_fragment',
    'proxy.err.missing_port',
    'proxy.err.invalid_host_port',
    'proxy.err.invalid_port',
    'proxy.err.invalid_mode',
    'proxy.err.manual_url_must_be_string',
  ];
  const ph = (s) => (s.match(/\{[a-zA-Z0-9_.-]+\}/g) ?? []).sort().join('|');
  for (const k of proxyKeys) {
    assert.equal(typeof zh.backend[k], 'string', `zh-Hans.json 缺少 ${k}`);
    assert.equal(typeof en.backend[k], 'string', `en.json 缺少 ${k}`);
    assert.match(zh.backend[k], /[\u4e00-\u9fff]/, `zh-Hans.json.${k} 应为中文`);
    assert.equal(ph(zh.backend[k]), ph(en.backend[k]), `${k} 占位符应完全一致`);
  }
});

test('P2-17 ~ P2-22: 语言包补齐、HUD 三方同步、template 上下文、setBaseDir 重建监听与 engine.js 更新防交错', async () => {
  const [zhRaw, enRaw, engineSrc, hudMod] = await Promise.all([
    readFile(fileURLToPath(new URL('../assets/i18n/zh-Hans.json', import.meta.url)), 'utf8'),
    readFile(fileURLToPath(new URL('../assets/i18n/en.json', import.meta.url)), 'utf8'),
    readFile(fileURLToPath(new URL('../runtime/engine.js', import.meta.url)), 'utf8'),
    import('../runtime/hud-i18n.js'),
  ]);
  const zh = JSON.parse(zhRaw);
  const en = JSON.parse(enRaw);

  // P2-17: quota.standalone.daily_known
  assert.equal(zh.backend['quota.standalone.daily_known'], '{shortLabel} 每日配额已取得（剩余 {pct}%）');
  assert.equal(en.backend['quota.standalone.daily_known'], '{shortLabel} daily quota retrieved ({pct}% remaining)');

  // P2-18: snapshot(s) 单复数修复
  assert.equal(en.app['overview.ssh.companion_offline_suffix'], ' ({count} offline snapshot(s))');

  // P2-20: candidate.kind.template 映射与双语词条
  assert.equal(zh.backend['candidate.kind.template'], '模板');
  assert.equal(en.backend['candidate.kind.template'], 'Template');
  assert.match(describeContext({ route: '/settings', kind: 'template' }), /模板|Template/);

  // P2-21: engine.js updateGeneration 与大小写不敏感匹配
  assert.ok(engineSrc.includes('let updateGeneration = 0;'), 'engine.js 应维护 updateGeneration 令牌');
  assert.ok(engineSrc.includes("brand.toLowerCase() === 'claude and gpt'"), 'engine.js 应使用大小写不敏感的 Claude and GPT 判断');

  // P2-22: HUD_I18N 与语言包三方 100% 对齐，且确认废弃的 7 个 hud key 与 10 个 OAuth key 已清理
  assert.deepEqual(hudMod.HUD_I18N['zh-Hans'], zh.hud);
  assert.deepEqual(hudMod.HUD_I18N.en, en.hud);
  for (const deadHud of ['lblStageSectionOrchestrator', 'stageRolePlanner', 'stageCompactionBadge', 'ariaContextSessionCompNote']) {
    assert.equal(deadHud in zh.hud, false);
    assert.equal(deadHud in en.hud, false);
  }
  assert.equal('add_account.google_title' in zh.app, false);
  assert.equal('add_account.google_title' in en.app, false);

  // P2-19: DictionaryStore.setBaseDir 切换目录后重建 watcher 并能响应新目录热更新
  const dir = await mkdtemp(join(tmpdir(), 'gb-p2-19-'));
  try {
    const baseA = join(dir, 'base-a');
    const baseB = join(dir, 'base-b');
    await mkdir(baseA, { recursive: true });
    await mkdir(baseB, { recursive: true });
    await writeFile(join(baseA, 'base.json'), JSON.stringify({ Open: '打开' }));
    await writeFile(join(baseB, 'base.json'), JSON.stringify({ Open: '开启' }));
    const store = new DictionaryStore(baseA);
    await store.start();
    try {
      assert.equal(store.current?.entries.Open, '打开');
      await store.setBaseDir(baseB);
      assert.equal(store.current?.entries.Open, '开启');
      const updated = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('setBaseDir 后新目录变更未触发 watcher 热更新')), 2500);
        store.once('updated', (next) => {
          clearTimeout(timer);
          resolve(next);
        });
      });
      await writeFile(join(baseB, 'base.json'), JSON.stringify({ Open: '立即开启' }));
      const nextDict = await updated;
      assert.equal(nextDict.entries.Open, '立即开启');
    } finally {
      store.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('模板规则双向隔离、实体槽位收紧、全量语料碰撞门禁与 JSX 内联组提取校验', async () => {
  const [engineSrc, uiRaw, dictRaw] = await Promise.all([
    readFile(fileURLToPath(new URL('../runtime/engine.js', import.meta.url)), 'utf8'),
    readFile(fileURLToPath(new URL('../ui-strings/2.34.0.json', import.meta.url)), 'utf8'),
    readFile(fileURLToPath(new URL('../dict/base.json', import.meta.url)), 'utf8'),
  ]);
  const ui = JSON.parse(uiRaw);
  const dict = JSON.parse(dictRaw);

  // 1. validateTemplateRules 拒绝非内联规则在 replacement 中注入 {0} 占位符
  const filteredRules = validateTemplateRules([
    { key: 'Configure {server}', pattern: '^Configure\\s+(.+)$', replacement: '配置 {0}' },
    { key: 'Safe {0} rule', pattern: '^Safe\\s+\\{0\\}\\s+rule$', replacement: '安全 {0} 规则' },
  ]);
  assert.equal(filteredRules.length, 1);
  assert.equal(filteredRules[0].key, 'Safe {0} rule');

  // 2. 直接执行 runtime/engine.js 中的 TEMPLATE_RULES + isEntityNameSlot 校验全量语料防碰撞
  const startIdx = engineSrc.indexOf('const ENTITY_PROSE_STOP_WORDS =');
  const endIdx = engineSrc.indexOf('function translateKeybindingExamples');
  assert.ok(startIdx > 0 && endIdx > startIdx, 'runtime/engine.js 应包含 ENTITY_PROSE_STOP_WORDS 与 TEMPLATE_RULES');
  const snippet = engineSrc.slice(startIdx, endIdx);
  const rules = new Function(
    'MODEL_GROUP_LABEL', 'formatDuration', 'nestedLabel', 'entryFor', 'isRelativeTimeBadge', 'isElapsedDurationNode', 'translateKeybindingExamples',
    `${snippet}\nfor (const r of TEMPLATE_RULES) r.inlineOnly = /\\{\\d+\\}/.test(r.key);\nreturn TEMPLATE_RULES;`
  )(/^Models within this group:\s*(.*)$/i, d => d, s => s, () => undefined, () => false, () => false, s => s);

  const matchWithRules = (text) => {
    const hasInlineSlot = /\{\d+\}/.test(text);
    for (const rule of rules) {
      if (Boolean(rule.inlineOnly) !== hasInlineSlot) continue;
      const m = text.match(rule.pattern);
      if (!m) continue;
      if (rule.guard && !rule.guard(null, m)) continue;
      const replaced = text.replace(rule.pattern, rule.replace);
      if (!hasInlineSlot && /\{\d+\}/.test(replaced)) continue;
      return { key: rule.key, replaced };
    }
    return null;
  };

  // 2a. Configure {server} 必须匹配短实体名，但绝不匹配完整英文长句或含 {0} 的内联组
  assert.equal(matchWithRules('Configure chrome-devtools')?.replaced, '配置 chrome-devtools');
  assert.equal(matchWithRules('Configure what the agent can do in local and remote conversations.'), null);
  assert.equal(matchWithRules('Configure what the agent can do in local and remote conversations. {0}.'), null);
  assert.equal(matchWithRules('Configure global allowed and denied resource permissions. {0}.'), null);
  assert.equal(matchWithRules('Configure default behaviors, skills, and MCP servers. {0}.'), null);

  const folded = new Map();
  for (const [k, v] of Object.entries(dict)) {
    const f = foldDictionaryKey(k);
    if (!folded.has(f)) folded.set(f, v);
  }

  // 2b. 全量 2.34.0 非 template/fragment 句子及其合成 {0}. 变体：任何非 inlineOnly 规则都不得命中 {0} 串，也不得吞噬完整英文长句或未收录词条
  for (const row of ui.strings) {
    if (row.kinds?.includes('template') || row.kinds?.includes('fragment')) continue;
    const syntheticInline = `${row.text} {0}.`;
    const inlineHit = matchWithRules(syntheticInline);
    if (inlineHit) {
      const matchedRule = rules.find(r => r.key === inlineHit.key);
      assert.equal(matchedRule?.inlineOnly, true, `非 inlineOnly 规则 ${inlineHit.key} 不得匹配内联串：${syntheticInline}`);
    }
    const plainHit = matchWithRules(row.text);
    if (plainHit && plainHit.key === 'Configure {server}') {
      assert.equal(folded.has(foldDictionaryKey(row.text)), true, `Configure {server} 不应命中未收录静态句：${row.text}`);
      assert.equal(/[.?!]/.test(row.text), false, `Configure {server} 不应吞噬带标点完整句：${row.text}`);
    }
  }

  // 3. extract-inline-groups-ast.mjs 提取与槽位布局校验
  const sampleJsx = `
    const A = E.createElement("span", null, ua ? "Configure what the agent can do in local and remote conversations." : "Configure global allowed and denied resource permissions.", " ", E.createElement("a", { href: "#" }, "Learn more"), ".");
    const B = _jsx("p", { children: ["Visit ", _jsx("a", { href: "#", children: "Legal Help" }), " for info."] });
    const C = E.createElement("div", null, "Plain text ", cond && E.createElement(E.Fragment, null, E.createElement("a", { href: "#" }, "Learn more"), "."));
  `;
  const extracted = extractInlineGroupsAst(sampleJsx).map(x => x.text);
  assert.ok(extracted.includes('Configure what the agent can do in local and remote conversations. {0}.'));
  assert.ok(extracted.includes('Configure global allowed and denied resource permissions. {0}.'));
  assert.ok(extracted.includes('Visit {0} for info.'));
  assert.ok(extracted.includes('Plain text {0}.'));

  assert.equal(validateInlineSlotLayout('Gronk {0}', '{0}，请阅读').ok, false);
  assert.equal(validateInlineSlotLayout('Blorp {0} zib {1}.', '先 {1}，再 {0}。').ok, false);
  assert.equal(validateInlineSlotLayout('Configure {0}.', '配置 {0}。').ok, true);
  assert.equal(inlineSlotViolations(dict).length, 0, 'dict/base.json 不应存在内联槽位布局违规');

  assert.equal(resolveInlineGroupCoverage('Configure what the agent can do in local and remote conversations. {0}.', folded).mode, 'compositional');
  assert.equal(resolveInlineGroupCoverage('This Google Cloud project is not supported. Input a different project, or sign in with another account. {0}', folded).mode, 'compositional');
  assert.equal(resolveInlineGroupCoverage('Are you sure you want to delete {0}? This action cannot be undone.', folded).mode, 'compositional');
});
});
