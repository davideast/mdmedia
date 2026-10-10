import { VideoEditor } from '@/components/media/video-editor';
export default async function VideoPage({ params }: { params: Promise<{ id: string }> }) { const { id } = await params; return <VideoEditor key={id} id={id} />; }
