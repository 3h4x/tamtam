/* @vitest-environment jsdom */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { SchedulerFireTable, type SchedulerInternalEntry } from '@/components/monitoring/SchedulerFireTable';

function makeEntry(overrides: Partial<SchedulerInternalEntry> = {}): SchedulerInternalEntry {
  return {
    agentId: 'agent-1',
    project: 'proj-a',
    name: 'cron-agent',
    schedule: '1h',
    enabled: true,
    nextFireMs: Date.now() + 60_000,
    lastFireMs: Date.now() - 60_000,
    lastJobMs: null,
    fireCount: 1,
    errorCount: 0,
    lastError: null,
    ...overrides,
  };
}

describe('<SchedulerFireTable />', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  function render(entries: SchedulerInternalEntry[]) {
    flushSync(() => {
      root.render(<SchedulerFireTable entries={entries} />);
    });
  }

  it('renders header and "never" placeholder when an entry has no last-fire', () => {
    const now = Date.now();
    render([makeEntry({ agentId: 'a1', lastFireMs: null, lastJobMs: null, nextFireMs: now + 5 * 60_000 })]);
    expect(container.textContent).toContain('Fire history');
    expect(container.textContent).toContain('proj-a/cron-agent');
    expect(container.textContent).toContain('never');
  });

  it('keeps long agent names bounded inside the compact table layout', () => {
    render([
      makeEntry({
        project: 'very-long-owner-name/very-long-project-name',
        name: 'very-long-agent-name-that-should-not-push-status-columns-offscreen',
      }),
    ]);

    const wrapper = container.querySelector('.overflow-x-auto');
    const agentCell = container.querySelector('td');
    const agentLabel = agentCell?.querySelector('[data-private]');

    expect(wrapper?.className).toContain('[&_table]:table-fixed');
    expect(agentCell?.className).toContain('max-w-0');
    expect(agentCell?.className).toContain('overflow-hidden');
    expect(agentLabel?.className).toContain('block');
    expect(agentLabel?.className).toContain('truncate');
  });

  it('formats future fires with "in X" prefix', () => {
    const now = 1_700_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    render([makeEntry({ nextFireMs: now + 5 * 60_000 })]);
    expect(container.textContent).toContain('in 5m');
  });

  it('formats past fires with "X ago" suffix and marks them overdue', () => {
    const now = 1_700_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    render([makeEntry({ nextFireMs: now - 3 * 60_000 })]);
    expect(container.textContent).toContain('3m ago');
    expect(container.textContent).toContain('(1 overdue)');
  });

  it('sorts entries with lastError first, then by nextFireMs', () => {
    const now = 1_700_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    render([
      makeEntry({ agentId: 'a-clean-soon', name: 'clean-soon', nextFireMs: now + 1_000 }),
      makeEntry({ agentId: 'a-error-later', name: 'error-later', nextFireMs: now + 999_999, lastError: 'boom', errorCount: 3 }),
      makeEntry({ agentId: 'a-clean-later', name: 'clean-later', nextFireMs: now + 30_000 }),
    ]);
    // The error row comes first regardless of its later nextFireMs.
    const rendered = container.textContent ?? '';
    const errIdx = rendered.indexOf('error-later');
    const cleanSoonIdx = rendered.indexOf('clean-soon');
    const cleanLaterIdx = rendered.indexOf('clean-later');
    expect(errIdx).toBeGreaterThan(-1);
    expect(errIdx).toBeLessThan(cleanSoonIdx);
    expect(cleanSoonIdx).toBeLessThan(cleanLaterIdx);
  });

  it('renders "Show all N" button only when there are more than 8 entries', () => {
    const entries = Array.from({ length: 9 }, (_, i) =>
      makeEntry({ agentId: `a-${i}`, name: `agent-${i}` }),
    );
    render(entries);
    expect(container.textContent).toContain('Show all 9');

    // Boundary: exactly 8 → no toggle.
    render(entries.slice(0, 8));
    expect(container.textContent).not.toMatch(/Show all/);
  });

  it('shows error count as "fires/errors!" when errors > 0', () => {
    const now = 1_700_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    render([makeEntry({ fireCount: 12, errorCount: 3, lastError: 'boom' })]);
    expect(container.textContent).toContain('12/3!');
  });

  it('uses lastJobMs in preference to lastFireMs when both are present', () => {
    const now = 1_700_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    // lastFireMs is 1h ago, lastJobMs is 10m ago — UI should show the job time.
    render([makeEntry({ lastFireMs: now - 3_600_000, lastJobMs: now - 600_000 })]);
    expect(container.textContent).toContain('10m ago');
    expect(container.textContent).not.toContain('1h ago');
  });
});
