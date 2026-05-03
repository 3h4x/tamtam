export const BUDGET_SUBSCRIPTION_PROVIDERS = ['claude', 'codex'] as const;

export type BudgetSubscriptionProvider = (typeof BUDGET_SUBSCRIPTION_PROVIDERS)[number];

const VALID_PROVIDERS = new Set<BudgetSubscriptionProvider>(BUDGET_SUBSCRIPTION_PROVIDERS);

export function normalizeBudgetSubscriptionProviders(
  raw: string | null | undefined,
): BudgetSubscriptionProvider[] {
  const parsed = String(raw ?? '')
    .split(/[,\s]+/)
    .map((value) => value.trim())
    .filter((value): value is BudgetSubscriptionProvider => VALID_PROVIDERS.has(value as BudgetSubscriptionProvider));

  const unique = Array.from(new Set(parsed));
  return unique.length > 0 ? unique : [...BUDGET_SUBSCRIPTION_PROVIDERS];
}

export function encodeBudgetSubscriptionProviders(
  providers: readonly BudgetSubscriptionProvider[],
): string {
  return normalizeBudgetSubscriptionProviders(providers.join(',')).join(',');
}
