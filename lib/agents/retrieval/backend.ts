export type SourceKind = 'agent_run' | 'project_doc' | 'skill';

export interface RetrievalChunk {
  chunkId: string;        // `${sourceKind}:${sourceId}:${chunkIndex}` — deterministic
  text: string;
  embedding: number[];    // 768-dim float32
  project: string;
  sourceKind: SourceKind;
  sourceId: string;
  chunkIndex: number;
  metadata: Record<string, string>;
}

export interface RetrievalResult {
  text: string;
  sourceKind: SourceKind;
  sourceId: string;
  score: number;          // 0-1, higher = more similar
  metadata: Record<string, string>;
}

export interface RetrievalBackend {
  upsertChunks(chunks: RetrievalChunk[]): void;
  search(opts: {
    embedding: number[];
    project: string;
    limit: number;
    sourceKinds?: SourceKind[];
  }): RetrievalResult[];
  deleteSource(project: string, sourceKind: SourceKind, sourceId: string): void;
  deleteProject(project: string): void;
}
