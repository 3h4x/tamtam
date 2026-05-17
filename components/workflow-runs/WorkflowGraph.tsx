'use client';

import { useEffect, useRef, useState } from 'react';

interface MermaidApi {
  initialize: (config: Record<string, unknown>) => void;
  render: (id: string, src: string) => Promise<{ svg: string }>;
}

// Pipeline state machine — source of truth: lib/workflows/decide-next-phase.ts.
// Keeping this string in lockstep with the decision rules: every edge here
// matches one branch in `decideNextPhase`. Update both together.
//
// Mermaid is loaded from CDN (esm.sh) on demand — no new npm dep, no build
// impact, and the 7-day minimumReleaseAge gate doesn't apply.
const DIAGRAM = `flowchart LR
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

export function WorkflowGraph() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rendered, setRendered] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Load mermaid from CDN via a runtime-evaluated dynamic import. Going
        // through `new Function` hides the URL from both Webpack and Turbopack
        // static analysis, so the bundler never tries to resolve or rewrite
        // it — the browser performs the import natively at runtime.
        const dynamicImport = new Function('u', 'return import(u)') as (u: string) => Promise<{ default: MermaidApi }>;
        const mod = await dynamicImport('https://esm.sh/mermaid@11.4.1');
        const mermaid = mod.default;
        if (cancelled) return;
        mermaid.initialize({
          startOnLoad: false,
          theme: 'dark',
          flowchart: { curve: 'basis', padding: 16 },
          themeVariables: {
            background: 'transparent',
            primaryColor: '#1e293b',
            primaryTextColor: '#e2e8f0',
            primaryBorderColor: '#64748b',
            lineColor: '#94a3b8',
            tertiaryColor: '#0f172a',
          },
        });
        const { svg } = await mermaid.render('tamtam-release-graph', DIAGRAM);
        if (cancelled) return;
        if (ref.current) {
          ref.current.innerHTML = svg;
          setRendered(true);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message || 'failed to load mermaid');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="rounded-md border border-border bg-bg-secondary p-4">
      <div className="mb-3 flex items-baseline gap-3">
        <h3 className="text-sm font-semibold text-text-primary">Release pipeline state machine</h3>
        <span className="text-xs text-text-tertiary">
          Source of truth: <code className="font-mono">lib/workflows/decide-next-phase.ts</code>
        </span>
      </div>
      {error ? (
        <div className="text-status-error text-sm">Failed to render graph: {error}</div>
      ) : !rendered ? (
        <div className="text-text-tertiary text-sm">Loading mermaid from CDN…</div>
      ) : null}
      <div ref={ref} className="overflow-x-auto" />
    </div>
  );
}
