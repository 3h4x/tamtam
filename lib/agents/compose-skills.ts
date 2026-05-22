import { readFileSync } from 'fs'
import { basename, join } from 'path'
import { inArray } from 'drizzle-orm'
import { db, schema } from '@/lib/db'
import { SKILLS_DIR, DATA_SKILLS_DIR } from '@/lib/skills/skills'

const DOCS_BASE = join(SKILLS_DIR, 'docs', 'skills')

export interface ComposedSkillMeta {
  id: string
  name: string
  description: string
  content?: string
  source: 'db' | 'file'
}

export interface ComposedDocMeta {
  name: string
  path: string
}

export interface ComposedSkills {
  /** Skill bodies (DB skills first, then persona files) — joined with `\n\n---\n\n` is the caller's responsibility. */
  parts: string[]
  /** Doc bodies prefixed with `## <basename>\n` headers, in the order requested. */
  docParts: string[]
  metaSkills: ComposedSkillMeta[]
  metaDocs: ComposedDocMeta[]
}

function readSkillFile(path: string): string | null {
  try {
    return readFileSync(/*turbopackIgnore: true*/ path, 'utf-8')
  } catch {
    return null
  }
}

/**
 * Resolve an agent's `skillIds` and `docPaths` into the parts that get merged
 * into the system prompt. Shared between the agent run path and the magic-wand
 * prompt-improvement endpoint so both see the same context.
 *
 * - `skillIds` may contain DB skill UUIDs and `persona:<path>` references.
 * - `docPaths` are project-relative; reads are guarded against path traversal.
 */
export async function composeAgentSkills(
  projPath: string,
  skillIds: string[],
  docPaths: string[],
): Promise<ComposedSkills> {
  const dbSkillIds = skillIds.filter((id) => !id.startsWith('persona:'))
  const personaPaths = skillIds
    .filter((id) => id.startsWith('persona:'))
    .map((id) => id.slice('persona:'.length))

  const docParts: string[] = []
  const metaDocs: ComposedDocMeta[] = []
  for (const docPath of docPaths) {
    const fullPath = join(projPath, docPath)
    if (!fullPath.startsWith(projPath + '/')) continue
    try {
      const content = readFileSync(/*turbopackIgnore: true*/ fullPath, 'utf-8')
      docParts.push(`## ${basename(docPath)}\n${content}`)
      metaDocs.push({ name: basename(docPath), path: docPath })
    } catch {}
  }

  const parts: string[] = []
  const metaSkills: ComposedSkillMeta[] = []
  if (dbSkillIds.length > 0) {
    const rows = await db.select().from(schema.skills).where(inArray(schema.skills.id, dbSkillIds))
    for (const s of rows) {
      parts.push(`## ${s.name}\n${s.content}`)
      metaSkills.push({ id: s.id, name: s.name, description: s.description ?? '', content: s.content, source: 'db' })
    }
  }

  for (const p of personaPaths) {
    // Defense-in-depth: persona paths shipped from the UI are always of the
    // form `<category>/<slug>` (see app/api/projects/personas/route.ts), but
    // skillIds end up persisted in the agents table and could be tampered
    // with via DB writes or an unvetted PATCH. Without this guard,
    // `persona:../../etc/passwd` would compose `${SKILLS_DIR}/docs/skills/
    // ../../etc/passwd.md` — which `path.join` normalises into a path
    // outside the skills directories and `readFileSync` would happily read.
    // Reject any `..` segment, empty segment (double slash, leading slash),
    // or absolute path. Single-dot segments and leading-dot filenames stay
    // allowed — they don't traverse and persona filesystems may legitimately
    // ship `.hidden.md`-style entries.
    const segments = p.split('/')
    if (p.startsWith('/') || segments.some((s) => s === '..' || s === '')) {
      metaSkills.push({ id: `persona:${p}`, name: p, description: p, source: 'file' })
      continue
    }
    const fallbackName = p.split('/').pop() ?? p
    const docsFile = join(DOCS_BASE, `${p}.md`)
    const dataFile = join(DATA_SKILLS_DIR, `${p}.md`)
    // Belt-and-braces: also verify the resolved path stays inside one of
    // the skill roots. Catches any traversal payload that slipped past
    // the segment-level check (e.g. on weird filesystems / encodings).
    const inDocs = docsFile.startsWith(DOCS_BASE + '/')
    const inData = dataFile.startsWith(DATA_SKILLS_DIR + '/')
    if (!inDocs && !inData) {
      metaSkills.push({ id: `persona:${p}`, name: fallbackName, description: p, source: 'file' })
      continue
    }
    const body = (inDocs ? readSkillFile(docsFile) : null)
      ?? (inData ? readSkillFile(dataFile) : null)
    if (body === null) {
      metaSkills.push({ id: `persona:${p}`, name: fallbackName, description: p, source: 'file' })
      continue
    }

    parts.push(body)
    let display = fallbackName
    const fm = body.match(/^---[\s\S]*?\nname:\s*(.+?)\s*\n[\s\S]*?---/)
    if (fm) display = fm[1].trim()
    else {
      const h = body.match(/^#\s+(.+)$/m)
      if (h) display = h[1].trim()
    }
    metaSkills.push({ id: `persona:${p}`, name: display, description: p, source: 'file' })
  }

  return { parts, docParts, metaSkills, metaDocs }
}
