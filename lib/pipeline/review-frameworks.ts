import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export function detectReviewFrameworks(projPath: string): string[] {
  const frameworks: string[] = [];
  const has = (rel: string) => existsSync(/*turbopackIgnore: true*/ join(projPath, rel));
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {};
  try {
    // The catch handles ENOENT, so a separate existsSync probe is just an
    // extra syscall for the typical case. readFileSync throws → we fall
    // back to the empty default.
    pkg = JSON.parse(readFileSync(/*turbopackIgnore: true*/ join(projPath, 'package.json'), 'utf-8'));
  } catch { /* missing or unparseable package.json — no framework hints from it */ }
  const dep = (name: string) => pkg.dependencies?.[name] || pkg.devDependencies?.[name];
  const nextVer = dep('next');
  if (nextVer || has('next.config.ts') || has('next.config.js') || has('next.config.mjs') || has('next.config.cjs')) {
    frameworks.push(nextVer ? `nextjs@${nextVer.replace(/^[\^~]/, '')}` : 'nextjs');
  }
  if (has('foundry.toml') || has('hardhat.config.ts') || has('hardhat.config.js')) frameworks.push('solidity');
  if (has('drizzle.config.ts') || has('drizzle/') || has('migrations/') || has('prisma/schema.prisma')) frameworks.push('db-migrations');
  if (has('.github/workflows')) frameworks.push('github-actions');
  if (has('pyproject.toml') || has('requirements.txt') || has('setup.py')) frameworks.push('python');
  if (has('Package.swift') || has('Cartfile')) frameworks.push('swift');
  return frameworks;
}

export function formatReviewFrameworksBlock(frameworks: string[]): string {
  if (frameworks.length === 0) return 'FRAMEWORK: none detected (no language/framework markers found).';
  return `FRAMEWORK: ${frameworks.join(', ')}.`;
}

// Strip framework checklist sections that don't match the detected stack.
// Since per-repo detection is deterministic, pre-filter the prompt so the
// reviewer only sees applicable checklists.
export function filterReviewFrameworkSections(content: string, frameworks: string[]): string {
  const enabled = new Set(frameworks.map((f) => f.split('@')[0]));
  const lines = content.split('\n');
  const startIdx = lines.findIndex((l) => l.trim() === '## Framework-specific checks');
  if (startIdx === -1) return content;
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('## ') && !l.startsWith('### ')) { endIdx = i; break; }
  }
  const before = lines.slice(0, startIdx);
  const after = lines.slice(endIdx);
  const block = lines.slice(startIdx, endIdx);

  const headerAndLead: string[] = [];
  let i = 0;
  while (i < block.length && !block[i].startsWith('### ')) {
    headerAndLead.push(block[i]);
    i++;
  }

  const kept: string[] = [];
  while (i < block.length) {
    const sectionStart = i;
    const header = block[i];
    const match = header.match(/FRAMEWORK:`?[^`]*`?\s+line includes\s+`([\w-]+)`/i);
    const key = match?.[1];
    i++;
    while (i < block.length && !block[i].startsWith('### ')) i++;
    if (key && enabled.has(key)) kept.push(...block.slice(sectionStart, i));
  }

  // No matching subsection - drop the whole "## Framework-specific checks" block.
  if (kept.length === 0) {
    const trimmedBefore = [...before];
    while (trimmedBefore.length && trimmedBefore[trimmedBefore.length - 1] === '') trimmedBefore.pop();
    return [...trimmedBefore, '', ...after].join('\n');
  }

  return [...before, ...headerAndLead, ...kept, ...after].join('\n');
}
