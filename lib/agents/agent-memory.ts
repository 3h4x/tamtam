import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { basename, join } from 'path';

// Per-project, inside the project worktree so codex-sandboxed agents (which
// can only write under the workspace root) can rewrite their memory at the
// end of a run. The old global path (`~/.cache/tamtam/agent-memory/<project>/<agent>.md`)
// lived outside any project's writable roots and was silently rejected by
// the sandbox, so the memory contract never actually persisted across runs
// for sandboxed providers.
//
// The cache directory is intentionally ignored by git (see
// `ensureAgentMemoryDir` below, which writes `.tamtam/.gitignore` with
// `cache/` on first use). The rest of `.tamtam/` stays committed.
const TAMTAM_DIR = '.tamtam';
const CACHE_SUBDIR = 'cache';
const AGENT_MEMORY_SUBDIR = 'agent-memory';
const GITIGNORE_FILENAME = '.gitignore';
const GITIGNORE_LINE = 'cache/';

const MEMORY_MAX_CHARS = 2000;

function sanitizeName(name: string): string {
  // Prevent path traversal: strip directory separators and leading dots.
  return basename(name).replace(/^\.+/, '_') || '_';
}

export function getAgentMemoryDir(projPath: string): string {
  return join(/*turbopackIgnore: true*/ projPath, TAMTAM_DIR, CACHE_SUBDIR, AGENT_MEMORY_SUBDIR);
}

export function getAgentMemoryPath(projPath: string, agentName: string): string {
  return join(/*turbopackIgnore: true*/ getAgentMemoryDir(projPath), `${sanitizeName(agentName)}.md`);
}

export function readAgentMemory(projPath: string, agentName: string): string | null {
  const path = getAgentMemoryPath(projPath, agentName);
  if (!existsSync(/*turbopackIgnore: true*/ path)) return null;
  try {
    return readFileSync(/*turbopackIgnore: true*/ path, 'utf-8').slice(0, MEMORY_MAX_CHARS);
  } catch {
    return null;
  }
}

export function ensureAgentMemoryDir(projPath: string): void {
  const dir = getAgentMemoryDir(projPath);
  mkdirSync(/*turbopackIgnore: true*/ dir, { recursive: true });
  ensureTamtamCacheGitignore(projPath);
}

/**
 * Make sure `<projPath>/.tamtam/.gitignore` exists and lists `cache/`, so the
 * agent-memory directory (and any other future per-project cache) does not
 * end up committed. We touch a file the repo tracks (`.tamtam/.gitignore`)
 * rather than the project's root `.gitignore` because:
 *   - `.tamtam/` is the part of the worktree TamTam owns by contract
 *     (`docs/TAMTAM-DIR.md`), so writing inside it doesn't surprise the
 *     project's own ignore rules.
 *   - Every project that uses TamTam gets the same ignore for free without
 *     each repo having to add `.tamtam/cache/` to its root `.gitignore`.
 *
 * Idempotent: if the file already contains `cache/` on its own line, do
 * nothing. If it exists but lacks the line, append it. If it doesn't exist,
 * write it with a single line.
 */
function ensureTamtamCacheGitignore(projPath: string): void {
  const tamtamDir = join(/*turbopackIgnore: true*/ projPath, TAMTAM_DIR);
  if (!existsSync(/*turbopackIgnore: true*/ tamtamDir)) return;
  const gitignorePath = join(/*turbopackIgnore: true*/ tamtamDir, GITIGNORE_FILENAME);
  let existing = '';
  if (existsSync(/*turbopackIgnore: true*/ gitignorePath)) {
    try {
      existing = readFileSync(/*turbopackIgnore: true*/ gitignorePath, 'utf-8');
    } catch {
      existing = '';
    }
  }
  const hasRule = existing
    .split('\n')
    .some((line) => line.trim() === GITIGNORE_LINE);
  if (hasRule) return;
  const next = existing.length === 0
    ? `${GITIGNORE_LINE}\n`
    : (existing.endsWith('\n') ? existing : existing + '\n') + `${GITIGNORE_LINE}\n`;
  try {
    writeFileSync(/*turbopackIgnore: true*/ gitignorePath, next, 'utf-8');
  } catch {
    // Non-fatal: gitignore write failure shouldn't break agent runs. The
    // worst case is that `.tamtam/cache/` ends up tracked by git until the
    // next successful write, which is a presentation issue, not a
    // correctness one.
  }
}

export function buildMemoryBlock(memoryPath: string, currentMemory: string | null): string {
  const memoryContents = currentMemory
    ? currentMemory.trim()
    : '(empty — this is your first run)';

  return `## Your Persistent Memory

Your memory file is at: ${memoryPath}

<current_memory>
${memoryContents}
</current_memory>

At the end of your run, rewrite the memory file at the path above (use the Write tool — replace its full contents, do NOT append). Keep it compact — under ${MEMORY_MAX_CHARS} characters; anything past that cap is silently truncated on the next read. Focus on actionable state:
- What was completed this run (with dates/identifiers)
- What is still pending (ordered by priority)
- Key decisions or constraints to remember

Compaction: when the file approaches the cap, collapse older "completed" entries into a one-line summary so the pending list stays visible. Do not summarize the current run log verbatim — write forward-looking notes for your future self so you never repeat completed work or lose track of what's next.`;
}
