import { join } from 'path';

export const SKILLS_DIR = join(process.cwd(), 'skills');

export const DATA_SKILLS_DIR = join(process.cwd(), 'data', 'skills');

export const CODE_REVIEWER_SKILL = join(
  SKILLS_DIR,
  'docs',
  'skills',
  'engineering',
  'code-reviewer.md'
);
