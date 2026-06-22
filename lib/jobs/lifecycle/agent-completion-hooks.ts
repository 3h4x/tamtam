import { updateJob } from '@/lib/jobs/storage';
import type { JobData } from '@/lib/jobs/types';

export async function runAgentCompletionHooks(job: JobData): Promise<void> {
  // Classify the final outcome of agent/run jobs so the UI can highlight the
  // Continue button when the model stopped mid-task or asked a question.
  // Fire-and-forget; never blocks completion-hook chaining.
  if (job.kind === 'run' || job.kind.startsWith('agent:')) {
    void (async () => {
      try {
        const { classifyAndStashOutcome } = await import('@/lib/jobs/outcome-classifier');
        await classifyAndStashOutcome(job);
      } catch (err) {
        console.warn(`[outcome-classifier] background classification failed for ${job.id}:`, err);
      }
    })();

    // Read the agent's emitted `tamtam-actions` block (if any) and execute
    // each action server-side. Awaited (NOT fire-and-forget) so the
    // completion-hook chain that runs below sees the post-action state
    // (issue closed, branch back on default, etc.) — without this, the
    // stranded-branch reconciler races and recreates an empty fix/issue-N
    // branch before the agent's close lands.
    //
    // The agent runs inside Codex's `workspace-write` sandbox which blocks
    // localhost, so the agent CANNOT POST to /api/.../issue-close itself.
    // This is the server-side bridge that turns its declared intent into a
    // real `gh issue close` / etc. invocation.
    try {
      if (job.logPath) {
        const { resolveProjectPath } = await import('@/lib/shared/project-data');
        const projPath = resolveProjectPath(job.project);
        if (projPath) {
          const { extractAssistantTextFromRawLog } = await import('@/lib/agents/work-summary-extractor.mjs');
          const { parseAgentActions } = await import('@/lib/agents/action-block-parser');
          // extractAssistantTextFromRawLog takes the log CONTENT, not a path.
          // Previously this passed `job.logPath` directly which silently
          // resolved to "" inside the extractor (the path split by '\n'
          // produced a single non-JSON line that was discarded), so every
          // agent's action block was lost. Read the file here.
          const { readFile } = await import('node:fs/promises');
          let rawLog = '';
          try {
            rawLog = await readFile(/*turbopackIgnore: true*/ job.logPath, 'utf8');
          } catch (readErr) {
            console.warn(`[agent-actions] ${job.id} could not read log:`, readErr);
          }
          const text = extractAssistantTextFromRawLog(rawLog);
          const parsed = parseAgentActions(text);
          if (parsed.ok && parsed.actions.length > 0) {
            const { canExecuteAgentActions } = await import('@/lib/agents/action-eligibility');
            const eligibility = canExecuteAgentActions(job, parsed.actions);
            if (eligibility.ok) {
              const { runAgentActions } = await import('@/lib/agents/action-orchestrator');
              const result = await runAgentActions({
                project: job.project,
                projPath,
                jobId: job.id,
                actions: parsed.actions,
              });
              // Surface counts on contextMeta so the UI can show "closed
              // issue #N" alongside the verdict without re-parsing the log.
              try {
                const meta = JSON.parse(job.contextMeta || '{}');
                meta.agentActions = {
                  executed: result.executed,
                  errors: result.errors,
                };
                job.contextMeta = JSON.stringify(meta);
                updateJob(job);
              } catch {
                /* non-fatal — contextMeta unchanged on parse error */
              }
              console.log(`[agent-actions] ${job.id}: executed=${result.executed} errors=${result.errors.length}`);
            } else {
              console.warn(`[agent-actions] ${job.id} skipped (${eligibility.reason}): ${eligibility.detail ?? ''}`);
            }
          } else if (!parsed.ok && parsed.reason !== 'missing') {
            console.warn(`[agent-actions] ${job.id} parse failed (${parsed.reason}): ${parsed.detail ?? ''}`);
          }
        }
      }
    } catch (err) {
      console.error(`[agent-actions] ${job.id} orchestrator threw:`, err);
    }

    // Auto-resume agent/run jobs that died mid-stream (no final `result`
    // event in the log + non-zero exit). The most common trigger is a PM2
    // restart killing the child process group before Claude could finish a
    // long turn. Fire-and-forget; capped at 2 attempts via contextMeta.
    // Gated on a kill switch so the durable job-completion router can take
    // over once the legacy inline path is retired.
    void (async () => {
      try {
        const { getSettings } = await import('@/lib/shared/config');
        if (!getSettings().legacy_completion_hook_auto_resume_enabled) return;
        const { maybeAutoResume } = await import('@/lib/jobs/auto-resume');
        await maybeAutoResume(job);
      } catch (err) {
        console.warn(`[auto-resume] background relaunch failed for ${job.id}:`, err);
      }
    })();
  }
}
