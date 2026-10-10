'use client';
import { auth } from './firebase';
export class MediaClientError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export async function studioFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await auth().currentUser?.getIdToken();
  if (!token) throw new MediaClientError(401, 'unauthenticated', 'Please sign in to Studio.');
  const response = await fetch(path, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new MediaClientError(response.status, body?.error?.code ?? 'request_failed', body?.error?.message ?? 'Studio could not complete this request.');
  }
  return response;
}
export async function studioJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  return (await studioFetch(path, init)).json() as Promise<T>;
}
