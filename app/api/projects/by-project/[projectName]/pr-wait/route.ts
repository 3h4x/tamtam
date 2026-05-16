import { NextRequest, NextResponse } from 'next/server';
import { launchPrWait } from '@/lib/pipeline/start-pr-wait';
import { resolveProjectPath } from '@/lib/shared/project-data';
import { exec } from '@/lib/shared/shell';

type Body = {
  prNumber?: number;
  prRepo?: string;
  prUrl?: string;
};

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> },
) {
  const { projectName } = await params;
  let body: Body = {};
  try { body = (await request.json()) as Body; } catch {}

  const prNumber = Number(body.prNumber);
  if (!Number.isFinite(prNumber) || prNumber <= 0) {
    return NextResponse.json({ error: 'prNumber required' }, { status: 400 });
  }

  let prRepo = body.prRepo;
  let prUrl = body.prUrl;

  if (!prRepo || !prUrl) {
    const projPath = resolveProjectPath(projectName);
    if (!projPath) return NextResponse.json({ error: 'project not found' }, { status: 404 });
    const ghOut = await exec('gh', ['pr', 'view', String(prNumber), '--json', 'url,headRepositoryOwner,headRepository'], {
      cwd: projPath,
      timeout: 15000,
    });
    if (ghOut.exitCode !== 0) {
      return NextResponse.json({ error: `gh pr view failed: ${ghOut.stderr || ghOut.stdout}` }, { status: 502 });
    }
    try {
      const parsed = JSON.parse(ghOut.stdout) as {
        url?: string;
        headRepositoryOwner?: { login?: string };
        headRepository?: { name?: string };
      };
      prUrl ||= parsed.url;
      if (!prRepo && parsed.headRepositoryOwner?.login && parsed.headRepository?.name) {
        prRepo = `${parsed.headRepositoryOwner.login}/${parsed.headRepository.name}`;
      }
    } catch (err) {
      return NextResponse.json({ error: `gh pr view parse: ${(err as Error).message}` }, { status: 502 });
    }
  }

  if (!prRepo || !prUrl) {
    return NextResponse.json({ error: 'could not resolve prRepo/prUrl' }, { status: 400 });
  }

  const r = launchPrWait(projectName, prNumber, prRepo, prUrl);
  if ('error' in r) {
    return NextResponse.json({ error: r.error }, { status: 500 });
  }
  return NextResponse.json({ status: 'started', jobId: r.jobId, prNumber, prRepo, prUrl });
}
