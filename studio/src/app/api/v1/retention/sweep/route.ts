import { authenticate, requireUser } from '@/lib/api-auth';
import { mediaApi, mediaJson } from '@/lib/media-api-server';
import { sweepExpired } from '@/lib/retention-sweep';
export const runtime = 'nodejs';

/** Deletes your expired items now instead of waiting for the next scheduled sweep. Signed-in sessions only. */
export const POST = (request: Request) => mediaApi(async () => {
  const caller = await authenticate(request);
  const denied = requireUser(caller); if (denied) return denied;
  const report = await sweepExpired({ uid: caller!.uid, limit: 100 });
  return mediaJson({ purged: report.purged, failed: report.failed, truncated: report.truncated });
});
