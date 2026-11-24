import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { buildPricingFeed } from './sync-pricing-feed.mjs';

const DEFAULT_CATALOG_PATH = new URL('../assets/model-catalog.json', import.meta.url);
const DEFAULT_FEED_PATH = new URL('../assets/pricing-feed.json', import.meta.url);
const DEFAULT_REPORT_PATH = new URL('../pricing-watch-alert.json', import.meta.url);

const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/models';
const ANTIGRAVITY_MODELS_MD_URL = 'https://antigravity.google/docs/models.md';
const ANTIGRAVITY_ENTERPRISE_MD_URL = 'https://antigravity.google/docs/enterprise.md';

const MAX_PAGE_CHARS = 160_000;
const WARN_HORIZON_MS = 14 * 24 * 60 * 60 * 1000;
const CONSENSUS_TOLERANCE = 0.01;
const CONSENSUS_ABS_EPSILON = 0.0005;
const MIN_PRICE_RATIO = 0.2;
const MAX_PRICE_RATIO = 3.0;
const MAX_SAFE_USD_PER_M = 500;
const MIN_TIER_MULTIPLIER = 1.1;
const MAX_TIER_MULTIPLIER = 4.0;
const MAX_PROMO_POST_MULTIPLIER = 5.0;

const VENDOR_CONTENT_ANCHORS = [
  { match: /cloud\.google\.com|ai\.google\.dev|aistudio\.google\.com/i, anchor: /gemini|token|pricing/i, vendor: 'Google' },
  { match: /anthropic\.com|platform\.claude\.com/i, anchor: /claude|million\s+tokens|mtok|pricing/i, vendor: 'Anthropic' },
  { match: /openai\.com/i, anchor: /gpt|token|pricing/i, vendor: 'OpenAI' },
];

// 内部实验/测试/别名衍生条目不做上游一对一自动调价，避免每日因上游无报价产生误报
const INTERNAL_DERIVATIVE_RE = /(?:^|[-_])(?:trial|control|tiered|safety[-_]le|exp[-_][a-z0-9]+|n|a|default)(?:$|[-_])/i;

// 仅作为新模型雷达候选的现代主流对话模型族，过滤老旧历史模型与非文本模态条目
const MODERN_RADAR_MODEL_RE = /^(?:gemini-(?:3\.[5-9]|(?:[4-9]|[1-9]\d+)(?:\.\d+)?)|claude-(?:(?:sonnet|opus|haiku|[a-z]{3,16})-(?:[4-9]|[1-9]\d+)|(?:[4-9]|[1-9]\d+)(?:[-.]\d+)?-(?:sonnet|opus|haiku|[a-z]{3,16}))|gpt-(?:4\.[5-9]|(?:[5-9]|[1-9]\d+)(?:\.\d+)?)|o(?:[3-9]|[1-9]\d+)(?:-|$))/i;
const IGNORED_RADAR_SUFFIX_RE = /(?:batch|audio|realtime|image|video|tts|stt|transcribe|embed|moderation|search|deep-research|computer-use|cyber-permissive|free|:free|:extended)/i;

// 常见目录 key 到官方/LiteLLM 常见别名的补充映射
const CATALOG_TO_UPSTREAM_ALIASES = {
  'gemini-4-carbon': ['gemini-4-carbon', 'gemini-4.0-carbon', 'gemini-4-pro'],
  'gemini-4-argon': ['gemini-4-argon', 'gemini-4.0-argon'],
  'gemini-4-neon': ['gemini-4-neon', 'gemini-4.0-neon'],
  'gemini-4-hydrogen': ['gemini-4-hydrogen', 'gemini-4.0-hydrogen'],
  'gemini-3.8-flash': ['gemini-3.8-flash'],
  'gemini-3.1-pro': ['gemini-3.1-pro', 'gemini-3.1-pro-preview'],
  'gemini-2.5-flash': ['gemini-2.5-flash'],
  'gemini-2.5-pro': ['gemini-2.5-pro'],
  'claude-opus-5-5': ['claude-opus-5-5', 'claude-5-5-opus', 'claude-opus-5.5'],
  'claude-sonnet-5-5': ['claude-sonnet-5-5', 'claude-5-5-sonnet', 'claude-sonnet-5.5'],
  'claude-opus-4-6': ['claude-opus-4-6', 'claude-4-6-opus', 'claude-opus-4.6'],
  'claude-sonnet-4-6': ['claude-sonnet-4-6', 'claude-4-6-sonnet', 'claude-sonnet-4.6'],
  'claude-3-7-sonnet': ['claude-3-7-sonnet', 'claude-3-7-sonnet-latest', 'claude-3-7-sonnet-20250219'],
  'claude-3-5-sonnet': ['claude-3-5-sonnet', 'claude-3-5-sonnet-latest', 'claude-3-5-sonnet-20241022'],
  'claude-3-5-haiku': ['claude-3-5-haiku', 'claude-3-5-haiku-latest', 'claude-3-5-haiku-20241022'],
  'gpt-4o': ['gpt-4o'],
  'gpt-4o-mini': ['gpt-4o-mini'],
  'gpt-oss-120b': ['gpt-oss-120b'],
};

const GEMINI_EXTRACTION_SCHEMA = {
  type: 'OBJECT',
  properties: {
    pageParsedOk: { type: 'BOOLEAN' },
    notes: { type: 'STRING' },
    models: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          catalogKey: { type: 'STRING' },
          officialModelName: { type: 'STRING' },
          inputPer1M: { type: 'NUMBER' },
          outputPer1M: { type: 'NUMBER' },
          cachedPer1M: { type: 'NUMBER' },
          cacheWritePer1M: { type: 'NUMBER' },
          hasContextTiers: { type: 'BOOLEAN' },
          hasMultipleContextTiers: { type: 'BOOLEAN' },
          contextThresholdTokens: { type: 'INTEGER' },
          tierInputPer1M: { type: 'NUMBER' },
          tierOutputPer1M: { type: 'NUMBER' },
          tierCachedPer1M: { type: 'NUMBER' },
          tierCacheWritePer1M: { type: 'NUMBER' },
          tierEvidenceQuote: { type: 'STRING' },
          promoValidUntil: { type: 'STRING' },
          postPromoInputPer1M: { type: 'NUMBER' },
          postPromoOutputPer1M: { type: 'NUMBER' },
          postPromoCachedPer1M: { type: 'NUMBER' },
          postPromoCacheWritePer1M: { type: 'NUMBER' },
          promoEvidenceQuote: { type: 'STRING' },
          confidence: { type: 'STRING', enum: ['high', 'medium', 'low'] },
          evidenceQuote: { type: 'STRING' },
        },
        required: ['officialModelName', 'inputPer1M', 'outputPer1M', 'confidence', 'evidenceQuote'],
      },
    },
  },
  required: ['pageParsedOk', 'models'],
};

function roundRate(value) {
  return Math.round(Number(value) * 1e6) / 1e6;
}

function decodeHtmlEntities(text) {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#36;/g, '$')
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number.parseInt(n, 10);
      return Number.isFinite(code) && code >= 32 && code < 127 ? String.fromCharCode(code) : ' ';
    });
}

/**
 * 将官方 HTML 定价页转换为保留表格边界的结构化纯文本，并在超长时优先保留含价格锚点的窗口。
 */
export function extractCleanPricingText(html, maxChars = MAX_PAGE_CHARS) {
  if (!html || typeof html !== 'string') return '';
  let stripped = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|iframe|template)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(nav|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, '\n')
    .replace(/<\/(?:td|th)>/gi, ' | ')
    .replace(/<\/(?:tr|li|p|div|section|article|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  stripped = decodeHtmlEntities(stripped);
  const lines = stripped
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t\f\v]+/g, ' ').replace(/\s*\|\s*/g, ' | ').trim())
    .filter((line) => line.length > 0);

  const fullText = lines.join('\n');
  if (fullText.length <= maxChars) return fullText;

  // 超长页面按价格锚点行保留上下文窗口，避免尾部模型表被一刀截断
  const anchorRe = /\$|\b(?:mtok|per\s+1m|1m\s+tokens|million\s+tokens|input|output|cached|cache|context|200k|gemini|claude|gpt)\b/i;
  const keep = new Uint8Array(lines.length);
  for (let i = 0; i < lines.length; i++) {
    if (anchorRe.test(lines[i])) {
      const start = Math.max(0, i - 2);
      const end = Math.min(lines.length - 1, i + 4);
      for (let j = start; j <= end; j++) {
        // 上下文补全行过长时不纳入，避免单行大段落挤占或阻断后续真实价格行
        if (j !== i && lines[j].length > 500) continue;
        keep[j] = 1;
      }
    }
  }

  const chunks = [];
  let total = 0;
  let inGap = false;
  for (let i = 0; i < lines.length; i++) {
    if (!keep[i]) {
      inGap = true;
      continue;
    }
    const remaining = maxChars - total;
    if (remaining <= 32) break;
    let next = lines[i];
    if (next.length + 1 > remaining) {
      if (anchorRe.test(next)) {
        next = next.slice(0, remaining - 1);
      } else {
        inGap = true;
        continue;
      }
    }
    if (inGap && chunks.length > 0 && remaining > 5) {
      chunks.push('...');
      total += 4;
    }
    inGap = false;
    chunks.push(next);
    total += next.length + 1;
  }
  return chunks.join('\n');
}

export function detectBlockedOrEmptyPage(html, cleanText, rule) {
  if (/Just a moment|cf-browser-verification|Enable JavaScript and cookies to continue/i.test(html)) {
    return 'anti_bot_challenge';
  }
  if (cleanText.length < 250) {
    return 'empty_or_csr_shell';
  }
  if (rule && !rule.anchor.test(cleanText)) {
    return 'anchor_missing';
  }
  return null;
}

/**
 * 为 CSR 空壳文档页生成同路径 `.md` 回退地址（例如 aistudio.google.com/docs/pricing -> pricing.md）。
 */
export function buildMarkdownFallbackUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.pathname.endsWith('.md')) return null;
    const basePath = parsed.pathname.replace(/\/+$/, '');
    if (!basePath) return null;
    parsed.pathname = `${basePath}.md`;
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

function stripMarkdownTableCell(rawCell) {
  return String(rawCell ?? '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\\([*_`~])/g, '$1')
    .replace(/[*†‡]+/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/`/g, '')
    .trim();
}

export function parseAntigravityHostModels(modelsMd, enterpriseMd = '') {
  const hostModels = new Map();
  const keys = new Set();
  const consumerKeys = new Set();

  const registerKeyVariants = (rawId, isConsumer) => {
    const norm = normalizeUpstreamModelKey(rawId);
    if (!norm || /^orchestrator\b/i.test(norm)) return null;
    const canonical = canonicalCatalogKeyForNewModel(norm);
    for (const variant of [norm, canonical, ...expandCanonicalVariants(norm), ...expandCanonicalVariants(canonical)]) {
      if (variant) keys.add(variant);
    }
    if (isConsumer) {
      consumerKeys.add(canonical);
    }
    return canonical;
  };

  const parseMarkdownSectionRows = (mdText, sectionHeaderRe) => {
    const text = String(mdText ?? '');
    if (!text) return [];
    const lines = text.split(/\r?\n/);
    let inSection = false;
    const rows = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (/^#{1,3}\s+/.test(trimmed)) {
        if (sectionHeaderRe.test(trimmed)) {
          inSection = true;
          continue;
        }
        if (inSection) break;
      }
      if (!inSection || !trimmed.startsWith('|')) continue;
      const cells = trimmed.split('|').slice(1, -1).map((c) => c.trim());
      if (cells.length < 2) continue;
      if (cells.every((c) => /^:?-+:?$/.test(c)) || /^model$/i.test(cells[0])) continue;
      rows.push(cells);
    }
    return rows;
  };

  for (const cells of parseMarkdownSectionRows(modelsMd, /^##\s+Reasoning\s+model\b/i)) {
    const label = stripMarkdownTableCell(cells[0]);
    if (!label || /^orchestrator\b/i.test(label)) continue;
    const tierCols = cells.slice(1, 4);
    const enterpriseCol = cells[4] ?? '';
    const consumerActive = tierCols.some((c) => c.includes('✅'));
    const enterpriseActive = enterpriseCol.includes('✅');
    if (!consumerActive && !enterpriseActive) continue;
    const canonical = registerKeyVariants(label, consumerActive);
    if (!canonical) continue;
    hostModels.set(canonical, {
      key: canonical,
      displayName: label,
      consumerActive,
      enterpriseActive,
    });
  }

  for (const cells of parseMarkdownSectionRows(enterpriseMd, /^##\s+Supported\s+models\b/i)) {
    const label = stripMarkdownTableCell(cells[0]);
    if (!label || /^orchestrator\b/i.test(label)) continue;
    const enterpriseCol = cells[2] ?? '';
    const enterpriseActive = enterpriseCol.includes('✅');
    const existing = hostModels.get(canonicalCatalogKeyForNewModel(normalizeUpstreamModelKey(label)));
    const isConsumer = Boolean(existing?.consumerActive);
    if (!enterpriseActive && !isConsumer) continue;
    const canonical = registerKeyVariants(label, isConsumer);
    const idRaw = String(cells[1] ?? '').replace(/\\([*_`])/g, '$1');
    const idMatch = idRaw.match(/`([^`]+)`/);
    if (idMatch?.[1]) {
      const cleanedId = idMatch[1]
        .replace(/-(?:<level>|extra-high|extra-low|xhigh|high|medium|low|minimal|max)$/i, '')
        .replace(/-preview$/i, '')
        .trim();
      registerKeyVariants(cleanedId, isConsumer);
      if (idMatch[1].trim() !== cleanedId) {
        registerKeyVariants(idMatch[1].replace(/-(?:<level>)$/i, '').trim(), isConsumer);
      }
    }
    if (canonical && !hostModels.has(canonical)) {
      hostModels.set(canonical, {
        key: canonical,
        displayName: label,
        consumerActive: isConsumer,
        enterpriseActive,
      });
    }
  }

  return { models: hostModels, keys, consumerKeys };
}

const MONTH_PATTERNS = [
  '(?:january|jan)',
  '(?:february|feb)',
  '(?:march|mar)',
  '(?:april|apr)',
  '(?:may)',
  '(?:june|jun)',
  '(?:july|jul)',
  '(?:august|aug)',
  '(?:september|sept|sep)',
  '(?:october|oct)',
  '(?:november|nov)',
  '(?:december|dec)',
];

function extractMatchedNormalizedQuote(cleanText, rawQuote) {
  if (!cleanText || typeof cleanText !== 'string') return null;
  const normQuote = String(rawQuote ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (normQuote.length < 6) return null;
  const normText = cleanText.replace(/\s+/g, ' ').toLowerCase();
  const stripPipes = (s) => s.replace(/\s*\|\s*/g, ' ').replace(/\s+/g, ' ').trim();
  const quoteMatched = normText.includes(normQuote) || stripPipes(normText).includes(stripPipes(normQuote));
  return quoteMatched ? normQuote : null;
}

function extractUsdPricesFromQuote(normQuote) {
  return [...normQuote.matchAll(/(?:\$|usd\s*)(\d+(?:,\d{3})*(?:\.\d+)?)/gi)]
    .map((m) => Number.parseFloat(m[1].replace(/,/g, '')))
    .filter((n) => Number.isFinite(n));
}

function quoteMatchesRates(priceNums, { input, output, cached, cacheWrite }) {
  if (!Number.isFinite(input) || input <= 0 || !Number.isFinite(output) || output <= 0) {
    return false;
  }
  const hasInput = priceNums.some((n) => ratesClose(n, input));
  const hasOutput = priceNums.some((n) => ratesClose(n, output));
  if (!hasInput || !hasOutput) return false;
  if (ratesClose(input, output)) {
    const sameCount = priceNums.filter((n) => ratesClose(n, input)).length;
    if (sameCount < 2) return false;
  }
  if (Number.isFinite(cached) && cached > 0) {
    if (!priceNums.some((n) => ratesClose(n, cached))) return false;
  }
  if (Number.isFinite(cacheWrite) && cacheWrite > 0) {
    if (!priceNums.some((n) => ratesClose(n, cacheWrite))) return false;
  }
  return true;
}

function normalizeIsoDateOnly(raw) {
  const m = String(raw ?? '').trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:$|T)/);
  if (!m) return null;
  const y = Number.parseInt(m[1], 10);
  const mo = Number.parseInt(m[2], 10);
  const d = Number.parseInt(m[3], 10);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    return null;
  }
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function nextDayStartIso(isoDate) {
  const [y, m, d] = isoDate.split('-').map((n) => Number.parseInt(n, 10));
  const nextMs = Date.UTC(y, m - 1, d) + 86_400_000;
  return new Date(nextMs).toISOString().slice(0, 10) + 'T00:00:00Z';
}

function quoteContainsThreshold(normQuote, thresholdTokens) {
  if (!Number.isSafeInteger(thresholdTokens) || thresholdTokens <= 0) return false;
  const forms = new Set([
    String(thresholdTokens),
    thresholdTokens.toLocaleString('en-US'),
  ]);
  if (thresholdTokens % 1000 === 0) {
    const k = thresholdTokens / 1000;
    forms.add(`${k}k`);
    forms.add(`${k} k`);
  }
  if (thresholdTokens >= 1_000_000 && thresholdTokens % 100_000 === 0) {
    const m = thresholdTokens / 1_000_000;
    forms.add(`${m}m`);
    forms.add(`${m} m`);
  }
  for (const form of forms) {
    const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(?:^|[^0-9a-z.])${escaped}(?:$|[^0-9a-z])`, 'i').test(normQuote)) {
      return true;
    }
  }
  return false;
}

function quoteContainsDate(normQuote, isoDate) {
  const [yStr, mStr, dStr] = isoDate.split('-');
  const mNum = Number.parseInt(mStr, 10);
  const dNum = Number.parseInt(dStr, 10);
  const monthPat = MONTH_PATTERNS[mNum - 1];
  const dayPat = `0?${dNum}`;
  const monthNumPat = `0?${mNum}`;
  const patterns = [
    new RegExp(`(?:^|[^0-9])${yStr}[-/]${monthNumPat}[-/]${dayPat}(?:$|[^0-9])`),
    new RegExp(`(?:^|[^a-z0-9])${monthPat}\\.?\\s+${dayPat}(?:st|nd|rd|th)?(?:,\\s*|\\s+)${yStr}(?:$|[^0-9])`, 'i'),
    new RegExp(`(?:^|[^0-9])${dayPat}(?:st|nd|rd|th)?\\s+${monthPat}\\.?(?:,\\s*|\\s+)${yStr}(?:$|[^0-9])`, 'i'),
    new RegExp(`${yStr}\\s*年\\s*${monthNumPat}\\s*月\\s*${dayPat}\\s*日`),
  ];
  return patterns.some((re) => re.test(normQuote));
}

export function verifyOfficialEvidence(cleanText, item) {
  if (!item || typeof item !== 'object') return false;
  const normQuote = extractMatchedNormalizedQuote(cleanText, item.evidenceQuote);
  if (!normQuote) return false;

  const modelNorm = normalizeUpstreamModelKey(item.officialModelName || item.catalogKey || '');
  const modelTokens = modelNorm.split(/[^a-z0-9]+/).filter(Boolean);
  if (modelTokens.length === 0) return false;
  const normQuoteTokens = normQuote.replace(/[^a-z0-9]+/g, ' ');
  for (const tok of modelTokens) {
    const escaped = tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp(`(?:^|\\s)${escaped}(?:$|\\s)`).test(normQuoteTokens)) return false;
  }

  const priceNums = extractUsdPricesFromQuote(normQuote);
  return quoteMatchesRates(priceNums, {
    input: item.inputPer1M,
    output: item.outputPer1M,
    cached: item.cachedPer1M,
    cacheWrite: item.cacheWritePer1M,
  });
}

export function verifyOfficialTierEvidence(cleanText, item) {
  if (!item || typeof item !== 'object') return false;
  if (item.hasContextTiers !== true || item.hasMultipleContextTiers === true) return false;
  if (!Number.isSafeInteger(item.contextThresholdTokens) || item.contextThresholdTokens < 10_000 || item.contextThresholdTokens > 10_000_000) {
    return false;
  }
  const rawQuote = typeof item.tierEvidenceQuote === 'string' && item.tierEvidenceQuote.trim()
    ? item.tierEvidenceQuote
    : item.evidenceQuote;
  const normQuote = extractMatchedNormalizedQuote(cleanText, rawQuote);
  if (!normQuote) return false;
  if (!quoteContainsThreshold(normQuote, item.contextThresholdTokens)) return false;

  const priceNums = extractUsdPricesFromQuote(normQuote);
  return quoteMatchesRates(priceNums, {
    input: item.tierInputPer1M,
    output: item.tierOutputPer1M,
    cached: item.tierCachedPer1M,
    cacheWrite: item.tierCacheWritePer1M,
  });
}

export function verifyOfficialPromoEvidence(cleanText, item) {
  if (!item || typeof item !== 'object') return false;
  const promoDate = normalizeIsoDateOnly(item.promoValidUntil);
  if (!promoDate) return false;
  const rawQuote = typeof item.promoEvidenceQuote === 'string' && item.promoEvidenceQuote.trim()
    ? item.promoEvidenceQuote
    : item.evidenceQuote;
  const normQuote = extractMatchedNormalizedQuote(cleanText, rawQuote);
  if (!normQuote) return false;
  if (!quoteContainsDate(normQuote, promoDate)) return false;

  const priceNums = extractUsdPricesFromQuote(normQuote);
  return quoteMatchesRates(priceNums, {
    input: item.postPromoInputPer1M,
    output: item.postPromoOutputPer1M,
    cached: item.postPromoCachedPer1M,
    cacheWrite: item.postPromoCacheWritePer1M,
  });
}

export function isTrackedCanonicalModel(key, catalog) {
  if (!key || INTERNAL_DERIVATIVE_RE.test(key)) return false;
  const activeSet = new Set(catalog.activeModels ?? []);
  if (activeSet.has(key)) return true;
  const entry = catalog.prices?.[key];
  if (!entry || Array.isArray(entry)) return false;
  return entry.provenance?.verification === 'confirmed';
}

export function resolveCurrentRate(entry, nowMs = Date.now()) {
  if (!entry) return null;
  if (Array.isArray(entry)) {
    return (
      entry.find((iv) => {
        const f = iv?.validFrom ? Date.parse(iv.validFrom) : -Infinity;
        const u = iv?.validUntil ? Date.parse(iv.validUntil) : Infinity;
        return nowMs >= f && nowMs < u;
      }) ?? entry[entry.length - 1]
    );
  }
  if (Array.isArray(entry.intervals) && entry.intervals.length > 0) {
    const matched = entry.intervals.find((iv) => {
      const f = iv?.validFrom ? Date.parse(iv.validFrom) : -Infinity;
      const u = iv?.validUntil ? Date.parse(iv.validUntil) : Infinity;
      return nowMs >= f && nowMs < u;
    });
    if (matched) return matched;
  }
  return entry;
}

export function hasPendingFutureInterval(entry, nowMs = Date.now()) {
  const intervals = Array.isArray(entry) ? entry : entry?.intervals;
  if (!Array.isArray(intervals)) return false;
  return intervals.some((iv) => {
    const f = iv?.validFrom ? Date.parse(iv.validFrom) : NaN;
    return Number.isFinite(f) && f > nowMs;
  });
}

function getPendingFutureIntervals(entry, nowMs = Date.now()) {
  const intervals = Array.isArray(entry) ? entry : entry?.intervals;
  if (!Array.isArray(intervals)) return [];
  return intervals.filter((iv) => {
    const f = iv?.validFrom ? Date.parse(iv.validFrom) : NaN;
    return Number.isFinite(f) && f > nowMs;
  });
}

function tupleMatchesRate(rate, inputVal, outputVal, cachedVal, cacheWriteVal) {
  if (!rate) return false;
  if (!ratesClose(rate.input, inputVal) || !ratesClose(rate.output, outputVal)) return false;
  if (Number.isFinite(cachedVal) && !ratesClose(rate.cached, cachedVal)) return false;
  if (rate.cacheWrite !== undefined && Number.isFinite(cacheWriteVal) && !ratesClose(rate.cacheWrite, cacheWriteVal)) {
    return false;
  }
  return true;
}

/**
 * 若本地已预设未来区间且上游出现的差异正好吻合该预设未来区间（同时未出现未预期的其它价格偏离），
 * 说明属于已知且已排期生效的过渡期定价，无需每日重复报黄灯。
 */
export function isAccountedByFutureInterval({ local, entry, officialValid, official, litellm, nowMs = Date.now() }) {
  const futureIntervals = getPendingFutureIntervals(entry, nowMs);
  if (futureIntervals.length === 0) return false;

  return futureIntervals.some((iv) => {
    const officialMatchesLocalOrFuture =
      !officialValid ||
      tupleMatchesRate(local, official.inputPer1M, official.outputPer1M, official.cachedPer1M, official.cacheWritePer1M) ||
      tupleMatchesRate(iv, official.inputPer1M, official.outputPer1M, official.cachedPer1M, official.cacheWritePer1M);

    const litellmMatchesLocalOrFuture =
      !litellm ||
      tupleMatchesRate(local, litellm.input, litellm.output, litellm.cached, litellm.cacheWrite) ||
      tupleMatchesRate(iv, litellm.input, litellm.output, litellm.cached, litellm.cacheWrite);

    return officialMatchesLocalOrFuture && litellmMatchesLocalOrFuture;
  });
}

export function ratesClose(a, b, tolerance = CONSENSUS_TOLERANCE) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const diff = Math.abs(a - b);
  if (diff <= CONSENSUS_ABS_EPSILON) return true;
  const denom = Math.max(Math.abs(a), Math.abs(b), 0.01);
  return diff / denom <= tolerance;
}

export function normalizeUpstreamModelKey(rawKey) {
  return String(rawKey ?? '')
    .trim()
    .toLowerCase()
    .replace(/^(?:vertex_ai|gemini|google|anthropic|openai)\//i, '')
    .replace(/@.+$/, '')
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/[*†‡]+/g, '')
    .replace(/[_\s]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function parseLiteLlmRates(data) {
  const map = new Map();
  const skipProviderOrChannelRe = /(?:^|\/)(?:bedrock|azure|azure_ai|sagemaker|together_ai|fireworks_ai|groq|deepseek|openrouter|databricks|snowflake|cohere|replicate|perplexity|baseten|deepinfra|lambda|cloudflare|mistral|voyage|palm)\b|(?:^|[\/_-])(?:us|eu|europe|asia|ap|me|sa)-(?:central|east|west|north|south|northeast|southeast)|(?:^|[-_/:])(?:batch|flex|priority|provisioned|audio|realtime|image|video|tts|stt|embed)(?:$|[-_/:])/i;
  const directProviderPriority = (key) => {
    if (/^(?:gemini|anthropic|openai)\//i.test(key)) return 3;
    if (!key.includes('/')) return 2;
    if (/^vertex_ai\//i.test(key)) return 1;
    return 0;
  };

  for (const [rawKey, spec] of Object.entries(data ?? {})) {
    if (!spec || typeof spec !== 'object') continue;
    if (skipProviderOrChannelRe.test(rawKey)) continue;
    const priority = directProviderPriority(rawKey);
    if (priority === 0) continue;

    const inPerM = Number(spec.input_cost_per_token) * 1_000_000;
    const outPerM = Number(spec.output_cost_per_token) * 1_000_000;
    if (!Number.isFinite(inPerM) || inPerM <= 0 || !Number.isFinite(outPerM) || outPerM <= 0) continue;

    const cleanKey = normalizeUpstreamModelKey(rawKey);
    if (!cleanKey) continue;

    const cachedRaw = Number(spec.cache_read_input_token_cost);
    const cacheWriteRaw = Number(spec.cache_creation_input_token_cost);
    const tierInRaw = Number(spec.input_cost_per_token_above_200k_tokens);
    const tierOutRaw = Number(spec.output_cost_per_token_above_200k_tokens);
    const tierCachedRaw = Number(spec.cache_read_input_token_cost_above_200k_tokens);
    const tierCwRaw = Number(spec.cache_creation_input_token_cost_above_200k_tokens);
    const hasAbove200k = Number.isFinite(tierInRaw) && tierInRaw > 0;
    const contextTier =
      hasAbove200k && Number.isFinite(tierOutRaw) && tierOutRaw > 0
        ? {
            thresholdTokens: 200_000,
            input: roundRate(tierInRaw * 1_000_000),
            output: roundRate(tierOutRaw * 1_000_000),
            ...(Number.isFinite(tierCachedRaw) && tierCachedRaw >= 0 ? { cached: roundRate(tierCachedRaw * 1_000_000) } : {}),
            ...(Number.isFinite(tierCwRaw) && tierCwRaw >= 0 ? { cacheWrite: roundRate(tierCwRaw * 1_000_000) } : {}),
          }
        : undefined;

    const maxInputRaw = Number(spec.max_input_tokens ?? spec.max_tokens);
    const contextWindow =
      Number.isSafeInteger(maxInputRaw) && maxInputRaw >= 4_096 && maxInputRaw <= 10_000_000
        ? maxInputRaw
        : undefined;

    const candidate = {
      rawKey,
      cleanKey,
      priority,
      input: roundRate(inPerM),
      output: roundRate(outPerM),
      ...(Number.isFinite(cachedRaw) && cachedRaw >= 0 ? { cached: roundRate(cachedRaw * 1_000_000) } : {}),
      ...(Number.isFinite(cacheWriteRaw) && cacheWriteRaw >= 0 ? { cacheWrite: roundRate(cacheWriteRaw * 1_000_000) } : {}),
      ...(contextWindow ? { contextWindow } : {}),
      hasContextTiers: hasAbove200k,
      ...(contextTier ? { contextTier } : {}),
      source: 'litellm',
    };

    const existing = map.get(cleanKey);
    if (!existing || candidate.priority > existing.priority) {
      map.set(cleanKey, candidate);
    }
  }
  return map;
}

export function parseOpenRouterRates(payload) {
  const map = new Map();
  for (const item of payload?.data ?? []) {
    const id = normalizeUpstreamModelKey(item?.id ?? '');
    if (!id || IGNORED_RADAR_SUFFIX_RE.test(id)) continue;
    const inPerM = Number(item?.pricing?.prompt) * 1_000_000;
    const outPerM = Number(item?.pricing?.completion) * 1_000_000;
    if (!Number.isFinite(inPerM) || inPerM <= 0 || !Number.isFinite(outPerM) || outPerM <= 0) continue;
    const cacheReadRaw = Number(item?.pricing?.input_cache_read);
    const cacheWriteRaw = Number(item?.pricing?.input_cache_write);
    const ctxRaw = Number(item?.context_length ?? item?.top_provider?.context_length);
    const contextWindow =
      Number.isSafeInteger(ctxRaw) && ctxRaw >= 4_096 && ctxRaw <= 10_000_000
        ? ctxRaw
        : undefined;
    map.set(id, {
      cleanKey: id,
      input: roundRate(inPerM),
      output: roundRate(outPerM),
      ...(Number.isFinite(cacheReadRaw) && cacheReadRaw >= 0 ? { cached: roundRate(cacheReadRaw * 1_000_000) } : {}),
      ...(Number.isFinite(cacheWriteRaw) && cacheWriteRaw >= 0 ? { cacheWrite: roundRate(cacheWriteRaw * 1_000_000) } : {}),
      ...(contextWindow ? { contextWindow } : {}),
      source: 'openrouter',
    });
  }
  return map;
}

const CLAUDE_FAMILY_TOKEN_SRC =
  '(?!thinking|preview|trial|latest|high|medium|low|max|minimal|xhigh|extra|tiered|fast|batch|exp)[a-z]{3,16}';
const CLAUDE_FAMILY_HYPHEN_RE = new RegExp(`^(claude-${CLAUDE_FAMILY_TOKEN_SRC}-)(\\d+)\\.(\\d+)$`, 'i');
const CLAUDE_FAMILY_DOT_RE = new RegExp(`^(claude-${CLAUDE_FAMILY_TOKEN_SRC}-)(\\d+)-(\\d+)$`, 'i');
const CLAUDE_FAMILY_FWD_RE = new RegExp(`^claude-(${CLAUDE_FAMILY_TOKEN_SRC})-(\\d+)[.-](\\d+)$`, 'i');
const CLAUDE_FAMILY_REV_RE = new RegExp(`^claude-(\\d+)[.-](\\d+)-(${CLAUDE_FAMILY_TOKEN_SRC})$`, 'i');

function expandCanonicalVariants(normKey) {
  if (!normKey) return [];
  const out = new Set([normKey]);
  const claudeHyphen = normKey.replace(CLAUDE_FAMILY_HYPHEN_RE, '$1$2-$3');
  if (claudeHyphen !== normKey) out.add(claudeHyphen);
  const claudeDot = normKey.replace(CLAUDE_FAMILY_DOT_RE, '$1$2.$3');
  if (claudeDot !== normKey) out.add(claudeDot);
  const claudeMatch =
    normKey.match(CLAUDE_FAMILY_FWD_RE) ??
    (() => {
      const rev = normKey.match(CLAUDE_FAMILY_REV_RE);
      return rev ? [rev[0], rev[3], rev[1], rev[2]] : null;
    })();
  if (claudeMatch) {
    const tier = claudeMatch[1].toLowerCase();
    const major = claudeMatch[2];
    const minor = claudeMatch[3];
    out.add(`claude-${tier}-${major}-${minor}`);
    out.add(`claude-${tier}-${major}.${minor}`);
    out.add(`claude-${major}-${minor}-${tier}`);
    out.add(`claude-${major}.${minor}-${tier}`);
  }
  return [...out];
}

function lookupUpstreamByNormalizedId(normId, map) {
  for (const candidate of expandCanonicalVariants(normId)) {
    if (map.has(candidate)) return map.get(candidate);
  }
  return null;
}

function lookupUpstreamForCatalogKey(key, map) {
  const candidates = [key, ...(CATALOG_TO_UPSTREAM_ALIASES[key] ?? [])].map((s) => normalizeUpstreamModelKey(s));
  for (const candidate of candidates) {
    const hit = lookupUpstreamByNormalizedId(candidate, map);
    if (hit) return hit;
  }
  return null;
}

function buildGeminiGenerationConfig(model) {
  const generationConfig = {
    temperature: 0,
    responseMimeType: 'application/json',
    responseSchema: GEMINI_EXTRACTION_SCHEMA,
  };
  // Gemini 3.6+ / 4.x+ 非 lite 文本模型支持 thinkingLevel='low'，避免默认 medium/high 思考拉高输出计费
  if (/^gemini-(?:3\.(?:[6-9]|\d{2})|[4-9]|[1-9]\d+)/i.test(model) && !/(?:lite|tts|image|live)/i.test(model)) {
    generationConfig.thinkingConfig = { thinkingLevel: 'low' };
  }
  return generationConfig;
}

export async function extractPricesWithGemini({ url, vendor, cleanText, targetModels, apiKey, model = process.env.GEMINI_MODEL || 'gemini-3.8-flash', fetchImpl = fetch }) {
  const modelListText = targetModels
    .map((m) => `- catalogKey: "${m.key}", displayName: "${m.displayName}"`)
    .join('\n');

  const prompt = [
    `You are auditing official LLM API pricing from ${vendor} (${url}).`,
    'Extract ONLY standard pay-as-you-go Global/Standard API text token pricing in USD per 1M tokens.',
    'Ignore Batch API, Provisioned Throughput, regional premiums, audio/image/video modalities, and deprecated models unless listed below.',
    'If a model has single-threshold long-context tiered pricing (e.g. >100k or >200k tokens), record base rates in inputPer1M/outputPer1M/cachedPer1M/cacheWritePer1M, set hasContextTiers=true and contextThresholdTokens (integer token threshold), record high-tier rates in tierInputPer1M/tierOutputPer1M/tierCachedPer1M/tierCacheWritePer1M, and include a verbatim tierEvidenceQuote containing the threshold and $-prefixed tier prices. If there are 2 or more separate context tier breakpoints, set hasMultipleContextTiers=true.',
    'If a model has a limited-time promotional rate with an explicit end date, set promoValidUntil (YYYY-MM-DD); if the page also explicitly states the post-promotion standard list prices, populate postPromoInputPer1M/postPromoOutputPer1M/postPromoCachedPer1M/postPromoCacheWritePer1M and include a verbatim promoEvidenceQuote containing the end date and $-prefixed standard prices.',
    'Also extract any NEW flagship chat models on this page that are not in the target list below (leave catalogKey empty for genuinely new models).',
    'For each extracted model, include a short verbatim quote from the page in evidenceQuote (<= 160 chars) that contains the model name and $-prefixed base prices (input, output, and any listed cached or cache write rates). Never guess missing numbers.',
    '',
    'Target catalog models to look for on this page:',
    modelListText || '(none)',
    '',
    'Cleaned pricing page text:',
    cleanText,
  ].join('\n');

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: buildGeminiGenerationConfig(model),
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = new Error(`Gemini API HTTP ${res.status}: ${text.slice(0, 200)}`);
        if (res.status === 408 || res.status === 429 || res.status >= 500) {
          lastError = err;
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        err.nonRetryable = true;
        throw err;
      }
      const payload = await res.json();
      const rawJsonText = payload?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
      if (!rawJsonText) throw new Error('Gemini API returned empty content');
      const parsed = JSON.parse(rawJsonText);
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.models)) {
        throw new Error('Gemini API JSON missing models array');
      }
      const um = payload?.usageMetadata;
      if (um && typeof um === 'object') {
        Object.defineProperty(parsed, '__usageMetadata', {
          value: {
            model,
            promptTokenCount: Number(um.promptTokenCount) || 0,
            thoughtsTokenCount: Number(um.thoughtsTokenCount) || 0,
            candidatesTokenCount: Number(um.candidatesTokenCount) || 0,
            totalTokenCount: Number(um.totalTokenCount) || 0,
          },
          enumerable: false,
          configurable: true,
        });
      }
      return parsed;
    } catch (err) {
      lastError = err;
      if (err?.nonRetryable) throw err;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  throw lastError ?? new Error('Gemini API extraction failed');
}

/**
 * 对单个模型评估本地价格 vs 官网提取 vs LiteLLM 共识门禁，返回：
 * - status: 'unchanged' | 'green' | 'yellow'
 */
export function evaluateModelConsensus({
  key,
  localEntry,
  official,
  litellm,
  openrouter,
  nowMs = Date.now(),
}) {
  const local = resolveCurrentRate(localEntry, nowMs);
  if (!local) return { key, status: 'unchanged' };

  const officialValid =
    official &&
    official.confidence !== 'low' &&
    Number.isFinite(official.inputPer1M) &&
    official.inputPer1M > 0 &&
    Number.isFinite(official.outputPer1M) &&
    official.outputPer1M > 0;

  const localPrimaryTier =
    Array.isArray(local.contextTiers) && local.contextTiers.length > 0 ? local.contextTiers[0] : null;
  const officialHasTierNums =
    Boolean(officialValid) &&
    Number.isFinite(official.tierInputPer1M) &&
    official.tierInputPer1M > 0 &&
    Number.isFinite(official.tierOutputPer1M) &&
    official.tierOutputPer1M > 0;
  const officialTierDiffers =
    Boolean(officialValid && localPrimaryTier && officialHasTierNums) &&
    ((Number.isSafeInteger(official.contextThresholdTokens) &&
      official.contextThresholdTokens > 0 &&
      official.contextThresholdTokens !== localPrimaryTier.thresholdTokens) ||
      !ratesClose(localPrimaryTier.input, official.tierInputPer1M) ||
      !ratesClose(localPrimaryTier.output, official.tierOutputPer1M) ||
      (Number.isFinite(official.tierCachedPer1M) && !ratesClose(localPrimaryTier.cached, official.tierCachedPer1M)) ||
      (localPrimaryTier.cacheWrite !== undefined &&
        Number.isFinite(official.tierCacheWritePer1M) &&
        !ratesClose(localPrimaryTier.cacheWrite, official.tierCacheWritePer1M)));

  const officialDiffers =
    officialValid &&
    (!ratesClose(local.input, official.inputPer1M) ||
      !ratesClose(local.output, official.outputPer1M) ||
      (Number.isFinite(official.cachedPer1M) && !ratesClose(local.cached, official.cachedPer1M)) ||
      (local.cacheWrite !== undefined &&
        Number.isFinite(official.cacheWritePer1M) &&
        !ratesClose(local.cacheWrite, official.cacheWritePer1M)) ||
      officialTierDiffers ||
      official.hasMultipleContextTiers === true);

  const litellmTierDiffers =
    Boolean(litellm?.contextTier && localPrimaryTier && localPrimaryTier.thresholdTokens === litellm.contextTier.thresholdTokens) &&
    (!ratesClose(localPrimaryTier.input, litellm.contextTier.input) ||
      !ratesClose(localPrimaryTier.output, litellm.contextTier.output) ||
      (Number.isFinite(litellm.contextTier.cached) && !ratesClose(localPrimaryTier.cached, litellm.contextTier.cached)) ||
      (localPrimaryTier.cacheWrite !== undefined &&
        Number.isFinite(litellm.contextTier.cacheWrite) &&
        !ratesClose(localPrimaryTier.cacheWrite, litellm.contextTier.cacheWrite)));

  const litellmDiffers =
    litellm &&
    (!ratesClose(local.input, litellm.input) ||
      !ratesClose(local.output, litellm.output) ||
      (Number.isFinite(litellm.cached) && !ratesClose(local.cached, litellm.cached)) ||
      (local.cacheWrite !== undefined &&
        Number.isFinite(litellm.cacheWrite) &&
        !ratesClose(local.cacheWrite, litellm.cacheWrite)) ||
      litellmTierDiffers);

  if (!officialDiffers && !litellmDiffers) {
    return { key, status: 'unchanged', local, official, litellm, openrouter };
  }

  if (isAccountedByFutureInterval({ local, entry: localEntry, officialValid, official, litellm, nowMs })) {
    return { key, status: 'unchanged', local, official, litellm, openrouter };
  }

  const reasons = [];
  const officialSelfVerified = Boolean(
    officialValid && official.confidence === 'high' && official.evidenceVerified === true
  );
  if (!officialValid) reasons.push('官网未抓到高/中置信度有效价格（仅 LiteLLM 存在偏移）');
  if (!litellm && !officialSelfVerified) reasons.push('LiteLLM 缺少对应通道报价（且官网证据未通过原文核验）');

  if (officialValid && !litellm) {
    if (local.cached > 0 && !Number.isFinite(official.cachedPer1M)) {
      reasons.push('LiteLLM 缺失且官网未提取 cached 报价，无法单源自证');
    }
    if (local.cacheWrite !== undefined && local.cacheWrite > 0 && !Number.isFinite(official.cacheWritePer1M)) {
      reasons.push('本地已配置cacheWrite且官网未提取cacheWrite报价，无法单源自证');
    }
  }

  if (officialValid && litellm) {
    if (!ratesClose(official.inputPer1M, litellm.input) || !ratesClose(official.outputPer1M, litellm.output)) {
      reasons.push(`官网($${official.inputPer1M}/$${official.outputPer1M})与LiteLLM($${litellm.input}/$${litellm.output})偏差>1%`);
    }
    const offCached = Number.isFinite(official.cachedPer1M) ? official.cachedPer1M : null;
    const ltCached = Number.isFinite(litellm.cached) ? litellm.cached : null;
    if (offCached !== null && ltCached !== null && !ratesClose(offCached, ltCached)) {
      reasons.push(`官网cached($${offCached})与LiteLLM($${ltCached})偏差>1%`);
    } else if (offCached === null && ltCached !== null && !ratesClose(local.cached, ltCached)) {
      reasons.push('官网缺少cached报价无法交叉印证');
    } else if (offCached !== null && ltCached === null && !officialSelfVerified && !ratesClose(local.cached, offCached)) {
      reasons.push('LiteLLM缺少cached报价无法交叉印证');
    }

    if (local.cacheWrite !== undefined && local.cacheWrite > 0) {
      const offCw = Number.isFinite(official.cacheWritePer1M) ? official.cacheWritePer1M : null;
      const ltCw = Number.isFinite(litellm.cacheWrite) ? litellm.cacheWrite : null;
      if (offCw === null || (ltCw !== null && !ratesClose(offCw, ltCw)) || (ltCw === null && !officialSelfVerified)) {
        reasons.push('本地已配置cacheWrite但双源未能一致印证');
      }
    }
  }

  let verifiedContextTiers = Array.isArray(local.contextTiers) ? local.contextTiers : undefined;
  if (officialValid) {
    const inRatio = official.inputPer1M / Math.max(0.0001, local.input);
    const outRatio = official.outputPer1M / Math.max(0.0001, local.output);
    if (
      inRatio < MIN_PRICE_RATIO ||
      inRatio > MAX_PRICE_RATIO ||
      outRatio < MIN_PRICE_RATIO ||
      outRatio > MAX_PRICE_RATIO
    ) {
      reasons.push(`价格波动比例(${inRatio.toFixed(2)}x / ${outRatio.toFixed(2)}x)超出0.2x~3.0x安全阈值`);
    }
    if (
      official.inputPer1M > MAX_SAFE_USD_PER_M ||
      official.outputPer1M > MAX_SAFE_USD_PER_M ||
      (Number.isFinite(official.cachedPer1M) && official.cachedPer1M > MAX_SAFE_USD_PER_M)
    ) {
      reasons.push(`提取单价超过$${MAX_SAFE_USD_PER_M}/1M安全上限`);
    }

    const localHasTiers = Array.isArray(local.contextTiers) && local.contextTiers.length > 0;
    if (Boolean(official.hasContextTiers) !== localHasTiers) {
      reasons.push('contextTiers阶梯结构与本地不一致');
    } else if (official.hasMultipleContextTiers === true) {
      reasons.push('检测到多段长上下文阶梯价，需人工复核');
    } else if (officialTierDiffers) {
      if (local.contextTiers.length > 1) {
        reasons.push(`多段长上下文阶梯价变动(官网 >${official.contextThresholdTokens || localPrimaryTier.thresholdTokens}: $${official.tierInputPer1M}/$${official.tierOutputPer1M}，需人工交叉复核)`);
      } else {
        const baseCwCandidate =
          local.cacheWrite !== undefined
            ? Number.isFinite(official.cacheWritePer1M)
              ? official.cacheWritePer1M
              : local.cacheWrite
            : official.cacheWritePer1M;
        const tierRes = evaluateVerifiedContextTier({
          baseInput: roundRate(official.inputPer1M),
          baseOutput: roundRate(official.outputPer1M),
          baseCacheWrite: Number.isFinite(baseCwCandidate) ? baseCwCandidate : undefined,
          official,
          litellm,
        });
        if (!tierRes.ok) {
          reasons.push(
            `长上下文阶梯价变动(官网 >${official.contextThresholdTokens || localPrimaryTier.thresholdTokens}: $${official.tierInputPer1M}/$${official.tierOutputPer1M}：${tierRes.reasons.join('、')})`
          );
        } else {
          const tierInRatio = tierRes.tier.input / Math.max(0.0001, localPrimaryTier.input);
          const tierOutRatio = tierRes.tier.output / Math.max(0.0001, localPrimaryTier.output);
          if (
            tierInRatio < MIN_PRICE_RATIO ||
            tierInRatio > MAX_PRICE_RATIO ||
            tierOutRatio < MIN_PRICE_RATIO ||
            tierOutRatio > MAX_PRICE_RATIO
          ) {
            reasons.push(`长上下文阶梯价波动比例(${tierInRatio.toFixed(2)}x / ${tierOutRatio.toFixed(2)}x)超出0.2x~3.0x安全阈值`);
          } else {
            verifiedContextTiers = [tierRes.tier];
          }
        }
      }
    }
    if (official.promoValidUntil) {
      const existingUntil = local.validUntil ?? local.provenance?.validUntil ?? '';
      if (!existingUntil || !existingUntil.startsWith(official.promoValidUntil.slice(0, 10))) {
        reasons.push(`检测到促销截止日(${official.promoValidUntil})变动`);
      }
    }
  }

  if (hasPendingFutureInterval(localEntry, nowMs)) {
    reasons.push('本地已配置未来生效区间，拒绝自动覆盖');
  }

  if (reasons.length > 0) {
    return {
      key,
      status: 'yellow',
      reasons,
      local,
      official: officialValid ? official : null,
      litellm,
      openrouter,
    };
  }

  const nextCached = Number.isFinite(official.cachedPer1M)
    ? roundRate(official.cachedPer1M)
    : Number.isFinite(litellm?.cached)
      ? roundRate(litellm.cached)
      : local.cached;

  const nextCacheWrite =
    local.cacheWrite !== undefined
      ? Number.isFinite(official.cacheWritePer1M)
        ? roundRate(official.cacheWritePer1M)
        : local.cacheWrite
      : Number.isFinite(official.cacheWritePer1M) &&
          ((Number.isFinite(litellm?.cacheWrite) && ratesClose(official.cacheWritePer1M, litellm.cacheWrite)) ||
            (!litellm && officialSelfVerified))
        ? roundRate(official.cacheWritePer1M)
        : undefined;

  return {
    key,
    status: 'green',
    local,
    official,
    litellm,
    openrouter,
    proposed: {
      input: roundRate(official.inputPer1M),
      output: roundRate(official.outputPer1M),
      cached: nextCached,
      ...(nextCacheWrite !== undefined ? { cacheWrite: nextCacheWrite } : {}),
      ...(Array.isArray(verifiedContextTiers) ? { contextTiers: verifiedContextTiers } : {}),
    },
  };
}

export function bumpCatalogVersion(currentVersion, todayDate) {
  const ver = String(currentVersion ?? '').trim();
  if (!ver || ver < todayDate) return todayDate;
  if (ver === todayDate) return `${todayDate}-r2`;
  const m = ver.match(new RegExp(`^${todayDate}-r(\\d+)$`));
  if (m) return `${todayDate}-r${Number.parseInt(m[1], 10) + 1}`;
  if (ver.startsWith(todayDate)) return `${todayDate}-r2`;
  return todayDate;
}

function stripVolatileProvenanceFields(prov) {
  if (!prov || typeof prov !== 'object' || Array.isArray(prov)) return prov;
  const { checkedAt: _checkedAt, conditions: _conditions, conditionsEn: _conditionsEn, ...rest } = prov;
  return rest;
}

function normalizePriceEntryForSemanticDiff(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  if (Array.isArray(entry)) {
    return entry.map((iv) => normalizePriceEntryForSemanticDiff(iv));
  }
  const normalized = { ...entry };
  if (normalized.provenance) {
    normalized.provenance = stripVolatileProvenanceFields(normalized.provenance);
  }
  if (Array.isArray(normalized.intervals)) {
    normalized.intervals = normalized.intervals.map((iv) => normalizePriceEntryForSemanticDiff(iv));
  }
  return normalized;
}

function normalizeCatalogForSemanticDiff(catalog) {
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) return null;
  const { pricingVersion: _ver, pricingUpdatedAt: _updatedAt, prices, ...rest } = catalog;
  const normalizedPrices = {};
  if (prices && typeof prices === 'object' && !Array.isArray(prices)) {
    for (const [k, v] of Object.entries(prices)) {
      normalizedPrices[k] = normalizePriceEntryForSemanticDiff(v);
    }
  }
  return { ...rest, prices: normalizedPrices };
}

function stableJson(val) {
  if (val === null || typeof val !== 'object') return JSON.stringify(val);
  if (Array.isArray(val)) return `[${val.map((item) => (item === undefined ? 'null' : stableJson(item))).join(',')}]`;
  const keys = Object.keys(val).filter((k) => val[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(val[k])}`).join(',')}}`;
}

export function hasSemanticCatalogChanges(prevCatalog, nextCatalog) {
  const prevNorm = normalizeCatalogForSemanticDiff(prevCatalog);
  const nextNorm = normalizeCatalogForSemanticDiff(nextCatalog);
  if (!prevNorm || !nextNorm) return true;
  return stableJson(prevNorm) !== stableJson(nextNorm);
}

export function canonicalCatalogKeyForNewModel(normId) {
  return String(normId ?? '')
    .trim()
    .toLowerCase()
    .replace(CLAUDE_FAMILY_REV_RE, 'claude-$3-$1-$2')
    .replace(CLAUDE_FAMILY_HYPHEN_RE, '$1$2-$3');
}

export function buildAutoStagedAliases(modelId) {
  const clean = String(modelId ?? '').trim().toLowerCase();
  const match = clean.match(/^gemini-((?:[4-9]|[1-9]\d+)(?:\.\d+)?)-([a-z][a-z0-9]*)$/);
  if (!match) return {};
  const codename = match[2];
  const cap = codename.charAt(0).toUpperCase() + codename.slice(1);
  return {
    [`gemini-pro-orchestrator-${codename}`]: clean,
    [`orchestrator (${codename})`]: clean,
    [`Orchestrator (${cap})`]: clean,
    [`${clean}-tiered`]: clean,
    [`${clean}-tiered-low`]: clean,
    [`${clean}-tiered-medium`]: clean,
    [`${clean}-tiered-high`]: clean,
    [`${clean}-tiered-xhigh`]: clean,
    [`${clean}-tiered-extra-high`]: clean,
  };
}

export function formatCanonicalModelDisplayName(modelId, officialModelName) {
  const cleaned = String(officialModelName ?? '')
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/[*†‡]+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (cleaned) return cleaned;
  return String(modelId ?? '')
    .split('-')
    .map((p) => (p ? p.charAt(0).toUpperCase() + p.slice(1) : p))
    .join(' ');
}

function inferPlatformLabels(vendor, url) {
  if (vendor === 'Google' || /cloud\.google\.com|ai\.google\.dev/i.test(String(url))) {
    return { platform: 'Google Cloud 标准 Global API', platformEn: 'Google Cloud Standard Global API' };
  }
  if (vendor === 'Anthropic' || /anthropic\.com|claude\.com/i.test(String(url))) {
    return { platform: 'Anthropic 标准 API', platformEn: 'Anthropic Standard API' };
  }
  if (vendor === 'OpenAI' || /openai\.com/i.test(String(url))) {
    return { platform: 'OpenAI 标准 API', platformEn: 'OpenAI Standard API' };
  }
  return { platform: `${vendor} 标准 API`, platformEn: `${vendor} Standard API` };
}

export function evaluateVerifiedContextTier({ baseInput, baseOutput, baseCacheWrite, official, litellm }) {
  if (official?.hasMultipleContextTiers === true) {
    return { ok: false, reasons: ['含多段长上下文阶梯价，需人工复核'] };
  }
  const thresholdTokens = official?.contextThresholdTokens;
  if (!Number.isSafeInteger(thresholdTokens) || thresholdTokens < 10_000 || thresholdTokens > 10_000_000) {
    return { ok: false, reasons: ['长上下文阶梯缺少合法 thresholdTokens（需 10k~10M 整数）'] };
  }
  const tierIn = official?.tierInputPer1M;
  const tierOut = official?.tierOutputPer1M;
  if (!Number.isFinite(tierIn) || tierIn <= 0 || !Number.isFinite(tierOut) || tierOut <= 0) {
    return { ok: false, reasons: ['长上下文阶梯缺少有效 input/output 单价'] };
  }
  if (tierIn > MAX_SAFE_USD_PER_M || tierOut > MAX_SAFE_USD_PER_M) {
    return { ok: false, reasons: [`长上下文阶梯单价超过$${MAX_SAFE_USD_PER_M}/1M安全上限`] };
  }
  if (Number.isFinite(baseInput) && baseInput > 0 && Number.isFinite(baseOutput) && baseOutput > 0) {
    const inMult = tierIn / baseInput;
    const outMult = tierOut / baseOutput;
    if (
      tierIn <= baseInput ||
      tierOut <= baseOutput ||
      inMult < MIN_TIER_MULTIPLIER ||
      inMult > MAX_TIER_MULTIPLIER ||
      outMult < MIN_TIER_MULTIPLIER ||
      outMult > MAX_TIER_MULTIPLIER
    ) {
      return {
        ok: false,
        reasons: [`长上下文阶梯倍率(${inMult.toFixed(2)}x / ${outMult.toFixed(2)}x)超出${MIN_TIER_MULTIPLIER}x~${MAX_TIER_MULTIPLIER}x合理范围`],
      };
    }
  }

  const ltRawTier = litellm?.contextTier ?? null;
  if (ltRawTier && ltRawTier.thresholdTokens !== thresholdTokens) {
    return {
      ok: false,
      reasons: [`长上下文阈值(${thresholdTokens})与LiteLLM(${ltRawTier.thresholdTokens})不一致`],
    };
  }
  const ltTier = ltRawTier && ltRawTier.thresholdTokens === thresholdTokens ? ltRawTier : null;
  const tierSelfVerified = Boolean(official?.confidence === 'high' && official?.tierEvidenceVerified === true);
  const reasons = [];

  if (!ltTier && !tierSelfVerified) {
    reasons.push('LiteLLM 缺少对应阶梯报价（且官网阶梯证据未通过原文核验）');
  } else if (ltTier && (!ratesClose(tierIn, ltTier.input) || !ratesClose(tierOut, ltTier.output))) {
    reasons.push(`官网阶梯($${tierIn}/$${tierOut})与LiteLLM($${ltTier.input}/$${ltTier.output})偏差>1%`);
  }

  const offTierCached = Number.isFinite(official?.tierCachedPer1M) && official.tierCachedPer1M >= 0 ? official.tierCachedPer1M : null;
  const ltTierCached = ltTier && Number.isFinite(ltTier.cached) && ltTier.cached >= 0 ? ltTier.cached : null;
  if (offTierCached !== null && offTierCached > MAX_SAFE_USD_PER_M) {
    reasons.push(`长上下文阶梯 cached 单价超过$${MAX_SAFE_USD_PER_M}/1M安全上限`);
  }
  if (offTierCached !== null && ltTierCached !== null && !ratesClose(offTierCached, ltTierCached)) {
    reasons.push(`官网阶梯cached($${offTierCached})与LiteLLM($${ltTierCached})偏差>1%`);
  } else if (offTierCached === null && ltTierCached === null) {
    reasons.push('官网与 LiteLLM 均缺少长上下文阶梯 cached 报价，拒绝静默置零');
  }

  const offTierCwRaw = official?.tierCacheWritePer1M;
  const offTierCw = Number.isFinite(offTierCwRaw) && offTierCwRaw > 0 ? offTierCwRaw : null;
  const ltTierCw = ltTier && Number.isFinite(ltTier.cacheWrite) && ltTier.cacheWrite >= 0 ? ltTier.cacheWrite : null;
  if (offTierCw !== null) {
    if (offTierCw > MAX_SAFE_USD_PER_M) {
      reasons.push(`长上下文阶梯 cacheWrite 单价超过$${MAX_SAFE_USD_PER_M}/1M安全上限`);
    } else if ((ltTierCw !== null && !ratesClose(offTierCw, ltTierCw)) || (ltTierCw === null && !tierSelfVerified)) {
      reasons.push('官网长上下文阶梯含未经 LiteLLM 一致确认的 cacheWrite');
    }
  } else if (ltTierCw !== null && ltTierCw > 0) {
    reasons.push(`LiteLLM 阶梯含 cacheWrite($${ltTierCw}) 但官网未提取到对应报价，需人工复核`);
  } else if (baseCacheWrite !== undefined && baseCacheWrite > 0) {
    reasons.push('基础单价已配置 cacheWrite 但长上下文阶梯缺少对应 tierCacheWrite 报价');
  }

  if (reasons.length > 0) {
    return { ok: false, reasons };
  }

  const resolvedTierCached = roundRate(offTierCached !== null ? offTierCached : ltTierCached);
  const resolvedTierCw = offTierCw !== null
    ? roundRate(offTierCw)
    : baseCacheWrite === 0
      ? 0
      : undefined;

  return {
    ok: true,
    tier: {
      thresholdTokens,
      input: roundRate(tierIn),
      output: roundRate(tierOut),
      cached: resolvedTierCached,
      ...(resolvedTierCw !== undefined ? { cacheWrite: resolvedTierCw } : {}),
    },
  };
}

export function evaluateVerifiedPromoSchedule({ baseInput, baseOutput, baseCacheWrite, official, nowMs = Date.now() }) {
  const promoDate = normalizeIsoDateOnly(official?.promoValidUntil);
  if (!promoDate) {
    return { ok: false, reasons: [`含格式无效的促销截止日(${official?.promoValidUntil})需人工复核`] };
  }
  const validUntilIso = `${promoDate}T23:59:59Z`;
  if (Date.parse(validUntilIso) <= nowMs) {
    return { ok: false, reasons: [`促销截止日(${promoDate})已过期需人工复核`] };
  }
  if (official?.confidence !== 'high' || official?.promoEvidenceVerified !== true) {
    return { ok: false, reasons: [`含推广截止日(${promoDate})但缺少到期恢复标准价的原文核验`] };
  }
  const postIn = official.postPromoInputPer1M;
  const postOut = official.postPromoOutputPer1M;
  if (!Number.isFinite(postIn) || postIn <= 0 || !Number.isFinite(postOut) || postOut <= 0) {
    return { ok: false, reasons: [`含推广截止日(${promoDate})但缺少到期恢复标准价`] };
  }
  if (postIn > MAX_SAFE_USD_PER_M || postOut > MAX_SAFE_USD_PER_M) {
    return { ok: false, reasons: [`促销到期恢复单价超过$${MAX_SAFE_USD_PER_M}/1M安全上限`] };
  }
  if (
    Number.isFinite(baseInput) &&
    baseInput > 0 &&
    Number.isFinite(baseOutput) &&
    baseOutput > 0 &&
    (postIn < baseInput ||
      postOut < baseOutput ||
      postIn / baseInput > MAX_PROMO_POST_MULTIPLIER ||
      postOut / baseOutput > MAX_PROMO_POST_MULTIPLIER)
  ) {
    return { ok: false, reasons: ['促销到期恢复价与促销价比例不合理，需人工复核'] };
  }
  const postCached = official.postPromoCachedPer1M;
  if (!Number.isFinite(postCached) || postCached < 0 || postCached > MAX_SAFE_USD_PER_M) {
    return { ok: false, reasons: ['促销到期恢复价缺少有效 cached 读缓存单价'] };
  }
  const postCwRaw = official.postPromoCacheWritePer1M;
  const hasPostCw = Number.isFinite(postCwRaw) && postCwRaw >= 0;
  if (baseCacheWrite !== undefined && baseCacheWrite > 0 && !hasPostCw) {
    return { ok: false, reasons: ['促销期已配置 cacheWrite 但到期恢复价缺少对应 cacheWrite'] };
  }
  if (hasPostCw && postCwRaw > MAX_SAFE_USD_PER_M) {
    return { ok: false, reasons: [`促销到期恢复 cacheWrite 单价超过$${MAX_SAFE_USD_PER_M}/1M安全上限`] };
  }
  const anyRateHigher =
    postIn > baseInput ||
    postOut > baseOutput ||
    (hasPostCw && postCwRaw > (baseCacheWrite ?? 0));
  if (!anyRateHigher) {
    return { ok: false, reasons: ['促销到期恢复价未高于促销期价格，需人工复核'] };
  }

  const postFromIso = nextDayStartIso(promoDate);
  const resolvedPostCw = hasPostCw
    ? postCwRaw > 0
      ? roundRate(postCwRaw)
      : baseCacheWrite !== undefined
        ? 0
        : undefined
    : undefined;

  return {
    ok: true,
    promo: {
      validUntilDate: promoDate,
      validUntilIso,
      postValidFromDate: postFromIso.slice(0, 10),
      postValidFromIso: postFromIso,
      postRates: {
        input: roundRate(postIn),
        output: roundRate(postOut),
        cached: roundRate(postCached),
        ...(resolvedPostCw !== undefined ? { cacheWrite: resolvedPostCw } : {}),
      },
    },
  };
}

export function evaluateNewModelStagingCandidate({ id, vendor = 'Upstream', url = '', official, litellm, openrouter = null, nowMs = Date.now() }) {
  const catalogKey = canonicalCatalogKeyForNewModel(id);
  const reasons = [];
  if (!official || official.confidence !== 'high') {
    reasons.push('官网未取得 high 置信度标准报价');
  }
  const baseRatesValid = Boolean(
    official &&
      Number.isFinite(official.inputPer1M) &&
      official.inputPer1M > 0 &&
      Number.isFinite(official.outputPer1M) &&
      official.outputPer1M > 0
  );
  if (!baseRatesValid) {
    reasons.push('官网缺少有效 input/output 单价');
  } else if (
    official.inputPer1M > MAX_SAFE_USD_PER_M ||
    official.outputPer1M > MAX_SAFE_USD_PER_M ||
    (Number.isFinite(official.cachedPer1M) && official.cachedPer1M > MAX_SAFE_USD_PER_M)
  ) {
    reasons.push(`提取单价超过$${MAX_SAFE_USD_PER_M}/1M安全上限`);
  }
  const officialSelfVerified = Boolean(official?.confidence === 'high' && official?.evidenceVerified === true);
  if (!litellm && !officialSelfVerified) {
    reasons.push('LiteLLM 尚无对应通道报价（且官网证据未通过原文核验）');
  } else if (
    litellm &&
    baseRatesValid &&
    (!ratesClose(official.inputPer1M, litellm.input) || !ratesClose(official.outputPer1M, litellm.output))
  ) {
    reasons.push(`官网($${official.inputPer1M}/$${official.outputPer1M})与LiteLLM($${litellm.input}/$${litellm.output})偏差>1%`);
  }

  const offCached = official && Number.isFinite(official.cachedPer1M) && official.cachedPer1M >= 0 ? official.cachedPer1M : null;
  const ltCached = litellm && Number.isFinite(litellm.cached) && litellm.cached >= 0 ? litellm.cached : null;
  if (offCached !== null && ltCached !== null && !ratesClose(offCached, ltCached)) {
    reasons.push(`官网cached($${offCached})与LiteLLM($${ltCached})偏差>1%`);
  } else if (offCached === null && ltCached === null) {
    reasons.push('官网与 LiteLLM 均缺少 cached 读缓存报价，拒绝静默置零');
  }

  const offCw = official && Number.isFinite(official.cacheWritePer1M) && official.cacheWritePer1M > 0 ? official.cacheWritePer1M : null;
  const ltCw = litellm && Number.isFinite(litellm.cacheWrite) && litellm.cacheWrite >= 0 ? litellm.cacheWrite : null;
  if (offCw !== null) {
    if (offCw > MAX_SAFE_USD_PER_M) {
      reasons.push(`提取 cacheWrite 单价超过$${MAX_SAFE_USD_PER_M}/1M安全上限`);
    } else if ((ltCw !== null && !ratesClose(offCw, ltCw)) || (ltCw === null && !officialSelfVerified)) {
      reasons.push('官网含未经 LiteLLM 一致确认的 cacheWrite（或延迟生效条款）');
    }
  } else if (ltCw !== null && ltCw > 0) {
    reasons.push(`LiteLLM 含 cacheWrite($${ltCw}) 但官网未提取到对应报价，需人工复核`);
  }

  const baseIn = baseRatesValid ? roundRate(official.inputPer1M) : NaN;
  const baseOut = baseRatesValid ? roundRate(official.outputPer1M) : NaN;
  const cacheWriteVal = offCw !== null ? roundRate(offCw) : undefined;

  let verifiedContextTiers = null;
  let verifiedPromoSchedule = null;
  const hasTierFlag = Boolean(official?.hasContextTiers);
  const hasPromoFlag = Boolean(official?.promoValidUntil);
  if (hasTierFlag && hasPromoFlag) {
    reasons.push('同时含长上下文阶梯价与限时促销条款，需人工复核');
  } else if (hasTierFlag) {
    const tierRes = evaluateVerifiedContextTier({
      baseInput: baseIn,
      baseOutput: baseOut,
      baseCacheWrite: cacheWriteVal,
      official,
      litellm,
    });
    if (!tierRes.ok) {
      reasons.push(...tierRes.reasons);
    } else {
      verifiedContextTiers = [tierRes.tier];
    }
  } else if (hasPromoFlag) {
    const promoRes = evaluateVerifiedPromoSchedule({
      baseInput: baseIn,
      baseOutput: baseOut,
      baseCacheWrite: cacheWriteVal,
      official,
      nowMs,
    });
    if (!promoRes.ok) {
      reasons.push(...promoRes.reasons);
    } else {
      verifiedPromoSchedule = promoRes.promo;
    }
  }

  if (reasons.length > 0) {
    return { stageable: false, catalogKey, reasons };
  }

  const cachedVal = roundRate(offCached !== null ? offCached : ltCached);
  const rawCtx = official?.contextWindow ?? litellm?.contextWindow ?? openrouter?.contextWindow;
  const contextWindow =
    Number.isSafeInteger(Number(rawCtx)) && Number(rawCtx) >= 4_096 && Number(rawCtx) <= 10_000_000
      ? Number(rawCtx)
      : undefined;
  return {
    stageable: true,
    catalogKey,
    displayName: formatCanonicalModelDisplayName(catalogKey, official.officialModelName),
    vendor,
    url,
    aliases: buildAutoStagedAliases(catalogKey),
    ...(contextWindow ? { contextWindow } : {}),
    proposed: {
      input: baseIn,
      output: baseOut,
      cached: cachedVal,
      ...(cacheWriteVal !== undefined ? { cacheWrite: cacheWriteVal } : {}),
      ...(verifiedContextTiers ? { contextTiers: verifiedContextTiers } : {}),
      ...(verifiedPromoSchedule ? { promoSchedule: verifiedPromoSchedule } : {}),
    },
  };
}

function formatThresholdTag(thresholdTokens) {
  if (!Number.isSafeInteger(thresholdTokens) || thresholdTokens <= 0) return '';
  return thresholdTokens % 1000 === 0 ? `${thresholdTokens / 1000}k` : String(thresholdTokens);
}

export function applyStagedNewModels(catalog, stagedModels, nowMs = Date.now(), options = {}) {
  const { bumpVersion = true, promoteActiveKeys = null } = options;
  if (!Array.isArray(stagedModels) || stagedModels.length === 0) return false;
  const todayDate = new Date(nowMs).toISOString().slice(0, 10);
  catalog.names ??= {};
  catalog.capacities ??= {};
  catalog.prices ??= {};
  catalog.aliases ??= {};
  catalog.feedModels ??= [];

  let changed = false;
  for (const candidate of stagedModels) {
    const key = candidate.catalogKey;
    if (!key || Object.hasOwn(catalog.prices, key)) continue;
    const { platform, platformEn } = inferPlatformLabels(candidate.vendor, candidate.url);
    catalog.names[key] = candidate.displayName;
    if (!Object.hasOwn(catalog.capacities, key)) {
      const candidateCtx = Number(candidate.contextWindow ?? candidate.proposed?.contextWindow);
      catalog.capacities[key] =
        Number.isSafeInteger(candidateCtx) && candidateCtx >= 4_096 && candidateCtx <= 10_000_000
          ? candidateCtx
          : (/^(?:gpt-|o(?:[1-9]|[1-9]\d+)(?:$|[-_]))/i.test(key) ? 128_000 : 200_000);
    }

    const promo = candidate.proposed.promoSchedule;
    const contextTiers = Array.isArray(candidate.proposed.contextTiers) && candidate.proposed.contextTiers.length > 0
      ? candidate.proposed.contextTiers
      : null;

    if (promo) {
      const promoProv = {
        ...(candidate.url ? { sourceUrl: candidate.url } : {}),
        platform,
        platformEn,
        conditions: `推广期标准定价（优惠截至${promo.validUntilDate}）`,
        conditionsEn: `Promotional standard pricing (promotional through ${promo.validUntilDate})`,
        checkedAt: todayDate,
        validFrom: null,
        validUntil: promo.validUntilIso,
        verification: 'confirmed',
      };
      const postProv = {
        ...(candidate.url ? { sourceUrl: candidate.url } : {}),
        platform,
        platformEn,
        conditions: `标准全量定价（${promo.postValidFromDate}生效）`,
        conditionsEn: `Standard list pricing (effective ${promo.postValidFromDate})`,
        checkedAt: todayDate,
        validFrom: promo.postValidFromIso,
        validUntil: null,
        verification: 'confirmed',
      };
      catalog.prices[key] = {
        model: key,
        input: candidate.proposed.input,
        output: candidate.proposed.output,
        cached: candidate.proposed.cached,
        ...(candidate.proposed.cacheWrite !== undefined ? { cacheWrite: candidate.proposed.cacheWrite } : {}),
        provenance: promoProv,
        intervals: [
          {
            model: key,
            validFrom: null,
            validUntil: promo.validUntilIso,
            input: candidate.proposed.input,
            output: candidate.proposed.output,
            cached: candidate.proposed.cached,
            ...(candidate.proposed.cacheWrite !== undefined ? { cacheWrite: candidate.proposed.cacheWrite } : {}),
            provenance: { ...promoProv },
          },
          {
            model: key,
            validFrom: promo.postValidFromIso,
            validUntil: null,
            input: promo.postRates.input,
            output: promo.postRates.output,
            cached: promo.postRates.cached,
            ...(promo.postRates.cacheWrite !== undefined ? { cacheWrite: promo.postRates.cacheWrite } : {}),
            provenance: postProv,
          },
        ],
      };
    } else {
      const tierTag = contextTiers ? formatThresholdTag(contextTiers[0].thresholdTokens) : '';
      catalog.prices[key] = {
        model: key,
        input: candidate.proposed.input,
        output: candidate.proposed.output,
        cached: candidate.proposed.cached,
        ...(candidate.proposed.cacheWrite !== undefined ? { cacheWrite: candidate.proposed.cacheWrite } : {}),
        ...(contextTiers ? { contextTiers } : {}),
        provenance: {
          ...(candidate.url ? { sourceUrl: candidate.url } : {}),
          platform,
          platformEn,
          conditions: tierTag
            ? `标准全量定价（${todayDate}生效；含 >${tierTag} 长上下文阶梯价）`
            : `标准全量定价（${todayDate}生效）`,
          conditionsEn: tierTag
            ? `Standard list pricing (effective ${todayDate}; includes >${tierTag} context tier)`
            : `Standard list pricing (effective ${todayDate})`,
          checkedAt: todayDate,
          validFrom: null,
          validUntil: null,
          verification: 'confirmed',
        },
      };
    }
    for (const [aliasKey, target] of Object.entries(candidate.aliases ?? {})) {
      if (!Object.hasOwn(catalog.aliases, aliasKey)) {
        catalog.aliases[aliasKey] = target;
      }
    }
    if (!catalog.feedModels.includes(key)) {
      catalog.feedModels.push(key);
    }
    if (promoteActiveKeys?.has(key) && Array.isArray(catalog.activeModels) && !catalog.activeModels.includes(key)) {
      catalog.activeModels.push(key);
    }
    changed = true;
  }

  if (changed && bumpVersion) {
    catalog.pricingVersion = bumpCatalogVersion(catalog.pricingVersion, todayDate);
    catalog.pricingUpdatedAt = new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  return changed;
}

/**
 * 以不篡改历史的方式安全增量更新 catalog.prices[key] 与顶层版本元数据。
 */
export function applyVerifiedPriceUpdate(catalog, key, proposed, nowMs = Date.now(), options = {}) {
  const { bumpVersion = true } = options;
  const entry = catalog.prices?.[key];
  if (!entry || Array.isArray(entry)) {
    throw new Error(`无法更新非标准对象条目: ${key}`);
  }

  const todayDate = new Date(nowMs).toISOString().slice(0, 10);
  const todayStartIso = `${todayDate}T00:00:00Z`;
  const yesterdayEndIso = new Date(Date.parse(todayStartIso) - 1000).toISOString().replace('.000Z', 'Z');
  const currentActive = resolveCurrentRate(entry, nowMs);
  const baseProv = currentActive?.provenance ?? entry.provenance ?? {};

  const newProv = {
    ...(baseProv.sourceUrl ? { sourceUrl: baseProv.sourceUrl } : {}),
    ...(baseProv.platform ? { platform: baseProv.platform } : {}),
    ...(baseProv.platformEn ? { platformEn: baseProv.platformEn } : {}),
    conditions: `标准全量定价（${todayDate}生效）`,
    conditionsEn: `Standard list pricing (effective ${todayDate})`,
    checkedAt: todayDate,
    validFrom: todayStartIso,
    validUntil: null,
    verification: 'confirmed',
  };

  const todayStartMs = Date.parse(todayStartIso);
  if (!Array.isArray(entry.intervals) || entry.intervals.length === 0) {
    const baseFromMs = baseProv.validFrom ? Date.parse(baseProv.validFrom) : NaN;
    const isSameDayOrLaterBase =
      Number.isFinite(baseFromMs) && Number.isFinite(todayStartMs) && baseFromMs >= todayStartMs;
    if (isSameDayOrLaterBase) {
      entry.intervals = [
        {
          model: key,
          validFrom: baseProv.validFrom,
          validUntil: null,
          input: proposed.input,
          output: proposed.output,
          cached: proposed.cached,
          ...(proposed.cacheWrite !== undefined ? { cacheWrite: proposed.cacheWrite } : {}),
          ...(Array.isArray(proposed.contextTiers) ? { contextTiers: proposed.contextTiers } : {}),
          provenance: { ...newProv, validFrom: baseProv.validFrom },
        },
      ];
    } else {
      const oldProv = {
        ...baseProv,
        validUntil: yesterdayEndIso,
      };
      entry.intervals = [
        {
          model: key,
          validFrom: baseProv.validFrom ?? null,
          validUntil: yesterdayEndIso,
          input: entry.input,
          output: entry.output,
          cached: entry.cached,
          ...(entry.cacheWrite !== undefined ? { cacheWrite: entry.cacheWrite } : {}),
          ...(Array.isArray(entry.contextTiers) ? { contextTiers: entry.contextTiers } : {}),
          provenance: oldProv,
        },
        {
          model: key,
          validFrom: todayStartIso,
          validUntil: null,
          input: proposed.input,
          output: proposed.output,
          cached: proposed.cached,
          ...(proposed.cacheWrite !== undefined ? { cacheWrite: proposed.cacheWrite } : {}),
          ...(Array.isArray(proposed.contextTiers) ? { contextTiers: proposed.contextTiers } : {}),
          provenance: { ...newProv },
        },
      ];
    }
  } else {
    const activeIdx = entry.intervals.findIndex((iv) => {
      const f = iv?.validFrom ? Date.parse(iv.validFrom) : -Infinity;
      const u = iv?.validUntil ? Date.parse(iv.validUntil) : Infinity;
      return nowMs >= f && nowMs < u;
    });
    const targetIdx = activeIdx >= 0 ? activeIdx : entry.intervals.length - 1;
    const activeIv = entry.intervals[targetIdx];
    const activeFromMs = activeIv?.validFrom ? Date.parse(activeIv.validFrom) : NaN;
    const isSameDayOrLaterActive =
      Number.isFinite(activeFromMs) && Number.isFinite(todayStartMs) && activeFromMs >= todayStartMs;

    if (isSameDayOrLaterActive && !activeIv.validUntil) {
      activeIv.input = proposed.input;
      activeIv.output = proposed.output;
      activeIv.cached = proposed.cached;
      if (proposed.cacheWrite !== undefined) activeIv.cacheWrite = proposed.cacheWrite;
      if (Array.isArray(proposed.contextTiers)) activeIv.contextTiers = proposed.contextTiers;
      activeIv.provenance = { ...newProv, validFrom: activeIv.validFrom };
    } else {
      activeIv.validUntil = yesterdayEndIso;
      activeIv.provenance = { ...(activeIv.provenance ?? baseProv), validUntil: yesterdayEndIso };
      entry.intervals.push({
        model: key,
        validFrom: todayStartIso,
        validUntil: null,
        input: proposed.input,
        output: proposed.output,
        cached: proposed.cached,
        ...(proposed.cacheWrite !== undefined ? { cacheWrite: proposed.cacheWrite } : {}),
        ...(Array.isArray(proposed.contextTiers) ? { contextTiers: proposed.contextTiers } : {}),
        provenance: { ...newProv },
      });
    }
  }

  // 同步顶层当前有效基准字段（供直接读取 DEFAULT_API_PRICES[key] 顶层属性的模块与测试使用）
  entry.input = proposed.input;
  entry.output = proposed.output;
  entry.cached = proposed.cached;
  if (proposed.cacheWrite !== undefined) entry.cacheWrite = proposed.cacheWrite;
  if (Array.isArray(proposed.contextTiers)) entry.contextTiers = proposed.contextTiers;
  entry.provenance = { ...newProv };

  if (bumpVersion) {
    catalog.pricingVersion = bumpCatalogVersion(catalog.pricingVersion, todayDate);
    catalog.pricingUpdatedAt = new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
}

function collectExpiringIntervals(catalog, nowMs = Date.now()) {
  const expiring = [];
  const seen = new Set();
  for (const [key, entry] of Object.entries(catalog.prices ?? {})) {
    const items = Array.isArray(entry) ? entry : [entry, ...(entry.intervals ?? [])];
    for (const item of items) {
      const validUntil = item?.validUntil ?? item?.provenance?.validUntil;
      if (!validUntil) continue;
      const untilMs = Date.parse(validUntil);
      if (!Number.isFinite(untilMs)) continue;
      const hasSuccessor =
        Array.isArray(entry?.intervals) &&
        entry.intervals.some((iv) => {
          const fromMs = iv?.validFrom ? Date.parse(iv.validFrom) : NaN;
          return Number.isFinite(fromMs) && fromMs >= untilMs - 1000 && !iv.validUntil;
        });
      if (!hasSuccessor && untilMs - nowMs <= WARN_HORIZON_MS) {
        const dedupKey = `${key}\0${validUntil}`;
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);
        expiring.push({ key, validUntil });
      }
    }
  }
  return expiring;
}

function formatPriceTuple(rate) {
  if (!rate) return '—';
  const inVal = rate.input ?? rate.inputPer1M;
  const outVal = rate.output ?? rate.outputPer1M;
  const cachedVal = rate.cached ?? rate.cachedPer1M;
  const cwVal = rate.cacheWrite ?? rate.cacheWritePer1M;
  const parts = [`$${inVal} / $${outVal}`];
  if (Number.isFinite(cachedVal)) parts.push(`c:$${cachedVal}`);
  if (Number.isFinite(cwVal) && cwVal > 0) parts.push(`cw:$${cwVal}`);
  return parts.join(' ');
}

export async function runAutoUpdatePricing(options = {}) {
  const writeMode = Boolean(options.write);
  const nowMs = options.nowMs ?? Date.now();
  const catalogPath = options.catalogPath ?? DEFAULT_CATALOG_PATH;
  const feedPath = options.feedPath ?? DEFAULT_FEED_PATH;
  const reportPath = options.reportPath ?? DEFAULT_REPORT_PATH;
  const fetchImpl = options.fetchImpl ?? fetch;
  const geminiApiKey = options.geminiApiKey ?? process.env.GEMINI_API_KEY ?? '';
  const geminiModel = options.geminiModel ?? process.env.GEMINI_MODEL ?? 'gemini-3.8-flash';
  const filterByAntigravityHost = Boolean(options.filterByAntigravityHost);
  const antigravityModelsUrl = options.antigravityModelsUrl ?? ANTIGRAVITY_MODELS_MD_URL;
  const antigravityEnterpriseUrl = options.antigravityEnterpriseUrl ?? ANTIGRAVITY_ENTERPRISE_MD_URL;

  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  const trackedKeys = Object.keys(catalog.prices ?? {}).filter((k) => isTrackedCanonicalModel(k, catalog));

  const probeRows = [];
  const pageAlerts = [];
  let antigravityHost = null;
  if (filterByAntigravityHost) {
    try {
      const [modelsResult, enterpriseResult] = await Promise.allSettled([
        fetchImpl(antigravityModelsUrl, {
          headers: { 'User-Agent': 'GravityBox-PricingWatch/1.2 (+https://github.com/Enzoo404/gravitybox)' },
          signal: AbortSignal.timeout(15_000),
        }),
        fetchImpl(antigravityEnterpriseUrl, {
          headers: { 'User-Agent': 'GravityBox-PricingWatch/1.2 (+https://github.com/Enzoo404/gravitybox)' },
          signal: AbortSignal.timeout(15_000),
        }),
      ]);

      let modelsMd = '';
      let modelsOk = false;
      let modelsStatus = 200;
      if (modelsResult.status === 'rejected') {
        const reason = modelsResult.reason?.message ?? String(modelsResult.reason);
        pageAlerts.push(`[Antigravity Docs] ${reason}: ${antigravityModelsUrl}`);
        probeRows.push(`| Antigravity | \`ERR\` | ${reason.slice(0, 48)} | ${antigravityModelsUrl} |`);
      } else {
        const modelsRes = modelsResult.value;
        modelsStatus = modelsRes.status;
        if (!modelsRes.ok) {
          pageAlerts.push(`[Antigravity Docs] http_${modelsRes.status}: ${antigravityModelsUrl}`);
          probeRows.push(`| Antigravity | \`${modelsRes.status}\` | http_${modelsRes.status} | ${antigravityModelsUrl} |`);
        } else {
          modelsMd = await modelsRes.text();
          modelsOk = true;
        }
      }

      let enterpriseMd = '';
      if (enterpriseResult.status === 'rejected') {
        const reason = enterpriseResult.reason?.message ?? String(enterpriseResult.reason);
        pageAlerts.push(`[Antigravity Enterprise Docs] ${reason}: ${antigravityEnterpriseUrl}`);
        probeRows.push(`| Antigravity Enterprise | \`ERR\` | ${reason.slice(0, 48)} | ${antigravityEnterpriseUrl} |`);
      } else {
        const enterpriseRes = enterpriseResult.value;
        if (!enterpriseRes.ok) {
          pageAlerts.push(`[Antigravity Enterprise Docs] http_${enterpriseRes.status}: ${antigravityEnterpriseUrl}`);
          probeRows.push(`| Antigravity Enterprise | \`${enterpriseRes.status}\` | http_${enterpriseRes.status} | ${antigravityEnterpriseUrl} |`);
        } else {
          enterpriseMd = await enterpriseRes.text();
          probeRows.push(`| Antigravity Enterprise | \`${enterpriseRes.status}\` | Loaded | ${antigravityEnterpriseUrl} |`);
        }
      }

      if (modelsOk) {
        const parsedHost = parseAntigravityHostModels(modelsMd, enterpriseMd);
        if (!parsedHost || parsedHost.models.size === 0) {
          pageAlerts.push(`[Antigravity Docs] host_table_empty: ${antigravityModelsUrl}`);
          probeRows.push(`| Antigravity | \`${modelsStatus}\` | host_table_empty | ${antigravityModelsUrl} |`);
        } else {
          antigravityHost = parsedHost;
          probeRows.push(`| Antigravity | \`${modelsStatus}\` | Host Catalog (${parsedHost.models.size} models) | ${antigravityModelsUrl} |`);
        }
      }
    } catch (err) {
      const reason = err?.message ?? String(err);
      pageAlerts.push(`[Antigravity Docs] ${reason}: ${antigravityModelsUrl}`);
      probeRows.push(`| Antigravity | \`ERR\` | ${reason.slice(0, 48)} | ${antigravityModelsUrl} |`);
    }
  }

  // 1. 收集去重官方 sourceUrl 及对应需要追踪的模型
  const sourceTargets = new Map();
  for (const key of trackedKeys) {
    const current = resolveCurrentRate(catalog.prices[key], nowMs);
    const url = current?.provenance?.sourceUrl ?? catalog.prices[key]?.provenance?.sourceUrl;
    if (typeof url !== 'string' || !url.startsWith('https://')) continue;
    if (!sourceTargets.has(url)) sourceTargets.set(url, []);
    sourceTargets.get(url).push({ key, displayName: catalog.names?.[key] ?? key });
  }

  // 2. 抓取官网定价页 + 调用 Gemini Flash 结构化提取
  const officialByKey = new Map();
  const discoveredOfficialNewModels = [];
  const filteredNonHostModels = [];
  const seenNewModels = new Set();
  const geminiUsage = {
    model: geminiModel,
    calls: 0,
    hasUsage: false,
    promptTokens: 0,
    thoughtsTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
  const knownAliasSet = new Set(
    [
      ...Object.keys(catalog.prices ?? {}).map((k) => normalizeUpstreamModelKey(k)),
      ...Object.keys(catalog.aliases ?? {}).map((k) => normalizeUpstreamModelKey(k)),
      ...Object.values(catalog.names ?? {}).map((v) => normalizeUpstreamModelKey(v)),
      ...Object.values(CATALOG_TO_UPSTREAM_ALIASES).flatMap((arr) =>
        arr.map((alias) => normalizeUpstreamModelKey(alias))
      ),
    ].filter(Boolean)
  );
  for (const existing of [...knownAliasSet]) {
    for (const v of expandCanonicalVariants(existing)) {
      knownAliasSet.add(v);
    }
  }

  for (const [url, targetModels] of sourceTargets.entries()) {
    const rule = VENDOR_CONTENT_ANCHORS.find((r) => r.match.test(url));
    const vendor = rule?.vendor ?? 'Upstream';
    try {
      let fetchUrl = url;
      let res = await fetchImpl(fetchUrl, {
        method: 'GET',
        redirect: 'follow',
        headers: {
          'User-Agent': 'GravityBox-PricingWatch/1.2 (+https://github.com/Enzoo404/gravitybox)',
          Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        },
        signal: AbortSignal.timeout(20_000),
      });
      let html = res.ok ? await res.text() : '';
      let cleanText = res.ok ? extractCleanPricingText(html) : '';
      let blockReason = res.ok ? detectBlockedOrEmptyPage(html, cleanText, rule) : `http_${res.status}`;

      if (blockReason === 'empty_or_csr_shell' || blockReason === 'anchor_missing') {
        const mdUrl = buildMarkdownFallbackUrl(res.url || url);
        if (mdUrl) {
          try {
            const mdRes = await fetchImpl(mdUrl, {
              method: 'GET',
              redirect: 'follow',
              headers: {
                'User-Agent': 'GravityBox-PricingWatch/1.2 (+https://github.com/Enzoo404/gravitybox)',
                Accept: 'text/markdown,text/plain;q=0.9,*/*;q=0.8',
              },
              signal: AbortSignal.timeout(20_000),
            });
            if (mdRes.ok) {
              const mdText = await mdRes.text();
              const mdCleanText = extractCleanPricingText(mdText);
              const mdBlockReason = detectBlockedOrEmptyPage(mdText, mdCleanText, rule);
              if (!mdBlockReason) {
                fetchUrl = mdUrl;
                res = mdRes;
                html = mdText;
                cleanText = mdCleanText;
                blockReason = null;
              }
            }
          } catch {
            // Markdown 回退失败时保留原始 blockReason 告警，不掩盖上游页面状态
          }
        }
      }

      if (blockReason) {
        pageAlerts.push(`[${vendor}] ${blockReason}: ${fetchUrl}`);
        probeRows.push(`| ${vendor} | \`${res.status}\` | ${blockReason} | ${fetchUrl} |`);
        continue;
      }

      if (!geminiApiKey) {
        probeRows.push(`| ${vendor} | \`${res.status}\` | Anchored (No Gemini Key) | ${fetchUrl} |`);
        continue;
      }

      const extracted = await extractPricesWithGemini({
        url: fetchUrl,
        vendor,
        cleanText,
        targetModels,
        apiKey: geminiApiKey,
        model: geminiModel,
        fetchImpl,
      });
      geminiUsage.calls++;
      if (extracted.__usageMetadata) {
        geminiUsage.hasUsage = true;
        geminiUsage.promptTokens += extracted.__usageMetadata.promptTokenCount;
        geminiUsage.thoughtsTokens += extracted.__usageMetadata.thoughtsTokenCount;
        geminiUsage.outputTokens += extracted.__usageMetadata.candidatesTokenCount;
        geminiUsage.totalTokens += extracted.__usageMetadata.totalTokenCount;
      }

      if (!extracted.pageParsedOk) {
        pageAlerts.push(`[${vendor}] gemini_parse_unconfirmed: ${fetchUrl}`);
        probeRows.push(`| ${vendor} | \`${res.status}\` | Parse Low Confidence | ${fetchUrl} |`);
        continue;
      }

      probeRows.push(`| ${vendor} | \`${res.status}\` | Parsed (${extracted.models.length} models) | ${fetchUrl} |`);

      for (const item of extracted.models) {
        const enrichedItem = {
          ...item,
          evidenceVerified: verifyOfficialEvidence(cleanText, item),
          ...(item.hasContextTiers ? { tierEvidenceVerified: verifyOfficialTierEvidence(cleanText, item) } : {}),
          ...(item.promoValidUntil ? { promoEvidenceVerified: verifyOfficialPromoEvidence(cleanText, item) } : {}),
        };
        const normName = normalizeUpstreamModelKey(enrichedItem.officialModelName);
        const normVariants = new Set(expandCanonicalVariants(normName));
        const matchedKey =
          (enrichedItem.catalogKey && catalog.prices?.[enrichedItem.catalogKey] ? enrichedItem.catalogKey : null) ??
          targetModels.find((m) => {
            const candidateKeys = [m.key, m.displayName, ...(CATALOG_TO_UPSTREAM_ALIASES[m.key] ?? [])];
            return candidateKeys.some((cand) => {
              const candNorm = normalizeUpstreamModelKey(cand);
              return Boolean(candNorm) && normVariants.has(candNorm);
            });
          })?.key ??
          null;

        if (matchedKey) {
          if (!officialByKey.has(matchedKey) || enrichedItem.catalogKey === matchedKey) {
            officialByKey.set(matchedKey, enrichedItem);
          }
        } else if (
          normName &&
          MODERN_RADAR_MODEL_RE.test(normName) &&
          !IGNORED_RADAR_SUFFIX_RE.test(normName) &&
          ![...normVariants].some((v) => knownAliasSet.has(v)) &&
          !seenNewModels.has(normName)
        ) {
          seenNewModels.add(normName);
          if (filterByAntigravityHost) {
            if (!antigravityHost) {
              continue;
            }
            const inHost = [...normVariants].some((v) => antigravityHost.keys.has(v));
            if (!inHost) {
              filteredNonHostModels.push(normName);
              continue;
            }
          }
          discoveredOfficialNewModels.push({ vendor, url, item: enrichedItem });
        }
      }
    } catch (err) {
      const reason = err?.message ?? String(err);
      pageAlerts.push(`[${vendor}] ${reason}: ${url}`);
      probeRows.push(`| ${vendor} | \`ERR\` | ${reason.slice(0, 48)} | ${url} |`);
    }
  }

  // 3. 拉取 LiteLLM 与 OpenRouter 结构化价格表
  let litellmMap = new Map();
  try {
    const res = await fetchImpl(LITELLM_URL, { signal: AbortSignal.timeout(12_000) });
    if (res.ok) litellmMap = parseLiteLlmRates(await res.json());
    else pageAlerts.push(`[LiteLLM] http_${res.status}: ${LITELLM_URL}`);
  } catch (err) {
    pageAlerts.push(`[LiteLLM] unreachable: ${err?.message ?? err}`);
  }

  let openrouterMap = new Map();
  try {
    const res = await fetchImpl(OPENROUTER_URL, { signal: AbortSignal.timeout(12_000) });
    if (res.ok) openrouterMap = parseOpenRouterRates(await res.json());
    else pageAlerts.push(`[OpenRouter] http_${res.status}: ${OPENROUTER_URL}`);
  } catch (err) {
    pageAlerts.push(`[OpenRouter] unreachable: ${err?.message ?? err}`);
  }

  // 4. 共识门禁逐一评估
  const greenUpdates = [];
  const yellowItems = [];
  for (const key of trackedKeys) {
    const evaluation = evaluateModelConsensus({
      key,
      localEntry: catalog.prices[key],
      official: officialByKey.get(key) ?? null,
      litellm: lookupUpstreamForCatalogKey(key, litellmMap),
      openrouter: lookupUpstreamForCatalogKey(key, openrouterMap),
      nowMs,
    });
    if (evaluation.status === 'green') greenUpdates.push(evaluation);
    else if (evaluation.status === 'yellow') yellowItems.push(evaluation);
  }

  // 新模型雷达（启用宿主白名单过滤时仅追踪 Antigravity 官方文档已接入的现代模型，忽略纯外部模型）
  const newModelsRadar = [];
  const stagedNewModels = [];
  for (const entry of discoveredOfficialNewModels) {
    const id = normalizeUpstreamModelKey(entry.item.officialModelName);
    const litellm = lookupUpstreamByNormalizedId(id, litellmMap);
    const openrouter = lookupUpstreamByNormalizedId(id, openrouterMap);
    const staging = evaluateNewModelStagingCandidate({
      id,
      vendor: entry.vendor,
      url: entry.url,
      official: entry.item,
      litellm,
      openrouter,
      nowMs,
    });
    if (staging.stageable) {
      stagedNewModels.push(staging);
    }
    if (filterByAntigravityHost && staging.stageable) {
      continue;
    }
    newModelsRadar.push({
      model: id,
      vendor: entry.vendor,
      url: entry.url,
      official: entry.item,
      litellm,
      openrouter,
      consensusReady: staging.stageable,
      stagedCatalogKey: staging.catalogKey,
      note: staging.stageable
        ? `双源共识通过：已自动预入库 \`${staging.catalogKey}\`（含衍生别名）供 PR 审阅合入；请确认是否纳入 activeModels`
        : `官网发现未入库现代模型（${staging.reasons.join('；')}）`,
    });
  }

  // Antigravity 消费级宿主模型反向对账：若官网 models.md 已上线但厂商定价页未提取到，主动推送黄灯告警
  if (filterByAntigravityHost && antigravityHost) {
    const discoveredKeySet = new Set();
    for (const entry of discoveredOfficialNewModels) {
      const norm = normalizeUpstreamModelKey(entry.item.officialModelName);
      if (!norm) continue;
      const canonical = canonicalCatalogKeyForNewModel(norm);
      for (const variant of [norm, canonical, ...expandCanonicalVariants(norm), ...expandCanonicalVariants(canonical)]) {
        if (variant) discoveredKeySet.add(variant);
      }
    }
    for (const hostInfo of antigravityHost.models.values()) {
      if (hostInfo.consumerActive !== true) continue;
      const hostVariants = [hostInfo.key, ...expandCanonicalVariants(hostInfo.key)];
      const alreadyTracked = hostVariants.some((v) => knownAliasSet.has(v));
      const alreadyDiscovered = hostVariants.some((v) => discoveredKeySet.has(v));
      if (!alreadyTracked && !alreadyDiscovered) {
        newModelsRadar.push({
          model: hostInfo.key,
          vendor: 'Antigravity',
          url: antigravityModelsUrl,
          official: null,
          litellm: lookupUpstreamByNormalizedId(hostInfo.key, litellmMap),
          openrouter: lookupUpstreamByNormalizedId(hostInfo.key, openrouterMap),
          consensusReady: false,
          stagedCatalogKey: hostInfo.key,
          note: `Antigravity 官网 models.md 已上线消费级模型 ${hostInfo.displayName}，但厂商定价页未提取到对应报价，需人工补充定价`,
        });
      }
    }
  }

  const expiring = collectExpiringIntervals(catalog, nowMs);

  // 5. 执行增量写入
  let filesModified = false;
  if (writeMode && (greenUpdates.length > 0 || stagedNewModels.length > 0)) {
    const todayDate = new Date(nowMs).toISOString().slice(0, 10);
    for (const item of greenUpdates) {
      applyVerifiedPriceUpdate(catalog, item.key, item.proposed, nowMs, { bumpVersion: false });
    }
    if (stagedNewModels.length > 0) {
      applyStagedNewModels(catalog, stagedNewModels, nowMs, {
        bumpVersion: false,
        promoteActiveKeys: filterByAntigravityHost && antigravityHost ? antigravityHost.consumerKeys : null,
      });
    }
    catalog.pricingVersion = bumpCatalogVersion(catalog.pricingVersion, todayDate);
    catalog.pricingUpdatedAt = new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
    await writeFile(catalogPath, JSON.stringify(catalog, null, 2) + '\n', 'utf8');
    const feed = buildPricingFeed(catalog);
    await writeFile(feedPath, JSON.stringify(feed, null, 2) + '\n', 'utf8');
    filesModified = true;
  }

  // 6. 决策分流：no_change / green_auto_merge / yellow_needs_review / fetch_failed
  let decision = 'no_change';
  const unapprovedNewModels = filterByAntigravityHost ? newModelsRadar.length > 0 : (newModelsRadar.length > 0 || stagedNewModels.length > 0);
  if (yellowItems.length > 0 || expiring.length > 0 || unapprovedNewModels) {
    decision = 'yellow_needs_review';
  } else if (greenUpdates.length > 0 || (filterByAntigravityHost && stagedNewModels.length > 0)) {
    decision = 'green_auto_merge';
  } else if (pageAlerts.length > 0) {
    decision = 'fetch_failed';
  }

  const reviewRows = [...yellowItems, ...newModelsRadar.map((n) => ({ ...n, key: n.model, local: null, reasons: [n.note] }))].map(
    (item) => {
      const quote = item.official?.evidenceQuote ? ` (${String(item.official.evidenceQuote).replace(/\|/g, '/').slice(0, 80)})` : '';
      return `| \`${item.key}\` | ${formatPriceTuple(item.local)} | ${formatPriceTuple(item.official)}${quote} | ${formatPriceTuple(item.litellm)} | ${formatPriceTuple(item.openrouter)} |`;
    }
  );

  const geminiTokenSummary = geminiUsage.hasUsage
    ? `, calls: ${geminiUsage.calls}, tokens: in=${geminiUsage.promptTokens.toLocaleString('en-US')} thoughts=${geminiUsage.thoughtsTokens.toLocaleString('en-US')} out=${geminiUsage.outputTokens.toLocaleString('en-US')} total=${geminiUsage.totalTokens.toLocaleString('en-US')}`
    : `, calls: ${geminiUsage.calls}`;

  const summaryLines = [
    '### Pricing Watch Auto-Audit Summary',
    '',
    `- **Decision**: \`${decision}\``,
    `- **Gemini Flash Extraction**: ${geminiApiKey ? `enabled (\`${geminiUsage.model}\`${geminiTokenSummary})` : 'skipped (GEMINI_API_KEY not set)'}`,
    `- **Verified Consensus Updates (Green)**: ${greenUpdates.length}`,
    `- **Auto-Staged Host Models**: ${stagedNewModels.length}`,
    ...(filterByAntigravityHost ? [`- **Ignored Non-Antigravity Models**: ${filteredNonHostModels.length}`] : []),
    `- **Needs Review / Divergence / New Models (Yellow)**: ${yellowItems.length + newModelsRadar.length}`,
    `- **Expiring Promotional Intervals (<=14d)**: ${expiring.length}`,
    '',
    '| Vendor | HTTP | Status | Source URL |',
    '| :--- | :--- | :--- | :--- |',
    ...probeRows,
    '',
    ...(greenUpdates.length > 0
      ? [
          '#### Verified Consensus Updates Applied',
          '',
          '| Model | Old Rate | New Rate (Verified) | Evidence |',
          '| :--- | :--- | :--- | :--- |',
          ...greenUpdates.map(
            (g) =>
              `| \`${g.key}\` | ${formatPriceTuple(g.local)} | ${formatPriceTuple(g.proposed)} | ${String(g.official?.evidenceQuote ?? '').replace(/\|/g, '/').slice(0, 100)} |`
          ),
          '',
        ]
      : []),
    ...(stagedNewModels.length > 0
      ? [
          '#### Auto-Staged New Model Candidates (PR Ready for Review)',
          '',
          '| Catalog Key | Display Name | Staged Rate | Derived Aliases |',
          '| :--- | :--- | :--- | :--- |',
          ...stagedNewModels.map((s) => {
            const extraTag = s.proposed.contextTiers?.[0]
              ? ` (+>${formatThresholdTag(s.proposed.contextTiers[0].thresholdTokens)})`
              : s.proposed.promoSchedule
                ? ` (+promo<=${s.proposed.promoSchedule.validUntilDate})`
                : '';
            return `| \`${s.catalogKey}\` | ${s.displayName} | ${formatPriceTuple(s.proposed)}${extraTag} | ${Object.keys(s.aliases).length} |`;
          }),
          '',
        ]
      : []),
    ...(reviewRows.length > 0
      ? [
          '#### Needs-Review Comparison (4-Source Matrix)',
          '',
          '| Model | Local | Official (+Quote) | LiteLLM | OpenRouter |',
          '| :--- | :--- | :--- | :--- | :--- |',
          ...reviewRows,
          '',
          ...yellowItems.map((y) => `- **\`${y.key}\`**: ${y.reasons.join('；')}`),
          ...newModelsRadar.map((n) => `- **\`${n.model}\`** (新模型): ${n.note}`),
          '',
        ]
      : []),
    ...(expiring.length > 0
      ? [
          '#### Expiring Promotional Intervals',
          '',
          ...expiring.map((e) => `- \`${e.key}\`: validUntil \`${e.validUntil}\``),
          '',
        ]
      : []),
    ...(pageAlerts.length > 0
      ? [
          '#### Upstream Fetch Alerts',
          '',
          ...pageAlerts.map((a) => `- ${a}`),
          '',
        ]
      : []),
  ];

  const report = {
    decision,
    filesModified,
    geminiEnabled: Boolean(geminiApiKey),
    filterByAntigravityHost,
    filteredNonHostModels,
    greenUpdates,
    stagedNewModels,
    yellowItems,
    newModelsRadar,
    expiring,
    pageAlerts,
    summaryMarkdown: summaryLines.join('\n'),
  };

  if (reportPath) {
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  }
  return report;
}

async function main() {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const filterByAntigravityHost = !args.includes('--no-host-filter');
  const report = await runAutoUpdatePricing({ write, filterByAntigravityHost });
  console.log(report.summaryMarkdown);
  if (process.env.GITHUB_OUTPUT) {
    const { appendFile } = await import('node:fs/promises');
    const lines = [
      `decision=${report.decision}`,
      `files_modified=${report.filesModified ? 'true' : 'false'}`,
      `has_alert=${report.decision === 'yellow_needs_review' || report.decision === 'fetch_failed' ? 'true' : 'false'}`,
      `green_count=${report.greenUpdates.length}`,
      `staged_new_count=${report.stagedNewModels.length}`,
      `yellow_count=${report.yellowItems.length + report.newModelsRadar.length}`,
    ];
    await appendFile(process.env.GITHUB_OUTPUT, lines.join('\n') + '\n', 'utf8');
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFile } = await import('node:fs/promises');
    await appendFile(process.env.GITHUB_STEP_SUMMARY, report.summaryMarkdown + '\n', 'utf8');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err?.stack ?? err?.message ?? String(err));
    process.exitCode = 1;
  });
}
