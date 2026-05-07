# Docs Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `+docs` button to the experimental tab that lets users pick `docs/*.md` files from the current project and inject their content into the first message of a session.

**Architecture:** New API route lists and reads `.md` files from the project's `docs/` directory. ExperimentalTab gains parallel docs state (list, selected, picker visibility) mirroring the existing skill picker. On submit, selected doc contents are prepended inline like DB skills — first message only.

**Tech Stack:** Next.js App Router, TypeScript, React, vitest

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `app/api/projects/by-project/[projectName]/docs/route.ts` | Create | List and return `docs/*.md` content |
| `__tests__/api/project-docs.test.ts` | Create | Unit tests for the docs API route |
| `components/ExperimentalTab.tsx` | Modify | Add docs state, picker UI, and injection logic |

---

### Task 1: API route — list project docs

**Files:**
- Create: `app/api/projects/by-project/[projectName]/docs/route.ts`

- [x] **Step 1: Write the failing test**

Create `__tests__/api/project-docs.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('GET /api/projects/by-project/{projectName}/docs', () => {
  let GET: any;
  let resolveProjectPathMock: ReturnType<typeof vi.fn>;
  let tempDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = mkdtempSync(join(tmpdir(), 'tamtam-docs-test-'));

    resolveProjectPathMock = vi.fn().mockReturnValue(tempDir);

    vi.doMock('@/lib/project-data', () => ({
      resolveProjectPath: resolveProjectPathMock,
    }));

    const mod = await import('@/app/api/projects/by-project/[projectName]/docs/route');
    GET = mod.GET;
  });

  afterEach(() => {
    vi.resetModules();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns 404 if project not found', async () => {
    resolveProjectPathMock.mockReturnValue(null);
    const req = new NextRequest('http://localhost/api/projects/by-project/unknown/docs');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'unknown' }) });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.detail).toContain('project not found');
  });

  it('returns empty array when docs dir does not exist', async () => {
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/docs');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.docs).toEqual([]);
  });

  it('returns empty array when docs dir has no .md files', async () => {
    mkdirSync(join(tempDir, 'docs'));
    writeFileSync(join(tempDir, 'docs', 'notes.txt'), 'not markdown');
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/docs');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.docs).toEqual([]);
  });

  it('returns name and content for each .md file', async () => {
    mkdirSync(join(tempDir, 'docs'));
    writeFileSync(join(tempDir, 'docs', 'ARCHITECTURE.md'), '# Architecture\ndetails here');
    writeFileSync(join(tempDir, 'docs', 'API.md'), '# API\nendpoints here');
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/docs');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.docs).toHaveLength(2);
    const names = data.docs.map((d: any) => d.name).sort();
    expect(names).toEqual(['API.md', 'ARCHITECTURE.md']);
    const arch = data.docs.find((d: any) => d.name === 'ARCHITECTURE.md');
    expect(arch.content).toBe('# Architecture\ndetails here');
  });

  it('ignores subdirectories', async () => {
    mkdirSync(join(tempDir, 'docs'));
    mkdirSync(join(tempDir, 'docs', 'subdir'));
    writeFileSync(join(tempDir, 'docs', 'subdir', 'nested.md'), '# Nested');
    writeFileSync(join(tempDir, 'docs', 'top.md'), '# Top');
    const req = new NextRequest('http://localhost/api/projects/by-project/proj1/docs');
    const res = await GET(req, { params: Promise.resolve({ projectName: 'proj1' }) });
    const data = await res.json();
    expect(data.docs).toHaveLength(1);
    expect(data.docs[0].name).toBe('top.md');
  });
});
```

- [x] **Step 2: Run test to confirm it fails**

```bash
cd /Users/3h4x/workspace/tamtam && pnpm test __tests__/api/project-docs.test.ts 2>&1 | tail -20
```

Expected: fails with import error (file doesn't exist yet).

- [x] **Step 3: Create the API route**

Create `app/api/projects/by-project/[projectName]/docs/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { resolveProjectPath } from '@/lib/project-data';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> }
) {
  const { projectName } = await params;
  const projPath = resolveProjectPath(projectName);
  if (!projPath) {
    return NextResponse.json({ detail: 'project not found' }, { status: 404 });
  }

  const docsDir = join(projPath, 'docs');
  if (!existsSync(docsDir)) {
    return NextResponse.json({ docs: [] });
  }

  const docs: { name: string; content: string }[] = [];
  for (const entry of readdirSync(docsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const filePath = join(docsDir, entry.name);
    try {
      const content = readFileSync(filePath, 'utf-8');
      docs.push({ name: entry.name, content });
    } catch {}
  }

  docs.sort((a, b) => a.name.localeCompare(b.name));
  return NextResponse.json({ docs });
}
```

- [x] **Step 4: Run tests to confirm they pass**

```bash
cd /Users/3h4x/workspace/tamtam && pnpm test __tests__/api/project-docs.test.ts 2>&1 | tail -20
```

Expected: all 5 tests pass.

Evidence: `app/api/projects/by-project/[projectName]/docs/route.ts` now sorts `docs/*.md` alphabetically even when no root `README.md` exists, while still keeping `README.md` first when present. Verified with `pnpm test __tests__/api/project-docs.test.ts` and `pnpm type-check` on 2026-05-07.

- [ ] **Step 5: Commit**

```bash
cd /Users/3h4x/workspace/tamtam
git add app/api/projects/by-project/[projectName]/docs/route.ts __tests__/api/project-docs.test.ts
git commit -m "feat: add GET /api/projects/by-project/[name]/docs route"
```

---

### Task 2: ExperimentalTab — docs picker UI and injection

**Files:**
- Modify: `components/ExperimentalTab.tsx`

The changes are:
1. Add docs state (after the skill state block, around line 57)
2. Add `useEffect` to close the docs picker when skill picker opens (and vice versa)
3. Add injection in `handleSubmit` (after DB skill injection, around line 243)
4. Add `+docs` button + picker in the title bar (after the `+skill` block, around line 408)
5. Clear selected docs on new session in `handleNewSession`

- [ ] **Step 1: Add docs state after the skills state block**

In `components/ExperimentalTab.tsx`, find the line:
```typescript
  const [skillUsage, setSkillUsage] = useState<Record<string, number>>(() => {
    try { return JSON.parse(localStorage.getItem('tamtam-skill-usage') || '{}') } catch { return {} }
  })
```

Add immediately after it:

```typescript
  // Docs
  interface DocItem { name: string; content: string }
  const [allDocs, setAllDocs] = useState<DocItem[]>([])
  const [selectedDocs, setSelectedDocs] = useState<DocItem[]>([])
  const [showDocsPicker, setShowDocsPicker] = useState(false)
  const [docsSearch, setDocsSearch] = useState('')
  const docsSearchRef = useRef<HTMLInputElement>(null)
```

- [ ] **Step 2: Add useEffect to focus docs search input**

After the existing `useEffect` that focuses `skillSearchRef`:
```typescript
  useEffect(() => {
    if (showSkillPicker) skillSearchRef.current?.focus()
  }, [showSkillPicker])
```

Add:
```typescript
  useEffect(() => {
    if (showDocsPicker) {
      // Fetch docs list once per picker open if not yet loaded
      if (allDocs.length === 0) {
        fetch(`/api/projects/by-project/${encodeURIComponent(projectName)}/docs`)
          .then(r => r.json())
          .then(data => setAllDocs(data.docs ?? []))
          .catch(() => {})
      }
      docsSearchRef.current?.focus()
    }
  }, [showDocsPicker, projectName, allDocs.length])
```

- [ ] **Step 3: Add filtered docs and toggle function**

After the `toggleItem` function (around line 105), add:

```typescript
  const filteredDocs = allDocs.filter(doc =>
    !selectedDocs.some(d => d.name === doc.name) &&
    (docsSearch === '' || doc.name.toLowerCase().includes(docsSearch.toLowerCase()))
  )

  const toggleDoc = (doc: DocItem) => {
    if (selectedDocs.some(d => d.name === doc.name)) {
      setSelectedDocs(prev => prev.filter(d => d.name !== doc.name))
    } else {
      setSelectedDocs(prev => [...prev, doc])
      setDocsSearch('')
      setShowDocsPicker(false)
    }
  }
```

- [ ] **Step 4: Inject doc content in handleSubmit**

In `handleSubmit`, find the DB skill injection block:
```typescript
      if (!isFollowUp) {
        const dbSkills = selectedItems.filter(s => s.source === 'db' && s.content)
        if (dbSkills.length > 0) {
          const skillContext = dbSkills.map(s => `## ${s.name}\n${s.content}`).join('\n\n---\n\n')
          fullPrompt = skillContext + '\n\n---\n\n' + fullPrompt
        }
      }
```

Replace with:
```typescript
      if (!isFollowUp) {
        const dbSkills = selectedItems.filter(s => s.source === 'db' && s.content)
        if (dbSkills.length > 0) {
          const skillContext = dbSkills.map(s => `## ${s.name}\n${s.content}`).join('\n\n---\n\n')
          fullPrompt = skillContext + '\n\n---\n\n' + fullPrompt
        }
        if (selectedDocs.length > 0) {
          const docContext = selectedDocs.map(d => `## ${d.name}\n${d.content}`).join('\n\n---\n\n')
          fullPrompt = docContext + '\n\n---\n\n' + fullPrompt
        }
      }
```

- [ ] **Step 5: Clear selected docs in handleNewSession**

Find `handleNewSession`:
```typescript
  const handleNewSession = () => {
    esRef.current?.close()
    setClaudeSessionId(null)
    setHistory([])
    streamBufferRef.current = ''
    setStreamBuffer('')
    setDisplayedLength(0)
    setStreaming(false)
    inputRef.current?.focus()
  }
```

Replace with:
```typescript
  const handleNewSession = () => {
    esRef.current?.close()
    setClaudeSessionId(null)
    setHistory([])
    streamBufferRef.current = ''
    setStreamBuffer('')
    setDisplayedLength(0)
    setStreaming(false)
    setSelectedDocs([])
    inputRef.current?.focus()
  }
```

- [ ] **Step 6: Add +docs button and picker to title bar**

Find the closing `</div>` after the `+skill` picker block (after line 408):
```typescript
            </div>
            <select
```

Add between the `</div>` (closing the +skill relative div) and the `<select>`:

```typescript
            <div className="relative">
              <button
                className="text-[11px] px-2 py-1 h-[26px] rounded bg-[#252525] text-[#888] hover:text-[#ccc] cursor-pointer border-none font-mono leading-none"
                onClick={() => setShowDocsPicker(!showDocsPicker)}
              >
                +docs
              </button>
              {showDocsPicker && (
                <div className="absolute top-full right-0 mt-1 w-72 bg-[#1a1a1a] border border-[#333] rounded-lg shadow-xl z-50 overflow-hidden">
                  <input
                    ref={docsSearchRef}
                    type="text"
                    className="w-full px-3 py-2.5 text-sm bg-[#111] border-b border-[#333] text-[#ccc] outline-none placeholder:text-[#555] font-mono"
                    value={docsSearch}
                    onChange={(e) => setDocsSearch(e.target.value)}
                    placeholder="search docs..."
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') { setShowDocsPicker(false); setDocsSearch('') }
                      if (e.key === 'Enter' && filteredDocs.length > 0) toggleDoc(filteredDocs[0])
                    }}
                  />
                  <div className="max-h-80 overflow-y-auto">
                    {filteredDocs.length === 0 ? (
                      <div className="px-3 py-3 text-xs text-[#555]">
                        {allDocs.length === 0 ? 'no docs' : 'no matches'}
                      </div>
                    ) : (
                      filteredDocs.map(doc => (
                        <button
                          key={doc.name}
                          className="w-full px-3 py-2 text-left text-xs hover:bg-[#252525] cursor-pointer border-none bg-transparent text-[#ccc] font-mono"
                          onClick={() => toggleDoc(doc)}
                        >
                          {doc.name}
                        </button>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>
```

Also add selected doc chips alongside selected skill chips. Find:
```typescript
            {selectedItems.map(item => (
              <span key={item.id} className="text-[10px] px-1.5 py-0.5 rounded bg-accent/15 text-accent font-mono">
                {item.name}
                <button className="ml-1 text-accent/50 hover:text-accent cursor-pointer" onClick={() => toggleItem(item)}>x</button>
              </span>
            ))}
```

Replace with:
```typescript
            {selectedItems.map(item => (
              <span key={item.id} className="text-[10px] px-1.5 py-0.5 rounded bg-accent/15 text-accent font-mono">
                {item.name}
                <button className="ml-1 text-accent/50 hover:text-accent cursor-pointer" onClick={() => toggleItem(item)}>x</button>
              </span>
            ))}
            {selectedDocs.map(doc => (
              <span key={doc.name} className="text-[10px] px-1.5 py-0.5 rounded bg-accent/15 text-accent font-mono">
                {doc.name}
                <button className="ml-1 text-accent/50 hover:text-accent cursor-pointer" onClick={() => toggleDoc(doc)}>x</button>
              </span>
            ))}
```

- [ ] **Step 7: Type-check**

```bash
cd /Users/3h4x/workspace/tamtam && pnpm type-check 2>&1 | tail -20
```

Expected: no errors.

- [ ] **Step 8: Run full test suite**

```bash
cd /Users/3h4x/workspace/tamtam && pnpm test 2>&1 | tail -20
```

Expected: same pass/fail ratio as before (1 pre-existing failure in config.test.ts, all others pass).

- [ ] **Step 9: Commit**

```bash
cd /Users/3h4x/workspace/tamtam
git add components/ExperimentalTab.tsx
git commit -m "feat: add +docs picker to experimental tab"
```
