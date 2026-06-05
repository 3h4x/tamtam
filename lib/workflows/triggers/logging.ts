export function logWorkflowTrigger(message: string): void {
  if (process.env.NODE_ENV === 'test' || process.env.VITEST_WORKER_ID) return;
  console.log(message);
}
