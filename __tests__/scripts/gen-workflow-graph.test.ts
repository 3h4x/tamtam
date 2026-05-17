import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const svgPath = resolve(__dirname, '../../public/workflow-graph.svg');

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

  it('renders the release-after-run gate, not the legacy issue-work skip text', () => {
    const svg = readFileSync(svgPath, 'utf-8');
    expect(svg).toContain('successful run/agent');
    expect(svg).toContain('issue work ok');
    expect(svg).toContain('pending release');
    expect(svg).not.toContain('agent:issue-cruncher');
    expect(svg).not.toContain('ghIssueNumber');
    expect(svg).not.toContain('jobs paused');
  });

  it('does not render duplicate agent-run trigger nodes', () => {
    const svg = readFileSync(svgPath, 'utf-8');
    expect(svg).not.toContain('my-svg-flowchart-agent-run');
    expect(svg).toContain('my-svg-flowchart-agent_run');
    expect(svg).toContain('Agent run');
    expect(svg).not.toMatch(/<p>agent_run<\/p>/);
  });
});
