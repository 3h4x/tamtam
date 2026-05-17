// Source of truth for the release pipeline state-machine diagram.
// Edits here regenerate public/workflow-graph.svg via `pnpm gen:workflow-graph`
// (run automatically as part of `pnpm build`). Keep every edge in lockstep with
// `decideNextPhase` in `decide-next-phase.ts` and the release-after-run trigger
// in `lib/workflows/triggers/release-after-run.ts`.

export const PIPELINE_DIAGRAM = `flowchart LR
  agentRun([Agent run])
  manual([Manual release<br/>UI / API POST])
  scheduled([Scheduled agent<br/>cron tick])

  agentRun --> raR{successful run/agent<br/>+ release_after_run?}
  scheduled --> agentRun
  raR -->|"yes<br/>issue work ok"| release
  raR -->|retryable blocker| pending([pending release<br/>drain later])
  raR -->|no / non-retryable| noRelease([no release])
  manual --> release([release start])

  release --> test[test]
  test -->|exit 0| review[review]
  test -->|exit ≠ 0| fix[fix]
  test -->|review_disabled<br/>+ dirty| commit[commit]
  test -->|review_disabled<br/>+ clean| push[push]

  review -->|LGTM| commit
  review -->|NEEDS ATTENTION| fix
  review -->|"DO NOT SHIP<br/>(policy: fix, default)"| fix
  review -->|"DO NOT SHIP<br/>(policy: pass)"| commit
  review -->|"DO NOT SHIP<br/>(policy: abort)"| abort([abort])

  fix -->|parent test| test
  fix -->|parent review| review
  fix -->|parent commit| commit
  fix -->|parent push| push

  commit -->|exit 0| push
  commit -->|exit ≠ 0| fix

  push -->|exit 0| markDod[mark-dod]
  push -->|exit ≠ 0| fix

  markDod -->|auto-merge + PR| prWait[pr-wait]
  markDod -->|otherwise| done([done<br/>shipped to default])

  prWait -->|merged| done
  prWait -->|checks_failed| fixCi[fix-ci]
  fixCi -->|exit 0| test

  classDef phase fill:#1e293b,stroke:#64748b,color:#e2e8f0
  classDef terminal fill:#064e3b,stroke:#10b981,color:#a7f3d0
  classDef abort fill:#7f1d1d,stroke:#ef4444,color:#fecaca
  classDef fix fill:#78350f,stroke:#f59e0b,color:#fde68a
  classDef trigger fill:#1e3a8a,stroke:#60a5fa,color:#dbeafe
  classDef gate fill:#0f172a,stroke:#94a3b8,color:#cbd5e1
  class test,review,commit,push,markDod,prWait phase
  class fix,fixCi fix
  class done,pending,noRelease terminal
  class agentRun,manual,scheduled,release trigger
  class raR gate
  class abort abort`;
