import { loadCut, segmentThumbnail } from '@/lib/cut-files-server';

export const runtime = 'nodejs';

/**
 * Development only: a 4:3 JPEG of one shot's first frame, cached on disk.
 * The shot is named by its id in the cut; its source must be inside the media root.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ name: string; segment: string }> }): Promise<Response> {
  const { name, segment: id } = await params;
  const cut = await loadCut(name);
  if (!cut.ok) return Response.json({ message: cut.message }, { status: cut.status });
  const segment = cut.timeline.segments.find((item) => item.id === id);
  if (!segment) return Response.json({ message: 'No such shot.' }, { status: 404 });
  try {
    const jpeg = await segmentThumbnail(cut.timeline, segment);
    if (!jpeg) return Response.json({ message: 'This shot has no picture in the media folder.' }, { status: 404 });
    return new Response(new Uint8Array(jpeg), {
      headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=300' },
    });
  } catch {
    return Response.json({ message: 'The thumbnail could not be made.' }, { status: 500 });
  }
}
