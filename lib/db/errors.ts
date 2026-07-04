function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const direct = (error as { code?: unknown }).code;
  if (typeof direct === 'string') return direct;
  const cause = (error as { cause?: unknown }).cause;
  if (!cause || typeof cause !== 'object') return undefined;
  const causeCode = (cause as { code?: unknown }).code;
  return typeof causeCode === 'string' ? causeCode : undefined;
}

export function isUndefinedTableError(error: unknown): boolean {
  if (errorCode(error) === '42P01') return true;
  const message = error instanceof Error ? error.message : String(error);
  return /relation "[^"]+" does not exist/.test(message);
}

// Socket-level failures that mean "the Postgres server is not reachable right
// now", not "your query is wrong". A refused connection surfaces as a drizzle
// error whose `.cause` is the happy-eyeballs AggregateError carrying
// `code: 'ECONNREFUSED'`; a dropped peer / bad host / half-open socket surfaces
// as one of the other codes.
const DB_UNAVAILABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EHOSTDOWN',
  'ENETDOWN',
  'EADDRNOTAVAIL',
  'EPIPE',
  // getaddrinfo transient DNS failure — common when pg connects by hostname and
  // the resolver briefly can't answer.
  'EAI_AGAIN',
]);

// Collect candidate error codes from the error, its `.cause`, and any nested
// AggregateError `.errors[]` — Node's happy-eyeballs connect wraps per-address
// failures in an AggregateError, and drizzle wraps that as the `.cause`.
function collectErrorCodes(error: unknown, depth = 0): string[] {
  if (!error || typeof error !== 'object' || depth > 3) return [];
  const codes: string[] = [];
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string') codes.push(code);
  const cause = (error as { cause?: unknown }).cause;
  if (cause) codes.push(...collectErrorCodes(cause, depth + 1));
  const nested = (error as { errors?: unknown }).errors;
  if (Array.isArray(nested)) for (const inner of nested) codes.push(...collectErrorCodes(inner, depth + 1));
  return codes;
}

// pg surfaces server-side unavailability as SQLSTATE class 08 (connection
// exception) or 57P01/57P02/57P03 (admin shutdown / crash shutdown / cannot
// connect now — "the database system is starting up").
function isDbUnavailableSqlState(code: string): boolean {
  return /^08/.test(code) || /^57P0[123]$/.test(code);
}

// This classifier drives storm-QUIETING (reportDbError → serve stale + one
// throttled line), NOT the reachability gate — that uses a dedicated probe
// connection (lib/db/reachability.ts) whose success/failure is unambiguous. So
// it can safely include the codeless pg timeout strings: pg-pool's
// "timeout exceeded when trying to connect", pg-Client's "timeout expired"
// (connectionTimeoutMillis) and "Query read timeout" (query_timeout). Each is
// ambiguous between a saturated/slow-but-healthy server and a dead one, but under
// either it means "this query didn't reach a live server in time", and treating
// it as unavailable only suppresses a log storm (an over-eager quiet self-corrects
// via reportDbOk on the next success). It stays narrow enough to not match a
// server-side statement_timeout ("canceling statement due to statement timeout"),
// which is a healthy server enforcing a per-statement limit.
const DB_UNAVAILABLE_MESSAGE =
  /(timeout exceeded when trying to connect|timeout expired|query read timeout|connection terminated|terminating connection due to administrator|the database system is (starting up|shutting down|in recovery)|could not connect to server|connection refused|server closed the connection unexpectedly)/i;

/**
 * True when an error means Postgres is currently unreachable (down, restarting,
 * or the socket dropped) rather than a genuine query/logic failure. Callers use
 * this to back off and log a single clean "DB unreachable" signal instead of
 * hammering a dead pool and spraying a per-call `AggregateError` stack.
 */
export function isDbUnavailableError(error: unknown): boolean {
  const codes = collectErrorCodes(error);
  if (codes.some((code) => DB_UNAVAILABLE_CODES.has(code) || isDbUnavailableSqlState(code))) return true;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return DB_UNAVAILABLE_MESSAGE.test(message);
}

/**
 * True when the error is a Postgres *server-side* response — the TCP connection
 * reached a live server, which then answered with a 5-char SQLSTATE (e.g. '53300'
 * too_many_connections, '28P01' auth failed, '3D000' unknown database, 'XX000'
 * internal_error, 'P0001' raise_exception). This is "the server is reachable, it
 * just rejected this request", as opposed to a socket-level failure (ECONNREFUSED,
 * connect timeout) that never reached a server. A SQLSTATE is 5 chars from
 * [0-9A-Z] and always contains a digit (the 3-char subclass); Node socket errnos
 * are all-letters ('ECONNREFUSED', 'EPIPE'), so the digit requirement
 * distinguishes a server response from a socket failure even for letter-class
 * SQLSTATEs (XX*, F0*, HV*, P0*).
 *
 * Used by the reachability gate so that a fresh probe connection being refused
 * for a server-side reason (notably a connection-cap 53300, when the app's
 * existing pooled connections are still healthy) is NOT mistaken for an outage.
 * Note: connection-class SQLSTATEs (08*, 57P01/02/03) still count as unavailable
 * via {@link isDbUnavailableError}; callers should check that first.
 */
export function isPostgresServerResponse(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) && /[0-9]/.test(code);
}
