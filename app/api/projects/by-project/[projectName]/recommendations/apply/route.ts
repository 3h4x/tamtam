import { NextRequest, NextResponse } from 'next/server'
import { ApplyRecommendationError, applyRecommendation } from '@/lib/recommendations/apply-recommendation'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> },
) {
  const { projectName } = await params
  const body = await request.json().catch(() => ({}))
  const id = typeof body.id === 'string' ? body.id : ''

  if (!id) {
    return NextResponse.json({ detail: 'id is required' }, { status: 400 })
  }

  try {
    const result = await applyRecommendation(projectName, id)
    return NextResponse.json(result)
  } catch (e: unknown) {
    if (e instanceof ApplyRecommendationError) {
      return NextResponse.json({ detail: e.message }, { status: e.status })
    }
    console.error('Failed to apply recommendation:', e)
    return NextResponse.json({ detail: 'Failed to apply recommendation' }, { status: 500 })
  }
}
