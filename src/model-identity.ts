export const THINKING_EFFORT_SUFFIX_RE =
  /(?:-(?:extra-high|extra-low|xhigh|extra|high|medium|low|minimal|max|thinking))+$/i;

export const THINKING_EFFORT_OR_LATEST_SUFFIX_RE =
  /(?:-(?:extra-high|extra-low|xhigh|extra|high|medium|low|minimal|max|thinking|latest))+$/i;

export const TIERED_OR_THINKING_EFFORT_SUFFIX_RE =
  /(?:-(?:tiered|extra-high|extra-low|xhigh|extra|high|medium|low|minimal|max|thinking))+$/i;

/** Strip Vertex AI / GCP / Cloud publisher prefixes and RPC method suffixes while preserving case. */
export function stripModelProviderPrefix(name: string): string {
  return name.trim()
    .replace(/^(?:projects\/[^/]+\/locations\/[^/]+\/)?(?:publishers\/[^/]+\/)?models\//i, '')
    .replace(/^publishers\/[^/]+\/models\//i, '')
    .replace(/^(?:vertex_ai|google|anthropic|openai)\//i, '')
    .replace(/^models\//i, '')
    .replace(/:(?:predict|generateContent|streamGenerateContent)$/i, '');
}

/** Normalize spelling only; this does not authorize a model to inherit a price. */
export function normalizeModelId(name: string): string {
  return stripModelProviderPrefix(name)
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '')
    .replace(/^claude-(opus|sonnet|haiku)-3\.([57])\b/, 'claude-3-$2-$1')
    .replace(/^claude-((?!thinking|preview|trial|latest|high|medium|low|max|minimal|xhigh|extra|tiered|fast|batch|exp)[a-z]{3,16})-(\d+)\.(\d+)/, 'claude-$1-$2-$3')
    .replace(/^claude-3\.([57])-(sonnet|haiku)/, 'claude-3-$1-$2')
    .replace(/^claude-(3)-(5|7)-(sonnet|haiku)/, 'claude-$1-$2-$3')
    .replace(/^claude-([4-9]|[1-9]\d+)\.(\d+)-((?!thinking|preview|trial|latest|high|medium|low|max|minimal|xhigh|extra|tiered|fast|batch|exp)[a-z]{3,16})/, 'claude-$3-$1-$2')
    .replace(/^claude-3\.([57])-/, 'claude-3-$1-');
}
