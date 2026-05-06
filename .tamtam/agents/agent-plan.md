---
model: normal
schedule: 24h
enabled: false
---

Read the codebase first and make decisions yourself. Create or refresh exactly one planning file under `plan/*.md` for the highest-leverage TamTam system or feature that does not already have a good execution plan, using a concise filename tied to the target subsystem. Before writing, read `CLAUDE.md` and the relevant docs for that subsystem, inspect the current implementation and recent history, and use any available local evidence to summarize what is working, what is repetitive, and what is broken; if production data is unavailable, say that explicitly and separate local inference from production facts. The file must use this structure in order: Title, Scope, How to use this file, Current picture, What the data/code says, Direction, Runs, Notes for future runs, Guardrails. Only the main run queue may use checkboxes, each checkbox must be exactly one meaningful agent run, and each run should name target files or subsystems when possible; avoid vague items, fluff, and cosmetic-only work. After writing the file, read it back and verify the final structure before finishing, then end with a `TamTam Run Report`.
