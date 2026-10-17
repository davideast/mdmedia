import { apiError, authenticate, authorize, requireUser, readJsonObject } from '@/lib/api-auth';
import { MediaError } from '@/lib/image-request';
import { mediaApi, mediaJson } from '@/lib/media-api-server';
import { MEDIA_TYPES, type MediaType } from '@/lib/media-types';
import { loadRetentionSettings, saveRetentionDefault } from '@/lib/retention-server';
export const runtime = 'nodejs';

/** The default TTL for each media type and the global one. */
export const GET = (request: Request) => mediaApi(async () => {
  const caller = await authorize(request, 'options:read'); if (caller instanceof Response) return caller;
  return mediaJson({ defaults: await loadRetentionSettings(caller.uid), mediaTypes: MEDIA_TYPES.map((entry) => entry.type) });
});

/**
 * Changes one default. Body: `{ "target": "narration" | "global" | …, "ttl": "7d" | "keep" | "inherit", "retroactive": false }`.
 * Defaults decide what is deleted, so only a signed-in session may change them, never an API key.
 */
export const PUT = (request: Request) => mediaApi(async () => {
  const caller = await authenticate(request);
  const denied = requireUser(caller); if (denied) return denied;
  const body = await readJsonObject(request); if (body instanceof Response) return body;
  const unknown = Object.keys(body).filter((key) => !['target', 'ttl', 'retroactive'].includes(key));
  if (unknown.length > 0) return apiError(400, 'unknown_fields', `Unknown field: ${unknown.join(', ')}.`);
  const types: string[] = MEDIA_TYPES.map((entry) => entry.type);
  if (typeof body.target !== 'string' || (body.target !== 'global' && !types.includes(body.target))) {
    throw new MediaError(400, 'invalid_target', `target must be "global" or one of: ${types.join(', ')}.`);
  }
  if (typeof body.ttl !== 'string') throw new MediaError(400, 'invalid_ttl', 'ttl must be like "7d", or "keep" or "inherit".');
  if (body.retroactive !== undefined && typeof body.retroactive !== 'boolean') throw new MediaError(400, 'invalid_field', 'retroactive must be true or false.');
  const defaults = await saveRetentionDefault(caller!.uid, body.target as MediaType | 'global', body.ttl, body.retroactive === true);
  return mediaJson({ defaults });
});
