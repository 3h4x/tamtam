import { Suspense } from 'react';
import { WorkflowRunDetail } from '@/components/workflow-runs/WorkflowRunDetail';

export default async function WorkflowRunDetailPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;
  return (
    <Suspense fallback={<div className="p-6 text-text-tertiary">Loading…</div>}>
      <WorkflowRunDetail runId={runId} />
    </Suspense>
  );
}
