import { adminDb, verifyIdToken } from '@/lib/firebase-admin';
import { readLibraryCursor, readLibraryPage } from '@/lib/library-page';

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  const uid = await verifyIdToken(request.headers.get('authorization'));
  if (!uid) return Response.json({ message: 'Please sign in to browse your library.' }, { status: 401 });
  const url = new URL(request.url);
  const search = (url.searchParams.get('q') ?? '').trim();
  let cursor;
  try {
    if (search.length > 200 || (url.searchParams.get('cursor')?.length ?? 0) > 2048) throw new Error('Invalid query');
    cursor = readLibraryCursor(url.searchParams.get('cursor'));
  } catch { return Response.json({ message: 'Invalid library search or cursor.' }, { status: 400 }); }
  try {
    const page = await readLibraryPage(async (after, size) => {
      let query = adminDb().collection('narrations').where('ownerUid', '==', uid)
        .orderBy('createdAt', 'desc').orderBy('__name__', 'desc').limit(size);
      if (after) query = query.startAfter(after.createdAt, after.id);
      const result = await query.get();
      return result.docs.map((doc) => ({ id: doc.id, data: doc.data() }));
    }, search, cursor);
    return Response.json(page, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[library] Failed to load page:', error);
    return Response.json({ message: 'Could not load your library. Try again.' }, { status: 500 });
  }
}
