import { notFound } from 'next/navigation';
import { SAMPLE_REPOS, isSampleId } from '../../../lib/fixtures';
import { GraphWorkspace } from './GraphWorkspace';

export function generateStaticParams() {
  return Object.keys(SAMPLE_REPOS).map((id) => ({ id }));
}

export default async function AnalysisPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isSampleId(id)) notFound();
  return <GraphWorkspace sampleId={id} />;
}
