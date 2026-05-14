import { describe, it, expect } from 'vitest';
import { encode as cborEncode } from 'cbor-x';
import { stringify as devalueStringify } from 'devalue';
import { decodeWorkflowPayload } from '@/lib/workflows/decode-workflow-payload';

/** Build a CBOR-wrapped devalue payload the way the Workflow runtime does. */
function makeWorkflowBytes(value: unknown): Buffer {
  const devalueStr = devalueStringify(value);
  const inner = new TextEncoder().encode(`devl${devalueStr}`);
  const cbor = cborEncode(inner) as Buffer;
  return Buffer.isBuffer(cbor) ? cbor : Buffer.from(cbor);
}

describe('decodeWorkflowPayload', () => {
  it('returns the plain jsonb value when present (skips cbor)', () => {
    const r = decodeWorkflowPayload({ project: 'test-tt', ok: true }, null);
    expect(r).toEqual({ project: 'test-tt', ok: true });
  });

  it('returns null when both inputs are absent', () => {
    expect(decodeWorkflowPayload(null, null)).toBeNull();
    expect(decodeWorkflowPayload(undefined, null)).toBeNull();
  });

  it('returns null when cbor is an empty buffer', () => {
    expect(decodeWorkflowPayload(null, Buffer.alloc(0))).toBeNull();
  });

  it('decodes a CBOR+devalue payload for an array of args', () => {
    const original = ['test-tt', { queueIfBlocked: true }];
    const bytes = makeWorkflowBytes(original);
    expect(decodeWorkflowPayload(null, bytes)).toEqual(original);
  });

  it('decodes a CBOR+devalue payload for a single object arg', () => {
    const original = { project: 'test-tt', agentName: 'workflow-test', jobId: 'job-1' };
    const bytes = makeWorkflowBytes(original);
    expect(decodeWorkflowPayload(null, bytes)).toEqual(original);
  });

  it('roundtrips devalue-specific types (Date, undefined, NaN) without crashing', () => {
    // devalue supports more types than JSON. The decoder should pass them
    // through faithfully — that's the whole point of using devalue.
    const original = { ts: new Date('2026-05-14T20:00:00Z'), missing: undefined, nan: NaN };
    const bytes = makeWorkflowBytes(original);
    const decoded = decodeWorkflowPayload(null, bytes) as typeof original;
    expect(decoded.ts).toBeInstanceOf(Date);
    expect(decoded.ts.toISOString()).toBe('2026-05-14T20:00:00.000Z');
    expect(decoded.missing).toBeUndefined();
    expect(Number.isNaN(decoded.nan)).toBe(true);
  });

  it('returns null on malformed CBOR', () => {
    // Random bytes that aren't valid CBOR.
    const garbage = Buffer.from([0xff, 0xfe, 0xfd, 0xfc, 0xfb]);
    expect(decodeWorkflowPayload(null, garbage)).toBeNull();
  });

  it('returns null on CBOR-wrapped non-Uint8Array (defensive)', () => {
    // CBOR of a plain object (no Uint8Array tag) — function returns it as-is.
    const cbor = cborEncode({ raw: 'object' }) as Buffer;
    expect(decodeWorkflowPayload(null, cbor)).toEqual({ raw: 'object' });
  });

  it('falls back to JSON.parse when prefix is not "devl"', () => {
    // Build a CBOR-wrapped Uint8Array containing plain JSON (no devl prefix).
    const inner = new TextEncoder().encode('{"foo":"bar"}');
    const bytes = cborEncode(inner) as Buffer;
    expect(decodeWorkflowPayload(null, bytes)).toEqual({ foo: 'bar' });
  });

  it('returns null when the devl payload is malformed', () => {
    const inner = new TextEncoder().encode('devl<not-valid-devalue>');
    const bytes = cborEncode(inner) as Buffer;
    expect(decodeWorkflowPayload(null, bytes)).toBeNull();
  });

  it('prefers jsonValue over cborBuffer even when both are set', () => {
    const fromJson = { fromJson: true };
    const fromCbor = makeWorkflowBytes({ fromCbor: true });
    expect(decodeWorkflowPayload(fromJson, fromCbor)).toEqual({ fromJson: true });
  });
});
