import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { contentTypeForLogoPath, detectProjectLogoPath } from '@/lib/shared/project-logo';

describe('contentTypeForLogoPath', () => {
  it('returns image/svg+xml for .svg', () => {
    expect(contentTypeForLogoPath('/path/to/logo.svg')).toBe('image/svg+xml');
  });

  it('returns image/png for .png', () => {
    expect(contentTypeForLogoPath('/path/to/logo.png')).toBe('image/png');
  });

  it('returns image/jpeg for .jpg', () => {
    expect(contentTypeForLogoPath('/path/to/logo.jpg')).toBe('image/jpeg');
  });

  it('returns image/jpeg for .jpeg', () => {
    expect(contentTypeForLogoPath('/path/to/logo.jpeg')).toBe('image/jpeg');
  });

  it('returns image/webp for .webp', () => {
    expect(contentTypeForLogoPath('/path/to/logo.webp')).toBe('image/webp');
  });

  it('returns image/x-icon for .ico', () => {
    expect(contentTypeForLogoPath('/path/to/favicon.ico')).toBe('image/x-icon');
  });

  it('returns application/octet-stream for unknown extension', () => {
    expect(contentTypeForLogoPath('/path/to/logo.bmp')).toBe('application/octet-stream');
  });

  it('returns application/octet-stream for no extension', () => {
    expect(contentTypeForLogoPath('/path/to/logo')).toBe('application/octet-stream');
  });

  it('is case-insensitive for extensions', () => {
    expect(contentTypeForLogoPath('/path/to/LOGO.SVG')).toBe('image/svg+xml');
    expect(contentTypeForLogoPath('/path/to/logo.PNG')).toBe('image/png');
  });
});

describe('detectProjectLogoPath', () => {
  let projectRoot: string;

  function setup() {
    projectRoot = mkdtempSync(join(tmpdir(), 'tamtam-logo-unit-'));
    return projectRoot;
  }

  function teardown() {
    rmSync(projectRoot, { recursive: true, force: true });
  }

  it('returns null when no logo files exist', () => {
    setup();
    try {
      expect(detectProjectLogoPath(projectRoot)).toBeNull();
    } finally {
      teardown();
    }
  });

  it('finds .tamtam/logo.svg as the highest priority candidate', () => {
    setup();
    try {
      mkdirSync(join(projectRoot, '.tamtam'), { recursive: true });
      mkdirSync(join(projectRoot, 'public'), { recursive: true });
      writeFileSync(join(projectRoot, '.tamtam', 'logo.svg'), '<svg/>');
      writeFileSync(join(projectRoot, 'public', 'logo.png'), Buffer.from([0x89, 0x50]));

      const result = detectProjectLogoPath(projectRoot);
      expect(result).toBe(join(projectRoot, '.tamtam', 'logo.svg'));
    } finally {
      teardown();
    }
  });

  it('falls back to public/logo.png when no .tamtam logo exists', () => {
    setup();
    try {
      mkdirSync(join(projectRoot, 'public'), { recursive: true });
      writeFileSync(join(projectRoot, 'public', 'logo.png'), Buffer.from([0x89, 0x50]));

      const result = detectProjectLogoPath(projectRoot);
      expect(result).toBe(join(projectRoot, 'public', 'logo.png'));
    } finally {
      teardown();
    }
  });

  it('picks the first matching candidate among several present', () => {
    setup();
    try {
      mkdirSync(join(projectRoot, 'public'), { recursive: true });
      writeFileSync(join(projectRoot, 'public', 'logo.png'), Buffer.from([0x89, 0x50]));
      writeFileSync(join(projectRoot, 'public', 'logo.svg'), '<svg/>');

      // public/logo.svg comes before public/logo.png in the candidate list
      const result = detectProjectLogoPath(projectRoot);
      expect(result).toBe(join(projectRoot, 'public', 'logo.svg'));
    } finally {
      teardown();
    }
  });

  it('skips directories that match candidate names', () => {
    setup();
    try {
      // Create a directory named logo.png; lstatSync should detect it's not a file.
      const dirPath = join(projectRoot, 'public');
      mkdirSync(dirPath, { recursive: true });
      mkdirSync(join(dirPath, 'logo.png'), { recursive: true });
      writeFileSync(join(projectRoot, 'logo.png'), Buffer.from([0x89, 0x50]));

      const result = detectProjectLogoPath(projectRoot);
      expect(result).toBe(join(projectRoot, 'logo.png'));
    } finally {
      teardown();
    }
  });
});
