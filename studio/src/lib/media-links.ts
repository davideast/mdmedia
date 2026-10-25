/**
 * Short-lived signed links to one asset's bytes.
 *
 * A `<video>` or `<img>` can't send the `Authorization` header, so a signed-in
 * page asks for a link instead: `/api/v1/assets/{id}/content?exp=…&sig=…`.
 * The signature is an HMAC-SHA256, under a server secret, of the asset id,
 * its owner and the expiry, so a link opens that one asset until it expires
 * and nothing else. The content route checks it in place of the header and
 * serves the same bytes and byte ranges.
 *
 * Expiry is rounded up to a five-minute step, so links handed out within the
 * same few minutes are the same URL and the browser's cache keeps working.
 * Links live 15 to 20 minutes; pages fetch fresh ones before then.
 *
 * The secret is `MDMEDIA_MEDIA_LINK_SECRET` (at least 32 characters), set
 * like Studio's other secrets in `.env.local` or the host's environment.
 * Without it, each server process makes a random one: links still work, but
 * stop working when the process restarts, and can't be shared between
 * several instances.
 *
 * Links are never logged.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ApiKeyScope } from './api-key-token';
import type { StoredAsset } from './assets-server';

/** The scope an API key needs to read this asset, or to get a link to it. */
export function assetReadScope(asset: Pick<StoredAsset, 'purpose' | 'mediaType'>): ApiKeyScope {
  if (asset.purpose === 'production') return 'productions:read';
  return asset.mediaType === 'sfx' ? 'sfx:read' : asset.mediaType === 'music' ? 'music:read' : asset.mediaType === 'video' ? 'videos:read' : 'images:read';
}

/** How long a new link lives, at least. */
export const MEDIA_LINK_TTL_MS = 15 * 60_000;
/** Expiries round up to this step, so links made close together are identical. */
export const MEDIA_LINK_STEP_MS = 5 * 60_000;
/** No link is accepted that claims to live longer than this from now. */
const MAX_LIFETIME_MS = MEDIA_LINK_TTL_MS + MEDIA_LINK_STEP_MS;
/** How many links one request may ask for. */
export const MAX_MEDIA_LINKS = 100;

const MIN_SECRET_LENGTH = 32;
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/;
const EXPIRY = /^\d{1,13}$/;

export interface MediaLinkClaim {
  assetId: string;
  ownerUid: string;
  /** Expiry, in seconds since the epoch. */
  exp: number;
}

export type MediaLinkCheck = 'ok' | 'expired' | 'invalid';

const globalSecret = globalThis as typeof globalThis & { __mdmediaMediaLinkSecret?: Buffer; __mdmediaMediaLinkWarned?: boolean };

/** The signing secret: the configured one, else one random secret per server process. */
export function mediaLinkSecret(env: Record<string, string | undefined> = process.env): Buffer {
  const configured = env.MDMEDIA_MEDIA_LINK_SECRET?.trim();
  if (configured && configured.length >= MIN_SECRET_LENGTH) return Buffer.from(configured, 'utf8');
  if (configured && !globalSecret.__mdmediaMediaLinkWarned) {
    globalSecret.__mdmediaMediaLinkWarned = true;
    console.warn(`[media-links] MDMEDIA_MEDIA_LINK_SECRET is shorter than ${MIN_SECRET_LENGTH} characters; using a per-process secret instead.`);
  }
  return (globalSecret.__mdmediaMediaLinkSecret ??= randomBytes(32));
}

/** The expiry, in seconds, for a link made at `now`: at least the TTL away, rounded up to the step. */
export function mediaLinkExpiry(now = Date.now()): number {
  return Math.ceil((now + MEDIA_LINK_TTL_MS) / MEDIA_LINK_STEP_MS) * MEDIA_LINK_STEP_MS / 1000;
}

const payload = ({ assetId, ownerUid, exp }: MediaLinkClaim) => `mdmedia-media-link/v1\n${assetId}\n${ownerUid}\n${exp}`;

export function signMediaLink(secret: Buffer, claim: MediaLinkClaim): string {
  return createHmac('sha256', secret).update(payload(claim)).digest('base64url');
}

/**
 * Checks a presented link for this asset and its owner. `expired` is a link
 * that was good and has run out; anything else wrong (another asset, another
 * owner, a changed expiry, a mangled signature) is `invalid`.
 */
export function verifyMediaLink(secret: Buffer, claim: MediaLinkClaim, signature: string, now = Date.now()): MediaLinkCheck {
  if (!SIGNATURE.test(signature) || !Number.isSafeInteger(claim.exp)) return 'invalid';
  const expected = Buffer.from(signMediaLink(secret, claim), 'base64url');
  const presented = Buffer.from(signature, 'base64url');
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return 'invalid';
  if (claim.exp * 1000 <= now) return 'expired';
  // Only this server signs, so a far expiry means the secret leaked or the clock jumped; refuse it.
  if (claim.exp * 1000 > now + MAX_LIFETIME_MS) return 'invalid';
  return 'ok';
}

/** The `exp` and `sig` a request presents, or null when it presents no link. Malformed values are `invalid`. */
export function presentedLink(query: URLSearchParams): { exp: number; sig: string } | 'invalid' | null {
  const exp = query.get('exp');
  const sig = query.get('sig');
  if (exp === null && sig === null) return null;
  if (exp === null || sig === null || !EXPIRY.test(exp)) return 'invalid';
  return { exp: Number(exp), sig };
}

/** The query string that signs a link to `claim`'s asset. */
export function mediaLinkQuery(secret: Buffer, claim: MediaLinkClaim): string {
  return `exp=${claim.exp}&sig=${signMediaLink(secret, claim)}`;
}
