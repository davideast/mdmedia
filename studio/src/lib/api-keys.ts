/**
 * Personal API keys and the device approval flow that issues them.
 *
 * Both collections are server-only: Security Rules deny every client read and
 * write, and these Admin SDK helpers scope each operation to a verified uid.
 *
 *   apiKeys/{keyId}          { ownerUid, ownerEmail, name, hash, scopes, createdAt, lastUsedAt, revokedAt }
 *   deviceAuthorizations/{sha256(deviceCode)}
 *                            { userCode, clientName, status, createdAt, expiresAt, approvedUid?, approvedEmail? }
 */

import { adminDb, isAllowlisted } from './firebase-admin';
import {
  API_KEY_SCOPES,
  generateApiKey,
  generateDeviceCode,
  generateUserCode,
  hashSecret,
  normalizeUserCode,
  parseApiKey,
  secretMatches,
  type ApiKeyScope,
} from './api-key-token';

export const MAX_KEYS_PER_USER = 20;
const MAX_CLIENT_NAME = 80;
const DEVICE_CODE_TTL_MS = 10 * 60_000;
export const DEVICE_POLL_INTERVAL_S = 3;
/** Write lastUsedAt at most this often, so a busy key is not one write per request. */
const LAST_USED_RESOLUTION_MS = 5 * 60_000;

export interface ApiKeyCaller {
  uid: string;
  keyId: string;
  scopes: ApiKeyScope[];
}

export interface ApiKeySummary {
  id: string;
  name: string;
  scopes: ApiKeyScope[];
  createdAt: number;
  lastUsedAt: number | null;
}

interface ApiKeyRecord {
  ownerUid: string;
  ownerEmail: string;
  name: string;
  hash: string;
  scopes: ApiKeyScope[];
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

const keys = () => adminDb().collection('apiKeys');
const devices = () => adminDb().collection('deviceAuthorizations');

export function cleanClientName(value: unknown): string {
  const name = typeof value === 'string' ? value.replace(/[\u0000-\u001f]/g, '').trim().slice(0, MAX_CLIENT_NAME) : '';
  return name || 'Command line';
}

function readScopes(value: unknown): ApiKeyScope[] {
  return Array.isArray(value) ? value.filter((scope): scope is ApiKeyScope => API_KEY_SCOPES.includes(scope)) : [];
}

/** Issues a key. The returned token is the only time the secret exists outside the caller. */
export async function createApiKey(uid: string, email: string, name: string): Promise<{ token: string; key: ApiKeySummary }> {
  const active = await keys().where('ownerUid', '==', uid).get();
  if (active.docs.filter((doc) => !doc.data().revokedAt).length >= MAX_KEYS_PER_USER) {
    throw new Error(`You already have ${MAX_KEYS_PER_USER} connected apps. Revoke one in Settings first.`);
  }
  const { keyId, token, hash } = generateApiKey();
  const record: ApiKeyRecord = {
    ownerUid: uid, ownerEmail: email, name: cleanClientName(name), hash, scopes: [...API_KEY_SCOPES],
    createdAt: Date.now(), lastUsedAt: null, revokedAt: null,
  };
  await keys().doc(keyId).set(record);
  return { token, key: { id: keyId, name: record.name, scopes: record.scopes, createdAt: record.createdAt, lastUsedAt: null } };
}

/**
 * Resolves a presented key to its owner, or `null`. A key stops working when it
 * is revoked or when its owner leaves the allowlist.
 */
export async function verifyApiKey(token: string): Promise<ApiKeyCaller | null> {
  const parsed = parseApiKey(token);
  if (!parsed) return null;
  const snapshot = await keys().doc(parsed.keyId).get();
  const record = snapshot.data() as ApiKeyRecord | undefined;
  if (!record || record.revokedAt || !secretMatches(parsed.secret, record.hash)) return null;
  if (!(await isAllowlisted(record.ownerEmail))) return null;
  const now = Date.now();
  if (!record.lastUsedAt || now - record.lastUsedAt > LAST_USED_RESOLUTION_MS) {
    void snapshot.ref.update({ lastUsedAt: now }).catch(() => {});
  }
  return { uid: record.ownerUid, keyId: parsed.keyId, scopes: readScopes(record.scopes) };
}

export async function listApiKeys(uid: string): Promise<ApiKeySummary[]> {
  const snapshot = await keys().where('ownerUid', '==', uid).get();
  return snapshot.docs
    .map((doc) => ({ id: doc.id, data: doc.data() as ApiKeyRecord }))
    .filter(({ data }) => !data.revokedAt)
    .map(({ id, data }) => ({ id, name: data.name, scopes: readScopes(data.scopes), createdAt: data.createdAt, lastUsedAt: data.lastUsedAt ?? null }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** Revokes one of the caller's keys. Returns false when it is not theirs or does not exist. */
export async function revokeApiKey(uid: string, keyId: string): Promise<boolean> {
  if (!/^[A-Za-z0-9]{16}$/.test(keyId)) return false;
  const ref = keys().doc(keyId);
  const snapshot = await ref.get();
  const record = snapshot.data() as ApiKeyRecord | undefined;
  if (!record || record.ownerUid !== uid) return false;
  if (!record.revokedAt) await ref.update({ revokedAt: Date.now() });
  return true;
}

/* ------------------------------------------------------------------------ */
/* Device approval: a local client asks, the signed-in person approves.      */
/* ------------------------------------------------------------------------ */

export interface DeviceStart {
  deviceCode: string;
  userCode: string;
  expiresIn: number;
  interval: number;
}

interface DeviceRecord {
  userCode: string;
  clientName: string;
  status: 'pending' | 'approved' | 'denied';
  createdAt: number;
  expiresAt: number;
  approvedUid?: string;
  approvedEmail?: string;
}

export async function startDeviceAuthorization(clientName: unknown): Promise<DeviceStart> {
  const deviceCode = generateDeviceCode();
  const now = Date.now();
  const record: DeviceRecord = {
    userCode: generateUserCode(), clientName: cleanClientName(clientName), status: 'pending',
    createdAt: now, expiresAt: now + DEVICE_CODE_TTL_MS,
  };
  await devices().doc(hashSecret(deviceCode)).set(record);
  return { deviceCode, userCode: record.userCode, expiresIn: DEVICE_CODE_TTL_MS / 1000, interval: DEVICE_POLL_INTERVAL_S };
}

async function findPendingByUserCode(userCode: string) {
  const code = normalizeUserCode(userCode);
  if (!code) return null;
  const snapshot = await devices().where('userCode', '==', code).get();
  const doc = snapshot.docs.find((item) => {
    const data = item.data() as DeviceRecord;
    return data.status === 'pending' && data.expiresAt > Date.now();
  });
  return doc ? { ref: doc.ref, data: doc.data() as DeviceRecord } : null;
}

/** What the approval page shows before the person decides. */
export async function describeDeviceAuthorization(userCode: string): Promise<{ clientName: string; expiresAt: number } | null> {
  const found = await findPendingByUserCode(userCode);
  return found ? { clientName: found.data.clientName, expiresAt: found.data.expiresAt } : null;
}

export async function decideDeviceAuthorization(uid: string, email: string, userCode: string, approve: boolean): Promise<boolean> {
  const found = await findPendingByUserCode(userCode);
  if (!found) return false;
  await found.ref.update(approve ? { status: 'approved', approvedUid: uid, approvedEmail: email } : { status: 'denied' });
  return true;
}

export type DevicePoll =
  | { status: 'pending' | 'denied' | 'expired' }
  | { status: 'approved'; token: string; key: ApiKeySummary };

/**
 * The client's poll. The key is minted here, at the moment the client that holds
 * the device code collects it, so no plaintext key is ever stored. The record is
 * deleted once collected, so a device code works once.
 */
export async function pollDeviceAuthorization(deviceCode: string): Promise<DevicePoll> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(deviceCode)) return { status: 'expired' };
  const ref = devices().doc(hashSecret(deviceCode));
  const claimed = await adminDb().runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const record = snapshot.data() as DeviceRecord | undefined;
    if (!record || record.expiresAt <= Date.now()) {
      if (record) transaction.delete(ref);
      return { status: 'expired' as const };
    }
    if (record.status !== 'approved') {
      if (record.status === 'denied') transaction.delete(ref);
      return { status: record.status };
    }
    transaction.delete(ref);
    return { status: 'approved' as const, record };
  });
  if (claimed.status !== 'approved') return claimed;
  const { approvedUid, approvedEmail, clientName } = claimed.record;
  if (!approvedUid || !approvedEmail) return { status: 'denied' };
  const issued = await createApiKey(approvedUid, approvedEmail, clientName);
  return { status: 'approved', ...issued };
}
