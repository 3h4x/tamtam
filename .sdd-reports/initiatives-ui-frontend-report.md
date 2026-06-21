# Initiatives UI Frontend Report

## Status

Success — all files created, `pnpm type-check` and `pnpm lint` both pass clean.

## Files Changed

| File | Action | Lines |
|------|--------|-------|
| `/Users/3h4x/workspace/tamtam/components/InitiativesPage.tsx` | Created | 286 |
| `/Users/3h4x/workspace/tamtam/components/initiatives/ProjectPreviewRow.tsx` | Created | 95 |
| `/Users/3h4x/workspace/tamtam/app/initiatives/page.tsx` | Created | 5 |
| `/Users/3h4x/workspace/tamtam/components/Header.tsx` | Modified — added `{ to: '/initiatives', label: 'Initiatives' }` after `/recommendations` item | +1 |
| `/Users/3h4x/workspace/tamtam/components/stats/OrchestratorActivity.tsx` | Modified — added `import Link from 'next/link'` and "View backlog →" link in panel header | +4 |

## Line Count of New Components

- `InitiativesPage.tsx`: 286 lines
- `components/initiatives/ProjectPreviewRow.tsx`: 95 lines
- `app/initiatives/page.tsx`: 5 lines (Server Component shell)
- **Total new lines: 386**

## Project-List Helper Reused

`fetchProjects` from `@/lib/client/projects`, which calls `GET /api/projects` and returns `ProjectsResponse`. The `Task[]` array inside provides the project names via `t.project`. This is the same helper used by the main projects page and other components.

## Type-Check / Lint Result

- `pnpm type-check` (tsc --noEmit): **clean, no errors**
- `pnpm lint` (eslint app components lib hooks): **clean, no errors**

## UX Decisions Made

1. **Engine-off notice** shown as a quiet `text-xs text-text-tertiary` line under the header badges, with a link to `/settings`. Consistent with how `OrchestratorActivity` surfaces the same situation.

2. **StatCard grid** uses `grid-cols-2 sm:grid-cols-3 lg:grid-cols-5` so all five status counts (proposed / queued / running / shipped / failed) fit on large screens without wrapping, while gracefully collapsing on mobile. The `maxShipsPerDay` cap is shown as a subtle `note` under the Shipped card.

3. **Per-project independence in Preview**: each `ProjectPreviewRow` manages its own fetch state (`idle → loading → done | error`). Double-click guard via `if (state.kind === 'loading') return`. No global loading state.

4. **Kind badge tone**: a small `KIND_TONE` map colors lint/todo/fixme/test kinds with the semantic status color (warning/accent/error/info). Unknown kinds fall back to `text-text-secondary`.

5. **Table default sort**: `updatedAt` descending so the most recent changes appear first.

6. **fmtAgo** in `InitiativesPage` receives epoch-milliseconds (as documented — `initiatives[].updatedAt` is MS). The `BridgeOverview`/`OrchestratorActivity` helpers receive epoch-seconds; we wrote a distinct helper that does not divide by 1000.

7. **ProjectPreviewRow** extracted as a subcomponent in `components/initiatives/` (per the file-size cap convention: extract when parent would exceed ~400 lines). The parent `InitiativesPage` stays at 286 lines.

8. **"View backlog →" link** in `OrchestratorActivity` header is placed immediately after the `<h2>` title, styled `text-[11px] text-text-tertiary hover:text-accent transition-colors` — subtle, consistent with existing dim metadata links in the panel.

9. **Polling**: `/api/initiatives` polls every 30s with `setInterval` + cancel-on-unmount, matching `BridgeOverview`. The preview endpoint is on-demand only.

10. **Privacy markers**: `data-private` on project name spans in both `InitiativesPage` table and `ProjectPreviewRow` headers, consistent with other components.
