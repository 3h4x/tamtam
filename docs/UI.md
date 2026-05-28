# UI — TamTam Design System

The single source of truth for visual decisions in TamTam. Tokens live in `app/globals.css` (Tailwind v4 `@theme` block); components use them via Tailwind classes (`bg-bg-secondary`, `text-text-tertiary`, `border-border`, `text-accent`, etc.). Live previews of every concept ship under `docs/ui-preview/*.html` — open them in a browser when iterating.

> Adapted from the standalone TamTam Design System bundle. This file is the in-repo authoritative version; if a discrepancy exists between this and any other doc, this one wins.

---

## What TamTam looks like

Dense, utilitarian, information-first. Tables of projects with sortable columns, status dots, agent pills, terminal panes, monitoring dashboards — closer to Linear or pm2-web than a marketing SaaS. One accent blue, neutral grays, four standard status colors. **No gradients, no marketing illustrations, no emoji-as-iconography, no drop shadows on cards.**

---

## Tokens (source: `app/globals.css`)

### Color

| Token | Light | Dark | Usage |
|---|---|---|---|
| `--color-bg-primary` | `#ffffff` | `#0f0f0f` | Page background |
| `--color-bg-secondary` | `#f5f5f5` | `#1a1a1a` | Cards, headers, hovered rows |
| `--color-bg-tertiary` | `#efefef` | `#2a2a2a` | Hover lift, badges, inline code |
| `--color-text-primary` | `#1a1a1a` | `#e5e5e5` | Body text, headings |
| `--color-text-secondary` | `#666666` | `#999999` | Help text, metadata |
| `--color-text-tertiary` | `#999999` | `#666666` | Column headers, eyebrows |
| `--color-border` | `#e5e5e5` | `#2a2a2a` | All borders, always 1px solid |
| `--color-divider` | `#eeeeee` | `#222222` | Inline horizontal rules |
| `--color-accent` | `#2563eb` | `#3b82f6` | Brand blue — single accent |
| `--color-accent-hover` | `#1d4ed8` | `#2563eb` | Accent darken on hover |
| `--color-accent-light` | `rgba(37,99,235,0.10)` | `rgba(59,130,246,0.10)` | Translucent active/selected fill |
| `--color-status-success` | `#22c55e` | (same) | OK, LGTM, passing |
| `--color-status-error` | `#ef4444` | (same) | Failed, DO NOT SHIP |
| `--color-status-warning` | `#f59e0b` | (same) | Needs attention |
| `--color-status-info` | `#3b82f6` | (same) | Running, info banners |

**Rules:**
- One accent: blue. **No purple, no gradient, no second accent.**
- Borders are always grayscale. Never use accent for borders unless it's an "active" affordance (focus ring, active tab, selected nav).
- Status colors always pair with an icon — never color alone.
- Selected/active states use translucency (`accent-light`, `bg-status-error/10`, `accent/15`), never solid fills.

### Radii

| Token | Value | Usage |
|---|---|---|
| `--radius-sm` | `6px` | Inputs, inline pills, badges |
| `--radius-md` | `8px` | Buttons, cards |
| `--radius-lg` | `12px` | Large panels, toasts |
| `--radius-pill` | `9999px` | Capsule pills (`rounded-full`) |

### Typography

- **Geist** for UI, **Geist Mono** for code, paths, numbers in dev contexts. Both ship as variable woff2 in `public/fonts/` and are registered via `@font-face` in `app/globals.css`. Fallback stack stays in the cascade so there's no FOIT before the woff2 lands.
- Use `var(--font-sans)` / `var(--font-mono)` — or the Tailwind `font-mono` class.

| Size | Value | Usage |
|---|---|---|
| `text-xs` | 12px | Meta, table headers, badges, eyebrows |
| `text-sm` | 14px | Primary body in dense UI, button labels |
| `text-base` | 16px | Section titles |
| `text-xl` | 20px | Page H1 |
| `text-2xl` | 24px | Large stat values |

**There is no display size larger than 24px in the product.**

**Weights used:** 400, 500, 600, 700.
- `500` is the workhorse for buttons and active labels.
- `600` for stat values and section titles.
- `700` only in agent-pill emphasis.

**Numbers are tabular.** `font-variant-numeric: tabular-nums` on every count, cost, time, token total. Empty cells render an em-dash `—`, never blank or "N/A".

### Spacing & layout

- Tailwind 4 spacing scale (4 / 8 / 12 / 16 / 20 / 24 / 32). Rarely above 24px. Page padding is `p-6`.
- **Tables are the dominant layout.** Left-aligned text, right-aligned numbers. Column headers are `text-xs uppercase tracking-wider text-text-tertiary`.
- **Cards** = `bg-bg-secondary border border-border rounded-lg`, optionally with a `bg-bg-tertiary` header strip.
- **Dense rows.** `py-2.5` to `py-3`. Agent pills are `px-1.5 py-0.5`.

### Borders, radii, shadows

- Borders are always `1px solid var(--color-border)`. Never thicker. Active tabs use `border-b-2 border-accent`.
- **Shadows are nearly non-existent.** Only toasts (`shadow-lg`). Use border + bg-shift for elevation, not shadow.
- No inner shadows. No protection gradients.

### Backgrounds & imagery

- **No background images. No patterns. No textures. No gradients.** The dashboard is a flat, neutral surface — content provides the visual rhythm via tables, pills, and color-coded dots.
- The only graphic asset is the **tamtam logo** (`public/logo.png` for dark, `public/logo-light.png` for light). Keep it small (36–52px tall) and don't recolor it.

### Animation

Three motions, all subtle:

| Animation | Duration | Easing | Usage |
|---|---|---|---|
| `spin` | 600ms | linear infinite | Spinners (`.spinner`, `.spinner-sm`) |
| `slideInUp` / `slideOutDown` | 300ms | ease-out / ease-in | Toasts |
| `skeleton-pulse` | 1500ms | ease-in-out infinite | Loading rectangles (`.skeleton`) |

Default transition for hovers is `transition-colors duration-150`. **Never animate layout. Never bounce. Never spring.**

### Interaction states

- **Hover** = background lifts one tier (`bg-bg-secondary` → `bg-bg-tertiary`) or text deepens (`text-text-secondary` → `text-text-primary`). Buttons darken from `accent` → `accent-hover`. **No scale, no shadow expand, no lift.**
- **Press / active** = no separate visual; the hover state covers the press window.
- **Focus** = `focus:ring-2 focus:ring-accent/30 focus:border-accent` on inputs; `outline: 2px solid var(--color-accent)` with 2px offset on buttons. Always keyboard-visible. Use the `.focus-ring` class on form elements.
- **Disabled** = `opacity-50 cursor-not-allowed`. No grayed-out colors.

### Privacy mode

`html.privacy-mode [data-private] { filter: blur(8px); }` blurs project names in screenshots. Mark sensitive cells with `data-private`. Don't use blur for "frosted glass" panels.

---

## Components

### Button component (`components/ui/Button.tsx`)

The canonical way to render buttons in TamTam. Import `Button` for interactive elements and `buttonVariants` when you need the class string applied to a non-button element (e.g. `<Link>`, `<a>`).

```tsx
import { Button, buttonVariants } from '@/components/ui/Button'

// interactive button
<Button variant="primary" onClick={handleSave}>Save</Button>

// link styled as a button
<Link href="/pipeline" className={buttonVariants({ variant: 'ghost' })}>Pipeline</Link>
```

**Variants** (prop `variant`, default `secondary`):

| Variant | Visual | Typical usage |
|---------|--------|---------------|
| `secondary` | bordered neutral | default workhorse — most action buttons |
| `primary` | translucent accent (border + bg/10) | contextual primary actions |
| `solid` | solid accent fill | marquee save/submit actions |
| `ghost` | transparent, text-secondary | nav links, separators, low-priority actions |
| `danger` | error text + hover fill | "Delete" before confirmation |
| `danger-solid` | solid red fill | confirmed destructive action |
| `warning` | amber border + translucent bg | caution states (e.g. pull with conflicts) |
| `info` | blue border + translucent bg | informational actions (e.g. Rebase) |
| `link` | inline text-accent, hover underline, no padding | inline prose/header actions (e.g. "clear" beside a label) |

**Size** (prop `size`, default `md`):

| Size | Padding | Text |
|------|---------|------|
| `md` | `px-3 py-1.5` | `text-sm` |
| `sm` | `px-2 py-1` | `text-xs` |

All variants automatically apply `disabled:opacity-50 disabled:cursor-not-allowed` — pass `disabled` as a boolean prop.

### CSS utility classes (from `app/globals.css`)

Use these reusable classes when Tailwind utilities would produce repetition. **Prefer the `Button` component** over raw CSS classes for all interactive buttons.

- `.btn-primary` — accent-filled button (legacy; prefer `<Button variant="solid">`)
- `.btn-secondary` — bordered neutral button (legacy; prefer `<Button variant="secondary">`)
- `.btn-custom` — outline button colored by `--btn-color` inline (project custom-actions; no `Button` equivalent)
- `.spinner` / `.spinner-sm` — 20px / 14px circular spinner
- `.skeleton` — pulsing loading rectangle
- `.focus-ring` — consistent ring for inputs
- `.terminal-markdown` — markdown rendering inside the terminal pane (dark-only)

**Toolbar atoms** (terminal panel header bar; all chips/groups align to a 24px row, inner tabs 20px):
- `.toolbar-btn` — bordered chip for standalone toggles (e.g. NEW, RECENT, thinking, trace); 24px tall, mono font
- `.toolbar-group` — grouped control container (e.g. ATTACH, MODEL); wraps `.toolbar-label` + one or more `.toolbar-tab` children
- `.toolbar-label` — uppercase eyebrow label inside a group or standalone before buttons; 10px, letter-spaced
- `.toolbar-tab` — inner selectable tab inside a `.toolbar-group`; 20px tall, no border, transparent background
- `.toolbar-pill` — selected-item capsule (e.g. active skill/doc name); 20px tall, accent-tinted border + fill, max-width 180px

Cards, tables, pills, toasts, status dots — compose with Tailwind utilities directly using the tokens above. See `docs/ui-preview/*.html` for canonical recipes.

---

## Iconography

- **Hand-rolled inline SVG**, almost all 14×14 or 16×16, `stroke="currentColor"`, `strokeWidth="1.8"`, `strokeLinecap="round"`, `strokeLinejoin="round"`.
- **No icon library is imported.** No Lucide, no Heroicons, no FontAwesome. Each icon is written inline where it's used.
- No PNG/SVG icon files in `public/` — only the logo. Icons live in JSX.
- Glyph style: outlined, geometric, slightly playful. Status dots are circles with a check or X.

**Unicode glyphs in active use:**
- `⟳` loading spinner in header
- `↑` unpushed commits, sort indicator
- `↑/↓/↕` sort indicators
- `▼/▲` sort indicators in stats
- `⚠️` error banner
- `✕` / `&#x2715;` dismiss
- `○ / ✓ / ✗ / !` pipeline-step states (rendered as plain text)

**Emoji used as iconography: only `🚀`** on the Release button. Treat this as the one exception, not a precedent. **Do not add 🎉, 💡, 🔥, ✨ — those don't fit the voice.**

If a new glyph is needed, draw it as a 14×14 or 16×16 inline SVG with `currentColor` stroke, 1.8px width, rounded caps. Adopting an icon library (Lucide is the closest stylistic match) requires explicit user approval — see `CLAUDE.md` *Dependency & Supply-Chain Security*.

---

## Voice & content

The product copy is **short, technical, and lowercase by default.** Assumes the reader is an engineer.

### Casing
- **Sentence case** for headings (`Agent Behavior`, `Workspace`, `Release Pipeline`).
- **lowercase** for status verbs and labels in dense UI (`idle`, `running`, `error`, `lgtm`, `needs attention`, `do not ship`, `review`, `reviewing…`).
- **UPPERCASE** reserved for verdicts in logs (`LGTM`, `NEEDS ATTENTION`, `DO NOT SHIP`) and column headers (`PROJECT`, `STATUS`, `CHANGES`).
- **Conventional-commit** style for any commit/release copy: `feat(scope): message`, ≤72 chars, present tense, no period.

### Pronouns
- **You** when speaking to the operator.
- **The agent / the pipeline / Claude** in third person — never "I".
- No "we." Never "let's."

### Tone
- Direct, slightly dry, occasionally blunt.
- No fluff phrasing. Buttons say `Save Settings`, `Send Test`, `Create Backup`, `🚀 Release`, `+ Add Template`. **Never** "Get started," "Welcome," "Discover your…"
- Help text is a single sentence.

### Microcopy patterns
- Empty state: terse, no illustration (`No projects found`).
- Loading: gerund + ellipsis (`Loading settings…`, `Scanning workspace…`, `Refreshing…`, `Reviewing…`).
- Error banner: `Failed to <verb>: <message>`.
- Confirmation: terse, exclamation, auto-dismiss (`Saved!`, `Done!`, `Sent!`).
- Empty cells: em-dash `—`, never blank.
- Numbers in tables: tabular-nums, lowercase units (`12K`, `$1.42`, `2h ago`, `↑3`).

---

## Standards checklist

Before merging UI work, verify:

1. **Tokens only.** No hardcoded hex colors in components — use `bg-bg-secondary`, `text-text-tertiary`, `border-border`, etc.
2. **No new fonts.** Geist + Geist Mono only. No `font-family` overrides.
3. **No new accent.** Single blue. No purple, no second brand color.
4. **No drop shadows** except on toasts.
5. **No gradients, background images, or textures.**
6. **No new icon library.** Inline SVG with the standard stroke recipe.
7. **No emoji** beyond `🚀` (Release button) and `⚠️` (error banner).
8. **Tabular numerics.** `font-variant-numeric: tabular-nums` on counts/costs/times.
9. **Em-dash for empty cells**, never blank or "N/A".
10. **Focus visible.** `.focus-ring` on inputs; `outline: 2px solid var(--color-accent)` on buttons.
11. **Privacy markers.** `data-private` on project names and any sensitive identifier.
12. **Sentence-case headings, lowercase status labels, UPPERCASE verdicts/column headers.**
13. **Live preview check.** Open the relevant `docs/ui-preview/*.html` and confirm the new pattern matches.
14. **DoD (per `CLAUDE.md`)**: server running under PM2 (`pnpm rebuild`), navigate via Playwright MCP, take a screenshot in both light and dark themes.

---

## Files

- `app/globals.css` — runtime source of truth (`@theme` tokens, `@font-face`, base classes)
- `public/fonts/Geist-Variable.woff2`, `public/fonts/GeistMono-Variable.woff2` — variable-axis webfonts (Vercel, SIL OFL)
- `public/logo.png`, `public/logo-light.png` — brand wordmark (dark / light)
- `docs/ui-preview/*.html` — canonical, copy-pasteable previews of every primitive (buttons, inputs, pills, toasts, status icons, type scale, color swatches, spacing, logo)
- `docs/UI.md` — this file

When changing a token, update `app/globals.css` and re-open the preview HTMLs to spot regressions; the previews are self-contained and re-import `colors_and_type.css` semantics inline, so they're handy for diffing visual intent against runtime output.
