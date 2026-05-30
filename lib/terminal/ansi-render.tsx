import type { ReactNode, CSSProperties } from 'react'

const FG: Record<number, string> = {
  30: '#3e3e3e', 31: '#cc6666', 32: '#a7c080', 33: '#d6b86b',
  34: '#7aa6da', 35: '#c594c5', 36: '#6fb4b0', 37: '#cccccc',
  90: '#666666', 91: '#e28d8d', 92: '#b6d98a', 93: '#e6cc80',
  94: '#9cc0e7', 95: '#d6aad6', 96: '#88c5c1', 97: '#ffffff',
}
const BG: Record<number, string> = {
  40: '#1a1a1a', 41: '#5a2a2a', 42: '#2a5a2a', 43: '#5a5a2a',
  44: '#2a2a5a', 45: '#5a2a5a', 46: '#2a5a5a', 47: '#5a5a5a',
}

interface State {
  fg?: string
  bg?: string
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
}

function styleFor(s: State): CSSProperties {
  const css: CSSProperties = {}
  if (s.fg) css.color = s.fg
  if (s.bg) css.backgroundColor = s.bg
  if (s.bold) css.fontWeight = 'bold'
  if (s.dim) css.opacity = 0.6
  if (s.italic) css.fontStyle = 'italic'
  if (s.underline) css.textDecoration = 'underline'
  return css
}

function applyCodes(state: State, codes: number[]): State {
  let s = { ...state }
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i]
    if (c === 0) s = {}
    else if (c === 1) s.bold = true
    else if (c === 2) s.dim = true
    else if (c === 3) s.italic = true
    else if (c === 4) s.underline = true
    else if (c === 22) { s.bold = false; s.dim = false }
    else if (c === 23) s.italic = false
    else if (c === 24) s.underline = false
    else if (c === 39) s.fg = undefined
    else if (c === 49) s.bg = undefined
    else if (FG[c]) s.fg = FG[c]
    else if (BG[c]) s.bg = BG[c]
  }
  return s
}

// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\x1b?\[([0-9]+(?:;[0-9]+)*)m/g

export function hasAnsi(text: string): boolean {
  ANSI_REGEX.lastIndex = 0
  let count = 0
  while (ANSI_REGEX.exec(text) !== null) {
    if (++count >= 2) return true
  }
  return false
}

export function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, '')
}

function reflow(text: string): string {
  if (text.includes('\n')) return text
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/\s*(?=\x1b?\[3[12]m\s?[✓×✗])/g, '\n')
    .replace(/\s+(?=(Test Files|Tests|Start at|Duration|RERUN)\b)/g, '\n')
    .replace(/^\n+/, '')
}

function parseAnsi(text: string): ReactNode[][] {
  text = reflow(text)
  const regex = new RegExp(ANSI_REGEX.source, 'g')
  const lines: ReactNode[][] = [[]]
  let state: State = {}
  let lastIndex = 0
  let match: RegExpExecArray | null
  let key = 0
  const push = (chunk: string) => {
    if (!chunk) return
    const pieces = chunk.split('\n')
    for (let index = 0; index < pieces.length; index++) {
      const piece = pieces[index]
      if (piece) {
        const hasStyle = state.fg || state.bg || state.bold || state.dim || state.italic || state.underline
        if (hasStyle) {
          lines[lines.length - 1].push(<span key={key++} style={styleFor(state)}>{piece}</span>)
        } else {
          lines[lines.length - 1].push(piece)
        }
      }
      if (index < pieces.length - 1) {
        lines.push([])
      }
    }
  }
  while ((match = regex.exec(text)) !== null) {
    push(text.slice(lastIndex, match.index))
    const codes = match[1].split(';').map(n => (n === '' ? 0 : parseInt(n, 10)))
    state = applyCodes(state, codes)
    lastIndex = regex.lastIndex
  }
  push(text.slice(lastIndex))
  return lines
}

export function renderAnsiLines(text: string): ReactNode[][] {
  return parseAnsi(text)
}

export function renderAnsi(text: string): ReactNode[] {
  const lines = parseAnsi(text)
  const parts: ReactNode[] = []
  for (let index = 0; index < lines.length; index++) {
    if (index > 0) parts.push('\n')
    parts.push(...lines[index])
  }
  return parts
}
