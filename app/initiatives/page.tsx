import { redirect } from 'next/navigation'

// Initiatives merged into the Recommendations hub — keep the old path working.
export default function InitiativesRedirect() {
  redirect('/recommendations?tab=initiatives')
}
