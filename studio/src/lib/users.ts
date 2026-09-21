'use client';

/**
 * Client-side access to `users/{uid}`.
 *
 * The document is owner-only by Security Rules: it carries the profile and the
 * embedded settings map, and nobody but the signed-in owner can read it.
 */

import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  type DocumentData,
  type FirestoreDataConverter,
  type QueryDocumentSnapshot,
  type SnapshotOptions,
} from 'firebase/firestore';

import { db } from '@/lib/firebase';
import {
  DEFAULT_SETTINGS,
  HIGHLIGHT_COLORS,
  type HighlightColorId,
  type UserProfile,
  type UserSettings,
} from '@/lib/types';

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function toSettings(value: unknown): UserSettings {
  const raw = (value ?? {}) as Partial<UserSettings>;
  const validHighlight = HIGHLIGHT_COLORS.some((c) => c.id === raw.highlightColor)
    ? (raw.highlightColor as HighlightColorId)
    : DEFAULT_SETTINGS.highlightColor;
  return {
    defaultVoice: raw.defaultVoice ?? DEFAULT_SETTINGS.defaultVoice,
    defaultPromptStyle: asString(raw.defaultPromptStyle, DEFAULT_SETTINGS.defaultPromptStyle),
    rewriteForNarration:
      typeof raw.rewriteForNarration === 'boolean'
        ? raw.rewriteForNarration
        : DEFAULT_SETTINGS.rewriteForNarration,
    autoPlay: typeof raw.autoPlay === 'boolean' ? raw.autoPlay : DEFAULT_SETTINGS.autoPlay,
    defaultVisibility: raw.defaultVisibility ?? DEFAULT_SETTINGS.defaultVisibility,
    highlightColor: validHighlight,
  };
}

/**
 * Shape a raw snapshot into a {@link UserProfile}.
 *
 * Applied explicitly rather than through `withConverter`, matching
 * `narrations.ts`. Document references do support converters under every
 * implementation we run against today, but keeping one reference kind on a
 * different mechanism from the others is how you end up with a capability gap
 * that only shows up at runtime.
 */
export function toUserProfile(snapshot: {
  id: string;
  data: () => DocumentData | undefined;
}): UserProfile {
  const data = (snapshot.data() ?? {}) as Record<string, unknown>;
  return {
    uid: snapshot.id,
    displayName: asString(data.displayName),
    photoURL: asString(data.photoURL),
    email: asString(data.email),
    bio: asString(data.bio),
    createdAt: asNumber(data.createdAt),
    updatedAt: asNumber(data.updatedAt),
    settings: toSettings(data.settings),
  };
}

export function userRef(uid: string) {
  return doc(db(), 'users', uid);
}

export async function getUserProfile(uid: string): Promise<UserProfile | null> {
  const snapshot = await getDoc(userRef(uid));
  return snapshot.exists() ? toUserProfile(snapshot) : null;
}

export interface UpsertProfileInput {
  uid: string;
  displayName: string;
  email: string;
  photoURL: string;
}

/**
 * Create `users/{uid}` on first sign-in, or refresh the fields the identity
 * provider owns. An existing display name or bio the person edited here is
 * never overwritten.
 */
export async function upsertUserProfile(input: UpsertProfileInput): Promise<UserProfile> {
  const ref = userRef(input.uid);
  const existing = await getDoc(ref);
  const now = Date.now();

  if (!existing.exists()) {
    const profile: UserProfile = {
      uid: input.uid,
      displayName: input.displayName,
      photoURL: input.photoURL,
      email: input.email,
      bio: '',
      createdAt: now,
      updatedAt: now,
      settings: { ...DEFAULT_SETTINGS },
    };
    await setDoc(ref, profile);
    return profile;
  }

  const current = toUserProfile(existing);
  const patch: Partial<Pick<UserProfile, 'email' | 'photoURL' | 'displayName'>> = {};
  if (input.email && input.email !== current.email) patch.email = input.email;
  if (input.photoURL && input.photoURL !== current.photoURL) patch.photoURL = input.photoURL;
  if (!current.displayName && input.displayName) patch.displayName = input.displayName;

  if (Object.keys(patch).length === 0) return current;

  await updateDoc(doc(db(), 'users', input.uid), { ...patch, updatedAt: now });
  return { ...current, ...patch, updatedAt: now };
}

/** Merge a settings patch without clobbering the keys it leaves alone. */
export async function saveSettings(uid: string, patch: Partial<UserSettings>): Promise<void> {
  const fields: Record<string, unknown> = { updatedAt: Date.now() };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    fields[`settings.${key}`] = value;
  }
  await updateDoc(doc(db(), 'users', uid), fields);
}

/** Update the fields of the profile a person controls directly. */
export async function saveProfileFields(
  uid: string,
  patch: { displayName?: string; bio?: string },
): Promise<void> {
  const fields: Record<string, unknown> = { updatedAt: Date.now() };
  if (patch.displayName !== undefined) fields.displayName = patch.displayName;
  if (patch.bio !== undefined) fields.bio = patch.bio;
  await updateDoc(doc(db(), 'users', uid), fields);
}
