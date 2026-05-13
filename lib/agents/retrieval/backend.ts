export type SourceKind = 'agent_run' | 'project_doc' | 'skill' | 'project_config';

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
  upsertChunks(chunks: RetrievalChunk[]): Promise<void>;
  search(opts: {
    embedding: number[];
    project: string;
    limit: number;
    sourceKinds?: SourceKind[];
  }): Promise<RetrievalResult[]>;
  countProjectChunks(project: string, sourceKinds?: SourceKind[]): Promise<number>;
  deleteSource(project: string, sourceKind: SourceKind, sourceId: string): Promise<void>;
  deleteProject(project: string): Promise<void>;
}
