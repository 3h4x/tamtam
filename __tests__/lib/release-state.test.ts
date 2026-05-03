import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('release-state', () => {
  let hasFreshLgtm: typeof import('@/lib/pipeline/release-state').hasFreshLgtm
  let hasLocalCommitsAhead: typeof import('@/lib/pipeline/release-state').hasLocalCommitsAhead
  let execMock: ReturnType<typeof vi.fn>
  let listJobsMock: ReturnType<typeof vi.fn>
  let getVerdictMock: ReturnType<typeof vi.fn>
  let isReviewedMock: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.resetModules()
    execMock = vi.fn()
    listJobsMock = vi.fn().mockReturnValue([])
    getVerdictMock = vi.fn().mockReturnValue(null)
    isReviewedMock = vi.fn().mockResolvedValue(false)

    vi.doMock('@/lib/shared/shell', () => ({ exec: execMock }))
    vi.doMock('@/lib/jobs/job-storage', () => ({
      listJobs: listJobsMock,
      getVerdict: getVerdictMock,
    }))
    vi.doMock('@/lib/git/git-utils', () => ({
      isReviewed: isReviewedMock,
    }))

    ;({ hasFreshLgtm, hasLocalCommitsAhead } = await import('@/lib/pipeline/release-state'))
  })

  it('returns true only when the latest finished review is LGTM and still fresh', async () => {
    listJobsMock.mockReturnValue([
      { id: 'older', project: 'proj', kind: 'review', finishedAt: 10, exitCode: 0 },
      { id: 'latest', project: 'proj', kind: 'review', finishedAt: 20, exitCode: 0 },
      { id: 'run-1', project: 'proj', kind: 'run', finishedAt: 30, exitCode: 0 },
      { id: 'other-project', project: 'other', kind: 'review', finishedAt: 40, exitCode: 0 },
      { id: 'failed', project: 'proj', kind: 'review', finishedAt: 50, exitCode: 1 },
    ])
    getVerdictMock.mockImplementation((job: { id: string }) => job.id === 'latest' ? 'LGTM' : 'NEEDS ATTENTION')
    isReviewedMock.mockResolvedValue(true)

    await expect(hasFreshLgtm('proj', '/repo/proj')).resolves.toBe(true)
    expect(getVerdictMock).toHaveBeenCalledTimes(1)
    expect(getVerdictMock).toHaveBeenCalledWith(expect.objectContaining({ id: 'latest' }))
    expect(isReviewedMock).toHaveBeenCalledWith('proj', '/repo/proj')
  })

  it('returns false when there is no finished LGTM review or the fingerprint check fails', async () => {
    listJobsMock.mockReturnValue([
      { id: 'latest', project: 'proj', kind: 'review', finishedAt: 20, exitCode: 0 },
    ])
    getVerdictMock.mockReturnValue('NEEDS ATTENTION')

    await expect(hasFreshLgtm('proj', '/repo/proj')).resolves.toBe(false)
    expect(isReviewedMock).not.toHaveBeenCalled()

    getVerdictMock.mockReturnValue('LGTM')
    isReviewedMock.mockResolvedValue(false)

    await expect(hasFreshLgtm('proj', '/repo/proj')).resolves.toBe(false)
    expect(isReviewedMock).toHaveBeenCalledTimes(1)
  })

  it('fails open to false when review lookup throws', async () => {
    listJobsMock.mockImplementation(() => {
      throw new Error('boom')
    })

    await expect(hasFreshLgtm('proj', '/repo/proj')).resolves.toBe(false)
  })

  it('detects when local commits are ahead of upstream', async () => {
    execMock.mockResolvedValue({ exitCode: 0, stdout: '3\n', stderr: '' })

    await expect(hasLocalCommitsAhead('/repo/proj')).resolves.toBe(true)
    expect(execMock).toHaveBeenCalledWith(
      'git',
      ['-C', '/repo/proj', 'rev-list', '--count', '@{u}..HEAD'],
      { timeout: 5000 },
    )
  })

  it('returns false for zero, invalid output, non-zero exit, and shell failures', async () => {
    execMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: '0\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'not-a-number\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 1, stdout: '7\n', stderr: 'fatal' })
      .mockRejectedValueOnce(new Error('spawn failed'))

    await expect(hasLocalCommitsAhead('/repo/proj')).resolves.toBe(false)
    await expect(hasLocalCommitsAhead('/repo/proj')).resolves.toBe(false)
    await expect(hasLocalCommitsAhead('/repo/proj')).resolves.toBe(false)
    await expect(hasLocalCommitsAhead('/repo/proj')).resolves.toBe(false)
  })
})
