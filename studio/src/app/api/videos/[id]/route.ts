import { verifyIdToken } from '@/lib/firebase-admin';
import { loadVideoJob } from '@/lib/video-server';
export const runtime = 'nodejs';
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const uid = await verifyIdToken(request.headers.get('authorization'));
  if (!uid) return Response.json({ message: 'Please sign in to view this video.' }, { status: 401 });
  const job = await loadVideoJob(uid, (await params).id);
  return job ? Response.json({ job }, { headers: { 'Cache-Control': 'no-store' } }) : Response.json({ message: 'That video is unavailable.' }, { status: 404 });
}
