import { embedText } from './ollama-embedder';
import type { RetrievalBackend, RetrievalResult } from './backend';

export function buildRetrievedContextBlock(results: RetrievalResult[]): string | null {
  if (results.length === 0) return null;

  const lines = results.map((r) => {
    const label =
      r.sourceKind === 'agent_run'
        ? `agent_run · ${r.metadata.agentName ?? r.sourceId}`
        : r.sourceKind === 'project_doc'
        ? `project_doc · ${r.metadata.filePath ?? r.sourceId}`
        : `skill · ${r.metadata.skillTitle ?? r.sourceId}`;
    return `[${label}]\n${r.text}`;
  });

  return [
    '## Retrieved Context',
    'The following was retrieved from past runs and project knowledge.',
    'Use it to avoid repeating work and stay consistent with prior decisions.',
    '',
    ...lines,
  ].join('\n');
}

export interface RetrieveAgentContextOpts {
  backend: RetrievalBackend;
  project: string;
  taskPrompt: string;
  limit: number;
  scoreThreshold: number;
  ollamaUrl: string;
  embeddingModel: string;
}

export async function retrieveAgentContext(opts: RetrieveAgentContextOpts): Promise<string | null> {
  try {
    const embedding = await embedText(opts.taskPrompt, opts.ollamaUrl, opts.embeddingModel);
    const results = opts.backend.search({ embedding, project: opts.project, limit: opts.limit });
    const above = results.filter((r) => r.score >= opts.scoreThreshold);
    return buildRetrievedContextBlock(above);
  } catch (err) {
    console.warn('[retrieval] retrieveAgentContext failed (best-effort):', err);
    return null;
  }
}
