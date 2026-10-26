import { StoryboardPage } from '@/components/storyboards/storyboard-page';
export default async function Storyboard({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <StoryboardPage key={id} id={id} />;
}
