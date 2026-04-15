import { NextRequest, NextResponse } from 'next/server';
import { checkAuth } from '@/lib/auth';
import { resolveProjectPath } from '@/lib/project-data';
import { exec } from '@/lib/shell';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> }
) {
  const authError = checkAuth(request);
  if (authError) return authError;
  const { projectName } = await params;

  const projPath = resolveProjectPath(projectName);
  if (!projPath) return NextResponse.json({ detail: 'project not found' }, { status: 404 });

  try {
    const [statusR, porcelainR, diffR] = await Promise.all([
      exec('git', ['-C', projPath, 'diff', '--cached', '--stat'], { timeout: 10000 }),
      exec('git', ['-C', projPath, 'status', '--porcelain'], { timeout: 10000 }),
      exec('git', ['-C', projPath, 'diff', 'HEAD', '--stat', '--no-color'], { timeout: 10000 }),
    ]);

    const fileSummary = statusR.stdout.trim() ? `\n\nFILE STATISTICS:\n${statusR.stdout.trim()}` : '';
    const changesSummary = `\nGIT STATUS:\n${porcelainR.stdout}\nRepository: ${projectName}\n`;

    const numOptions = 5;
    const commitPrompt = `Generate ${numOptions} different conventional commit titles. Be fast and concise.

${changesSummary}${fileSummary}

Format: <type>: <description>
Types: feat, fix, docs, style, refactor, test, chore, ci, build

Rules: One line only, present tense, max 50 chars, no period.

Return ONLY ${numOptions} commit messages, one per line, numbered 1-${numOptions}. No other text.`;

    const { getImproveConfig } = await import('@/lib/scheduling');
    const { claudeBin } = getImproveConfig();

    const result = await exec(claudeBin, ['--print', '-p', commitPrompt], {
      cwd: projPath,
      timeout: 60000,
    });

    const options = result.stdout
      .trim()
      .split('\n')
      .map((l) => l.replace(/^\d+[\.\)]\s*/, '').trim())
      .filter((l) => l.length > 0)
      .slice(0, numOptions);

    return NextResponse.json({ options, model: 'claude', error: null });
  } catch (e: any) {
    return NextResponse.json({ options: [], model: 'unknown', error: e.message });
  }
}
