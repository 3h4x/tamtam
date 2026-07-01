# Prompt Size & Cache-Read Cost

**TL;DR:** every byte in the composed prompt is read back from cache on every tool turn within a Claude run. A 50k-token system prompt with 10 tool turns = 500k cache-read tokens per run. Cache reads are cheap per token but compound fast, so prompt growth needs active monitoring.

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
- `estimatePromptCost(prompt)` — shared pre-run estimate for composed prompts; reports bytes, estimated input tokens, thresholds, warning/block flags, model tier, and a rough input-token cost.
- `assertPromptEstimateAllowed(prompt)` — throws before provider spawn when the estimate exceeds `prompt_estimate_block_tokens`.
- `checkPromptSize(jobId, kind, bytes)` — `console.warn` when bytes exceed `TAMTAM_PROMPT_WARN_BYTES` (default 50 000 bytes ≈ 12.5k tokens).

The current spawn paths measure and persist `promptBytes` on the job row:
- `lib/jobs/spawn-claude-detached.ts startJobInProcess` for terminal runs and pipeline jobs.
- `lib/jobs/inline-agent.ts startInProcessAgentJob` for agent intake workflow jobs.

`/api/stats/usage` aggregates `avgPromptBytes` / `avgPromptTokens` per `kind`.

## Pre-spawn guardrail

Before creating manual terminal and agent job rows, TamTam estimates the composed prompt it is about to send. Accepted start responses include `prompt_estimate`. If the estimate exceeds `prompt_estimate_block_tokens`, the route returns HTTP 413 with `code: "prompt_estimate_blocked"` and does not create a job or spawn a provider process. The terminal input footer also shows a warning state before submit when the local draft plus selected DB skills/docs crosses `prompt_estimate_warn_tokens`; the server estimate remains authoritative because it also includes file personas, auto-attached docs, base prompt, provider choice, and attachment path instructions.

Release pipeline builders estimate their composed provider prompt before launch. `review` and `fix` reject before creating their phase job when the estimate exceeds `prompt_estimate_block_tokens`; `mark-dod` can only know the verification prompt after the issue/PR criteria have been fetched, so it records the blocked DoD row and stops before starting the provider verification subprocess. The spawn adapters still assert the same threshold as a final guard for all pipeline prompts and future callers.

The estimator uses provider-aware tokenization only when a caller adds it; the current fallback is conservative and local: UTF-8 bytes divided by 4. It includes whatever has already been composed into the prompt at that start path: base prompt/project memory, selected skills/docs/personas, auto-attached docs, issue/PR text, diff/context payloads, DoD criteria, and attachment path instructions.

## Identified bloat sources

1. **`lib/agents/default-agent-skills.ts`** — built-in skill bodies stay intentionally compact. New users get the shipped versions immediately; existing seeded DB rows refresh automatically on boot when their stored content still matches a known shipped default hash. User-customized skill bodies are preserved.
2. **`base_prompt` setting** — already short (one paragraph). Don't grow it; per-task guidance belongs in skills.
3. **Project `CLAUDE.md`** — out of TamTam's control, but it's auto-loaded by the Claude CLI on every run. If a project's CLAUDE.md is huge, agent runs in that project will have huge cache reads regardless of TamTam's prompt.

## When to investigate

Watch `/stats` for kinds where `avgPromptTokens > 12 500`. The `[prompt-size] …` warning lines appear in the TamTam server log. If a kind suddenly grows, check:
- A new skill was attached to an agent.
- An agent's prompt gained boilerplate.
- A docPath was added that pulls in a large file.

## Threshold tuning

`TAMTAM_PROMPT_WARN_BYTES=300000 pnpm run rebuild` raises the warn threshold to ~75k tokens. Default is 50 000 bytes (≈ 12.5k tokens).

DB settings:
- `prompt_estimate_warn_tokens` defaults to `50000`; `0` disables warning state.
- `prompt_estimate_block_tokens` defaults to `180000`; `0` disables hard blocking.
