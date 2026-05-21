import { NextRequest, NextResponse } from 'next/server';
import { checkoutDefault } from '@/lib/git/checkout-default';

// Switch the working copy back to the project's default branch.
//
// Body (optional): { carryChanges?: boolean }
//   - carryChanges=true: stash uncommitted changes, switch, then pop the stash
//     on default so the user's work moves with them.
//   - default behavior: refuse when there are uncommitted changes.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectName: string }> },
): Promise<NextResponse> {
  const { projectName } = await params;

  let carryChanges = false;
  try {
    const body = await req.json();
    carryChanges = !!body?.carryChanges;
  } catch {
    // no body is fine — fall back to default (strict) behavior
  }

  const result = await checkoutDefault({ project: projectName, carryChanges });
  if (!result.ok) {
    return NextResponse.json({ detail: result.detail }, { status: result.status });
  }
  // 'switched-stash-kept' returns 207 Multi-Status so the caller can surface
  // the recovery hint to the user.
  if (result.status === 'switched-stash-kept') {
    return NextResponse.json(
      {
        status: 'switched-stash-kept',
        branch: result.branch,
        deletedBranch: result.deletedBranch,
        detail: result.detail,
      },
      { status: 207 },
    );
  }
  return NextResponse.json({
    status: result.status,
    branch: result.branch,
    deletedBranch: result.deletedBranch,
  });
}
