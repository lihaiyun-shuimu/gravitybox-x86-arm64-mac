import { readdir, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export function selectTestFiles(entries, mode = 'all') {
  if (!['all', 'native', 'fast'].includes(mode)) throw new Error(`未知测试范围：${mode}`);
  return entries.filter(name => name.endsWith('.test.mjs'))
    .filter(name => mode === 'all' || name.startsWith('native-') === (mode === 'native'))
    .sort().map(name => join('test', name));
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some(arg => !['--native', '--fast'].includes(arg))) {
    throw new Error('用法：node tools/run-tests.mjs [--native | --fast]');
  }
  const mode = args[0]?.slice(2) ?? 'all';
  let selected = selectTestFiles(await readdir(join(root, 'test')), mode);
  if (selected.length === 0) throw new Error(`未找到匹配的测试文件（mode=${mode}）`);

  if (process.platform === 'win32') {
    if (mode === 'native') {
      process.stdout.write('[run-tests] Windows 环境无 macOS Swift 工具链，跳过 macOS native-*.test.mjs\n');
      return;
    }
    if (mode === 'all') {
      const macNative = selected.filter(file => basename(file).startsWith('native-'));
      if (macNative.length > 0) {
        process.stdout.write(`[run-tests] Windows 环境自动跳过 ${macNative.length} 个 macOS Swift 原生测试（native-*.test.mjs）\n`);
        selected = selected.filter(file => !basename(file).startsWith('native-'));
      }
      if (selected.length === 0) throw new Error(`未找到匹配的测试文件（mode=${mode}）`);
    }
  }

  const child = spawn(process.execPath, ['--test', ...selected], { cwd: root, stdio: 'inherit' });
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`测试被 ${signal} 中断`));
      else resolve(code ?? 1);
    });
  });
}

const entryPath = process.argv[1] ? await realpath(process.argv[1]).catch(() => null) : null;
const selfPath = await realpath(fileURLToPath(import.meta.url)).catch(() => fileURLToPath(import.meta.url));
const isMain = Boolean(
  entryPath && (
    process.platform === 'win32'
      ? entryPath.toLowerCase() === selfPath.toLowerCase()
      : import.meta.url === pathToFileURL(entryPath).href
  )
);
if (isMain) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
