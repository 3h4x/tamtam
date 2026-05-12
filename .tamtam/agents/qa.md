---
model: normal
schedule: 1h
skillIds: ["agent-qa"]
prerequisiteCommand: "bash scripts/qa-stack-up.sh"
---

TamTam-specific flow checklist for §2b. Drive each flow, then judge it against §2c.

- `/` — open a project row from the list, return via browser back, confirm scroll position is restored and the row is still where you left it.
- `/project/<name>` Terminal tab — open the skill picker, select any skill, type a short prompt ("hello"), submit, wait for streaming output. Tokens should arrive incrementally; tool-call blocks should render readably; there should be no blank-screen gap between submit and first token.
- `/project/<name>` overview — click **🚀 Release**. The pipeline strip must appear and chips must transition through `○ → spinner → ✓` (or `!` / `✗`) as steps complete, then disappear when the chain finishes. Capture any chip that stalls and any step whose status disagrees with its label.
- `/project/<name>/agents` — open an agent editor, click **✨ Improve** next to the Prompt textarea, confirm the prompt is replaced with the improved version and that the change is undoable (`Cmd+Z` or a visible undo).
- `/project/<name>/agents` — flip an agent's **enabled** switch, navigate to another tab, return, confirm the new state persisted. Flip it back.
- `/runs` — open a recent run, scroll the log to the bottom, click **Rerun**. The new run should appear at the top with a running indicator.
- `/monitoring` and `/pipeline` — both render charts. Wait ~3s after load and re-check the console; flag any chart-resize or ResizeObserver warnings.
- `/settings/*` — visit every settings tab. Edit a harmless field (e.g. a numeric default), save, confirm a toast or persisted-banner appears and that the saved value survives a reload.
- `/project/<name>/does-not-exist` and `/project/does-not-exist` — both must render a graceful 404, not a blank page or a 500.
