import { NextRequest, NextResponse } from 'next/server';
import { resolveProjectPath } from '@/lib/project-data';
import { exec } from '@/lib/shell';
import { statSync } from 'fs';
import { join } from 'path';

type ChangeStatus = 'M' | 'A' | 'D' | 'R' | 'C' | 'U' | 'T';

interface ChangeFile {
  status: ChangeStatus;
  filename: string;
  additions: number;
  deletions: number;
  binary: boolean;
}

// Skip running `git diff --no-index` on huge untracked files; mark binary instead.
const UNTRACKED_SIZE_LIMIT_BYTES = 2 * 1024 * 1024;

// For renames, numstat writes the path as `dir/{old => new}.ext` or `old => new`.
// Resolve to the new path so lookups against `--name-status` entries succeed.
function canonicalizeRenamePath(p: string): string {
  const brace = p.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
  if (brace) return `${brace[1]}${brace[3]}${brace[4]}`;
  const arrow = p.match(/^(.+) => (.+)$/);
  if (arrow) return arrow[2];
  return p;
}

function parseNumstatLine(line: string): { additions: number; deletions: number; binary: boolean; filename: string } | null {
  const parts = line.split('\t');
  if (parts.length < 3) return null;
  const [addStr, delStr] = parts;
  const filename = canonicalizeRenamePath(parts[parts.length - 1]);
  const binary = addStr === '-' && delStr === '-';
  return {
    additions: binary ? 0 : parseInt(addStr, 10) || 0,
    deletions: binary ? 0 : parseInt(delStr, 10) || 0,
    binary,
    filename,
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> }
) {
  const { projectName } = await params;

  const projPath = resolveProjectPath(projectName);
  if (!projPath) return NextResponse.json({ detail: 'project not found' }, { status: 404 });

  const [nameStatus, numstat, untracked, branch] = await Promise.all([
    exec('git', ['-C', projPath, 'diff', 'HEAD', '--name-status'], { timeout: 10000 }),
    exec('git', ['-C', projPath, 'diff', 'HEAD', '--numstat'], { timeout: 10000 }),
    exec('git', ['-C', projPath, 'ls-files', '--others', '--exclude-standard'], { timeout: 10000 }),
    exec('git', ['-C', projPath, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 5000 }),
  ]);

  const statMap: Record<string, { additions: number; deletions: number; binary: boolean }> = {};
  if (numstat.stdout.trim()) {
    for (const line of numstat.stdout.trim().split('\n')) {
      const parsed = parseNumstatLine(line);
      if (!parsed) continue;
      const { filename, additions, deletions, binary } = parsed;
      statMap[filename] = { additions, deletions, binary };
    }
  }

  const files: ChangeFile[] = [];
  const seen = new Set<string>();

  if (nameStatus.stdout.trim()) {
    for (const line of nameStatus.stdout.trim().split('\n')) {
      if (!line.trim()) continue;
      const parts = line.split('\t');
      if (parts.length < 2) continue;
      const status = parts[0][0] as ChangeStatus;
      const filename = parts[parts.length - 1];
      const stats = statMap[filename] ?? { additions: 0, deletions: 0, binary: false };
      files.push({
        status,
        filename,
        additions: stats.additions,
        deletions: stats.deletions,
        binary: stats.binary,
      });
      seen.add(filename);
    }
  }

  const untrackedNames = untracked.stdout
    .trim()
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s && !seen.has(s));

  const untrackedFiles = await Promise.all(
    untrackedNames.map(async (name): Promise<ChangeFile> => {
      let additions = 0;
      let binary = false;
      try {
        const size = statSync(join(projPath, name)).size;
        if (size > UNTRACKED_SIZE_LIMIT_BYTES) {
          binary = true;
        } else {
          const diff = await exec(
            'git',
            ['-C', projPath, 'diff', '--no-index', '--numstat', '/dev/null', name],
            { timeout: 5000 }
          );
          const line = diff.stdout.trim().split('\n')[0];
          if (line) {
            const parts = line.split('\t');
            if (parts[0] === '-') binary = true;
            else additions = parseInt(parts[0], 10) || 0;
          }
        }
      } catch {
        /* file may have been removed or unreadable */
      }
      return { status: 'A', filename: name, additions, deletions: 0, binary };
    })
  );

  files.push(...untrackedFiles);

  const totalAdditions = files.reduce((sum, f) => sum + f.additions, 0);
  const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0);

  return NextResponse.json({
    files,
    totalFiles: files.length,
    totalAdditions,
    totalDeletions,
    branch: branch.stdout.trim() || null,
  });
}
