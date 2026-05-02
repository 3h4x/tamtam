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
