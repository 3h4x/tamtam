import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';

// Minimal EventSource mock — must be set up before importing the store
let esInstances: MockES[] = [];

class MockES {
  onmessage: ((e: any) => void) | null = null;
  onerror: ((e: any) => void) | null = null;
  private handlers: Record<string, ((e: any) => void)[]> = {};
  closed = false;

  constructor(public url: string) {
    esInstances.push(this);
  }

  addEventListener(type: string, fn: (e: any) => void) {
    (this.handlers[type] ??= []).push(fn);
  }

  emit(type: string, data: string) {
    const e = { data, type } as any;
    if (type === 'message') this.onmessage?.(e);
    else this.handlers[type]?.forEach((h) => h(e));
  }

  emitError() {
    this.onerror?.({} as any);
  }

  close() {
    this.closed = true;
  }
}

beforeAll(() => {
  vi.stubGlobal('EventSource', MockES);
  // Run rAF callbacks synchronously by default so the legacy tests that
  // expect listeners to fire inside update() still pass. Batched-flush
  // behavior is exercised in the dedicated "notification batching" describe
  // below by overriding rAF.
  vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => {
    cb(0);
    return 0;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
});

afterEach(() => {
  esInstances = [];
});

// Use unique project names per test to avoid state leakage between tests
let _ctr = 0;
const proj = () => `store-test-proj-${_ctr++}`;

import { terminalStore } from '@/lib/terminal/terminal-session-store';

describe('TerminalStore – pure state management', () => {
  it('get returns empty state for unknown project', () => {
    const s = terminalStore.get(proj());
    expect(s.history).toEqual([]);
    expect(s.streaming).toBe(false);
    expect(s.streamBuffer).toBe('');
    expect(s.claudeSessionId).toBeNull();
    expect(s.messageQueue).toEqual([]);
    expect(s.pendingAutoSubmit).toBeNull();
    expect(s.sessionKey).toBe('new');
  });

  it('update applies partial patch', () => {
    const p = proj();
    terminalStore.update(p, () => ({ streamBuffer: 'hello', streaming: true }));
    const s = terminalStore.get(p);
    expect(s.streamBuffer).toBe('hello');
    expect(s.streaming).toBe(true);
    // Fields not in patch are unchanged
    expect(s.history).toEqual([]);
  });

  it('update with no return value (void) leaves state unchanged', () => {
    const p = proj();
    terminalStore.update(p, () => ({ claudeSessionId: 'sess-1' }));
    terminalStore.update(p, () => {
      // void updater
    });
    const s = terminalStore.get(p);
    expect(s.claudeSessionId).toBe('sess-1');
  });

  it('subscribe listener is called on update', () => {
    const p = proj();
    const listener = vi.fn();
    terminalStore.subscribe(p, listener);
    terminalStore.update(p, () => ({ streamBuffer: 'x' }));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('subscribe returns an unsubscribe function that removes the listener', () => {
    const p = proj();
    const listener = vi.fn();
    const unsub = terminalStore.subscribe(p, listener);
    unsub();
    terminalStore.update(p, () => ({ streamBuffer: 'y' }));
    expect(listener).not.toHaveBeenCalled();
  });

  it('multiple listeners for same project all get notified', () => {
    const p = proj();
    const l1 = vi.fn();
    const l2 = vi.fn();
    terminalStore.subscribe(p, l1);
    terminalStore.subscribe(p, l2);
    terminalStore.update(p, () => ({ streaming: true }));
    expect(l1).toHaveBeenCalledTimes(1);
    expect(l2).toHaveBeenCalledTimes(1);
  });

  it('listeners for different projects are independent', () => {
    const p1 = proj();
    const p2 = proj();
    const l1 = vi.fn();
    const l2 = vi.fn();
    terminalStore.subscribe(p1, l1);
    terminalStore.subscribe(p2, l2);
    terminalStore.update(p1, () => ({ streaming: true }));
    expect(l1).toHaveBeenCalledTimes(1);
    expect(l2).not.toHaveBeenCalled();
  });

  it('reset returns state to empty', () => {
    const p = proj();
    terminalStore.update(p, () => ({
      history: [{ role: 'user', text: 'hi' }],
      streaming: true,
      streamBuffer: 'partial',
      claudeSessionId: 'sess',
    }));
    terminalStore.reset(p);
    const s = terminalStore.get(p);
    expect(s.history).toEqual([]);
    expect(s.streaming).toBe(false);
    expect(s.streamBuffer).toBe('');
    expect(s.claudeSessionId).toBeNull();
    expect(s.sessionKey).toBe('new');
  });

  it('reset notifies listeners', () => {
    const p = proj();
    const listener = vi.fn();
    terminalStore.subscribe(p, listener);
    terminalStore.reset(p);
    expect(listener).toHaveBeenCalled();
  });

  it('cancelStream returns null jobId when no stream is active', () => {
    const p = proj();
    const jobId = terminalStore.cancelStream(p);
    expect(jobId).toBeNull();
  });

  it('cancelStream appends cancelled error entry to history', () => {
    const p = proj();
    terminalStore.update(p, () => ({
      history: [{ role: 'user', text: 'task' }],
      currentJobId: 'job-xyz',
      streaming: true,
    }));
    terminalStore.cancelStream(p);
    const s = terminalStore.get(p);
    const lastEntry = s.history[s.history.length - 1];
    expect(lastEntry.role).toBe('error');
    expect(lastEntry.text).toBe('cancelled');
  });

  it('cancelStream flushes streamBuffer into history as assistant entry', () => {
    const p = proj();
    terminalStore.update(p, () => ({
      streamBuffer: 'partial output',
      currentJobId: 'job-abc',
      streaming: true,
    }));
    terminalStore.cancelStream(p);
    const s = terminalStore.get(p);
    const assistantEntry = s.history.find((e) => e.role === 'assistant');
    expect(assistantEntry?.text).toBe('partial output');
  });

  it('cancelStream returns the active jobId', () => {
    const p = proj();
    terminalStore.update(p, () => ({ currentJobId: 'job-42', streaming: true }));
    const returned = terminalStore.cancelStream(p);
    expect(returned).toBe('job-42');
  });

  it('cancelStream clears streaming state and message queue', () => {
    const p = proj();
    terminalStore.update(p, () => ({
      currentJobId: 'job-1',
      streaming: true,
      messageQueue: ['next msg'],
      pendingAutoSubmit: 'auto',
    }));
    terminalStore.cancelStream(p);
    const s = terminalStore.get(p);
    expect(s.streaming).toBe(false);
    expect(s.messageQueue).toEqual([]);
    expect(s.pendingAutoSubmit).toBeNull();
    expect(s.currentJobId).toBeNull();
  });

  it('clearPendingAutoSubmit sets pendingAutoSubmit to null', () => {
    const p = proj();
    terminalStore.update(p, () => ({ pendingAutoSubmit: 'submit this' }));
    terminalStore.clearPendingAutoSubmit(p);
    expect(terminalStore.get(p).pendingAutoSubmit).toBeNull();
  });
});

describe('TerminalStore – startStream EventSource integration', () => {
  it('creates EventSource with correct URL', () => {
    const p = proj();
    terminalStore.startStream(p, 'job-stream-1');
    expect(esInstances).toHaveLength(1);
    expect(esInstances[0].url).toBe('/api/streaming/job-stream-1');
    terminalStore.reset(p);
  });

  it('creates EventSource with raw=1 suffix when raw=true', () => {
    const p = proj();
    terminalStore.startStream(p, 'job-raw', true);
    expect(esInstances[0].url).toBe('/api/streaming/job-raw?raw=1');
    terminalStore.reset(p);
  });

  it('sets streaming=true and currentJobId on startStream', () => {
    const p = proj();
    terminalStore.startStream(p, 'job-running');
    const s = terminalStore.get(p);
    expect(s.streaming).toBe(true);
    expect(s.currentJobId).toBe('job-running');
    expect(s.streamStartedAt).not.toBeNull();
    terminalStore.reset(p);
  });

  it('appends text to streamBuffer on onmessage', () => {
    const p = proj();
    terminalStore.startStream(p, 'job-msg');
    const es = esInstances[esInstances.length - 1];
    es.emit('message', 'chunk1');
    es.emit('message', 'chunk2');
    expect(terminalStore.get(p).streamBuffer).toBe('chunk1chunk2');
    terminalStore.reset(p);
  });

  it('appends to thinkingBuffer on thinking event', () => {
    const p = proj();
    terminalStore.startStream(p, 'job-think');
    const es = esInstances[esInstances.length - 1];
    es.emit('thinking', 'hmm');
    expect(terminalStore.get(p).thinkingBuffer).toBe('hmm');
    terminalStore.reset(p);
  });

  it('tool_use flushes streamBuffer to history and adds tool entry', () => {
    const p = proj();
    terminalStore.startStream(p, 'job-tool');
    const es = esInstances[esInstances.length - 1];
    es.emit('message', 'some text before tool');
    es.emit('tool_use', JSON.stringify({ name: 'Read', input: '{"file_path":"/foo"}' }));
    const s = terminalStore.get(p);
    // streamBuffer was flushed
    expect(s.streamBuffer).toBe('');
    // assistant entry added from flushed buffer
    expect(s.history.some((e) => e.role === 'assistant' && e.text === 'some text before tool')).toBe(true);
    // tool added to streamTools
    expect(s.streamTools).toHaveLength(1);
    expect(s.streamTools[0].name).toBe('Read');
    terminalStore.reset(p);
  });

  it('tool_result attaches result to the last tool in streamTools', () => {
    const p = proj();
    terminalStore.startStream(p, 'job-tool-result');
    const es = esInstances[esInstances.length - 1];
    es.emit('tool_use', JSON.stringify({ name: 'Bash', input: '{}' }));
    es.emit('tool_result', JSON.stringify({ content: 'exit 0' }));
    const s = terminalStore.get(p);
    // tool_result flushes the completed tool to history; streamTools is cleared
    const toolEntry = s.history.find((e) => e.role === 'tool' && e.tool?.name === 'Bash');
    expect(toolEntry?.tool?.result).toBe('exit 0');
    terminalStore.reset(p);
  });

  it('done event flushes all buffers to history and sets streaming=false', () => {
    const p = proj();
    terminalStore.startStream(p, 'job-done');
    const es = esInstances[esInstances.length - 1];
    es.emit('thinking', 'planning');
    es.emit('message', 'answer');
    es.emit('done', JSON.stringify({ exitCode: 0, sessionId: 'sess-new', duration: 100, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreateTokens: 0 }));
    const s = terminalStore.get(p);
    expect(s.streaming).toBe(false);
    expect(s.streamBuffer).toBe('');
    expect(s.thinkingBuffer).toBe('');
    expect(s.claudeSessionId).toBe('sess-new');
    // thinking entry
    expect(s.history.some((e) => e.role === 'thinking' && e.text === 'planning')).toBe(true);
    // assistant entry from flushed buffer
    expect(s.history.some((e) => e.role === 'assistant' && e.text === 'answer')).toBe(true);
    // status entry for exit 0
    expect(s.history.some((e) => e.role === 'status' && e.text === 'exit 0 — ok')).toBe(true);
    // stats captured
    expect(s.lastStats?.duration).toBe(100);
    expect(s.lastStats?.inputTokens).toBe(10);
  });

  it('done event with non-zero exitCode adds error entry', () => {
    const p = proj();
    terminalStore.startStream(p, 'job-fail');
    const es = esInstances[esInstances.length - 1];
    es.emit('done', JSON.stringify({ exitCode: 1 }));
    const s = terminalStore.get(p);
    expect(s.history.some((e) => e.role === 'error' && e.text === 'exit 1')).toBe(true);
  });

  it('done event with detail appends an extra error entry', () => {
    const p = proj();
    terminalStore.startStream(p, 'job-detail');
    const es = esInstances[esInstances.length - 1];
    es.emit('done', JSON.stringify({ exitCode: 1, detail: 'log file missing' }));
    const s = terminalStore.get(p);
    const errorEntries = s.history.filter((e) => e.role === 'error');
    expect(errorEntries.length).toBe(2);
    expect(errorEntries[1].text).toBe('log file missing');
  });

  it('done event with error=true surfaces claude run failure + errorText', () => {
    const p = proj();
    terminalStore.startStream(p, 'job-api-err');
    const es = esInstances[esInstances.length - 1];
    es.emit(
      'done',
      JSON.stringify({
        error: true,
        errorText: 'API Error: Stream idle timeout - partial response received',
        duration: 9636496,
        inputTokens: 39,
        outputTokens: 8460,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
        sessionId: 'sess-api-err',
      })
    );
    const s = terminalStore.get(p);
    const errorEntries = s.history.filter((e) => e.role === 'error');
    expect(errorEntries.length).toBe(2);
    expect(errorEntries[0].text).toBe('claude run failed');
    expect(errorEntries[1].text).toBe('API Error: Stream idle timeout - partial response received');
    // stats still captured
    expect(s.lastStats?.duration).toBe(9636496);
    expect(s.lastStats?.outputTokens).toBe(8460);
  });

  it('done event with error=true but no errorText shows only the generic failure line', () => {
    const p = proj();
    terminalStore.startStream(p, 'job-err-no-text');
    const es = esInstances[esInstances.length - 1];
    es.emit('done', JSON.stringify({ error: true }));
    const s = terminalStore.get(p);
    const errorEntries = s.history.filter((e) => e.role === 'error');
    expect(errorEntries.length).toBe(1);
    expect(errorEntries[0].text).toBe('claude run failed');
  });

  it('done event with error=false does not trigger the error path', () => {
    const p = proj();
    terminalStore.startStream(p, 'job-ok');
    const es = esInstances[esInstances.length - 1];
    es.emit('done', JSON.stringify({ error: false, sessionId: 'ok' }));
    const s = terminalStore.get(p);
    expect(s.history.some((e) => e.role === 'error')).toBe(false);
  });

  it('done event dequeues next message into pendingAutoSubmit', () => {
    const p = proj();
    terminalStore.update(p, () => ({ messageQueue: ['next prompt'] }));
    terminalStore.startStream(p, 'job-queue');
    const es = esInstances[esInstances.length - 1];
    es.emit('done', JSON.stringify({ exitCode: 0 }));
    const s = terminalStore.get(p);
    expect(s.pendingAutoSubmit).toBe('next prompt');
    expect(s.messageQueue).toEqual([]);
  });

  it('onerror adds error entry and sets streaming=false', () => {
    const p = proj();
    terminalStore.startStream(p, 'job-error');
    const es = esInstances[esInstances.length - 1];
    es.emitError();
    const s = terminalStore.get(p);
    expect(s.streaming).toBe(false);
    expect(s.history.some((e) => e.role === 'error' && e.text === 'Connection error')).toBe(true);
    expect(s.messageQueue).toEqual([]);
    expect(s.pendingAutoSubmit).toBeNull();
  });

  it('startStream closes previous EventSource before opening new one', () => {
    const p = proj();
    terminalStore.startStream(p, 'job-first');
    const first = esInstances[esInstances.length - 1];
    terminalStore.startStream(p, 'job-second');
    expect(first.closed).toBe(true);
    terminalStore.reset(p);
  });
});

describe('TerminalStore – notification batching', () => {
  let pendingRaf: Array<(t: number) => void> = [];
  beforeAll(() => {
    vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => {
      pendingRaf.push(cb);
      return pendingRaf.length;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      pendingRaf[id - 1] = () => {};
    });
  });
  afterAll(() => {
    // Restore the synchronous-rAF default so any later file (in case of
    // a re-run) doesn't leak the queueing stub.
    vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => {
      cb(0);
      return 0;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });

  afterEach(() => {
    pendingRaf = [];
  });

  function runRaf() {
    const queued = pendingRaf;
    pendingRaf = [];
    for (const cb of queued) cb(0);
  }

  it('coalesces 100 rapid updates into a single listener call', () => {
    const p = proj();
    const listener = vi.fn();
    terminalStore.subscribe(p, listener);
    for (let i = 0; i < 100; i++) {
      terminalStore.update(p, (s) => ({ streamBuffer: s.streamBuffer + 'x' }));
    }
    expect(listener).not.toHaveBeenCalled();
    runRaf();
    expect(listener).toHaveBeenCalledTimes(1);
    // State writes are still synchronous — the buffer reflects all 100 updates.
    expect(terminalStore.get(p).streamBuffer.length).toBe(100);
  });

  it('get() returns the latest state between updates even before flush', () => {
    const p = proj();
    terminalStore.update(p, () => ({ streamBuffer: 'a' }));
    expect(terminalStore.get(p).streamBuffer).toBe('a');
    terminalStore.update(p, () => ({ streamBuffer: 'ab' }));
    expect(terminalStore.get(p).streamBuffer).toBe('ab');
    runRaf();
  });

  it('coalesces across distinct projects within the same frame', () => {
    const p1 = proj();
    const p2 = proj();
    const l1 = vi.fn();
    const l2 = vi.fn();
    terminalStore.subscribe(p1, l1);
    terminalStore.subscribe(p2, l2);
    terminalStore.update(p1, () => ({ streaming: true }));
    terminalStore.update(p2, () => ({ streaming: true }));
    terminalStore.update(p1, () => ({ streamBuffer: 'q' }));
    expect(l1).not.toHaveBeenCalled();
    expect(l2).not.toHaveBeenCalled();
    runRaf();
    expect(l1).toHaveBeenCalledTimes(1);
    expect(l2).toHaveBeenCalledTimes(1);
  });

  it('__flushNotifications flushes synchronously on demand', () => {
    const p = proj();
    const listener = vi.fn();
    terminalStore.subscribe(p, listener);
    terminalStore.update(p, () => ({ streamBuffer: 'sync' }));
    expect(listener).not.toHaveBeenCalled();
    terminalStore.__flushNotifications();
    expect(listener).toHaveBeenCalledTimes(1);
    // Pending rAF should have been cancelled — no second fire on next frame.
    runRaf();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
