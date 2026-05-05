import { useCallback } from 'react'
import { runProject } from '@/lib/client-api'
import { terminalStore, type SkillItem, type DocItem } from '@/lib/terminal/terminal-session-store'
import type { ModelTier } from '@/lib/agents/model-aliases'

interface SubmitDeps {
  projectName: string
  streaming: boolean
  input: string
  pendingImages: File[]
  pendingImageUrls: string[]
  selectedItems: SkillItem[]
  selectedDocs: DocItem[]
  model: ModelTier
  issueContextRef: React.RefObject<{ number: number; repo: string; title: string } | null>
  draftBeforeHistoryRef: React.MutableRefObject<string>
  setInput: (v: string) => void
  setPendingImages: React.Dispatch<React.SetStateAction<File[]>>
  setPendingImageUrls: React.Dispatch<React.SetStateAction<string[]>>
  setPromptHistory: React.Dispatch<React.SetStateAction<string[]>>
  setHistoryIdx: React.Dispatch<React.SetStateAction<number | null>>
  setMessageQueue: (v: string[] | ((prev: string[]) => string[])) => void
}

export function useHandleSubmit(deps: SubmitDeps) {
  const {
    projectName, streaming, input, pendingImages, pendingImageUrls,
    selectedItems, selectedDocs, model, issueContextRef, draftBeforeHistoryRef,
    setInput, setPendingImages, setPendingImageUrls, setPromptHistory,
    setHistoryIdx, setMessageQueue,
  } = deps

  const handleSubmit = useCallback(async (autoText?: string) => {
    const text = (autoText !== undefined ? autoText : input).trim()
    if (!text && pendingImages.length === 0) return

    if (streaming) {
      if (text) {
        setMessageQueue(prev => [...prev, text])
        setInput('')
      }
      return
    }

    const imageUrls = [...pendingImageUrls]
    const imageFiles = [...pendingImages]
    if (text) {
      setPromptHistory(prev => {
        const updated = [text, ...prev.filter(p => p !== text)].slice(0, 50)
        try { localStorage.setItem('tamtam-prompt-history', JSON.stringify(updated)) } catch {}
        return updated
      })
    }
    setHistoryIdx(null)
    draftBeforeHistoryRef.current = ''
    setInput('')
    setPendingImages([])
    setPendingImageUrls([])

    terminalStore.update(projectName, (s) => ({
      history: [...s.history, { role: 'user', text, imageUrls: imageUrls.length > 0 ? imageUrls : undefined }],
      lastStats: null,
    }))

    try {
      const cur = terminalStore.get(projectName)
      const sessionId = cur.claudeSessionId
      const isFollowUp = !!sessionId
      let fullPrompt = text

      const dbSkills = selectedItems.filter(s => s.source === 'db' && s.content)
      if (dbSkills.length > 0) {
        const skillContext = dbSkills.map(s => `## ${s.name}\n${s.content}`).join('\n\n---\n\n')
        fullPrompt = skillContext + '\n\n---\n\n' + fullPrompt
      }
      if (selectedDocs.length > 0) {
        const docContext = selectedDocs.map(d => `## ${d.name}\n${d.content}`).join('\n\n---\n\n')
        fullPrompt = docContext + '\n\n---\n\n' + fullPrompt
      }

      const personaPaths = selectedItems
        .filter(s => s.source === 'file')
        .map(s => s.id.replace('persona:', ''))

      const contextMetaStr = !isFollowUp
        ? JSON.stringify({
            skills: selectedItems.map(s => ({ id: s.id, name: s.name, description: s.description, content: s.content, source: s.source })),
            docs: selectedDocs.map(d => ({ name: d.name, content: d.content })),
          })
        : undefined

      if (!isFollowUp && cur.currentJobId) {
        const inspectableKinds = ['release', 'push', 'fix-push', 'test', 'review', 'fix', 'fix-ci']
        const jobKindFromId = inspectableKinds.find(k => cur.currentJobId!.includes(`-${k}-`))
        if (jobKindFromId) {
          try {
            const logRes = await fetch(`/api/jobs/${encodeURIComponent(cur.currentJobId)}/logs`)
            if (logRes.ok) {
              const logData = await logRes.json()
              const rawLog: string = typeof logData.content === 'string' ? logData.content : ''
              if (rawLog.trim()) {
                const tail = rawLog.length > 12000 ? '...(truncated)...\n' + rawLog.slice(-12000) : rawLog
                fullPrompt = `## Previous session output (${jobKindFromId} job, for context)\n\n\`\`\`\n${tail}\n\`\`\`\n\n---\n\n${fullPrompt}`
              }
            }
          } catch {
            // Best-effort
          }
        }
      }

      const issueCtx = !sessionId ? issueContextRef.current : null
      const result = await runProject(projectName, fullPrompt, {
        files: imageFiles.length > 0 ? imageFiles : undefined,
        personas: personaPaths.length > 0 ? personaPaths : undefined,
        model,
        resumeSessionId: sessionId || undefined,
        // When resuming, pin to the originating provider — session IDs are
        // not portable across CLIs (codex rollouts ≠ claude sessions).
        provider: sessionId && cur.sessionProvider ? cur.sessionProvider : undefined,
        contextMeta: contextMetaStr,
        userPrompt: text,
        ghIssueNumber: issueCtx?.number ?? undefined,
        ghIssueRepo: issueCtx?.repo ?? undefined,
        ghIssueTitle: issueCtx?.title ?? undefined,
      })
      terminalStore.startStream(projectName, result.job_id)
    } catch (err) {
      terminalStore.update(projectName, (s) => ({
        history: [...s.history, { role: 'error', text: err instanceof Error ? err.message : 'Failed to start' }],
        streaming: false,
      }))
    }
  }, [
    projectName, streaming, input, pendingImages, pendingImageUrls,
    selectedItems, selectedDocs, model, issueContextRef, draftBeforeHistoryRef,
    setInput, setPendingImages, setPendingImageUrls, setPromptHistory,
    setHistoryIdx, setMessageQueue,
  ])

  return { handleSubmit }
}
