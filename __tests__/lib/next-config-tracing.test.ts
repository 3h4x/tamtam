import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

describe('next output file tracing config', () => {
  const source = readFileSync(join(process.cwd(), 'next.config.ts'), 'utf-8');

  it('excludes runtime data but not vendored skill docs read at runtime', () => {
    expect(source).toContain("'data/**'");
    expect(source).not.toMatch(/['"](?:\*\*\/)?skills\/docs\/\*\*['"]/);
  });

  it('preserves explicit local workflow data dir overrides', () => {
    expect(source).toContain("const localDataDir = process.env.WORKFLOW_LOCAL_DATA_DIR;");
    expect(source).toContain("if (!localDataDir || localDataDir === '.next/workflow-data')");
    expect(source).not.toContain("process.env.WORKFLOW_LOCAL_DATA_DIR = 'data/workflow-data';\n}");
  });
});
