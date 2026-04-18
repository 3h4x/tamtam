import { resolveProjectPath, clearProjectDataCache } from './project-data';
import { invalidateProject } from './gh-status';
import { exec } from './shell';
import { getSettings } from './config';
import { getImproveConfig } from './scheduling';

export type PushResult =
  | { ok: true; commitSha: string; message: string }
  | { ok: false; status: number; detail: string };

const MAX_PROMPT_CONTEXT_CHARS = 8000;

function truncatePromptContext(s: string): string {
  if (s.length <= MAX_PROMPT_CONTEXT_CHARS) return s;
  return s.slice(0, MAX_PROMPT_CONTEXT_CHARS) + '\n...(truncated)...';
}

async function generateCommitMessage(projPath: string, projectName: string): Promise<string> {
  const [statusR, porcelainR] = await Promise.all([
    exec('git', ['-C', projPath, 'diff', '--cached', '--stat'], { timeout: 10000 }),
    exec('git', ['-C', projPath, 'status', '--porcelain'], { timeout: 10000 }),
  ]);

  const fileSummary = statusR.stdout.trim() ? `\n\nFILE STATISTICS:\n${truncatePromptContext(statusR.stdout.trim())}` : '';
  const changesSummary = `\nGIT STATUS:\n${truncatePromptContext(porcelainR.stdout)}\nRepository: ${projectName}\n`;
  const styleGuide = (getSettings().commit_style ?? '').trim();
  const prompt = `Output exactly one commit title. No prose, no code blocks, no backticks, no quotes.

${changesSummary}${fileSummary}

${styleGuide ? `STYLE GUIDE:\n${styleGuide}\n` : ''}
Return ONLY the title — nothing else.`;

  const { claudeBin } = getImproveConfig();
  const result = await exec(claudeBin, ['--print', '--model', 'haiku', '-p', prompt], {
    cwd: projPath,
    timeout: 30000,
  });
  const line = result.stdout.trim().split('\n')[0] ?? '';
  return line.replace(/^[`'"*_]+/, '').replace(/[`'"*_]+$/, '').trim() || 'chore: automated update';
}

export async function startProjectPush(projectName: string): Promise<PushResult> {
  const projPath = resolveProjectPath(projectName);
  if (!projPath) return { ok: false, status: 404, detail: 'project not found' };

  // Stage all changes including new (untracked) files. .gitignore is expected
  // to exclude secrets — auto-push trusts it.
  await exec('git', ['-C', projPath, 'add', '-A'], { timeout: 10000 });
  const statusR = await exec('git', ['-C', projPath, 'diff', '--cached', '--name-status'], { timeout: 10000 });
  const hasStaged = !!statusR.stdout.trim();

  if (hasStaged) {
    const message = await generateCommitMessage(projPath, projectName);
    const commitR = await exec('git', ['-C', projPath, 'commit', '-m', message], { timeout: 30000 });
    if (commitR.exitCode !== 0 && !commitR.stdout.includes('nothing to commit')) {
      return { ok: false, status: 500, detail: `Commit failed: ${commitR.stderr.trim()}` };
    }
  } else {
    const aheadR = await exec('git', ['-C', projPath, 'rev-list', '--count', '@{u}..HEAD'], { timeout: 5000 });
    const ahead = parseInt(aheadR.stdout.trim(), 10);
    if (!aheadR.stdout.trim() || aheadR.exitCode !== 0 || isNaN(ahead) || ahead === 0) {
      return { ok: true, commitSha: '', message: 'No changes to push' };
    }
  }

  let pushR = await exec('git', ['-C', projPath, 'push'], { timeout: 30000 });
  if (pushR.exitCode !== 0) {
    if (pushR.stderr.includes('no upstream') || pushR.stderr.includes('set-upstream')) {
      const branchR = await exec('git', ['-C', projPath, 'branch', '--show-current'], { timeout: 5000 });
      const branch = branchR.stdout.trim();
      if (branch) {
        pushR = await exec('git', ['-C', projPath, 'push', '-u', 'origin', branch], { timeout: 30000 });
      }
    }
    if (pushR.exitCode !== 0) {
      return { ok: false, status: 502, detail: `Push failed: ${pushR.stderr.trim()}` };
    }
  }

  const shaR = await exec('git', ['-C', projPath, 'rev-parse', '--short', 'HEAD'], { timeout: 5000 });
  const commitSha = shaR.exitCode === 0 ? shaR.stdout.trim() : '';

  invalidateProject(projectName);
  clearProjectDataCache();

  return { ok: true, commitSha, message: 'pushed' };
}
