import type { QuotaSnapshot } from '@/lib/usage/quota-types';
import { getSettings } from '@/lib/shared/config';
import {
  getClaudeQuota,
  clearQuotaCache as clearClaudeQuotaCache,
  peekQuotaCache as peekClaudeQuotaCache,
  prefetchQuota as prefetchClaudeQuota,
} from '@/lib/usage/claude-quota';
import {
  getCodexQuota,
  clearCodexQuotaCache,
  peekCodexQuotaCache,
  prefetchCodexQuota,
} from '@/lib/usage/codex-quota';

function isCodexProvider(): boolean {
  try {
    return getSettings().claude_provider === 'codex';
  } catch {
    return false;
  }
}

export type QuotaProvider = 'active' | 'claude' | 'codex';

export async function getQuota(options: { force?: boolean } = {}): Promise<QuotaSnapshot> {
  return isCodexProvider() ? getCodexQuota(options) : getClaudeQuota(options);
}

export async function getQuotaForProvider(
  provider: QuotaProvider = 'active',
  options: { force?: boolean } = {},
): Promise<QuotaSnapshot> {
  if (provider === 'codex') return getCodexQuota(options);
  if (provider === 'claude') return getClaudeQuota(options);
  return getQuota(options);
}

export function clearQuotaCache(): void {
  if (isCodexProvider()) clearCodexQuotaCache();
  else clearClaudeQuotaCache();
}

export function peekQuotaCache(): QuotaSnapshot | null {
  return isCodexProvider() ? peekCodexQuotaCache() : peekClaudeQuotaCache();
}

export function prefetchQuota(): void {
  if (isCodexProvider()) prefetchCodexQuota();
  else prefetchClaudeQuota();
}
