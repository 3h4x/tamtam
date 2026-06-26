import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, schema } from '@/lib/db';
import { bearerToken, TAMTAM_AUTH_COOKIE, verifyAuthToken } from '@/lib/auth/token';

async function getStoredHash(): Promise<string> {
  const row = (await db
    .select({ value: schema.settings.value })
    .from(schema.settings)
    .where(eq(schema.settings.key, 'auth_token'))
    .limit(1))[0] ?? null;
  return row?.value ?? '';
}

export async function GET(request: NextRequest) {
  const storedHash = await getStoredHash();
  if (!storedHash) {
    return NextResponse.json({ ok: true, configured: false });
  }

  const token = bearerToken(request.headers.get('authorization'))
    || request.cookies.get(TAMTAM_AUTH_COOKIE)?.value
    || '';

  if (token && verifyAuthToken(token, storedHash)) {
    return NextResponse.json({ ok: true, configured: true });
  }

  return NextResponse.json({ ok: false, configured: true }, { status: 401 });
}
