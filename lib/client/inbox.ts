// Client-side types for the cross-project inbox feed. These mirror the
// server-side shapes in `lib/workflows/inbox.ts`; kept as a standalone module
// so client components can import them without pulling in server-only code.

export type InboxSignalType =
  | 'ci_red'
  | 'review_needs_decision'
  | 'pr_ready_to_merge'
  | 'pr_needs_manual_merge'
  | 'stale_changes'
  | 'fix_loop_exhausted'
  | 'orphan_release';

export type InboxSeverity = 'red' | 'yellow' | 'green';

export type InboxActionKind =
  | 'fix-ci'
  | 'release'
  | 'review'
  | 'merge'
  | 'retry-automation'
  | 'open-terminal';

export interface InboxAction {
  kind: InboxActionKind;
  label: string;
  prNumber?: number;
}

export interface InboxSignal {
  id: string;
  type: InboxSignalType;
  severity: InboxSeverity;
  project: string;
  title: string;
  detail: string | null;
  href: string;
  externalUrl: string | null;
  ageSeconds: number | null;
  action: InboxAction;
}

export interface InboxCounts {
  red: number;
  yellow: number;
  green: number;
  total: number;
}

export interface InboxResponse {
  signals: InboxSignal[];
  counts: InboxCounts;
}

async function parseJsonError(response: Response): Promise<Error> {
  const body = (await response.json().catch(() => ({}))) as { detail?: string };
  return new Error(body.detail || `HTTP ${response.status}`);
}

export async function fetchInbox(): Promise<InboxResponse> {
  const response = await fetch('/api/inbox');
  if (!response.ok) throw await parseJsonError(response);
  return response.json();
}
