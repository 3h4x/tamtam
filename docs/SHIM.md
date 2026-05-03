# CLI Shims for TamTam

## Overview

TamTam natively invokes a Claude-compatible CLI binary and expects either:

- plain `--print` output for small helper calls such as commit-message generation
- Claude CLI `--output-format stream-json` NDJSON for terminal, agent, review, and fix runs

The shim scripts in `scripts/` let another model backend act as that configured binary without changing TamTam's pipeline code.

## Gemini CLI Shim

The `scripts/gemini-shim.js` script provides a compatibility layer that allows TamTam to interoperate with the Gemini CLI.

It acts as a translation layer: intercepting Claude-style commands, launching the Gemini CLI with appropriate parameters, and transforming the stream of events produced by Gemini into the event shapes expected by TamTam's Claude stream parser.

## How It Works

### Argument Mapping

The shim takes incoming arguments designed for Claude and translates them to their Gemini CLI equivalents:

*   **Models:**
    *   `fast` → `flash`
    *   `normal` → `pro`
    *   `smart` → `pro`
    *   legacy `haiku` / `sonnet` / `opus` still map to the same tiers
    *   `thinking` → `thinking`
*   **Permission / Approval Modes:**
    *   `bypassPermissions` → `yolo`
    *   `auto` → `auto_edit`
    *   `plan` → `plan`
    *   `default` → `default`

Other standard arguments like `--cwd` are passed through appropriately, and the `--output-format stream-json` flag is supplied to ensure the Gemini CLI outputs structured JSON lines.

Optional model overrides:

- `GEMINI_FAST_MODEL`
- `GEMINI_NORMAL_MODEL`
- `GEMINI_SMART_MODEL`
- legacy `GEMINI_HAIKU_MODEL`, `GEMINI_SONNET_MODEL`, and `GEMINI_OPUS_MODEL` are still honored as fallbacks

### Event Stream Translation

TamTam relies on an event stream formatted for Anthropic's Claude APIs. The shim listens to `gemini`'s `stdout`, parses the Gemini JSON events line-by-line, and translates them in real-time:

1.  **Text Generation:**
    *   **Gemini:** `{ "type": "message", "role": "assistant", "content": "..." }`
    *   **Claude Equivalent:** Translated into a `stream_event` containing a `content_block_delta` with a `text_delta`.
2.  **Tool Usage:**
    *   **Gemini:** `{ "type": "tool_use", "tool_name": "...", "tool_id": "...", "parameters": {...} }`
    *   **Claude Equivalent:** Emits three distinct events to simulate Claude's streaming tools:
        *   `content_block_start` (with `tool_use` type, name, and id)
        *   `content_block_delta` (with `input_json_delta` containing the parameters)
        *   `content_block_stop`
3.  **Tool Results:**
    *   **Gemini:** `{ "type": "tool_result", "status": "..." }`
    *   **Claude Equivalent:** Emits a `system` event with subtype `tool_result`.
4.  **Final Summary and Stats:**
    *   **Gemini:** `{ "type": "result", "stats": {...}, "status": "...", "error": "..." }`
    *   **Claude Equivalent:** Emitted as the final `result` object containing usage statistics mapped to `modelUsage`, capturing `inputTokens`, `outputTokens`, and `cacheReadInputTokens`.

## Usage

The shim is meant to be invoked as a drop-in replacement for the Claude CLI binary within the TamTam application.

```bash
node scripts/gemini-shim.js [claude-args...]
```

### Provider selection in Settings

Settings → Workspace → **Agent CLI Provider** controls which binary TamTam invokes:

- `claude` — uses the path in **Claude CLI Path** (default `~/.local/bin/claude`)
- `gemini` — TamTam resolves the binary to `<TamTam>/scripts/gemini-shim.js` automatically; the Claude CLI Path field is read-only
- `lmstudio` — TamTam resolves the binary to `<TamTam>/scripts/lmstudio-shim.js` automatically
- `codex` — TamTam resolves the binary to `<TamTam>/scripts/codex-shim.js` automatically
- `custom` — uses the path in **Claude CLI Path** verbatim (for forks of the Claude CLI or wrapper scripts)

Switching the provider away from `gemini`/`lmstudio`/`codex` clears any leftover shim path from the Claude CLI Path field so a stale `…/scripts/gemini-shim.js` doesn't keep getting executed under the `claude` provider. `lib/config.ts` enforces the same rule on the server side: a shim path stored under `claude` or `custom` is treated as unset and falls back to the default.

## Codex CLI Shim

The `scripts/codex-shim.js` script launches `codex exec` and translates Codex JSONL events into Claude-style `stream-json` events.

Model aliases:

- `fast` → `gpt-5.4-mini`
- `normal` → `gpt-5.4`
- `smart` → `gpt-5.5`
- legacy `haiku` / `sonnet` / `opus` are still accepted as aliases

Override with `CODEX_MODEL`, `CODEX_FAST_MODEL`, `CODEX_NORMAL_MODEL`, or `CODEX_SMART_MODEL`. Legacy `CODEX_HAIKU_MODEL`, `CODEX_SONNET_MODEL`, and `CODEX_OPUS_MODEL` still work as fallbacks.

Permission mapping defaults to Codex `workspace-write` sandbox with `-a never` for non-interactive runs. `plan` uses `read-only`. Set `CODEX_DANGEROUS_BYPASS=1` only if you intentionally want TamTam's `bypassPermissions` mode to run Codex with `danger-full-access`.

Manual usage:

```bash
node scripts/codex-shim.js --print --model normal -p "Write one sentence."
node scripts/codex-shim.js --print --output-format stream-json --model normal < prompt.txt
```

### Codex Quota

When the provider is `codex`, `/api/usage/quota` reads Codex's latest local `token_count.rate_limits` event from `~/.codex/sessions/**/*.jsonl`. Codex records the same 5-hour and weekly windows shown by `/status`, so TamTam's Budget tab and budget gates can reuse the existing quota shape without calling Anthropic's usage API.

## LM Studio Shim

The `scripts/lmstudio-shim.js` script calls LM Studio's native stateful REST API (`POST /api/v1/chat`) and translates the streaming response into Claude-style `stream-json` events.

Unlike the Gemini shim, this is not a Claude-compatible tool-running CLI. It sends TamTam's prompt to LM Studio and streams model text back. That is useful for local-model drafting, review comments, and simple assistant runs. Native LM Studio MCP/tool integrations may be added later, but Claude tool names such as `Read`, `Edit`, `Bash`, and `Grep` are not automatically available through this shim.

### Sessions

LM Studio's native `/api/v1/chat` endpoint is stateful. On the first request, LM Studio returns a `response_id` such as `resp_...`; the shim emits that value as Claude-style `session_id`.

When TamTam later invokes the shim with:

```bash
--resume resp_...
```

the shim passes that value as `previous_response_id`, so LM Studio continues the prior chat context without TamTam resending the full conversation.

### Configuration

Start the LM Studio local server, then mark the shim executable and configure TamTam's `Claude CLI Path` to the shim's absolute path:

```bash
chmod +x scripts/lmstudio-shim.js
/path/to/tamtam/scripts/lmstudio-shim.js
```

Do not put `node /path/to/tamtam/scripts/lmstudio-shim.js` directly in the setting. Some TamTam paths execute the configured binary with `execFile`, so the setting must be a single executable path. If you prefer launching through `node`, create a small wrapper script and point TamTam at that wrapper.

Manual CLI usage can still call it through Node:

```bash
node scripts/lmstudio-shim.js --print -p "Write one sentence."
```

Environment variables:

```bash
LMSTUDIO_BASE_URL=http://127.0.0.1:1234
LMSTUDIO_MODEL=your-loaded-model

# Optional per-tier aliases:
LMSTUDIO_FAST_MODEL=your-fast-model
LMSTUDIO_NORMAL_MODEL=your-default-model
LMSTUDIO_SMART_MODEL=your-largest-model

# Legacy aliases still honored:
LMSTUDIO_HAIKU_MODEL=your-fast-model

# Optional:
LMSTUDIO_API_KEY=...
LMSTUDIO_TEMPERATURE=0.2
LMSTUDIO_CONTEXT_LENGTH=8192
```

If no alias is set, `LMSTUDIO_MODEL` is used. If neither is set, the shim passes through TamTam's requested model name (`fast`, `normal`, or `smart`, with legacy `haiku` / `sonnet` / `opus` still accepted). `LMSTUDIO_BASE_URL` may include a trailing `/v1` from older OpenAI-compatible setup examples; the shim normalizes it back to the server root before calling `/api/v1/chat`.

### Event Translation

For `--output-format stream-json`, the shim maps native LM Studio SSE events:

1. `message.delta` → Claude-style `content_block_delta` with `text_delta`
2. `reasoning.delta` → Claude-style `thinking_delta`
3. `chat.end.result.stats` → final `result.modelUsage`
4. `chat.end.result.response_id` → final `result.session_id`

For plain `--print` calls without `--output-format stream-json`, the shim writes only the model text to stdout so helper code that expects one-line output can still parse it.

### Usage

```bash
LMSTUDIO_MODEL=qwen3-coder node scripts/lmstudio-shim.js --print --model fast -p "Write one sentence."
LMSTUDIO_MODEL=qwen3-coder node scripts/lmstudio-shim.js --print --output-format stream-json --model normal < prompt.txt
LMSTUDIO_MODEL=qwen3-coder node scripts/lmstudio-shim.js --print --output-format stream-json --model normal --resume resp_abc123 < followup.txt
```
