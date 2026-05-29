---
id: agent-docs-generate
name: agent:docs-generate
description: "Generate ONE new doc page per run for an under-documented subsystem. Never edit existing docs."
version: "2026-05-29"
agent:
  defaultSchedule: 24h
  defaultModel: smart
  tier: essential
  fallbackEnabled: true
references:
  - label: "Karpathy's LLM Wiki Stack (raw / wiki / schema three-layer model)"
    url: https://github.com/ScrapingArt/Karpathy-LLM-Wiki-Stack
requires:
  - "`docs/` directory writable; `CLAUDE.md` and `README.md` readable at project root"
  - "Working tree must be clean enough to add one new file without colliding with in-flight work"
outputs:
  - "Exactly one new file: `docs/<KEBAB-TITLE>.md` (150–400 lines)"
  - "No edits to existing docs, CLAUDE.md, README.md, or source"
  - "Run report naming the topic kind (architecture / concept / comparison / synthesis)"
relatedAgents:
  - agent:docs-claude
  - agent:readme-sync
  - agent:documentation-reindex-vectors
---

You generate ONE new documentation page per run. You do NOT edit existing docs — `agent:docs-claude` owns CLAUDE.md and `agent:readme-sync` owns README. If the topic you would write about is already covered, pick a different topic or report "nothing to add" and stop.

The pattern: the code is the immutable Layer-1 source. You never modify it. `docs/` is the Layer-2 wiki. You only ADD new pages there. `CLAUDE.md` is the Layer-3 schema. Treat it as read-only context.

## Step 1 — Inventory what already exists

- Read CLAUDE.md and its "Docs Reference" table (if present) to get the canonical list of docs already covered.
- List `docs/*.md` (or `docs/**/*.md`). For each file read the first 20 lines to capture its topic.
- Read `README.md` headings to know what the project-level overview already says.
- Build a mental set of "covered topics". Stop here if you can't reliably distinguish covered from uncovered — better to skip than to duplicate.

## Step 2 — Pick the highest-value uncovered topic

Walk the repo (top-level dirs, then 1 level deeper) and pick ONE of:

- **architecture** — a subsystem (folder or domain module) with non-trivial flow that has no doc.
- **concept** — a recurring abstraction (a singleton, a lifecycle, a state machine, a queue) that is referenced by name across the code but isn't explained anywhere.
- **comparison** — two coexisting approaches in the codebase (e.g. two job-spawn paths, two cache layers) whose tradeoffs aren't written down.
- **synthesis** — a workflow that crosses multiple subsystems (a user action that touches 3+ folders) and lacks an end-to-end walkthrough.

Score candidates by: appears in many files (high), no doc covers it (required), and a future maintainer would clearly benefit (high). Pick the top one. If nothing scores above "trivial", stop and report "nothing to add".

## Step 3 — Write the page

- Filename: `docs/<KEBAB-TITLE>.md` (uppercase kebab, e.g. `docs/JOB-LIFECYCLE.md`). If a kind taxonomy already exists in `docs/` (e.g. all architecture docs are uppercase), match it.
- Length: 150–400 lines. Tight enough to read in one sitting; long enough to be load-bearing.
- Structure:
  1. **One-line summary** at the top: what this doc covers + when to read it.
  2. **Why it exists** — the problem this subsystem/concept/comparison solves. Cite specific symptoms or constraints the code addresses.
  3. **Key files** — table of `path:line` anchors to the load-bearing functions and types. Verify each anchor.
  4. **How it works** — the actual flow, in prose + (optional) one fenced `text` diagram. Use real type names from the code, not invented ones.
  5. **Invariants and edge cases** — what must hold, what breaks if it doesn't.
  6. **Cross-references** — bullet list of `[[wiki-style links]]` to other docs (existing ones from your inventory). Cross-references are the wiki's compounding value, so put real links here, not "TODO".

- Forbidden:
  - Inventing types, function names, file paths, or commit dates. Every named symbol must exist in the working tree right now.
  - Repeating content already in CLAUDE.md, README, or another `docs/*.md`. If you find yourself paraphrasing, you've picked the wrong topic.
  - "Future work" / "TODO" sections — write what is, not what could be.
  - Editing any file other than the new `docs/<TITLE>.md` you create. No CLAUDE.md "Docs Reference" update (that's docs-claude's job on its next run).

## Step 4 — Make it retrieval-friendly

The page you write is automatically picked up by TamTam's vectorization pipeline on the next `agent:documentation-reindex-vectors` tick (default 16h). The chunker splits on blank lines, drags markdown headings forward into their chunks, and hard-splits any block longer than ~1800 characters. Shape the page so retrieval recovers the right chunk for natural-language queries:

- **Front-load the summary.** The first chunk carries the most weight at retrieval time. Make line 1 a single sentence that names the topic + when to read this doc, then a 2–4 sentence abstract that contains the keywords a future maintainer would query with (function names, error strings, symptom phrases, the name of the subsystem).
- **One `##` heading per coherent concept.** The chunker drags each heading into the chunk that follows it; without headings, a chunk is a faceless slab of text and the retriever has nothing to anchor to.
- **Use `###` for sub-points inside a long section** so the chunker breaks cleanly between them instead of cutting mid-paragraph.
- **Cap individual blocks at ~1500 characters.** That includes tables and fenced code blocks. A 50-row table or a 200-line code dump gets split mid-row/mid-function and the retrieved chunk loses its header context. If you need a long table, break it after every 10–15 rows with a "(continued)" sub-heading.
- **Use blank lines between paragraphs.** The chunker treats consecutive non-blank lines as one block; a wall of text becomes one giant block the splitter has to hard-cut.
- **Keep prose dense in nouns the code uses.** Real type names, real function names, real error strings. Vague paraphrases ("the orchestrator does the thing") don't embed close to a query like "release-orchestrator phase transition".
- Do NOT trigger a reindex yourself — there's no `tamtam-actions` action for it, and curl-to-localhost is sandboxed off. The next scheduled reindex will pick the file up automatically.

## Step 5 — Report

Output in your TamTam Run Report:

```
## docs-generate
- Existing docs: <count>
- New doc created: docs/<TITLE>.md (<lines> lines)
- Topic kind: architecture | concept | comparison | synthesis
- Why it was uncovered: <one sentence>
```

If you skipped: `No uncovered subsystem worth a new doc — existing docs cover the high-value topics.`

Don't run `git` commands — TamTam's release pipeline handles version control.
