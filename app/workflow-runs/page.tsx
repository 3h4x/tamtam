import { Suspense } from 'react';
import { WorkflowRunsPage } from '@/components/workflow-runs/WorkflowRunsPage';

export default function WorkflowRuns() {
  return (
    <Suspense fallback={<div className="p-6 text-text-tertiary">Loading…</div>}>
      <WorkflowRunsPage />
    </Suspense>
  );
}
