/* @vitest-environment jsdom */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import {
  Labels,
  CheckIcon,
  GateBadge,
  GATE_CLASS,
  GATE_SYMBOL,
  type GateState,
} from '@/components/issues-tab/shared';

describe('<Labels />', () => {
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
  });

  it('returns null for an empty label array (no wrapper rendered)', () => {
    flushSync(() => root.render(<Labels labels={[]} />));
    // No <span> wrapper for an empty list.
    expect(container.querySelector('span')).toBeNull();
  });

  it('renders each label as a pill', () => {
    flushSync(() =>
      root.render(<Labels labels={[{ name: 'bug', color: 'ff0000' }, { name: 'enhancement', color: '00ff00' }]} />)
    );
    expect(container.textContent).toContain('bug');
    expect(container.textContent).toContain('enhancement');
  });

  it('truncates at the limit and shows the +N overflow tag with hidden names in title', () => {
    flushSync(() =>
      root.render(
        <Labels
          labels={[
            { name: 'a', color: '111111' },
            { name: 'b', color: '222222' },
            { name: 'c', color: '333333' },
            { name: 'd', color: '444444' },
            { name: 'e', color: '555555' },
          ]}
          limit={2}
        />
      )
    );
    expect(container.textContent).toContain('a');
    expect(container.textContent).toContain('b');
    expect(container.textContent).toContain('+3');
    // Overflow tag must NOT visually list the hidden names — they live in the title for the hover tooltip.
    expect(container.textContent).not.toContain('c, d, e');
    const overflow = Array.from(container.querySelectorAll('span')).find((s) => s.textContent === '+3');
    expect(overflow?.getAttribute('title')).toBe('c, d, e');
  });
});

describe('<CheckIcon />', () => {
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
  });

  it('renders an animate-spin spinner when status is not COMPLETED', () => {
    flushSync(() => root.render(<CheckIcon conclusion={null} status="IN_PROGRESS" />));
    expect(container.querySelector('svg')?.classList.contains('animate-spin')).toBe(true);
  });

  it('renders a success checkmark when COMPLETED and conclusion is SUCCESS/NEUTRAL/SKIPPED', () => {
    for (const conclusion of ['SUCCESS', 'NEUTRAL', 'SKIPPED']) {
      flushSync(() => root.render(<CheckIcon conclusion={conclusion} status="COMPLETED" />));
      const svg = container.querySelector('svg');
      // Success icon contains a unique path command starting with "M13.78 4.22" (the checkmark path).
      expect(svg?.innerHTML).toContain('M13.78 4.22');
      expect(svg?.classList.contains('animate-spin')).toBe(false);
    }
  });

  it('renders the fail X icon for other conclusions (FAILURE, CANCELLED, ...)', () => {
    flushSync(() => root.render(<CheckIcon conclusion="FAILURE" status="COMPLETED" />));
    const svg = container.querySelector('svg');
    // Fail icon contains the X path "M3.72 3.72".
    expect(svg?.innerHTML).toContain('M3.72 3.72');
  });
});

describe('<GateBadge />', () => {
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
  });

  it('renders the state symbol + label and applies the matching tone class', () => {
    for (const state of ['pass', 'fail', 'warn', 'none'] as GateState[]) {
      flushSync(() => root.render(<GateBadge label="tests" state={state} title="t" />));
      expect(container.textContent).toContain(GATE_SYMBOL[state]);
      expect(container.textContent).toContain('tests');
      const el = container.querySelector('span.inline-flex, button.inline-flex');
      // The tone class string is a 3-class chunk; check the first class for stability.
      const firstToneClass = GATE_CLASS[state].split(' ')[0];
      expect(el?.className).toContain(firstToneClass);
    }
  });

  it('renders as a <button> and invokes onClick on click', () => {
    // Note: the handler also calls stopPropagation(), which matters in
    // practice because GateBadge is nested inside row-level click
    // handlers in IssueRow/PRRow. JSDOM + React's synthetic-event
    // delegation doesn't let us assert that cleanly via native event
    // listeners, so we just verify the onClick fires here; the
    // stopPropagation behavior is exercised by the integration-level
    // tests in `issues-tab.test.ts` that mount the surrounding row.
    const onClick = vi.fn();
    flushSync(() =>
      root.render(<GateBadge label="run review" state="warn" title="t" onClick={onClick} />)
    );
    const btn = container.querySelector('button');
    expect(btn).not.toBeNull();
    btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('renders as a static <span> when no onClick is provided', () => {
    flushSync(() => root.render(<GateBadge label="dod" state="pass" title="t" />));
    expect(container.querySelector('button')).toBeNull();
    expect(container.querySelector('span')).not.toBeNull();
  });

  it('shows the ⟳ spinner symbol when busy and disables the click', () => {
    const onClick = vi.fn();
    flushSync(() =>
      root.render(<GateBadge label="run" state="warn" title="t" onClick={onClick} busy />)
    );
    expect(container.textContent).toContain('⟳');
    // busy disables the button at the DOM level.
    const btn = container.querySelector('button');
    expect((btn as HTMLButtonElement | null)?.disabled).toBe(true);
    btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onClick).not.toHaveBeenCalled();
  });
});
