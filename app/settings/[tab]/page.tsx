import { notFound } from 'next/navigation'
import { SettingsPage } from '@/components/SettingsPage'

const VALID_TABS = ['general', 'auth', 'cli', 'pipeline', 'notifications', 'projects', 'templates', 'database'] as const
type Tab = (typeof VALID_TABS)[number]

export default async function SettingsTabPage({ params }: { params: Promise<{ tab: string }> }) {
  const { tab } = await params
  if (!VALID_TABS.includes(tab as Tab)) {
    notFound()
  }
  return <SettingsPage initialTab={tab as Tab} />
}
