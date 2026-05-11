import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('GET /api/projects/by-project/[projectName]/logo', () => {
  let GET: typeof import('@/app/api/projects/by-project/[projectName]/logo/route').GET
  let projectRoot: string

  beforeEach(async () => {
    vi.resetModules()
    projectRoot = mkdtempSync(join(tmpdir(), 'tamtam-project-logo-'))

    vi.doMock('@/lib/shared/project-data', () => ({
      resolveProjectPath: vi.fn((projectName: string) => ['demo', 'r&d"'].includes(projectName) ? projectRoot : null),
    }))

    const mod = await import('@/app/api/projects/by-project/[projectName]/logo/route')
    GET = mod.GET
  })

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true })
    vi.resetModules()
  })

  it('returns 404 for unknown projects', async () => {
    const res = await GET({} as Parameters<typeof GET>[0], { params: Promise.resolve({ projectName: 'missing' }) })

    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toEqual({ detail: 'project not found' })
  })

  it('streams a detected logo with the correct content type', async () => {
    mkdirSync(join(projectRoot, 'public'), { recursive: true })
    writeFileSync(join(projectRoot, 'public', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    const res = await GET({} as Parameters<typeof GET>[0], { params: Promise.resolve({ projectName: 'demo' }) })

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/png')
    await expect(res.arrayBuffer()).resolves.toBeInstanceOf(ArrayBuffer)
  })

  it('prefers earlier candidates from the detection allowlist', async () => {
    mkdirSync(join(projectRoot, '.tamtam'), { recursive: true })
    mkdirSync(join(projectRoot, 'public'), { recursive: true })
    writeFileSync(join(projectRoot, '.tamtam', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    writeFileSync(join(projectRoot, 'public', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    const res = await GET({} as Parameters<typeof GET>[0], { params: Promise.resolve({ projectName: 'demo' }) })

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/svg+xml')
    await expect(res.text()).resolves.toContain('<svg')
  })

  it('returns a placeholder logo when no supported local logo is present', async () => {
    const res = await GET({} as Parameters<typeof GET>[0], { params: Promise.resolve({ projectName: 'demo' }) })

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/svg+xml')
    await expect(res.text()).resolves.toContain('<svg')
  })

  it('does not interpolate project names into the placeholder SVG', async () => {
    const projectName = 'r&d"'
    const res = await GET({} as Parameters<typeof GET>[0], { params: Promise.resolve({ projectName }) })
    const svg = await res.text()

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/svg+xml')
    expect(svg).toContain('aria-label="Project logo"')
    expect(svg).not.toContain(projectName)
  })
})
