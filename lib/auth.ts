import { NextRequest, NextResponse } from 'next/server';

export function checkAuth(request: NextRequest): NextResponse | null {
  const token = process.env.Z_API_TOKEN;
  if (!token) return null;
  const authHeader = request.headers.get('authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) {
    return NextResponse.json({ detail: 'Missing or invalid Authorization header' }, { status: 401 });
  }
  if (authHeader.slice(7) !== token) {
    return NextResponse.json({ detail: 'Invalid API token' }, { status: 401 });
  }
  return null;
}
