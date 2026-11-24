import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type LocaleMeta = {
  code: string;
  nativeName: string;
  fallback: string;
  hasTargetDictionary: boolean;
};

export type LocalePack = {
  meta: LocaleMeta;
  app: Record<string, string>;
  backend: Record<string, string>;
  hud: Record<string, string>;
};

export type I18nNamespace = 'app' | 'backend' | 'hud';

const DEFAULT_FALLBACK_LOCALE = 'en';
const DEFAULT_LEGACY_LOCALE = 'zh-Hans';

function resolveI18nDirectory(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '../assets/i18n'),
    join(here, '../../assets/i18n'),
    join(here, '../../i18n'),
    join(process.cwd(), 'assets/i18n'),
  ];
  for (const dir of candidates) {
    try {
      const files = readdirSync(dir);
      if (files.some((f) => f.endsWith('.json'))) {
        return dir;
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

/** 从磁盘目录加载所有受支持语言包，按 meta.code 注册。 */
export function loadLocalePacks(directory = resolveI18nDirectory()): Map<string, LocalePack> {
  const packs = new Map<string, LocalePack>();
  if (!directory) return packs;
  const files = readdirSync(directory).filter((name) => name.endsWith('.json')).sort();
  for (const file of files) {
    try {
      const parsed = JSON.parse(readFileSync(join(directory, file), 'utf8')) as Partial<LocalePack>;
      const code = typeof parsed?.meta?.code === 'string' ? parsed.meta.code.trim() : '';
      if (!code) continue;
      packs.set(code, {
        meta: {
          code,
          nativeName: typeof parsed.meta?.nativeName === 'string' && parsed.meta.nativeName ? parsed.meta.nativeName : code,
          fallback: typeof parsed.meta?.fallback === 'string' && parsed.meta.fallback ? parsed.meta.fallback : DEFAULT_FALLBACK_LOCALE,
          hasTargetDictionary: parsed.meta?.hasTargetDictionary === true,
        },
        app: parsed.app && typeof parsed.app === 'object' ? { ...parsed.app } : {},
        backend: parsed.backend && typeof parsed.backend === 'object' ? { ...parsed.backend } : {},
        hud: parsed.hud && typeof parsed.hud === 'object' ? { ...parsed.hud } : {},
      });
    } catch {
      // 忽略损坏的单个语言包文件，避免阻塞服务启动
    }
  }
  return packs;
}

const builtinPacks = loadLocalePacks();
let activeLocale = DEFAULT_LEGACY_LOCALE;

export function listSupportedLocales(packs: Map<string, LocalePack> = builtinPacks): LocaleMeta[] {
  return [...packs.values()].map((pack) => pack.meta);
}

/**
 * 将任意系统/用户输入语言标签规范化为已注册的语言 code。
 * 支持常见区域别名（zh-CN -> zh-Hans, zh-TW/HK -> zh-Hant 或回退 zh-Hans, en-US -> en, ja-JP -> ja 等）。
 */
export function normalizeLocale(
  input: unknown,
  packs: Map<string, LocalePack> = builtinPacks
): string | null {
  if (typeof input !== 'string') return null;
  const raw = input.trim().replace(/_/g, '-');
  if (!raw || raw.toLowerCase() === 'system') return null;

  if (packs.has(raw)) return raw;
  const lower = raw.toLowerCase();
  for (const code of packs.keys()) {
    if (code.toLowerCase() === lower) return code;
  }

  // 中文变体匹配
  if (lower.startsWith('zh')) {
    if (/\b(hant|tw|hk|mo)\b/.test(lower)) {
      if (packs.has('zh-Hant')) return 'zh-Hant';
    }
    if (packs.has('zh-Hans')) return 'zh-Hans';
  }

  // 主语言子tag精确前缀匹配（如 en-US -> en, ja-JP -> ja, fr-FR -> fr）
  const primary = lower.split('-')[0];
  if (primary) {
    for (const code of packs.keys()) {
      if (code.toLowerCase() === primary) return code;
    }
    for (const code of packs.keys()) {
      if (code.toLowerCase().startsWith(`${primary}-`)) return code;
    }
  }
  return null;
}

/** 解析 macOS `defaults read -g AppleLanguages` 的 OpenStep 数组文本。 */
export function parseAppleLanguagesOutput(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('(') || !trimmed.endsWith(')')) return [];
  const body = trimmed.slice(1, -1);
  const locales: string[] = [];
  for (const match of body.matchAll(/"([^"]+)"|([A-Za-z0-9_-]+)/g)) {
    const token = (match[1] ?? match[2] ?? '').trim();
    if (token) locales.push(token);
  }
  return locales;
}

/** 读取当前系统首选语言列表并解析有效语言包 code。 */
export function detectSystemLocales(): string[] {
  const candidates: string[] = [];
  const pushUnique = (value: string) => {
    const trimmed = value.trim();
    if (trimmed && !candidates.includes(trimmed)) candidates.push(trimmed);
  };

  const envOverride = process.env.GRAVITYBOX_SYSTEM_LOCALES;
  if (typeof envOverride === 'string' && envOverride.trim()) {
    for (const part of envOverride.split(',')) {
      pushUnique(part);
    }
  }

  if (process.platform === 'darwin') {
    try {
      const output = execFileSync('/usr/bin/defaults', ['read', '-g', 'AppleLanguages'], {
        encoding: 'utf8',
        timeout: 1500,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      for (const locale of parseAppleLanguagesOutput(output)) {
        pushUnique(locale);
      }
    } catch {
      // ignore defaults read failure and fall back to POSIX / Intl
    }
  }

  if (process.platform === 'win32') {
    try {
      const intlLocale = Intl.DateTimeFormat().resolvedOptions().locale;
      if (intlLocale) pushUnique(intlLocale);
    } catch {
      // ignore
    }
  }

  const envLang = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG;
  if (envLang) {
    const clean = envLang.split('.')[0];
    if (clean && clean !== 'C' && clean !== 'POSIX') pushUnique(clean);
  }
  try {
    const intlLocale = Intl.DateTimeFormat().resolvedOptions().locale;
    if (intlLocale) pushUnique(intlLocale);
  } catch {
    // ignore
  }
  return candidates;
}

export function resolveLocale(
  configured: unknown,
  systemLocales?: string[],
  packs: Map<string, LocalePack> = builtinPacks
): string {
  if (typeof configured === 'string' && configured.trim().toLowerCase() !== 'system') {
    const exact = normalizeLocale(configured, packs);
    if (exact) return exact;
  }
  const resolvedSystemLocales = systemLocales ?? detectSystemLocales();
  for (const candidate of resolvedSystemLocales) {
    const matched = normalizeLocale(candidate, packs);
    if (matched) return matched;
  }
  if (packs.has(DEFAULT_FALLBACK_LOCALE)) return DEFAULT_FALLBACK_LOCALE;
  if (packs.has(DEFAULT_LEGACY_LOCALE)) return DEFAULT_LEGACY_LOCALE;
  return packs.keys().next().value ?? DEFAULT_FALLBACK_LOCALE;
}

/**
 * 解析初次启动/迁移时的全局语言：
 * - 显式配置有效 -> 使用之（system 按系统语言解析）
 * - 无显式配置但存在旧版 translationEnabled -> false 迁为 en，true 迁为 zh-Hans
 * - 全新安装 -> 按 system 解析系统语言
 */
export function resolveInitialRuntimeLanguage(options: {
  configuredLanguage?: unknown;
  legacyTranslationEnabled?: unknown;
  systemLocales?: string[];
  packs?: Map<string, LocalePack>;
}): { configuredLanguage: string; resolvedLocale: string } {
  const packs = options.packs ?? builtinPacks;

  if (typeof options.configuredLanguage === 'string' && options.configuredLanguage.trim()) {
    const raw = options.configuredLanguage.trim();
    if (raw.toLowerCase() === 'system') {
      const sys = options.systemLocales ?? detectSystemLocales();
      return { configuredLanguage: 'system', resolvedLocale: resolveLocale('system', sys, packs) };
    }
    const normalized = normalizeLocale(raw, packs);
    if (normalized) {
      return { configuredLanguage: normalized, resolvedLocale: normalized };
    }
  }

  if (options.legacyTranslationEnabled === false) {
    const enLocale = normalizeLocale('en', packs) ?? DEFAULT_FALLBACK_LOCALE;
    return { configuredLanguage: enLocale, resolvedLocale: enLocale };
  }
  if (options.legacyTranslationEnabled === true) {
    const zhLocale = normalizeLocale('zh-Hans', packs) ?? DEFAULT_LEGACY_LOCALE;
    return { configuredLanguage: zhLocale, resolvedLocale: zhLocale };
  }

  const sys = options.systemLocales ?? detectSystemLocales();
  return {
    configuredLanguage: 'system',
    resolvedLocale: resolveLocale('system', sys, packs),
  };
}

export function getActiveLocale(): string {
  return activeLocale;
}

export function setActiveLocale(input: unknown, systemLocales?: string[]): string {
  activeLocale = resolveLocale(input, systemLocales);
  return activeLocale;
}

/** 按回退链读取本地化文本并执行 {param} 插值。 */
export function translate(
  locale: string | undefined,
  key: string,
  params?: Record<string, string | number | boolean | null | undefined>,
  options: {
    namespace?: I18nNamespace;
    fallback?: string;
    packs?: Map<string, LocalePack>;
  } = {}
): string {
  const packs = options.packs ?? builtinPacks;
  const ns: I18nNamespace = options.namespace ?? 'backend';
  const visited = new Set<string>();
  let cursor: string | undefined = resolveLocale(locale ?? activeLocale, undefined, packs);
  let template: string | undefined;

  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    const pack = packs.get(cursor);
    if (pack && typeof pack[ns]?.[key] === 'string') {
      template = pack[ns][key];
      break;
    }
    const nextFallback: string | undefined = pack?.meta?.fallback;
    cursor = nextFallback && nextFallback !== cursor ? nextFallback : undefined;
  }

  if (template === undefined && packs.has(DEFAULT_FALLBACK_LOCALE)) {
    template = packs.get(DEFAULT_FALLBACK_LOCALE)?.[ns]?.[key];
  }
  if (template === undefined) {
    template = options.fallback ?? key;
  }
  if (!params) return template;

  return template.replace(/\{([a-zA-Z0-9_.-]+)\}/g, (match, name) => {
    if (!Object.prototype.hasOwnProperty.call(params, name)) return match;
    const val = params[name];
    return val === null || val === undefined ? '' : String(val);
  });
}

/** 使用当前激活语言查询 backend 命名空间文案的便捷方法。 */
export function bt(
  key: string,
  params?: Record<string, string | number | boolean | null | undefined>,
  fallback?: string
): string {
  return translate(getActiveLocale(), key, params, { namespace: 'backend', fallback });
}
