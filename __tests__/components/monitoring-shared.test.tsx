/* @vitest-environment jsdom */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { SectionHeader } from '@/components/monitoring/shared';

describe('<SectionHeader />', () => {
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

  function render(title: string, status: 'ok' | 'unavailable' | 'issue') {
    flushSync(() => {
      root.render(<SectionHeader title={title} status={status} />);
    });
  }

  it('renders the title verbatim', () => {
    render('Health', 'ok');
    expect(container.textContent).toContain('Health');
  });

  it('renders "ok" status with the success color class', () => {
    render('x', 'ok');
    expect(container.textContent).toContain('● ok');
    expect(container.querySelector('.text-status-success')).not.toBeNull();
  });

  it('renders "issue" status with the warning color and PLURALIZED label', () => {
    // Type discriminator is the singular `issue` but the displayed label
    // is `issues` — protect that intentional mismatch with an explicit
    // test so future "fixes" of the inconsistency don't silently change
    // the UI string.
    render('x', 'issue');
    expect(container.textContent).toContain('● issues');
    expect(container.querySelector('.text-status-warning')).not.toBeNull();
  });

  it('renders "unavailable" status with the tertiary text color', () => {
    render('x', 'unavailable');
    expect(container.textContent).toContain('● unavailable');
    expect(container.querySelector('.text-text-tertiary')).not.toBeNull();
  });
});
