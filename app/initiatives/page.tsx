import { redirect } from 'next/navigation'

// Initiatives is a tab on the merged Inbox hub — keep the old path working.
export default function InitiativesRedirect() {
  redirect('/inbox?tab=initiatives')
}
