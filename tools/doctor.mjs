import { existsSync, chmodSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const setup = process.argv.includes('--setup');
const install = setup || process.argv.includes('--install');
const skipNative = process.argv.includes('--skip-native');
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
if (!process.versions.node.startsWith('22.')) {
  process.stderr.write('开发需要 Node 22。当前应用已自带运行环境，日常使用不受影响。\n');
  process.exit(1);
}

function runNpm(args) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && existsSync(npmExecPath)) {
    execFileSync(process.execPath, [npmExecPath, ...args], { cwd: root, stdio: 'inherit' });
    return;
  }
  if (isWin) {
    execFileSync('cmd.exe', ['/d', '/s', '/c', 'npm', ...args], { cwd: root, stdio: 'inherit' });
    return;
  }
  execFileSync('npm', args, { cwd: root, stdio: 'inherit' });
}

if (install && !existsSync(join(root, 'node_modules/typescript/bin/tsc'))) {
  runNpm(['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
}

let ready = true;
const requiredFiles = [
  'package-lock.json',
  'node_modules/typescript/bin/tsc',
  'runtime/engine.js',
  ...(isMac ? ['native/Assistant.swift'] : []),
];
for (const file of requiredFiles) {
  if (!existsSync(join(root, file))) {
    ready = false;
    process.stderr.write('缺少：' + file + '\n');
  }
}

const bundleSource = await readFile(join(root, 'src/bundle.ts'), 'utf8');
const bundleBlock = bundleSource.match(/export const SUPPORTED_BUNDLES\s*=\s*new Map\(\[([\s\S]*?)\]\);/)?.[1] ?? '';
for (const [, supportedVersion] of bundleBlock.matchAll(/\['(\d+\.\d+\.\d+)'\s*,/g)) {
  const dictFile = `ui-strings/${supportedVersion}.json`;
  if (!existsSync(join(root, dictFile))) {
    ready = false;
    process.stderr.write(`缺少已收录版本词典：${dictFile}\n`);
  }
}

const hasWinRustProjects = isWin && (
  existsSync(join(root, 'windows', 'win-helper', 'Cargo.toml')) ||
  existsSync(join(root, 'windows', 'app', 'src-tauri', 'Cargo.toml'))
);

if (!skipNative) {
  if (isMac) {
    try {
      execFileSync('/usr/bin/xcrun', ['--find', 'swiftc'], { stdio: 'pipe' });
    } catch {
      ready = false;
      process.stderr.write('缺少 Apple 命令行开发工具。\n');
    }
  } else if (isWin && hasWinRustProjects) {
    for (const tool of ['rustc', 'cargo']) {
      try {
        execFileSync(tool, ['--version'], { stdio: 'pipe', windowsHide: true });
      } catch {
        ready = false;
        process.stderr.write(`缺少 Windows 原生构建工具：${tool}（请安装 Rust / MSVC 工具链）。\n`);
      }
    }
  }
}

if (!ready) {
  const hint = isWin
    ? '先运行 npm run setup:dev 准备依赖；缺少 Rust/MSVC 工具链时请安装 rustup 与 Visual Studio C++ 生成工具。\n'
    : '先运行 npm run setup:dev 准备依赖；缺少系统开发工具时按 macOS 提示安装。\n';
  process.stderr.write(hint);
  process.exit(1);
}

// Git pre-commit / pre-push hook 门禁配置
let hooksConfigured = false;
for (const hookName of ['pre-commit', 'pre-push']) {
  const hookPath = join(root, '.githooks', hookName);
  if (setup && existsSync(hookPath)) {
    try { chmodSync(hookPath, 0o755); } catch {}
  }
}
if (existsSync(join(root, '.git'))) {
  try {
    const currentHooks = execFileSync('git', ['config', '--get', 'core.hooksPath'], { cwd: root, stdio: 'pipe', windowsHide: true }).toString().trim();
    hooksConfigured = currentHooks === '.githooks';
  } catch {
    hooksConfigured = false;
  }
  if (!hooksConfigured && setup) {
    try {
      execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root, stdio: 'pipe', windowsHide: true });
      hooksConfigured = true;
      process.stdout.write('已配置 Git 门禁钩子：core.hooksPath = .githooks\n');
    } catch {
      process.stderr.write('配置 Git hooksPath 失败。\n');
    }
  }
}

if (setup) runNpm(['run', 'build']);

const winHelperPresent = isWin && (
  existsSync(join(root, 'windows', 'win-helper', 'target', 'release', 'gravitybox-win-helper.exe')) ||
  existsSync(join(root, 'windows', 'win-helper', 'target', 'debug', 'gravitybox-win-helper.exe'))
);
const extraInfo = isWin && hasWinRustProjects
  ? (winHelperPresent ? '；win-helper 二进制已就绪' : '；提示：运行 cargo build --release --manifest-path windows/win-helper/Cargo.toml 构建 Win32 Helper')
  : '';

process.stdout.write(
  `GravityBox ${version} (${process.platform}/${process.arch}) 开发环境已就绪`
  + `${existsSync(join(root, 'dist/main.js')) ? '，编译输出存在' : '；运行 npm run build 生成编译输出'}`
  + extraInfo
  + `${hooksConfigured ? '；Git 门禁钩子已就绪' : '；提示：运行 npm run setup:dev 可自动启用 Git pre-commit / pre-push 门禁钩子'}。\n`
);
