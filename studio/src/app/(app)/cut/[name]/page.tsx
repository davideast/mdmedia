import { notFound } from 'next/navigation';
import { CutProblems, DevCutViewer } from '@/components/cut/cut-viewer';
import { loadCut } from '@/lib/cut-files-server';

/**
 * Development only: a read-only player and timeline for `docs/cuts/<name>.cut.json`, straight from
 * the repository and the local media folder. Pushed cuts open under /productions instead.
 */
export default async function CutPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const cut = await loadCut(name);
  if (!cut.ok && cut.status === 404) notFound();
  if (!cut.ok) return <CutProblems title={`${name}.cut.json`} message={cut.message} errors={cut.errors ?? []} />;
  return <DevCutViewer key={name} name={name} timeline={cut.timeline} />;
}
