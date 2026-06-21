# Stats Orchestrator Frontend — Implementation Report

## Status
DONE

## Files Changed
- **CREATED** `components/stats/OrchestratorActivity.tsx` — 175 lines
- **MODIFIED** `components/StatsPage.tsx` — added import + `<OrchestratorActivity />` after `<BridgeOverview />`

## Type-check / Lint
- `pnpm type-check`: clean (no output, exit 0)
- `pnpm lint`: clean (no output, exit 0)

## Visual / UX Decisions

### Flag badges
Three badges — "Tuning" (orchestratorEnabled), "Engine" (initiativeEngineEnabled), "Mining" (initiativeMiningEnabled).
On = `bg-accent/10 border-accent/30 text-accent` with a solid accent dot.
Off = `border-border text-text-tertiary` with a muted dot. No one-off color scales.

### Engine-off note
When `initiativeEngineEnabled` is false, a muted `ml-auto` line reads "Initiative engine is off — enable in Settings" so the panel is self-explanatory when empty.

### Stat cards
Two rows of `MiniStat` components styled identically to `StatCard` in StatsPage (border/bg-bg-secondary/rounded-lg), but at `text-xl` (vs `text-2xl`) to keep the panel compact:
- Row 1 (grid-cols-2 lg:grid-cols-4): Queued · Running · Shipped today (N / maxShipsPerDay) · Failed
- Row 2 (grid-cols-3): Boosts (24h) · Autopilot (24h) · Health concerns (24h)
Non-zero values get semantic tone (accent for queued/running, success for shipped, error for failed/health).

### Recent lists
Side-by-side (grid-cols-1 lg:grid-cols-2) compact row lists, capped at 8 rows each.
- Initiatives: project · kind (monospace) · status (toned) · score · ago
  - `updatedAt` in milliseconds → `Math.floor(row.updatedAt / 1_000)` before `fmtAgo`
- Actions: type badge (monospace pill) · project · title (truncated with title attr) · ago
  - `updatedAt` already epoch-seconds → passed directly to `fmtAgo`
Empty arrays render a quiet "No recent …" line.

### Data-private
Project names in both lists carry `data-private` to match the existing privacy pattern in StatsPage.

### Polling
`useEffect` with `setInterval(..., 30_000)` and `cancelled` flag, matching BridgeOverview exactly.
On fetch failure with no prior data, renders nothing (returns null) — never crashes the page.
While loading, renders a `skeleton h-24 rounded-lg` placeholder.
