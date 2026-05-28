import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

export interface WriteRunMcpConfigOptions {
  jobId: string;
  brokerUrl: string;
  brokerMcpUrl?: string;
  allowedOrigins: string[];
  provider: 'claude' | 'codex' | 'gemini' | 'lmstudio' | 'deepagents';
}

export interface WrittenMcpConfig {
  runDir: string;
  claudeConfigPath: string;
  env: Record<string, string>;
}

function runDirFor(jobId: string): string {
  return join(/*turbopackIgnore: true*/ tmpdir(), 'tamtam-runs', jobId);
}

export function writeRunMcpConfig(opts: WriteRunMcpConfigOptions): WrittenMcpConfig {
  const runDir = runDirFor(opts.jobId);
  mkdirSync(/*turbopackIgnore: true*/ runDir, { recursive: true });

  const mcpUrl = opts.brokerMcpUrl ?? `${opts.brokerUrl}/mcp`;
  const allowedOriginsCsv = opts.allowedOrigins.join(',');
  const transportType = mcpUrl.endsWith('/sse') ? 'sse' : 'http';

  // Claude reads its MCP config from a file path passed via --mcp-config.
  // Write a fresh JSON per run so the broker URL stays current as the
  // broker's host port may change across TamTam restarts.
  const claudeConfig = {
    mcpServers: {
      tamtam_browser: {
        type: transportType,
        url: mcpUrl,
      },
    },
  };
  const claudeConfigPath = join(/*turbopackIgnore: true*/ runDir, 'mcp.json');
  writeFileSync(/*turbopackIgnore: true*/ claudeConfigPath, JSON.stringify(claudeConfig, null, 2));

  // Codex: instead of overriding CODEX_HOME (which would orphan the user's
  // auth.json + sessions in ~/.codex), advertise the broker URL via env. The
  // codex shim turns this into native `-c mcp_servers.tamtam_browser.*` flags
  // before exec'ing codex — same effect, user's normal config is preserved.
  return {
    runDir,
    claudeConfigPath,
    env: {
      TAMTAM_MCP_CONFIG_PATH: claudeConfigPath,
      TAMTAM_BROKER_URL: opts.brokerUrl,
      TAMTAM_BROKER_MCP_URL: mcpUrl,
      TAMTAM_ALLOWED_ORIGINS: allowedOriginsCsv,
    },
  };
}

export function cleanupRunMcpConfig(jobId: string): void {
  const dir = runDirFor(jobId);
  try {
    rmSync(/*turbopackIgnore: true*/ dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}
