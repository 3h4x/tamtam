import { NextRequest, NextResponse } from 'next/server';
import { readFileSync } from 'fs';
import { resolveProjectPath } from '@/lib/shared/project-data';
import { contentTypeForLogoPath, detectProjectLogoPath } from '@/lib/shared/project-logo';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectName: string }> }
) {
  const { projectName } = await params;
  const projectPath = resolveProjectPath(projectName);
  if (!projectPath) {
    return NextResponse.json({ detail: 'project not found' }, { status: 404 });
  }

  const logoPath = detectProjectLogoPath(projectPath);
  if (!logoPath) {
    return NextResponse.json({ detail: 'logo not found' }, { status: 404 });
  }

  try {
    const body = readFileSync(/*turbopackIgnore: true*/ logoPath);
    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type': contentTypeForLogoPath(logoPath),
        'Cache-Control': 'public, max-age=60',
      },
    });
  } catch (error) {
    console.error('Failed to read project logo', error);
    return NextResponse.json({ detail: 'failed to read project logo' }, { status: 500 });
  }
}
