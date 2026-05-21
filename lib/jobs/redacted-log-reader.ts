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
      // Use the fd we already opened instead of `readFileSync(path)`,
      // which would re-open + re-read the file via a fresh path lookup
      // (two opens, two reads, two closes for one tail call). Also makes
      // the small-file path race-free against rotation between the fstat
      // and the actual read.
      const buf = Buffer.alloc(stats.size);
      readSync(fd, buf, 0, stats.size, 0);
      return redactSecrets(buf.toString('utf-8'));
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
