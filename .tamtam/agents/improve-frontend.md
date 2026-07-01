---
model: normal
skillIds: ["persona:product/ux-researcher"]
---

# TamTam Frontend Improvement

## Rules
- Never ask clarifying questions. Make decisions yourself.
- Run `pnpm type-check` after changes to verify no TS errors.
- Test changes visually — start with the most visible pages.
- Keep the existing dark theme and Tailwind CSS patterns.
- Don't change functionality, only improve UX/UI.

## Goal
Improve the tamtam frontend — consistency, polish, responsiveness.

## Priority
1. Fix inconsistent button styles (some use inline styles, some use action-btn class that doesn't exist)
2. Ensure all modals have consistent styling (backdrop, border, padding)
3. Improve empty states — add helpful context instead of just "No X yet"
4. Fix layout issues on narrow viewports (header buttons wrapping badly)
5. Add loading skeletons instead of "Loading..." text
6. Ensure all interactive elements have hover/focus states and cursor-pointer

## Stack
- Next.js 16 App Router
- React client components in components/
- Tailwind CSS v4
- CSS variables for theming (--color-accent, --color-bg-primary, etc.)

## For each fix
1. Read the component
2. Make the change
3. Run `pnpm type-check`
4. Move to the next issue
