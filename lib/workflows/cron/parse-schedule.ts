// Schedule parsing + next-fire computation for the cron migration
// (see docs/superpowers/plans/2026-05-15-cron-migration-graphile.md).
//
// Cron-via-graphile-worker code paths import `computeNextFire` from here
// rather than from `lib/scheduling/internal-scheduler.ts` directly so the
// internal scheduler can be deleted without breaking the cron task once
// Phase 4 migration completes.
//
// Right now this is a thin re-export — `computeNextFire` lives in
// `internal-scheduler.ts` because it's still hot-path for the in-memory
// scheduler. When `seed-agent-crons.ts` lands, it'll import from THIS
// file. When the in-memory scheduler is deleted, the function moves here
// physically too.

export { computeNextFire } from '@/lib/scheduling/internal-scheduler';
export { normalizeAgentScheduleOrThrow } from '@/lib/scheduling/agent-schedule';
export { stableHash } from '@/lib/scheduling/fire-times';
