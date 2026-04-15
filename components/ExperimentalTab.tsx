'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { runProject, fetchSkills } from '@/lib/client-api'
import type { Skill } from '@/lib/client-api'

interface RunSession {
  id: string
  jobId: string
  prompt: string
  status: 'running' | 'done' | 'error'
  output: string
  startedAt: number
  exitCode?: number
}

interface ExperimentalTabProps {
  projectName: string
}

function RunPanel({ session, onRemove }: { session: RunSession; onRemove: () => void }) {
  const logRef = useRef<HTMLPreElement>(null)
  const [autoScroll, setAutoScroll] = useState(true)
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    if (autoScroll && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [session.output, autoScroll])

  const handleScroll = () => {
    if (!logRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = logRef.current
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 50)
  }

  const elapsed = Math.floor(((session.status === 'running' ? Date.now() / 1000 : (session.startedAt + (session.output.length > 0 ? 1 : 0))) - session.startedAt))
  const promptPreview = session.prompt.length > 80 ? session.prompt.slice(0, 80) + '...' : session.prompt

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <div
        className="flex items-center gap-3 px-4 py-2 bg-bg-secondary cursor-pointer"
        onClick={() => setCollapsed(!collapsed)}
      >
        <span className={`w-2 h-2 rounded-full shrink-0 ${
          session.status === 'running' ? 'bg-status-warning animate-pulse' :
          session.exitCode === 0 ? 'bg-status-success' : 'bg-status-error'
        }`} />
        <span className="text-sm text-text-primary font-medium truncate flex-1">{promptPreview}</span>
        <span className="text-xs text-text-secondary shrink-0">{session.jobId.split('-').slice(-1)[0]}</span>
        <span className="text-xs text-text-secondary shrink-0">{collapsed ? '>' : 'v'}</span>
        {session.status === 'done' && (
          <button
            className="text-xs text-text-secondary hover:text-status-error px-1"
            onClick={(e) => { e.stopPropagation(); onRemove() }}
            title="Dismiss"
          >
            x
          </button>
        )}
      </div>
      {!collapsed && (
        <pre
          ref={logRef}
          onScroll={handleScroll}
          className="font-mono text-sm text-text-primary whitespace-pre-wrap bg-[#0d0d0d] p-4 overflow-y-auto m-0"
          style={{ maxHeight: '400px', minHeight: '100px' }}
        >
          {session.output || (session.status === 'running' ? 'Waiting for output...' : 'No output.')}
        </pre>
      )}
    </div>
  )
}

export function ExperimentalTab({ projectName }: ExperimentalTabProps) {
  const [prompt, setPrompt] = useState('')
  const [sessions, setSessions] = useState<RunSession[]>([])
  const [submitting, setSubmitting] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const eventSourcesRef = useRef<Map<string, EventSource>>(new Map())

  // Skills
  const [allSkills, setAllSkills] = useState<Skill[]>([])
  const [selectedSkills, setSelectedSkills] = useState<Skill[]>([])
  const [skillSearch, setSkillSearch] = useState('')
  const [showSkillPicker, setShowSkillPicker] = useState(false)
  const skillSearchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    fetchSkills().then(data => setAllSkills(data.skills)).catch(() => {})
  }, [])

  useEffect(() => {
    if (showSkillPicker) skillSearchRef.current?.focus()
  }, [showSkillPicker])

  const filteredSkills = allSkills.filter(s =>
    !selectedSkills.some(sel => sel.id === s.id) &&
    (skillSearch === '' ||
      s.name.toLowerCase().includes(skillSearch.toLowerCase()) ||
      s.description.toLowerCase().includes(skillSearch.toLowerCase()))
  )

  const toggleSkill = (skill: Skill) => {
    if (selectedSkills.some(s => s.id === skill.id)) {
      setSelectedSkills(prev => prev.filter(s => s.id !== skill.id))
    } else {
      setSelectedSkills(prev => [...prev, skill])
      setSkillSearch('')
      setShowSkillPicker(false)
    }
  }

  // Cleanup EventSources on unmount
  useEffect(() => {
    return () => {
      for (const es of eventSourcesRef.current.values()) {
        es.close()
      }
    }
  }, [])

  const startStreaming = useCallback((jobId: string, sessionId: string) => {
    const es = new EventSource(`/api/streaming/${jobId}`)
    eventSourcesRef.current.set(sessionId, es)

    es.onmessage = (event) => {
      setSessions(prev => prev.map(s => {
        if (s.id !== sessionId) return s
        return { ...s, output: s.output + event.data + '\n' }
      }))
    }

    es.onerror = () => {
      es.close()
      eventSourcesRef.current.delete(sessionId)
      // Mark as done — poll for final status
      setSessions(prev => prev.map(s => {
        if (s.id !== sessionId || s.status !== 'running') return s
        return { ...s, status: 'done' }
      }))
    }
  }, [])

  // Poll running sessions for status
  useEffect(() => {
    const running = sessions.filter(s => s.status === 'running')
    if (running.length === 0) return

    const interval = setInterval(async () => {
      for (const session of running) {
        try {
          const res = await fetch(`/api/projects/jobs/${session.jobId}`)
          if (!res.ok) continue
          const data = await res.json()
          if (data.status === 'done') {
            setSessions(prev => prev.map(s => {
              if (s.id !== session.id) return s
              return { ...s, status: 'done', exitCode: data.exit_code }
            }))
            const es = eventSourcesRef.current.get(session.id)
            if (es) { es.close(); eventSourcesRef.current.delete(session.id) }
          }
        } catch {}
      }
    }, 5000)

    return () => clearInterval(interval)
  }, [sessions])

  const handleRun = async () => {
    if (!prompt.trim() || submitting) return
    setSubmitting(true)
    try {
      // Compose skills into prompt
      let fullPrompt = prompt.trim()
      if (selectedSkills.length > 0) {
        const skillContext = selectedSkills
          .map(s => `## ${s.name}\n${s.content}`)
          .join('\n\n---\n\n')
        fullPrompt = skillContext + '\n\n---\n\n' + fullPrompt
      }
      const result = await runProject(projectName, fullPrompt)
      const sessionId = crypto.randomUUID()
      const session: RunSession = {
        id: sessionId,
        jobId: result.job_id,
        prompt: prompt.trim(),
        status: 'running',
        output: '',
        startedAt: Date.now() / 1000,
      }
      setSessions(prev => [session, ...prev])
      startStreaming(result.job_id, sessionId)
      setPrompt('')
    } catch (err) {
      const sessionId = crypto.randomUUID()
      setSessions(prev => [{
        id: sessionId,
        jobId: 'error',
        prompt: prompt.trim(),
        status: 'error',
        output: err instanceof Error ? err.message : 'Failed to start',
        startedAt: Date.now() / 1000,
        exitCode: -1,
      }, ...prev])
    } finally {
      setSubmitting(false)
      textareaRef.current?.focus()
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && e.metaKey) {
      e.preventDefault()
      handleRun()
    }
  }

  const removeSession = (id: string) => {
    const es = eventSourcesRef.current.get(id)
    if (es) { es.close(); eventSourcesRef.current.delete(id) }
    setSessions(prev => prev.filter(s => s.id !== id))
  }

  const runningCount = sessions.filter(s => s.status === 'running').length

  return (
    <div className="mt-4 flex flex-col gap-4">
      {/* Prompt input */}
      <div className="bg-bg-secondary rounded-lg p-4">
        <div className="flex items-center gap-2 mb-2">
          <h3 className="text-sm font-semibold text-text-secondary uppercase tracking-wider m-0">Run Claude</h3>
          {runningCount > 0 && (
            <span className="px-2 py-0.5 text-xs rounded-full bg-status-warning/15 text-status-warning font-medium">
              {runningCount} running
            </span>
          )}
        </div>

        {/* Skills picker */}
        <div className="flex items-center gap-2 mb-2 flex-wrap">
          {selectedSkills.map(skill => (
            <span
              key={skill.id}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md bg-accent/10 text-accent border border-accent/30"
            >
              {skill.name}
              <button
                className="text-accent/60 hover:text-accent ml-0.5 cursor-pointer"
                onClick={() => toggleSkill(skill)}
              >
                x
              </button>
            </span>
          ))}
          <div className="relative">
            <button
              className="px-2 py-1 text-xs border border-border rounded-md bg-bg-tertiary text-text-secondary hover:text-text-primary hover:border-accent cursor-pointer"
              onClick={() => setShowSkillPicker(!showSkillPicker)}
            >
              + Skill
            </button>
            {showSkillPicker && (
              <div className="absolute top-full left-0 mt-1 w-64 bg-bg-primary border border-border rounded-lg shadow-xl z-50 overflow-hidden">
                <input
                  ref={skillSearchRef}
                  type="text"
                  className="w-full px-3 py-2 text-sm bg-bg-secondary border-b border-border text-text-primary outline-none placeholder:text-text-tertiary"
                  value={skillSearch}
                  onChange={(e) => setSkillSearch(e.target.value)}
                  placeholder="Search skills..."
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') { setShowSkillPicker(false); setSkillSearch('') }
                    if (e.key === 'Enter' && filteredSkills.length > 0) toggleSkill(filteredSkills[0])
                  }}
                />
                <div className="max-h-48 overflow-y-auto">
                  {filteredSkills.length === 0 ? (
                    <div className="px-3 py-2 text-xs text-text-tertiary">
                      {allSkills.length === 0 ? 'No skills defined yet' : 'No matches'}
                    </div>
                  ) : (
                    filteredSkills.map(skill => (
                      <button
                        key={skill.id}
                        className="w-full px-3 py-2 text-left text-sm hover:bg-bg-secondary cursor-pointer border-none bg-transparent text-text-primary"
                        onClick={() => toggleSkill(skill)}
                      >
                        <div className="font-medium">{skill.name}</div>
                        {skill.description && (
                          <div className="text-xs text-text-tertiary truncate">{skill.description}</div>
                        )}
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        <textarea
          ref={textareaRef}
          className="w-full p-3 font-mono text-sm bg-bg-tertiary border border-border rounded-md text-text-primary resize-y outline-none focus:border-accent placeholder:text-text-tertiary"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="What should Claude do?"
          rows={3}
          disabled={submitting}
        />
        <div className="flex items-center justify-between mt-2">
          <span className="text-text-tertiary text-xs">
            Cmd+Enter to run{selectedSkills.length > 0 ? ` | ${selectedSkills.length} skill${selectedSkills.length > 1 ? 's' : ''} attached` : ''} | --print mode
          </span>
          <button
            className="px-4 py-1.5 text-sm bg-accent text-white rounded-md hover:bg-accent-hover cursor-pointer"
            onClick={handleRun}
            disabled={!prompt.trim() || submitting}
          >
            {submitting ? 'Starting...' : 'Run'}
          </button>
        </div>
      </div>

      {/* Sessions */}
      {sessions.length > 0 && (
        <div className="flex flex-col gap-3">
          {sessions.map(session => (
            <RunPanel
              key={session.id}
              session={session}
              onRemove={() => removeSession(session.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
