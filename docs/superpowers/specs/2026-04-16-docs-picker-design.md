# Design: Docs Picker for Experimental Tab

**Date:** 2026-04-16  
**Status:** Approved

## Summary

Add a `+docs` button to the experimental tab title bar that lets the user pick markdown files from the current project's `docs/` directory and inject their content into the first message of a session — the same way DB-backed skills work today.

## API

### `GET /api/projects/by-project/[name]/docs`

Reads `{projectPath}/docs/*.md` (top-level only, no subdirectories).

Response:
```json
{
  "docs": [
    { "name": "EXPERIMENTAL.md", "content": "..." },
    { "name": "streaming.md", "content": "..." }
  ]
}
```

- Returns `[]` if the `docs/` directory does not exist or has no `.md` files
- `projectPath` resolved via `resolveProjectPath(name)` — 404 if not found

## UI changes (`ExperimentalTab.tsx`)

- `+docs` button added to the title bar, same style/position as `+skill`, placed immediately after it
- Clicking `+docs` fetches the docs list (one fetch per session open, cached in component state)
- Picker dropdown shows filenames; same search-filter, keyboard, and close-on-select behaviour as the skill picker
- Selected docs displayed as removable chips alongside selected skill chips
- **Injection rule:** on first message only (same as skills — skipped when `claudeSessionId` is set)
- Content injected inline before the user prompt: `## <filename>\n<content>\n\n---\n\n`
- Docs chips are separate state from skill chips but rendered and cleared on the same cycle

## Files to create/modify

| File | Change |
|------|--------|
| `app/api/projects/by-project/[projectName]/docs/route.ts` | New — list + read docs files |
| `components/ExperimentalTab.tsx` | Add `+docs` button, picker, state, injection |
| `__tests__/api/project-docs.test.ts` | New — unit tests for the API route |

## Out of scope

- Subdirectory traversal
- Showing doc content previews in the picker
- Persisting selected docs across sessions
- Usage frequency tracking (unlike skills)
