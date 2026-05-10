'use client'

import { useState } from 'react'

interface ProjectLogoProps {
  projectName: string
  size?: number
  className?: string
}

function FallbackProjectIcon({ size }: { size: number }) {
  return (
    <span
      className="inline-flex items-center justify-center rounded-md border border-border bg-bg-secondary text-text-tertiary"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <svg
        viewBox="0 0 16 16"
        width={Math.max(12, size - 6)}
        height={Math.max(12, size - 6)}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M2.75 3.25h4.2l1.1 1.5h5a1 1 0 011 1v6a1 1 0 01-1 1H2.75a1 1 0 01-1-1v-7.5a1 1 0 011-1z" />
        <path d="M1.75 6.25h12.3" />
      </svg>
    </span>
  )
}

export function ProjectLogo({ projectName, size = 20, className = '' }: ProjectLogoProps) {
  const [hasError, setHasError] = useState(false)

  if (hasError) {
    return <FallbackProjectIcon size={size} />
  }

  return (
    <img
      src={`/api/projects/by-project/${encodeURIComponent(projectName)}/logo`}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      className={`shrink-0 rounded-md border border-border bg-bg-secondary object-contain ${className}`.trim()}
      style={{ width: size, height: size }}
      onError={() => setHasError(true)}
    />
  )
}
