import type { JobData } from '@/lib/jobs/types';

export const PIPELINE_CHAIN_GAP_SEC = 60;
export const RESUMABLE_RELEASE_STEP_KINDS = new Set(['test', 'fix', 'review', 'commit']);

export function buildReleaseStepChain(
  release: Pick<JobData, 'startedAt'>,
  candidates: JobData[],
): JobData[] {
  const releaseStart = release.startedAt || 0;
  const chain: JobData[] = [];
  let edge = releaseStart;

  for (const candidate of [...candidates].sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0))) {
    if ((candidate.startedAt || 0) - edge > PIPELINE_CHAIN_GAP_SEC) break;
    chain.push(candidate);
    edge = candidate.finishedAt || edge;
  }

  return chain;
}

export function getEffectiveReleaseChainTail(chain: JobData[]): JobData | null {
  if (chain.length === 0) return null;
  const last = chain[chain.length - 1];
  if (last.kind === 'mark-dod' && chain.length > 1) {
    return chain[chain.length - 2];
  }
  return last;
}
