'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { EmptyState } from '@/components/ui/EmptyState'
import {
  parseTrustedGithubUsers,
  serializeTrustedGithubUsers,
  validateTrustedGithubUsersEntries,
} from '@/lib/shared/trusted-github-users'

export function TrustedGithubUsersField({
  value,
  onChange,
  onValidityChange,
}: {
  value: string
  onChange: (value: string) => void
  onValidityChange: (error: string | null) => void
}) {
  const fieldId = useId()
  const hasMountedRef = useRef(false)
  const [users, setUsers] = useState<string[]>(() => parseTrustedGithubUsers(value))
  const validationError = validateTrustedGithubUsersEntries(users)

  function updateUsers(nextUsers: string[]) {
    setUsers(nextUsers)

    const nextValue = serializeTrustedGithubUsers(nextUsers)
    if (nextValue !== value) onChange(nextValue)
  }

  useEffect(() => {
    if (!hasMountedRef.current) {
      hasMountedRef.current = true
      return
    }

    setUsers((prev) => {
      // Only reseed local rows from `value` when the parent's canonical
      // representation actually diverged from what we already have. Otherwise
      // a strict-mode double-invoke of this effect would drop in-flight edits
      // (e.g. a freshly-added empty input that hasn't been propagated yet).
      if (serializeTrustedGithubUsers(prev) === value) return prev
      return parseTrustedGithubUsers(value)
    })
  }, [value])

  useEffect(() => {
    onValidityChange(validationError)
  }, [onValidityChange, validationError])

  return (
    <div className="col-span-2">
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <label htmlFor={`${fieldId}-0`} className="block font-medium text-sm text-text-primary">
          Trusted GitHub Users
        </label>
        <Button
          type="button"
          onClick={() => updateUsers([...users, ''])}
          size="sm"
          surface="primary"
          className="rounded-lg px-2.5"
        >
          + Add user
        </Button>
      </div>

      <div className="rounded-lg border border-border bg-bg-primary/60 p-3">
        {users.length === 0 ? (
          <EmptyState
            title={<span className="font-normal">No trusted GitHub logins configured.</span>}
            paddingX="none"
            paddingY="none"
            align="start"
          />
        ) : (
          <div className="space-y-2">
            {users.map((user, index) => (
              <div key={index} className="flex items-center gap-2">
                <Input
                  id={`${fieldId}-${index}`}
                  type="text"
                  value={user}
                  onChange={(event) => {
                    const nextUsers = users.slice()
                    nextUsers[index] = event.target.value
                    updateUsers(nextUsers)
                  }}
                  placeholder="octocat"
                  className="placeholder:text-text-tertiary"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
                <Button
                  type="button"
                  onClick={() => updateUsers(users.filter((_, itemIndex) => itemIndex !== index))}
                  size="sm"
                  surface="primary"
                  className="rounded-lg px-2.5 py-2"
                  aria-label={`Remove trusted GitHub user ${user || index + 1}`}
                >
                  Remove
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      <p className="mt-1.5 text-xs text-text-tertiary">
        Global allowlist for issue and PR authors whose GitHub content TamTam may treat as trusted. Unioned with each project&apos;s <code className="font-mono">.tamtam/config.yml</code> <code className="font-mono">security.safe_users</code>.
      </p>
      {validationError && (
        <p className="mt-2 text-xs text-status-error">{validationError}</p>
      )}
    </div>
  )
}
