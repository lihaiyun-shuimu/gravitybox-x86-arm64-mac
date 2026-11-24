import { execFile } from 'node:child_process';
import { cpus } from 'node:os';
import { promisify } from 'node:util';
import { readdir, mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import {
  sourceDigest,
  windowsSourceDigest,
  vendorEvidence,
  collectReleaseArtifacts,
  checkReleaseConsistency,
  renderReleaseConsistency,
  fileSha256,
} from './release-integrity.mjs';
import { describeValidationScope, parseTargetAppVersionArg, recordedScopeFields, resolveValidationScope, VALIDATION_SCOPE_TARGETED } from './release-scope.mjs';
import { computeSwiftInputsDigest, nativeBuildArgs } from './native-build.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), run = promisify(execFile);
const argv = process.argv.slice(2);
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

let failureReported = false;

function npmStepCommand(args) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && existsSync(npmExecPath)) {
    return { binary: process.execPath, args: [npmExecPath, ...args] };
  }
  if (isWin) {
    return { binary: 'cmd.exe', args: ['/d', '/s', '/c', 'npm', ...args] };
  }
  return { binary: 'npm', args };
}

async function reportFailureToStepSummary({ name, binary, args, error, detail, completedSteps = [] }) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  failureReported = true;

  const lines = [
    `## ❌ Release Gate 门禁校验失败: ${name}`,
    '',
    '| 属性 | 详情 |',
    '| --- | --- |',
    `| **失败步骤** | \`${name}\` |`,
    `| **已完成步骤** | ${completedSteps.length > 0 ? completedSteps.map(s => '`' + s + '`').join(', ') : '（首个步骤）'} |`,
    `| **执行程序** | \`${binary}\` |`,
    `| **执行参数** | \`${(args || []).map(a => typeof a === 'string' ? a.replace(root, '.') : a).join(' ')}\` |`,
    `| **退出代码** | \`${error?.code ?? error?.status ?? '非零退出'}\` |`,
    `| **错误摘要** | \`${error?.message ?? '执行失败'}\` |`,
    '',
  ];

  const rawLog = (detail || '').trim();
  if (rawLog) {
    lines.push(
      `### 步骤 \`${name}\` 详细控制台输出`,
      '<details open>',
      `<summary>点击展开 / 折叠 ${name} 完整输出日志</summary>`,
      '',
      '```text',
      rawLog.length > 50000 ? '...(截取后 50KB)...\n' + rawLog.slice(-50000) : rawLog,
      '```',
      '</details>',
      ''
    );
  }

  lines.push('> 💡 **质检提示**：完整质检日志与快照已归档至 GitHub Actions Artifacts 中的 `质检报告`。');

  try {
    await mkdir(dirname(summaryPath), { recursive: true });
    await appendFile(summaryPath, lines.join('\n') + '\n\n', 'utf8');
  } catch (writeErr) {
    process.stderr.write(`[verify] 写入 GITHUB_STEP_SUMMARY 失败: ${writeErr.message}\n`);
  }
}

async function reportGenericErrorToStepSummary(error) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath || failureReported) return;

  const lines = [
    '## ❌ Release Gate 门禁校验异常中断',
    '',
    `**错误信息**: ${error?.message || String(error)}`,
    '',
    '```text',
    error?.stack || String(error),
    '```',
    '',
    '> 💡 **质检提示**：请根据上述异常信息排查构建或环境问题。',
    '',
  ];
  try {
    await mkdir(dirname(summaryPath), { recursive: true });
    await appendFile(summaryPath, lines.join('\n') + '\n\n', 'utf8');
  } catch {}
}

async function reportSuccessToStepSummary({ version, scope, digest, steps }) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;

  const platformLabel = isWin ? 'Windows' : isMac ? 'macOS' : process.platform;
  const lines = [
    `## ✅ Release Gate 门禁校验全部通过 (v${version})`,
    '',
    '| 检查项 | 结果 |',
    '| --- | --- |',
    `| **版本号** | \`v${version}\` |`,
    `| **门禁范围** | ${describeValidationScope(scope)} |`,
    `| **源码指纹** | \`${digest.slice(0, 16)}...\` |`,
    `| **运行环境** | ${platformLabel} (${process.arch}) / Node ${process.version} |`,
    `| **原生 UI 夹具** | ${isWin ? '已按存在情况检查 Windows Rust/Tauri 与前端构建；桌面端交互另行验收' : '默认不运行；按需执行 `npm run test:native-ui`，安装后另行人工验收'} |`,
    '',
    '### 已通过的校验步骤',
    '',
    '| 步骤 | 状态 |',
    '| --- | --- |',
    ...steps.map(s => `| ${s} | ✅ 通过 |`),
    '',
  ];
  try {
    await mkdir(dirname(summaryPath), { recursive: true });
    await appendFile(summaryPath, lines.join('\n') + '\n\n', 'utf8');
  } catch {}
}

/**
 * 发布验证。默认（无 --target-app-version）对全部受支持版本验证冻结提取快照；
 * 存在 vendor 时额外核对官方字节，否则明确使用免 vendor 模式。
 * 只有显式 `--target-app-version <x.y.z>` 才进入定向范围：目标版本作为发布通过条件，其余受支持版本
 * 在输出与 verified-release 中明确记为“本轮未验证”，绝不冒充通过或降低门禁。
 */
async function main() {
  const startedAt = performance.now();
  /* 先做参数格式/重复校验，避免跑完构建才发现 CLI 写错。 */
  const earlyTarget = parseTargetAppVersionArg(argv);
  const dictOnly = argv.includes('--dict-only');
  if (argv.includes('--auto-extract')) throw Error('验证不修改适配输入；请先显式运行 i18n:extract -- --register-bundle，审阅后再验证');
  const initialDigest = await sourceDigest(root);
  const initialWinDigest = isWin ? await windowsSourceDigest(root) : null;
  const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
  const out = join(root, '质检报告', `${version}-改造验收`); await mkdir(out, { recursive: true });
  const completedSteps = [];
  const timings = [];
  if (!dictOnly) {
    if (isWin) {
      process.stdout.write('[verify] Windows 环境自动跳过 macOS Swift 检查，执行 Node 测试与按需 Rust/Tauri 原生检查\n');
    } else {
      process.stdout.write('[verify] 原生 UI 夹具不纳入默认门禁；按需运行 npm run test:native-ui，安装后另行人工验收\n');
    }
  }
  async function step(name, binary, args, { env, cwd } = {}) {
    process.stdout.write(`检查：${name}\n`);
    const started = performance.now();
    try {
      const result = await run(binary, args, {
        cwd: cwd ?? root,
        maxBuffer: 16e6,
        windowsHide: true,
        ...(env ? { env } : {}),
      });
      await writeFile(join(out, `${name}.log`), result.stdout + result.stderr);
      completedSteps.push(name);
      const durationMs = performance.now() - started;
      timings.push({ name, durationMs });
      process.stdout.write(`通过：${name}（${(durationMs / 1000).toFixed(2)} 秒）\n`);
    } catch (error) {
      const detail = String(error.stdout ?? '') + String(error.stderr ?? '');
      await writeFile(join(out, `${name}.log`), detail);
      if (detail.trim()) process.stderr.write(`\n--- [${name} 错误详情] ---\n${detail}\n------------------------\n`);
      await reportFailureToStepSummary({ name, binary, args, error, detail, completedSteps: [...completedSteps] });
      throw new Error(`${name} 未通过，见质检报告`);
    }
  }

  const privacyPromise = step('隐私门禁', process.execPath, [join(root, 'tools/check-privacy.mjs')]);

  let swiftPromise = null;
  if (!dictOnly && isMac) {
    await mkdir(join(root, '.cache'), { recursive: true });
    const swiftBinaryPath = join(root, '.cache/GravityBox-native-verified');
    const swiftMetaPath = join(root, '.cache/GravityBox-native-verified.meta.json');
    const forceSwift = argv.includes('--force-swift') || process.env.GRAVITYBOX_FORCE_SWIFT === '1';
    const swiftInputsDigest = await computeSwiftInputsDigest(root);
    let swiftCacheHit = false;
    if (!forceSwift && existsSync(swiftBinaryPath) && existsSync(swiftMetaPath)) {
      try {
        const meta = JSON.parse(await readFile(swiftMetaPath, 'utf8'));
        if (meta?.swiftInputsDigest === swiftInputsDigest && typeof meta?.binarySha256 === 'string') {
          const actualBinSha = createHash('sha256').update(await readFile(swiftBinaryPath)).digest('hex');
          swiftCacheHit = actualBinSha === meta.binarySha256;
        }
      } catch {
        swiftCacheHit = false;
      }
    }
    if (swiftCacheHit) {
      completedSteps.push('Swift检查');
      timings.push({ name: 'Swift检查', durationMs: 0 });
      process.stdout.write('通过：Swift检查（源码未变更，复用已校验产物）\n');
      swiftPromise = Promise.resolve();
    } else {
      const swiftArgs = await nativeBuildArgs(root, swiftBinaryPath);
      swiftPromise = step('Swift检查', '/usr/bin/swiftc', swiftArgs).then(async () => {
        const binarySha256 = createHash('sha256').update(await readFile(swiftBinaryPath)).digest('hex');
        await writeFile(swiftMetaPath, JSON.stringify({ swiftInputsDigest, binarySha256, at: new Date().toISOString() }, null, 2) + '\n');
      });
    }
  }

  await step('清理孤儿构建产物', process.execPath, [join(root, 'tools/clean-dist.mjs')]);
  await step('构建', process.execPath, [join(root, 'node_modules/typescript/bin/tsc')]);
  await step('运行时', process.execPath, [join(root, 'tools/copy-runtime.mjs')]);
  await step('价格资产', process.execPath, [join(root, 'tools/sync-pricing-feed.mjs')]);

  const { SUPPORTED_BUNDLES } = await import(pathToFileURL(join(root, 'dist', 'bundle.js')).href);
  const supportedVersions = [...SUPPORTED_BUNDLES.keys()];
  const scope = resolveValidationScope(argv, supportedVersions);
  if (earlyTarget !== undefined && !scope.targetAppVersions.includes(earlyTarget)) throw new Error(`内部错误：目标版本 ${earlyTarget} 未进入验证范围`);
  process.stdout.write(`[verify] ${describeValidationScope(scope)}\n`);

  /* 只有本次发布范围内（定向=目标版本；默认=全部受支持版本）的提取结果与门禁才是通过条件。
     默认全量校验仅对最新目标版本校验本地 vendor 字节（其余历史冻结版本并发走轻量模式，除非显式传 --full-vendor）。 */
  const extracted = new Set((await readdir(join(root, 'ui-strings'))).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5)));
  const uncovered = scope.targetAppVersions.filter(targetVersion => !extracted.has(targetVersion));
  if (uncovered.length) throw new Error(`词典门禁缺少界面串提取：${uncovered.join('、')}；请先运行 node tools/extract-ui-strings.mjs --version <版本>`);
  const noVendor = argv.includes('--no-vendor') || process.env.GRAVITYBOX_NO_VENDOR === '1';
  const fullVendor = argv.includes('--full-vendor') || process.env.GRAVITYBOX_FULL_VENDOR === '1';
  const latestVersion = scope.targetAppVersions[scope.targetAppVersions.length - 1];
  const latestSupportedVersion = supportedVersions[supportedVersions.length - 1];
  const gateTasks = [];
  for (const targetVersion of scope.targetAppVersions) {
    const cachedBundle = join(root, 'vendor', 'antigravity', targetVersion, 'main.js');
    const shouldVerifyVendor = !noVendor && existsSync(cachedBundle) && (fullVendor || scope.mode === VALIDATION_SCOPE_TARGETED || targetVersion === latestVersion);
    const file = `${targetVersion}.json`, expected = SUPPORTED_BUNDLES.get(targetVersion);
    const stringsPath = join(root, 'ui-strings', file);
    const reportOut = join(out, `coverage-${file}`);
    const gateArgs = [join(root, 'tools/coverage-report.mjs'), '--strings', stringsPath, '--gate', '--skip-advisory-scan', '--out', reportOut];
    if (expected) gateArgs.push('--expect-bundle-sha256', expected);
    if (shouldVerifyVendor) {
      gateArgs.push('--bundle', cachedBundle);
    } else {
      gateArgs.push('--no-vendor');
      process.stdout.write(`[verify] ${targetVersion} 启用免 vendor 校验模式（基于 ui-strings/${file} 验证词典）\n`);
    }
    gateTasks.push({ targetVersion, shouldVerifyVendor, stringsPath, reportOut, expected, gateArgs });
  }

  const latestGateTask = gateTasks.find(task => task.targetVersion === latestSupportedVersion);
  const shouldVerifyLatestVendor = Boolean(!noVendor && latestGateTask?.shouldVerifyVendor);

  async function runNoVendorGatesBatch(tasks) {
    if (!tasks.length) return;
    const { loadDictLayers, properNounViolations, runCoverageReport } = await import(pathToFileURL(join(root, 'tools/coverage-report.mjs')).href);
    const { inlineSlotViolations } = await import(pathToFileURL(join(root, 'tools/extract-inline-groups-ast.mjs')).href);
    const dictDir = join(root, 'dict');
    const dictLoaded = await loadDictLayers(dictDir);
    const preloadedDict = { ...dictLoaded, violations: properNounViolations(dictLoaded.entries), slotViolations: inlineSlotViolations(dictLoaded.entries) };
    for (const task of tasks) {
      const name = `词典门禁-${task.targetVersion}`;
      process.stdout.write(`检查：${name}\n`);
      const started = performance.now();
      let result;
      try {
        result = await runCoverageReport({
          stringsPath: task.stringsPath,
          dictDir,
          expectSha256: task.expected,
          noVendor: true,
          skipAdvisoryScan: true,
          out: task.reportOut,
          gate: true,
          preloadedDict,
        });
      } catch (error) {
        const detail = `[coverage-report] ${error?.stack ?? error?.message ?? error}\n`;
        await writeFile(join(out, `${name}.log`), detail);
        process.stderr.write(`\n--- [${name} 错误详情] ---\n${detail}\n------------------------\n`);
        await reportFailureToStepSummary({
          name,
          binary: process.execPath,
          args: task.gateArgs,
          error: { code: 1, message: error?.message ?? String(error) },
          detail,
          completedSteps: [...completedSteps],
        });
        throw new Error(`${name} 未通过，见质检报告`);
      }
      const detail = result.stdout + result.stderr;
      await writeFile(join(out, `${name}.log`), detail);
      if (result.exitCode !== 0) {
        if (detail.trim()) process.stderr.write(`\n--- [${name} 错误详情] ---\n${detail}\n------------------------\n`);
        await reportFailureToStepSummary({
          name,
          binary: process.execPath,
          args: task.gateArgs,
          error: { code: result.exitCode, message: `词典门禁未通过（exit ${result.exitCode}）` },
          detail,
          completedSteps: [...completedSteps],
        });
        throw new Error(`${name} 未通过，见质检报告`);
      }
      completedSteps.push(name);
      const durationMs = performance.now() - started;
      timings.push({ name, durationMs });
      process.stdout.write(`通过：${name}（${(durationMs / 1000).toFixed(2)} 秒）\n`);
    }
  }

  async function runDictionaryGates() {
    const vendorTasks = gateTasks.filter(task => task.shouldVerifyVendor);
    const noVendorTasks = gateTasks.filter(task => !task.shouldVerifyVendor);
    const runVendorTasks = async () => {
      if (!vendorTasks.length) return;
      const concurrency = Math.max(1, Math.min(4, cpus().length || 2));
      let cursor = 0;
      await Promise.all(Array.from({ length: Math.min(concurrency, vendorTasks.length) }, async () => {
        while (cursor < vendorTasks.length) {
          const { targetVersion, gateArgs } = vendorTasks[cursor++];
          await step(`词典门禁-${targetVersion}`, process.execPath, gateArgs);
        }
      }));
    };
    await Promise.all([runNoVendorGatesBatch(noVendorTasks), runVendorTasks()]);
  }

  if (dictOnly) {
    await Promise.all([privacyPromise, runDictionaryGates()]);
  } else {
    const unitTestEnv = {
      ...process.env,
      GRAVITYBOX_SKIP_REPO_PRIVACY_TEST: '1',
      ...(shouldVerifyLatestVendor ? { GRAVITYBOX_SKIP_VENDOR_PROVENANCE_TEST: '1' } : {}),
    };
    const parallelChecks = [
      privacyPromise,
      step('单元与集成', process.execPath, [join(root, 'tools/run-tests.mjs')], { env: unitTestEnv }),
      runDictionaryGates(),
    ];

    if (isMac) {
      parallelChecks.push(
        swiftPromise,
        step('UI测试类型检查', process.execPath, [join(root, 'tools/native-build.mjs'), '--typecheck', '--ui-test']),
        step('浏览器回归', process.execPath, [join(root, 'test/browser.mjs')]),
      );
    } else if (isWin) {
      const winHelperManifest = join(root, 'windows', 'win-helper', 'Cargo.toml');
      const winAppDir = join(root, 'windows', 'app');
      const winAppCargo = join(winAppDir, 'src-tauri', 'Cargo.toml');

      const winNativeChecks = (async () => {
        if (existsSync(winHelperManifest)) {
          await step('WinHelper-Cargo测试', 'cargo', ['test', '--manifest-path', winHelperManifest]);
        }
        if (existsSync(join(winAppDir, 'package.json'))) {
          if (!existsSync(join(winAppDir, 'node_modules'))) {
            throw new Error('Windows桌面端缺少 node_modules，请先在 windows/app 执行 npm ci');
          }
          const npmBuild = npmStepCommand(['run', 'build']);
          await step('Windows桌面端-前端构建', npmBuild.binary, npmBuild.args, { cwd: winAppDir });
        }
        if (existsSync(winAppCargo)) {
          await step('Windows桌面端-Cargo检查', 'cargo', ['check', '--manifest-path', winAppCargo]);
        }
      })();
      parallelChecks.push(winNativeChecks);

      const hasExplicitBrowser = Boolean(
        argv.includes('--with-browser') ||
        process.env.CHROME_BIN ||
        process.env.CHROME_PATH ||
        process.env.PUPPETEER_EXECUTABLE_PATH
      );
      if (hasExplicitBrowser) {
        parallelChecks.push(step('浏览器回归', process.execPath, [join(root, 'test/browser.mjs')]));
      } else {
        process.stdout.write('[verify] Windows 环境未指定测试浏览器（CHROME_BIN），跳过浏览器回归（传入 --with-browser 或 CHROME_BIN 可启用）\n');
      }
    }

    const settled = await Promise.allSettled(parallelChecks);
    const failed = settled.find(item => item.status === 'rejected');
    if (failed) throw failed.reason;
  }

  for (const historical of scope.historicalUnverified) {
    process.stdout.write(`[verify] 词典门禁-${historical}：本轮未验证（定向发布 ${scope.targetAppVersions.join('、')}），不视为通过\n`);
  }

  const digest = await sourceDigest(root);
  if (digest !== initialDigest) throw new Error('验证期间源码发生变化，请重新检查');
  const winDigest = isWin ? await windowsSourceDigest(root) : null;
  if (isWin && winDigest !== initialWinDigest) throw new Error('验证期间 Windows 源码发生变化，请重新检查');

  if (dictOnly) {
    await reportSuccessToStepSummary({ version, scope, digest, steps: completedSteps });
    await writeFile(join(out, 'gate-timings.json'), JSON.stringify({ totalMs: performance.now() - startedAt, steps: timings }, null, 2) + '\n');
    process.stdout.write('全部词典门禁检查通过\n');
    return;
  }
  await mkdir(join(root, '.cache'), { recursive: true });

  if (isWin) {
    const winHelperBin = join(root, 'windows', 'win-helper', 'target', 'release', 'gravitybox-win-helper.exe');
    const winDesktopBin = join(root, 'windows', 'app', 'src-tauri', 'target', 'release', 'gravitybox-desktop.exe');
    await writeFile(join(root, '.cache/verified-release.json'), JSON.stringify({
      platform: 'win32',
      arch: process.arch,
      digest,
      windowsDigest: winDigest,
      vendorEvidence: await vendorEvidence(root),
      artifacts: await collectReleaseArtifacts(root),
      winHelperSha256: existsSync(winHelperBin) ? await fileSha256(winHelperBin) : null,
      desktopBinarySha256: existsSync(winDesktopBin) ? await fileSha256(winDesktopBin) : null,
      at: new Date().toISOString(),
      version,
      ...recordedScopeFields(scope),
    }, null, 2) + '\n');
  } else {
    await writeFile(join(root, '.cache/verified-release.json'), JSON.stringify({
      digest,
      vendorEvidence: await vendorEvidence(root),
      artifacts: await collectReleaseArtifacts(root),
      nativeBinarySha256: createHash('sha256').update(await readFile(join(root, '.cache/GravityBox-native-verified'))).digest('hex'),
      at: new Date().toISOString(),
      version,
      nativeUi: { included: false, command: 'npm run test:native-ui' },
      ...recordedScopeFields(scope),
    }));
  }

  /* 发布一致性：macOS 核对 DMG / sidecar / 已安装应用；Windows 跳过 macOS DMG 一致性检查。 */
  const strict = argv.includes('--strict');
  if (isMac) {
    const release = await checkReleaseConsistency({ root, digest, strict });
    for (const line of renderReleaseConsistency(release)) process.stdout.write(line + '\n');
    if (strict && release.warnings.length) throw new Error(`发布一致性检查未通过（--strict，${release.warnings.length} 项警告），见上方明细`);
  } else if (isWin) {
    process.stdout.write('[verify] Windows 平台跳过 macOS DMG 发布一致性检查\n');
  }
  if (scope.mode === VALIDATION_SCOPE_TARGETED) process.stdout.write(`[verify] 发布通过仅覆盖 ${scope.targetAppVersions.join('、')}；${scope.historicalUnverified.join('、') || '无历史版本'} 本轮未验证，不得宣称通过。\n`);
  await reportSuccessToStepSummary({ version, scope, digest, steps: completedSteps });
  await writeFile(join(out, 'gate-timings.json'), JSON.stringify({ totalMs: performance.now() - startedAt, steps: timings }, null, 2) + '\n');
  process.stdout.write('全部自动检查通过\n');
}

function isDirectEntry() {
  if (typeof process.argv[1] !== 'string') return false;
  if (isWin) {
    return resolve(process.argv[1]).toLowerCase() === resolve(fileURLToPath(import.meta.url)).toLowerCase();
  }
  return import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectEntry()) {
  main().catch(async error => {
    console.error(`[verify] ${error?.message ?? error}`);
    await reportGenericErrorToStepSummary(error);
    process.exitCode = 1;
  });
}
