import { redirect } from 'next/navigation';
import { storyboardHref, storyboardView } from '@/lib/storyboard';
/** Legacy links preserve the view and selected beat after migration. */
export default async function LegacyStoryboard({ params, searchParams }: { params: Promise<{id: string}>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const {id} = await params;
  const query = await searchParams;
  redirect(storyboardHref(id, storyboardView(typeof query.view === 'string' ? query.view : null), typeof query.beat === 'string' ? query.beat : null));
}
