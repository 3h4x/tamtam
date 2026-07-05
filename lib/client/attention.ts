// Client fetcher for the unified Inbox feed. The item/counts types are the pure
// shapes in `@/lib/attention/types` (no server-only code), so client components
// import those directly — only the fetch + response wrapper live here.

import type { AttentionItem, AttentionCounts } from '@/lib/attention/types';

export interface AttentionResponse {
  items: AttentionItem[];
  counts: AttentionCounts;
}

async function parseJsonError(response: Response): Promise<Error> {
  const body = (await response.json().catch(() => ({}))) as { detail?: string };
  return new Error(body.detail || `HTTP ${response.status}`);
}

export async function fetchAttention(opts?: { project?: string }): Promise<AttentionResponse> {
  const qs = opts?.project ? `?project=${encodeURIComponent(opts.project)}` : '';
  const response = await fetch(`/api/attention${qs}`);
  if (!response.ok) throw await parseJsonError(response);
  return response.json();
}
