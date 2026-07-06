import { NextRequest, NextResponse } from 'next/server';

const PUBLIC_API = new Set(['/api/health', '/api/auth/check', '/api/auth/login', '/api/auth/logout']);

function isPublicPath(pathname: string): boolean {
  return pathname === '/login'
    || pathname.startsWith('/favicons/')
    || pathname === '/favicon.ico'
    || pathname === '/site.webmanifest'
    || PUBLIC_API.has(pathname);
}

// Auth-check memo. The verify step needs the DB-stored token hash + Node crypto,
// neither available in the Edge middleware runtime, so it delegates to the
// `/api/auth/check` route over an internal fetch. That fetch ran on EVERY
// non-public request — and a project page mounts ~12 requests at once, so the
// server handled ~24 (12 page + 12 auth checks), and even zero-work cache-hit
// endpoints stalled to ~280ms under the burst.
//
// Two guards collapse that:
//   1. Single-flight: concurrent requests with identical credentials share one
//      in-flight check instead of each firing its own — this alone turns the
//      12-request mount burst's auth checks into a single fetch, with no
//      staleness (the checks are simultaneous and identical).
//   2. Short TTL memo: a subsequent request with the same credentials within
//      the TTL reuses the decision instead of re-fetching.
//
// Keyed by the exact credentials the decision depends on (authorization +
// cookie); only real HTTP responses are cached (a transient fetch error is
// denied but not cached, preserving fail-closed behavior). The only trade-off is
// that an auth-config change (setting / rotating / clearing the token) takes up
// to AUTH_CACHE_TTL_MS to be fully enforced — acceptable for a self-hosted tool
// and consistent with the app's other 5s caches. Login/logout stay public, so
// signing in/out is never delayed. Module-level state persists across requests
// in the self-hosted Node process (one middleware sandbox per process).
const AUTH_CACHE_TTL_MS = 5_000;
const authCache = new Map<string, { ok: boolean; time: number }>();
const authInflight = new Map<string, Promise<boolean>>();

/** Test-only: reset the memo so cases don't leak decisions into each other. */
export function _resetAuthCacheForTests(): void {
  authCache.clear();
  authInflight.clear();
}

async function isAuthorized(request: NextRequest): Promise<boolean> {
  const authorization = request.headers.get('authorization') ?? '';
  const cookie = request.headers.get('cookie') ?? '';
  const key = `${authorization}\n${cookie}`;

  const hit = authCache.get(key);
  if (hit && Date.now() - hit.time < AUTH_CACHE_TTL_MS) return hit.ok;

  let pending = authInflight.get(key);
  if (!pending) {
    const checkUrl = new URL('/api/auth/check', request.url);
    pending = fetch(checkUrl, { headers: { authorization, cookie } })
      .then((r) => {
        // Cache only a real decision (200 → ok, 401 → not ok). A network error
        // rejects into the catch below and is not cached, so a transient blip
        // denies exactly one request rather than being memoized.
        const ok = r.ok;
        authCache.set(key, { ok, time: Date.now() });
        return ok;
      })
      .catch(() => false)
      .finally(() => {
        authInflight.delete(key);
      });
    authInflight.set(key, pending);
  }
  return pending;
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (isPublicPath(pathname)) return NextResponse.next();

  if (await isAuthorized(request)) return NextResponse.next();

  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ detail: 'Unauthorized' }, { status: 401 });
  }

  const loginUrl = new URL('/login', request.url);
  loginUrl.searchParams.set('next', request.nextUrl.pathname + request.nextUrl.search);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|.*\\.(?:png|jpg|jpeg|gif|svg|ico|css|js|map|txt)$).*)',
  ],
};
