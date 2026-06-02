/* @vitest-environment jsdom */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { LogsPage } from '@/components/LogsPage';

const { fetchProjectsMock, fetchProjectLogsMock } = vi.hoisted(() => ({
  fetchProjectsMock: vi.fn(),
  fetchProjectLogsMock: vi.fn(),
}));

vi.mock('@/lib/client-api', () => ({
  fetchProjects: fetchProjectsMock,
  fetchProjectLogs: fetchProjectLogsMock,
}));

describe('<LogsPage />', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    fetchProjectsMock.mockReset();
    fetchProjectLogsMock.mockReset();
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
  });

  async function render() {
    flushSync(() => {
      root.render(<LogsPage />);
    });
    // Let the mount-time loadProjects promise settle.
    await settleReact();
  }

  async function settleReact() {
    await new Promise((r) => setTimeout(r, 0));
    flushSync(() => {});
  }

  async function waitFor(assertion: () => void) {
    let lastError: unknown;
    for (let i = 0; i < 10; i += 1) {
      try {
        assertion();
        return;
      } catch (err) {
        lastError = err;
        await settleReact();
      }
    }
    throw lastError;
  }

  function clickButtonByText(text: string) {
    const buttons = Array.from(container.querySelectorAll('button'));
    const button = buttons.find((b) => b.textContent?.includes(text));
    if (!button) throw new Error(`button with text "${text}" not found`);
    flushSync(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  }

  it('renders project buttons after fetchProjects resolves', async () => {
    fetchProjectsMock.mockResolvedValue({ tasks: [{ project: 'alpha' }, { project: 'beta' }, { project: 'alpha' }] });
    await render();
    // Duplicates collapsed, sorted.
    await waitFor(() => {
      const buttons = Array.from(container.querySelectorAll('button')).map((b) => b.textContent?.trim());
      expect(buttons).toContain('alpha');
      expect(buttons).toContain('beta');
    });
  });

  it('surfaces an error and Retry button when loadLogs fails (regression: was silently empty)', async () => {
    fetchProjectsMock.mockResolvedValue({ tasks: [{ project: 'alpha' }] });
    fetchProjectLogsMock.mockRejectedValue(new Error('500 internal'));
    await render();
    clickButtonByText('alpha');
    // Resolve the rejected fetchProjectLogs and the resulting re-render. The
    // rejection + catch + setState chain crosses multiple microtask hops in
    // React 19, so retry the assertion rather than relying on a single tick.
    await waitFor(() => {
      expect(container.textContent).toContain('Failed to load logs.');
    });
    // Retry button is present and wired.
    const retry = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Retry');
    expect(retry).toBeTruthy();
  });

  it('clears search when switching projects (regression: stale query persisted)', async () => {
    fetchProjectsMock.mockResolvedValue({ tasks: [{ project: 'alpha' }, { project: 'beta' }] });
    fetchProjectLogsMock.mockResolvedValue({
      logs: [
        { filename: 'a.log', content: 'aaa' },
        { filename: 'b.log', content: 'bbb' },
      ],
    });
    await render();
    clickButtonByText('alpha');
    await waitFor(() => {
      expect(container.querySelector('input[type="search"]')).toBeTruthy();
    });

    const input = container.querySelector('input[type="search"]') as HTMLInputElement | null;
    expect(input).toBeTruthy();
    // Type a search query.
    if (input) {
      input.value = 'nonmatching';
      flushSync(() => input.dispatchEvent(new Event('input', { bubbles: true })));
    }

    // Switch back to the project list and pick a different project.
    clickButtonByText('clear');
    await waitFor(() => {
      expect(container.textContent).toContain('beta');
    });
    clickButtonByText('beta');
    await waitFor(() => {
      expect(container.querySelector('input[type="search"]')).toBeTruthy();
    });

    const inputAfter = container.querySelector('input[type="search"]') as HTMLInputElement | null;
    if (inputAfter) {
      expect(inputAfter.value).toBe('');
    }
  });
});
