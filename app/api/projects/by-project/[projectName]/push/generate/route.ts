import { NextRequest, NextResponse } from 'next/server';
import { resolveProjectPath } from '@/lib/project-data';
import { exec } from '@/lib/shell';
import { errMsg } from '@/lib/types';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> }
) {
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
    const commitPrompt = `Output exactly ${numOptions} conventional commit titles, one per line, numbered 1-${numOptions}. No prose, no code blocks, no backticks, no quotes.

${changesSummary}${fileSummary}

Format: <type>: <description>  (types: feat|fix|docs|style|refactor|test|chore|ci|build)
Rules: present tense, ≤50 chars, no trailing period, plain text only.`;

    const { getImproveConfig } = await import('@/lib/scheduling');
    const { claudeBin } = getImproveConfig();
    // Commit message generation is short and latency-sensitive. Always use haiku,
    // regardless of the project's default_model preference.
    const model = 'haiku';

    const result = await exec(claudeBin, ['--print', '--model', model, '-p', commitPrompt], {
      cwd: projPath,
      timeout: 30000,
    });

    const stripWrap = (s: string) =>
      s.replace(/^[`'"*_]+/, '').replace(/[`'"*_]+$/, '').trim();
    const options = result.stdout
      .trim()
      .split('\n')
      .map((l) => l.replace(/^\s*[-*•]\s*/, ''))
      .map((l) => l.replace(/^\d+[.)]\s*/, ''))
      .map(stripWrap)
      .filter((l) => l.length > 0 && /^(feat|fix|docs|style|refactor|test|chore|ci|build|perf|revert)(\(.+\))?:/i.test(l))
      .slice(0, numOptions);

    return NextResponse.json({ options, model, error: null });
  } catch (e: unknown) {
    return NextResponse.json({ options: [], model: 'unknown', error: errMsg(e) });
  }
}
