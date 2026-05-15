// Shared agent type used by the cron task handlers and the boot helpers.
// Lives outside `internal-scheduler.ts` so the cron migration can keep
// importing this type after the in-memory scheduler is deleted.

export type AgentInput = {
  id: string;
  project: string;
  name: string;
  schedule: string | null;
  prompt: string | null;
  enabled: boolean;
};
