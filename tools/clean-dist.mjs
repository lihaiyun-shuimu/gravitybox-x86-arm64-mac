import { readdir, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { GENERATED_DIST_FILES } from './copy-runtime.mjs';

/**
 * dist 孤儿清理：删除 `dist/**` 中「没有同名 src/**\/*.ts 对应」且不在白名单里的 TypeScript 编译产物（.js / .js.map / .d.ts / .d.ts.map）。
 * - 白名单只放构建期生成物（engine.js 由 tools/copy-runtime.mjs 生成），非编译期资源文件不会被触碰。
 * - 默认 dry-run 之外的行为只有删除孤儿；缺失 src/dist 目录时视为无孤儿，不报错。
 */
const defaultRoot = fileURLToPath(new URL('../', import.meta.url));
const DIST_ARTIFACT_RE = /\.(?:js|d\.ts)(?:\.map)?$/;

function toJsStem(file) {
  return file.replace(/\.(?:js\.map|d\.ts\.map|d\.ts)$/, '.js');
}

async function listFiles(dir) {
  const result = [];
  async function walk(relative = '') {
    let entries;
    try { entries = await readdir(join(dir, relative), { withFileTypes: true }); }
    catch (error) { if (error?.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const next = relative ? join(relative, entry.name) : entry.name;
      if (entry.isDirectory()) await walk(next);
      else if (entry.isFile()) result.push(next.split('\\').join('/'));
    }
  }
  await walk();
  return result;
}

export async function planDistCleanup({ projectRoot = defaultRoot, srcDir = 'src', distDir = 'dist', whitelist = GENERATED_DIST_FILES } = {}) {
  const srcFiles = (await listFiles(join(projectRoot, srcDir))).filter(file => file.endsWith('.ts'));
  const expected = new Set(srcFiles.map(file => file.replace(/\.ts$/, '.js')));
  const keep = new Set(whitelist);
  const distFiles = (await listFiles(join(projectRoot, distDir))).filter(file => DIST_ARTIFACT_RE.test(file));
  const orphans = distFiles.filter(file => {
    const stemJs = toJsStem(file);
    return !expected.has(stemJs) && !keep.has(file) && !keep.has(stemJs);
  }).sort();
  return { expected: [...expected].sort(), whitelist: [...keep], orphans };
}

export async function cleanDist(options = {}) {
  const plan = await planDistCleanup(options);
  const projectRoot = options.projectRoot ?? defaultRoot;
  const distDir = options.distDir ?? 'dist';
  for (const relative of plan.orphans) {
    await rm(join(projectRoot, distDir, ...relative.split('/')), { force: true, maxRetries: 3, retryDelay: 50 });
  }
  return { ...plan, removed: plan.orphans };
}

function isDirectEntry() {
  if (!process.argv[1]) return false;
  if (process.platform === 'win32') {
    return resolve(process.argv[1]).toLowerCase() === resolve(fileURLToPath(import.meta.url)).toLowerCase();
  }
  return import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectEntry()) {
  const dryRun = process.argv.includes('--dry-run');
  const plan = dryRun ? await planDistCleanup() : await cleanDist();
  if (!plan.orphans.length) process.stdout.write('dist 与 src 对应，无孤儿文件\n');
  else for (const file of plan.orphans) process.stdout.write(`${dryRun ? '将清理' : '已清理'} dist/${file}（无 src 对应）\n`);
}
