import { embedText } from './ollama-embedder';
import type { RetrievalBackend, RetrievalResult } from './backend';

const PREVIEW_MAX_CHARS = 180;

function previewText(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= PREVIEW_MAX_CHARS) return normalized;
  return `${normalized.slice(0, PREVIEW_MAX_CHARS - 3).trimEnd()}...`;
}

export function buildRetrievedContextBlock(results: RetrievalResult[]): string | null {
  if (results.length === 0) return null;

  const lines = results.map((r) => {
    const label =
      r.sourceKind === 'agent_run'
        ? `agent_run · ${r.metadata.agentName ?? r.sourceId}`
        : r.sourceKind === 'project_doc'
        ? `project_doc · ${r.metadata.filePath ?? r.sourceId}`
        : r.sourceKind === 'project_config'
        ? `project_config · ${r.metadata.label ?? r.sourceId}`
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

export interface RetrievalDiagnostics {
  status: 'ok' | 'warning';
  reason: 'results' | 'empty_corpus' | 'no_results' | 'below_threshold' | 'embed_failed';
  corpusChunkCount: number;
  retrievedCount: number;
  acceptedCount: number;
  topScore: number | null;
  scoreThreshold: number;
  sources?: RetrievedContextSource[];
}

export interface RetrievedContextSource {
  sourceKind: RetrievalResult['sourceKind'];
  sourceId: string;
  project: string;
  score: number;
  rank: number;
  preview: string;
}

export async function retrieveAgentContextDetailed(
  opts: RetrieveAgentContextOpts
): Promise<{ block: string | null; diagnostics: RetrievalDiagnostics }> {
  const corpusChunkCount = await opts.backend.countProjectChunks(opts.project, ['project_doc', 'skill', 'project_config', 'agent_run']);
  if (corpusChunkCount === 0) {
    return {
      block: null,
      diagnostics: {
        status: 'warning',
        reason: 'empty_corpus',
        corpusChunkCount,
        retrievedCount: 0,
        acceptedCount: 0,
        topScore: null,
        scoreThreshold: opts.scoreThreshold,
      },
    };
  }

  try {
    const embedding = await embedText(opts.taskPrompt, opts.ollamaUrl, opts.embeddingModel, {
      project: opts.project,
      sourceKind: 'query',
    });
    const results = await opts.backend.search({ embedding, project: opts.project, limit: opts.limit });
    const above = results.filter((r) => r.score >= opts.scoreThreshold);
    const topScore = results[0]?.score ?? null;
    const sources: RetrievedContextSource[] = above.map((result, index) => ({
      sourceKind: result.sourceKind,
      sourceId: result.sourceId,
      project: opts.project,
      score: result.score,
      rank: index + 1,
      preview: previewText(result.text),
    }));
    return {
      block: buildRetrievedContextBlock(above),
      diagnostics: {
        status: above.length > 0 ? 'ok' : 'warning',
        reason: results.length === 0 ? 'no_results' : above.length === 0 ? 'below_threshold' : 'results',
        corpusChunkCount,
        retrievedCount: results.length,
        acceptedCount: above.length,
        topScore,
        scoreThreshold: opts.scoreThreshold,
        ...(sources.length > 0 ? { sources } : {}),
      },
    };
  } catch (err) {
    console.warn('[retrieval] retrieveAgentContext failed (best-effort):', err);
    return {
      block: null,
      diagnostics: {
        status: 'warning',
        reason: 'embed_failed',
        corpusChunkCount,
        retrievedCount: 0,
        acceptedCount: 0,
        topScore: null,
        scoreThreshold: opts.scoreThreshold,
      },
    };
  }
}

export async function retrieveAgentContext(opts: RetrieveAgentContextOpts): Promise<string | null> {
  const result = await retrieveAgentContextDetailed(opts);
  return result.block;
}
