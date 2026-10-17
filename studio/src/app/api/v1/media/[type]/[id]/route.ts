import { authorize, readJsonObject } from '@/lib/api-auth';
import type { ApiKeyScope } from '@/lib/api-key-token';
import { MediaError } from '@/lib/image-request';
import { mediaApi, mediaJson } from '@/lib/media-api-server';
import { MEDIA_TYPES, type MediaType } from '@/lib/media-types';
import { RetentionInputError, parseRetentionPatch } from '@/lib/retention';
import { getRetention, setRetention } from '@/lib/retention-server';
export const runtime = 'nodejs';
type Context = { params: Promise<{ type: string; id: string }> };

const SCOPES: Record<MediaType, { read: ApiKeyScope; write: ApiKeyScope }> = {
  narration: { read: 'narrations:read', write: 'narrations:create' },
  image: { read: 'images:read', write: 'images:create' },
  video: { read: 'videos:read', write: 'videos:create' },
  music: { read: 'music:read', write: 'music:create' },
  sfx: { read: 'sfx:read', write: 'sfx:create' },
};

function mediaType(value: string): MediaType {
  const found = MEDIA_TYPES.find((entry) => entry.type === value);
  if (!found) throw new MediaError(404, 'unknown_type', `"${value}" is not a media type. Use ${MEDIA_TYPES.map((entry) => entry.type).join(', ')}.`);
  return found.type;
}

/** How long this item is kept, and why. */
export const GET = (request: Request, context: Context) => mediaApi(async () => {
  const { type: rawType, id } = await context.params;
  const type = mediaType(rawType);
  const caller = await authorize(request, SCOPES[type].read); if (caller instanceof Response) return caller;
  return mediaJson({ id, type, retention: await getRetention(caller.uid, type, id) });
});

/** Sets, extends or clears an item's TTL, or locks and unlocks it. Body: `{ "retention": { "ttl": "36h" } }`. */
export const PATCH = (request: Request, context: Context) => mediaApi(async () => {
  const { type: rawType, id } = await context.params;
  const type = mediaType(rawType);
  const caller = await authorize(request, SCOPES[type].write); if (caller instanceof Response) return caller;
  const body = await readJsonObject(request); if (body instanceof Response) return body;
  if (Object.keys(body).some((key) => key !== 'retention')) throw new MediaError(400, 'unknown_fields', 'Only "retention" can be changed here.');
  let patch;
  try { patch = parseRetentionPatch(body.retention, Date.now()); }
  catch (error) {
    if (error instanceof RetentionInputError) throw new MediaError(400, 'invalid_retention', error.message);
    throw error;
  }
  return mediaJson({ id, type, retention: await setRetention(caller.uid, type, id, patch) });
});
