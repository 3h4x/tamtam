import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import { join } from 'path';
import { checkAuth } from '@/lib/auth';

export async function POST(request: NextRequest) {
  const authError = checkAuth(request);
  if (authError) return authError;

  const dataDir = join(process.cwd(), 'data');
  const dbPath = join(dataDir, 'tamtam.db');

  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const filename = `tamtam-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.db`;
  const backupPath = join(dataDir, filename);

  try {
    const source = new Database(dbPath, { readonly: true });
    await source.backup(backupPath);
    source.close();
    return NextResponse.json({ status: 'ok', filename, path: backupPath });
  } catch (e: any) {
    return NextResponse.json(
      { error: `Backup failed: ${e.message}` },
      { status: 500 }
    );
  }
}
