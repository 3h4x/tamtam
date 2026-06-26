import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { TAMTAM_AUTH_COOKIE, verifyAuthToken } from '@/lib/auth/token';

async function getStoredHash(): Promise<string> {
  const row = (await db
    .select({ value: schema.settings.value })
    .from(schema.settings)
    .where(eq(schema.settings.key, 'auth_token'))
    .limit(1))[0] ?? null;
  return row?.value ?? '';
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  const storedHash = await getStoredHash();
  if (!storedHash) {
    return NextResponse.json({ ok: true, configured: false });
  }
  if (!token || !verifyAuthToken(token, storedHash)) {
    return NextResponse.json({ detail: 'Invalid token' }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true, configured: true });
  response.cookies.set(TAMTAM_AUTH_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  });
  return response;
}
