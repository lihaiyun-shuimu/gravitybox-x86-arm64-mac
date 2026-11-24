import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { cpus } from 'node:os';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const run = promisify(execFile);

/** Release builds use -O -whole-module-optimization; UI harness defaults to -Onone for fast iteration. */
export async function nativeBuildArgs(root, output, { uiTest = false, typecheck = false, optimize = !uiTest } = {}) {
  const sources = (await readdir(join(root, 'native')))
    .filter(name => name.endsWith('.swift')).sort().map(name => join(root, 'native', name));
  const threads = String(Math.max(2, Math.min(16, cpus().length || 4)));
  const modeFlags = typecheck
    ? ['-typecheck']
    : (optimize
      ? ['-O', '-whole-module-optimization', '-num-threads', threads]
      : ['-Onone', '-num-threads', threads]);
  return [
    ...modeFlags,
    ...(uiTest ? ['-D', 'NATIVE_UI_TEST'] : []),
    '-parse-as-library', '-target', 'arm64-apple-macosx14.0',
    ...['Cocoa', 'ServiceManagement', 'Security', 'ApplicationServices', 'CFNetwork'].flatMap(name => ['-framework', name]),
    ...sources,
    ...(uiTest ? [join(root, 'test/native-ui.swift')] : []),
    ...(typecheck || !output ? [] : ['-o', output]),
  ];
}

async function hashCommonSwiftInputs(hash, root) {
  try {
    const { stdout } = await run('/usr/bin/swiftc', ['--version'], { cwd: root });
    hash.update(`swiftc:${stdout.trim()}\n`);
  } catch {
    hash.update('swiftc:unknown\n');
  }
  const buildScript = await readFile(join(root, 'tools/native-build.mjs'));
  hash.update('tools/native-build.mjs\0').update(buildScript);
  const sources = (await readdir(join(root, 'native')))
    .filter(name => name.endsWith('.swift')).sort();
  for (const name of sources) {
    hash.update(`native/${name}\0`).update(await readFile(join(root, 'native', name)));
  }
}

/** 计算 Swift 原生发布构建的全部输入指纹，用于跳过未变更时的重复全量重编。 */
export async function computeSwiftInputsDigest(root) {
  const hash = createHash('sha256');
  await hashCommonSwiftInputs(hash, root);
  return hash.digest('hex');
}

/** 计算原生 UI 夹具（含 test/native-ui.swift）的编译输入指纹，支持区分 uiTest-Onone / uiTest-O。 */
export async function computeUiTestSwiftInputsDigest(root, { optimize = false } = {}) {
  const hash = createHash('sha256');
  hash.update(`mode:${optimize ? 'uiTest-O' : 'uiTest-Onone'}\n`);
  await hashCommonSwiftInputs(hash, root);
  hash.update('test/native-ui.swift\0').update(await readFile(join(root, 'test/native-ui.swift')));
  return hash.digest('hex');
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const uiTest = process.argv.includes('--ui-test');
  const typecheck = process.argv.includes('--typecheck');
  if (!typecheck) {
    console.error('用法: node tools/native-build.mjs --typecheck [--ui-test]');
    process.exit(1);
  }
  const started = performance.now();
  const args = await nativeBuildArgs(root, undefined, { typecheck: true, uiTest });
  await run('/usr/bin/swiftc', args, { cwd: root, maxBuffer: 4e6 });
  console.log(`Swift 类型检查通过（${((performance.now() - started) / 1000).toFixed(2)} 秒）`);
}
