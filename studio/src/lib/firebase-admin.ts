/**
 * Server Firebase bootstrap. Standard `firebase-admin`, one app per process.
 *
 * Server-side only: import this from route handlers and server components,
 * never from a `'use client'` module.
 *
 * Admin credentials bypass Security Rules, so every route handler that uses
 * these accessors must establish the caller's identity first with
 * {@link verifyIdToken} and then scope its reads and writes to that uid.
 */

import { getApps, initializeApp, applicationDefault, type App } from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

/** The Cloud Storage bucket handle, as typed by the Admin SDK. */
type Bucket = ReturnType<ReturnType<typeof getStorage>['bucket']>;

const PROJECT_ID =
  process.env.FIREBASE_PROJECT_ID ?? process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? '';

const STORAGE_BUCKET =
  process.env.FIREBASE_STORAGE_BUCKET ?? process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET ?? '';

export function adminApp(): App {
  const existing = getApps();
  if (existing.length > 0) return existing[0]!;

  // `GOOGLE_APPLICATION_CREDENTIALS` is the deployment-time credential source.
  // When it is absent the platform's own default credential is used.
  return initializeApp({
    projectId: PROJECT_ID,
    storageBucket: STORAGE_BUCKET,
    ...(process.env.GOOGLE_APPLICATION_CREDENTIALS
      ? { credential: applicationDefault() }
      : {}),
  });
}

export const adminDb = (): Firestore => getFirestore(adminApp());
export const adminAuth = (): Auth => getAuth(adminApp());
/**
 * The app's configured Cloud Storage bucket.
 *
 * Deliberately `bucket()` with no argument, so the name comes from the
 * `storageBucket` option passed to {@link adminApp}. Naming the bucket here
 * instead would be redundant in production and is outright rejected by a
 * single-bucket backend.
 */
export const adminBucket = (): Bucket => getStorage(adminApp()).bucket();

/**
 * Resolve the caller's uid from an `Authorization: Bearer <idToken>` header.
 * Returns `null` for a missing, malformed, expired, revoked, or non-allowlisted
 * token; callers translate that into a plain "please sign in" response.
 */
export async function verifyIdToken(authorizationHeader: string | null): Promise<string | null> {
  if (!authorizationHeader) return null;

  const [scheme, token] = authorizationHeader.split(' ');
  if (!token || scheme?.toLowerCase() !== 'bearer') return null;

  try {
    const decoded = await adminAuth().verifyIdToken(token.trim(), true);
    const email = decoded.email?.trim().toLowerCase();
    if (!email || decoded.email_verified !== true) {
      return null;
    }

    const allowlistDoc = await adminDb().collection('allowlist').doc(email).get();
    if (!allowlistDoc.exists) return null;

    return decoded.uid;
  } catch (error) {
    // A silent 401 is undebuggable. Say why in development; stay quiet in
    // production, where a rejected token is an expected, uninteresting event.
    if (process.env.NODE_ENV !== 'production') {
      console.warn('[auth] token rejected:', error instanceof Error ? error.message : error);
    }
    return null;
  }
}
