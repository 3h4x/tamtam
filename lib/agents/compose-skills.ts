import { existsSync, readFileSync } from 'fs'
import { basename, join } from 'path'
import { inArray } from 'drizzle-orm'
import { db, schema } from '@/lib/db'
import { SKILLS_DIR, DATA_SKILLS_DIR } from '@/lib/skills/skills'

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

/**
 * Resolve an agent's `skillIds` and `docPaths` into the parts that get merged
 * into the system prompt. Shared between the agent run path and the magic-wand
 * prompt-improvement endpoint so both see the same context.
 *
 * - `skillIds` may contain DB skill UUIDs and `persona:<path>` references.
 * - `docPaths` are project-relative; reads are guarded against path traversal.
 */
export function composeAgentSkills(
  projPath: string,
  skillIds: string[],
  docPaths: string[],
): ComposedSkills {
  const dbSkillIds = skillIds.filter((id) => !id.startsWith('persona:'))
  const personaPaths = skillIds
    .filter((id) => id.startsWith('persona:'))
    .map((id) => id.slice('persona:'.length))

  const docParts: string[] = []
  const metaDocs: ComposedDocMeta[] = []
  for (const docPath of docPaths) {
    const fullPath = join(projPath, docPath)
    if (!fullPath.startsWith(projPath + '/')) continue
    if (existsSync(/*turbopackIgnore: true*/ fullPath)) {
      try {
        const content = readFileSync(/*turbopackIgnore: true*/ fullPath, 'utf-8')
        docParts.push(`## ${basename(docPath)}\n${content}`)
        metaDocs.push({ name: basename(docPath), path: docPath })
      } catch {}
    }
  }

  const parts: string[] = []
  const metaSkills: ComposedSkillMeta[] = []
  if (dbSkillIds.length > 0) {
    const rows = db.select().from(schema.skills).where(inArray(schema.skills.id, dbSkillIds)).all()
    for (const s of rows) {
      parts.push(`## ${s.name}\n${s.content}`)
      metaSkills.push({ id: s.id, name: s.name, description: s.description ?? '', content: s.content, source: 'db' })
    }
  }

  const docsBase = join(SKILLS_DIR, 'docs', 'skills')
  for (const p of personaPaths) {
    const fallbackName = p.split('/').pop() ?? p
    const docsFile = join(docsBase, `${p}.md`)
    const dataFile = join(DATA_SKILLS_DIR, `${p}.md`)
    const file = existsSync(/*turbopackIgnore: true*/ docsFile)
      ? docsFile
      : dataFile
    if (existsSync(/*turbopackIgnore: true*/ file)) {
      try {
        const body = readFileSync(/*turbopackIgnore: true*/ file, 'utf-8')
        parts.push(body)
        let display = fallbackName
        const fm = body.match(/^---[\s\S]*?\nname:\s*(.+?)\s*\n[\s\S]*?---/)
        if (fm) display = fm[1].trim()
        else {
          const h = body.match(/^#\s+(.+)$/m)
          if (h) display = h[1].trim()
        }
        metaSkills.push({ id: `persona:${p}`, name: display, description: p, source: 'file' })
      } catch {}
    } else {
      metaSkills.push({ id: `persona:${p}`, name: fallbackName, description: p, source: 'file' })
    }
  }

  return { parts, docParts, metaSkills, metaDocs }
}
