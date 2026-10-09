/**
 * Who is calling a `/api/v1` route.
 *
 * A browser session presents a Firebase ID token and may do anything the app
 * does. A local client (a CLI, a coding agent) presents an API key, which is
 * limited to its scopes and to private narrations.
 */

import { isApiKeyToken, type ApiKeyScope } from './api-key-token';
import { verifyApiKey } from './api-keys';
import { verifyUser } from './firebase-admin';

export type Caller =
  | { kind: 'user'; uid: string; email: string }
  | { kind: 'apiKey'; uid: string; keyId: string; scopes: ApiKeyScope[] };

function bearer(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token.trim() : null;
}

export async function authenticate(request: Request): Promise<Caller | null> {
  const token = bearer(request);
  if (!token) return null;
  if (isApiKeyToken(token)) {
    const key = await verifyApiKey(token);
    return key ? { kind: 'apiKey', ...key } : null;
  }
  const user = await verifyUser(`Bearer ${token}`);
  return user ? { kind: 'user', ...user } : null;
}

export function hasScope(caller: Caller, scope: ApiKeyScope): boolean {
  return caller.kind === 'user' || caller.scopes.includes(scope);
}

/** A JSON error body with a stable machine-readable code and a sentence for people. */
export function apiError(status: number, code: string, message: string, headers?: HeadersInit): Response {
  return Response.json({ error: { code, message } }, { status, headers });
}

export const unauthorized = () =>
  apiError(401, 'unauthenticated', 'Sign in, or pass an API key as "Authorization: Bearer mdm_…". Run `mdmedia studio login` to get one.');

export const forbiddenScope = (scope: ApiKeyScope) =>
  apiError(403, 'insufficient_scope', `This API key cannot ${scope.replace(':', ' ')}.`);

/** Routes that manage keys accept only a browser session, never a key. */
export function requireUser(caller: Caller | null): Response | null {
  if (!caller) return unauthorized();
  if (caller.kind !== 'user') return apiError(403, 'session_required', 'Manage connected apps from the studio while signed in.');
  return null;
}
