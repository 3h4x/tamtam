import { describe, it, expect } from 'vitest';
import { computeAllowedOrigins } from '@/lib/browser-broker/origin-allowlist';

describe('computeAllowedOrigins', () => {
  it('returns empty for all-null input', () => {
    expect(computeAllowedOrigins({ qaUrl: null, devServerReadyUrl: null, website: null })).toEqual([]);
  });

  it('extracts the origin (no path)', () => {
    const r = computeAllowedOrigins({
      qaUrl: 'http://example.com:8080/path/here?q=1',
      devServerReadyUrl: null,
      website: null,
    });
    expect(r).toContain('http://example.com:8080');
  });

  it('adds host.docker.internal twin for localhost', () => {
    const r = computeAllowedOrigins({
      qaUrl: null,
      devServerReadyUrl: 'http://localhost:3000',
      website: null,
    });
    expect(r).toContain('http://localhost:3000');
    expect(r).toContain('http://host.docker.internal:3000');
  });

  it('adds twin for 127.0.0.1', () => {
    const r = computeAllowedOrigins({
      qaUrl: 'http://127.0.0.1:4000',
      devServerReadyUrl: null,
      website: null,
    });
    expect(r).toContain('http://127.0.0.1:4000');
    expect(r).toContain('http://host.docker.internal:4000');
  });

  it('deduplicates across qa/dev/website fields', () => {
    const r = computeAllowedOrigins({
      qaUrl: 'http://example.com',
      devServerReadyUrl: 'http://example.com',
      website: 'http://example.com/landing',
    });
    expect(r).toEqual(['http://example.com']);
  });

  it('ignores garbage URLs', () => {
    const r = computeAllowedOrigins({
      qaUrl: 'not a url',
      devServerReadyUrl: '',
      website: null,
    });
    expect(r).toEqual([]);
  });

  it('preserves https scheme', () => {
    const r = computeAllowedOrigins({
      qaUrl: 'https://staging.example.com',
      devServerReadyUrl: null,
      website: null,
    });
    expect(r).toEqual(['https://staging.example.com']);
  });
});
