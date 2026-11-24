import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyStagedNewModels,
  applyVerifiedPriceUpdate,
  buildAutoStagedAliases,
  buildMarkdownFallbackUrl,
  bumpCatalogVersion,
  detectBlockedOrEmptyPage,
  evaluateModelConsensus,
  evaluateNewModelStagingCandidate,
  extractCleanPricingText,
  extractPricesWithGemini,
  hasSemanticCatalogChanges,
  normalizeUpstreamModelKey,
  parseAntigravityHostModels,
  parseLiteLlmRates,
  parseOpenRouterRates,
  runAutoUpdatePricing,
  verifyOfficialEvidence,
  verifyOfficialPromoEvidence,
  verifyOfficialTierEvidence,
} from '../tools/auto-update-pricing.mjs';
import { buildPricingFeed } from '../tools/sync-pricing-feed.mjs';
import * as pricingMod from '../dist/pricing.js';

const {
  resolvePricingForTimestamp,
  validateRawPrices,
  resolveContextTierPricing,
  calculateEstimatedUsd,
  priceStatus,
  localizePricingProvenance,
} = pricingMod;

test('HTML 降噪：剥离噪声标签、保留表格结构并在超长页面优先保留底部价格锚点', () => {
  const filler = '<p>无关营销文案介绍段落。'.repeat(120) + '</p>';
  const html = `
    <html>
      <head><style>.x{color:red}</style><script>window.__data={};</script></head>
      <body>
        <nav><a href="/home">Home</a></nav>
        ${filler}
        <table>
          <tr><th>Model</th><th>Input</th><th>Output</th></tr>
          <tr><td>Claude Sonnet 5.5</td><td>$2.00 / 1M tokens</td><td>$10.00 / 1M tokens</td></tr>
        </table>
        <footer>Copyright 2026</footer>
      </body>
    </html>
  `;
  const clean = extractCleanPricingText(html, 900);
  assert.equal(clean.includes('window.__data'), false);
  assert.equal(clean.includes('Copyright 2026'), false);
  assert.match(clean, /Claude Sonnet 5\.5 \| \$2\.00 \/ 1M tokens \| \$10\.00 \/ 1M tokens/);

  assert.equal(
    detectBlockedOrEmptyPage('<html>Just a moment... cf-browser-verification</html>', 'Just a moment', null),
    'anti_bot_challenge'
  );
  assert.equal(detectBlockedOrEmptyPage('<html><body></body></html>', 'tiny', null), 'empty_or_csr_shell');

  const mediumLongDoc = `<p>${'Gemini pricing row sample text '.repeat(3500)}</p><p>Tail Marker: gemini-2.5-flash $0.30</p>`;
  const cleanDefault = extractCleanPricingText(mediumLongDoc);
  assert.ok(cleanDefault.length > 100_000);
  assert.match(cleanDefault, /Tail Marker: gemini-2\.5-flash \$0\.30/);
});

test('LiteLLM 与 OpenRouter 解析：过滤区域/batch/非文本通道，保留直连标准报价', () => {
  const parsedLt = parseLiteLlmRates({
    'bedrock/anthropic.claude-sonnet-5-5-v1': { input_cost_per_token: 9e-6, output_cost_per_token: 9e-5 },
    'openai/gpt-4o-batch': { input_cost_per_token: 1.25e-6, output_cost_per_token: 5e-6 },
    'vertex_ai/us-central1/gemini-3.8-flash': { input_cost_per_token: 9e-6, output_cost_per_token: 9e-5 },
    'anthropic/claude-sonnet-5-5': {
      input_cost_per_token: 2e-6,
      output_cost_per_token: 10e-6,
      cache_read_input_token_cost: 0.1e-6,
      cache_creation_input_token_cost: 2.5e-6,
    },
    'vertex_ai/gemini-3.8-flash': { input_cost_per_token: 0.9e-6, output_cost_per_token: 4.5e-6 },
    'gemini/gemini-3.8-flash': {
      input_cost_per_token: 0.75e-6,
      output_cost_per_token: 3.75e-6,
      cache_read_input_token_cost: 0.075e-6,
    },
  });

  assert.equal(parsedLt.get('claude-sonnet-5-5')?.input, 2);
  assert.equal(parsedLt.get('claude-sonnet-5-5')?.cacheWrite, 2.5);
  assert.equal(parsedLt.get('gemini-3.8-flash')?.input, 0.75);
  assert.equal(parsedLt.has('gpt-4o-batch'), false);

  const parsedOr = parseOpenRouterRates({
    data: [
      { id: 'anthropic/claude-sonnet-5-5', pricing: { prompt: '0.000002', completion: '0.00001' } },
      { id: 'openai/gpt-4o:free', pricing: { prompt: '0', completion: '0' } },
    ],
  });
  assert.equal(parsedOr.get('claude-sonnet-5-5')?.output, 10);
  assert.equal(parsedOr.has('gpt-4o:free'), false);
});

test('共识门禁：双源一致放行 green，分歧/孤证/越界波动/未来预设区间拦截为 yellow', () => {
  const nowMs = Date.parse('2026-11-17T02:00:00Z');
  const baseEntry = {
    model: 'claude-sonnet-5-5',
    input: 3.0,
    output: 15.0,
    cached: 0.3,
    cacheWrite: 3.75,
    provenance: { verification: 'confirmed', sourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing' },
  };

  const green = evaluateModelConsensus({
    key: 'claude-sonnet-5-5',
    localEntry: baseEntry,
    official: {
      officialModelName: 'Claude Sonnet 5.5',
      inputPer1M: 2.0,
      outputPer1M: 10.0,
      cachedPer1M: 0.2,
      cacheWritePer1M: 2.5,
      hasContextTiers: false,
      confidence: 'high',
      evidenceQuote: 'Claude Sonnet 5.5: $2 / MTok input, $10 / MTok output',
    },
    litellm: { input: 2.0, output: 10.0, cached: 0.2, cacheWrite: 2.5 },
    nowMs,
  });
  assert.equal(green.status, 'green');
  assert.deepEqual(green.proposed, { input: 2, output: 10, cached: 0.2, cacheWrite: 2.5 });

  const diverged = evaluateModelConsensus({
    key: 'claude-sonnet-5-5',
    localEntry: baseEntry,
    official: { officialModelName: 'Claude Sonnet 5.5', inputPer1M: 2.0, outputPer1M: 10.0, cachedPer1M: 0.2, cacheWritePer1M: 2.5, confidence: 'high', evidenceQuote: '...' },
    litellm: { input: 2.5, output: 12.0, cached: 0.25, cacheWrite: 3.0 },
    nowMs,
  });
  assert.equal(diverged.status, 'yellow');

  const singleSource = evaluateModelConsensus({
    key: 'claude-sonnet-5-5',
    localEntry: baseEntry,
    official: { officialModelName: 'Claude Sonnet 5.5', inputPer1M: 2.0, outputPer1M: 10.0, cachedPer1M: 0.2, cacheWritePer1M: 2.5, confidence: 'high', evidenceQuote: '...' },
    litellm: null,
    nowMs,
  });
  assert.equal(singleSource.status, 'yellow');

  const extremeDrop = evaluateModelConsensus({
    key: 'claude-sonnet-5-5',
    localEntry: baseEntry,
    official: { officialModelName: 'Claude Sonnet 5.5', inputPer1M: 0.3, outputPer1M: 1.5, cachedPer1M: 0.03, cacheWritePer1M: 0.375, confidence: 'high', evidenceQuote: '...' },
    litellm: { input: 0.3, output: 1.5, cached: 0.03, cacheWrite: 0.375 },
    nowMs,
  });
  assert.equal(extremeDrop.status, 'yellow');

  const withFutureInterval = {
    ...baseEntry,
    intervals: [
      { model: 'claude-sonnet-5-5', validFrom: null, validUntil: '2026-11-30T23:59:59Z', input: 3, output: 15, cached: 0.3, cacheWrite: 3.75 },
      { model: 'claude-sonnet-5-5', validFrom: '2026-12-01T00:00:00Z', validUntil: null, input: 4, output: 20, cached: 0.4, cacheWrite: 5.0 },
    ],
  };
  const futureBlocked = evaluateModelConsensus({
    key: 'claude-sonnet-5-5',
    localEntry: withFutureInterval,
    official: { officialModelName: 'Claude Sonnet 5.5', inputPer1M: 2.0, outputPer1M: 10.0, cachedPer1M: 0.2, cacheWritePer1M: 2.5, confidence: 'high', evidenceQuote: '...' },
    litellm: { input: 2.0, output: 10.0, cached: 0.2, cacheWrite: 2.5 },
    nowMs,
  });
  assert.equal(futureBlocked.status, 'yellow');

  // 若官网价正好吻合本地已排期的未来生效区间（如 gemini-4-hydrogen 的 2027-01-12 cacheWrite=$1.875），不重复报黄灯
  const hydrogenScheduledEntry = {
    model: 'gemini-4-hydrogen',
    input: 1.5,
    output: 7.5,
    cached: 0.075,
    cacheWrite: 0,
    intervals: [
      { model: 'gemini-4-hydrogen', validFrom: null, validUntil: '2027-01-11T23:59:59Z', input: 1.5, output: 7.5, cached: 0.075, cacheWrite: 0 },
      { model: 'gemini-4-hydrogen', validFrom: '2027-01-12T00:00:00Z', validUntil: null, input: 1.5, output: 7.5, cached: 0.075, cacheWrite: 1.875 },
    ],
  };
  const scheduledExpected = evaluateModelConsensus({
    key: 'gemini-4-hydrogen',
    localEntry: hydrogenScheduledEntry,
    official: { officialModelName: 'Gemini 4 Hydrogen', inputPer1M: 1.5, outputPer1M: 7.5, cachedPer1M: 0.075, cacheWritePer1M: 1.875, confidence: 'high', evidenceQuote: '...' },
    litellm: { input: 1.5, output: 7.5, cached: 0.075 },
    nowMs,
  });
  assert.equal(scheduledExpected.status, 'unchanged');

  // gemini-4-neon 同样按 2027-01-12 cacheWrite=$3.75 未来区间排期，不应误报黄灯
  const neonScheduledEntry = {
    model: 'gemini-4-neon',
    input: 3.0,
    output: 15.0,
    cached: 0.15,
    cacheWrite: 0,
    intervals: [
      { model: 'gemini-4-neon', validFrom: null, validUntil: '2027-01-11T23:59:59Z', input: 3.0, output: 15.0, cached: 0.15, cacheWrite: 0 },
      { model: 'gemini-4-neon', validFrom: '2027-01-12T00:00:00Z', validUntil: null, input: 3.0, output: 15.0, cached: 0.15, cacheWrite: 3.75 },
    ],
  };
  const neonScheduledExpected = evaluateModelConsensus({
    key: 'gemini-4-neon',
    localEntry: neonScheduledEntry,
    official: { officialModelName: 'Gemini 4 Neon', inputPer1M: 3.0, outputPer1M: 15.0, cachedPer1M: 0.15, cacheWritePer1M: 3.75, confidence: 'high', evidenceQuote: '...' },
    litellm: { input: 3.0, output: 15.0, cached: 0.15 },
    nowMs: Date.parse('2026-11-19T02:00:00Z'),
  });
  assert.equal(neonScheduledExpected.status, 'unchanged');
});

test('安全增量写入：不篡改历史区间、保持英文 provenance 无中文残留并正确递增 -rN 版本号', () => {
  assert.equal(bumpCatalogVersion('2026-11-13', '2026-11-17'), '2026-11-17');
  assert.equal(bumpCatalogVersion('2026-11-17', '2026-11-17'), '2026-11-17-r2');
  assert.equal(bumpCatalogVersion('2026-11-17-r2', '2026-11-17'), '2026-11-17-r3');

  const catalog = {
    pricingVersion: '2026-11-13',
    pricingUpdatedAt: '2026-11-13T00:00:00Z',
    prices: {
      'claude-3-5-haiku': {
        model: 'claude-3-5-haiku',
        input: 1.0,
        output: 5.0,
        cached: 0.1,
        cacheWrite: 1.25,
        provenance: {
          sourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
          platform: 'Anthropic 标准 API',
          conditions: 'Anthropic 官方 Claude 3.5 Haiku 标准文本基准',
          checkedAt: '2026-11-12',
          validFrom: null,
          validUntil: null,
          verification: 'confirmed',
        },
      },
    },
  };

  const day1Ms = Date.parse('2026-11-17T02:00:00Z');
  applyVerifiedPriceUpdate(catalog, 'claude-3-5-haiku', { input: 0.8, output: 4.0, cached: 0.08, cacheWrite: 1.0 }, day1Ms);

  const entry = catalog.prices['claude-3-5-haiku'];
  assert.equal(entry.input, 0.8);
  assert.equal(entry.intervals.length, 2);
  assert.equal(entry.intervals[0].validUntil, '2026-11-16T23:59:59Z');
  assert.equal(entry.intervals[1].validFrom, '2026-11-17T00:00:00Z');
  assert.equal(catalog.pricingVersion, '2026-11-17');

  const oldPrice = resolvePricingForTimestamp(entry, Math.floor(Date.parse('2026-11-16T12:00:00Z') / 1000));
  const newPrice = resolvePricingForTimestamp(entry, Math.floor(Date.parse('2026-11-17T12:00:00Z') / 1000));
  assert.equal(oldPrice?.input, 1.0);
  assert.equal(newPrice?.input, 0.8);

  assert.equal(/[\u4e00-\u9fff]/.test(entry.provenance.conditionsEn ?? ''), false);
  if (typeof pricingMod.localizePricingProvenance === 'function') {
    const enProv = pricingMod.localizePricingProvenance(entry.provenance, 'en');
    assert.equal(/[\u4e00-\u9fff]/.test(enProv?.conditions ?? ''), false);
  }

  // 同日二次更新只刷新当日区间且版本号递增为 -r2
  const day1SecondMs = Date.parse('2026-11-17T08:00:00Z');
  applyVerifiedPriceUpdate(catalog, 'claude-3-5-haiku', { input: 0.75, output: 3.75, cached: 0.075, cacheWrite: 0.94 }, day1SecondMs);
  assert.equal(entry.intervals.length, 2);
  assert.equal(entry.intervals[1].input, 0.75);
  assert.equal(catalog.pricingVersion, '2026-11-17-r2');
});

test('端到端干跑与自动写入：模拟官网 + Gemini Flash + LiteLLM 全绿闭环并生成一致 pricing-feed.json', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gb-auto-pricing-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const catalogPath = join(dir, 'model-catalog.json');
  const feedPath = join(dir, 'pricing-feed.json');
  const reportPath = join(dir, 'report.json');

  const fixtureCatalog = {
    schema: 1,
    names: { 'claude-3-5-haiku': 'Claude 3.5 Haiku' },
    prices: {
      'claude-3-5-haiku': {
        model: 'claude-3-5-haiku',
        input: 1.0,
        output: 5.0,
        cached: 0.1,
        cacheWrite: 1.25,
        provenance: {
          sourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
          platform: 'Anthropic 标准 API',
          conditions: 'Anthropic 官方标准文本基准',
          checkedAt: '2026-11-12',
          validFrom: null,
          validUntil: null,
          verification: 'confirmed',
        },
      },
    },
    activeModels: ['claude-3-5-haiku'],
    feedModels: ['claude-3-5-haiku'],
    pricingVersion: '2026-11-13',
    pricingUpdatedAt: '2026-11-13T00:00:00Z',
  };
  await writeFile(catalogPath, JSON.stringify(fixtureCatalog, null, 2) + '\n', 'utf8');

  const mockFetch = async (url) => {
    const target = String(url);
    if (target.includes('platform.claude.com')) {
      return new Response(
        '<html><body><h1>Anthropic Claude Pricing</h1>' +
          '<p>Standard API pricing per million tokens (MTok) for Claude models:</p>' +
          '<table><tr><td>Claude 3.5 Haiku</td><td>$0.80 / MTok</td><td>$4.00 / MTok</td><td>$0.08 / MTok</td><td>$1.00 / MTok</td></tr></table>' +
          '<p>All prices are in USD per 1M input and output tokens for standard global API endpoints.</p></body></html>',
        { status: 200 }
      );
    }
    if (target.includes('generativelanguage.googleapis.com')) {
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      pageParsedOk: true,
                      models: [
                        {
                          catalogKey: 'claude-3-5-haiku',
                          officialModelName: 'Claude 3.5 Haiku',
                          inputPer1M: 0.8,
                          outputPer1M: 4.0,
                          cachedPer1M: 0.08,
                          cacheWritePer1M: 1.0,
                          hasContextTiers: false,
                          confidence: 'high',
                          evidenceQuote: 'Claude 3.5 Haiku | $0.80 / MTok | $4.00 / MTok',
                        },
                      ],
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 }
      );
    }
    if (target.includes('litellm')) {
      return new Response(
        JSON.stringify({
          'anthropic/claude-3-5-haiku': {
            input_cost_per_token: 0.8e-6,
            output_cost_per_token: 4.0e-6,
            cache_read_input_token_cost: 0.08e-6,
            cache_creation_input_token_cost: 1.0e-6,
          },
        }),
        { status: 200 }
      );
    }
    if (target.includes('openrouter.ai')) {
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    throw new Error(`Unexpected URL in mockFetch: ${target}`);
  };

  const report = await runAutoUpdatePricing({
    write: true,
    nowMs: Date.parse('2026-11-17T02:00:00Z'),
    catalogPath,
    feedPath,
    reportPath,
    geminiApiKey: 'test-fake-key',
    fetchImpl: mockFetch,
  });

  assert.equal(report.decision, 'green_auto_merge');
  assert.equal(report.filesModified, true);
  assert.equal(report.greenUpdates.length, 1);

  const updatedCatalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  const updatedFeed = JSON.parse(await readFile(feedPath, 'utf8'));
  assert.equal(updatedCatalog.pricingVersion, '2026-11-17');
  assert.deepEqual(buildPricingFeed(updatedCatalog), updatedFeed);
  assert.equal(updatedFeed.prices['claude-3-5-haiku'][1].input, 0.8);
});

test('上游抓取异常与确定性 4xx 防护：HTTP 404 不重试，上游阻塞时返回 fetch_failed 防误关告警 Issue', async (t) => {
  let geminiCalls = 0;
  await assert.rejects(
    () =>
      extractPricesWithGemini({
        url: 'https://cloud.google.com/vertex-ai/pricing',
        vendor: 'Google',
        cleanText: 'Gemini 4 Hydrogen $1.50 / $7.50',
        targetModels: [{ key: 'gemini-4-hydrogen', displayName: 'Gemini 4 Hydrogen' }],
        apiKey: 'fake-key',
        model: 'invalid-model-404',
        fetchImpl: async () => {
          geminiCalls++;
          return new Response('Not Found', { status: 404 });
        },
      }),
    /Gemini API HTTP 404/
  );
  assert.equal(geminiCalls, 1, '确定性 HTTP 404 应单次立即抛出，不浪费重试');

  const dir = await mkdtemp(join(tmpdir(), 'gb-auto-pricing-fail-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const catalogPath = join(dir, 'model-catalog.json');
  const feedPath = join(dir, 'pricing-feed.json');
  const reportPath = join(dir, 'report.json');
  await writeFile(
    catalogPath,
    JSON.stringify({
      schema: 1,
      names: { 'claude-3-5-haiku': 'Claude 3.5 Haiku' },
      prices: {
        'claude-3-5-haiku': {
          model: 'claude-3-5-haiku',
          input: 1.0,
          output: 5.0,
          cached: 0.1,
          provenance: {
            sourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
            verification: 'confirmed',
          },
        },
      },
      activeModels: ['claude-3-5-haiku'],
      feedModels: ['claude-3-5-haiku'],
      pricingVersion: '2026-11-17',
    }),
    'utf8'
  );

  const report = await runAutoUpdatePricing({
    write: false,
    nowMs: Date.parse('2026-11-17T02:00:00Z'),
    catalogPath,
    feedPath,
    reportPath,
    geminiApiKey: 'test-fake-key',
    fetchImpl: async (url) => {
      const target = String(url);
      if (target.includes('platform.claude.com')) return new Response('Forbidden', { status: 403 });
      if (target.includes('litellm')) return new Response('Service Unavailable', { status: 503 });
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    },
  });

  assert.equal(report.decision, 'fetch_failed');
  assert.equal(report.pageAlerts.length >= 2, true);
  assert.match(report.summaryMarkdown, /Upstream Fetch Alerts/);
});

test('normalizeUpstreamModelKey 规范化官网空格/星号/括号展示名并保留 :free 通道后缀', () => {
  assert.equal(normalizeUpstreamModelKey('Gemini 4 Neon'), 'gemini-4-neon');
  assert.equal(normalizeUpstreamModelKey('Gemini 4 Carbon*'), 'gemini-4-carbon');
  assert.equal(normalizeUpstreamModelKey('Gemini 4 Carbon (Starting December 1, 2026)'), 'gemini-4-carbon');
  assert.equal(normalizeUpstreamModelKey('Claude Opus 5.5'), 'claude-opus-5.5');
  assert.equal(normalizeUpstreamModelKey('gemini/gemini_4_neon@default'), 'gemini-4-neon');
  assert.equal(normalizeUpstreamModelKey('openai/gpt-4o:free'), 'gpt-4o:free');
});

test('新模型雷达回归：带空格与星号的官网新模型不再漏检，支持去重与三方查价关联，并排除已入库与 Cyber Permissive', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gb-auto-pricing-radar-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const catalogPath = join(dir, 'model-catalog.json');
  const feedPath = join(dir, 'pricing-feed.json');
  const reportPath = join(dir, 'report.json');

  const fixtureCatalog = {
    schema: 1,
    names: {
      'gemini-4-carbon': 'Gemini 4 Carbon',
      'claude-opus-5-5': 'Claude Opus 5.5',
    },
    prices: {
      'gemini-4-carbon': {
        model: 'gemini-4-carbon',
        input: 2.0,
        output: 10.0,
        cached: 0.1,
        provenance: {
          sourceUrl: 'https://cloud.google.com/model-garden/pricing?hl=en',
          platform: 'Google Cloud 标准 Global API',
          conditions: 'Google Cloud 官方推广期标准 Global API 文本基准（优惠截至2026-11-30）',
          checkedAt: '2026-11-19',
          validUntil: '2026-11-30T23:59:59Z',
          verification: 'confirmed',
        },
        intervals: [
          { model: 'gemini-4-carbon', validFrom: null, validUntil: '2026-11-30T23:59:59Z', input: 2.0, output: 10.0, cached: 0.1 },
          { model: 'gemini-4-carbon', validFrom: '2026-12-01T00:00:00Z', validUntil: null, input: 4.0, output: 20.0, cached: 0.2 },
        ],
      },
      'claude-opus-5-5': {
        model: 'claude-opus-5-5',
        input: 4.0,
        output: 20.0,
        cached: 0.2,
        cacheWrite: 5.0,
        provenance: {
          sourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
          platform: 'Anthropic 标准 API',
          conditions: 'Anthropic 官方 Claude Opus 5.5 标准文本基准',
          checkedAt: '2026-11-19',
          validFrom: null,
          validUntil: null,
          verification: 'confirmed',
        },
      },
    },
    activeModels: ['gemini-4-carbon', 'claude-opus-5-5'],
    feedModels: ['gemini-4-carbon', 'claude-opus-5-5'],
    pricingVersion: '2026-11-19',
    pricingUpdatedAt: '2026-11-19T00:00:00Z',
  };
  await writeFile(catalogPath, JSON.stringify(fixtureCatalog, null, 2) + '\n', 'utf8');

  const mockFetch = async (url, init) => {
    const target = String(url);
    if (target.includes('cloud.google.com')) {
      return new Response(
        '<html><body><h1>Gemini Model Garden Standard Global API Pricing</h1>' +
          '<p>Standard pay-as-you-go text token pricing on Google Cloud per 1 million tokens in USD for global endpoints.</p>' +
          '<table><tr><td>Gemini 4 Carbon*</td><td>$2.00</td><td>$10.00</td></tr>' +
          '<tr><td>Gemini 4 Carbon Cyber Permissive</td><td>$4.00</td><td>$20.00</td></tr>' +
          '<tr><td>Gemini 5 Nova</td><td>$3.50</td><td>$17.50</td></tr></table>' +
          '<p>* Promotional pricing provided through 50% credits back through November 30, 2026 on eligible global endpoints.</p></body></html>',
        { status: 200 }
      );
    }
    if (target.includes('platform.claude.com')) {
      return new Response(
        '<html><body><h1>Anthropic Claude API Pricing (MTok)</h1>' +
          '<p>Standard API pricing per million tokens (MTok) in USD for Claude models on global endpoints.</p>' +
          '<table><tr><td>Claude Opus 5.5</td><td>$4.00 / MTok</td><td>$20.00 / MTok</td></tr>' +
          '<tr><td>Claude Sonnet 6.0</td><td>$2.50 / MTok</td><td>$12.50 / MTok</td></tr></table>' +
          '<p>All prices are in USD per 1M input, output, cache read, and cache write tokens for standard API endpoints.</p></body></html>',
        { status: 200 }
      );
    }
    if (target.includes('generativelanguage.googleapis.com')) {
      const promptBody = String(init?.body ?? '');
      const isGooglePage = promptBody.includes('cloud.google.com');
      const bodyModels = isGooglePage
        ? [
            // 模拟 Gemini 提取时留空 catalogKey，验证通过归一化匹配已入库模型、去重与雷达过滤
            {
              catalogKey: '',
              officialModelName: 'Gemini 4 Carbon*',
              inputPer1M: 2.0,
              outputPer1M: 10.0,
              cachedPer1M: 0.1,
              hasContextTiers: false,
              confidence: 'high',
              evidenceQuote: 'Gemini 4 Carbon* | $2.00 | $10.00',
            },
            {
              catalogKey: '',
              officialModelName: 'Gemini 4 Carbon Cyber Permissive',
              inputPer1M: 4.0,
              outputPer1M: 20.0,
              cachedPer1M: 0.2,
              hasContextTiers: false,
              confidence: 'high',
              evidenceQuote: 'Gemini 4 Carbon Cyber Permissive | $4.00 | $20.00',
            },
            {
              catalogKey: '',
              officialModelName: 'Gemini 5 Nova',
              inputPer1M: 3.5,
              outputPer1M: 17.5,
              cachedPer1M: 0.175,
              hasContextTiers: false,
              confidence: 'high',
              evidenceQuote: 'Gemini 5 Nova | $3.50 | $17.50',
            },
            {
              catalogKey: '',
              officialModelName: 'Gemini 5 Nova*',
              inputPer1M: 7.0,
              outputPer1M: 35.0,
              cachedPer1M: 0.35,
              hasContextTiers: false,
              confidence: 'high',
              evidenceQuote: 'Gemini 5 Nova* promo row',
            },
          ]
        : [
            {
              catalogKey: '',
              officialModelName: 'Claude Opus 5.5',
              inputPer1M: 4.0,
              outputPer1M: 20.0,
              cachedPer1M: 0.2,
              cacheWritePer1M: 5.0,
              hasContextTiers: false,
              confidence: 'high',
              evidenceQuote: 'Claude Opus 5.5 | $4.00 | $20.00',
            },
            {
              catalogKey: '',
              officialModelName: 'Claude Sonnet 6.0',
              inputPer1M: 2.5,
              outputPer1M: 12.5,
              cachedPer1M: 0.25,
              cacheWritePer1M: 3.125,
              hasContextTiers: false,
              confidence: 'high',
              evidenceQuote: 'Claude Sonnet 6.0 | $2.50 | $12.50',
            },
          ];
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: JSON.stringify({ pageParsedOk: true, models: bodyModels }) }],
              },
            },
          ],
        }),
        { status: 200 }
      );
    }
    if (target.includes('litellm')) {
      return new Response(
        JSON.stringify({
          'gemini/gemini-4-carbon': { input_cost_per_token: 2e-6, output_cost_per_token: 10e-6, cache_read_input_token_cost: 0.1e-6 },
          'gemini/gemini-5-nova': { input_cost_per_token: 3.5e-6, output_cost_per_token: 17.5e-6, cache_read_input_token_cost: 0.175e-6 },
          'anthropic/claude-opus-5-5': { input_cost_per_token: 4e-6, output_cost_per_token: 20e-6, cache_read_input_token_cost: 0.2e-6, cache_creation_input_token_cost: 5e-6 },
          'anthropic/claude-sonnet-6-0': { input_cost_per_token: 2.5e-6, output_cost_per_token: 12.5e-6, cache_read_input_token_cost: 0.25e-6, cache_creation_input_token_cost: 3.125e-6 },
        }),
        { status: 200 }
      );
    }
    if (target.includes('openrouter.ai')) {
      return new Response(
        JSON.stringify({
          data: [
            { id: 'google/gemini-5-nova', pricing: { prompt: '0.0000035', completion: '0.0000175', input_cache_read: '0.000000175' } },
            { id: 'anthropic/claude-sonnet-6.0', pricing: { prompt: '0.0000025', completion: '0.0000125', input_cache_read: '0.00000025' } },
          ],
        }),
        { status: 200 }
      );
    }
    throw new Error(`Unexpected URL in mockFetch: ${target}`);
  };

  const report = await runAutoUpdatePricing({
    write: false,
    nowMs: Date.parse('2026-11-19T02:00:00Z'),
    catalogPath,
    feedPath,
    reportPath,
    geminiApiKey: 'test-fake-key',
    fetchImpl: mockFetch,
  });

  assert.equal(report.decision, 'yellow_needs_review');
  assert.equal(report.yellowItems.length, 0);
  assert.deepEqual(
    report.newModelsRadar.map((n) => n.model),
    ['gemini-5-nova', 'claude-sonnet-6.0']
  );
  assert.equal(report.newModelsRadar[0].litellm?.input, 3.5);
  assert.equal(report.newModelsRadar[0].openrouter?.output, 17.5);
  assert.equal(report.newModelsRadar[1].litellm?.input, 2.5);
  assert.equal(report.newModelsRadar[1].openrouter?.output, 12.5);
});

test('新模型自动预入库门禁与 PR 草案生成：双源共识自动写 feedModels+衍生别名（不动 activeModels），未经 LiteLLM 确认的 cacheWrite 或阶梯价拦截', async (t) => {
  // 1) buildAutoStagedAliases：仅 Gemini 4+ 代号生成 Orchestrator / tiered 别名
  assert.deepEqual(buildAutoStagedAliases('gemini-5-nova'), {
    'gemini-pro-orchestrator-nova': 'gemini-5-nova',
    'orchestrator (nova)': 'gemini-5-nova',
    'Orchestrator (Nova)': 'gemini-5-nova',
    'gemini-5-nova-tiered': 'gemini-5-nova',
    'gemini-5-nova-tiered-low': 'gemini-5-nova',
    'gemini-5-nova-tiered-medium': 'gemini-5-nova',
    'gemini-5-nova-tiered-high': 'gemini-5-nova',
    'gemini-5-nova-tiered-xhigh': 'gemini-5-nova',
    'gemini-5-nova-tiered-extra-high': 'gemini-5-nova',
  });
  assert.deepEqual(buildAutoStagedAliases('claude-sonnet-6-0'), {});

  // 2) 未经 LiteLLM 确认的 cacheWritePer1M 或含 hasContextTiers 时不得自动预入库
  const blockedCacheWrite = evaluateNewModelStagingCandidate({
    id: 'gemini-5-pulsar',
    vendor: 'Google',
    url: 'https://cloud.google.com/model-garden/pricing?hl=en',
    official: {
      officialModelName: 'Gemini 5 Pulsar',
      inputPer1M: 3.0,
      outputPer1M: 15.0,
      cachedPer1M: 0.15,
      cacheWritePer1M: 3.75,
      hasContextTiers: false,
      confidence: 'high',
    },
    litellm: { input: 3.0, output: 15.0, cached: 0.15 },
  });
  assert.equal(blockedCacheWrite.stageable, false);

  const blockedTiers = evaluateNewModelStagingCandidate({
    id: 'gemini-5-quasar',
    vendor: 'Google',
    url: 'https://cloud.google.com/model-garden/pricing?hl=en',
    official: {
      officialModelName: 'Gemini 5 Quasar',
      inputPer1M: 2.0,
      outputPer1M: 10.0,
      cachedPer1M: 0.1,
      hasContextTiers: true,
      confidence: 'high',
    },
    litellm: { input: 2.0, output: 10.0, cached: 0.1 },
  });
  assert.equal(blockedTiers.stageable, false);

  // 3) 端到端 write: true：严格双源共识新模型预写入 model-catalog.json 与 pricing-feed.json，决策保持 yellow_needs_review 走 PR 审阅
  const dir = await mkdtemp(join(tmpdir(), 'gb-auto-pricing-stage-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const catalogPath = join(dir, 'model-catalog.json');
  const feedPath = join(dir, 'pricing-feed.json');
  const reportPath = join(dir, 'report.json');

  const fixtureCatalog = {
    schema: 1,
    names: { 'gemini-4-carbon': 'Gemini 4 Carbon' },
    prices: {
      'gemini-4-carbon': {
        model: 'gemini-4-carbon',
        input: 2.0,
        output: 10.0,
        cached: 0.1,
        provenance: {
          sourceUrl: 'https://cloud.google.com/model-garden/pricing?hl=en',
          platform: 'Google Cloud 标准 Global API',
          conditions: 'Google Cloud 官方推广期标准 Global API 文本基准（优惠截至2026-11-30）',
          checkedAt: '2026-11-18',
          validUntil: '2026-11-30T23:59:59Z',
          verification: 'confirmed',
        },
        intervals: [
          { model: 'gemini-4-carbon', validFrom: null, validUntil: '2026-11-30T23:59:59Z', input: 2.0, output: 10.0, cached: 0.1 },
          { model: 'gemini-4-carbon', validFrom: '2026-12-01T00:00:00Z', validUntil: null, input: 4.0, output: 20.0, cached: 0.2 },
        ],
      },
    },
    aliases: {},
    activeModels: ['gemini-4-carbon'],
    feedModels: ['gemini-4-carbon'],
    pricingVersion: '2026-11-18',
    pricingUpdatedAt: '2026-11-18T00:00:00Z',
  };
  await writeFile(catalogPath, JSON.stringify(fixtureCatalog, null, 2) + '\n', 'utf8');

  const mockFetch = async (url) => {
    const target = String(url);
    if (target.includes('cloud.google.com')) {
      return new Response(
        '<html><body><h1>Gemini Model Garden Standard Global API Pricing</h1>' +
          '<p>Standard pay-as-you-go text token pricing on Google Cloud per 1 million tokens in USD for global endpoints.</p>' +
          '<table><tr><td>Gemini 4 Carbon*</td><td>$2.00</td><td>$10.00</td></tr>' +
          '<tr><td>Gemini 5 Nova*</td><td>$3.50</td><td>$17.50</td></tr>' +
          '<tr><td>Gemini 5 Pulsar</td><td>$3.00</td><td>$15.00</td></tr></table>' +
          '<p>All rates apply to global standard pay-as-you-go text endpoints in USD.</p></body></html>',
        { status: 200 }
      );
    }
    if (target.includes('generativelanguage.googleapis.com')) {
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      pageParsedOk: true,
                      models: [
                        {
                          catalogKey: 'gemini-4-carbon',
                          officialModelName: 'Gemini 4 Carbon*',
                          inputPer1M: 2.0,
                          outputPer1M: 10.0,
                          cachedPer1M: 0.1,
                          hasContextTiers: false,
                          confidence: 'high',
                          evidenceQuote: 'Gemini 4 Carbon* | $2.00 | $10.00',
                        },
                        {
                          catalogKey: '',
                          officialModelName: 'Gemini 5 Nova*',
                          inputPer1M: 3.5,
                          outputPer1M: 17.5,
                          cachedPer1M: 0.175,
                          hasContextTiers: false,
                          confidence: 'high',
                          evidenceQuote: 'Gemini 5 Nova* | $3.50 | $17.50',
                        },
                        {
                          catalogKey: '',
                          officialModelName: 'Gemini 5 Pulsar',
                          inputPer1M: 3.0,
                          outputPer1M: 15.0,
                          cachedPer1M: 0.15,
                          cacheWritePer1M: 3.75,
                          hasContextTiers: false,
                          confidence: 'high',
                          evidenceQuote: 'Gemini 5 Pulsar | $3.00 | $15.00 | cw:$3.75',
                        },
                      ],
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 }
      );
    }
    if (target.includes('litellm')) {
      return new Response(
        JSON.stringify({
          'gemini/gemini-4-carbon': { input_cost_per_token: 2e-6, output_cost_per_token: 10e-6, cache_read_input_token_cost: 0.1e-6 },
          'gemini/gemini-5-nova': { input_cost_per_token: 3.5e-6, output_cost_per_token: 17.5e-6, cache_read_input_token_cost: 0.175e-6 },
          'gemini/gemini-5-pulsar': { input_cost_per_token: 3e-6, output_cost_per_token: 15e-6, cache_read_input_token_cost: 0.15e-6 },
        }),
        { status: 200 }
      );
    }
    if (target.includes('openrouter.ai')) {
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    throw new Error(`Unexpected URL in mockFetch: ${target}`);
  };

  const report = await runAutoUpdatePricing({
    write: true,
    nowMs: Date.parse('2026-11-19T02:00:00Z'),
    catalogPath,
    feedPath,
    reportPath,
    geminiApiKey: 'test-fake-key',
    fetchImpl: mockFetch,
  });

  assert.equal(report.decision, 'yellow_needs_review', '新模型预入库必须走 yellow_needs_review 人工 PR 审阅');
  assert.equal(report.filesModified, true);
  assert.equal(report.stagedNewModels.length, 1);
  assert.equal(report.stagedNewModels[0].catalogKey, 'gemini-5-nova');
  assert.match(report.summaryMarkdown, /Auto-Staged New Model Candidates/);

  const updatedCatalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  const updatedFeed = JSON.parse(await readFile(feedPath, 'utf8'));
  assert.equal(updatedCatalog.names['gemini-5-nova'], 'Gemini 5 Nova');
  assert.equal(updatedCatalog.prices['gemini-5-nova']?.input, 3.5);
  assert.equal(updatedCatalog.prices['gemini-5-nova']?.output, 17.5);
  assert.equal(updatedCatalog.prices['gemini-5-nova']?.cached, 0.175);
  assert.equal(updatedCatalog.prices['gemini-5-pulsar'], undefined, '未经 LiteLLM 确认 cacheWrite 的模型不得自动预写入');
  assert.equal(updatedCatalog.aliases['gemini-pro-orchestrator-nova'], 'gemini-5-nova');
  assert.equal(updatedCatalog.aliases['Orchestrator (Nova)'], 'gemini-5-nova');
  assert.deepEqual(updatedCatalog.activeModels, ['gemini-4-carbon'], 'activeModels 不得擅自扩大');
  assert.deepEqual(updatedCatalog.feedModels, ['gemini-4-carbon', 'gemini-5-nova']);
  assert.equal(updatedCatalog.capacities?.['gemini-5-nova'], 200000);
  assert.equal(updatedCatalog.pricingVersion, '2026-11-19');
  assert.deepEqual(buildPricingFeed(updatedCatalog), updatedFeed);
  assert.deepEqual(updatedFeed.feedModels, ['gemini-4-carbon', 'gemini-5-nova']);
  assert.equal(updatedFeed.models?.['gemini-5-nova']?.capacityTokens, 200000);

  if (typeof pricingMod.localizePricingProvenance === 'function') {
    const enProv = pricingMod.localizePricingProvenance(updatedCatalog.prices['gemini-5-nova'].provenance, 'en');
    assert.equal(/[\u4e00-\u9fff]/.test(enProv?.platform ?? ''), false);
    assert.equal(/[\u4e00-\u9fff]/.test(enProv?.conditions ?? ''), false);
  }
});

test('官网宿主白名单筛选与自证校验：屏蔽未接入模型的外部噪音，已接入新模型在 LiteLLM 滞后时仍可凭官网原文证据自动合入', async (t) => {
  // 1) parseAntigravityHostModels 解析 models.md + enterprise.md
  const sampleModelsMd = `
## Reasoning model
| Model | Free & Google AI Plus | Google AI Pro | Google AI Ultra | Enterprise |
| --- | --- | --- | --- | --- |
| [Gemini 4 Carbon](/blog/gemini-4-carbon) | ❌ | ❌ | ✅ | ✅ |
| [Orchestrator (Carbon)](/docs/models#orchestrator) | ❌ | ❌ | ✅ | ❌ |
| [Gemini 5 Nova](/blog/gemini-5-nova) | ❌ | ✅ | ✅ | ✅ |
| [Gemini 3.1 Pro](/blog/gemini-3-1-pro) | ❌ | ❌ | ❌ | ✅ |
`;
  const sampleEnterpriseMd = `
## Supported models in Gemini Enterprise
| Model | CLI / API Identifier | Enterprise |
| --- | --- | --- |
| [Gemini 3.1 Pro](/blog/gemini-3-1-pro) | \`gemini-3.1-pro-preview\` | ✅ |
`;
  const parsedHost = parseAntigravityHostModels(sampleModelsMd, sampleEnterpriseMd);
  assert.equal(parsedHost.models.has('gemini-4-carbon'), true);
  assert.equal(parsedHost.models.has('gemini-5-nova'), true);
  assert.equal(parsedHost.models.has('orchestrator-carbon'), false);
  assert.equal(parsedHost.consumerKeys.has('gemini-5-nova'), true);
  assert.equal(parsedHost.consumerKeys.has('gemini-3.1-pro'), false);
  assert.equal(parsedHost.keys.has('gemini-3.1-pro-preview'), true);

  // 2) verifyOfficialEvidence 校验原文证据句与数字
  assert.equal(
    verifyOfficialEvidence('Gemini 5 Nova | $3.50 | $17.50 | $0.175', {
      officialModelName: 'Gemini 5 Nova',
      inputPer1M: 3.5,
      outputPer1M: 17.5,
      evidenceQuote: 'Gemini 5 Nova | $3.50 | $17.50',
    }),
    true
  );
  assert.equal(
    verifyOfficialEvidence('Gemini 5 Nova | $3.50 | $17.50', {
      officialModelName: 'Gemini 5 Nova',
      inputPer1M: 1.0,
      outputPer1M: 5.0,
      evidenceQuote: 'Gemini 5 Nova | $3.50 | $17.50',
    }),
    false
  );

  // 3) LiteLLM 缺失时，通过官网原文自证的报价允许 green / stageable；但若 LiteLLM 存在冲突仍拦截
  const selfVerifiedGreen = evaluateModelConsensus({
    key: 'gemini-4-carbon',
    localEntry: { model: 'gemini-4-carbon', input: 2.0, output: 10.0, cached: 0.1 },
    official: {
      officialModelName: 'Gemini 4 Carbon',
      inputPer1M: 1.8,
      outputPer1M: 9.0,
      cachedPer1M: 0.09,
      confidence: 'high',
      evidenceQuote: 'Gemini 4 Carbon | $1.80 | $9.00',
      evidenceVerified: true,
    },
    litellm: null,
  });
  assert.equal(selfVerifiedGreen.status, 'green');

  const conflictBlocked = evaluateModelConsensus({
    key: 'gemini-4-carbon',
    localEntry: { model: 'gemini-4-carbon', input: 2.0, output: 10.0, cached: 0.1 },
    official: {
      officialModelName: 'Gemini 4 Carbon',
      inputPer1M: 1.8,
      outputPer1M: 9.0,
      cachedPer1M: 0.09,
      confidence: 'high',
      evidenceQuote: 'Gemini 4 Carbon | $1.80 | $9.00',
      evidenceVerified: true,
    },
    litellm: { input: 2.5, output: 12.5, cached: 0.25 },
  });
  assert.equal(conflictBlocked.status, 'yellow');

  // 4) 端到端 filterByAntigravityHost: true：
  //    - gpt-6.2-astra / gpt-6.2-sol（未接入 Antigravity）直接过滤，不入表、不开 Issue
  //    - gemini-5-nova（官网文档已接入，即使 LiteLLM 尚无收录）凭官网原文自证直接写入并走 green_auto_merge
  const dir = await mkdtemp(join(tmpdir(), 'gb-host-filter-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const catalogPath = join(dir, 'model-catalog.json');
  const feedPath = join(dir, 'pricing-feed.json');
  const reportPath = join(dir, 'report.json');

  await writeFile(
    catalogPath,
    JSON.stringify({
      schema: 1,
      names: { 'gemini-4-carbon': 'Gemini 4 Carbon', 'gpt-oss-120b': 'GPT-OSS 120B' },
      capacities: { 'gemini-4-carbon': 200000, 'gpt-oss-120b': 128000 },
      prices: {
        'gemini-4-carbon': {
          model: 'gemini-4-carbon',
          input: 2.0,
          output: 10.0,
          cached: 0.1,
          provenance: { sourceUrl: 'https://cloud.google.com/model-garden/pricing?hl=en', verification: 'confirmed' },
        },
        'gpt-oss-120b': {
          model: 'gpt-oss-120b',
          input: 0.15,
          output: 0.6,
          cached: 0.075,
          provenance: { sourceUrl: 'https://developers.openai.com/api/docs/pricing', verification: 'confirmed' },
        },
      },
      aliases: {},
      activeModels: ['gemini-4-carbon', 'gpt-oss-120b'],
      feedModels: ['gemini-4-carbon', 'gpt-oss-120b'],
      pricingVersion: '2026-11-19',
      pricingUpdatedAt: '2026-11-19T00:00:00Z',
    }, null, 2) + '\n',
    'utf8'
  );

  const mockFetch = async (url, init) => {
    const target = String(url);
    if (target.includes('antigravity.google/docs/models.md')) {
      return new Response(sampleModelsMd, { status: 200 });
    }
    if (target.includes('antigravity.google/docs/enterprise.md')) {
      return new Response(sampleEnterpriseMd, { status: 200 });
    }
    if (target.includes('cloud.google.com')) {
      return new Response(
        '<html><body><h1>Google Cloud Vertex AI Model Garden Pricing</h1>' +
          '<p>Standard pay-as-you-go Global API text token pricing per 1 million tokens in USD for Gemini frontier models and standard endpoints.</p>' +
          '<table><tr><td>Gemini 4 Carbon</td><td>$2.00</td><td>$10.00</td><td>$0.10</td></tr>' +
          '<tr><td>Gemini 5 Nova</td><td>$3.50</td><td>$17.50</td><td>$0.175</td></tr></table>' +
          '<p>Prices apply to standard global pay-as-you-go text generation endpoints in USD per million input, output, and cached tokens.</p></body></html>',
        { status: 200 }
      );
    }
    if (target.includes('developers.openai.com')) {
      return new Response(
        '<html><body><h1>OpenAI API Standard Text Token Pricing</h1>' +
          '<p>Standard pay-as-you-go API pricing per 1 million tokens in USD for GPT and open-weight models across global endpoints.</p>' +
          '<table><tr><td>GPT-OSS 120B</td><td>$0.15</td><td>$0.60</td><td>$0.075</td></tr>' +
          '<tr><td>gpt-6.2-astra</td><td>$8.00</td><td>$40.00</td><td>$0.40</td></tr>' +
          '<tr><td>gpt-6.2-sol</td><td>$2.00</td><td>$10.00</td><td>$0.10</td></tr></table>' +
          '<p>All listed prices apply to standard pay-as-you-go text endpoints per 1M tokens in USD.</p></body></html>',
        { status: 200 }
      );
    }
    if (target.includes('generativelanguage.googleapis.com')) {
      const promptBody = String(init?.body ?? '');
      const models = promptBody.includes('cloud.google.com')
        ? [
            { catalogKey: 'gemini-4-carbon', officialModelName: 'Gemini 4 Carbon', inputPer1M: 2.0, outputPer1M: 10.0, cachedPer1M: 0.1, confidence: 'high', evidenceQuote: 'Gemini 4 Carbon | $2.00 | $10.00 | $0.10' },
            { catalogKey: '', officialModelName: 'Gemini 5 Nova', inputPer1M: 3.5, outputPer1M: 17.5, cachedPer1M: 0.175, confidence: 'high', evidenceQuote: 'Gemini 5 Nova | $3.50 | $17.50 | $0.175' },
          ]
        : [
            { catalogKey: 'gpt-oss-120b', officialModelName: 'GPT-OSS 120B', inputPer1M: 0.15, outputPer1M: 0.6, cachedPer1M: 0.075, confidence: 'high', evidenceQuote: 'GPT-OSS 120B | $0.15 | $0.60 | $0.075' },
            { catalogKey: '', officialModelName: 'gpt-6.2-astra', inputPer1M: 8.0, outputPer1M: 40.0, cachedPer1M: 0.4, confidence: 'high', evidenceQuote: 'gpt-6.2-astra | $8.00 | $40.00 | $0.40' },
            { catalogKey: '', officialModelName: 'gpt-6.2-sol', inputPer1M: 2.0, outputPer1M: 10.0, cachedPer1M: 0.1, confidence: 'high', evidenceQuote: 'gpt-6.2-sol | $2.00 | $10.00 | $0.10' },
          ];
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ pageParsedOk: true, models }) }] } }] }),
        { status: 200 }
      );
    }
    if (target.includes('litellm')) {
      // 模拟 LiteLLM 尚未收录 gemini-5-nova，但收录了无关外部 gpt-6.2-astra
      return new Response(
        JSON.stringify({
          'gemini/gemini-4-carbon': { input_cost_per_token: 2e-6, output_cost_per_token: 10e-6, cache_read_input_token_cost: 0.1e-6 },
          'openai/gpt-6.2-astra': { input_cost_per_token: 8e-6, output_cost_per_token: 40e-6, cache_read_input_token_cost: 0.4e-6 },
        }),
        { status: 200 }
      );
    }
    if (target.includes('openrouter.ai')) {
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    throw new Error(`Unexpected URL in mockFetch: ${target}`);
  };

  const report = await runAutoUpdatePricing({
    write: true,
    filterByAntigravityHost: true,
    nowMs: Date.parse('2026-11-19T13:30:00Z'),
    catalogPath,
    feedPath,
    reportPath,
    geminiApiKey: 'test-fake-key',
    fetchImpl: mockFetch,
  });

  assert.equal(report.decision, 'green_auto_merge');
  assert.equal(report.filesModified, true);
  assert.deepEqual(report.filteredNonHostModels, ['gpt-6.2-astra', 'gpt-6.2-sol']);
  assert.deepEqual(report.newModelsRadar, []);
  assert.equal(report.stagedNewModels.length, 1);
  assert.equal(report.stagedNewModels[0].catalogKey, 'gemini-5-nova');

  const updatedCatalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  const updatedFeed = JSON.parse(await readFile(feedPath, 'utf8'));
  assert.ok(updatedCatalog.prices['gemini-5-nova']);
  assert.equal(updatedCatalog.prices['gpt-6.2-astra'], undefined);
  assert.equal(updatedCatalog.prices['gpt-6.2-sol'], undefined);
  assert.equal(updatedCatalog.activeModels.includes('gemini-5-nova'), true);
  assert.equal(updatedCatalog.feedModels.includes('gemini-5-nova'), true);
  assert.equal(updatedCatalog.capacities['gemini-5-nova'], 200000);
  assert.deepEqual(buildPricingFeed(updatedCatalog), updatedFeed);
});

test('P0/P1 回归防护：litellm 缺省空指针防护、新模型禁置零/丢 cacheWrite、原文自证锚定与宿主反向对账', async (t) => {
  // 1) evaluateModelConsensus 在 litellm === null + officialSelfVerified 时不得抛 TypeError，且校验 cached/cacheWrite 与 thresholdTokens
  const missingCachedWhenLitellmNull = evaluateModelConsensus({
    key: 'gemini-4-carbon',
    localEntry: { model: 'gemini-4-carbon', input: 2.0, output: 10.0, cached: 0.1 },
    official: {
      officialModelName: 'Gemini 4 Carbon',
      inputPer1M: 1.8,
      outputPer1M: 9.0,
      confidence: 'high',
      evidenceQuote: 'Gemini 4 Carbon | $1.80 | $9.00',
      evidenceVerified: true,
    },
    litellm: null,
  });
  assert.equal(missingCachedWhenLitellmNull.status, 'yellow');
  assert.equal(missingCachedWhenLitellmNull.reasons.some((r) => r.includes('cached')), true);

  const missingCwWhenLitellmNull = evaluateModelConsensus({
    key: 'claude-sonnet-5-5',
    localEntry: { model: 'claude-sonnet-5-5', input: 3.0, output: 15.0, cached: 0.3, cacheWrite: 3.75 },
    official: {
      officialModelName: 'Claude Sonnet 5.5',
      inputPer1M: 2.0,
      outputPer1M: 10.0,
      cachedPer1M: 0.2,
      confidence: 'high',
      evidenceQuote: 'Claude Sonnet 5.5 | $2.00 | $10.00 | $0.20',
      evidenceVerified: true,
    },
    litellm: null,
  });
  assert.equal(missingCwWhenLitellmNull.status, 'yellow');
  assert.equal(missingCwWhenLitellmNull.reasons.some((r) => r.includes('cacheWrite')), true);

  const selfVerifiedWithNewCw = evaluateModelConsensus({
    key: 'gemini-4-carbon',
    localEntry: { model: 'gemini-4-carbon', input: 2.0, output: 10.0, cached: 0.1 },
    official: {
      officialModelName: 'Gemini 4 Carbon',
      inputPer1M: 1.8,
      outputPer1M: 9.0,
      cachedPer1M: 0.1,
      cacheWritePer1M: 2.5,
      confidence: 'high',
      evidenceQuote: 'Gemini 4 Carbon | $1.80 | $9.00 | $0.10 | cw:$2.50',
      evidenceVerified: true,
    },
    litellm: null,
  });
  assert.equal(selfVerifiedWithNewCw.status, 'green');
  assert.deepEqual(selfVerifiedWithNewCw.proposed, { input: 1.8, output: 9.0, cached: 0.1, cacheWrite: 2.5 });

  const tierDiffReason = evaluateModelConsensus({
    key: 'gemini-4-carbon',
    localEntry: {
      model: 'gemini-4-carbon',
      input: 2.0,
      output: 10.0,
      cached: 0.1,
      contextTiers: [{ thresholdTokens: 200_000, input: 4.0, output: 20.0, cached: 0.2 }],
    },
    official: {
      officialModelName: 'Gemini 4 Carbon',
      inputPer1M: 2.0,
      outputPer1M: 10.0,
      cachedPer1M: 0.1,
      hasContextTiers: true,
      tierInputPer1M: 5.0,
      tierOutputPer1M: 25.0,
      confidence: 'high',
      evidenceQuote: 'Gemini 4 Carbon | $2.00 | $10.00 | $5.00 | $25.00',
    },
    litellm: { input: 2.0, output: 10.0, cached: 0.1 },
  });
  assert.equal(tierDiffReason.status, 'yellow');
  assert.equal(tierDiffReason.reasons.some((r) => r.includes('>200000:') && !r.includes('undefined')), true);

  // 2) evaluateNewModelStagingCandidate 拒绝静默置零 cached 与静默丢弃 LiteLLM 的 cacheWrite
  const zeroCachedBlocked = evaluateNewModelStagingCandidate({
    id: 'gemini-5-nova',
    vendor: 'Google',
    official: {
      officialModelName: 'Gemini 5 Nova',
      inputPer1M: 3.5,
      outputPer1M: 17.5,
      confidence: 'high',
      evidenceVerified: true,
    },
    litellm: null,
  });
  assert.equal(zeroCachedBlocked.stageable, false);
  assert.equal(zeroCachedBlocked.reasons.some((r) => r.includes('cached')), true);

  const missingOffCwBlocked = evaluateNewModelStagingCandidate({
    id: 'gpt-6.2-astra',
    vendor: 'OpenAI',
    official: {
      officialModelName: 'gpt-6.2-astra',
      inputPer1M: 8.0,
      outputPer1M: 40.0,
      cachedPer1M: 0.4,
      confidence: 'high',
      evidenceVerified: true,
    },
    litellm: { input: 8.0, output: 40.0, cached: 0.4, cacheWrite: 10.0 },
  });
  assert.equal(missingOffCwBlocked.stageable, false);
  assert.equal(missingOffCwBlocked.reasons.some((r) => r.includes('cacheWrite')), true);

  // 3) verifyOfficialEvidence 模型名锚定、$ 货币语境与 cached 数值校验
  const evidenceText = 'Gemini 5 Nova | $3.50 | $17.50 | $0.175 | cw:$4.50\nOther Model | $1.00 | $5.00 | $0.05';
  assert.equal(
    verifyOfficialEvidence(evidenceText, {
      officialModelName: 'Gemini 5 Nova',
      inputPer1M: 1.0,
      outputPer1M: 5.0,
      evidenceQuote: 'Other Model | $1.00 | $5.00 | $0.05',
    }),
    false,
    '摘录不含目标模型名时不得通过核验'
  );
  assert.equal(
    verifyOfficialEvidence('Gemini 5 Nova 3.5 17.5 context 200', {
      officialModelName: 'Gemini 5 Nova',
      inputPer1M: 3.5,
      outputPer1M: 17.5,
      evidenceQuote: 'Gemini 5 Nova 3.5 17.5',
    }),
    false,
    '无 $ 货币语境的裸数字不得通过核验'
  );
  assert.equal(
    verifyOfficialEvidence(evidenceText, {
      officialModelName: 'Gemini 5 Nova',
      inputPer1M: 3.5,
      outputPer1M: 17.5,
      cachedPer1M: 0.01,
      evidenceQuote: 'Gemini 5 Nova | $3.50 | $17.50 | $0.175',
    }),
    false,
    'cachedPer1M 被篡改且不在摘录 $ 价格中时不得通过核验'
  );
  assert.equal(
    verifyOfficialEvidence(evidenceText, {
      officialModelName: 'Gemini 5 Nova',
      inputPer1M: 3.5,
      outputPer1M: 17.5,
      cachedPer1M: 0.175,
      evidenceQuote: 'Gemini 5 Nova | $3.50 | $17.50 | $0.175',
    }),
    true
  );

  // 4) parseAntigravityHostModels 支持 Claude 版本号与 tier 语序互换
  const claudeSwapHost = parseAntigravityHostModels(`
## Reasoning model
| Model | Free & Google AI Plus | Google AI Pro | Google AI Ultra | Enterprise |
| --- | --- | --- | --- | --- |
| [Claude 6.0 Sonnet](/blog/claude-6-0-sonnet) | ❌ | ✅ | ✅ | ✅ |
`);
  for (const variant of ['claude-sonnet-6-0', 'claude-sonnet-6.0', 'claude-6.0-sonnet', 'claude-6-0-sonnet']) {
    assert.equal(claudeSwapHost.keys.has(variant), true, `keys 必须覆盖语序变体 ${variant}`);
  }

  // 5) 端到端反向对账与 enterprise.md / models.md 异常告警可见性
  const dir = await mkdtemp(join(tmpdir(), 'gb-reverse-reconcile-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const catalogPath = join(dir, 'model-catalog.json');
  const feedPath = join(dir, 'pricing-feed.json');
  const reportPath = join(dir, 'report.json');
  await writeFile(
    catalogPath,
    JSON.stringify(
      {
        schema: 1,
        names: { 'gemini-4-carbon': 'Gemini 4 Carbon' },
        capacities: { 'gemini-4-carbon': 200000 },
        prices: {
          'gemini-4-carbon': {
            model: 'gemini-4-carbon',
            input: 2.0,
            output: 10.0,
            cached: 0.1,
            provenance: { sourceUrl: 'https://cloud.google.com/model-garden/pricing?hl=en', verification: 'confirmed' },
          },
        },
        aliases: {},
        activeModels: ['gemini-4-carbon'],
        feedModels: ['gemini-4-carbon'],
        pricingVersion: '2026-11-19',
        pricingUpdatedAt: '2026-11-19T00:00:00Z',
      },
      null,
      2
    ) + '\n',
    'utf8'
  );

  const makeReverseFetch = ({ modelsResp, enterpriseResp }) => async (url) => {
    const target = String(url);
    if (target.includes('antigravity.google/docs/models.md')) return modelsResp();
    if (target.includes('antigravity.google/docs/enterprise.md')) return enterpriseResp();
    if (target.includes('cloud.google.com')) {
      return new Response(
        '<html><body><h1>Google Cloud Vertex AI Model Garden Pricing</h1>' +
          '<p>Standard pay-as-you-go Global API text token pricing per 1 million tokens in USD for Gemini models across global endpoints.</p>' +
          '<table><tr><td>Gemini 4 Carbon</td><td>$2.00</td><td>$10.00</td><td>$0.10</td></tr></table>' +
          '<p>All listed rates apply to standard global pay-as-you-go text endpoints in USD per million tokens.</p></body></html>',
        { status: 200 }
      );
    }
    if (target.includes('generativelanguage.googleapis.com')) {
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      pageParsedOk: true,
                      models: [
                        {
                          catalogKey: 'gemini-4-carbon',
                          officialModelName: 'Gemini 4 Carbon',
                          inputPer1M: 2.0,
                          outputPer1M: 10.0,
                          cachedPer1M: 0.1,
                          confidence: 'high',
                          evidenceQuote: 'Gemini 4 Carbon | $2.00 | $10.00 | $0.10',
                        },
                      ],
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 }
      );
    }
    if (target.includes('litellm')) {
      return new Response(
        JSON.stringify({
          'gemini/gemini-4-carbon': { input_cost_per_token: 2e-6, output_cost_per_token: 10e-6, cache_read_input_token_cost: 0.1e-6 },
        }),
        { status: 200 }
      );
    }
    if (target.includes('openrouter.ai')) {
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    throw new Error(`Unexpected URL: ${target}`);
  };

  const reverseReport = await runAutoUpdatePricing({
    write: false,
    filterByAntigravityHost: true,
    nowMs: Date.parse('2026-11-19T14:00:00Z'),
    catalogPath,
    feedPath,
    reportPath,
    geminiApiKey: 'test-fake-key',
    fetchImpl: makeReverseFetch({
      modelsResp: () =>
        new Response(
          `## Reasoning model\n| Model | Free | Pro | Ultra | Enterprise |\n| --- | --- | --- | --- | --- |\n| Gemini 4 Carbon | ❌ | ❌ | ✅ | ✅ |\n| Gemini 5 Orion | ❌ | ✅ | ✅ | ✅ |\n`,
          { status: 200 }
        ),
      enterpriseResp: () => new Response('Internal Server Error', { status: 500 }),
    }),
  });
  assert.equal(reverseReport.decision, 'yellow_needs_review');
  assert.equal(reverseReport.newModelsRadar.some((n) => n.model === 'gemini-5-orion'), true);
  assert.equal(reverseReport.pageAlerts.some((a) => a.includes('Antigravity Enterprise Docs')), true);

  const modelsFailReport = await runAutoUpdatePricing({
    write: false,
    filterByAntigravityHost: true,
    nowMs: Date.parse('2026-11-19T14:00:00Z'),
    catalogPath,
    feedPath,
    reportPath,
    geminiApiKey: 'test-fake-key',
    fetchImpl: makeReverseFetch({
      modelsResp: () => new Response('Service Unavailable', { status: 503 }),
      enterpriseResp: () => new Response('## Supported models\n| Model | ID | Enterprise |\n| --- | --- | --- |\n', { status: 200 }),
    }),
  });
  assert.equal(modelsFailReport.decision, 'fetch_failed');
  assert.equal(modelsFailReport.pageAlerts.some((a) => a.includes('Antigravity Docs')), true);
});

test('hasSemanticCatalogChanges：忽略版本时间戳、checkedAt、文案及键序噪声，精准捕获实质变化', () => {
  const base = {
    schema: 1,
    names: { 'gemini-4-carbon': 'Gemini 4 Carbon', 'gpt-4o': 'GPT-4o' },
    capacities: { 'gemini-4-carbon': 200000 },
    aliases: { 'Orchestrator (Carbon)': 'gemini-4-carbon' },
    activeModels: ['gemini-4-carbon'],
    feedModels: ['gemini-4-carbon', 'gpt-4o'],
    pricingVersion: '2026-11-19',
    pricingUpdatedAt: '2026-11-19T00:00:00Z',
    prices: {
      'gemini-4-carbon': {
        model: 'gemini-4-carbon',
        input: 2,
        output: 10,
        cached: 0.1,
        provenance: {
          sourceUrl: 'https://cloud.google.com/model-garden/pricing?hl=en',
          platform: 'Google Cloud 标准 Global API',
          platformEn: 'Google Cloud Standard Global API',
          conditions: '旧文案',
          conditionsEn: 'Old conditions',
          checkedAt: '2026-11-19',
          validUntil: '2026-11-30T23:59:59Z',
          verification: 'confirmed',
        },
        intervals: [
          {
            model: 'gemini-4-carbon',
            validFrom: null,
            validUntil: '2026-11-30T23:59:59Z',
            input: 2,
            output: 10,
            cached: 0.1,
            provenance: {
              sourceUrl: 'https://cloud.google.com/model-garden/pricing?hl=en',
              checkedAt: '2026-11-19',
              conditions: '区间旧文案',
              conditionsEn: 'Interval old',
              verification: 'confirmed',
            },
          },
        ],
      },
    },
  };

  const metadataNoiseOnly = {
    pricingUpdatedAt: '2026-11-20T09:58:17Z',
    pricingVersion: '2026-11-20-r2',
    feedModels: ['gemini-4-carbon', 'gpt-4o'],
    activeModels: ['gemini-4-carbon'],
    aliases: { 'Orchestrator (Carbon)': 'gemini-4-carbon' },
    capacities: { 'gemini-4-carbon': 200000 },
    names: { 'gpt-4o': 'GPT-4o', 'gemini-4-carbon': 'Gemini 4 Carbon' },
    schema: 1,
    prices: {
      'gemini-4-carbon': {
        cached: 0.1,
        output: 10.0,
        input: 2.0,
        model: 'gemini-4-carbon',
        provenance: {
          verification: 'confirmed',
          validUntil: '2026-11-30T23:59:59Z',
          checkedAt: '2026-11-20',
          conditionsEn: 'Updated conditions',
          conditions: '新文案',
          platformEn: 'Google Cloud Standard Global API',
          platform: 'Google Cloud 标准 Global API',
          sourceUrl: 'https://cloud.google.com/model-garden/pricing?hl=en',
        },
        intervals: [
          {
            cached: 0.1,
            output: 10,
            input: 2,
            validUntil: '2026-11-30T23:59:59Z',
            validFrom: null,
            model: 'gemini-4-carbon',
            provenance: {
              verification: 'confirmed',
              conditionsEn: 'Interval new',
              conditions: '区间新文案',
              checkedAt: '2026-11-20',
              sourceUrl: 'https://cloud.google.com/model-garden/pricing?hl=en',
            },
          },
        ],
      },
    },
  };
  assert.equal(hasSemanticCatalogChanges(base, metadataNoiseOnly), false);

  const priceChanged = structuredClone(metadataNoiseOnly);
  priceChanged.prices['gemini-4-carbon'].input = 1.8;
  assert.equal(hasSemanticCatalogChanges(base, priceChanged), true);

  const activeChanged = structuredClone(metadataNoiseOnly);
  activeChanged.activeModels.push('gpt-4o');
  assert.equal(hasSemanticCatalogChanges(base, activeChanged), true);

  const intervalChanged = structuredClone(metadataNoiseOnly);
  intervalChanged.prices['gemini-4-carbon'].intervals[0].validUntil = '2026-12-15T23:59:59Z';
  assert.equal(hasSemanticCatalogChanges(base, intervalChanged), true);
});

test('长上下文单阶梯与限时促销规则：LiteLLM 解析、原文锚定校验、护栏拦截及端到端自动生效', async (t) => {
  // 1) parseLiteLlmRates 提取 above_200k 四元组
  const ltRates = parseLiteLlmRates({
    'gemini/gemini-5-apex': {
      input_cost_per_token: 2e-6,
      output_cost_per_token: 12e-6,
      cache_read_input_token_cost: 0.2e-6,
      cache_creation_input_token_cost: 2.5e-6,
      input_cost_per_token_above_200k_tokens: 4e-6,
      output_cost_per_token_above_200k_tokens: 18e-6,
      cache_read_input_token_cost_above_200k_tokens: 0.4e-6,
      cache_creation_input_token_cost_above_200k_tokens: 5e-6,
    },
  });
  assert.deepEqual(ltRates.get('gemini-5-apex')?.contextTier, {
    thresholdTokens: 200_000,
    input: 4,
    output: 18,
    cached: 0.4,
    cacheWrite: 5,
  });

  // 2) verifyOfficialTierEvidence & verifyOfficialPromoEvidence
  const tierPageText = 'Claude Haiku 5.5 | <= 100,000 tokens: $0.10 / $0.50 | > 100,000 tokens: $0.20 in, $1.00 out, $0.02 cached, $0.25 cache write';
  assert.equal(
    verifyOfficialTierEvidence(tierPageText, {
      hasContextTiers: true,
      contextThresholdTokens: 100_000,
      tierInputPer1M: 0.2,
      tierOutputPer1M: 1.0,
      tierCachedPer1M: 0.02,
      tierCacheWritePer1M: 0.25,
      tierEvidenceQuote: '> 100,000 tokens: $0.20 in, $1.00 out, $0.02 cached, $0.25 cache write',
    }),
    true
  );
  assert.equal(
    verifyOfficialTierEvidence('Gemini 5 Apex >200k tier: $4.00 / $18.00 / $0.40', {
      hasContextTiers: true,
      contextThresholdTokens: 200_000,
      tierInputPer1M: 4.0,
      tierOutputPer1M: 18.0,
      tierCachedPer1M: 0.4,
      tierEvidenceQuote: 'Gemini 5 Apex >200k tier: $4.00 / $18.00 / $0.40',
    }),
    true
  );
  assert.equal(
    verifyOfficialTierEvidence(tierPageText, {
      hasContextTiers: true,
      contextThresholdTokens: 200_000,
      tierInputPer1M: 0.2,
      tierOutputPer1M: 1.0,
      tierEvidenceQuote: '> 100,000 tokens: $0.20 in, $1.00 out',
    }),
    false,
    '阈值不匹配摘录时必须拒绝'
  );
  assert.equal(
    verifyOfficialTierEvidence(tierPageText, {
      hasContextTiers: true,
      contextThresholdTokens: 100_000,
      tierInputPer1M: 0.2,
      tierOutputPer1M: 9.9,
      tierEvidenceQuote: '> 100,000 tokens: $0.20 in, $1.00 out',
    }),
    false,
    '阶梯单价不匹配摘录时必须拒绝'
  );

  const promoPageText = 'Gemini 5 Flash | Promo $1.00 / $5.00 / $0.10 through November 30, 2026; standard rate $2.00 / $10.00 / $0.20 thereafter.';
  assert.equal(
    verifyOfficialPromoEvidence(promoPageText, {
      promoValidUntil: '2026-11-30',
      postPromoInputPer1M: 2.0,
      postPromoOutputPer1M: 10.0,
      postPromoCachedPer1M: 0.2,
      promoEvidenceQuote: 'through November 30, 2026; standard rate $2.00 / $10.00 / $0.20 thereafter.',
    }),
    true
  );
  assert.equal(
    verifyOfficialPromoEvidence(promoPageText, {
      promoValidUntil: '2026-02-31',
      postPromoInputPer1M: 2.0,
      postPromoOutputPer1M: 10.0,
      postPromoCachedPer1M: 0.2,
      promoEvidenceQuote: 'through November 30, 2026; standard rate $2.00 / $10.00 / $0.20 thereafter.',
    }),
    false,
    '非法日期必须拒绝'
  );
  assert.equal(
    verifyOfficialPromoEvidence('Promo $1.00 / $5.00 through 2026-11-30', {
      promoValidUntil: '2026-11-30',
      postPromoInputPer1M: 2.0,
      postPromoOutputPer1M: 10.0,
      promoEvidenceQuote: 'Promo $1.00 / $5.00 through 2026-11-30',
    }),
    false,
    '缺少恢复价时必须拒绝'
  );

  // 3) 阶梯价与促销护栏拦截测试
  const multiTierBlocked = evaluateNewModelStagingCandidate({
    id: 'gemini-5-multi',
    official: {
      officialModelName: 'Gemini 5 Multi',
      inputPer1M: 2,
      outputPer1M: 10,
      cachedPer1M: 0.2,
      hasContextTiers: true,
      hasMultipleContextTiers: true,
      contextThresholdTokens: 200_000,
      tierInputPer1M: 4,
      tierOutputPer1M: 20,
      tierCachedPer1M: 0.4,
      confidence: 'high',
      evidenceVerified: true,
      tierEvidenceVerified: true,
    },
    litellm: null,
  });
  assert.equal(multiTierBlocked.stageable, false);

  const extremeMultBlocked = evaluateNewModelStagingCandidate({
    id: 'gemini-5-mult',
    official: {
      officialModelName: 'Gemini 5 Mult',
      inputPer1M: 1,
      outputPer1M: 5,
      cachedPer1M: 0.1,
      hasContextTiers: true,
      contextThresholdTokens: 200_000,
      tierInputPer1M: 5,
      tierOutputPer1M: 25,
      tierCachedPer1M: 0.5,
      confidence: 'high',
      evidenceVerified: true,
      tierEvidenceVerified: true,
    },
    litellm: null,
  });
  assert.equal(extremeMultBlocked.stageable, false);

  const missingTierCachedBlocked = evaluateNewModelStagingCandidate({
    id: 'gemini-5-nocached',
    official: {
      officialModelName: 'Gemini 5 Nocached',
      inputPer1M: 2,
      outputPer1M: 10,
      cachedPer1M: 0.2,
      hasContextTiers: true,
      contextThresholdTokens: 200_000,
      tierInputPer1M: 4,
      tierOutputPer1M: 20,
      confidence: 'high',
      evidenceVerified: true,
      tierEvidenceVerified: true,
    },
    litellm: null,
  });
  assert.equal(missingTierCachedBlocked.stageable, false);

  const missingTierCwBlocked = evaluateNewModelStagingCandidate({
    id: 'claude-haiku-5.5',
    official: {
      officialModelName: 'Claude Haiku 5.5',
      inputPer1M: 0.1,
      outputPer1M: 0.5,
      cachedPer1M: 0.01,
      cacheWritePer1M: 0.125,
      hasContextTiers: true,
      contextThresholdTokens: 100_000,
      tierInputPer1M: 0.2,
      tierOutputPer1M: 1.0,
      tierCachedPer1M: 0.02,
      confidence: 'high',
      evidenceVerified: true,
      tierEvidenceVerified: true,
    },
    litellm: null,
  });
  assert.equal(missingTierCwBlocked.stageable, false);

  const divergedTierBlocked = evaluateNewModelStagingCandidate({
    id: 'gemini-5-div',
    official: {
      officialModelName: 'Gemini 5 Div',
      inputPer1M: 2,
      outputPer1M: 12,
      cachedPer1M: 0.2,
      hasContextTiers: true,
      contextThresholdTokens: 200_000,
      tierInputPer1M: 4,
      tierOutputPer1M: 18,
      tierCachedPer1M: 0.4,
      confidence: 'high',
      evidenceVerified: true,
      tierEvidenceVerified: true,
    },
    litellm: {
      input: 2,
      output: 12,
      cached: 0.2,
      contextTier: { thresholdTokens: 200_000, input: 5, output: 20, cached: 0.5 },
    },
  });
  assert.equal(divergedTierBlocked.stageable, false);

  const expiredPromoBlocked = evaluateNewModelStagingCandidate({
    id: 'gemini-5-promo-old',
    nowMs: Date.parse('2026-12-05T00:00:00Z'),
    official: {
      officialModelName: 'Gemini 5 Promo Old',
      inputPer1M: 1,
      outputPer1M: 5,
      cachedPer1M: 0.1,
      promoValidUntil: '2026-11-30',
      postPromoInputPer1M: 2,
      postPromoOutputPer1M: 10,
      postPromoCachedPer1M: 0.2,
      confidence: 'high',
      evidenceVerified: true,
      promoEvidenceVerified: true,
    },
    litellm: null,
  });
  assert.equal(expiredPromoBlocked.stageable, false);

  const missingPostPromoBlocked = evaluateNewModelStagingCandidate({
    id: 'gemini-5-promo-nopost',
    nowMs: Date.parse('2026-11-19T00:00:00Z'),
    official: {
      officialModelName: 'Gemini 5 Promo Nopost',
      inputPer1M: 1,
      outputPer1M: 5,
      cachedPer1M: 0.1,
      promoValidUntil: '2026-11-30',
      confidence: 'high',
      evidenceVerified: true,
      promoEvidenceVerified: false,
    },
    litellm: null,
  });
  assert.equal(missingPostPromoBlocked.stageable, false);

  const bothTierAndPromoBlocked = evaluateNewModelStagingCandidate({
    id: 'gemini-5-both',
    nowMs: Date.parse('2026-11-19T00:00:00Z'),
    official: {
      officialModelName: 'Gemini 5 Both',
      inputPer1M: 1,
      outputPer1M: 5,
      cachedPer1M: 0.1,
      hasContextTiers: true,
      contextThresholdTokens: 200_000,
      tierInputPer1M: 2,
      tierOutputPer1M: 10,
      tierCachedPer1M: 0.2,
      promoValidUntil: '2026-11-30',
      postPromoInputPer1M: 2,
      postPromoOutputPer1M: 10,
      postPromoCachedPer1M: 0.2,
      confidence: 'high',
      evidenceVerified: true,
      tierEvidenceVerified: true,
      promoEvidenceVerified: true,
    },
    litellm: null,
  });
  assert.equal(bothTierAndPromoBlocked.stageable, false);

  // 4) 端到端闭环：单阶梯新模型 (claude-haiku-5.5 >100k 单源自证 + gemini-5-apex >200k 双源共识) + 限时促销双区间新模型 (gemini-5-flash)
  const dir = await mkdtemp(join(tmpdir(), 'gb-tier-promo-auto-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const catalogPath = join(dir, 'model-catalog.json');
  const feedPath = join(dir, 'pricing-feed.json');
  const reportPath = join(dir, 'report.json');

  await writeFile(
    catalogPath,
    JSON.stringify(
      {
        schema: 1,
        names: { 'gemini-4-carbon': 'Gemini 4 Carbon', 'claude-sonnet-5-5': 'Claude Sonnet 5.5' },
        capacities: { 'gemini-4-carbon': 200_000, 'claude-sonnet-5-5': 200_000 },
        prices: {
          'gemini-4-carbon': {
            model: 'gemini-4-carbon',
            input: 2.0,
            output: 10.0,
            cached: 0.1,
            provenance: { sourceUrl: 'https://cloud.google.com/model-garden/pricing?hl=en', verification: 'confirmed' },
          },
          'claude-sonnet-5-5': {
            model: 'claude-sonnet-5-5',
            input: 3.0,
            output: 15.0,
            cached: 0.3,
            cacheWrite: 3.75,
            provenance: { sourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing', verification: 'confirmed' },
          },
        },
        aliases: {},
        activeModels: ['gemini-4-carbon', 'claude-sonnet-5-5'],
        feedModels: ['gemini-4-carbon', 'claude-sonnet-5-5'],
        pricingVersion: '2026-11-19',
        pricingUpdatedAt: '2026-11-19T00:00:00Z',
      },
      null,
      2
    ) + '\n',
    'utf8'
  );

  const mockFetch = async (url, init) => {
    const target = String(url);
    if (target.includes('antigravity.google/docs/models.md')) {
      return new Response(
        `## Reasoning model
| Model | Free | Pro | Ultra | Enterprise |
| --- | --- | --- | --- | --- |
| Gemini 4 Carbon | ❌ | ❌ | ✅ | ✅ |
| Claude Sonnet 5.5 | ❌ | ✅ | ✅ | ✅ |
| Claude Haiku 5.5 | ✅ | ✅ | ✅ | ✅ |
| Gemini 5 Apex | ❌ | ✅ | ✅ | ✅ |
| Gemini 5 Flash | ✅ | ✅ | ✅ | ✅ |
`,
        { status: 200 }
      );
    }
    if (target.includes('antigravity.google/docs/enterprise.md')) {
      return new Response('## Supported models\n| Model | ID | Enterprise |\n| --- | --- | --- |\n', { status: 200 });
    }
    if (target.includes('cloud.google.com')) {
      return new Response(
        '<html><body><h1>Google Cloud Vertex AI Model Garden Pricing</h1>' +
          '<p>Standard pay-as-you-go Global API text token pricing per 1 million tokens in USD for Gemini models.</p>' +
          '<table><tr><td>Gemini 4 Carbon</td><td>$2.00</td><td>$10.00</td><td>$0.10</td></tr>' +
          '<tr><td>Gemini 5 Apex</td><td>$2.00</td><td>$12.00</td><td>$0.20</td><td>>200k tokens: $4.00 / $18.00 / $0.40</td></tr>' +
          '<tr><td>Gemini 5 Flash</td><td>$1.00</td><td>$5.00</td><td>$0.10</td><td>Promotional rate valid through November 30, 2026; standard rate $2.00 / $10.00 / $0.20 starting Dec 1, 2026</td></tr></table>' +
          '<p>All listed prices apply to standard global pay-as-you-go text endpoints in USD per 1M tokens.</p></body></html>',
        { status: 200 }
      );
    }
    if (target.includes('platform.claude.com')) {
      return new Response(
        '<html><body><h1>Anthropic Claude API Standard Text Token Pricing</h1>' +
          '<p>Standard API pricing per million tokens (MTok) in USD for Claude models on global endpoints.</p>' +
          '<table><tr><td>Claude Sonnet 5.5</td><td>$3.00 / MTok</td><td>$15.00 / MTok</td><td>$0.30</td><td>$3.75</td></tr>' +
          '<tr><td>Claude Haiku 5.5</td><td>$0.10</td><td>$0.50</td><td>$0.01</td><td>$0.125</td><td>>100,000 tokens: $0.20 / $1.00 / $0.02 / $0.25</td></tr></table>' +
          '<p>All listed prices are in USD per 1M input, output, cached, and cache write tokens.</p></body></html>',
        { status: 200 }
      );
    }
    if (target.includes('generativelanguage.googleapis.com')) {
      const body = String(init?.body ?? '');
      const models = body.includes('cloud.google.com')
        ? [
            {
              catalogKey: 'gemini-4-carbon',
              officialModelName: 'Gemini 4 Carbon',
              inputPer1M: 2.0,
              outputPer1M: 10.0,
              cachedPer1M: 0.1,
              confidence: 'high',
              evidenceQuote: 'Gemini 4 Carbon | $2.00 | $10.00 | $0.10',
            },
            {
              catalogKey: '',
              officialModelName: 'Gemini 5 Apex',
              inputPer1M: 2.0,
              outputPer1M: 12.0,
              cachedPer1M: 0.2,
              hasContextTiers: true,
              contextThresholdTokens: 200_000,
              tierInputPer1M: 4.0,
              tierOutputPer1M: 18.0,
              tierCachedPer1M: 0.4,
              confidence: 'high',
              evidenceQuote: 'Gemini 5 Apex | $2.00 | $12.00 | $0.20',
              tierEvidenceQuote: '>200k tokens: $4.00 / $18.00 / $0.40',
            },
            {
              catalogKey: '',
              officialModelName: 'Gemini 5 Flash',
              inputPer1M: 1.0,
              outputPer1M: 5.0,
              cachedPer1M: 0.1,
              promoValidUntil: '2026-11-30',
              postPromoInputPer1M: 2.0,
              postPromoOutputPer1M: 10.0,
              postPromoCachedPer1M: 0.2,
              confidence: 'high',
              evidenceQuote: 'Gemini 5 Flash | $1.00 | $5.00 | $0.10',
              promoEvidenceQuote: 'Promotional rate valid through November 30, 2026; standard rate $2.00 / $10.00 / $0.20',
            },
          ]
        : [
            {
              catalogKey: 'claude-sonnet-5-5',
              officialModelName: 'Claude Sonnet 5.5',
              inputPer1M: 3.0,
              outputPer1M: 15.0,
              cachedPer1M: 0.3,
              cacheWritePer1M: 3.75,
              confidence: 'high',
              evidenceQuote: 'Claude Sonnet 5.5 | $3.00 / MTok | $15.00 / MTok | $0.30 | $3.75',
            },
            {
              catalogKey: '',
              officialModelName: 'Claude Haiku 5.5',
              inputPer1M: 0.1,
              outputPer1M: 0.5,
              cachedPer1M: 0.01,
              cacheWritePer1M: 0.125,
              hasContextTiers: true,
              contextThresholdTokens: 100_000,
              tierInputPer1M: 0.2,
              tierOutputPer1M: 1.0,
              tierCachedPer1M: 0.02,
              tierCacheWritePer1M: 0.25,
              confidence: 'high',
              evidenceQuote: 'Claude Haiku 5.5 | $0.10 | $0.50 | $0.01 | $0.125',
              tierEvidenceQuote: '>100,000 tokens: $0.20 / $1.00 / $0.02 / $0.25',
            },
          ];
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ pageParsedOk: true, models }) }] } }] }),
        { status: 200 }
      );
    }
    if (target.includes('litellm')) {
      return new Response(
        JSON.stringify({
          'gemini/gemini-4-carbon': { input_cost_per_token: 2e-6, output_cost_per_token: 10e-6, cache_read_input_token_cost: 0.1e-6 },
          'anthropic/claude-sonnet-5-5': {
            input_cost_per_token: 3e-6,
            output_cost_per_token: 15e-6,
            cache_read_input_token_cost: 0.3e-6,
            cache_creation_input_token_cost: 3.75e-6,
          },
          'gemini/gemini-5-apex': {
            input_cost_per_token: 2e-6,
            output_cost_per_token: 12e-6,
            cache_read_input_token_cost: 0.2e-6,
            input_cost_per_token_above_200k_tokens: 4e-6,
            output_cost_per_token_above_200k_tokens: 18e-6,
            cache_read_input_token_cost_above_200k_tokens: 0.4e-6,
          },
        }),
        { status: 200 }
      );
    }
    if (target.includes('openrouter.ai')) {
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    throw new Error(`Unexpected URL: ${target}`);
  };

  const report = await runAutoUpdatePricing({
    write: true,
    filterByAntigravityHost: true,
    nowMs: Date.parse('2026-11-19T14:00:00Z'),
    catalogPath,
    feedPath,
    reportPath,
    geminiApiKey: 'test-fake-key',
    fetchImpl: mockFetch,
  });

  assert.equal(report.decision, 'green_auto_merge');
  assert.equal(report.filesModified, true);
  assert.deepEqual(
    report.stagedNewModels.map((s) => s.catalogKey).sort(),
    ['claude-haiku-5-5', 'gemini-5-apex', 'gemini-5-flash']
  );

  const updatedCatalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  const updatedFeed = JSON.parse(await readFile(feedPath, 'utf8'));
  assert.deepEqual(buildPricingFeed(updatedCatalog), updatedFeed);
  validateRawPrices(updatedCatalog.prices);

  // 验证 claude-haiku-5-5 单阶梯 >100k 精确计费与英文条款无中文
  const haiku = updatedCatalog.prices['claude-haiku-5-5'];
  assert.deepEqual(haiku.contextTiers, [
    { thresholdTokens: 100_000, input: 0.2, output: 1.0, cached: 0.02, cacheWrite: 0.25 },
  ]);
  assert.equal(resolveContextTierPricing(haiku, 100_000).input, 0.1);
  assert.equal(resolveContextTierPricing(haiku, 100_001).input, 0.2);
  assert.ok(Math.abs(calculateEstimatedUsd(60_000, 10_000, 30_000, haiku, 20_000) - (60_000 * 0.2 + 10_000 * 1.0 + 30_000 * 0.02 + 20_000 * 0.25) / 1_000_000) < 1e-12);
  assert.equal(/[\u4e00-\u9fff]/.test(localizePricingProvenance(haiku.provenance, 'en')?.conditions ?? ''), false);

  // 验证 gemini-5-apex >200k
  assert.deepEqual(updatedCatalog.prices['gemini-5-apex']?.contextTiers, [
    { thresholdTokens: 200_000, input: 4.0, output: 18.0, cached: 0.4 },
  ]);

  // 验证 gemini-5-flash 促销两段 intervals 与跨期切换
  const flash = updatedCatalog.prices['gemini-5-flash'];
  assert.equal(flash.intervals?.length, 2);
  assert.equal(flash.intervals[0].validUntil, '2026-11-30T23:59:59Z');
  assert.equal(flash.intervals[1].validFrom, '2026-12-01T00:00:00Z');
  assert.equal(flash.intervals[1].validUntil, null);
  const novStamp = Math.floor(Date.parse('2026-11-25T12:00:00Z') / 1000);
  const decStamp = Math.floor(Date.parse('2026-12-01T12:00:00Z') / 1000);
  assert.equal(resolvePricingForTimestamp(flash, novStamp, 'gemini-5-flash')?.input, 1.0);
  const resolvedDecFlash = resolvePricingForTimestamp(flash, decStamp, 'gemini-5-flash');
  assert.equal(resolvedDecFlash?.input, 2.0);
  assert.equal(priceStatus(resolvedDecFlash, Date.parse('2026-12-05T00:00:00Z')), 'confirmed');
  assert.equal(priceStatus(updatedFeed.prices['gemini-5-flash'], Date.parse('2026-12-05T00:00:00Z')), 'confirmed');
  assert.equal(/[\u4e00-\u9fff]/.test(localizePricingProvenance(flash.intervals[0].provenance, 'en')?.conditions ?? ''), false);
  assert.equal(/[\u4e00-\u9fff]/.test(localizePricingProvenance(flash.intervals[1].provenance, 'en')?.conditions ?? ''), false);

  // 5) 存量单阶梯模型 contextTiers 变动：核验通过自动更新，多段或无核验仍转 yellow
  const existingTierUpdated = evaluateModelConsensus({
    key: 'gemini-3.1-pro',
    localEntry: {
      model: 'gemini-3.1-pro',
      input: 2.0,
      output: 12.0,
      cached: 0.2,
      contextTiers: [{ thresholdTokens: 200_000, input: 4.0, output: 18.0, cached: 0.4 }],
    },
    official: {
      officialModelName: 'Gemini 3.1 Pro',
      inputPer1M: 2.0,
      outputPer1M: 12.0,
      cachedPer1M: 0.2,
      hasContextTiers: true,
      contextThresholdTokens: 200_000,
      tierInputPer1M: 3.5,
      tierOutputPer1M: 16.0,
      tierCachedPer1M: 0.35,
      confidence: 'high',
      evidenceQuote: 'Gemini 3.1 Pro | $2.00 | $12.00 | $0.20',
      tierEvidenceQuote: '>200k tokens: $3.50 / $16.00 / $0.35',
      evidenceVerified: true,
      tierEvidenceVerified: true,
    },
    litellm: {
      input: 2.0,
      output: 12.0,
      cached: 0.2,
      contextTier: { thresholdTokens: 200_000, input: 3.5, output: 16.0, cached: 0.35 },
    },
  });
  assert.equal(existingTierUpdated.status, 'green');
  assert.deepEqual(existingTierUpdated.proposed.contextTiers, [
    { thresholdTokens: 200_000, input: 3.5, output: 16.0, cached: 0.35 },
  ]);

  const multiExistingBlocked = evaluateModelConsensus({
    key: 'gemini-3.1-pro',
    localEntry: {
      model: 'gemini-3.1-pro',
      input: 2.0,
      output: 12.0,
      cached: 0.2,
      contextTiers: [
        { thresholdTokens: 200_000, input: 4.0, output: 18.0, cached: 0.4 },
        { thresholdTokens: 500_000, input: 6.0, output: 24.0, cached: 0.6 },
      ],
    },
    official: {
      officialModelName: 'Gemini 3.1 Pro',
      inputPer1M: 2.0,
      outputPer1M: 12.0,
      cachedPer1M: 0.2,
      hasContextTiers: true,
      contextThresholdTokens: 200_000,
      tierInputPer1M: 3.5,
      tierOutputPer1M: 16.0,
      tierCachedPer1M: 0.35,
      confidence: 'high',
      evidenceVerified: true,
      tierEvidenceVerified: true,
    },
    litellm: { input: 2.0, output: 12.0, cached: 0.2 },
  });
  assert.equal(multiExistingBlocked.status, 'yellow');
  assert.ok(applyStagedNewModels);
});

test('Gemini 提取默认使用 gemini-3.8-flash + low thinkingLevel 并在汇总中统计 usageMetadata', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gb-auto-pricing-usage-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const catalogPath = join(dir, 'model-catalog.json');
  const feedPath = join(dir, 'pricing-feed.json');
  const reportPath = join(dir, 'report.json');
  await writeFile(
    catalogPath,
    JSON.stringify({
      schema: 1,
      names: { 'claude-3-5-haiku': 'Claude 3.5 Haiku' },
      prices: {
        'claude-3-5-haiku': {
          model: 'claude-3-5-haiku',
          input: 1.0,
          output: 5.0,
          cached: 0.1,
          provenance: {
            sourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
            verification: 'confirmed',
          },
        },
      },
      activeModels: ['claude-3-5-haiku'],
      feedModels: ['claude-3-5-haiku'],
      pricingVersion: '2026-11-19',
    }),
    'utf8'
  );

  let capturedEndpoint = '';
  let capturedBody = null;
  const report = await runAutoUpdatePricing({
    write: false,
    nowMs: Date.parse('2026-11-20T02:00:00Z'),
    catalogPath,
    feedPath,
    reportPath,
    geminiApiKey: 'test-fake-key',
    fetchImpl: async (url, init) => {
      const target = String(url);
      if (target.includes('generativelanguage.googleapis.com')) {
        capturedEndpoint = target;
        capturedBody = JSON.parse(init.body);
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        pageParsedOk: true,
                        models: [
                          {
                            catalogKey: 'claude-3-5-haiku',
                            officialModelName: 'Claude 3.5 Haiku',
                            inputPer1M: 1.0,
                            outputPer1M: 5.0,
                            cachedPer1M: 0.1,
                            confidence: 'high',
                            evidenceQuote: 'Claude 3.5 Haiku $1.00 / $5.00',
                          },
                        ],
                      }),
                    },
                  ],
                },
              },
            ],
            usageMetadata: {
              promptTokenCount: 1200,
              thoughtsTokenCount: 150,
              candidatesTokenCount: 80,
              totalTokenCount: 1430,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (target.includes('platform.claude.com')) {
        return new Response(
          `<html><body><h1>Anthropic Claude API Pricing</h1><p>${'Standard pay-as-you-go text token pricing per million tokens (MTok). '.repeat(5)}Claude 3.5 Haiku $1.00 / $5.00 per 1M tokens</p></body></html>`,
          { status: 200 }
        );
      }
      if (target.includes('litellm')) {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      if (target.includes('openrouter')) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      return new Response('', { status: 404 });
    },
  });

  assert.match(capturedEndpoint, /\/models\/gemini-3\.8-flash:generateContent$/);
  assert.equal(capturedBody?.generationConfig?.thinkingConfig?.thinkingLevel, 'low');
  assert.match(report.summaryMarkdown, /`gemini-3\.8-flash`/);
  assert.match(report.summaryMarkdown, /tokens: in=1,200 thoughts=150 out=80 total=1,430/);
});

test('CSR 空壳定价页自动回退抓取同路径 .md 并归类为 Google 厂商', async (t) => {
  assert.equal(
    buildMarkdownFallbackUrl('https://aistudio.google.com/docs/pricing'),
    'https://aistudio.google.com/docs/pricing.md'
  );
  assert.equal(
    buildMarkdownFallbackUrl('https://aistudio.google.com/docs/pricing/?hl=en#flash'),
    'https://aistudio.google.com/docs/pricing.md'
  );
  assert.equal(buildMarkdownFallbackUrl('https://aistudio.google.com/docs/pricing.md'), null);
  assert.equal(buildMarkdownFallbackUrl('https://aistudio.google.com/'), null);

  const dir = await mkdtemp(join(tmpdir(), 'gb-pricing-csr-md-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const catalogPath = join(dir, 'model-catalog.json');
  const feedPath = join(dir, 'pricing-feed.json');
  const reportPath = join(dir, 'report.json');
  await writeFile(
    catalogPath,
    JSON.stringify({
      schema: 1,
      names: { 'gemini-3.6-flash': 'Gemini 3.6 Flash' },
      prices: {
        'gemini-3.6-flash': {
          model: 'gemini-3.6-flash',
          input: 0.75,
          output: 3.75,
          cached: 0.075,
          provenance: {
            sourceUrl: 'https://aistudio.google.com/docs/pricing',
            verification: 'confirmed',
          },
        },
      },
      activeModels: ['gemini-3.6-flash'],
      feedModels: ['gemini-3.6-flash'],
      pricingVersion: '2026-11-21',
    }),
    'utf8'
  );

  const requestedUrls = [];
  const report = await runAutoUpdatePricing({
    write: false,
    nowMs: Date.parse('2026-11-21T14:00:00Z'),
    catalogPath,
    feedPath,
    reportPath,
    geminiApiKey: 'test-fake-key',
    fetchImpl: async (url) => {
      const target = String(url);
      requestedUrls.push(target);
      if (target === 'https://aistudio.google.com/docs/pricing') {
        return new Response(
          '<html><head><title>Gemini Developer API pricing</title></head><body><script src="/main.js"></script></body></html>',
          { status: 200 }
        );
      }
      if (target === 'https://aistudio.google.com/docs/pricing.md') {
        return new Response(
          `# Gemini Developer API Pricing\n\n${'Gemini Developer API token pricing per 1M tokens. '.repeat(6)}\n\n## Gemini 3.6 Flash\n| Input | $0.75 |\n| Output | $3.75 |\n| Cached | $0.075 |\n`,
          { status: 200 }
        );
      }
      if (target.includes('generativelanguage.googleapis.com')) {
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        pageParsedOk: true,
                        models: [
                          {
                            catalogKey: 'gemini-3.6-flash',
                            officialModelName: 'Gemini 3.6 Flash',
                            inputPer1M: 0.75,
                            outputPer1M: 3.75,
                            cachedPer1M: 0.075,
                            confidence: 'high',
                            evidenceQuote: 'Gemini 3.6 Flash $0.75 / $3.75 / $0.075',
                          },
                        ],
                      }),
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (target.includes('litellm')) {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      if (target.includes('openrouter')) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      return new Response('', { status: 404 });
    },
  });

  assert.equal(report.decision, 'no_change');
  assert.deepEqual(report.pageAlerts, []);
  assert.ok(requestedUrls.includes('https://aistudio.google.com/docs/pricing.md'));
  assert.match(report.summaryMarkdown, /\| Google \| `200` \| Parsed \(1 models\) \| https:\/\/aistudio\.google\.com\/docs\/pricing\.md \|/);
});

test('P1-15: 2 位数版本别名生成、预入库优先采用上游上下文窗口、同日 validFrom>=todayStartIso 就地更新防倒挂区间', () => {
  // 1) 2 位数 Gemini 代号自动生成预入库别名
  const aliases10 = buildAutoStagedAliases('gemini-10-nova');
  assert.equal(aliases10['gemini-pro-orchestrator-nova'], 'gemini-10-nova');
  assert.equal(aliases10['gemini-10-nova-tiered-high'], 'gemini-10-nova');
  const aliases12 = buildAutoStagedAliases('gemini-12.5-aurora');
  assert.equal(aliases12['Orchestrator (Aurora)'], 'gemini-12.5-aurora');

  // 2) LiteLLM / OpenRouter 提取 contextWindow 并穿透到 applyStagedNewModels
  const ltMap = parseLiteLlmRates({
    'gemini/gemini-10-nova': {
      input_cost_per_token: 2e-6,
      output_cost_per_token: 10e-6,
      cache_read_input_token_cost: 0.2e-6,
      max_input_tokens: 4_000_000,
    },
  });
  const orMap = parseOpenRouterRates({
    data: [
      {
        id: 'openai/o10-mini',
        context_length: 1_048_576,
        pricing: { prompt: '0.000001', completion: '0.000004', input_cache_read: '0.0000001' },
      },
    ],
  });
  assert.equal(ltMap.get('gemini-10-nova')?.contextWindow, 4_000_000);
  assert.equal(orMap.get('o10-mini')?.contextWindow, 1_048_576);

  const nowMs = Date.parse('2026-11-22T12:00:00Z');
  const staged = evaluateNewModelStagingCandidate({
    id: 'gemini-10-nova',
    vendor: 'Google',
    url: 'https://cloud.google.com/vertex-ai/generative-ai/pricing',
    official: {
      officialModelName: 'Gemini 10 Nova',
      inputPer1M: 2.0,
      outputPer1M: 10.0,
      cachedPer1M: 0.2,
      confidence: 'high',
      evidenceVerified: true,
    },
    litellm: ltMap.get('gemini-10-nova'),
    nowMs,
  });
  assert.equal(staged.stageable, true);
  assert.equal(staged.contextWindow, 4_000_000);

  const catalog = { names: {}, capacities: {}, prices: {}, aliases: {}, feedModels: [] };
  applyStagedNewModels(catalog, [staged], nowMs);
  assert.equal(catalog.capacities['gemini-10-nova'], 4_000_000, '预入库应优先采用上游 4M 上下文窗口');

  // 3) applyVerifiedPriceUpdate: 无 intervals 但 baseProv.validFrom >= todayStartIso 时就地更新，禁止产生 validFrom > validUntil 倒挂区间
  const sameDayNoIvCatalog = {
    prices: {
      'gemini-10-nova': {
        model: 'gemini-10-nova',
        input: 2.0,
        output: 10.0,
        cached: 0.2,
        provenance: {
          validFrom: '2026-11-22T06:00:00Z',
          validUntil: null,
          verification: 'confirmed',
        },
      },
    },
    pricingVersion: '2026-11-22',
  };
  applyVerifiedPriceUpdate(
    sameDayNoIvCatalog,
    'gemini-10-nova',
    { input: 1.8, output: 9.0, cached: 0.18 },
    nowMs,
    { bumpVersion: false }
  );
  const noIvList = sameDayNoIvCatalog.prices['gemini-10-nova'].intervals;
  assert.equal(noIvList.length, 1, '同日生效条目无 intervals 时应就地更新而非拆分倒挂区间');
  assert.equal(noIvList[0].validFrom, '2026-11-22T06:00:00Z');
  assert.equal(noIvList[0].validUntil, null);
  assert.equal(noIvList[0].input, 1.8);

  // 4) applyVerifiedPriceUpdate: 已有 intervals 且 activeIv.validFrom >= todayStartIso（非精确等于 00:00:00Z）时同样就地更新
  const sameDayWithIvCatalog = {
    prices: {
      'gemini-10-nova': {
        model: 'gemini-10-nova',
        input: 2.0,
        output: 10.0,
        cached: 0.2,
        intervals: [
          {
            model: 'gemini-10-nova',
            validFrom: null,
            validUntil: '2026-11-21T23:59:59Z',
            input: 2.5,
            output: 12.0,
            cached: 0.25,
          },
          {
            model: 'gemini-10-nova',
            validFrom: '2026-11-22T08:00:00Z',
            validUntil: null,
            input: 2.0,
            output: 10.0,
            cached: 0.2,
          },
        ],
      },
    },
    pricingVersion: '2026-11-22',
  };
  applyVerifiedPriceUpdate(
    sameDayWithIvCatalog,
    'gemini-10-nova',
    { input: 1.75, output: 8.75, cached: 0.175 },
    nowMs,
    { bumpVersion: false }
  );
  const withIvList = sameDayWithIvCatalog.prices['gemini-10-nova'].intervals;
  assert.equal(withIvList.length, 2, '同日稍晚 validFrom 的活跃区间应就地更新，不得新增第 3 段导致前段 validUntil 倒挂');
  assert.equal(withIvList[1].validFrom, '2026-11-22T08:00:00Z');
  assert.equal(withIvList[1].validUntil, null);
  assert.equal(withIvList[1].input, 1.75);
});

test('P2-3: anchor_missing 触发 .md 回退并独立容错，collectExpiringIntervals 按 key+validUntil 去重', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gb-p2-3-md-fallback-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const catalogPath = join(dir, 'model-catalog.json');
  const feedPath = join(dir, 'pricing-feed.json');
  const reportPath = join(dir, 'report.json');
  const nowMs = Date.parse('2026-11-22T12:00:00Z');

  // 顶层与 intervals[0] 含相同 validUntil，验证去重后仅告警 1 条
  const catalog = {
    schema: 1,
    names: { 'gemini-3.6-flash': 'Gemini 3.6 Flash' },
    capacities: { 'gemini-3.6-flash': 1_000_000 },
    aliases: {},
    activeModels: ['gemini-3.6-flash'],
    feedModels: ['gemini-3.6-flash'],
    pricingVersion: '2026-11-20',
    pricingUpdatedAt: '2026-11-20T00:00:00Z',
    prices: {
      'gemini-3.6-flash': {
        model: 'gemini-3.6-flash',
        input: 0.75,
        output: 3.75,
        cached: 0.075,
        validUntil: '2026-11-25T23:59:59Z',
        provenance: {
          sourceUrl: 'https://aistudio.google.com/docs/pricing',
          platform: 'Google AI Studio',
          validUntil: '2026-11-25T23:59:59Z',
          verification: 'confirmed',
        },
        intervals: [
          {
            model: 'gemini-3.6-flash',
            validFrom: null,
            validUntil: '2026-11-25T23:59:59Z',
            input: 0.75,
            output: 3.75,
            cached: 0.075,
          },
        ],
      },
    },
  };
  await writeFile(catalogPath, JSON.stringify(catalog, null, 2) + '\n', 'utf8');

  // 1) 主页内容 >= 250 字符但缺失关键词锚点（anchor_missing），且 .md 回退请求抛错 -> 独立 try/catch 保留原 anchor_missing 告警
  const requested = [];
  const report = await runAutoUpdatePricing({
    catalogPath,
    feedPath,
    reportPath,
    dryRun: true,
    nowMs,
    geminiApiKey: '',
    fetchImpl: async (url) => {
      const target = String(url);
      requested.push(target);
      if (target === 'https://aistudio.google.com/docs/pricing') {
        return new Response(`<html><body><main>${'Welcome to developer portal navigation menu. '.repeat(12)}</main></body></html>`, { status: 200 });
      }
      if (target === 'https://aistudio.google.com/docs/pricing.md') {
        throw new Error('simulated md fallback network failure');
      }
      if (target.includes('litellm')) return new Response(JSON.stringify({}), { status: 200 });
      if (target.includes('openrouter')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      return new Response('', { status: 404 });
    },
  });

  assert.ok(requested.includes('https://aistudio.google.com/docs/pricing.md'), 'anchor_missing 应触发 .md 回退探测');
  assert.ok(report.pageAlerts.some((msg) => msg.includes('anchor_missing')), '.md 回退抛错不得掩盖原始 anchor_missing 告警');
  assert.equal(report.expiring.length, 1, '顶层与 intervals 重复的同 key+validUntil 应去重为 1 条');
});

