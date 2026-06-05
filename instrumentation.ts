// tamtam
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  // Next.js runs this hook inside the build worker too (during "Collecting
  // page data"). Boot work — jobs-cache load, projects-cache warm, cron
  // seeding, the metrics sampler, boot recovery — all hits Postgres, which
  // need not be reachable at build time. Skip it during the build phase so a
  // DB-less `next build` doesn't spray ECONNREFUSED from those background
  // tasks. The real server boot (phase-production-server / dev) still runs it.
  if (process.env.NEXT_PHASE === 'phase-production-build') return;
  const { registerNode } = await import('./instrumentation-node');
  await registerNode();
}
