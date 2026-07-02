'use client'

import { useMemo, useState } from 'react'
import type { ToolEntry } from '@/lib/terminal/terminal-session-store'

export function ToolBlock({ tool, executing }: { tool: ToolEntry; executing?: boolean }) {
  const [collapsed, setCollapsed] = useState(true)

  // Memoize the parse + summary pick. Terminal sessions can mount hundreds
  // of ToolBlocks at once, and the parent re-renders on every streaming
  // chunk; without this, every chunk causes N JSON.parse calls for tool
  // inputs whose content hasn't changed since first mount.
  const summary = useMemo(() => {
    try {
      const input = JSON.parse(tool.input || '{}') as Record<string, unknown>
      const picked =
        (input.file_path as string | undefined) ||
        (input.command as string | undefined) ||
        (input.pattern as string | undefined) ||
        (input.query as string | undefined) ||
        (input.url as string | undefined) ||
        (input.path as string | undefined) ||
        (input.description as string | undefined) ||
        ''
      return picked ? picked.replace(/\s*\n\s*/g, ' ').trim() : ''
    } catch {
      return tool.input?.slice(0, 60) || ''
    }
  }, [tool.input])

  const hasResult = !!tool.result
  const resultPreview = useMemo(() => {
    if (!tool.result) return null
    return tool.result.length > 600 ? tool.result.slice(0, 600) + '...' : tool.result
  }, [tool.result])

  // One accent for every tool name — the tool identity is already the text;
  // a per-tool color rainbow broke the single-accent token system.
  const nameColor = 'text-accent'
  const clickable = hasResult

  return (
    <div className="mx-4 group/tool">
      <div
        className={`flex items-center gap-2 px-2 py-0.5 rounded-sm leading-tight ${clickable ? 'cursor-pointer hover:bg-bg-secondary' : ''}`}
        onClick={() => clickable && setCollapsed(!collapsed)}
      >
        {executing && !hasResult && (
          <span className="w-1.5 h-1.5 rounded-full bg-status-warning animate-pulse shrink-0" />
        )}
        <span className={`${nameColor} text-xs font-mono shrink-0`}>{tool.name}</span>
        {summary && (
          <span className="text-text-tertiary text-xs font-mono truncate min-w-0 flex-1">{summary}</span>
        )}
        {hasResult && tool.result && (
          <span className="text-[10px] text-text-tertiary/50 shrink-0 font-mono tabular-nums">
            {tool.result.length > 1024
              ? `${(tool.result.length / 1024).toFixed(1)}k`
              : `${tool.result.length}`}
          </span>
        )}
        {hasResult && (
          <span className="text-[10px] text-text-tertiary/60 shrink-0 transition-transform" style={{ transform: collapsed ? 'rotate(0deg)' : 'rotate(90deg)' }}>›</span>
        )}
      </div>
      {!collapsed && hasResult && (
        <pre className="ml-2 mt-1 mb-1 px-3 py-2 text-xs text-text-secondary bg-bg-primary border-l-2 border-border m-0 overflow-x-auto whitespace-pre-wrap max-h-60 overflow-y-auto font-mono">
          {resultPreview}
        </pre>
      )}
    </div>
  )
}
