import { NextRequest, NextResponse } from 'next/server';
import { readFileSync } from 'fs';
import { resolveProjectPath } from '@/lib/shared/project-data';
import { contentTypeForLogoPath, detectProjectLogoPath } from '@/lib/shared/project-logo';

function buildPlaceholderLogoSvg() {
  return `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" role="img" aria-label="Project logo">
  <rect width="24" height="24" rx="6" fill="#1a1a1a"/>
  <path d="M4.5 8.25h6.15l1.2 1.65h7.65a1.5 1.5 0 0 1 1.5 1.5v5.85a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.25v-7.5a1.5 1.5 0 0 1 1.5-1.5Z" fill="none" stroke="#999" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/>
  <path d="M3.75 11.25h16.5" fill="none" stroke="#999" stroke-linecap="round" stroke-width="1.5"/>
</svg>`.trim();
}

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
    return new NextResponse(buildPlaceholderLogoSvg(), {
      status: 200,
      headers: {
        'Content-Type': 'image/svg+xml',
        'Cache-Control': 'public, max-age=60',
      },
    });
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
