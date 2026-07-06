import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock('@/lib/shared/shell', () => ({ exec: mocks.exec }));

import { getPrAuthorLogin } from '@/lib/github/pr-author';

const resp = (exitCode: number, stdout = '', stderr = '') => ({ exitCode, stdout, stderr });

describe('getPrAuthorLogin', () => {
  beforeEach(() => mocks.exec.mockReset());

  it('returns the trimmed author login on success', async () => {
    mocks.exec.mockResolvedValue(resp(0, '3h4x\n'));
    await expect(getPrAuthorLogin('owner/repo', 30)).resolves.toBe('3h4x');
    // Argument array (no shell string) — repo and PR number passed as argv.
    expect(mocks.exec).toHaveBeenCalledWith(
      'gh',
      ['pr', 'view', '30', '--repo', 'owner/repo', '--json', 'author', '--jq', '.author.login'],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
  });

  it('returns the bot login verbatim (e.g. dependabot[bot]) so callers can trust-check it', async () => {
    mocks.exec.mockResolvedValue(resp(0, 'dependabot[bot]\n'));
    await expect(getPrAuthorLogin('owner/repo', 30)).resolves.toBe('dependabot[bot]');
  });

  it('returns null when the lookup fails (non-zero exit) — callers fail closed', async () => {
    mocks.exec.mockResolvedValue(resp(1, '', 'gh: not found'));
    await expect(getPrAuthorLogin('owner/repo', 30)).resolves.toBeNull();
  });

  it('returns null when gh reports no mapped author ("null" or empty)', async () => {
    mocks.exec.mockResolvedValueOnce(resp(0, 'null\n'));
    await expect(getPrAuthorLogin('owner/repo', 30)).resolves.toBeNull();
    mocks.exec.mockResolvedValueOnce(resp(0, '   \n'));
    await expect(getPrAuthorLogin('owner/repo', 30)).resolves.toBeNull();
  });
});
