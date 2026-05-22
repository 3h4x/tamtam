import { redirect } from 'next/navigation'

// Legacy URL — `/skills` was a peer page; the Skills surface now lives
// inside `/library` as one of two tabs alongside the agent catalog.
// Keep this redirect so external links / bookmarks don't 404.
export default function SkillsLegacyRoute() {
  redirect('/library?tab=skills')
}
