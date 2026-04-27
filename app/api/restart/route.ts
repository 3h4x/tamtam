import { NextResponse } from 'next/server';
import { exec } from '@/lib/shell';

export async function POST() {
  // Schedule PM2 restart after responding — this way the caller gets a clean exit 0
  // before TamTam is killed. Running `pm2 restart tamtam` synchronously inside an
  // action job would kill the server mid-tracking, producing exit -1 and duplicate
  // log output on reconnect.
  setTimeout(() => {
    exec('pm2', ['restart', 'tamtam', '--update-env']).catch(() => {});
  }, 200);

  return NextResponse.json({ status: 'restarting' });
}
