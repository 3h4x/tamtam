#!/usr/bin/env node
/* eslint-env node */

/**
 * Claude CLI tier-name shim.
 *
 * TamTam uses tier names (`fast`/`normal`/`smart`) globally so all provider
 * shims share one vocabulary. The actual `claude` CLI does not understand
 * these — it expects its own aliases (`haiku`/`sonnet`/`opus`) or full
 * model IDs — so this thin wrapper rewrites the `--model` value before
 * exec'ing the real Claude binary. All other args (and stdio) are forwarded
 * verbatim, so streaming and exit codes pass through untouched.
 *
 * Override the underlying binary with `CLAUDE_BIN` (default `claude`), and
 * the per-tier mapping with `CLAUDE_FAST_MODEL` / `CLAUDE_NORMAL_MODEL` /
 * `CLAUDE_SMART_MODEL`.
 */

const { spawn } = require('child_process');
const { homedir } = require('os');
const { join } = require('path');
const { installInactivityWatchdog, installSignalForwarding } = require('./shim-utils');

const TIER_DEFAULTS = {
  fast: 'haiku',
  normal: 'sonnet',
  smart: 'opus',
};

function resolveClaudeModel(value, env) {
  const e = env || process.env;
  const v = String(value || '').trim();
  if (!v) return v;
  if (v === 'fast') return e.CLAUDE_FAST_MODEL || TIER_DEFAULTS.fast;
  if (v === 'normal') return e.CLAUDE_NORMAL_MODEL || TIER_DEFAULTS.normal;
  if (v === 'smart') return e.CLAUDE_SMART_MODEL || TIER_DEFAULTS.smart;
  // Already a Claude alias or full model ID — leave it alone.
  return v;
}

function transformArgs(argv, env) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--model' && i + 1 < argv.length) {
      out.push(a, resolveClaudeModel(argv[i + 1], env));
      i += 1;
    } else if (a.startsWith('--model=')) {
      out.push(`--model=${resolveClaudeModel(a.slice('--model='.length), env)}`);
    } else if (a === '--fallback-model' && i + 1 < argv.length) {
      out.push(a, resolveClaudeModel(argv[i + 1], env));
      i += 1;
    } else if (a.startsWith('--fallback-model=')) {
      out.push(`--fallback-model=${resolveClaudeModel(a.slice('--fallback-model='.length), env)}`);
    } else {
      out.push(a);
    }
  }
  // TamTam-injected per-run MCP config: append --mcp-config when the env var
  // points at a writable file and the user hasn't already passed one in argv.
  const e = env || process.env;
  const mcpPath = e.TAMTAM_MCP_CONFIG_PATH;
  if (mcpPath && !out.includes('--mcp-config') && !out.some((x) => x.startsWith('--mcp-config='))) {
    out.push('--mcp-config', mcpPath);
    // Isolate the agent run to ONLY the broker MCP. Without --strict-mcp-config,
    // the CLI also loads the user's global/project/plugin MCP servers — most
    // damagingly the Claude Code `playwright` plugin, which starts
    // `@playwright/mcp@latest` *headed* (no --headless) and pops a visible
    // browser window during a headless agent run. TamTam's broker
    // (`tamtam_browser`) is already headless; strict mode makes the agent use
    // that and nothing else.
    if (!out.includes('--strict-mcp-config')) {
      out.push('--strict-mcp-config');
    }
    // Claude requires explicit --allowedTools entries for headless MCP calls;
    // without it the model is told the tool exists but is denied. Match the
    // server name written by mcp-config-writer.ts: `tamtam_browser`.
    const allowedFlag = out.findIndex((x) => x === '--allowedTools' || x === '--allowed-tools');
    if (allowedFlag === -1) {
      out.push('--allowedTools', 'mcp__tamtam_browser');
    }
    process.stderr.write(`[claude-shim] injecting --mcp-config ${mcpPath} (strict)\n`);
  }
  return out;
}

if (require.main === module) {
  const out = transformArgs(process.argv.slice(2));

  // Default mirrors TamTam's `claude_bin` default in lib/shared/config.ts so
  // users who relied on `~/.local/bin/claude` don't need to set CLAUDE_BIN.
  const bin = process.env.CLAUDE_BIN || join(homedir(), '.local', 'bin', 'claude');
  // Pipe stdout/stderr so the inactivity watchdog can observe data events,
  // then forward each chunk to the parent's stdout/stderr so streaming
  // output and exit codes pass through unchanged.
  let child;
  const signalForwarding = installSignalForwarding(() => child);
  child = spawn(bin, out, { stdio: ['inherit', 'pipe', 'pipe'], env: process.env });
  signalForwarding.forwardPending();

  const watchdog = installInactivityWatchdog(child, { shimName: 'claude-shim' });
  let childClosed = false;
  let stdoutEnded = false;
  let stderrEnded = false;
  let exitCode = 0;
  const maybeExit = () => {
    if (!childClosed || !stdoutEnded || !stderrEnded) return;
    process.exit(exitCode);
  };
  child.stdout.on('data', (chunk) => {
    watchdog.markActivity();
    process.stdout.write(chunk);
  });
  child.stdout.on('end', () => {
    stdoutEnded = true;
    maybeExit();
  });
  child.stderr.on('data', (chunk) => {
    watchdog.markActivity();
    process.stderr.write(chunk);
  });
  child.stderr.on('end', () => {
    stderrEnded = true;
    maybeExit();
  });

  child.on('error', (err) => {
    signalForwarding.dispose();
    watchdog.dispose();
    process.stderr.write(`[claude-shim] failed to launch ${bin}: ${err.message}\n`);
    process.exit(1);
  });
  child.on('close', (code, signal) => {
    signalForwarding.dispose();
    watchdog.dispose();
    if (watchdog.timedOut()) {
      process.stderr.write(`[claude-shim] killed by inactivity watchdog\n`);
      exitCode = 124;
      childClosed = true;
      maybeExit();
      return;
    }
    if (signal) {
      const sigCode = require('os').constants.signals[signal] || 0;
      exitCode = 128 + sigCode;
      childClosed = true;
      maybeExit();
      return;
    }
    exitCode = code ?? 0;
    childClosed = true;
    maybeExit();
  });
}

module.exports = { resolveClaudeModel, transformArgs };
