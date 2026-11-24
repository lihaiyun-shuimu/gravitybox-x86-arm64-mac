import test from "node:test";
import { describe as describeContractGroup } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceDigest, vendorEvidence, includeSourceDigestPath, collectReleaseArtifacts, assertReleaseArtifacts } from "../tools/release-integrity.mjs";
import { checkDocs } from "../tools/check-docs.mjs";
import { includePackagedAssetPath, escapeXml, computeMacBuildNumber, validateLocalizations } from "../tools/package-mac.mjs";

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("发行完整性 · optimization-20261022", { concurrency: false }, async () => {

const fixture=async fn=>{const dir=await mkdtemp(join(tmpdir(),'gb-opt-'));try{return await fn(dir);}finally{await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:50});}};

test('文档检查重算源码摘要，旧stamp不能掩盖当前修改',()=>fixture(async dir=>{
 for(const name of ['src','runtime','native','tools','test','dict','ui-strings','assets','licenses','.cache'])await mkdir(join(dir,name));
 for(const name of ['package-lock.json','tsconfig.json','README.md','THIRD_PARTY_NOTICES.md'])await writeFile(join(dir,name),'fixture');await writeFile(join(dir,'package.json'),'{"version":"0.9.0"}');const digest=await sourceDigest(dir);await writeFile(join(dir,'.cache','verified-release.json'),JSON.stringify({digest}));await writeFile(join(dir,'src','change.ts'),'changed');const result=await checkDocs({root:dir,installedApp:join(dir,'missing'),accountsPath:join(dir,'missing.json')});assert.ok(result.issues.some(i=>i.code==='SOURCE_NOT_VERIFIED'));
}));
});

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("发行完整性 · repair-20261023", { concurrency: false }, async () => {
async function fixture(t){const d=await mkdtemp(join(tmpdir(),'gb-repair-'));t.after(async()=>{try{await rm(d,{recursive:true,force:true,maxRetries:10,retryDelay:50});}catch{}});return d;}
test('已验证脚本清单拒绝仅改dist，源码未变化也不能打包',async t=>{const d=await fixture(t);await mkdir(join(d,'src'));await mkdir(join(d,'dist'));await writeFile(join(d,'src/a.ts'),'source');await writeFile(join(d,'dist/a.js'),'A');await writeFile(join(d,'dist/engine.js'),'runtime');const manifest=await collectReleaseArtifacts(d);await assertReleaseArtifacts(d,manifest);await writeFile(join(d,'dist/a.js'),'B');await assert.rejects(assertReleaseArtifacts(d,manifest),/已变化/);});
});

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("发行完整性 · release-1.1.1-contracts", { concurrency: false }, async () => {
  async function makeFixture(t) {
    const dir = await mkdtemp(join(tmpdir(), 'gb-rel111-'));
    t.after(async () => {
      try {
        await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      } catch {}
    });
    return dir;
  }

  test('sourceDigest 忽略 .DS_Store 与 assets/screenshots，并纳入新增发版文档与 workflow', async t => {
    const d = await makeFixture(t);
    for (const dirName of ['src', 'runtime', 'native', 'tools', 'test', 'dict', 'ui-strings', 'assets/screenshots', 'licenses', '.github/workflows']) {
      await mkdir(join(d, dirName), { recursive: true });
    }
    for (const fileName of ['package-lock.json', 'tsconfig.json', 'README.md', 'README.zh-CN.md', 'THIRD_PARTY_NOTICES.md', 'README_EN.md', 'CHANGELOG.md', 'PROJECT.md']) {
      await writeFile(join(d, fileName), 'fixture');
    }
    await writeFile(join(d, 'package.json'), '{"version":"1.1.1"}');
    await writeFile(join(d, '.github/workflows/ci.yml'), 'name: ci\n');

    const baseDigest = await sourceDigest(d);
    await writeFile(join(d, 'src/.DS_Store'), 'junk');
    await writeFile(join(d, 'assets/.DS_Store'), 'junk');
    await writeFile(join(d, 'assets/screenshots/about.png'), 'png-bytes');
    assert.equal(await sourceDigest(d), baseDigest);

    await writeFile(join(d, 'CHANGELOG.md'), 'updated changelog');
    const afterChangelog = await sourceDigest(d);
    assert.notEqual(afterChangelog, baseDigest);

    await writeFile(join(d, '.github/workflows/ci.yml'), 'name: ci-v2\n');
    assert.notEqual(await sourceDigest(d), afterChangelog);

    assert.equal(includeSourceDigestPath('assets/screenshots/settings.png'), false);
    assert.equal(includeSourceDigestPath('src/.DS_Store'), false);
    assert.equal(includeSourceDigestPath('assets/i18n/en.json'), true);
  });

  test('checkDocs --source-only 覆盖双语文档与 CHANGELOG，且不泄露账号明文', async t => {
    const d = await makeFixture(t);
    for (const dirName of ['src', 'runtime', 'native', 'tools', 'test', 'dict', 'ui-strings', 'assets/screenshots', 'licenses']) {
      await mkdir(join(d, dirName), { recursive: true });
    }
    for (const fileName of ['package-lock.json', 'tsconfig.json', 'THIRD_PARTY_NOTICES.md']) {
      await writeFile(join(d, fileName), 'fixture');
    }
    await writeFile(join(d, 'package.json'), '{"version":"1.1.1"}');
    await writeFile(join(d, 'README.md'), '<h1>GravityBox</h1>\n(`GravityBox v1.1.1`)\n');
    await writeFile(join(d, 'README.zh-CN.md'), '<h1>GravityBox</h1>\n(`GravityBox v1.1.0`)\n');
    await writeFile(join(d, 'README_EN.md'), '<h1>GravityBox</h1>\n(`GravityBox v1.1.0`)\n');
    await writeFile(join(d, 'CHANGELOG.md'), '## [Unreleased]\n\n## [1.1.0] - 2026-11-01\n\n[Unreleased]: https://github.com/example/repo/compare/v1.1.0...HEAD\n[1.1.0]: https://github.com/example/repo/compare/v1.0.0...v1.1.0\n');
    await writeFile(join(d, 'PROJECT.md'), '# PROJECT.md — GravityBox (`1.1.0`)\n');
    await writeFile(join(d, 'assets/screenshots/README.md'), '- `about.png`: About window (`v1.1.0`).\n');

    const sourceCheck = await checkDocs({
      root: d,
      installedApp: join(d, 'missing-app'),
      accountsPath: join(d, 'missing-accounts.json'),
      sourceOnly: true,
    });
    assert.equal(sourceCheck.ok, false);
    assert.ok(sourceCheck.checked >= 6);
    assert.ok(sourceCheck.issues.some(i => i.code === 'DOC_VERSION_MISMATCH' && i.file === 'README.zh-CN.md'));
    assert.ok(sourceCheck.issues.some(i => i.code === 'DOC_VERSION_MISMATCH' && i.file === 'README_EN.md'));
    assert.ok(sourceCheck.issues.some(i => i.code === 'DOC_VERSION_MISMATCH' && i.file === 'PROJECT.md'));
    assert.ok(sourceCheck.issues.some(i => i.code === 'DOC_VERSION_MISMATCH' && i.file === 'assets/screenshots/README.md'));
    assert.ok(sourceCheck.issues.some(i => i.code === 'CHANGELOG_VERSION_MISSING' && i.file === 'CHANGELOG.md'));
    assert.ok(sourceCheck.issues.some(i => i.code === 'CHANGELOG_UNRELEASED_LINK_STALE' && i.file === 'CHANGELOG.md'));
    assert.ok(sourceCheck.issues.some(i => i.code === 'CHANGELOG_VERSION_LINK_MISSING' && i.file === 'CHANGELOG.md'));

    await writeFile(join(d, 'README.md'), '<h1>GravityBox</h1>\n(`GravityBox v1.1.1`)\nold@example.test\nbot@users.noreply.github.com\n');
    await writeFile(join(d, 'accounts.json'), JSON.stringify({
      current_account_id: 'a',
      accounts: [
        { id: 'a', email: 'secret-pool@example.test' },
        { id: 'b', email: 'second@example.test' },
      ],
    }));
    const emailCheck = await checkDocs({
      root: d,
      installedApp: join(d, 'missing-app'),
      accountsPath: join(d, 'accounts.json'),
      sourceOnly: false,
    });
    const staleEmailIssue = emailCheck.issues.find(i => i.code === 'DOC_ACCOUNT_STALE');
    assert.ok(staleEmailIssue);
    assert.equal(staleEmailIssue.message.includes('secret-pool@example.test'), false);
    assert.equal(staleEmailIssue.message.includes('second@example.test'), false);
    assert.ok(staleEmailIssue.message.includes('号池共 2 个账号'));
  });

  test('package-mac.mjs 纯辅助函数校验资源过滤、XML 转义、构建号与本地化列表', () => {
    assert.equal(includePackagedAssetPath('model-icons/sources.json'), false);
    assert.equal(includePackagedAssetPath('i18n/.DS_Store'), false);
    assert.equal(includePackagedAssetPath('i18n/zh-Hans.json'), true);
    assert.equal(escapeXml('a&b<c>"d\'e'), 'a&amp;b&lt;c&gt;&quot;d&apos;e');
    assert.equal(computeMacBuildNumber('1.1.1'), 10101);
    assert.throws(() => computeMacBuildNumber('1.100.0'), /上限/);
    assert.throws(() => computeMacBuildNumber('1.1.1-beta'), /无效/);
    assert.deepEqual(validateLocalizations(['en', 'zh-Hans', 'en']), ['en', 'zh-Hans']);
    assert.throws(() => validateLocalizations([]), /不能为空/);
    assert.throws(() => validateLocalizations(['en<script>']), /无效/);
  });

  test('P1-29: sourceDigest 在有无 vendor/ 目录时完全一致，vendorEvidence 独立记录官方包校验和', async t => {
    const d = await makeFixture(t);
    for (const dirName of ['src', 'runtime', 'native', 'tools', 'test', 'dict', 'ui-strings', 'assets', 'licenses']) {
      await mkdir(join(d, dirName), { recursive: true });
    }
    for (const fileName of ['package.json', 'package-lock.json', 'tsconfig.json', 'README.md', 'THIRD_PARTY_NOTICES.md']) {
      await writeFile(join(d, fileName), 'fixture');
    }

    const digestWithoutVendor = await sourceDigest(d);
    const evBefore = await vendorEvidence(d);
    assert.equal(evBefore.present, false);
    assert.equal(evBefore.digest, null);

    await mkdir(join(d, 'vendor/antigravity/2.34.0'), { recursive: true });
    await writeFile(join(d, 'vendor/antigravity/2.34.0/main.js'), 'official bundle v1');
    assert.equal(await sourceDigest(d), digestWithoutVendor, '增加 vendor 官方包不得改变 sourceDigest');

    const evV1 = await vendorEvidence(d);
    assert.equal(evV1.present, true);
    assert.ok(evV1.versions['2.34.0']);
    assert.equal(evV1.versions['2.34.0'].files, 1);

    await writeFile(join(d, 'vendor/antigravity/2.34.0/main.js'), 'official bundle v2');
    assert.equal(await sourceDigest(d), digestWithoutVendor);
    const evV2 = await vendorEvidence(d);
    assert.notEqual(evV2.digest, evV1.digest, 'vendor 变动应反映在 vendorEvidence.digest 中');
    assert.notEqual(evV2.versions['2.34.0'].sha256, evV1.versions['2.34.0'].sha256);
  });
});
