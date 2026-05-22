import { RuleTester } from 'eslint';
import { describe, it } from 'vitest';
import { rules } from '../../eslint-rules/turbopack-nft.mjs';

type RuleTesterRule = Parameters<RuleTester['run']>[1];

const rule = rules['require-turbopack-ignore-on-dynamic-fs'] as unknown as RuleTesterRule;

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2024,
    sourceType: 'module',
  },
});

describe('turbopack-nft/require-turbopack-ignore-on-dynamic-fs', () => {
  it('only reports dynamic paths passed to real fs bindings', () => {
    ruleTester.run('require-turbopack-ignore-on-dynamic-fs', rule, {
      valid: [
        {
          code: "window.open(url, '_blank', 'noopener,noreferrer');",
        },
        {
          code: "import { readFile } from 'fs/promises'; readFile(/*turbopackIgnore: true*/ path, 'utf8');",
        },
        {
          code: "import { stat as fsStat } from 'node:fs/promises'; fsStat(/*turbopackIgnore: true*/ path);",
        },
        {
          code: "import * as fs from 'node:fs'; fs.existsSync('/tmp/static-file');",
        },
        {
          code: "import { existsSync } from 'fs'; existsSync(join(/*turbopackIgnore: true*/ root, 'package.json'));",
        },
        {
          code: "import { appendFileSync } from 'fs'; appendFileSync(fd, content);",
        },
        {
          code: "const fs = require('fs'); fs.existsSync(/*turbopackIgnore: true*/ path);",
          languageOptions: { sourceType: 'script', ecmaVersion: 2024 },
        },
      ],
      invalid: [
        {
          code: "import { readFile } from 'fs/promises'; readFile(path, 'utf8');",
          errors: [{ messageId: 'missing' }],
        },
        {
          code: "import * as fs from 'node:fs'; fs.existsSync(path);",
          errors: [{ messageId: 'missing' }],
        },
        {
          code: "const { stat } = require('fs/promises'); stat(path);",
          languageOptions: { sourceType: 'script', ecmaVersion: 2024 },
          errors: [{ messageId: 'missing' }],
        },
      ],
    });
  });
});
