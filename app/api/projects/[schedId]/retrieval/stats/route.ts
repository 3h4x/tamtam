import { NextResponse } from 'next/server';
import { db, schema } from '@/lib/db';
import { eq, count, sum } from 'drizzle-orm';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ schedId: string }> }
): Promise<NextResponse> {
  const { schedId } = await params;
  const [recordRow] = await db
    .select({ records: count(), chunks: sum(schema.retrievalRecords.chunkCount) })
    .from(schema.retrievalRecords)
    .where(eq(schema.retrievalRecords.project, schedId));
  return NextResponse.json({
    records: Number(recordRow?.records ?? 0),
    chunks: Number(recordRow?.chunks ?? 0),
  });
}
