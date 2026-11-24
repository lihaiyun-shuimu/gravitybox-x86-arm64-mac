import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CDP } from '../dist/cdp.js';
import { TEST_CHROME_PATH, TEST_CHROME_VERSION } from './setup-test-browser.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const defaultOutDir = join(root, 'assets', 'screenshots');

function resolveChromeBinary() {
  const candidates = [
    process.env.CHROME_BIN,
    process.env.CHROME_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    TEST_CHROME_PATH,
    join(root, '..', 'gravitybox', '.cache', `test-chrome-${TEST_CHROME_VERSION}-mac-arm64`, 'chrome-headless-shell'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('未找到可用的 Chromium / Chrome 可执行文件，请先运行 node tools/setup-test-browser.mjs 或设置 CHROME_BIN');
}

function buildShowcaseHtml({ locale, dark, compactBarOnly }) {
  const isEn = locale === 'en';
  const titleText = isEn ? 'Antigravity · Agent Session' : 'Antigravity · Agent 会话';
  const statusPill = isEn ? 'GravityBox HUD Active' : 'GravityBox HUD 已挂载';
  const userPrompt = isEn
    ? 'Refactor the payment ledger and verify all unit tests'
    : '帮我重构支付模块并校验所有单元测试';
  const thoughtMeta = isEn ? 'Thought for 14s · 6 tool calls' : '已思考 14 秒 · 调用 6 次工具';
  const replyLead = isEn ? 'Completed transaction splitting and regression checks in ' : '已完成 ';
  const replyTail = isEn
    ? ' — all 36 unit tests passed with 96.7% cache hit rate.'
    : ' 的并发事务拆分与回归校验，36 个单元测试全部通过，缓存命中率保持在 96.7%。';
  const draftPlaceholder = isEn ? '@ledger.ts Add boundary tests' : '@ledger.ts 补充边界测试';
  const modelPillLabel = compactBarOnly ? 'Gemini 4 Hydrogen' : 'Gemini 4 Hydrogen';

  const bgGradient = dark
    ? 'linear-gradient(155deg, #0f131a 0%, #090c11 100%)'
    : 'linear-gradient(155deg, #eef3f9 0%, #e4ebf4 100%)';
  const winBg = dark ? '#181c24' : '#ffffff';
  const winBorder = dark ? 'rgba(255, 255, 255, 0.11)' : 'rgba(15, 23, 42, 0.08)';
  const winShadow = dark
    ? '0 22px 54px rgba(0, 0, 0, 0.62), 0 2px 8px rgba(0, 0, 0, 0.35)'
    : '0 20px 50px rgba(15, 23, 42, 0.12), 0 2px 8px rgba(15, 23, 42, 0.06)';
  const topBorder = dark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(15, 23, 42, 0.06)';
  const textPrimary = dark ? '#f1f5f9' : '#111827';
  const textSecondary = dark ? '#94a3b8' : '#64748b';
  const badgeBg = dark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(15, 23, 42, 0.04)';
  const badgeBorder = dark ? 'rgba(255, 255, 255, 0.10)' : 'rgba(15, 23, 42, 0.10)';
  const userBubbleBg = dark ? '#252b37' : '#f1f5f9';
  const codeBg = dark ? 'rgba(56, 139, 253, 0.16)' : '#eaf2ff';
  const codeFg = dark ? '#79b8ff' : '#2563eb';
  const composerBg = dark ? '#1d222b' : '#ffffff';
  const composerBorder = dark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(15, 23, 42, 0.13)';
  const modelPillBg = dark ? 'rgba(255, 255, 255, 0.06)' : '#f5f7fa';
  const modelPillBorder = dark ? 'rgba(255, 255, 255, 0.10)' : 'rgba(15, 23, 42, 0.10)';

  const bodyStyles = compactBarOnly
    ? `
      body {
        margin: 0;
        padding: 16px 24px;
        background: ${bgGradient};
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 100vh;
        box-sizing: border-box;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Helvetica Neue", sans-serif;
      }
      .shell {
        width: 100%;
        background: ${winBg};
        border: 1px solid ${winBorder};
        border-radius: 16px;
        box-shadow: ${winShadow};
        padding: 16px 24px 12px;
        box-sizing: border-box;
      }
    `
    : `
      body {
        margin: 0;
        padding: 24px 32px;
        background: ${bgGradient};
        display: flex;
        align-items: stretch;
        justify-content: center;
        min-height: 100vh;
        box-sizing: border-box;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Helvetica Neue", sans-serif;
        color: ${textPrimary};
      }
      .shell {
        width: 100%;
        background: ${winBg};
        border: 1px solid ${winBorder};
        border-radius: 14px;
        box-shadow: ${winShadow};
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }
      .titlebar {
        height: 44px;
        padding: 0 18px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        border-bottom: 1px solid ${topBorder};
        flex-shrink: 0;
      }
      .lights { display: flex; gap: 8px; width: 160px; }
      .dot { width: 12px; height: 12px; border-radius: 50%; }
      .dot-red { background: #ff5f57; }
      .dot-yellow { background: #febc2e; }
      .dot-green { background: #28c840; }
      .title-text { font-size: 13px; font-weight: 600; color: ${textPrimary}; letter-spacing: -0.01em; }
      .title-right { width: 160px; display: flex; justify-content: flex-end; }
      .status-pill {
        font-size: 11px;
        font-weight: 500;
        color: ${textSecondary};
        background: ${badgeBg};
        border: 1px solid ${badgeBorder};
        border-radius: 999px;
        padding: 4px 10px;
        white-space: nowrap;
      }
      .conv-wrap {
        flex: 1;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        padding: 16px 28px 12px;
        gap: 10px;
      }
      .messages {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .user-row { display: flex; justify-content: flex-end; }
      .user-bubble {
        background: ${userBubbleBg};
        color: ${textPrimary};
        padding: 9px 14px;
        border-radius: 12px;
        font-size: 13px;
        line-height: 1.45;
      }
      .assistant-block {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .thought-meta {
        font-size: 12px;
        color: ${textSecondary};
      }
      .assistant-text {
        font-size: 13.5px;
        line-height: 1.55;
        color: ${textPrimary};
      }
      .inline-code {
        background: ${codeBg};
        color: ${codeFg};
        padding: 2px 6px;
        border-radius: 5px;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 12px;
      }
    `;

  return `<!DOCTYPE html>
<html lang="${isEn ? 'en' : 'zh-CN'}"${dark ? ' data-theme="dark"' : ''}>
<head>
  <meta charset="utf-8" />
  <style>
    ${bodyStyles}
    .composer-column {
      display: flex;
      flex-direction: column;
      width: 100%;
    }
    .surface-composer {
      background: ${composerBg};
      border: 1px solid ${composerBorder};
      border-radius: 18px;
      padding: 12px 14px 10px 16px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      box-sizing: border-box;
    }
    .composer-input {
      font-size: 13.5px;
      color: ${textSecondary};
      outline: none;
    }
    .composer-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .model-pill {
      font-size: 12px;
      font-weight: 500;
      color: ${textPrimary};
      background: ${modelPillBg};
      border: 1px solid ${modelPillBorder};
      border-radius: 999px;
      padding: 4px 12px;
      font-family: inherit;
    }
    .send-btn {
      width: 30px;
      height: 30px;
      border-radius: 50%;
      border: none;
      background: #2563eb;
      color: #ffffff;
      font-size: 14px;
      font-weight: 600;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
  </style>
</head>
<body>
  <div class="shell" data-testid="conversation-view" data-conversation-id="showcase-hud-v113">
    ${compactBarOnly ? '' : `
      <div class="titlebar">
        <div class="lights">
          <span class="dot dot-red"></span>
          <span class="dot dot-yellow"></span>
          <span class="dot dot-green"></span>
        </div>
        <div class="title-text">${titleText}</div>
        <div class="title-right"><span class="status-pill">${statusPill}</span></div>
      </div>
    `}
    <div class="${compactBarOnly ? 'composer-column' : 'conv-wrap'}">
      ${compactBarOnly ? '' : `
        <div class="messages">
          <div class="user-row"><div class="user-bubble">${userPrompt}</div></div>
          <div class="assistant-block">
            <div class="thought-meta">${thoughtMeta}</div>
            <div class="assistant-text">${replyLead}<code class="inline-code">src/billing/ledger.ts</code>${replyTail}</div>
          </div>
        </div>
      `}
      <div class="composer-column" data-testid="agent-input-box">
        <div class="surface-composer">
          <div class="composer-input" contenteditable="true" aria-label="Message input">${draftPlaceholder}</div>
          <div class="composer-footer">
            <button type="button" class="model-pill" data-testid="model-selector-trigger">${modelPillLabel}</button>
            <button type="button" class="send-btn" aria-label="Send">↑</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;
}

function buildMetricsPayload(scenario, locale = 'zh-Hans') {
  const baseSession = {
    turns: 3,
    steps: 19,
    compactionCount: scenario === 'context' || scenario === 'capsules' ? 2 : 0,
    runningSubagentCount: 2,
    subagentCount: 2,
    subagentSteps: 8,
    modelDurationSeconds: 72,
    modelDurationFormatted: '1分12秒',
    modelDurationFormattedEn: '1m12s',
    toolDurationSeconds: 28,
    toolDurationFormatted: '28秒',
    toolDurationFormattedEn: '28s',
    averageTtftSeconds: 1.42,
    averageTtftFormatted: '1.42 秒',
    averageTtftFormattedEn: '1.42s',
    outputTps: 90.4,
    outputTpsFormatted: '90.4 tok/s',
    latestStepTtftSeconds: 1.18,
    latestStepTtftFormatted: '1.18 秒',
    latestStepTtftFormattedEn: '1.18s',
    latestStepOutputTps: 96.2,
    latestStepOutputTpsFormatted: '96.2 tok/s',
    currentTurnDurationSeconds: 18,
    currentTurnDurationCompactZh: '本轮 18s',
    currentTurnDurationCompactEn: 'Turn 18s',
    currentTurnDurationFormatted: '18秒',
    currentTurnDurationFormattedEn: '18s',
  };

  const baseTokens = {
    totalTokens: 58593793,
    totalTokensCompact: '58.6M tok',
    totalTokensFormatted: '58.6M tok',
    cacheHitRate: 0.967,
    cacheHitRateFormatted: '97%',
    uncachedInputTokens: 1830000,
    uncachedInputFormatted: '1.83M tok',
    cachedReadTokens: 56600000,
    cachedReadFormatted: '56.6M tok',
    cacheWriteTokens: 100000,
    cacheWriteFormatted: '100K tok',
    outputTokens: 105000,
    outputFormatted: '105K tok',
    reasoningTokens: 42800,
    candidateTokens: 62200,
    estimatedCostUsd: 0.18,
    estimatedCostFormatted: '~$0.18',
    cacheSavedUsd: 1.02,
    cacheSavedFormatted: '~$1.02',
  };

  const useCompactExecLabel = locale === 'en' && scenario === 'context';
  const execModelId = useCompactExecLabel ? 'gemini-3.8-flash' : 'gemini-4-hydrogen';
  const execDisplayName = useCompactExecLabel ? 'Gemini 3.8 Flash' : 'Gemini 4 Hydrogen';
  const execShortLabel = useCompactExecLabel ? 'Flash' : 'Hydrogen';
  const execCompactLabel = useCompactExecLabel ? 'F' : 'H';

  const multiContext = {
    hasUsageData: true,
    modelId: execModelId,
    modelDisplayName: execDisplayName,
    modelShortLabel: execShortLabel,
    modelCompactLabel: execCompactLabel,
    isMultiModel: true,
    isOrchestrator: true,
    usedTokens: 339000,
    usedTokensCompact: '339K',
    peakContextTokens: 466000,
    capacityTokens: 512000,
    capacityTokensCompact: '512K',
    isFallbackCapacity: false,
    usedRatio: 0.662,
    usedRatioFormatted: '66%',
    breakdown: {
      cachedContextTokens: 337000,
      cachedContextRatio: 65.8,
      uncachedContextTokens: 2460,
      uncachedContextRatio: 0.48,
      latestOutputTokens: 346,
    },
    modelStages: [
      {
        slotKey: 'orchestrator:executor',
        role: 'executor',
        section: 'primary',
        modelId: execModelId,
        modelDisplayName: execDisplayName,
        shortLabel: execShortLabel,
        compactLabel: execCompactLabel,
        hasUsageData: true,
        isActive: true,
        usedTokens: 339000,
        peakContextTokens: 466000,
        capacityTokens: 512000,
        isFallbackCapacity: false,
        usedRatio: 0.662,
        usedRatioFormatted: '66.2%',
      },
      {
        slotKey: 'orchestrator:planner',
        role: 'planner',
        section: 'primary',
        modelId: 'gemini-4-neon',
        modelDisplayName: 'Gemini 4 Neon',
        shortLabel: 'Neon',
        compactLabel: 'N',
        hasUsageData: true,
        isActive: false,
        compactionCount: 2,
        usedTokens: 316000,
        peakContextTokens: 316000,
        capacityTokens: 512000,
        isFallbackCapacity: false,
        usedRatio: 0.618,
        usedRatioFormatted: '61.8%',
      },
    ],
  };

  return {
    conversationId: 'showcase-hud-v113',
    sessionRevision: 1,
    metricsSequence: 9999999,
    updatedAt: Date.now(),
    availability: 'ready',
    isStreaming: scenario === 'session' || scenario === 'capsules',
    activityPhase: scenario === 'session' || scenario === 'capsules' ? 'generating' : 'idle',
    isSubagentRunning: true,
    runningSubagentCount: 2,
    session: baseSession,
    tokens: baseTokens,
    context: multiContext,
  };
}

async function until(fn, timeout = 8000, label = 'condition') {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

export async function captureHudScreenshots({ outDir = defaultOutDir } = {}) {
  await mkdir(outDir, { recursive: true });
  const engineCode = await readFile(join(root, 'dist', 'engine.js'), 'utf8');
  const chromeBin = resolveChromeBinary();
  const profileDir = await mkdtemp(join(tmpdir(), 'gb-hud-shot-'));

  let currentHtml = '<html><body>loading</body></html>';
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(currentHtml);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  let chrome;
  let cdp;
  try {
    chrome = spawn(
      chromeBin,
      [
        '--headless=new',
        '--disable-gpu',
        `--user-data-dir=${profileDir}`,
        '--remote-debugging-port=0',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-extensions',
        `${origin}/`,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    );
    const port = await until(async () => {
      const text = await readFile(join(profileDir, 'DevToolsActivePort'), 'utf8');
      return Number(text.split('\n')[0]);
    }, 15000, 'DevToolsActivePort');

    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const pageTarget = targets.find((item) => item.type === 'page') ?? targets[0];
    cdp = new CDP(pageTarget.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    const shots = [
      { prefix: '', locale: 'zh-Hans' },
      { prefix: 'en-', locale: 'en' },
    ];

    const specs = [
      { key: 'hud', width: 1080, height: 540, scenario: 'tokens', capsule: '.capsule-tokens', compact: false },
      { key: 'hud-capsules', width: 800, height: 176, scenario: 'capsules', capsule: null, compact: true },
      { key: 'hud-card-session', width: 880, height: 420, scenario: 'session', capsule: '.capsule-session', compact: false },
      { key: 'hud-card-tokens', width: 880, height: 420, scenario: 'tokens', capsule: '.capsule-tokens', compact: false },
      { key: 'hud-card-context', width: 880, height: 440, scenario: 'context', capsule: '.capsule-context', compact: false },
    ];

    const generated = [];
    for (const { prefix, locale } of shots) {
      for (const dark of [false, true]) {
        for (const spec of specs) {
          const fileName = `${prefix}${spec.key}${dark ? '-dark' : ''}.png`;
          currentHtml = buildShowcaseHtml({ locale, dark, compactBarOnly: spec.compact });
          await cdp.send('Emulation.setDeviceMetricsOverride', {
            width: spec.width,
            height: spec.height,
            deviceScaleFactor: 2,
            mobile: false,
          });
          await cdp.send('Emulation.setEmulatedMedia', {
            features: [
              { name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' },
              { name: 'prefers-reduced-motion', value: 'reduce' },
            ],
          });
          await cdp.send('Page.navigate', { url: `${origin}/?shot=${encodeURIComponent(fileName)}` });
          await until(
            () => cdp.evaluate(`document.readyState === 'complete' && !!document.querySelector('[data-testid="conversation-view"]')`),
            8000,
            `${fileName} ready`
          );

          const bootPayload = {
            origin,
            path: '/',
            dictionary: { version: '2.34.0', entries: {} },
            conservative: true,
            runtimeId: `hud-shot-${fileName}`,
            shortcutEnabled: false,
            hudEnabled: true,
            translationEnabled: false,
            languageMode: locale === 'en' ? 'en' : 'zh',
            locale,
            shellValidated: true,
          };

          await cdp.evaluate(`(() => {
            delete globalThis.__GRAVITYBOX_ATTACH_DEEP_SCAN__;
            delete globalThis.__GRAVITYBOX_ATTACH_HUD__;
            globalThis.__GRAVITYBOX_BOOT__ = ${JSON.stringify(bootPayload)};
          })()`);
          await cdp.evaluate(engineCode);
          await cdp.evaluate(`globalThis.__GRAVITYBOX_HUD_V1__?.reconcileMounts?.()`);
          await until(() => cdp.evaluate(`Boolean(document.querySelector('#__gravitybox_hud_host__')?.shadowRoot)`), 8000, `${fileName} host`);

          const metrics = buildMetricsPayload(spec.scenario, locale);
          const isStreamingScene = spec.scenario === 'session' || spec.scenario === 'capsules';
          await cdp.evaluate(`(() => {
            const srHost = document.querySelector('#__gravitybox_hud_host__');
            if (${dark ? 'true' : 'false'}) srHost?.setAttribute('data-theme', 'dark');
            const mgr = globalThis.__GRAVITYBOX_HUD_V1__?.manager;
            const inst = mgr ? [...mgr.instances.values()][0] : null;
            if (!inst) return;
            if (${isStreamingScene ? 'true' : 'false'}) {
              inst.notifyModelOrStreamingChange(null, true, true, 2, null, 'generating');
            }
            const payload = ${JSON.stringify(metrics)};
            payload.sessionRevision = inst.getSessionRevision();
            mgr.dispatchMetrics(payload);
            ${spec.capsule ? `srHost.shadowRoot.querySelector(${JSON.stringify(spec.capsule)}).click();` : ''}
          })()`);

          await until(async () => {
            return await cdp.evaluate(`(() => {
              const sr = document.querySelector('#__gravitybox_hud_host__')?.shadowRoot;
              if (!sr) return false;
              const pct = sr.querySelector('#hud-txt-context')?.textContent?.trim();
              if (!pct || pct === '—') return false;
              ${spec.capsule
                ? `const popId = ${JSON.stringify(spec.capsule === '.capsule-session' ? '#hud-popover-session' : spec.capsule === '.capsule-tokens' ? '#hud-popover-tokens' : '#hud-popover-context')};
                   const pop = sr.querySelector(popId);
                   return Boolean(pop && !pop.hasAttribute('hidden') && pop.getBoundingClientRect().height > 40);`
                : 'return true;'}
            })()`);
          }, 8000, `${fileName} settle`);

          // Allow layout & shadow transitions to settle
          await new Promise((resolve) => setTimeout(resolve, 120));
          const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
          const dest = join(outDir, fileName);
          await writeFile(dest, Buffer.from(shot.data, 'base64'));
          generated.push({ fileName, size: `${spec.width * 2}x${spec.height * 2}` });
        }
      }
    }

    for (const item of generated) {
      console.log(`✓ 已生成 HUD 截图 ${item.fileName} (${item.size})`);
    }
    return generated;
  } finally {
    try { cdp?.close(); } catch {}
    try { chrome?.kill('SIGTERM'); } catch {}
    try { server.close(); } catch {}
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  captureHudScreenshots().catch((error) => {
    console.error('[capture-hud-screenshots]', error);
    process.exitCode = 1;
  });
}
