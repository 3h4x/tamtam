import { closeSync, fstatSync, openSync, readFileSync, readSync } from 'fs';
import { redactSecrets } from '@/lib/shared/log-redaction';

export function readRedactedFileSync(path: string): string {
  return redactSecrets(readFileSync(/*turbopackIgnore: true*/ path, 'utf-8'));
}

export function readRedactedTailSync(path: string, maxBytes: number): string {
  const fd = openSync(/*turbopackIgnore: true*/ path, 'r');
  try {
    const stats = fstatSync(fd);
    if (stats.size <= maxBytes) {
      return redactSecrets(readFileSync(/*turbopackIgnore: true*/ path, 'utf-8'));
    }

    const buf = Buffer.alloc(maxBytes);
    readSync(fd, buf, 0, maxBytes, stats.size - maxBytes);
    let content = buf.toString('utf-8');
    const nl = content.indexOf('\n');
    if (nl >= 0) content = content.slice(nl + 1);
    return redactSecrets(content);
  } finally {
    closeSync(fd);
  }
}
