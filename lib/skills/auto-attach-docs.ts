import { existsSync, readFileSync } from 'fs';
import { basename, isAbsolute, join, normalize, sep } from 'path';
import { getBranchContext, gitShowSync } from '@/lib/git/git-branch';
import { realPathStaysInsideProject } from '@/lib/shared/path-containment';
import type { FileProjectConfig } from './tamtam-file-config';

export interface AutoAttachRule {
  keywords: string[];
  doc: string;
}

export interface AutoAttachedDoc {
  rulePath: string;
  absolutePath: string;
  name: string;
  content: string;
  matchedKeyword: string;
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findMatchingKeyword(prompt: string, keywords: string[]): string | null {
  for (const raw of keywords) {
    const kw = raw.trim();
    if (!kw) continue;
    const re = new RegExp(`\\b${escapeForRegex(kw)}\\b`, 'i');
    if (re.test(prompt)) return kw;
  }
  return null;
}

function normalizeRelativeDocPath(docPath: string): string | null {
  const trimmed = docPath.trim();
  if (!trimmed) return null;
  if (isAbsolute(trimmed)) return null;
  const normalized = normalize(trimmed);
  if (normalized === '..' || normalized.startsWith(`..${sep}`)) return null;
  return normalized;
}

export function resolveAutoAttachedDocs(
  projectPath: string,
  prompt: string,
  config: FileProjectConfig | null,
): AutoAttachedDoc[] {
  if (!config?.auto_attach_docs || config.auto_attach_docs.length === 0) return [];
  if (!prompt || !prompt.trim()) return [];

  // Branch-safety: `loadFileConfig` returns config from `origin/<defaultBranch>`
  // when the working tree is on a non-default branch. The referenced doc
  // content must come from the same trusted ref, otherwise a feature branch
  // could rewrite an already-trusted doc path (e.g. docs/TEST.md) and have
  // arbitrary content injected into terminal, agent, and review prompts.
  const ctx = getBranchContext(projectPath);

  const out: AutoAttachedDoc[] = [];
  const seen = new Set<string>();

  for (const rule of config.auto_attach_docs) {
    if (!rule || typeof rule.doc !== 'string' || !Array.isArray(rule.keywords)) continue;
    const matched = findMatchingKeyword(prompt, rule.keywords);
    if (!matched) continue;

    const relPath = normalizeRelativeDocPath(rule.doc);
    if (!relPath) continue;
    if (seen.has(relPath)) continue;

    let content: string | null = null;
    let resolvedPath: string;

    if (ctx.isDefaultBranch) {
      resolvedPath = join(projectPath, relPath);
      if (!existsSync(/*turbopackIgnore: true*/ resolvedPath)) continue;
      if (!realPathStaysInsideProject(projectPath, resolvedPath)) continue;
      try {
        content = readFileSync(/*turbopackIgnore: true*/ resolvedPath, 'utf-8');
      } catch {
        continue;
      }
    } else {
      // Read from the trusted ref to match the config's trust boundary.
      resolvedPath = `${ctx.defaultBranch}:${relPath}`;
      content = gitShowSync(projectPath, `origin/${ctx.defaultBranch}`, relPath);
      if (content === null) continue;
    }
    if (!content || !content.trim()) continue;

    seen.add(relPath);
    out.push({
      rulePath: rule.doc,
      absolutePath: resolvedPath,
      name: basename(rule.doc),
      content,
      matchedKeyword: matched,
    });
  }

  return out;
}

export function formatAutoAttachedDocsBlock(docs: AutoAttachedDoc[]): string | null {
  if (docs.length === 0) return null;
  const sections = docs.map((d) => `## ${d.name}\n${d.content.trimEnd()}`);
  return [
    '## Auto-attached docs',
    'The following project docs were attached based on keywords in your prompt. Use them to stay consistent with project conventions.',
    '',
    ...sections,
  ].join('\n\n---\n\n');
}
