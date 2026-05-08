# Prompt Size & Cache-Read Cost

**TL;DR:** every byte in the composed prompt is read back from cache on every tool turn within a Claude run. A 50k-token system prompt with 10 tool turns = 500k cache-read tokens per run. Cache reads are cheap per token but compound fast — they were 51% of TamTam's weekly bill (issue #64) before this work.

## What gets composed into a prompt

For an **agent run** (`app/api/agents/[agentId]/run/route.ts`):

```
withBasePrompt(
  [docPaths..., skill bodies..., taskPrompt, memoryBlock].join('\n\n---\n\n'),
  { projectPath }
)
```

`withBasePrompt` (`lib/shared/config.ts`) prepends:
- `settings.base_prompt` (one paragraph)
- For non-Claude providers only: the project's `CLAUDE.md` (the Claude CLI loads it natively, so we don't double-include).

For **pipeline jobs** (review/fix/commit/dod/push), each `lib/pipeline/start-*.ts` builds a step-specific prompt and wraps it in `withBasePrompt`. They do *not* concatenate skill bodies — only the step prompt.

## Telemetry

`lib/jobs/prompt-size.ts` exports:
- `measurePrompt(prompt)` — UTF-8 byte length.
- `estimateTokens(bytes)` — rough `bytes / 4` approximation.
- `checkPromptSize(jobId, kind, bytes)` — `console.warn` when bytes exceed `TAMTAM_PROMPT_WARN_BYTES` (default 200 000 ≈ 50k tokens).

`lib/jobs/pm2-jobs.ts startJob` measures every prompt before handing it to PM2 and persists `promptBytes` on the job row. `/api/stats/usage` aggregates `avgPromptBytes` / `avgPromptTokens` per `kind`.

## Identified bloat sources

1. **`lib/agents/default-agent-skills.ts`** — 13 built-in skill bodies were 22 KB total before issue #64. Long "## Gotchas" sections re-stated Claude's defaults. Trimmed to 8 KB (~63% reduction). New users get the trimmed versions immediately; existing seeded DB rows also refresh automatically on boot when their stored content still matches a known shipped default hash. User-customized skill bodies are preserved.
2. **`base_prompt` setting** — already short (one paragraph). Don't grow it; per-task guidance belongs in skills.
3. **Project `CLAUDE.md`** — out of TamTam's control, but it's auto-loaded by the Claude CLI on every run. If a project's CLAUDE.md is huge, agent runs in that project will have huge cache reads regardless of TamTam's prompt.

## When to investigate

Watch `/stats` for kinds where `avgPromptTokens > 50 000`. The `[prompt-size] …` warning lines appear in the PM2 log. If a kind suddenly grows, check:
- A new skill was attached to an agent.
- A `.tamtam/agents/*.md` file gained boilerplate.
- A docPath was added that pulls in a large file.

## Threshold tuning

`TAMTAM_PROMPT_WARN_BYTES=300000 pnpm rebuild` raises the warn threshold to ~75k tokens. Default is 200 000 (≈ 50k tokens).
