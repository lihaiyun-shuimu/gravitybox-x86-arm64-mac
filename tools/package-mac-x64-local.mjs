// Intel (x86_64) Mac 本地打包脚本（非官方，x86 社区分支专用）
// 参照 tools/package-mac.mjs，但：
//   - Swift 目标改为 x86_64-apple-macosx14.0
//   - 内置运行时使用当前执行脚本的 Node 22 x64（process.execPath）
//   - 跳过 npm run verify 的全量测试/校验门禁，仅本地 ad-hoc 签名
// 用法（需先 npm run build）：node tools/package-mac-x64-local.mjs [--dmg]
import { mkdir, cp, copyFile, writeFile, rm, readFile, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { includeDictionaryPath, listCompiledScripts } from './release-integrity.mjs';
import { includePackagedAssetPath, escapeXml, computeMacBuildNumber, validateLocalizations } from './package-mac.mjs';
import { nativeBuildArgs } from './native-build.mjs';
const run = promisify(execFile), root = fileURLToPath(new URL('../', import.meta.url));

if (!process.versions.node.startsWith('22.') || process.arch !== 'x64') throw new Error('请使用 Intel (x64) 版 Node 22 运行本脚本');
const pkg = JSON.parse(await readFile(join(root, 'package.json'))), version = pkg.version;

// 1) 编译 x86_64 原生壳
await mkdir(join(root, 'build'), { recursive: true });
const nativeOut = join(root, 'build/GravityBox-x64');
const swiftArgs = (await nativeBuildArgs(root, nativeOut)).map(a => a === 'arm64-apple-macosx14.0' ? 'x86_64-apple-macosx14.0' : a);
console.log('[x64] 编译 Swift 原生壳（约 1～2 分钟）…');
await run('/usr/bin/swiftc', swiftArgs, { cwd: root, maxBuffer: 16e6 });

// 2) 组装 .app
const stage = join(root, 'build', 'x64-stage'), app = join(stage, 'GravityBox.app'), resources = join(app, 'Contents/Resources');
await rm(stage, { recursive: true, force: true });
await mkdir(join(app, 'Contents/MacOS'), { recursive: true });
await mkdir(join(resources, 'runtime'), { recursive: true });
await copyFile(process.execPath, join(resources, 'runtime/node'));
await run('/usr/bin/strip', ['-x', join(resources, 'runtime/node')]);
await run('/usr/bin/codesign', ['--force', '--sign', '-', join(resources, 'runtime/node')]);
await copyFile(join(root, 'licenses/NODE-LICENSE'), join(resources, 'runtime/LICENSE'));
await mkdir(join(resources, 'core/dist'), { recursive: true });
await mkdir(join(resources, 'icons'), { recursive: true });
await copyFile(join(root, 'assets/icons/menu-connected.png'), join(resources, 'icons/menu-connected.png'));
const filterAsset = source => includePackagedAssetPath(relative(join(root, 'assets'), source));
await cp(join(root, 'assets/model-icons'), join(resources, 'model-icons'), { recursive: true, filter: filterAsset });
for (const name of await listCompiledScripts(root)) {
  const dest = join(resources, 'core/dist', name);
  await mkdir(join(dest, '..'), { recursive: true });
  await copyFile(join(root, 'dist', name), dest);
}
await copyFile(join(root, 'assets/model-catalog.json'), join(resources, 'model-catalog.json'));
await cp(join(root, 'assets/i18n'), join(resources, 'i18n'), { recursive: true, filter: filterAsset });
const codes = [];
for (const file of (await readdir(join(root, 'assets/i18n'))).filter(n => n.endsWith('.json')).sort()) {
  const parsed = JSON.parse(await readFile(join(root, 'assets/i18n', file), 'utf8'));
  if (typeof parsed?.meta?.code === 'string' && parsed.meta.code.trim()) codes.push(parsed.meta.code.trim());
}
const localizationsXml = validateLocalizations(codes).map(c => `<string>${escapeXml(c)}</string>`).join('');
await cp(join(root, 'dict'), join(resources, 'core/dict'), { recursive: true, filter: source => includeDictionaryPath(join('dict', relative(join(root, 'dict'), source))) });
await writeFile(join(resources, 'core/package.json'), JSON.stringify({ type: 'module', version }) + '\n');
for (const [from, to] of [['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md'], ['LICENSE', 'LICENSE'], ['assets/AppIcon.icns', 'AppIcon.icns']]) await copyFile(join(root, from), join(resources, to));
const build = computeMacBuildNumber(version);
await writeFile(join(app, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>GravityBox</string><key>CFBundleIdentifier</key><string>local.gravitybox.app</string><key>CFBundleName</key><string>GravityBox</string><key>CFBundleDisplayName</key><string>GravityBox</string><key>CFBundleIconFile</key><string>AppIcon</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>${escapeXml(version)}</string><key>CFBundleVersion</key><string>${build}</string><key>CFBundleDevelopmentRegion</key><string>en</string><key>CFBundleLocalizations</key><array>${localizationsXml}</array><key>LSMinimumSystemVersion</key><string>14.0</string><key>LSUIElement</key><true/><key>NSHighResolutionCapable</key><true/></dict></plist>`);
await copyFile(join(root, 'build/GravityBox-x64'), join(app, 'Contents/MacOS/GravityBox'));
await writeFile(join(resources, 'build-info.json'), JSON.stringify({ version, build, node: process.versions.node, arch: 'x86_64', note: 'local unofficial build' }, null, 2));
await run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', app]);
await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
console.log(`[x64] App：${app}`);

// 3) 可选：生成 DMG
if (process.argv.includes('--dmg')) {
  const output = join(root, '成品');
  await mkdir(output, { recursive: true });
  await run('/bin/ln', ['-sf', '/Applications', join(stage, 'Applications')]);
  const dmg = join(output, `GravityBox-${version}-x86_64.dmg`);
  await run('/usr/bin/hdiutil', ['create', '-ov', '-volname', 'GravityBox', '-fs', 'HFS+', '-srcfolder', stage, '-format', 'ULFO', dmg], { maxBuffer: 2e6 });
  console.log(`[x64] DMG：${dmg}`);
}
