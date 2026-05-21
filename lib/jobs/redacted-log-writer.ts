import { appendFileSync } from 'fs';
import { redactSecrets } from '@/lib/shared/log-redaction';

export function appendRedactedFileSync(path: string, content: string): void {
  appendFileSync(/*turbopackIgnore: true*/ path, redactSecrets(content));
}

export function writeRedactedFd(fd: number, chunk: Buffer | string): void {
  const content = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
  appendFileSync(fd, redactSecrets(content));
}
