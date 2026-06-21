export type InitiativeAction = 'promote' | 'unpromote' | 'reject' | 'restore';

// Operator steering for one mined initiative. Mutates via PATCH /api/initiatives/[id].
export async function patchInitiative(id: number, action: InitiativeAction): Promise<void> {
  const res = await fetch(`/api/initiatives/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  });
  if (!res.ok) throw new Error(`patchInitiative ${action} failed: ${res.status}`);
}
