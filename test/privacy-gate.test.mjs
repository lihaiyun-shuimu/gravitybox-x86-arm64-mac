import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { SshRemoteRpcClient } from '../dist/ssh-remote-rpc.js';
import { RemoteAccountObservationStore, syncRemoteSessionUsage } from '../dist/remote-usage-sync.js';
import { runPrivacyCheck, scanContentForPrivacy, scanDirectoryForPrivacy } from '../tools/check-privacy.mjs';

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const sha256 = value => createHash('sha256').update(value).digest('hex');

test('隐私门禁扫描器：放行占位域名与 Retina 资源后缀，拦截真实域名邮箱', () => {
  const safeFixture = `
    const accounts = [
      { email: 'ultra@example.invalid', name: 'Ultra User' },
      { email: 'pro@example.test', name: 'Pro User' },
      { email: 'bot@users.noreply.github.com', name: 'Bot' },
      { icon: 'icon_16x16@2x.png' },
      { desc: '防止无限轮询导致界面卡顿' },
    ];
  `;
  assert.deepEqual(scanContentForPrivacy(safeFixture, 'test/sample.test.mjs'), []);

  const realGmail = ['someone', 'gmail.com'].join('@');
  const realQq = ['123456', 'qq.com'].join('@');
  const unsafeFixture = `
    const first = '${realGmail}';
    const second = '${realQq}';
  `;
  const issues = scanContentForPrivacy(unsafeFixture, 'test/sample.test.mjs');
  assert.equal(issues.length, 2);
  assert.equal(issues[0].code, 'DISALLOWED_EMAIL_DOMAIN');
  assert.equal(issues[1].code, 'DISALLOWED_EMAIL_DOMAIN');
  assert.ok(!issues[0].detail.includes('someone@'), '告警信息不得回显完整邮箱前缀');
});

test('隐私门禁扫描器：放行占位用户目录，拦截真实 /Users /home 与 Windows 用户路径', () => {
  const safePaths = `
    const a = '/Users/alice/Library/Application Support/Antigravity';
    const b = '/Users/demo/Private.txt';
    const c = '/Users/private/bad';
    const d = '/Users/Shared/cache';
    const e = 'C:\\\\Users\\\\demo\\\\AppData';
    const f = '/home/alice/.config';
  `;
  assert.deepEqual(scanContentForPrivacy(safePaths, 'test/sample.test.mjs'), []);

  const realMacPath = ['/Users', 'realdeveloper', 'Developer', 'gravitybox'].join('/');
  const realWinPath = ['C:', 'Users', 'realdeveloper', 'Desktop'].join('\\');
  const realLinuxPath = ['/home', 'realdeveloper', 'work'].join('/');
  const issues = scanContentForPrivacy(
    `const a = '${realMacPath}';\nconst b = '${realWinPath}';\nconst c = '${realLinuxPath}';\n`,
    'docs/report.md'
  );
  assert.equal(issues.length, 3);
  assert.deepEqual(issues.map(i => i.code), ['DISALLOWED_LOCAL_HOME_PATH', 'DISALLOWED_LOCAL_HOME_PATH', 'DISALLOWED_LOCAL_HOME_PATH']);
  assert.deepEqual(issues.map(i => i.line), [1, 2, 3]);
  assert.ok(issues.every(i => !i.detail.includes('realdeveloper')), '告警信息不得回显完整本机用户名');
});

test('隐私门禁扫描器：拦截真实私钥与密钥前缀，豁免显式测试占位凭据，并支持目录打包扫描', async () => {
  const safeCreds = `
    const testAt = 'ya29.' + 'abcdefghijklmnop';
    const secretAt = 'ya29.superSecretAccessToken123456';
    const testSk = 'sk-live-abcdefghijklmnop';
  `;
  assert.deepEqual(scanContentForPrivacy(safeCreds, 'test/sample.test.mjs'), []);

  const fakePem = ['-----BEGIN RSA', 'PRIVATE KEY-----'].join(' ');
  const fakeGoogleKey = 'AIza' + 'SyD9x8y7z6A5B4C3D2E1F0G9H8I7J6K5L4M';
  const fakeGhToken = 'ghp_' + 'Z9y8X7w6V5u4T3s2R1q0P9o8N7m6';
  const issues = scanContentForPrivacy(`${fakePem}\n${fakeGoogleKey}\n${fakeGhToken}\n`, 'src/leaked.ts');
  assert.equal(issues.length, 3);
  assert.deepEqual(issues.map(i => i.code), ['DISALLOWED_SECRET_LITERAL', 'DISALLOWED_SECRET_LITERAL', 'DISALLOWED_SECRET_LITERAL']);

  const safeGoogleOAuth = [
    "GRAVITYBOX_GOOGLE_CLIENT_ID='your-client-id.apps.googleusercontent.com'",
    "GRAVITYBOX_GOOGLE_CLIENT_ID='mock-id.apps.googleusercontent.com'",
    `const placeholderSecret = '${'GOCSPX-' + 'examplePlaceholderSecretValue99'}';`,
    `const placeholderClientId = '${'1071006060591-' + 'exampleplaceholderclientid99.apps.googleusercontent.com'}';`,
  ].join('\n');
  assert.deepEqual(scanContentForPrivacy(safeGoogleOAuth, 'test/sample.test.mjs'), []);

  const fakeOAuthSecret = 'GOCSPX-' + 'K9mPqR2xT4vW8zY1nB3cD6fG7hJ8';
  const fakeOAuthClientId = '1071006060591-' + 'k9mpqr2xt4vw8zy1nb3cd6fg7hj8' + '.apps.googleusercontent.com';
  const oauthIssues = scanContentForPrivacy(
    `GRAVITYBOX_GOOGLE_CLIENT_ID=${fakeOAuthClientId}\nGRAVITYBOX_GOOGLE_CLIENT_SECRET=${fakeOAuthSecret}\n`,
    'src/leaked-oauth.ts'
  );
  assert.equal(oauthIssues.length, 2);
  assert.deepEqual(oauthIssues.map(i => i.code), ['DISALLOWED_SECRET_LITERAL', 'DISALLOWED_SECRET_LITERAL']);
  assert.deepEqual(oauthIssues.map(i => i.line), [1, 2]);

  const tempDir = await mkdtemp(join(tmpdir(), 'gb-privacy-dir-'));
  try {
    await mkdir(join(tempDir, 'Resources', 'core'), { recursive: true });
    await mkdir(join(tempDir, 'MacOS'), { recursive: true });
    await writeFile(join(tempDir, 'MacOS', 'bin'), `${fakeGhToken}\n`);
    await writeFile(join(tempDir, 'Resources', 'core', 'app.js'), `console.log('${fakeGoogleKey}');\n`);
    const dirResult = await scanDirectoryForPrivacy(tempDir, { excludePrefixes: ['MacOS/'] });
    assert.equal(dirResult.scannedCount, 1);
    assert.equal(dirResult.issues.length, 1);
    assert.equal(dirResult.issues[0].file, 'Resources/core/app.js');
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('隐私门禁扫描器：支持指纹匹配拦截敏感标识、姓名与引号别名，并豁免词典中正常词条', () => {
  const secretToken = 'syntheticprivatehandle99';
  const secretFullName = 'synthetic private person';
  const secretCjk = '甲乙';
  const secretAlias = '秘密别名';

  const issues = scanContentForPrivacy(
    `
      const handle = '${secretToken}';
      const person = 'Synthetic Private Person';
      // 筛选${secretCjk}测试
      const label = '${secretAlias}';
    `,
    'test/sample.test.mjs',
    {
      tokenHashes: new Set([sha256(secretToken), sha256(secretFullName)]),
      cjkBigramHashes: new Set([sha256(secretCjk)]),
      quotedAliasHashes: new Set([sha256(secretAlias)]),
    }
  );
  assert.deepEqual(
    issues.map(i => i.code),
    ['SENSITIVE_TOKEN_MATCH', 'SENSITIVE_NAME_MATCH', 'SENSITIVE_CJK_NAME_MATCH', 'SENSITIVE_ALIAS_MATCH']
  );

  // dict/ 下允许普通别名翻译词条，不误报
  const dictIssues = scanContentForPrivacy(
    JSON.stringify({ Unlimited: secretAlias }),
    'dict/base.json',
    {
      tokenHashes: new Set(),
      cjkBigramHashes: new Set(),
      quotedAliasHashes: new Set([sha256(secretAlias)]),
    }
  );
  assert.deepEqual(dictIssues, []);
});

test('隐私门禁 --staged 模式：仅检查暂存区快照，不误检未暂存工作区', async () => {
  const tempRepo = await mkdtemp(join(tmpdir(), 'gb-privacy-hook-'));
  try {
    await execFileAsync('git', ['init'], { cwd: tempRepo });
    await mkdir(join(tempRepo, 'test'), { recursive: true });

    const target = join(tempRepo, 'test', 'demo.mjs');
    await writeFile(target, "export const email = 'safe@example.invalid';\n");
    await execFileAsync('git', ['add', 'test/demo.mjs'], { cwd: tempRepo });

    // 未暂存的脏修改不应影响 --staged 校验
    await writeFile(target, `export const email = '${['leak', 'gmail.com'].join('@')}';\n`);
    const cleanStaged = await runPrivacyCheck({ repoRoot: tempRepo, staged: true });
    assert.equal(cleanStaged.issues.length, 0);

    // 暂存真实邮箱后必须被 --staged 拦截
    await execFileAsync('git', ['add', 'test/demo.mjs'], { cwd: tempRepo });
    const blockedStaged = await runPrivacyCheck({ repoRoot: tempRepo, staged: true });
    assert.equal(blockedStaged.issues.length, 1);
    assert.equal(blockedStaged.issues[0].code, 'DISALLOWED_EMAIL_DOMAIN');
  } finally {
    await rm(tempRepo, { recursive: true, force: true }).catch(() => {});
  }
});

test('隐私门禁扫描器：拦截硬编码 SSH CSRF / 长 Bearer 凭据，放行 localStorage 只读键名与测试占位串', () => {
  const safeContent = `
    const csrf = localStorage.getItem('${'agy_session_csrf' + '_token'}');
    const hdr = { '${'x-codeium-csrf' + '-token'}': 'test-csrf-token-placeholder' };
    const auth = '${'Bear' + 'er'} sample-test-placeholder-token-1234';
  `;
  assert.deepEqual(scanContentForPrivacy(safeContent, 'src/ssh-remote-rpc.ts'), []);

  const unsafeCsrfAssign = `${'agy_session_csrf' + '_token'} = '${'K9mPqR2xT4vW8zY1nB3cD6fG'}'`;
  const unsafeCsrfHeader = `'${'x-codeium-csrf' + '-token'}': '${'M7nQpR9xT2vW4zY6bC8dE1fH'}'`;
  const unsafeBearerLine = `Authorization: ${'Bear' + 'er'} ${'K8vP3mQx9RtY2wZ5nB7cF4hJ6dL'}`;
  const issues = scanContentForPrivacy(
    `${unsafeCsrfAssign}\n${unsafeCsrfHeader}\n${unsafeBearerLine}\n`,
    'src/leaked-ssh.ts'
  );
  assert.equal(issues.length, 3);
  assert.deepEqual(issues.map(i => i.code), [
    'DISALLOWED_SECRET_LITERAL',
    'DISALLOWED_SECRET_LITERAL',
    'DISALLOWED_SECRET_LITERAL',
  ]);
});

test('SSH RPC 源码静态隐私契约：仅页内消耗会话 CSRF 令牌，严格白名单投影不转发提示词与消息体', async () => {
  const rpcSource = await readFile(join(repoRoot, 'src/ssh-remote-rpc.ts'), 'utf8');
  assert.ok(rpcSource.includes(`localStorage.getItem('${'agy_session_csrf' + '_token'}')`));
  assert.ok(rpcSource.includes('includeMessages: false'));
  assert.equal(/\b(?:token|csrfToken)\s*:/m.test(rpcSource), false);
  assert.equal(/return\s+\{[^}]*\btoken\b/m.test(rpcSource), false);
  for (const forbidden of [
    'promptSections',
    'systemPrompt',
    'tools',
    'responseHeader',
    'customMetadata',
    'messagePrompts',
    'messages',
  ]) {
    assert.equal(new RegExp(`\\b${forbidden}\\b`).test(rpcSource), false, `禁止在 ssh-remote-rpc.ts 投影或转发 ${forbidden}`);
  }
});

test('隐私门禁扫描器：拦截 SSH 公钥与敏感 SSH 配置指令，放行示例占位配置', () => {
  const safeSsh = [
    "const kind = 'ssh-ed25519';",
    `const placeholderKey = 'ssh-ed25519 ' + 'AAAAC3NzaC1lZDI1NTE5AAAAIexampleplaceholderkey1234';`,
    "const samplePath = '/Users/alice/.ssh/' + 'id_ed25519';",
    "const demoKeyPath = '~/.ssh/' + 'id_example';",
    'Host demo-box',
    '  HostName demo-ssh-host',
    '  HostName api.example.invalid',
    '  HostName 127.0.0.1',
    '  IdentityFile /Users/demo/.ssh/example_key',
    '  IdentityFile ~/.ssh/example_identity',
  ].join('\n');
  assert.deepEqual(scanContentForPrivacy(safeSsh, 'docs/ssh-guide.md'), []);

  const sshRsaKey = ['ssh-' + 'rsa', 'AAAAB3NzaC1yc2EAAAADAQABAAABgQC9mPqR2xT4vW8zY1nB3cD6fG=='].join(' ');
  const sshEdKey = ['ssh-' + 'ed25519', 'AAAAC3NzaC1lZDI1NTE5AAAAIK9mPqR2xT4vW8zY1nB3cD6fG7hJ8'].join(' ');
  const sshEcdsaKey = ['ssh-' + 'ecdsa', 'AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTY='].join(' ');
  const unsafeKeyPath = ['~/', '.ssh/', 'id_', 'ed25519'].join('');
  const unsafeHostLine = ['  Host', 'Name prod-gpu-01.corp.internal'].join('');
  const unsafeIdentLine = ['  Identity', 'File ~/.ssh/corp_bastion_key'].join('');

  const issues = scanContentForPrivacy(
    [
      sshRsaKey,
      sshEdKey,
      sshEcdsaKey,
      `const key = '${unsafeKeyPath}';`,
      unsafeHostLine,
      unsafeIdentLine,
    ].join('\n'),
    'src/leaked-ssh-config.ts'
  );
  assert.deepEqual(
    issues.map(i => i.code),
    [
      'DISALLOWED_SECRET_LITERAL',
      'DISALLOWED_SECRET_LITERAL',
      'DISALLOWED_SECRET_LITERAL',
      'DISALLOWED_SSH_CONFIG',
      'DISALLOWED_SSH_CONFIG',
      'DISALLOWED_SSH_CONFIG',
    ]
  );
  assert.deepEqual(issues.map(i => i.line), [1, 2, 3, 4, 5, 6]);
});

test('隐私门禁扫描器：拦截非保留私网 IPv4，严谨豁免版本号、时间戳与示例上下文', () => {
  const safeIpv4 = [
    `const winVer = '${['10', '0', '19045', '1'].join('.')}';`,
    `const vPrefixed = 'v${['10', '2', '3', '4'].join('.')}';`,
    `const prerelease = '${['172', '16', '0', '1'].join('.')}-rc1';`,
    `const versionObj = { version: '${['192', '168', '1', '2'].join('.')}' };`,
    `const stamped = '2026-11-20 ${['10', '12', '30', '40'].join('.')}';`,
    `// example private host: ${['192', '168', '1', '50'].join('.')}`,
    `const placeholderAddr = '${['10', '0', '0', '9'].join('.')}';`,
    `const cidr10 = '${['10', '0', '0', '0'].join('.')}/8';`,
    `const cidr172 = '${['172', '16', '0', '0'].join('.')}/12';`,
    `const cidr192 = '${['192', '168', '0', '0'].join('.')}/16';`,
    `const nonPrivate172 = '${['172', '15', '0', '1'].join('.')}';`,
    `const nonPrivate172High = '${['172', '32', '0', '1'].join('.')}';`,
    "const loopback = '127.0.0.1';",
  ].join('\n');
  assert.deepEqual(scanContentForPrivacy(safeIpv4, 'test/network.test.mjs'), []);

  const priv10 = ['10', '24', '8', '12'].join('.');
  const priv172 = ['172', '16', '5', '9'].join('.');
  const priv192 = ['192', '168', '50', '21'].join('.');
  const issues = scanContentForPrivacy(
    [
      `const dbHost = '${priv10}';`,
      `const vpcHost = '${priv172}';`,
      `const lanHost = '${priv192}';`,
    ].join('\n'),
    'src/leaked-ip.ts'
  );
  assert.equal(issues.length, 3);
  assert.deepEqual(issues.map(i => i.code), [
    'DISALLOWED_PRIVATE_IP',
    'DISALLOWED_PRIVATE_IP',
    'DISALLOWED_PRIVATE_IP',
  ]);
  assert.equal(issues.every(i => !i.detail.includes(priv10) && !i.detail.includes(priv172) && !i.detail.includes(priv192)), true);
});

test('syncRemoteSessionUsage 产物零令牌/零 Prompt 脱敏与 0o600 落盘契约', async () => {
  const tempStateDir = await mkdtemp(join(tmpdir(), 'gb-remote-privacy-'));
  const csrfSecret = 'csrf-remote-sync-secret-99887766';
  const secretWorkspace = ['/Users', 'privateuser', 'secret-repo'].join('/');
  const fakeWindow = {
    localStorage: {
      getItem: key => (key === `${'agy_session_csrf'}_token` ? csrfSecret : null),
    },
    fetch: async url => {
      const method = String(url).split('/').pop();
      const routes = {
        GetAllCascadeTrajectories: {
          trajectorySummaries: {
            'conv-priv-1': {
              trajectoryId: 'traj-priv-1',
              stepCount: 2,
              summary: 'PRIVATE_CHAT_TITLE_LEAK',
              lastModifiedTime: '2026-11-20T06:00:00Z',
              trajectoryMetadata: { workspaceUris: [secretWorkspace] },
            },
          },
        },
        GetCascadeTrajectoryGeneratorMetadata: {
          generatorMetadata: [
            {
              stepIndices: [1],
              executionId: 'exec-priv-1',
              chatModel: {
                responseModel: 'gemini-3.8-flash-n',
                promptSections: [{ text: 'SECRET_SYSTEM_PROMPT_LEAK' }],
                systemPrompt: 'SECRET_SYSTEM_PROMPT_LEAK',
                tools: [{ name: 'bash', schema: 'SECRET_TOOL_SCHEMA' }],
                customMetadata: { privateNote: 'SECRET_NOTE' },
                usage: {
                  inputTokens: '400',
                  outputTokens: '120',
                  cacheReadTokens: '200',
                  responseHeader: { authorization: 'SECRET_HEADER' },
                },
              },
            },
          ],
        },
        GetCascadeTrajectorySteps: {
          steps: [
            {
              idx: 0,
              type: 'CORTEX_STEP_TYPE_USER_INPUT',
              status: 'CORTEX_STEP_STATUS_DONE',
              metadata: { createdAt: '2026-11-20T05:59:50Z' },
              userInput: { items: [{ text: 'SECRET_USER_PROMPT_LEAK' }] },
            },
            {
              idx: 1,
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'CORTEX_STEP_STATUS_DONE',
              metadata: { createdAt: '2026-11-20T05:59:55Z', executionId: 'exec-priv-1' },
              plannerResponse: { response: 'SECRET_MODEL_REPLY_LEAK' },
            },
          ],
        },
      };
      const body = routes[method];
      return {
        ok: Boolean(body),
        status: body ? 200 : 404,
        async json() {
          return body ?? {};
        },
      };
    },
    AbortController,
    Date,
    Object,
    Array,
    Number,
    String,
    Boolean,
    JSON,
    Math,
    setTimeout,
    clearTimeout,
  };

  try {
    const rpcClient = new SshRemoteRpcClient({
      cdp: {
        async evaluate(expr, contextId) {
          assert.equal(contextId, 7);
          return vm.runInNewContext(expr, fakeWindow);
        },
      },
      getContextId: () => 7,
    });
    const observationStore = new RemoteAccountObservationStore({ stateDir: tempStateDir });
    const nowMs = Date.UTC(2026, 10, 20, 6, 0, 5);
    observationStore.recordObservation({
      environmentId: 'ssh:demo',
      hostLabel: 'demo-ssh-host',
      email: 'remote-dev@example.invalid',
      matchedLocalAccountId: 'acc-remote-1',
      accountType: 'consumer',
      observedAtSec: Math.floor(nowMs / 1000) - 60,
    });

    const result = await syncRemoteSessionUsage({
      target: {
        remoteKey: 'rk-priv',
        hostLabel: 'demo-ssh-host',
        environmentId: 'ssh:demo',
        origin: 'https://127.0.0.1:44139',
        rpcClient,
        email: 'remote-dev@example.invalid',
        name: 'Remote Dev',
        accountType: 'consumer',
        matchedLocalAccountId: 'acc-remote-1',
        state: 'connected',
      },
      observationStore,
      nowMs,
    });
    await observationStore.flush();

    assert.equal(result.ok, true);
    assert.equal(result.events.length, 1);

    const obsPath = join(tempStateDir, 'usage-remote-observations.json');
    const obsStat = await stat(obsPath);
    if (process.platform !== 'win32') {
      assert.equal(obsStat.mode & 0o777, 0o600);
    }
    const obsDiskContent = await readFile(obsPath, 'utf8');
    const serialized = `${JSON.stringify(result)}\n${obsDiskContent}`;

    for (const forbidden of [
      csrfSecret,
      'SECRET_SYSTEM_PROMPT_LEAK',
      'SECRET_TOOL_SCHEMA',
      'SECRET_NOTE',
      'SECRET_HEADER',
      'PRIVATE_CHAT_TITLE_LEAK',
      'SECRET_USER_PROMPT_LEAK',
      'SECRET_MODEL_REPLY_LEAK',
      secretWorkspace,
      'promptSections',
      'systemPrompt',
    ]) {
      assert.equal(serialized.includes(forbidden), false, `同步产物与观测落盘不得包含 ${forbidden}`);
    }
    assert.deepEqual(scanContentForPrivacy(serialized, 'state/usage-remote-observations.json'), []);
  } finally {
    await rm(tempStateDir, { recursive: true, force: true }).catch(() => {});
  }
});

const skipRepoPrivacyTest = process.env.GRAVITYBOX_SKIP_REPO_PRIVACY_TEST === '1'
  ? 'verify.mjs 本轮已独立执行全仓隐私门禁，跳过单元阶段重复扫描'
  : false;

test('仓库现状隐私门禁：当前代码库不得存在非白名单邮箱或敏感标识', { skip: skipRepoPrivacyTest }, async () => {
  const result = await runPrivacyCheck({ repoRoot, staged: false });
  assert.ok(result.scannedCount > 50, '应扫描完整仓库文件');
  assert.deepEqual(result.issues, []);
});
