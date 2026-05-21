export const MODEL_TIERS = ['fast', 'normal', 'smart'] as const;
export const LEGACY_MODEL_ALIASES = ['haiku', 'sonnet', 'opus'] as const;

export type ModelTier = (typeof MODEL_TIERS)[number];
export type LegacyModelAlias = (typeof LEGACY_MODEL_ALIASES)[number];
export type KnownModelAlias = ModelTier | LegacyModelAlias;
const INVALID_MODEL_INPUT_DETAIL = 'Invalid model. Allowed values: fast, normal, smart, haiku, sonnet, opus.';

const MODEL_ALIAS_MAP: Record<KnownModelAlias, ModelTier> = {
  fast: 'fast',
  normal: 'normal',
  smart: 'smart',
  haiku: 'fast',
  sonnet: 'normal',
  opus: 'smart',
};

export const MODEL_LABELS: Record<ModelTier, string> = {
  fast: 'Fast',
  normal: 'Normal',
  smart: 'Smart',
};

export const MODEL_DESCRIPTIONS: Record<ModelTier, string> = {
  fast: 'Fastest, lowest cost',
  normal: 'Balanced speed and quality',
  smart: 'Highest reasoning and quality',
};

export function resolveModelAlias(model: string | null | undefined): ModelTier | '' {
  const trimmed = model?.trim();
  if (!trimmed) return '';
  return MODEL_ALIAS_MAP[trimmed as KnownModelAlias] ?? '';
}

export function normalizeModelInput(model: string | null | undefined, fallback: ModelTier = 'normal'): ModelTier {
  const resolved = resolveModelAlias(model);
  return resolved || fallback;
}

export function parseOptionalKnownModelInput(
  input: unknown,
  fallback: ModelTier = 'normal'
): { model: ModelTier | null; error: string | null } {
  if (input === undefined || input === null) return { model: null, error: null };
  if (typeof input !== 'string') return { model: null, error: INVALID_MODEL_INPUT_DETAIL };
  const trimmed = input.trim();
  if (!trimmed) return { model: null, error: null };
  if (!isKnownModelAlias(trimmed)) return { model: null, error: INVALID_MODEL_INPUT_DETAIL };
  return { model: normalizeModelInput(trimmed, fallback), error: null };
}

export function isKnownModelAlias(model: string | null | undefined): model is KnownModelAlias {
  const trimmed = model?.trim();
  return !!trimmed && trimmed in MODEL_ALIAS_MAP;
}

export function isCanonicalModelTier(model: string | null | undefined): model is ModelTier {
  const trimmed = model?.trim();
  return !!trimmed && (MODEL_TIERS as readonly string[]).includes(trimmed);
}

export function getModelLabel(model: string | null | undefined): string {
  const resolved = resolveModelAlias(model);
  return MODEL_LABELS[resolved as ModelTier] ?? (model?.trim() || '');
}

export function getProviderModelHint(provider: string | null | undefined, model: string | null | undefined): string {
  const resolved = resolveModelAlias(model);
  if (!isCanonicalModelTier(resolved)) return '';
  if (provider === 'gemini') {
    return resolved === 'fast' ? 'flash' : 'pro';
  }
  if (provider === 'codex') {
    return resolved === 'fast' ? 'gpt-5.4-mini' : resolved === 'normal' ? 'gpt-5.4' : 'gpt-5.5';
  }
  return '';
}
