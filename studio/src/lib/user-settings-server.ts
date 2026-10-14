import { adminDb } from './firebase-admin';
import { readSettings } from './settings';
import type { UserSettings } from './types';

/** The caller's saved preferences, read with the Admin SDK after their identity is verified. */
export async function loadUserSettings(uid: string): Promise<UserSettings> {
  const snapshot = await adminDb().collection('users').doc(uid).get();
  return readSettings(snapshot.data()?.settings);
}
