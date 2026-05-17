// Source of truth for the release pipeline state-machine diagram.
// Edits here regenerate public/workflow-graph.svg via `pnpm gen:workflow-graph`
// (run automatically as part of `pnpm build`). Keep every edge in lockstep with
// `decideNextPhase` in `decide-next-phase.ts`.

export const PIPELINE_DIAGRAM = `flowchart LR
  start([Release start]) --> test[test]
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
  markDod -->|otherwise| done([done])

  prWait -->|merged| done
  prWait -->|checks_failed| fixCi[fix-ci]
  fixCi -->|exit 0| test

  classDef phase fill:#1e293b,stroke:#64748b,color:#e2e8f0
  classDef terminal fill:#064e3b,stroke:#10b981,color:#a7f3d0
  classDef abort fill:#7f1d1d,stroke:#ef4444,color:#fecaca
  classDef fix fill:#78350f,stroke:#f59e0b,color:#fde68a
  class test,review,commit,push,markDod,prWait phase
  class fix,fixCi fix
  class done,start terminal
  class abort abort`;
