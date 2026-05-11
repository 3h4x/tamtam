export interface QuotaWindow {
  utilization: number;
  resetsAt: string | null;
  msUntilReset: number | null;
}

export interface QuotaSnapshot {
  provider?: 'claude' | 'codex';
  planType?: string | null;
  fiveHour: QuotaWindow;
  sevenDay: QuotaWindow;
  sevenDaySonnet?: QuotaWindow | null;
  sevenDayOpus?: QuotaWindow | null;
  extra?: {
    isEnabled: boolean;
    monthlyLimit: number | null;
    usedCredits: number | null;
    utilization: number | null;
    currency: string | null;
  };
  fetchedAt: number;
  stale: boolean;
}

export class ProviderNotConfiguredError extends Error {
  readonly provider: 'claude' | 'codex';
  constructor(provider: 'claude' | 'codex', message: string) {
    super(message);
    this.name = 'ProviderNotConfiguredError';
    this.provider = provider;
  }
}
