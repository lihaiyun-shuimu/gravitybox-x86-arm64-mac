import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Script, runInNewContext } from 'node:vm';

/**
 * 由 runtime/ 合并生成到 dist/ 的产物（无 src/*.ts 对应）。
 * tools/clean-dist.mjs 必须保留这些文件，不能当作孤儿删除。
 */
export const GENERATED_DIST_FILES = ['engine.js'];

const HUD_RUNTIME_FILES = [
  'hud-i18n.js',
  'hud-styles.js',
  'hud-popover.js',
  'hud-instance.js',
  'hud-manager.js',
];

/**
 * 将支持 Node.js ESM import 的 runtime/hud-*.js 转换为可在 CDP Isolated World 经典脚本上下文直接执行的 IIFE
 */
function stripEsmForClassicRuntime(code) {
  return code
    .replace(/^\s*import\s+[^;]*?from\s+['"][^'"]+['"];?\s*$/gm, '')
    .replace(/^\s*export\s+(?=(?:async\s+function|const|let|var|function|class)\s+)/gm, '')
    .replace(/^\s*export\s*\{[^}]*\};?\s*$/gm, '');
}

async function loadAndSyncHudI18n(rawHudI18nSource) {
  const normalizedSource = rawHudI18nSource.replace(/\r\n/g, '\n');
  const [zhJsonRaw, enJsonRaw] = await Promise.all([
    readFile(new URL('../assets/i18n/zh-Hans.json', import.meta.url), 'utf8'),
    readFile(new URL('../assets/i18n/en.json', import.meta.url), 'utf8'),
  ]);
  const jsonHud = {
    'zh-Hans': JSON.parse(zhJsonRaw)?.hud ?? {},
    en: JSON.parse(enJsonRaw)?.hud ?? {},
  };
  const sandbox = {};
  const evalCode = stripEsmForClassicRuntime(normalizedSource).replace(
    /\bconst\s+(HUD_FALLBACK_LOCALE|HUD_I18N)\b/g,
    'var $1'
  );
  runInNewContext(evalCode, sandbox, { filename: 'hud-i18n-sync-check.js' });
  const runtimeHud = sandbox.HUD_I18N ?? {};
  for (const locale of ['zh-Hans', 'en']) {
    const expected = jsonHud[locale];
    const actual = runtimeHud[locale] ?? {};
    const expectedKeys = Object.keys(expected).sort();
    const actualKeys = Object.keys(actual).sort();
    if (
      expectedKeys.length === 0 ||
      expectedKeys.length !== actualKeys.length ||
      expectedKeys.some((key, index) => key !== actualKeys[index] || expected[key] !== actual[key])
    ) {
      throw new Error(
        `runtime/hud-i18n.js (${locale}) 与 assets/i18n/${locale}.json#hud 不一致，请先同步双源 HUD 词条`
      );
    }
  }
  const hudLiteral = JSON.stringify(jsonHud, null, 2);
  const replaced = normalizedSource.replace(
    /export\s+const\s+HUD_I18N\s*=\s*\{[\s\S]*?\n\};/,
    `export const HUD_I18N = ${hudLiteral};`
  );
  if (!replaced.includes(hudLiteral)) {
    throw new Error('未能在 runtime/hud-i18n.js 中定位 HUD_I18N 注入点');
  }
  return replaced;
}

export async function copyRuntime(distUrl = new URL('../dist/', import.meta.url)) {
  const baseSources = await Promise.all(
    ['engine.js', 'deep-scan.js'].map((name) =>
      readFile(new URL('../runtime/' + name, import.meta.url), 'utf8')
    )
  );
  const hudSources = await Promise.all(
    HUD_RUNTIME_FILES.map(async (name) => {
      const raw = await readFile(new URL('../runtime/' + name, import.meta.url), 'utf8');
      const synced = name === 'hud-i18n.js' ? await loadAndSyncHudI18n(raw) : raw;
      return stripEsmForClassicRuntime(synced);
    })
  );
  const formatSource = stripEsmForClassicRuntime(await readFile(new URL('metric-format.js', distUrl), 'utf8'));
  const hudBundle = `(function bootstrapGravityBoxHud() {\n'use strict';\n${formatSource}\n${hudSources.join('\n')}\n})();`;
  const mergedSource = [...baseSources, hudBundle].join('\n');
  new Script(mergedSource, { filename: 'GravityBox-runtime.js' });
  await writeFile(new URL('engine.js', distUrl), mergedSource);
}

function isDirectEntry() {
  if (!process.argv[1]) return false;
  if (process.platform === 'win32') {
    return resolve(process.argv[1]).toLowerCase() === resolve(fileURLToPath(import.meta.url)).toLowerCase();
  }
  return import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectEntry()) await copyRuntime();
