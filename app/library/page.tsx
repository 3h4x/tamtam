import { Suspense } from 'react'
import { LibraryPage } from '@/components/LibraryPage'

// `LibraryPage` reads `?tab=` via `useSearchParams`, which forces Next to
// opt the route out of static prerender unless we wrap the consumer in a
// `<Suspense>` boundary. Without this, `next build` throws
// "Suspense boundary received an update before it finished hydrating".
export default function LibraryRoute() {
  return (
    <Suspense fallback={null}>
      <LibraryPage />
    </Suspense>
  )
}
