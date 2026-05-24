export function getBrowserLocalStorage(): Storage | null {
  if (typeof document === 'undefined') return null;

  if (typeof process !== 'undefined' && process.versions?.node) {
    return null;
  }

  const view = document.defaultView;
  if (!view) return null;

  try {
    const storage = view.localStorage;
    if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') {
      return null;
    }
    return storage;
  } catch {
    return null;
  }
}

export function readBrowserStorage(key: string): string | null {
  try {
    return getBrowserLocalStorage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeBrowserStorage(key: string, value: string): void {
  try {
    getBrowserLocalStorage()?.setItem(key, value);
  } catch {
    // Storage can be unavailable in private browsing, blocked iframes, and tests.
  }
}

export function readBrowserStorageJson<T>(key: string, fallback: T): T {
  const value = readBrowserStorage(key);
  if (value === null) return fallback;

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
