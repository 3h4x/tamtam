'use client'

import { useState, useEffect } from 'react'

const STORAGE_KEY = 'tamtam:privacy-mode'
const CLASS_NAME = 'privacy-mode'

export function usePrivacyMode() {
  const [isPrivate, setIsPrivate] = useState(false)

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'true') {
      setIsPrivate(true)
      document.documentElement.classList.add(CLASS_NAME)
    }
  }, [])

  function togglePrivacy() {
    setIsPrivate(prev => {
      const next = !prev
      if (next) {
        document.documentElement.classList.add(CLASS_NAME)
        localStorage.setItem(STORAGE_KEY, 'true')
      } else {
        document.documentElement.classList.remove(CLASS_NAME)
        localStorage.setItem(STORAGE_KEY, 'false')
      }
      return next
    })
  }

  return { isPrivate, togglePrivacy }
}
