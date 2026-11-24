import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cleanDist } from './clean-dist.mjs';
import { copyRuntime } from './copy-runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const tscBin = join(root, 'node_modules', 'typescript', 'bin', 'tsc');

function runOnce(args) {
  return new Promise((resolveDone, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolveDone();
      else reject(new Error(`Command exited with code ${code ?? 1}: ${args.join(' ')}`));
    });
  });
}

function watchRuntimeSources() {
  const watchers = [];
  let timer = null;
  const trigger = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      timer = null;
      try {
        await copyRuntime();
        process.stdout.write('[dev:backend] runtime/i18n 已同步重建 dist/engine.js\n');
      } catch (error) {
        process.stderr.write(`[dev:backend] 重建 dist/engine.js 失败: ${error?.message ?? error}\n`);
      }
    }, 200);
  };
  for (const dir of [join(root, 'runtime'), join(root, 'assets', 'i18n')]) {
    try {
      watchers.push(watch(dir, trigger));
    } catch {
      // ignore unavailable watcher
    }
  }
  return () => {
    if (timer) clearTimeout(timer);
    for (const w of watchers) {
      try { w.close(); } catch {}
    }
  };
}

async function main() {
  const passthroughArgs = process.argv.slice(2);
  process.stdout.write('[dev:backend] 执行首次编译...\n');
  await cleanDist();
  await runOnce([tscBin]);
  await copyRuntime();

  const stopRuntimeWatch = watchRuntimeSources();
  const tscWatch = spawn(process.execPath, [tscBin, '--watch', '--preserveWatchOutput'], {
    cwd: root,
    stdio: 'inherit',
  });
  const backendWatch = spawn(
    process.execPath,
    ['--watch', '--watch-preserve-output', join(root, 'dist', 'main.js'), ...passthroughArgs],
    {
      cwd: root,
      stdio: 'inherit',
    },
  );

  process.stdout.write('[dev:backend] 热重载已启动：修改 src/*.ts 自动编译并重启 dist/main.js；修改 runtime/ 自动刷新 dist/engine.js\n');

  let shuttingDown = false;
  const shutdown = (exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopRuntimeWatch();
    for (const child of [backendWatch, tscWatch]) {
      try { child.kill('SIGTERM'); } catch {}
    }
    setTimeout(() => process.exit(exitCode), 150).unref();
  };

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));

  tscWatch.once('exit', (code) => {
    if (!shuttingDown) {
      process.stderr.write(`[dev:backend] tsc --watch 退出 (code=${code ?? 'null'})\n`);
      shutdown(code ?? 1);
    }
  });
  backendWatch.once('exit', (code) => {
    if (!shuttingDown) {
      process.stderr.write(`[dev:backend] node --watch 退出 (code=${code ?? 'null'})\n`);
      shutdown(code ?? 1);
    }
  });
}

function isDirectEntry() {
  if (!process.argv[1]) return false;
  if (process.platform === 'win32') {
    return resolve(process.argv[1]).toLowerCase() === resolve(fileURLToPath(import.meta.url)).toLowerCase();
  }
  return import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectEntry()) {
  main().catch((error) => {
    process.stderr.write(`[dev:backend] 启动失败: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}
