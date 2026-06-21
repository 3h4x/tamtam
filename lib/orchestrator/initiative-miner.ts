import type { InitiativeCandidate } from '@/lib/orchestrator/initiatives-store';
import { choreBaseScore } from '@/lib/orchestrator/initiative-score';

export interface ProbeFinding {
  kind: string; title: string; rationale: string; prompt: string; dedupKey: string;
}
export interface ProbeResults {
  project: string; findings: ProbeFinding[];
}

export function mineCandidates(results: ProbeResults): InitiativeCandidate[] {
  const byKey = new Map<string, InitiativeCandidate>();
  for (const f of results.findings) {
    if (!f.kind || !f.prompt || !f.dedupKey) continue;
    byKey.set(f.dedupKey, {
      project: results.project,
      source: 'mining',
      kind: f.kind,
      title: f.title,
      rationale: f.rationale,
      prompt: f.prompt,
      dedupKey: f.dedupKey,
      score: choreBaseScore(f.kind),
    });
  }
  return [...byKey.values()];
}
