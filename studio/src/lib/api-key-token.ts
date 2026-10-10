/**
 * API key format: `mdm_<keyId>_<secret>`.
 *
 * The key id names the stored record, so a lookup is one document read. Only a
 * SHA-256 hash of the secret is stored; the full key is shown once, to the
 * client that created it. Pure Node crypto, no Firebase, so it is testable.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const API_KEY_PREFIX = 'mdm_';

/** What an API key may do. Browser sessions implicitly have every scope. */
export const API_KEY_SCOPES = ['narrations:create', 'narrations:read', 'options:read', 'playlists:manage', 'images:create', 'images:read'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

const KEY_ID = /^[A-Za-z0-9]{16}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;

function randomId(length: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from(randomBytes(length), (byte) => alphabet[byte % alphabet.length]).join('');
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function generateApiKey(): { keyId: string; secret: string; token: string; hash: string } {
  const keyId = randomId(16);
  const secret = randomBytes(32).toString('base64url');
  return { keyId, secret, token: `${API_KEY_PREFIX}${keyId}_${secret}`, hash: hashSecret(secret) };
}

export function isApiKeyToken(token: string): boolean {
  return token.startsWith(API_KEY_PREFIX);
}

/** Splits a presented key into its record id and secret, or `null` if malformed. */
export function parseApiKey(token: string): { keyId: string; secret: string } | null {
  if (!isApiKeyToken(token)) return null;
  const rest = token.slice(API_KEY_PREFIX.length);
  const keyId = rest.slice(0, 16);
  const secret = rest.slice(17);
  if (rest[16] !== '_' || !KEY_ID.test(keyId) || !SECRET.test(secret)) return null;
  return { keyId, secret };
}

/** Constant-time comparison of a presented secret against the stored hash. */
export function secretMatches(secret: string, storedHash: string): boolean {
  const presented = Buffer.from(hashSecret(secret), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  return presented.length === stored.length && timingSafeEqual(presented, stored);
}

/** A short code a person types or confirms in the browser, e.g. `KQ7M-3XWP`. Ambiguous characters are left out. */
export function generateUserCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const code = Array.from(randomBytes(8), (byte) => alphabet[byte % alphabet.length]).join('');
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export function normalizeUserCode(value: string): string | null {
  const compact = value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(compact) ? `${compact.slice(0, 4)}-${compact.slice(4)}` : null;
}

/** The secret a polling client holds while its user code is waiting for approval. */
export function generateDeviceCode(): string {
  return randomBytes(32).toString('base64url');
}
