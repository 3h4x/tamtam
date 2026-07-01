import { InboxFeed } from '@/components/InboxFeed'

export default function InboxRoute() {
  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="text-lg font-semibold text-text-primary mb-4">Inbox</h1>
      <InboxFeed />
    </div>
  )
}
