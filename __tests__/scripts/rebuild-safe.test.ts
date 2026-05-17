import { describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

describe('scripts/rebuild-safe.sh', () => {
  it('keeps draining when a later running-jobs page contains blocking work', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tamtam-rebuild-safe-'));
    try {
      const callsPath = join(dir, 'curl-calls.log');
      const curlPath = join(dir, 'curl');
      const pnpmPath = join(dir, 'pnpm');

      writeFileSync(curlPath, `#!/usr/bin/env bash
set -euo pipefail
url="\${@: -1}"
if [[ "$url" == *"/api/settings"* ]]; then
  printf '{"status":"ok"}'
  exit 0
fi
printf '%s\\n' "$url" >> "${callsPath}"
if [[ "$url" == *"offset=200"* ]]; then
  printf '{"jobs":[{"id":"blocking","kind":"agent:docs","finished_at":null}],"total":201,"offset":200,"limit":200,"nextOffset":null}'
else
  printf '{"jobs":[{"id":"recoverable","kind":"pr-wait","finished_at":null}],"total":201,"offset":0,"limit":200,"nextOffset":200}'
fi
`);
      writeFileSync(pnpmPath, `#!/usr/bin/env bash
exit 1
`);
      chmodSync(curlPath, 0o755);
      chmodSync(pnpmPath, 0o755);

      const result = spawnSync('bash', ['scripts/rebuild-safe.sh'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH ?? ''}`,
          TAMTAM_BASE_URL: 'http://localhost:1337',
          TAMTAM_REBUILD_DRAIN_TIMEOUT: '0',
          TAMTAM_REBUILD_FORCE: '0',
          TAMTAM_REBUILD_WALL_CLOCK_TIMEOUT: '10',
        },
        encoding: 'utf8',
      });

      expect(result.status).toBe(2);
      expect(result.stdout).toContain('WARN: drain timeout');
      expect(result.stdout).toContain('1 job(s) still running');
      const calls = readFileSync(callsPath, 'utf8');
      expect(calls).toContain('offset=0');
      expect(calls).toContain('offset=200');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
