import { NextRequest, NextResponse } from 'next/server';

const PUBLIC_API = new Set(['/api/health', '/api/auth/check', '/api/auth/login', '/api/auth/logout']);

function isPublicPath(pathname: string): boolean {
  return pathname === '/login'
    || pathname.startsWith('/favicons/')
    || pathname === '/favicon.ico'
    || pathname === '/site.webmanifest'
    || PUBLIC_API.has(pathname);
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (isPublicPath(pathname)) return NextResponse.next();

  const checkUrl = new URL('/api/auth/check', request.url);
  const check = await fetch(checkUrl, {
    headers: {
      authorization: request.headers.get('authorization') ?? '',
      cookie: request.headers.get('cookie') ?? '',
    },
  }).catch(() => null);

  if (check?.ok) return NextResponse.next();

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
