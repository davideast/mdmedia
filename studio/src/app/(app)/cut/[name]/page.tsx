import { notFound } from 'next/navigation';
import { CutProblems, CutViewer } from '@/components/cut/cut-viewer';
import { loadCut } from '@/lib/cut-files-server';

/** Development only: a read-only player and timeline for `docs/cuts/<name>.cut.json`. */
export default async function CutPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const cut = await loadCut(name);
  if (!cut.ok && cut.status === 404) notFound();
  if (!cut.ok) return <CutProblems name={name} message={cut.message} errors={cut.errors ?? []} />;
  return <CutViewer key={name} name={name} timeline={cut.timeline} />;
}
