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

export interface IngestSourceOpts {
  backend: RetrievalBackend;
  project: string;
  sourceKind: SourceKind;
  sourceId: string;
  text: string;
  metadata: Record<string, string>;
  ollamaUrl: string;
  embeddingModel: string;
  existingHash: string | null;
}

export async function ingestSourceText(
  opts: IngestSourceOpts
): Promise<{ contentHash: string; chunkCount: number; skipped: boolean; stored: boolean }> {
  const contentHash = hashContent(opts.text);

  if (opts.existingHash === contentHash) {
    return { contentHash, chunkCount: 0, skipped: true, stored: false };
  }

  try {
    const chunks = chunkText(opts.text);
    const embeddedChunks = await Promise.all(
      chunks.map(async (chunk, i) => ({
        chunkId: `${opts.sourceKind}:${opts.sourceId}:${i}`,
        text: chunk,
        embedding: await embedText(chunk, opts.ollamaUrl, opts.embeddingModel, {
          project: opts.project,
          sourceKind: opts.sourceKind,
        }),
        project: opts.project,
        sourceKind: opts.sourceKind,
        sourceId: opts.sourceId,
        chunkIndex: i,
        metadata: opts.metadata,
      }))
    );
    if (opts.existingHash !== null) {
      await opts.backend.deleteSource(opts.project, opts.sourceKind, opts.sourceId);
    }
    await opts.backend.upsertChunks(embeddedChunks);
    return { contentHash, chunkCount: chunks.length, skipped: false, stored: true };
  } catch (err) {
    console.warn(`[retrieval] ingestSourceText failed for ${opts.sourceKind}:${opts.sourceId}:`, err);
    return { contentHash, chunkCount: 0, skipped: false, stored: false };
  }
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

  const result = await ingestSourceText({
    backend: opts.backend,
    project: opts.project,
    sourceKind: 'agent_run' as SourceKind,
    sourceId: opts.jobId,
    text,
    metadata: {
      agentId: opts.agentId,
      agentName: opts.agentName,
      jobId: opts.jobId,
      exitCode: String(opts.exitCode),
      completedAt: String(opts.completedAt),
    },
    ollamaUrl: opts.ollamaUrl,
    embeddingModel: opts.embeddingModel,
    // Forward the original existingHash so `ingestSourceText` knows this is
    // a re-ingestion and runs its stale-chunk delete before upserting. The
    // early-return-on-match check above already guarantees existingHash !=
    // newHash when we reach this call, so the only thing forwarding gains
    // is the delete-stale step. Without it, a run that shrank from N to M
    // chunks (M < N) leaves chunks M..N-1 orphaned in pgvector.
    existingHash: opts.existingHash,
  });
  return { contentHash, skipped: result.skipped, stored: result.stored };
}
