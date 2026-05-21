import { existsSync, lstatSync } from 'fs';
import { join, extname } from 'path';

const PROJECT_LOGO_CANDIDATES = [
  '.tamtam/logo.svg',
  '.tamtam/logo.png',
  '.tamtam/logo.jpg',
  '.tamtam/logo.jpeg',
  '.tamtam/logo.webp',
  'public/logo.svg',
  'public/logo.png',
  'public/logo.jpg',
  'public/logo.jpeg',
  'public/logo.webp',
  'public/icon.svg',
  'public/icon.png',
  'public/icon.jpg',
  'public/icon.jpeg',
  'public/icon.webp',
  'public/favicon.svg',
  'public/favicon.png',
  'public/favicon.ico',
  'app/icon.svg',
  'app/icon.png',
  'app/icon.jpg',
  'app/icon.jpeg',
  'app/icon.ico',
  'app/apple-icon.png',
  'src/app/icon.svg',
  'src/app/icon.png',
  'src/app/icon.jpg',
  'src/app/icon.jpeg',
  'src/app/icon.ico',
  'src/app/apple-icon.png',
  'logo.svg',
  'logo.png',
  'logo.jpg',
  'logo.jpeg',
  'logo.webp',
];

export function detectProjectLogoPath(projectPath: string): string | null {
  for (const candidate of PROJECT_LOGO_CANDIDATES) {
    const absolutePath = join(/*turbopackIgnore: true*/ projectPath, candidate);
    if (!existsSync(/*turbopackIgnore: true*/ absolutePath)) continue;
    try {
      // `lstatSync` does NOT follow symlinks. Restricting to real files
      // means an accidental or malicious symlink at one of the candidate
      // paths (e.g. `.tamtam/logo.svg` → `/etc/passwd`) doesn't end up
      // served by /api/.../logo with an image/* content-type derived from
      // the symlink's name. The logo route is a public-ish endpoint;
      // refusing symlinks here is the cheapest defense.
      const stat = lstatSync(/*turbopackIgnore: true*/ absolutePath);
      if (stat.isFile()) return absolutePath;
    } catch {
      // Ignore unreadable candidates and continue scanning.
    }
  }

  return null;
}

export function contentTypeForLogoPath(logoPath: string): string {
  switch (extname(logoPath).toLowerCase()) {
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.ico':
      return 'image/x-icon';
    default:
      return 'application/octet-stream';
  }
}
