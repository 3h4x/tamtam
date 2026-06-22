import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

describe('scripts/rebuild-safe.sh', () => {
  it('keeps draining when a later running-jobs page contains blocking work', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tamtam-rebuild-safe-'));
    try {
      const callsPath = join(dir, 'curl-calls.log');
      const bashEnvPath = join(dir, 'bash-env.sh');

      writeFileSync(bashEnvPath, `curl() {
set -euo pipefail
url="\${@: -1}"
if [[ "$url" == *"/api/settings"* ]]; then
  printf '{"status":"ok"}'
  return 0
fi
printf '%s\\n' "$url" >> "${callsPath}"
if [[ "$url" == *"offset=200"* ]]; then
  printf '{"jobs":[{"id":"blocking","kind":"agent:docs","finished_at":null}],"total":201,"offset":200,"limit":200,"nextOffset":null}'
else
  printf '{"jobs":[{"id":"recoverable","kind":"pr-wait","finished_at":null}],"total":201,"offset":0,"limit":200,"nextOffset":200}'
fi
}
pnpm() {
  return 1
}
# Stub pm2 too: with DRAIN_TIMEOUT=0 the drain loop breaks (not exits) and the
# script proceeds to stop_server(), which otherwise runs the REAL
# \`pm2 stop tamtam\` / \`pm2 delete tamtam\` against the live server running this
# very test suite (the pre-push hook runs \`pnpm test\`). Returning non-zero makes
# \`pm2 describe tamtam\` fail so stop_server treats it as "no entry — nothing to
# stop" and never touches a real process. Keeps the test hermetic.
pm2() {
  return 1
}
`);

      const result = spawnSync('bash', ['scripts/rebuild-safe.sh'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          BASH_ENV: bashEnvPath,
          TMPDIR: dir,
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
