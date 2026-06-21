# Task 9 Report — `startInitiativeRun`

## Status

DONE

## Files Created

- `lib/orchestrator/run-initiative.ts` (72 lines)
- `__tests__/orchestrator/run-initiative.test.ts` (22 lines)

## Test Result

```
Tests  2 passed (2)
```

Both tests pass:
- "starts an agent run carrying the initiative prompt" — verifies `startRun` is called with `{ project: 'proj', prompt: 'Fix all lint errors.' }`
- "propagates a start failure" — verifies that a throwing `startRun` propagates the error

## Type-check / Lint Result

- `pnpm type-check`: passed (no output, exit 0)
- `pnpm lint`: passed (no output, exit 0)

## Real Inline-Agent Entrypoint

The plan suggested using `startInProcessAgentJob` from `@/lib/jobs/inline-agent`, but its **real signature** is:

```typescript
export async function startInProcessAgentJob(
  jobId: string,
  command: string,
  prompt: string,
  cwd: string,
  options?: { env?: Record<string, string>; fallback?: ...; cleanup?: () => void },
): Promise<number>
```

This returns `number` (the subprocess PID), not `{ jobId: string }`, and requires a pre-created job row, a CLI command string, and a cwd — it cannot be called with just `{ project, prompt }`. The plan's scaffold cast (`as Parameters<typeof startInProcessAgentJob>[0]`) would have been a type violation under strict mode.

## Actual `defaultStartRun` Implementation

`defaultStartRun` uses the established HTTP-dispatch pattern (same as `redispatchAgentForReinforce` and `drainNextAgentRun`):

1. Queries `schema.agents` for the first `enabled = true`, `kind = 'user'` agent for the project
2. POSTs to `{baseUrl}/api/agents/{agentId}/run` with `{ prompt: args.prompt }` and trigger header `x-tamtam-trigger: schedule`
3. Returns `{ jobId }` parsed from the JSON response

This is fully typed — no `as any`, no `@ts-ignore`. The DB query uses `drizzle-orm`'s `eq`/`and`, the HTTP call uses `fetch` with `AbortSignal.timeout(30_000)`.

## Values Supplied Beyond project + prompt

- `agentId`: resolved at runtime by querying the first enabled user-kind agent for the project (if none exists, throws with an actionable message)
- `x-tamtam-trigger: schedule` header: so the run is treated as a scheduled fire (not a user-initiated manual run), consistent with how the cron scheduler and reinforce loop fire agents

## Error Case

If no enabled user agent exists for the project, `defaultStartRun` throws:
> `[run-initiative] no enabled user agent found for project "..." — add at least one agent before enabling the initiative engine`

This causes the dispatcher to mark the initiative `failed` with a 6h cooldown (Task 5 behavior), which is the correct outcome.
