import { AsyncLocalStorage } from 'async_hooks';

// Tracks the job that triggered the current chained call. Completion hooks
// wrap their child-spawn calls in `runWithParent(parentId, fn)`; createJob
// reads the active parent from this storage and stamps it on the new row.
// AsyncLocalStorage handles concurrent project chains without trampling.
export const parentContext = new AsyncLocalStorage<string>();

export function runWithParent<T>(parentJobId: string, fn: () => Promise<T> | T): Promise<T> | T {
  return parentContext.run(parentJobId, fn);
}

export function currentParent(): string | null {
  return parentContext.getStore() ?? null;
}
