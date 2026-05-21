/* @vitest-environment jsdom */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ErrorBanner } from '@/components/ErrorBanner';

describe('<ErrorBanner />', () => {
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

  it('renders the supplied message and the alert role', () => {
    flushSync(() => root.render(<ErrorBanner message="Server unreachable" onDismiss={() => {}} />));
    expect(container.textContent).toContain('Server unreachable');
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('uses the text-style warning glyph, NOT the emoji form (regression: previously rendered as ⚠️ with VS16)', () => {
    // The codebase convention is monochrome glyphs (see memory note
    // feedback_no_emoji_use_glyphs.md). Plain U+26A0 renders as a text-style
    // sign; adding U+FE0F (Variation Selector 16) forces emoji presentation.
    // The component must use the plain codepoint to match sibling usages.
    flushSync(() => root.render(<ErrorBanner message="x" onDismiss={() => {}} />));
    expect(container.textContent).toContain('⚠');
    expect(container.textContent).not.toContain('️');
  });

  it('fires onDismiss when the close button is clicked', () => {
    const onDismiss = vi.fn();
    flushSync(() => root.render(<ErrorBanner message="x" onDismiss={onDismiss} />));
    const closeBtn = container.querySelector('button[aria-label="Dismiss error"]');
    expect(closeBtn).not.toBeNull();
    closeBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
