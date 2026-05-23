import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('GET /api/projects/personas', () => {
  let GET: any;
  let tempDir: string;
  let skillsDir: string;
  let dataSkillsDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-personas-test-'));
    skillsDir = tempDir;
    dataSkillsDir = join(tempDir, 'data-skills');

    vi.doMock('@/lib/skills/skills', () => ({
      SKILLS_DIR: skillsDir,
      DATA_SKILLS_DIR: dataSkillsDir,
    }));

    const mod = await import('@/app/api/projects/personas/route');
    GET = mod.GET;
  });

  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('fs');
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns empty personas when neither skills dir exists', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.personas).toEqual([]);
  });

  it('returns personas from skill files', async () => {
    const docsSkills = join(skillsDir, 'docs', 'skills', 'engineering');
    mkdirSync(docsSkills, { recursive: true });
    writeFileSync(
      join(docsSkills, 'code-reviewer.md'),
      '---\ntitle: "Code Reviewer"\ndescription: "Reviews code changes"\n---\n\n# Content'
    );

    const res = await GET();
    const data = await res.json();
    expect(data.personas.length).toBe(1);
    expect(data.personas[0].name).toBe('Code Reviewer');
    expect(data.personas[0].description).toBe('Reviews code changes');
    expect(data.personas[0].category).toBe('engineering');
    expect(data.personas[0].path).toBe('engineering/code-reviewer');
  });

  it('returns personas from data/skills', async () => {
    const cat = join(dataSkillsDir, 'custom');
    mkdirSync(cat, { recursive: true });
    writeFileSync(
      join(cat, 'my-skill.md'),
      '---\ntitle: "My Skill"\ndescription: "A custom skill"\n---\n\n# Content'
    );

    const res = await GET();
    const data = await res.json();
    expect(data.personas.length).toBe(1);
    expect(data.personas[0].name).toBe('My Skill');
    expect(data.personas[0].category).toBe('custom');
    expect(data.personas[0].path).toBe('custom/my-skill');
  });

  it('merges personas from both skills dirs', async () => {
    const docsSkills = join(skillsDir, 'docs', 'skills', 'engineering');
    mkdirSync(docsSkills, { recursive: true });
    writeFileSync(join(docsSkills, 'reviewer.md'), '# Reviewer');

    const dataCat = join(dataSkillsDir, 'custom');
    mkdirSync(dataCat, { recursive: true });
    writeFileSync(join(dataCat, 'helper.md'), '# Helper');

    const res = await GET();
    const data = await res.json();
    expect(data.personas.length).toBe(2);
    const paths = data.personas.map((p: any) => p.path);
    expect(paths).toContain('engineering/reviewer');
    expect(paths).toContain('custom/helper');
  });

  it('returns personas from multiple categories', async () => {
    const cat1 = join(skillsDir, 'docs', 'skills', 'engineering');
    const cat2 = join(skillsDir, 'docs', 'skills', 'devops');
    mkdirSync(cat1, { recursive: true });
    mkdirSync(cat2, { recursive: true });

    writeFileSync(join(cat1, 'reviewer.md'), '# Reviewer content');
    writeFileSync(join(cat2, 'deployer.md'), '# Deployer content');

    const res = await GET();
    const data = await res.json();
    expect(data.personas.length).toBe(2);
    const categories = data.personas.map((p: any) => p.category);
    expect(categories).toContain('engineering');
    expect(categories).toContain('devops');
  });

  it('skips index.md files', async () => {
    const cat = join(skillsDir, 'docs', 'skills', 'engineering');
    mkdirSync(cat, { recursive: true });
    writeFileSync(join(cat, 'index.md'), '# Index');
    writeFileSync(join(cat, 'skill.md'), '# Skill');

    const res = await GET();
    const data = await res.json();
    expect(data.personas.length).toBe(1);
    expect(data.personas[0].path).toBe('engineering/skill');
  });

  it('falls back to slug-based name when no frontmatter title', async () => {
    const cat = join(skillsDir, 'docs', 'skills', 'tools');
    mkdirSync(cat, { recursive: true });
    writeFileSync(join(cat, 'my-cool-tool.md'), '# Just plain content, no frontmatter');

    const res = await GET();
    const data = await res.json();
    expect(data.personas[0].name).toBe('My Cool Tool');
  });

  it('caches the empty-personas result so back-to-back hits do not re-scan', async () => {
    // Regression guard: the cache check used to be gated on
    // `data.length > 0`, which meant a workspace with zero personas
    // re-walked the filesystem on every request. The freshness gate is
    // now `time > 0`, so the empty result is cached for the TTL window.
    //
    // Observed via the side-effect: add a persona file AFTER the first
    // empty scan. A working cache returns the empty result. A broken
    // cache (re-scan) sees the new file.
    const first = await GET();
    expect((await first.json()).personas).toEqual([]);

    const cat = join(skillsDir, 'docs', 'skills', 'engineering');
    mkdirSync(cat, { recursive: true });
    writeFileSync(join(cat, 'late.md'), '# Late persona');

    const second = await GET();
    expect((await second.json()).personas).toEqual([]);
  });

  it('skips a category directory that disappears during scan', async () => {
    vi.resetModules();

    const base = join(skillsDir, 'docs', 'skills');
    const vanishedCat = join(base, 'vanished');
    mkdirSync(vanishedCat, { recursive: true });

    vi.doMock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>();
      return {
        ...actual,
        readdirSync: ((pathArg: Parameters<typeof actual.readdirSync>[0], options?: Parameters<typeof actual.readdirSync>[1]) => {
          if (String(pathArg) === vanishedCat) {
            const err = new Error('ENOENT: no such file or directory');
            (err as NodeJS.ErrnoException).code = 'ENOENT';
            throw err;
          }
          return actual.readdirSync(pathArg, options as never);
        }) as typeof actual.readdirSync,
      };
    });
    vi.doMock('@/lib/skills/skills', () => ({
      SKILLS_DIR: skillsDir,
      DATA_SKILLS_DIR: dataSkillsDir,
    }));

    const mod = await import('@/app/api/projects/personas/route');
    const res = await mod.GET();
    expect(res.status).toBe(200);
    expect((await res.json()).personas).toEqual([]);
  });
});
