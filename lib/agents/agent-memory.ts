import { existsSync, mkdirSync, readFileSync } from 'fs';
import { basename, join } from 'path';
import { homedir } from 'os';

export function getAgentMemoryDir(): string {
  return join(homedir(), '.cache', 'tamtam');
}

const MEMORY_MAX_CHARS = 1000;

function sanitizeName(name: string): string {
  // Prevent path traversal: strip directory separators and leading dots.
  return basename(name).replace(/^\.+/, '_') || '_';
}

export function getAgentMemoryPath(dataDir: string, project: string, agentName: string): string {
  return join(dataDir, 'agent-memory', sanitizeName(project), `${sanitizeName(agentName)}.md`);
}

export function readAgentMemory(dataDir: string, project: string, agentName: string): string | null {
  const path = getAgentMemoryPath(dataDir, project, agentName);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf-8').slice(0, MEMORY_MAX_CHARS);
  } catch {
    return null;
  }
}

export function ensureAgentMemoryDir(dataDir: string, project: string): void {
  const dir = join(dataDir, 'agent-memory', sanitizeName(project));
  mkdirSync(dir, { recursive: true });
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

At the end of your run, update the memory file at the path above to record what you did and what you should do next time. Use your Write or Edit tools to update it directly. Keep it compact — under ${MEMORY_MAX_CHARS} characters. Focus on actionable state:
- What was completed this run (with dates/identifiers)
- What is still pending (ordered by priority)
- Key decisions or constraints to remember

Do not summarize the run log. Write forward-looking notes for your future self so you never repeat completed work or lose track of what's next.`;
}
