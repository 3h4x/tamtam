import { redirect } from 'next/navigation'

// Recommendations merged into the Inbox hub. `/recommendations` (and its old
// `?tab=` deep-links) now redirect to the tabbed `/inbox`: open recommendations
// live in the merged Inbox feed; `initiatives` / `history` stay as tabs.
export default async function RecommendationsRedirect({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>
}) {
  const { tab } = await searchParams
  const dest =
    tab === 'initiatives' ? '/inbox?tab=initiatives'
    : tab === 'history' ? '/inbox?tab=history'
    : '/inbox'
  redirect(dest)
}
