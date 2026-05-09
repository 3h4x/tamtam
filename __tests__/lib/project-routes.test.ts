import { describe, expect, it } from 'vitest';
import { buildProjectPath, buildProjectTerminalPath } from '@/lib/client/project-routes';

describe('project-routes', () => {
  it('encodes project names for the base project route', () => {
    expect(buildProjectPath('owner/repo name')).toBe('/project/owner%2Frepo%20name');
  });

  it('appends tabs to the encoded base route', () => {
    expect(buildProjectPath('owner/repo name', 'changes')).toBe('/project/owner%2Frepo%20name/changes');
  });

  it('builds terminal session routes ahead of job query routes', () => {
    expect(buildProjectTerminalPath('owner/repo name', { sessionId: 'sess/42', jobId: 'job-1' })).toBe(
      '/project/owner%2Frepo%20name/terminal/sess%2F42',
    );
  });

  it('falls back to an encoded job query when no session id exists', () => {
    expect(buildProjectTerminalPath('owner/repo name', { jobId: 'job 42' })).toBe(
      '/project/owner%2Frepo%20name/terminal?job=job%2042',
    );
  });

  it('returns the bare terminal tab when no terminal target is provided', () => {
    expect(buildProjectTerminalPath('owner/repo name')).toBe('/project/owner%2Frepo%20name/terminal');
  });
});
