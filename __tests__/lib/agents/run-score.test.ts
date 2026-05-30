import { describe, expect, it } from 'vitest'
import { computeRunScore } from '@/lib/agents/run-score'

const perfectFiles = JSON.stringify([{ path: 'a.ts', status: 'M', confidence: 'high' }])

describe('computeRunScore', () => {
  it('returns 0 for a failed run with no output', () => {
    expect(computeRunScore({
      exitCode: 1,
      modifiedFiles: null,
      linesAdded: null,
      linesRemoved: null,
      workSummary: null,
    })).toBe(0)
  })

  it('returns 100 for a perfect run with >= 32 lines changed', () => {
    // scoreExit=30, scoreFruitfulness=40, scoreVolume=20 (log2(33)>=5), scoreSummary=10
    expect(computeRunScore({
      exitCode: 0,
      modifiedFiles: perfectFiles,
      linesAdded: 20,
      linesRemoved: 12,
      workSummary: 'Fixed the critical authentication bug and improved error handling.',
    })).toBe(100)
  })

  it('gives 15 exit score when exit non-zero but files changed', () => {
    const score = computeRunScore({
      exitCode: 1,
      modifiedFiles: perfectFiles,
      linesAdded: 5,
      linesRemoved: 0,
      workSummary: null,
    })
    // scoreExit=15, scoreFruitfulness=40, scoreVolume=floor(log2(6)*4)=floor(2.58*4)=10, scoreSummary=0
    expect(score).toBe(65)
  })

  it('gives 15 exit score when a non-zero run only changed low-confidence files', () => {
    const lowFiles = JSON.stringify([{ path: 'a.ts', status: 'M', confidence: 'low' }])
    const score = computeRunScore({
      exitCode: 1,
      modifiedFiles: lowFiles,
      linesAdded: 0,
      linesRemoved: 0,
      workSummary: null,
    })
    // scoreExit=15 (file changed), scoreFruitfulness=0, scoreVolume=0, scoreSummary=0
    expect(score).toBe(15)
  })

  it('gives 30 exit score when a successful run only changed low-confidence files', () => {
    const lowFiles = JSON.stringify([{ path: 'a.ts', status: 'M', confidence: 'low' }])
    const score = computeRunScore({
      exitCode: 0,
      modifiedFiles: lowFiles,
      linesAdded: 0,
      linesRemoved: 0,
      workSummary: null,
    })
    // scoreExit=30 (file changed), scoreFruitfulness=0, scoreVolume=0, scoreSummary=0
    expect(score).toBe(30)
  })

  it('gives 0 fruitfulness when all files are low confidence', () => {
    const lowFiles = JSON.stringify([{ path: 'a.ts', status: 'M', confidence: 'low' }])
    const score = computeRunScore({
      exitCode: 0,
      modifiedFiles: lowFiles,
      linesAdded: 100,
      linesRemoved: 0,
      workSummary: 'x'.repeat(50),
    })
    // scoreExit=30 (exit_code=0), scoreFruitfulness=0 (no high-confidence files),
    // scoreVolume=20 (100 lines), scoreSummary=10 (50 chars)
    expect(score).toBe(60)
  })

  it('gives 5 summary score for short summary', () => {
    const score = computeRunScore({
      exitCode: 0,
      modifiedFiles: perfectFiles,
      linesAdded: 100,
      linesRemoved: 0,
      workSummary: 'ok',
    })
    // scoreExit=30, scoreFruitfulness=40, scoreVolume=20, scoreSummary=5
    expect(score).toBe(95)
  })

  it('caps volume score at 20', () => {
    const score = computeRunScore({
      exitCode: 0,
      modifiedFiles: perfectFiles,
      linesAdded: 10000,
      linesRemoved: 10000,
      workSummary: null,
    })
    // volume=20, no summary=0, total=30+40+20+0=90
    expect(score).toBe(90)
  })

  it('handles null modifiedFiles as zero files', () => {
    const score = computeRunScore({
      exitCode: 0,
      modifiedFiles: null,
      linesAdded: 0,
      linesRemoved: 0,
      workSummary: null,
    })
    // exitCode=0 but no files → scoreExit=0, rest=0
    expect(score).toBe(0)
  })

  it('handles malformed modifiedFiles JSON gracefully', () => {
    expect(() => computeRunScore({
      exitCode: 0,
      modifiedFiles: 'not-json',
      linesAdded: 10,
      linesRemoved: 0,
      workSummary: null,
    })).not.toThrow()
  })

  it('handles missing confidence field as high-confidence', () => {
    const noConfidenceFiles = JSON.stringify([{ path: 'a.ts', status: 'M' }])
    const score = computeRunScore({
      exitCode: 0,
      modifiedFiles: noConfidenceFiles,
      linesAdded: 0,
      linesRemoved: 0,
      workSummary: null,
    })
    // Files without confidence key are NOT 'low', so count as high-confidence
    // scoreExit=30, scoreFruitfulness=40, scoreVolume=0, scoreSummary=0
    expect(score).toBe(70)
  })
})
