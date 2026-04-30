import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import { join } from 'path';
import { errMsg } from '@/lib/shared/types';

export async function POST(_request: NextRequest) {
  const dbDir = join(process.cwd(), 'data', 'db');
  const dbPath = join(dbDir, 'tamtam.db');

  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const filename = `tamtam-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.db`;
  const backupPath = join(dbDir, filename);

  try {
    const source = new Database(dbPath, { readonly: true });
    await source.backup(backupPath);
    source.close();
    return NextResponse.json({ status: 'ok', filename, path: backupPath });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: `Backup failed: ${errMsg(e)}` },
      { status: 500 }
    );
  }
}
