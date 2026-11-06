import { AnalysisEditor } from '@/components/media/analysis-editor';
export default async function AnalysisPage({ params }: { params: Promise<{ id: string }> }) { const { id } = await params; return <AnalysisEditor key={id} id={id} />; }
