import { Fragment } from 'react'
import {
  buildReleaseSummary,
  buildReleaseProgressLabel,
  flattenReleaseChildren,
} from '@/components/project-runs/release-progress'
import type { Entry } from '@/components/project-runs/types'
import { RunRow } from '@/components/project-runs/RunRow'

// Render a chained-child node (e.g. a release nested under an agent run).
// For release nodes the pipeline steps are flattened so test/review/commit/push
// all appear at the same depth; fix is one level deeper.
export function renderChain(
  node: Entry,
  depth: number,
  navigate: (e: Entry) => void,
  actionsFor: (e: Entry) => React.ReactNode,
): React.ReactNode {
  const summary = node.kind === 'release'
    ? buildReleaseSummary(node.children ?? [], node)
    : null
  const progressLabel = node.kind === 'release'
    ? buildReleaseProgressLabel(node.children ?? [], node)
    : null
  const pipelineFlat = node.kind === 'release'
    ? flattenReleaseChildren(node.children ?? [], depth + 1)
    : []
  return (
    <Fragment key={node.key}>
      <RunRow
        entry={node}
        onClick={() => navigate(node)}
        depth={depth}
        summary={summary}
        progressLabel={progressLabel}
        actions={actionsFor(node)}
      />
      {node.kind === 'release'
        ? pipelineFlat.map(({ entry, depth: d }) => (
            <RunRow key={entry.key} entry={entry} onClick={() => navigate(entry)} depth={d} />
          ))
        : node.chainedChildren?.map((c) =>
            c.kind === 'release'
              // Skip the release wrapper row even when nested deeper than the
              // top-level expansion site — its phases attach directly to its
              // owner so the workflow reads as one continuous chain.
              ? (
                  <Fragment key={c.key}>
                    {flattenReleaseChildren(c.children ?? [], depth + 1).map(({ entry, depth: d }) => (
                      <RunRow key={entry.key} entry={entry} onClick={() => navigate(entry)} depth={d} />
                    ))}
                  </Fragment>
                )
              : renderChain(c, depth + 1, navigate, actionsFor)
          )
      }
    </Fragment>
  )
}
