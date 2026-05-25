import { getSettings } from '@/lib/shared/config';
import { ensureBrokerRunning } from './container-lifecycle';
import { computeAllowedOrigins, type ProjectOriginInput } from './origin-allowlist';
import { writeRunMcpConfig, cleanupRunMcpConfig } from './mcp-config-writer';

export interface BrokerRunPreparation {
  env: Record<string, string>;
  runDir: string;
  cleanup: () => void;
}

export interface PrepareBrokerRunInput {
  jobId: string;
  projectOrigins: ProjectOriginInput;
  provider: 'claude' | 'codex' | 'gemini' | 'lmstudio' | 'deepagents';
}

// Returns the env vars to merge into the child process and a cleanup callback
// to run after the job exits. Returns null when the broker is disabled or
// docker is unavailable — caller proceeds without broker injection.
export async function prepareBrokerRun(
  input: PrepareBrokerRunInput,
): Promise<BrokerRunPreparation | null> {
  const settings = getSettings();
  if (!settings.browser_broker_enabled) return null;

  let broker;
  try {
    broker = await ensureBrokerRunning();
  } catch (err) {
    console.error(
      '[browser-broker] start failed; agent will run without MCP injection:',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
  const allowedOrigins = computeAllowedOrigins(input.projectOrigins);
  const written = writeRunMcpConfig({
    jobId: input.jobId,
    brokerUrl: broker.url,
    allowedOrigins,
    provider: input.provider,
  });
  return {
    env: written.env,
    runDir: written.runDir,
    cleanup: () => cleanupRunMcpConfig(input.jobId),
  };
}
