import { authenticate, unauthorized, requireUser } from '@/lib/api-auth';
import { adminDb } from '@/lib/firebase-admin';
import { syncNarrationCatalog } from '@/lib/media-catalog-server';
import { validMediaId, MediaError } from '@/lib/image-request';
import { mediaApi, mediaJson } from '@/lib/media-api-server';
export const runtime = 'nodejs';
export const POST = (request: Request) => mediaApi(async () => {
  const caller = await authenticate(request); if (!caller) return unauthorized(); const denied = requireUser(caller); if (denied) return denied;
  const body = await request.json(); const id = body.id;
  if (typeof id !== 'string' || !validMediaId(id)) throw new MediaError(400, 'invalid_id', 'Send a narration ID.');
  const source = await adminDb().collection('narrations').doc(id).get();
  const indexed = await adminDb().collection('mediaItems').doc(`narration_${id}`).get();
  if ((source.exists ? source.data()?.ownerUid : indexed.data()?.ownerUid) !== caller.uid) throw new MediaError(404, 'not_found', 'That work is not available to you.');
  await syncNarrationCatalog(id); return mediaJson({ ok: true });
});
