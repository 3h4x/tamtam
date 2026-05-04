import { join } from 'path';
import type { TamTamConfig } from '@/lib/shared/config';
import type { CliProvider } from '@/lib/usage/cli-providers';

const DEFAULT_SHIM: Record<CliProvider, string> = {
  claude: 'claude-shim.js',
  codex: 'codex-shim.js',
  gemini: 'gemini-shim.js',
  lmstudio: 'lmstudio-shim.js',
};

function isShimPath(bin: string | undefined): boolean {
  if (!bin) return false;
  return /scripts\/(claude|gemini|lmstudio|codex)-shim\.js$/.test(bin);
}

/**
 * Resolve the executable for a given CLI provider. Per-CLI override takes
 * precedence only for the underlying vendor binary / endpoint env; the
 * launched executable remains the bundled shim under `scripts/` so callers
 * can keep passing the shared Claude-compatible argv shape.
 */
export function resolveCliBin(provider: CliProvider, _settings: TamTamConfig): string {
  const root = process.env.TAMTAM_ROOT || process.cwd();
  return join(root, 'scripts', DEFAULT_SHIM[provider]);
}

/**
 * Extra env vars required to launch a given provider. Claude always routes
 * through the shim so it can translate TamTam's shared model tiers; custom
 * Claude executable paths are forwarded via `CLAUDE_BIN`.
 */
export function resolveCliEnv(provider: CliProvider, settings: TamTamConfig): Record<string, string> {
  const overrideKey = `cli_bin_${provider}` as keyof TamTamConfig;
  const override = settings[overrideKey];
  if (typeof override === 'string' && override.trim().length > 0 && !isShimPath(override)) {
    const value = override.trim();
    if (provider === 'claude') return { CLAUDE_BIN: value };
    if (provider === 'codex') return { CODEX_BIN: value };
    if (provider === 'gemini') return { GEMINI_BIN: value };
    if (provider === 'lmstudio' && /^https?:\/\//i.test(value)) {
      return { LMSTUDIO_BASE_URL: value };
    }
  }
  return {};
}

/**
 * Per-CLI default model tier (`fast`/`normal`/`smart`). Falls back to the
 * workspace-wide `default_model` if the per-CLI key is unset.
 */
export function resolveCliDefaultModel(provider: CliProvider, settings: TamTamConfig): string {
  const key = `cli_default_model_${provider}` as keyof TamTamConfig;
  const value = settings[key];
  if (typeof value === 'string' && value.length > 0) return value;
  return settings.default_model;
}
