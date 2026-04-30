'use client'

import { useState, useEffect } from 'react'
import { fetchProjects, fetchProjectLogs } from '@/lib/client-api'
import type { LogEntry } from '@/lib/client-api'

export function LogsPage() {
  const [projects, setProjects] = useState<string[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [projectsError, setProjectsError] = useState<string | null>(null)
  const [selectedProject, setSelectedProject] = useState<string | null>(null)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')

  const loadProjects = () => {
    setProjectsLoading(true)
    setProjectsError(null)
    fetchProjects()
      .then((data) => {
        const unique = [...new Set(data.tasks.map(t => t.project))]
        setProjects(unique.sort())
      })
      .catch((err) => {
        console.error('Failed to load projects', err)
        setProjectsError('Failed to load projects.')
      })
      .finally(() => setProjectsLoading(false))
  }

  useEffect(loadProjects, [])

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
        projectsLoading ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="skeleton h-12 rounded-lg" style={{ opacity: 1 - i * 0.1 }} />
            ))}
          </div>
        ) : projectsError ? (
          <div className="flex flex-col items-center justify-center py-12 gap-3 text-center">
            <svg className="w-8 h-8 text-status-error" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.4">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m0 3.75h.008v.008H12v-.008zM21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className="text-sm text-text-secondary">{projectsError}</p>
            <button
              className="px-3 py-1.5 text-xs border border-border rounded-md text-text-primary hover:bg-bg-tertiary cursor-pointer"
              onClick={loadProjects}
            >
              Retry
            </button>
          </div>
        ) : projects.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 gap-2 text-center">
            <svg className="w-8 h-8 text-text-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 9.75h16.5m-16.5 6.75h16.5M3.75 6.75h16.5m-16.5 6.75h16.5" />
            </svg>
            <p className="text-sm text-text-secondary">No projects with logs yet.</p>
            <p className="text-xs text-text-tertiary">Run an agent to start collecting logs.</p>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3">
            {projects.map((p) => (
              <button
                key={p}
                className="px-4 py-3 text-sm border border-border rounded-lg bg-bg-secondary text-text-primary hover:bg-bg-tertiary cursor-pointer text-left font-medium transition-colors"
                onClick={() => loadLogs(p)}
              >
                {p}
              </button>
            ))}
          </div>
        )
      ) : loading ? (
        <div className="space-y-2 animate-pulse mt-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-10 border border-border rounded-lg bg-bg-secondary" style={{ opacity: 1 - i * 0.2 }} />
          ))}
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
