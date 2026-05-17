import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

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
});
