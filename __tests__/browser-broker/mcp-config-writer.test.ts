import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { writeRunMcpConfig, cleanupRunMcpConfig } from '@/lib/browser-broker/mcp-config-writer';

const JOB_ID = `test-${process.pid}-${Date.now()}`;

describe('writeRunMcpConfig', () => {
  beforeEach(() => {
    cleanupRunMcpConfig(JOB_ID);
  });

  it('emits Claude JSON pointing at the broker SSE endpoint', () => {
    const out = writeRunMcpConfig({
      jobId: JOB_ID,
      brokerUrl: 'http://127.0.0.1:9000',
      allowedOrigins: ['http://localhost:3000', 'http://host.docker.internal:3000'],
      provider: 'claude',
    });
    expect(existsSync(out.claudeConfigPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(out.claudeConfigPath, 'utf8'));
    expect(parsed.mcpServers.tamtam_browser.type).toBe('sse');
    expect(parsed.mcpServers.tamtam_browser.url).toBe('http://127.0.0.1:9000/sse');
  });

  it('exposes env vars the child process needs', () => {
    const out = writeRunMcpConfig({
      jobId: JOB_ID,
      brokerUrl: 'http://127.0.0.1:9000',
      allowedOrigins: ['http://localhost:3000'],
      provider: 'claude',
    });
    expect(out.env.TAMTAM_MCP_CONFIG_PATH).toBe(out.claudeConfigPath);
    expect(out.env.TAMTAM_BROKER_URL).toBe('http://127.0.0.1:9000');
    expect(out.env.TAMTAM_ALLOWED_ORIGINS).toBe('http://localhost:3000');
    // Codex auth lives in the user's normal ~/.codex; we don't override
    // CODEX_HOME because that would orphan auth.json + session state.
    expect(out.env.CODEX_HOME).toBeUndefined();
  });

  it('cleanup removes the run dir', () => {
    const out = writeRunMcpConfig({
      jobId: JOB_ID,
      brokerUrl: 'http://127.0.0.1:9000',
      allowedOrigins: [],
      provider: 'claude',
    });
    expect(existsSync(out.runDir)).toBe(true);
    cleanupRunMcpConfig(JOB_ID);
    expect(existsSync(out.runDir)).toBe(false);
  });

  it('uses os.tmpdir() as the run-dir base', () => {
    const out = writeRunMcpConfig({
      jobId: JOB_ID,
      brokerUrl: 'http://127.0.0.1:9000',
      allowedOrigins: [],
      provider: 'claude',
    });
    expect(out.runDir.startsWith(tmpdir())).toBe(true);
    rmSync(out.runDir, { recursive: true, force: true });
  });
});
