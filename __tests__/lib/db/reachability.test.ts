import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { isDbUnavailableError, isPostgresServerResponse } from '@/lib/db/errors';
import {
  ensureDbReachable,
  reportDbError,
  reportDbOk,
  isDbCurrentlyReachable,
  __resetDbReachabilityForTests,
} from '@/lib/db/reachability';

// The pasted production failure: a drizzle query error whose `.cause` is the
// happy-eyeballs AggregateError carrying `code: 'ECONNREFUSED'`.
function connRefusedError(): Error {
  const cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  return Object.assign(new Error('query failed'), { cause });
}

describe('isDbUnavailableError', () => {
  it('classifies an ECONNREFUSED cause chain as DB-unavailable', () => {
    expect(isDbUnavailableError(connRefusedError())).toBe(true);
  });

  it('classifies a bare connection error code', () => {
    expect(isDbUnavailableError(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isDbUnavailableError(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }))).toBe(true);
  });

  it('classifies host-down and transient-DNS codes', () => {
    for (const code of ['ENETDOWN', 'EHOSTDOWN', 'EADDRNOTAVAIL', 'EAI_AGAIN']) {
      expect(isDbUnavailableError(Object.assign(new Error(code), { code }))).toBe(true);
    }
  });

  it('classifies a connection-terminated message', () => {
    expect(isDbUnavailableError(new Error('Connection terminated unexpectedly'))).toBe(true);
  });

  it('classifies a pool/connect timeout as unavailable (for storm-quieting)', () => {
    // Ambiguous between saturation and a dead host, but under either it means the
    // query didn't reach a live server. It is treated as unavailable only to
    // quiet reportDbError callers; the reachability GATE does not rely on this —
    // it uses a dedicated probe connection — so this inclusive match cannot skip
    // the sweep's safety nets under load.
    expect(isDbUnavailableError(new Error('timeout exceeded when trying to connect'))).toBe(true);
  });

  it('classifies pg-Client connect/read timeouts (for storm-quieting)', () => {
    // A black-holed established connection rejects with these codeless messages.
    expect(isDbUnavailableError(new Error('timeout expired'))).toBe(true);
    expect(isDbUnavailableError(new Error('Query read timeout'))).toBe(true);
  });

  it('does NOT classify a statement_timeout (slow query on a healthy DB)', () => {
    expect(isDbUnavailableError(new Error('canceling statement due to statement timeout'))).toBe(false);
  });

  it('classifies pg connection-exception and admin-shutdown SQLSTATEs', () => {
    expect(isDbUnavailableError(Object.assign(new Error('conn failure'), { code: '08006' }))).toBe(true);
    expect(isDbUnavailableError(Object.assign(new Error('starting up'), { code: '57P03' }))).toBe(true);
  });

  it('does NOT classify ordinary errors or a missing-table error', () => {
    expect(isDbUnavailableError(new Error('boom'))).toBe(false);
    expect(isDbUnavailableError(Object.assign(new Error('relation "x" does not exist'), { code: '42P01' }))).toBe(false);
    expect(isDbUnavailableError(undefined)).toBe(false);
  });
});

describe('isPostgresServerResponse', () => {
  it('recognizes digit-first and letter-class SQLSTATEs as a server response', () => {
    for (const code of ['53300', '28P01', '3D000', '08006', '57P03', 'XX000', 'P0001', 'HV000', 'F0000']) {
      expect(isPostgresServerResponse(Object.assign(new Error(code), { code }))).toBe(true);
    }
  });

  it('does NOT treat all-letter Node socket errnos as a server response', () => {
    for (const code of ['EPIPE', 'ECONNREFUSED', 'ETIMEDOUT', 'EHOSTDOWN']) {
      expect(isPostgresServerResponse(Object.assign(new Error(code), { code }))).toBe(false);
    }
    expect(isPostgresServerResponse(new Error('no code'))).toBe(false);
  });
});

describe('reportDbError', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    __resetDbReachabilityForTests();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    __resetDbReachabilityForTests();
  });

  it('returns true for a DB-unavailable error and flips reachability to down', () => {
    expect(isDbCurrentlyReachable()).toBe(true);
    expect(reportDbError('agents-cache', connRefusedError())).toBe(true);
    expect(isDbCurrentlyReachable()).toBe(false);
  });

  it('returns false for an unrelated error and leaves state untouched (caller logs it)', () => {
    expect(reportDbError('agents-cache', new Error('bad query'))).toBe(false);
    expect(isDbCurrentlyReachable()).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs only once across a burst while the DB stays down (no per-call stack storm)', () => {
    for (let i = 0; i < 10; i++) reportDbError('agents-cache', connRefusedError());
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('reportDbOk clears a latched down-state and logs the recovery transition once', () => {
    reportDbError('agents-cache', connRefusedError());
    expect(isDbCurrentlyReachable()).toBe(false);
    warn.mockClear();

    reportDbOk();
    expect(isDbCurrentlyReachable()).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/reachable again/i);

    warn.mockClear();
    reportDbOk(); // idempotent while already reachable
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('ensureDbReachable', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    __resetDbReachabilityForTests();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    __resetDbReachabilityForTests();
  });

  it('returns true when the probe succeeds', async () => {
    expect(await ensureDbReachable(async () => {})).toBe(true);
    expect(isDbCurrentlyReachable()).toBe(true);
  });

  it('returns false and logs once when the probe reports the DB unreachable', async () => {
    const fail = async () => { throw connRefusedError(); };
    expect(await ensureDbReachable(fail)).toBe(false);
    expect(isDbCurrentlyReachable()).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('gates on a connect-level probe failure (server never responded)', async () => {
    // A socket-level failure carries no Postgres SQLSTATE (ECONNREFUSED, a connect
    // timeout's 'timeout expired', or a bare error) → the server was never reached.
    for (const err of [
      Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      new Error('timeout expired'),
      new Error('nope'),
    ]) {
      __resetDbReachabilityForTests();
      expect(await ensureDbReachable(async () => { throw err; })).toBe(false);
      expect(isDbCurrentlyReachable()).toBe(false);
    }
  });

  it('does NOT gate when the server responds with a non-connection error (too_many_connections / auth)', async () => {
    // A fresh probe connection refused with SQLSTATE 53300 (or 28P01) means the
    // server is alive and the app's pooled connections are unaffected — the sweep
    // must keep running its recovery work rather than treat this as an outage.
    const tooMany = Object.assign(new Error('sorry, too many clients already'), { code: '53300' });
    expect(await ensureDbReachable(async () => { throw tooMany; })).toBe(true);
    expect(isDbCurrentlyReachable()).toBe(true);
    expect(warn).not.toHaveBeenCalled();

    const auth = Object.assign(new Error('password authentication failed'), { code: '28P01' });
    expect(await ensureDbReachable(async () => { throw auth; })).toBe(true);

    // Letter-class SQLSTATE (server responded) must also not gate.
    const internal = Object.assign(new Error('internal error'), { code: 'XX000' });
    expect(await ensureDbReachable(async () => { throw internal; })).toBe(true);
  });

  it('DOES gate on a connection-class SQLSTATE (08006 / 57P03) even though the server responded', async () => {
    for (const code of ['08006', '57P03']) {
      __resetDbReachabilityForTests();
      expect(await ensureDbReachable(async () => { throw Object.assign(new Error(code), { code }); })).toBe(false);
    }
  });

  it('logs a recovery line on the down->up transition', async () => {
    await ensureDbReachable(async () => { throw connRefusedError(); });
    warn.mockClear();
    expect(await ensureDbReachable(async () => {})).toBe(true);
    expect(isDbCurrentlyReachable()).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/reachable again/i);
  });
});
