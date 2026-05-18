import { Suspense } from 'react';
import { WorkflowRunsPage } from '@/components/workflow-runs/WorkflowRunsPage';
import { WorkflowRunsLoadingState } from '@/components/workflow-runs/WorkflowRunsStates';

export default function WorkflowRuns() {
  return (
    <Suspense fallback={<WorkflowRunsLoadingState />}>
      <WorkflowRunsPage />
    </Suspense>
  );
}
