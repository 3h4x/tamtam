import { join } from 'path';

/**
 * Path to the claude-skills submodule (skills/).
 * Used for personas and review prompts.
 */
export const SKILLS_DIR = join(process.cwd(), 'skills');

export const CODE_REVIEWER_SKILL = join(
  SKILLS_DIR,
  'engineering-team',
  'code-reviewer',
  'SKILL.md'
);
