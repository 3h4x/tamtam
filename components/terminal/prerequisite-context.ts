export function hasPrerequisiteContext(contextMeta: string | null | undefined): boolean {
  if (!contextMeta) return false
  try {
    const meta = JSON.parse(contextMeta)
    return !!meta?.prerequisite
  } catch {
    return false
  }
}
