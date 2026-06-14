import type { AgentRole } from '@/lib/agents/roles';
import type { ModelTier } from '@/lib/agents/model-aliases';
import type { AutopilotState } from '@/lib/orchestrator/agent-autopilot';

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
  // When false, the orchestrator never picks this agent for a *boost* fire —
  // it still runs on its own `schedule`. Use for blog-writer / social-poster
  // style agents where boosting would over-publish.
  boostable: boolean;
  // Operator-configured base model tier (autopilot may override at dispatch).
  model: ModelTier;
  // Agent role — drives the autopilot policy (see lib/agents/roles.ts).
  role: AgentRole;
  // Runtime autopilot overrides + streak counters ({} when none). The cron
  // handler resolves the effective schedule/model from here at each fire.
  autopilot: AutopilotState;
};
