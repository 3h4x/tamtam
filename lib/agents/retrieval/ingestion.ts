import { createHash } from 'crypto';
import { chunkText } from './chunker';
import { embedText } from './ollama-embedder';
import type { RetrievalBackend, SourceKind } from './backend';

export function hashContent(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function buildRunText(opts: {
  workSummary: string;
  modifiedFiles: string[];
  agentName: string;
  exitCode: number;
}): string {
  const files = opts.modifiedFiles.length > 0 ? opts.modifiedFiles.join(', ') : 'none';
  return `${opts.workSummary}\n\nFiles: ${files}\nAgent: ${opts.agentName}\nExit: ${opts.exitCode}`;
}

export interface IngestAgentRunOpts {
  backend: RetrievalBackend;
  project: string;
  jobId: string;
  agentId: string;
  agentName: string;
  workSummary: string;
  modifiedFiles: string[];
  exitCode: number;
  completedAt: number;
  ollamaUrl: string;
  embeddingModel: string;
  existingHash: string | null;
}

export async function ingestAgentRun(
  opts: IngestAgentRunOpts
): Promise<{ contentHash: string; skipped: boolean; stored: boolean }> {
  const text = buildRunText({
    workSummary: opts.workSummary,
    modifiedFiles: opts.modifiedFiles,
    agentName: opts.agentName,
    exitCode: opts.exitCode,
  });
  const contentHash = hashContent(text);

  if (opts.existingHash === contentHash) {
    return { contentHash, skipped: true, stored: false };
  }

  try {
    const chunks = chunkText(text);
    const embeddedChunks = await Promise.all(
      chunks.map(async (chunk, i) => ({
        chunkId: `agent_run:${opts.jobId}:${i}` as const,
        text: chunk,
        embedding: await embedText(chunk, opts.ollamaUrl, opts.embeddingModel, {
          project: opts.project,
          sourceKind: 'agent_run',
        }),
        project: opts.project,
        sourceKind: 'agent_run' as SourceKind,
        sourceId: opts.jobId,
        chunkIndex: i,
        metadata: {
          agentId: opts.agentId,
          agentName: opts.agentName,
          jobId: opts.jobId,
          exitCode: String(opts.exitCode),
          completedAt: String(opts.completedAt),
        },
      }))
    );
    opts.backend.upsertChunks(embeddedChunks);
    return { contentHash, skipped: false, stored: true };
  } catch (err) {
    console.warn('[retrieval] ingestAgentRun failed (best-effort):', err);
    return { contentHash, skipped: false, stored: false };
  }
}
