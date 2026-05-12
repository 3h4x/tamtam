// tamtam
import { notFound } from 'next/navigation'
import { ProjectPageShell } from '@/components/project-detail/ProjectPageShell'

const VALID_TABS = ['overview', 'config', 'history', 'terminal', 'changes', 'issues', 'docs', 'agents'] as const
type Tab = (typeof VALID_TABS)[number]

export default async function ProjectTabPage({ params }: { params: Promise<{ tab: string }> }) {
  const { tab } = await params
  if (!VALID_TABS.includes(tab as Tab)) {
    notFound()
  }

  return <ProjectPageShell />
}
