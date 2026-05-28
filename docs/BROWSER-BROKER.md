# Browser Broker

Lets sandboxed agent runs drive a headless Chromium for QA testing without
giving up the sandbox. Without it, the only way to use Playwright from a
sandboxed Codex or Claude run was `permission_mode=bypassPermissions` —
which also disables network policy and exposes the docker socket. The broker
keeps the sandbox narrow.

## What it is

A long-lived docker container managed by TamTam:

- Image: `mcr.microsoft.com/playwright/mcp:v0.0.30` with `@playwright/mcp` preinstalled. Non-MCP image overrides are still supported through the legacy `npx -y @playwright/mcp@0.0.30` startup path.
- Listens on `0.0.0.0:9333` inside the container, published only on `127.0.0.1:<dynamic>` on the host.
- Probes `/mcp` first and falls back to legacy `/sse` so newer and older Playwright MCP images both work.
- One broker per TamTam process. Per-run `BrowserContext` isolates cookies/storage between agent runs.

Agent runs get a per-job MCP config written to `${tmpdir()}/tamtam-runs/<jobId>/`. The config registers the broker as the `tamtam_browser` MCP server, so the agent calls `mcp__tamtam_browser__browser_navigate`, `mcp__tamtam_browser__browser_take_screenshot`, etc.

The sandbox itself is narrowed: only `127.0.0.1` egress, no docker socket, no arbitrary outbound. This means the only thing the agent can reach over the network is the broker.

## Settings

| Key | Default | Effect |
|---|---|---|
| `browser_broker_enabled` | `false` | Master switch. Off = no broker, no MCP injection. |
| `browser_broker_image` | `mcr.microsoft.com/playwright/mcp:v0.0.30` | Pin override (defense in depth: if upstream pushes a bad image, change here). The pinned MCP image starts from its preinstalled CLI; custom non-MCP images start `@playwright/mcp` through `npx`. |
| `tamtam_network_policy_strict` | `false` | When `true` on macOS: wraps the spawned CLI in `sandbox-exec -f scripts/sandbox-profiles/tamtam-loopback.sb`. Loopback-only egress, docker socket blocked. |

`permission_mode=bypassPermissions` skips the sandbox wrap entirely — it's the explicit escape hatch for power users.

## Architecture

```
TamTam process (unsandboxed)
  ├─ lib/browser-broker/
  │   ├─ container-lifecycle.ts  → docker run/stop/health
  │   ├─ image.ts                → pinned MCP image
  │   ├─ port-allocator.ts       → random loopback port in 49152-65535
  │   ├─ origin-allowlist.ts     → project qa_url / dev_server_ready_url / website
  │   ├─ mcp-config-writer.ts    → per-run Claude JSON + Codex TOML
  │   └─ prepare-run.ts          → orchestrator: gates on settings, returns env
  └─ scripts/sandbox-profiles/tamtam-loopback.sb

Docker container: tamtam-playwright-broker-<port>
  └─ @playwright/mcp HTTP on container :9333 (/mcp or legacy /sse)
     → host 127.0.0.1:<dynamic>

Sandboxed agent
  CODEX_HOME=/tmp/tamtam-runs/<jobId>/.codex
  TAMTAM_MCP_CONFIG_PATH=/tmp/tamtam-runs/<jobId>/mcp.json
  TAMTAM_SANDBOX_PROFILE=<path to .sb>
  ── calls mcp__tamtam_browser__* tools, which reach
     127.0.0.1:<broker port> via the loopback rule
```

## Per-job lifecycle

`lib/agents/intake-workflow.ts` is the wiring point. Before spawning the
agent CLI:

1. `ensureDevServerRunning(project)` — existing behavior.
2. `prepareBrokerRun({ jobId, projectOrigins, provider })`:
   - If `browser_broker_enabled = false`: returns `null`, agent runs as before.
   - Otherwise: ensures the broker container is up, computes allowed origins, writes per-run MCP config to `${tmpdir()}/tamtam-runs/<jobId>/`, returns env to merge.
3. `wrapForSandbox({ bin, args, cwd, runDir })` in `lib/jobs/inline-agent.ts` and `lib/jobs/spawn-claude-detached.ts`:
   - If `tamtam_network_policy_strict = true` and platform is macOS: replaces the spawn command with `sandbox-exec -D … -f tamtam-loopback.sb <bin> <args...>`.
   - Sets `TAMTAM_SANDBOX_PROFILE` so the codex shim knows to pass `--sandbox danger-full-access` to codex (which neutralizes codex's built-in workspace-write sandbox; the outer seatbelt profile is the real one).
4. Spawn proceeds as normal.

The same `prepareBrokerRun()` wiring is also used by the manual continue
route and the background auto-resume path so resumed agent/terminal jobs
keep the same broker MCP tools as the original launch.

## Origin allow-list

The broker container has full internet access by itself (Chromium can navigate anywhere). This is acceptable because:

1. The sandboxed agent can only reach `127.0.0.1`, so it cannot directly exfiltrate.
2. The agent's `mcp__tamtam_browser__browser_navigate({url})` calls go to the broker, which is what actually navigates. Future work (v2): add a navigation interceptor in the broker that policies URLs against the per-run allow-list (`TAMTAM_ALLOWED_ORIGINS` is already passed to the container; the interceptor would enforce it).

For v1, the allow-list is metadata only — the agent can call any URL via the broker. Security depends on the broker container being trusted infrastructure.

## Sandbox profile

`scripts/sandbox-profiles/tamtam-loopback.sb`:

```scheme
(version 1)
(allow default)
(deny network*)
(allow network-bind (local ip "localhost:*"))
(allow network-outbound (remote ip "localhost:*"))
(allow network-outbound (literal "/private/var/run/syslog"))
(allow network-outbound (literal "/private/var/run/asl_input"))
(deny file-read* file-write* (literal "/var/run/docker.sock"))
(deny file-read* file-write* (literal "/private/var/run/docker.sock"))
```

Tested properties (`__tests__/browser-broker/sandbox-profile.test.ts`):

- ✓ Loopback to the broker reaches the selected MCP endpoint (HTTP 200 in stream-mode).
- ✓ External IP (`1.1.1.1`) is blocked (curl exits 7).
- ✓ Docker socket (`/var/run/docker.sock`) is blocked (`Operation not permitted`).

## Linux

V1 is macOS-only. Linux uses Codex's built-in landlock + seccomp, which doesn't easily express "loopback-only network." The broker itself works on Linux (the docker container is platform-portable), so a v2 task is to wrap Codex on Linux in `bwrap`/firejail with an analogous network policy.

`tamtam_network_policy_strict = true` on Linux is currently a no-op (logs the gap; proceeds without wrap).

## Operations

Enable for a workspace:

```sql
INSERT INTO settings(key, value) VALUES ('browser_broker_enabled', 'true');
INSERT INTO settings(key, value) VALUES ('tamtam_network_policy_strict', 'true');
```

Or via the settings UI when those keys are exposed there.

Verify the broker is up after enabling:

```bash
docker ps --filter "name=tamtam-playwright-broker"
```

Stop manually if needed:

```bash
docker rm -f $(docker ps -q --filter "name=tamtam-playwright-broker")
```

It will be re-started on next agent run.

## Tests

| File | What it verifies |
|---|---|
| `__tests__/browser-broker/origin-allowlist.test.ts` | Pure function: origin extraction, host.docker.internal twin, dedup. |
| `__tests__/browser-broker/mcp-config-writer.test.ts` | Writes Claude JSON and Codex TOML, exposes env vars, cleanup works. |
| `__tests__/browser-broker/smoke-broker.test.ts` | End-to-end: starts a real docker container, asserts the selected MCP endpoint is reachable. Skips when docker is unavailable. |
| `__tests__/browser-broker/sandbox-profile.test.ts` | Loopback to broker ✓, external blocked ✓, docker socket blocked ✓. Skips on non-Mac or missing docker. |
