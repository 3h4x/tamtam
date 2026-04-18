import { NextRequest, NextResponse } from 'next/server';
import { checkAuth } from '@/lib/auth';
import { resolveProjectPath } from '@/lib/project-data';
import { exec } from '@/lib/shell';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> }
) {
  const authError = checkAuth(request);
  if (authError) return authError;
  const { projectName } = await params;

  const projPath = resolveProjectPath(projectName);
  if (!projPath) return NextResponse.json({ detail: 'project not found' }, { status: 404 });

  const [nameStatus, untracked, diffStat] = await Promise.all([
    exec('git', ['-C', projPath, 'diff', 'HEAD', '--name-status'], { timeout: 10000 }),
    exec('git', ['-C', projPath, 'ls-files', '--others', '--exclude-standard'], { timeout: 10000 }),
    exec('git', ['-C', projPath, 'diff', 'HEAD', '--stat'], { timeout: 10000 }),
  ]);

  if (!nameStatus.stdout.trim() && !untracked.stdout.trim()) {
    return NextResponse.json({ files: [], summary: 'No changes' });
  }

  const statMap: Record<string, string> = {};
  let summaryLine = '';
  if (diffStat.stdout.trim()) {
    for (const line of diffStat.stdout.trim().split('\n')) {
      if (line.includes('|')) {
        const parts = line.split('|');
        if (parts.length >= 2) statMap[parts[0].trim()] = parts[1].trim();
      } else if (line.includes('changed')) {
        summaryLine = line.trim();
      }
    }
  }

  const files: { status: string; filename: string; stats: string }[] = [];
  if (nameStatus.stdout.trim()) {
    for (const line of nameStatus.stdout.trim().split('\n')) {
      if (!line.trim()) continue;
      const parts = line.split('\t');
      if (parts.length >= 2) {
        files.push({
          status: parts[0],
          filename: parts[parts.length - 1],
          stats: statMap[parts[parts.length - 1]] ?? '',
        });
      }
    }
  }
  if (untracked.stdout.trim()) {
    for (const fname of untracked.stdout.trim().split('\n')) {
      if (fname.trim()) {
        files.push({ status: 'A', filename: fname.trim(), stats: 'new file' });
      }
    }
  }

  return NextResponse.json({ files, summary: summaryLine });
}
