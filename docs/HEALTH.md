# Health Agent

The **health agent** is a built-in, auto-seeded per-project monitor that answers,
on a deliberate cadence: *is this project's deployed app up where it should be,
does it present data, is it healthy, and what do its logs say?* It is read-only —
it investigates and reports, never edits/restarts/redeploys.

Design spec: `docs/superpowers/specs/2026-07-08-default-health-agent-design.md`.

## What it is

A normal `kind:'user'` CLI agent, distinguished by three catalog fields:

- `role: 'monitor'` — never diff-judged, so it is never flagged unfruitful or
  schedule-backed-off, and autopilot downgrades its model when idle instead of
  throttling cadence (`lib/agents/roles.ts`).
- `boostable: false` — the orchestrator never boost-fires it; it runs only on its
  own schedule (`lib/orchestrator/budget-allocator.ts`).
- `dispatch: 'cli'`, `autoSeed: true` — it runs the normal intake workflow (so it
  gets the browser broker, spend cap, report capture for free) yet is materialized
  into every enabled project like a system agent.

It is defined once in `AGENT_CATALOG` (`lib/agents/catalog.ts`, name `health`,
skill `agent-health`, default schedule `1h`, cheap default model) and seeded per
project by `lib/agents/system/seed.ts`. Auto-seed now supports both internal
(`kind:'system'`) and CLI (`kind:'user'`) entries — the seeded row's
kind/role/boostable/skills come from the catalog entry.

Because "non-boostable" and "non-unfruitful" are carried by `role`/`boostable`
(honored everywhere) rather than by `kind`, the health agent needs no special
casing — **except** that the two cron dispatch gates in `instrumentation-node.ts`
(CI-red deferral, saturation backoff) historically keyed exemption on
`kind !== 'system'` only, which silenced any user monitor after a HEAD-stable
streak. Both now use `isSubjectToDiffGates(agent)` (`lib/agents/roles.ts`) so a
monitor keeps its cadence. That was a latent bug affecting any user monitor, not
just this agent.

## Run flow

1. **Read the per-app brief.** The `agent-health` skill
   (`skills/docs/skills/tamtam/agent-health.md`) reads `docs/HEALTH.md` from the
   project's **trusted default-branch ref** (`origin/<defaultBranch>`), so a
   feature branch cannot inject a forged brief. Absent brief → fall back to the
   project's QA/website URL; no URL → report HEALTHY "no target; skipped" (never
   invent a target).
2. **Cheap checks first.** HTTP-probe the URL + health endpoint; for goro-hosted
   apps, query the Loki tunnel (`localhost:3100`, `{job="pm2", app="<slug>"}`)
   for error-rate spikes; run any brief-specified log command. Known-noise
   patterns from the brief are not alerts.
3. **Browser only when needed.** Use the browser broker to verify "presents data"
   only when the brief asks for a visual assertion or cheap checks are ambiguous.
4. **Emit a verdict.** The report ends with `HEALTH_VERDICT: HEALTHY|DEGRADED|DOWN
   — <reason>`.

## Verdict surfacing

`finalizeAgentRunReport` (`lib/agents/agent-run-report.ts`) routes `agent:health`
jobs to `applyHealthVerdict` (`lib/agents/health-report.ts`), which:

- parses the `HEALTH_VERDICT` line (an unparseable report defaults to **DEGRADED**
  — a health run never fails silent);
- persists `contextMeta.healthVerdict = { verdict, reason, at }` on the job;
- **DEGRADED / DOWN** → upserts an `app_health` recommendation (attention feed);
  **HEALTHY** → resolves any open one (recovery self-clears).

**DOWN** additionally becomes a red `app_down` inbox signal, derived statelessly
in `deriveInboxSignals` (`lib/workflows/inbox.ts`) from the latest `agent:health`
job's persisted verdict — a later HEALTHY/DEGRADED run supersedes it and the
signal self-clears. A down production app is thus never silent (merge-or-HITL
invariant).

## Per-app brief — `docs/HEALTH.md` in each target repo

Each tracked project declares its own health facts in a committed `docs/HEALTH.md`
(read from the trusted ref). Suggested shape:

```markdown
# Health — <app>
- URL: <prod/qa url>  (health: <path> → <expected status>)
- Presents-data: <what "serving real data" means: content / JSON path / row count>
- Deploy: <host / PM2 app / port / container / platform>
- Logs: <Loki labels @ tunnel · pm2 app · platform log command · or "none">
- Healthy-signals: <log lines / metrics that mean OK>
- Known-noise: <log patterns that are NOT alerts>
- Thresholds: <what makes it DEGRADED vs DOWN>
```

Fleet monitoring facts already live in the workspace `CLAUDE.md` (Loki/PM2 tables)
and can seed these briefs incrementally.

## Operator control

The seeded `health` row is a normal user agent: enable/disable and retune its
schedule/model in `/agents`; it is re-seeded on next boot if deleted (idempotent
by name). It does not appear in the "Add agent" template list (auto-seeded entries
are excluded from `RECOMMENDED_AGENTS`).
