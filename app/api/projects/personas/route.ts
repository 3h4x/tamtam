import { NextResponse } from 'next/server';
import { readdirSync, readFileSync, type Dirent } from 'fs';
import { join } from 'path';
import { SKILLS_DIR, DATA_SKILLS_DIR } from '@/lib/skills/skills';

interface Persona {
  path: string;
  category: string;
  name: string;
  description: string;
  emoji: string;
}

// `time === 0` is the "never scanned" sentinel. We MUST distinguish that
// from "scanned and the result was zero personas" — otherwise a workspace
// with no skills/personas re-scans the filesystem on every request because
// `data.length > 0` never gates the freshness check.
let _personaCache: { data: Persona[]; time: number } = { data: [], time: 0 };
const PERSONA_CACHE_TTL_S = 300;

function scanDir(base: string, personas: Persona[]) {
  let catEntries: Dirent[];
  try {
    catEntries = readdirSync(/*turbopackIgnore: true*/ base, { withFileTypes: true });
  } catch {
    return;
  }
  for (const catEntry of catEntries) {
    if (!catEntry.isDirectory()) continue;
    const catDir = join(base, catEntry.name);
    const category = catEntry.name;
    let entries: Dirent[];
    try {
      entries = readdirSync(/*turbopackIgnore: true*/ catDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name === 'index.md') continue;
      const fpath = join(catDir, entry.name);
      const slug = entry.name.replace('.md', '');
      let name = slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      let description = '';
      const emoji = '';
      try {
        const content = readFileSync(/*turbopackIgnore: true*/ fpath, 'utf-8').slice(0, 2000);
        if (content.startsWith('---')) {
          const end = content.indexOf('---', 3);
          if (end > 0) {
            const fm = content.slice(3, end);
            const titleMatch = fm.match(/^title:\s*"?(.+?)"?\s*$/m);
            if (titleMatch) {
              name = titleMatch[1].replace(/\s*[—–-]\s*Agent Skill.*$/i, '').trim();
            }
            const descMatch = fm.match(/^description:\s*"?(.+?)"?\s*$/m);
            if (descMatch) {
              description = descMatch[1].replace(/\s*Agent skill for Claude Code.*$/i, '').trim();
            }
          }
        }
      } catch {}
      personas.push({ path: `${category}/${slug}`, category, name, description, emoji });
    }
  }
}

function listPersonas(): Persona[] {
  const now = Date.now() / 1000;
  if (_personaCache.time > 0 && now - _personaCache.time < PERSONA_CACHE_TTL_S) {
    return _personaCache.data;
  }

  const personas: Persona[] = [];
  scanDir(join(SKILLS_DIR, 'docs', 'skills'), personas);
  scanDir(DATA_SKILLS_DIR, personas);

  _personaCache = { data: personas, time: now };
  return personas;
}

export async function GET() {
  return NextResponse.json({ personas: listPersonas() });
}
