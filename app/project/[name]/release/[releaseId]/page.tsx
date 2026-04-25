import { ReleaseTraceView } from '@/components/ReleaseTraceView'

interface Props {
  params: Promise<{ name: string; releaseId: string }>
}

export default async function ReleasePage({ params }: Props) {
  const { name, releaseId } = await params
  return <ReleaseTraceView projectName={name} releaseId={releaseId} />
}
