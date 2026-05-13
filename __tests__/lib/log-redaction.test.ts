import { describe, expect, it } from 'vitest';
import { redactSecrets } from '@/lib/shared/log-redaction';

describe('log redaction', () => {
  it('leaves non-secret text unchanged', () => {
    const line = 'Running tests for package api with exit code 0\n';
    expect(redactSecrets(line)).toBe(line);
  });

  it('redacts representative credential shapes', () => {
    const input = [
      'github=ghp_abcdefghijklmnopqrstuvwxyz123456',
      'openai=sk-proj-abcdefghijklmnopqrstuvwxyz123456',
      'anthropic=sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456',
      'auth=Bearer abcdefghijklmnopqrstuvwxyz123456',
      'url=https://user:supersecret@example.com/path',
      'slack=https://hooks.slack.com/services/T000/B000/abcdefghijklmnopqrstuvwxyz',
      'discord=https://discord.com/api/webhooks/1234567890/abcdefghijklmnopqrstuvwxyz',
    ].join('\n');

    const output = redactSecrets(input);
    expect(output).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz123456');
    expect(output).not.toContain('sk-proj-abcdefghijklmnopqrstuvwxyz123456');
    expect(output).not.toContain('sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456');
    expect(output).not.toContain('abcdefghijklmnopqrstuvwxyz123456');
    expect(output).not.toContain('supersecret');
    expect(output).toContain('[REDACTED]');
    expect(output).toContain('https://user:[REDACTED]@example.com/path');
    expect(output).toContain('Bearer [REDACTED]');
  });

  it('redacts configured secret environment values', () => {
    const output = redactSecrets(
      'tool printed runtime-secret-value but kept ordinary-value',
      { SERVICE_TOKEN: 'runtime-secret-value', ORDINARY: 'ordinary-value' },
    );
    expect(output).toBe('tool printed [REDACTED] but kept ordinary-value');
  });
});
