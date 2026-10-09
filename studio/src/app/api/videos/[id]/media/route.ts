import { verifyIdToken } from '@/lib/firebase-admin';
import { loadVideoJob, readVideoBytes } from '@/lib/video-server';
export const runtime = 'nodejs';
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const uid = await verifyIdToken(request.headers.get('authorization'));
  if (!uid) return Response.json({ message: 'Please sign in to play this video.' }, { status: 401 });
  const id = (await params).id;
  const job = await loadVideoJob(uid, id);
  if (!job || job.status !== 'ready' && job.status !== 'partial') return Response.json({ message: 'That video is not ready.' }, { status: 404 });
  try {
    const bytes = await readVideoBytes(uid, id);
    return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': 'video/mp4', 'Content-Disposition': `attachment; filename="${id}.mp4"`, 'Cache-Control': 'private, no-store' } });
  } catch { return Response.json({ message: 'The video could not be loaded. Try again.' }, { status: 503 }); }
}
