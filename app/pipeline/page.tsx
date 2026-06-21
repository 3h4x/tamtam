import { redirect } from 'next/navigation'

// Pipeline metrics merged into the Stats hub — keep the old path working.
export default function PipelineRedirect() {
  redirect('/stats?tab=pipeline')
}
