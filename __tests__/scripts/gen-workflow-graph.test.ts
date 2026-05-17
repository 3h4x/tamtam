import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { PIPELINE_DIAGRAM } from '../../lib/workflows/pipeline-diagram';

describe('scripts/gen-workflow-graph.mjs', () => {
  it('keeps build usable with the committed SVG when Chrome is unavailable', () => {
    const result = spawnSync(
      process.execPath,
      ['scripts/gen-workflow-graph.mjs'],
      {
        cwd: process.cwd(),
        encoding: 'utf-8',
        env: {
          ...process.env,
          PUPPETEER_EXECUTABLE_PATH: '/definitely/not-a-browser',
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('using committed SVG');
  });

  it('documents release-after-run as a dispatch gate, not an issue-work skip', () => {
    expect(PIPELINE_DIAGRAM).toContain('successful run/agent');
    expect(PIPELINE_DIAGRAM).toContain('issue work ok');
    expect(PIPELINE_DIAGRAM).toContain('pending release');
    expect(PIPELINE_DIAGRAM).not.toContain('agent:issue-cruncher');
    expect(PIPELINE_DIAGRAM).not.toContain('ghIssueNumber');
    expect(PIPELINE_DIAGRAM).not.toContain('jobs paused');
  });
});
