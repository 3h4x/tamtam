import { NextResponse } from 'next/server';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, dirname } from 'path';
import { SKILLS_DIR } from '@/lib/skills';
import { existsSync } from 'fs';

interface Persona {
  path: string;
  category: string;
  name: string;
  description: string;
  emoji: string;
}

let _personaCache: { data: Persona[]; time: number } = { data: [], time: 0 };

function listPersonas(): Persona[] {
  const now = Date.now() / 1000;
  if (_personaCache.data.length > 0 && now - _personaCache.time < 300) return _personaCache.data;

  const docsBase = join(SKILLS_DIR, 'docs', 'skills');
  if (!existsSync(docsBase)) return [];

  const personas: Persona[] = [];

  for (const catEntry of readdirSync(docsBase, { withFileTypes: true })) {
    if (!catEntry.isDirectory()) continue;
    const catDir = join(docsBase, catEntry.name);
    const category = catEntry.name;

    for (const entry of readdirSync(catDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name === 'index.md') continue;
      const fpath = join(catDir, entry.name);
      const slug = entry.name.replace('.md', '');
      let name = slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      let description = '';
      let emoji = '';
      try {
        const content = readFileSync(fpath, 'utf-8').slice(0, 2000);
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

  _personaCache = { data: personas, time: now };
  return personas;
}

export async function GET() {
  return NextResponse.json({ personas: listPersonas() });
}
