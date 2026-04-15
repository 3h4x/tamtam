'use client'

import { useState, useEffect, useRef } from 'react'

export interface LogFrame {
  type: 'stdout' | 'stderr' | 'error' | 'status' | 'buffered' | string
  content: string
  timestamp: string
  metadata?: Record<string, unknown>
}

const FRAME_COLORS: Record<string, string> = {
  stdout: '#00ff00',
  stderr: '#ff0000',
  status: '#ffff00',
  error: '#ff6600',
}

function formatTimestamp(ts: string): string {
  try {
    const d = new Date(ts)
    return d.toISOString().replace('T', ' ').slice(0, 23)
  } catch {
    return ts
  }
}

interface FrameLineProps {
  frame: LogFrame
}

function FrameLine({ frame }: FrameLineProps) {
  const color = FRAME_COLORS[frame.type] ?? '#cccccc'
  return (
    <div
      data-testid="log-frame"
      data-frame-type={frame.type}
      className="mb-0.5 break-all"
      style={{ color }}
    >
      <span className="text-gray-500">[{formatTimestamp(frame.timestamp)}]</span>
      {' '}
      <span className="font-bold" style={{ color }}>[{frame.type.toUpperCase()}]</span>
      {' '}
      {frame.content}
    </div>
  )
}

interface StreamingLogProps {
  jobId: string
}

export function StreamingLog({ jobId }: StreamingLogProps) {
  const [frames, setFrames] = useState<LogFrame[]>([])
  const [connected, setConnected] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    const url = `ws://localhost:9999/ws/jobs/${jobId}/stream`
    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.onopen = () => setConnected(true)

    ws.onmessage = (event: MessageEvent) => {
      try {
        const frame: LogFrame = JSON.parse(event.data as string)
        if (frame.type === 'buffered') return
        setFrames((prev) => [...prev, frame])
      } catch {
        // ignore malformed frames
      }
    }

    ws.onclose = () => setConnected(false)
    ws.onerror = () => setConnected(false)

    return () => {
      ws.close()
    }
  }, [jobId])

  return (
    <div
      data-testid="streaming-log"
      data-connected={connected}
      className="h-[600px] overflow-y-auto font-mono text-[13px] bg-[#0d0d0d] p-3 border border-[#333333] rounded-sm box-border"
      style={{ borderLeft: `4px solid ${connected ? '#4ade80' : '#666666'}` }}
    >
      {frames.map((frame, i) => (
        <FrameLine key={i} frame={frame} />
      ))}
    </div>
  )
}
