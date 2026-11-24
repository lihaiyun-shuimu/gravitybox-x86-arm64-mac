import ts from 'typescript';
import { foldDictionaryKey, normalizeText } from '../dist/bundle.js';

const CONTAINER_TAGS = new Set(['span', 'p', 'div', 'li', 'label', 'h1', 'h2', 'h3', 'h4']);
const INLINE_TAGS = new Set(['code', 'strong', 'em', 'a', 'kbd', 'b', 'i', 'span', 'mark', 'small', 'svg']);
const BLOCK_TAGS = new Set(['div', 'p', 'ul', 'ol', 'li', 'table', 'form', 'section', 'article']);
const JSX_RUNTIME_CALLEES = new Set(['jsx', 'jsxs', 'jsxDEV', '_jsx', '_jsxs']);
const MAX_EXPANSION_VARIANTS = 8;

function resolveCalleeName(expr) {
  if (!expr) return '';
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  if (ts.isParenthesizedExpression(expr)) return resolveCalleeName(expr.expression);
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.CommaToken) {
    return resolveCalleeName(expr.right);
  }
  return '';
}

function getElementCallParts(node) {
  if (!ts.isCallExpression(node)) return null;
  const callee = ts.isPropertyAccessExpression(node.expression)
    ? node.expression.name.text
    : resolveCalleeName(node.expression);
  if (callee === 'createElement') {
    const tagArg = node.arguments[0];
    const isFrag = tagArg && ((ts.isPropertyAccessExpression(tagArg) && tagArg.name.text === 'Fragment')
      || (ts.isIdentifier(tagArg) && tagArg.text === 'Fragment'));
    const tag = tagArg && ts.isStringLiteral(tagArg) ? tagArg.text.toLowerCase() : '';
    return { kind: isFrag ? 'fragment' : 'element', tag, childrenNodes: node.arguments.slice(2) };
  }
  if (JSX_RUNTIME_CALLEES.has(callee)) {
    const tagArg = node.arguments[0];
    const isFrag = tagArg && ((ts.isPropertyAccessExpression(tagArg) && tagArg.name.text === 'Fragment')
      || (ts.isIdentifier(tagArg) && tagArg.text === 'Fragment'));
    const tag = tagArg && ts.isStringLiteral(tagArg) ? tagArg.text.toLowerCase() : '';
    const propsArg = node.arguments[1];
    let childrenNodes = [];
    if (propsArg && ts.isObjectLiteralExpression(propsArg)) {
      for (const prop of propsArg.properties) {
        if (ts.isPropertyAssignment(prop)) {
          const pName = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : '';
          if (pName === 'children') {
            childrenNodes = ts.isArrayLiteralExpression(prop.initializer)
              ? [...prop.initializer.elements]
              : [prop.initializer];
            break;
          }
        }
      }
    }
    return { kind: isFrag ? 'fragment' : 'element', tag, childrenNodes };
  }
  return null;
}

function containsBlockTag(node) {
  let found = false;
  const visit = cur => {
    if (found || !cur) return;
    const parts = getElementCallParts(cur);
    if (parts && parts.kind === 'element' && BLOCK_TAGS.has(parts.tag)) {
      found = true;
      return;
    }
    ts.forEachChild(cur, visit);
  };
  visit(node);
  return found;
}

function collectStaticInlineText(nodes) {
  const texts = [];
  for (const ch of nodes) {
    if (ts.isStringLiteral(ch) || ts.isNoSubstitutionTemplateLiteral(ch)) texts.push(ch.text);
  }
  return texts.join('');
}

function expandChild(node) {
  if (!node) return [[]];
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return [[{ type: 'text', val: node.text }]];
  }
  if (ts.isParenthesizedExpression(node)) return expandChild(node.expression);
  if (ts.isConditionalExpression(node)) {
    return [...expandChild(node.whenTrue), ...expandChild(node.whenFalse)].slice(0, MAX_EXPANSION_VARIANTS);
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    return expandChild(node.right);
  }
  if (ts.isArrayLiteralExpression(node)) {
    return expandChildrenSequence(node.elements);
  }
  const parts = getElementCallParts(node);
  if (parts) {
    if (parts.kind === 'fragment') {
      return expandChildrenSequence(parts.childrenNodes);
    }
    if (BLOCK_TAGS.has(parts.tag)) return [[{ type: 'block' }]];
    if (INLINE_TAGS.has(parts.tag)) {
      if (parts.childrenNodes.some(containsBlockTag)) return [[{ type: 'block' }]];
      return [[{ type: 'inline', tag: parts.tag, txt: collectStaticInlineText(parts.childrenNodes) }]];
    }
    return [[{ type: 'other' }]];
  }
  return [[{ type: 'expr' }]];
}

function expandChildrenSequence(childrenNodes) {
  let acc = [[]];
  for (const ch of childrenNodes) {
    const sub = expandChild(ch);
    const next = [];
    for (const prefix of acc) {
      for (const suffix of sub) {
        if (next.length < MAX_EXPANSION_VARIANTS) next.push([...prefix, ...suffix]);
      }
    }
    acc = next;
  }
  return acc;
}

/**
 * Extracts static JSX inline-group templates (e.g. `<span>Main text <a ...>Learn more</a>.</span>`)
 * matching the runtime `isInlineGroupContainer` + `groupTemplate` rules.
 * Never executes source; uses TypeScript AST parsing only.
 */
export function extractInlineGroupsAst(source) {
  const file = ts.createSourceFile('official-ui.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (file.parseDiagnostics.length) throw new Error('界面包未通过 AST 语法解析，无法提取内联组');
  const found = new Map();
  const walk = node => {
    const parts = getElementCallParts(node);
    if (parts && parts.kind === 'element' && CONTAINER_TAGS.has(parts.tag) && parts.childrenNodes.length >= 2) {
      for (const seq of expandChildrenSequence(parts.childrenNodes)) {
        if (seq.some(x => x.type === 'block' || x.type === 'other' || x.type === 'expr')) continue;
        const hasText = seq.some(x => x.type === 'text' && /[A-Za-z]{2,}/.test(x.val));
        const inlines = seq.filter(x => x.type === 'inline');
        if (!hasText || !inlines.length) continue;
        if (inlines.every(x => x.tag === 'svg')) {
          const firstInline = seq.findIndex(x => x.type === 'inline');
          const hasBefore = seq.slice(0, firstInline).some(x => x.type === 'text' && normalizeText(x.val));
          const hasAfter = seq.slice(firstInline + 1).some(x => x.type === 'text' && normalizeText(x.val));
          if (!(hasBefore && hasAfter)) continue;
        }
        let idx = 0;
        let tpl = '';
        const inlineTags = [];
        for (const item of seq) {
          if (item.type === 'text') tpl += item.val;
          else {
            tpl += `{${idx++}}`;
            inlineTags.push(`${item.tag}(${item.txt})`);
          }
        }
        const norm = normalizeText(tpl);
        if (norm.length < 4 || norm.length > 400 || !/[A-Za-z]{2,}/.test(norm)) continue;
        if (/(?:https?:\/\/|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,})/.test(norm)) continue;
        const existing = found.get(norm);
        if (existing) {
          existing.count += 1;
        } else {
          found.set(norm, { text: norm, tag: parts.tag, count: 1, inlineTags });
        }
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(file);
  return [...found.values()].sort((a, b) => a.text.localeCompare(b.text));
}

function placeholderTokens(text) {
  return String(text ?? '').match(/\{\d+\}/g) ?? [];
}

/**
 * Validates that a `{0}` dictionary entry keeps the exact placeholder set/order
 * and never introduces non-empty text into a slot that was empty in the English key.
 */
export function validateInlineSlotLayout(key, value) {
  const kTokens = placeholderTokens(key);
  if (kTokens.length === 0) return { ok: true };
  const vTokens = placeholderTokens(value);
  if (kTokens.join(',') !== vTokens.join(',')) {
    return { ok: false, reason: `占位符集合或顺序不一致（key=${kTokens.join(',')} vs value=${vTokens.join(',')}）` };
  }
  const kSegs = String(key).split(/\{\d+\}/);
  const vSegs = String(value).split(/\{\d+\}/);
  for (let i = 0; i < kSegs.length; i++) {
    if (kSegs[i] === '' && vSegs[i] !== '') {
      return { ok: false, reason: `第 ${i} 段在英文键中为空槽，译文写入 ${JSON.stringify(vSegs[i])} 会触发运行时 J04 unsupported` };
    }
  }
  return { ok: true };
}

function stripScopedPrefix(key) {
  if (!key.startsWith('@ui:')) return key;
  const parts = key.slice(4).split('|');
  return parts.length >= 3 ? parts.slice(2).join('|') : key;
}

/** Collects all `{0}` inline-slot layout violations in a dictionary layer map or object. */
export function inlineSlotViolations(entries) {
  const violations = [];
  const iterator = entries instanceof Map
    ? entries.entries()
    : Object.entries(entries ?? {});
  for (const [key, meta] of iterator) {
    const rawKey = stripScopedPrefix(key);
    if (!/\{\d+\}/.test(rawKey)) continue;
    const value = typeof meta === 'string' ? meta : meta?.value;
    const file = typeof meta === 'string' ? undefined : meta?.file;
    if (typeof value !== 'string') continue;
    const res = validateInlineSlotLayout(rawKey, value);
    if (!res.ok) violations.push({ key, value, file, reason: res.reason });
  }
  return violations;
}

/**
 * Mirrors `runtime/engine.js:translateInlineGroupText` coverage semantics:
 * checks direct match, inline template match, trailing placeholder stripping,
 * and atomic multi-sentence splitting.
 */
export function resolveInlineGroupCoverage(text, foldedEntries, options = {}) {
  const norm = normalizeText(text);
  if (!norm) return { covered: false };
  const lookup = s => foldedEntries.get(foldDictionaryKey(s));
  const matchesInlineTemplate = s => {
    const matchers = options.inlineTemplates;
    if (!Array.isArray(matchers)) return false;
    return matchers.some(re => re.test(s));
  };
  if (lookup(norm) !== undefined) return { covered: true, mode: 'direct' };
  if (matchesInlineTemplate(norm)) return { covered: true, mode: 'template' };

  const trailingMatch = norm.match(/^([\s\S]+?[.?!])(\s*)((?:\{\d+\})+)([.?!])?$/);
  if (trailingMatch) {
    const prefix = normalizeText(trailingMatch[1]);
    if (lookup(prefix) !== undefined || matchesInlineTemplate(prefix)) {
      return { covered: true, mode: 'compositional' };
    }
  }

  const sentences = norm.split(/(?<=[.?!])\s+/);
  if (sentences.length >= 2) {
    let hasProse = false;
    let allCovered = true;
    for (const rawSentence of sentences) {
      const sentence = normalizeText(rawSentence);
      if (!sentence) continue;
      if (/^((?:\{\d+\})+)([.?!])?$/.test(sentence)) continue;
      if (lookup(sentence) !== undefined || matchesInlineTemplate(sentence)) {
        hasProse = true;
      } else {
        allCovered = false;
        break;
      }
    }
    if (hasProse && allCovered) return { covered: true, mode: 'compositional' };
  }
  return { covered: false };
}
