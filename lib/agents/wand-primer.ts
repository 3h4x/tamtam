// Distilled primer that teaches Claude how TamTam agents are composed.
// Included in the magic-wand prompt-improvement context so the rewritten
// prompt is fit for execution as a TamTam agent. Keep this small (cache hits!)
// and update it only when agent semantics actually change.
export const WAND_PRIMER = `# How TamTam agents work

TamTam runs each agent as a single selected-provider CLI invocation per scheduled fire or
manual trigger. The agent receives:

- A composed system prompt built from selected skills (DB-backed and
  file-based personas) and project docs the user attached to the agent.
- Optionally, the captured stdout/stderr of a "prerequisite command" that
  TamTam ran in the project directory immediately before the agent started
  (for example \`pnpm test\`). This appears under \`## Prerequisite Output\`
  with command, exit code, duration, and output.
- The agent's own task prompt (this is the field the user is editing right now).

Conventions a good TamTam-agent prompt follows:

- Be concrete and project-specific: name the files, scripts, or commands the
  agent should touch. Vague verbs like "improve" produce drift.
- Assume the working directory is the project root; the agent already has
  shell and file-edit access via the standard CLI tools.
- The agent must NEVER run \`git commit\`, \`git push\`, \`gh pr create\`, or
  open/merge PRs. TamTam's release pipeline owns version control: it stages,
  commits, pushes, opens PRs, and merges after review. The agent should leave
  edits in the worktree and stop. Do not include "then commit", "and push",
  or any equivalent step in the prompt.
- End with a short machine-readable run report contract — TamTam already
  asks for "TamTam Run Report" at the end of every run, so the user prompt
  does NOT need to repeat that.
- Prefer imperative voice in second person ("Read X. Run Y. If Z, do W.").
`;
