import { Suspense } from 'react';
import { WorkflowRunDetail } from '@/components/workflow-runs/WorkflowRunDetail';
import { WorkflowRunDetailLoadingState } from '@/components/workflow-runs/WorkflowRunsStates';

export default async function WorkflowRunDetailPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;
  return (
    <Suspense fallback={<WorkflowRunDetailLoadingState />}>
      <WorkflowRunDetail runId={runId} />
    </Suspense>
  );
}
