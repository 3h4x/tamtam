export type AgentInput = {
  id: string;
  project: string;
  name: string;
  schedule: string | null;
  prompt: string | null;
  enabled: boolean;
  // 'user' for normal agents (default), 'system' for built-in auto-seeded
  // agents that dispatch to internal handlers instead of spawning a CLI.
  kind: 'user' | 'system';
};
