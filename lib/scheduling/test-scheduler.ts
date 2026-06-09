// In-process scheduler for per-project test cron.
//
// Previously this installed a PM2 cron entry per project. PM2's
// `--no-autostart` + `--cron` combination silently no-ops (cron tick updates
// metadata but never starts the stopped process), so test cron jobs registered
// that way never actually fired. The current implementation uses a plain
// in-process `setInterval` for each project, mirroring the pattern in
// `internal-scheduler.ts` for scheduled agents.
//
// Each timer fires by POSTing `/api/projects/by-project/<projectName>/test`,
// the same endpoint the manual "Test" button hits. Failures don't disable
// the schedule — the next tick just tries again.

import { stableHash } from './fire-times';

export function parseTestScheduleToCron(schedule: string): string {
  // Retained for the config-route validator. Returns the cron expression the
  // legacy PM2 path used to install; today the value is only inspected for
  // shape validity. Throws on unparseable input so the config route can
  // surface a 400 before persisting bad data.
  const s = schedule.trim();
  if (s.endsWith('m')) {
    const mins = parseInt(s.slice(0, -1), 10);
    if (!Number.isFinite(mins) || mins <= 0) throw new Error(`Invalid schedule: ${schedule}`);
    if (mins < 60) return `*/${mins} * * * *`;
    const hours = Math.floor(mins / 60);
    return `0 */${hours} * * *`;
  }
  if (s.endsWith('h')) {
    const hours = parseInt(s.slice(0, -1), 10);
    if (!Number.isFinite(hours) || hours <= 0) throw new Error(`Invalid schedule: ${schedule}`);
    return `0 */${hours} * * *`;
  }
  if (s.endsWith('d')) {
    const days = parseInt(s.slice(0, -1), 10);
    if (!Number.isFinite(days) || days <= 0) throw new Error(`Invalid schedule: ${schedule}`);
    if (days === 1) return `0 0 * * *`;
    return `0 0 */${days} * *`;
  }
  if (s.split(/\s+/).length === 5) return s;
  throw new Error(`Invalid schedule: ${schedule} (use 30m, 1h, 6h, 1d, or cron expression)`);
}

function parseScheduleToIntervalMs(schedule: string): number {
  const s = schedule.trim();
  if (s.endsWith('m')) {
    const mins = parseInt(s.slice(0, -1), 10);
    if (!Number.isFinite(mins) || mins <= 0) throw new Error(`Invalid schedule: ${schedule}`);
    return mins * 60_000;
  }
  if (s.endsWith('h')) {
    const hours = parseInt(s.slice(0, -1), 10);
    if (!Number.isFinite(hours) || hours <= 0) throw new Error(`Invalid schedule: ${schedule}`);
    return hours * 3600_000;
  }
  if (s.endsWith('d')) {
    const days = parseInt(s.slice(0, -1), 10);
    if (!Number.isFinite(days) || days <= 0) throw new Error(`Invalid schedule: ${schedule}`);
    return days * 86400_000;
  }
  throw new Error(`Cron expressions not supported by in-process test scheduler: ${schedule}`);
}

type TestScheduleEntry = {
  projectName: string;
  intervalMs: number;
  timer: NodeJS.Timeout;
};

type TestSchedulerGlobals = {
  __tamtamTestScheduler?: { entries: Map<string, TestScheduleEntry>; baseUrl: string };
};

const g = globalThis as TestSchedulerGlobals;
const state = (g.__tamtamTestScheduler ??= {
  entries: new Map<string, TestScheduleEntry>(),
  baseUrl: `http://127.0.0.1:${process.env.PORT || '1337'}`,
});

async function fire(projectName: string): Promise<void> {
  try {
    const url = `${state.baseUrl}/api/projects/by-project/${encodeURIComponent(projectName)}/test`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'X-Tamtam-Trigger': 'test-cron' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      console.warn(`[test-scheduler] ${projectName} fire returned HTTP ${res.status}`);
    }
  } catch (err) {
    console.warn(`[test-scheduler] ${projectName} fire threw:`, err instanceof Error ? err.message : err);
  }
}

export async function installTestSchedule(projectName: string, schedule: string): Promise<void> {
  await uninstallTestSchedule(projectName);
  const intervalMs = parseScheduleToIntervalMs(schedule);
  // Stagger the first fire by a stable per-project offset so multiple test
  // crons registered around boot don't stampede the test queue together.
  const initialDelay = Math.min(intervalMs, 30_000 + stableHash(`test-cron:${projectName}`, 60_000));
  const timer = setTimeout(() => {
    // The initial setTimeout has fired. If the entry was uninstalled (or
    // reinstalled, which uninstalls first) during the initial delay, our
    // `timer` is no longer the registered one — bail without firing or
    // promoting to an interval. Otherwise an old install's interval would
    // continue firing as an orphan after the entry has been replaced.
    const current = state.entries.get(projectName);
    if (!current || current.timer !== timer) return;
    void fire(projectName);
    const interval = setInterval(() => {
      // Same check applies on every tick: if we've been uninstalled the
      // interval needs to self-clear, otherwise it leaks.
      const e = state.entries.get(projectName);
      if (!e || e.timer !== interval) {
        clearInterval(interval);
        return;
      }
      void fire(projectName);
    }, intervalMs);
    interval.unref?.();
    // Re-read after starting the interval — uninstall could have raced
    // between the `current.timer !== timer` check and now.
    const stillUs = state.entries.get(projectName);
    if (stillUs && stillUs.timer === timer) {
      stillUs.timer = interval;
    } else {
      clearInterval(interval);
    }
  }, initialDelay);
  timer.unref?.();
  state.entries.set(projectName, { projectName, intervalMs, timer });
}

export async function uninstallTestSchedule(projectName: string): Promise<void> {
  const existing = state.entries.get(projectName);
  if (!existing) return;
  clearTimeout(existing.timer);
  clearInterval(existing.timer);
  state.entries.delete(projectName);
}
