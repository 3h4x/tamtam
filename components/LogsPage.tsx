'use client'

import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/Button'
import { ErrorState } from '@/components/ErrorState'
import { EmptyState } from '@/components/ui/EmptyState'
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
  const [expandedLogs, setExpandedLogs] = useState<Set<string>>(new Set())
  const [logsError, setLogsError] = useState<string | null>(null)

  const resetProjectScopedState = () => {
    setSearch('')
    setExpandedLogs(new Set())
    setLogsError(null)
  }

  const toggleLog = (filename: string) => {
    setExpandedLogs(prev => {
      const next = new Set(prev)
      if (next.has(filename)) next.delete(filename)
      else next.add(filename)
      return next
    })
  }

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
    // Reset search and prior error when switching projects so a stale
    // query from the previous project doesn't filter the new one to empty.
    resetProjectScopedState()
    try {
      const data = await fetchProjectLogs(project)
      setLogs(data.logs)
    } catch (err) {
      // Don't pretend "no logs" when the load actually failed — the empty-
      // state and the failure state look identical and the operator can't
      // tell whether to retry or whether the project really has no logs.
      console.error(`Failed to load logs for ${project}`, err)
      setLogs([])
      setLogsError('Failed to load logs.')
    } finally {
      setLoading(false)
    }
  }

  const searchLower = search.toLowerCase()
  const filteredLogs = search
    ? logs.filter(l =>
        l.filename.toLowerCase().includes(searchLower) ||
        l.content.toLowerCase().includes(searchLower)
      )
    : logs

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-semibold text-text-primary">
          Logs
          {selectedProject && (
            <>
              {' — '}{selectedProject}
              <Button
                variant="link"
                className="ml-2"
                onClick={() => { setSelectedProject(null); setLogs([]); resetProjectScopedState() }}
              >
                clear
              </Button>
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
          <ErrorState message={projectsError} onRetry={loadProjects} />
        ) : projects.length === 0 ? (
          <EmptyState
            icon={
              <svg className="w-8 h-8 text-text-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 9.75h16.5m-16.5 6.75h16.5M3.75 6.75h16.5m-16.5 6.75h16.5" />
              </svg>
            }
            title="No projects with logs yet."
            description="Run an agent to start collecting logs."
          />
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3">
            {projects.map((p) => (
              <Button
                key={p}
                className="justify-start rounded-lg px-4 py-3 text-left"
                onClick={() => loadLogs(p)}
              >
                {p}
              </Button>
            ))}
          </div>
        )
      ) : loading ? (
        <div className="space-y-2 mt-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="skeleton h-10 rounded-lg" />
          ))}
        </div>
      ) : logsError ? (
        <ErrorState
          message={logsError}
          onRetry={() => selectedProject && loadLogs(selectedProject)}
        />
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
            <EmptyState
              icon={
                <svg className="w-7 h-7 text-text-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                </svg>
              }
              title={`No logs found for ${selectedProject}`}
            />
          ) : (
            filteredLogs.map((log) => (
              <div key={log.filename} className="mb-2 border border-border rounded-lg overflow-hidden">
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full justify-between gap-3 rounded-none border-0 bg-bg-secondary px-4 py-2.5 text-left text-sm font-medium text-text-primary hover:bg-bg-tertiary"
                  onClick={() => toggleLog(log.filename)}
                >
                  <span className="font-mono truncate">{log.filename}</span>
                  <svg
                    className={`w-3.5 h-3.5 text-text-tertiary transition-transform duration-150 shrink-0 ml-2 ${expandedLogs.has(log.filename) ? 'rotate-180' : ''}`}
                    fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </Button>
                {expandedLogs.has(log.filename) && (
                  <pre className="font-mono text-sm text-text-primary whitespace-pre-wrap bg-bg-tertiary p-4 overflow-x-auto max-h-[500px] overflow-y-auto border-t border-border">{log.content}</pre>
                )}
              </div>
            ))
          )}
        </>
      )}
    </div>
  )
}
