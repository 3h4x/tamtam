'use client'

import { useState } from 'react'
import type { ToolEntry } from '@/lib/terminal/terminal-session-store'

const TOOL_COLORS: Record<string, string> = {
  Bash: 'text-[#f0b070]',
  Read: 'text-[#8fcfff]',
  Edit: 'text-[#c9b4ff]',
  Write: 'text-[#c9b4ff]',
  Glob: 'text-[#8fdfb0]',
  Grep: 'text-[#8fdfb0]',
  Task: 'text-[#ffb0c0]',
  WebFetch: 'text-[#ffd080]',
  WebSearch: 'text-[#ffd080]',
}

export function ToolBlock({ tool, executing }: { tool: ToolEntry; executing?: boolean }) {
  const [collapsed, setCollapsed] = useState(true)

  let summary = ''
  try {
    const input = JSON.parse(tool.input || '{}')
    summary =
      input.file_path ||
      input.command ||
      input.pattern ||
      input.query ||
      input.url ||
      input.path ||
      input.description ||
      ''
    // Collapse multi-line commands to single line for compactness
    if (summary) summary = summary.replace(/\s*\n\s*/g, ' ').trim()
  } catch {
    summary = tool.input?.slice(0, 60) || ''
  }

  const hasResult = !!tool.result
  const resultPreview = tool.result
    ? tool.result.length > 600 ? tool.result.slice(0, 600) + '...' : tool.result
    : null

  const nameColor = TOOL_COLORS[tool.name] ?? 'text-[#9cc7ff]'
  const clickable = hasResult

  return (
    <div className="mx-4 group/tool">
      <div
        className={`flex items-center gap-2 px-2 py-0.5 rounded-sm leading-tight ${clickable ? 'cursor-pointer hover:bg-[#181818]' : ''}`}
        onClick={() => clickable && setCollapsed(!collapsed)}
      >
        {executing && !hasResult && (
          <span className="w-1.5 h-1.5 rounded-full bg-status-warning animate-pulse shrink-0" />
        )}
        <span className={`${nameColor} text-xs font-mono shrink-0`}>{tool.name}</span>
        {summary && (
          <span className="text-[#888] text-xs font-mono truncate min-w-0 flex-1">{summary}</span>
        )}
        {hasResult && tool.result && (
          <span className="text-[10px] text-[#444] shrink-0 font-mono tabular-nums">
            {tool.result.length > 1024
              ? `${(tool.result.length / 1024).toFixed(1)}k`
              : `${tool.result.length}`}
          </span>
        )}
        {hasResult && (
          <span className="text-[10px] text-[#555] shrink-0 transition-transform" style={{ transform: collapsed ? 'rotate(0deg)' : 'rotate(90deg)' }}>›</span>
        )}
      </div>
      {!collapsed && hasResult && (
        <pre className="ml-2 mt-1 mb-1 px-3 py-2 text-xs text-[#999] bg-[#0d0d0d] border-l-2 border-[#2a2a2a] m-0 overflow-x-auto whitespace-pre-wrap max-h-60 overflow-y-auto font-mono">
          {resultPreview}
        </pre>
      )}
    </div>
  )
}
