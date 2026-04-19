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
            <div className="flex items-center gap-2 text-text-secondary text-sm">
              <div className="spinner-sm" />
              Loading projects…
            </div>
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
              className="w-full max-w-[400px] mb-4 px-3 py-2 text-sm bg-bg-secondary border border-border rounded-md text-text-primary placeholder:text-text-secondary focus:outline-none focus:ring-2 focus:ring-accent/20 focus:border-accent transition-colors"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search logs..."
            />
          )}
          {filteredLogs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 gap-2 text-center">
              <svg className="w-7 h-7 text-text-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
              </svg>
              <p className="text-sm text-text-secondary">No logs found for {selectedProject}</p>
            </div>
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
