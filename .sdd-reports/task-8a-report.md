# Task 8a Report — Initiative Admit + Probes

## Status
COMPLETE

## Files Created

- `lib/orchestrator/initiative-admit.ts` — exports `admitProject`
- `lib/orchestrator/initiative-probes.ts` — exports `runProbes`
- `__tests__/orchestrator/initiative-admit.test.ts` — 3 tests

## Test Result

```
Test Files  1 passed (1)
Tests  3 passed (3)
Duration  1.82s
```

Tests cover: (1) cap promotion with 3 findings → 2 queued + 1 proposed, (2) existing queued rows reduce room, (3) cap=0 → nothing promoted.

## Type-check / Lint

`pnpm type-check` — PASS (no output)
`pnpm lint` — PASS (no output)

## `exec` Return Shape Found

```typescript
export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function exec(
  cmd: string,
  args: string[],
  options?: { cwd?: string; timeout?: number; env?: Record<string, string>; ... }
): Promise<ShellResult>
```

**Key adaptation:** The plan called `exec('pnpm lint', { cwd: projectPath })` treating `exec` as a shell string helper. The real signature is `exec(cmd, args[], options)` — no shell interpolation. `initiative-probes.ts` was adapted:

- Lint probe: `exec('pnpm', ['lint'], { cwd: projectPath, timeout: 60000 })`
- TODO probe: `exec('grep', ['-rIl', '-E', 'TODO|FIXME', '--include=*.ts', '--include=*.tsx', 'lib', 'components', 'app'], { cwd: projectPath, timeout: 30000 })`

The grep command originally used a shell string with `2>/dev/null | head -20`. Since `exec` spawns without a shell (safer, no injection risk), the stderr redirect and pipe were replaced by: ignoring stderr (it goes to `res.stderr` which we discard), and using `.slice(0, 20)` on the parsed file list instead of `head -20`.

`exec` does NOT throw on non-zero exit — it returns `{ exitCode: N }`. The try/catch in each probe guards only unexpected errors (spawn failure, ENOENT, etc.). `grep` exits 1 on no matches, which is handled cleanly by the `res.stdout.split('\n').filter(Boolean)` path producing an empty array.

## Skipped

Step 6 (wiring into `instrumentation-node.ts`) and Step 7 (commit) — as instructed.
