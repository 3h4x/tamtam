/* @vitest-environment jsdom */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { SessionsPanel, type SessionItem } from '@/components/terminal/SessionsPanel';

function makeSession(overrides: Partial<SessionItem> = {}): SessionItem {
  return {
    id: 'sess-1',
    prompt: 'hello',
    startedAt: Math.floor(Date.now() / 1000),
    finishedAt: Math.floor(Date.now() / 1000),
    sessionId: 'abcd-1234',
    exitCode: 0,
    ...overrides,
  };
}

describe('<SessionsPanel />', () => {
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

  function render(sessions: SessionItem[], loading = false, onRestore = vi.fn()) {
    flushSync(() => {
      root.render(<SessionsPanel sessions={sessions} loadingSessions={loading} onRestore={onRestore} />);
    });
    return onRestore;
  }

  it('shows a skeleton row while loading', () => {
    render([], true);
    expect(container.querySelectorAll('.skeleton').length).toBeGreaterThan(0);
    // No session buttons while loading.
    expect(container.querySelectorAll('button').length).toBe(0);
  });

  it('shows "no recent sessions" when the list is empty and not loading', () => {
    render([]);
    expect(container.textContent).toContain('no recent sessions');
  });

  it('renders a button per session and calls onRestore with the session on click', () => {
    const onRestore = vi.fn();
    const sess = makeSession({ id: 's1', prompt: 'do thing' });
    render([sess], false, onRestore);

    const button = container.querySelector('button');
    expect(button).not.toBeNull();
    expect(button?.textContent).toContain('do thing');
    flushSync(() => button?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onRestore).toHaveBeenCalledWith(sess);
  });

  it('marks running sessions with a pulsing warning dot and "running" title', () => {
    render([makeSession({ finishedAt: null, exitCode: null })]);
    const dot = container.querySelector('span.bg-status-warning');
    expect(dot).not.toBeNull();
    expect(dot?.classList.contains('animate-pulse')).toBe(true);
    expect(dot?.getAttribute('title')).toBe('running');
  });

  it('marks successful sessions with a success dot and "done" title', () => {
    render([makeSession({ exitCode: 0 })]);
    const dot = container.querySelector('span.bg-status-success');
    expect(dot?.getAttribute('title')).toBe('done');
  });

  it('marks failed sessions with an error dot and "exit N" title', () => {
    render([makeSession({ exitCode: 137 })]);
    const dot = container.querySelector('span.bg-status-error');
    expect(dot?.getAttribute('title')).toBe('exit 137');
  });

  it('uses "(no prompt)" placeholder when prompt is null', () => {
    render([makeSession({ prompt: null })]);
    expect(container.textContent).toContain('(no prompt)');
  });

  it('truncates long prompts at 80 chars with an ellipsis', () => {
    const longPrompt = 'x'.repeat(120);
    render([makeSession({ prompt: longPrompt })]);
    // Slice should be 80 chars + '…'. Verify both bounds.
    expect(container.textContent).toContain('x'.repeat(80) + '…');
    expect(container.textContent).not.toContain('x'.repeat(81));
  });

  it('formats seconds/minutes/hours relative time', () => {
    const now = 1_700_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now * 1000));

    render([
      makeSession({ id: 'a', startedAt: now - 5 }),       // 5s
      makeSession({ id: 'b', startedAt: now - 5 * 60 }),  // 5m
      makeSession({ id: 'c', startedAt: now - 3 * 3600 }), // 3h
    ]);

    const text = container.textContent ?? '';
    expect(text).toContain('5s ago');
    expect(text).toContain('5m ago');
    expect(text).toContain('3h ago');
  });
});
