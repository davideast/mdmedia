import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { setGlobalOptions } from 'firebase-functions/v2';
import {
  beforeUserCreated,
  beforeUserSignedIn,
  HttpsError,
  type AuthBlockingEvent,
} from 'firebase-functions/v2/identity';

setGlobalOptions({
  region: 'us-central1',
  ingressSettings: 'ALLOW_INTERNAL_AND_GCLB',
  invoker: 'private',
});

function db() {
  if (getApps().length === 0) {
    initializeApp();
  }
  return getFirestore();
}

/**
 * Enforces that only accounts with a verified email present in
 * `allowlist/{email}` may be created or receive a Firebase Auth ID token.
 */
export async function assertAllowlisted(event: AuthBlockingEvent): Promise<void> {
  const user = event.data;
  const email = user?.email?.trim().toLowerCase();

  if (!email || user?.emailVerified !== true) {
    throw new HttpsError(
      'permission-denied',
      'A verified email address on the allowlist is required to sign in.',
    );
  }

  const snap = await db().collection('allowlist').doc(email).get();
  if (!snap.exists) {
    throw new HttpsError(
      'permission-denied',
      'Your email address is not on the studio allowlist.',
    );
  }
}

export const blockNonAllowlistedUserCreated = beforeUserCreated(async (event) => {
  await assertAllowlisted(event);
});

export const blockNonAllowlistedUserSignedIn = beforeUserSignedIn(async (event) => {
  await assertAllowlisted(event);
});
