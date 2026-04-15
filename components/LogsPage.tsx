'use client'

import { useState, useEffect } from 'react'
import { fetchProjects, fetchProjectLogs } from '@/lib/client-api'
import type { LogEntry } from '@/lib/client-api'

interface ProjectLogs {
  project: string
  logs: LogEntry[]
  loading: boolean
}

export function LogsPage() {
  const [projects, setProjects] = useState<string[]>([])
  const [selectedProject, setSelectedProject] = useState<string | null>(null)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')

  useEffect(() => {
    fetchProjects()
      .then((data) => {
        const unique = [...new Set(data.tasks.map(t => t.project))]
        setProjects(unique.sort())
      })
      .catch(() => {})
  }, [])

  const loadLogs = async (project: string) => {
    setSelectedProject(project)
    setLoading(true)
    try {
      const data = await fetchProjectLogs(project)
      setLogs(data.logs)
    } catch {
      setLogs([])
    } finally {
      setLoading(false)
    }
  }

  const filteredLogs = search
    ? logs.filter(l =>
        l.filename.toLowerCase().includes(search.toLowerCase()) ||
        l.content.toLowerCase().includes(search.toLowerCase())
      )
    : logs

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold text-text-primary">
          Logs
          {selectedProject && (
            <>
              {' — '}{selectedProject}
              <button
                className="text-accent hover:underline text-sm ml-2"
                onClick={() => { setSelectedProject(null); setLogs([]) }}
              >
                clear
              </button>
            </>
          )}
        </h2>
      </div>

      {!selectedProject ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3">
          {projects.map((p) => (
            <button
              key={p}
              className="px-4 py-3 text-sm border border-border rounded-lg bg-bg-secondary text-text-primary hover:bg-bg-tertiary cursor-pointer text-left font-medium"
              onClick={() => loadLogs(p)}
            >
              {p}
            </button>
          ))}
          {projects.length === 0 && (
            <div className="text-text-secondary text-sm">Loading projects...</div>
          )}
        </div>
      ) : loading ? (
        <div className="flex items-center gap-2 justify-center py-8">
          <div className="spinner" />
          <span className="text-text-secondary">Loading logs...</span>
        </div>
      ) : (
        <>
          {logs.length > 1 && (
            <input
              type="text"
              className="w-full max-w-[400px] mb-4 px-3 py-2 text-sm bg-bg-secondary border border-border rounded-md text-text-primary placeholder:text-text-secondary"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search logs..."
            />
          )}
          {filteredLogs.length === 0 ? (
            <div className="text-text-secondary text-sm">No logs found for {selectedProject}</div>
          ) : (
            filteredLogs.map((log) => (
              <details key={log.filename} className="mb-2 border border-border rounded-lg overflow-hidden">
                <summary className="px-4 py-2 bg-bg-secondary text-text-primary text-sm font-medium cursor-pointer hover:bg-bg-tertiary">{log.filename}</summary>
                <pre className="font-mono text-sm text-text-primary whitespace-pre-wrap bg-bg-tertiary p-4 overflow-x-auto max-h-[500px] overflow-y-auto">{log.content}</pre>
              </details>
            ))
          )}
        </>
      )}
    </div>
  )
}
