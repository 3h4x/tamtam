import { redirect } from 'next/navigation'

export default function SettingsRoot() {
  // Each settings tab has its own URL. Bare /settings redirects to General
  // so a user landing here always sees a fully-qualified URL.
  redirect('/settings/general')
}
