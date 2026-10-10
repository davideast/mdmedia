import { ImageEditor } from '@/components/media/image-editor';
export default async function ImagePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ImageEditor key={id} id={id} />;
}
