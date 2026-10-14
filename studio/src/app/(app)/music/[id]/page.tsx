import { MusicEditor } from '@/components/media/music-editor';
export default async function MusicPage({ params }: { params: Promise<{ id: string }> }) { const { id } = await params; return <MusicEditor key={id} id={id} />; }
