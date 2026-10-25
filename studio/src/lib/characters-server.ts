/**
 * Characters for `/api/v1`, through the Admin SDK and scoped to one owner.
 *
 *   characters/{id}                     { ownerUid, slug, name, kind, latestVersion, versions: [summary],
 *                                         createdAt, updatedAt }
 *   characters/{id}/versions/{version}  { ownerUid, characterId, version, character, stills, createdAt }
 *
 * A character (Rick, Buddy, Big Hal) is portable: any production can cast it.
 * Each version is stored once and never changes, so a production made with
 * `rick@1` keeps exactly that Rick when `rick@2` arrives. `character` is the
 * character file (`mdmedia.character@1`, see docs/characters.md) as pushed;
 * `stills` maps each of its reference stills to the image asset it was
 * uploaded as.
 *
 * Ids derive from the owner and the character's id (its slug), so pushing the
 * same version again is a no-op. Client reads are not allowed by the Rules
 * (there is no match for `characters`): pages read them through this API.
 */

import { createHash } from 'node:crypto';
import { formatCharacterRef, parseCharacter, parseCharacterRef, type Character } from 'mdmedia/character';
import { apiError } from './api-auth';
import { adminDb } from './firebase-admin';
import { MediaError } from './image-request';
import { loadOwnedAssets } from './production-media-server';

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DOC_ID = /^ch[0-9a-f]{24}$/;
const ASSET_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_VERSIONS = 200;
/** A character file is small; this leaves room for a long reference. */
const MAX_CHARACTER_BYTES = 200_000;
const LIST_LIMIT = 200;

export class CharacterError extends Error {
  constructor(readonly code: string, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'CharacterError';
  }
}

const ERROR_STATUS: Record<string, number> = {
  character_not_found: 404,
  version_not_found: 404,
  version_exists: 409,
  asset_not_found: 400,
  invalid_character: 422,
  too_many_versions: 409,
};

/** Runs a characters route: its own errors become their responses, anything unexpected a plain 500. */
export async function characterApi(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof CharacterError) {
      const status = ERROR_STATUS[error.code] ?? 400;
      if (!Object.keys(error.details).length) return apiError(status, error.code, error.message);
      return Response.json({ error: { code: error.code, message: error.message, ...error.details } }, { status });
    }
    if (error instanceof MediaError) return apiError(error.status, error.code, error.message);
    console.error('[characters] Request failed:', error instanceof Error ? error.message : 'unknown');
    return apiError(500, 'characters_unavailable', 'Studio could not complete that request. Try again.');
  }
}

// ---------------------------------------------------------------------------
// Shapes

export interface CharacterVersionSummary {
  version: number;
  date: string;
  changes: string;
  createdAt: number;
}

export interface CharacterSummary {
  id: string;
  slug: string;
  name: string;
  kind: 'person' | 'thing';
  latestVersion: number;
  versions: CharacterVersionSummary[];
  createdAt: number;
  updatedAt: number;
  links: { self: string };
}

export interface CharacterVersionResource {
  id: string;
  slug: string;
  version: number;
  /** `rick@1`. */
  ref: string;
  character: Character;
  /** Still id → image asset id. */
  stills: Record<string, string>;
  createdAt: number;
  links: { self: string; character: string; stills: Record<string, { content: string; thumbnail: string }> };
}

/** One part of a production's cast, as the production stores it: the role and the character version, with what a page shows. */
export interface CastMember {
  role: string;
  characterId: string;
  slug: string;
  version: number;
  ref: string;
  name: string;
  description: string;
  register: string;
  /** "ElevenLabs “Eric” (text-to-speech, voice swap)". */
  voice: string;
  /** Its first reference still, when it has one. */
  stillAssetId: string | null;
  /** How many approved lines its reference levels were measured from (0 before they are). */
  referenceLines: number;
}

interface StoredVersion {
  ownerUid: string;
  characterId: string;
  version: number;
  character: Character;
  stills: Record<string, string>;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Helpers

const characters = () => adminDb().collection('characters');
const versionsOf = (id: string) => adminDb().collection(`characters/${id}/versions`);

/** The character id for `uid`'s character with this slug. */
export const characterId = (uid: string, slug: string) => `ch${createHash('sha256').update(`character\0${uid}\0${slug}`).digest('hex').slice(0, 24)}`;

/** A route's `{id}`: a character id, or a slug. */
function idFrom(uid: string, idOrSlug: string): string {
  if (DOC_ID.test(idOrSlug)) return idOrSlug;
  if (SLUG.test(idOrSlug) && idOrSlug.length <= 80) return characterId(uid, idOrSlug);
  throw new CharacterError('character_not_found', 'No character of yours with that id.');
}

const notFound = () => new CharacterError('character_not_found', 'No character of yours with that id.');

/** A version as JSON in a fixed key order, so the same character always compares equal. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function describeVoice(character: Character): string {
  const v = character.voice;
  const uses = v.uses.map((u) => (u === 'tts' ? 'text-to-speech' : u === 'swap' ? 'voice swap' : 'on camera')).join(', ');
  return v.provider === 'video-model' ? `The video model's own voice (${uses})` : `ElevenLabs “${v.name ?? v.id}” (${uses})`;
}

function summarize(id: string, data: FirebaseFirestore.DocumentData, origin: string): CharacterSummary {
  return {
    id,
    slug: String(data.slug ?? ''),
    name: String(data.name ?? ''),
    kind: data.kind === 'thing' ? 'thing' : 'person',
    latestVersion: Number(data.latestVersion ?? 0),
    versions: Array.isArray(data.versions) ? (data.versions as CharacterVersionSummary[]) : [],
    createdAt: Number(data.createdAt ?? 0),
    updatedAt: Number(data.updatedAt ?? 0),
    links: { self: `${origin}/api/v1/characters/${id}` },
  };
}

function versionResource(id: string, slug: string, stored: StoredVersion, origin: string): CharacterVersionResource {
  const asset = (assetId: string) => ({ content: `${origin}/api/v1/assets/${assetId}/content`, thumbnail: `${origin}/api/v1/assets/${assetId}/content?thumbnail=1` });
  return {
    id,
    slug,
    version: stored.version,
    ref: formatCharacterRef({ id: slug, version: stored.version }),
    character: stored.character,
    stills: stored.stills,
    createdAt: stored.createdAt,
    links: {
      self: `${origin}/api/v1/characters/${id}/versions/${stored.version}`,
      character: `${origin}/api/v1/characters/${id}`,
      stills: Object.fromEntries(Object.entries(stored.stills).map(([still, assetId]) => [still, asset(assetId)])),
    },
  };
}

// ---------------------------------------------------------------------------
// Reads

export async function listCharacters(uid: string, origin: string): Promise<{ characters: CharacterSummary[] }> {
  const snapshot = await characters().where('ownerUid', '==', uid).limit(LIST_LIMIT).get();
  const list = snapshot.docs.map((doc) => summarize(doc.id, doc.data() ?? {}, origin)).sort((a, b) => a.name.localeCompare(b.name));
  return { characters: list };
}

export async function getCharacter(uid: string, idOrSlug: string, origin: string): Promise<CharacterSummary & { latest: CharacterVersionResource | null }> {
  const id = idFrom(uid, idOrSlug);
  const snapshot = await characters().doc(id).get();
  const data = snapshot.data();
  if (!snapshot.exists || !data || data.ownerUid !== uid) throw notFound();
  const summary = summarize(id, data, origin);
  const latest = summary.latestVersion ? await getCharacterVersion(uid, id, summary.latestVersion, origin) : null;
  return { ...summary, latest };
}

export async function getCharacterVersion(uid: string, idOrSlug: string, version: number, origin: string): Promise<CharacterVersionResource> {
  const id = idFrom(uid, idOrSlug);
  if (!Number.isInteger(version) || version < 1) throw new CharacterError('version_not_found', 'A version is a whole number, 1 or more.');
  const snapshot = await versionsOf(id).doc(String(version)).get();
  const stored = snapshot.data() as StoredVersion | undefined;
  if (!snapshot.exists || !stored || stored.ownerUid !== uid) throw new CharacterError('version_not_found', `No version ${version} of that character.`);
  return versionResource(id, stored.character.id, stored, origin);
}

// ---------------------------------------------------------------------------
// Writes

/**
 * Stores one version of a character: `{ character, stills: { [stillId]: assetId } }`.
 * A version is written once. Sending the same version again with the same
 * content is a no-op (`created: false`); with other content it is
 * `409 version_exists`, since a production may have been made with it.
 */
export async function putCharacterVersion(uid: string, slug: string, version: number, body: Record<string, unknown>, origin: string): Promise<{ version: CharacterVersionResource; created: boolean }> {
  if (!SLUG.test(slug) || slug.length > 80) throw new CharacterError('invalid_character', 'A character id is lowercase words joined by hyphens, like "big-hal".');
  if (!Number.isInteger(version) || version < 1) throw new CharacterError('invalid_character', 'A version is a whole number, 1 or more.');
  const parsed = parseCharacter(body.character);
  if (!parsed.ok) throw new CharacterError('invalid_character', 'The character file has errors.', { errors: parsed.errors });
  const character = parsed.value;
  if (character.id !== slug || character.version !== version) {
    throw new CharacterError('invalid_character', `The file holds ${formatCharacterRef(character)}, not ${slug}@${version}.`);
  }
  if (Buffer.byteLength(JSON.stringify(character)) > MAX_CHARACTER_BYTES) throw new CharacterError('invalid_character', 'The character file is too large.');
  const stillsRaw = body.stills ?? {};
  if (typeof stillsRaw !== 'object' || stillsRaw === null || Array.isArray(stillsRaw)) throw new CharacterError('invalid_stills', 'stills must map still ids to image asset ids.');
  const stills: Record<string, string> = {};
  for (const [still, asset] of Object.entries(stillsRaw as Record<string, unknown>)) {
    if (!character.stills.some((s) => s.id === still)) throw new CharacterError('invalid_stills', `The character has no still "${still}".`);
    if (typeof asset !== 'string' || !ASSET_ID.test(asset)) throw new CharacterError('invalid_stills', `stills.${still} must be an image asset id.`);
    stills[still] = asset;
  }
  const missingStills = character.stills.filter((s) => !stills[s.id]).map((s) => s.id);
  if (missingStills.length) throw new CharacterError('invalid_stills', `Upload every still and name its asset: ${missingStills.join(', ')}.`);
  const assets = await loadOwnedAssets(uid, Object.values(stills));
  const missing = Object.values(stills).filter((a) => !assets.has(a));
  if (missing.length) throw new CharacterError('asset_not_found', 'These assets are not yours, or do not exist. Upload them first.', { ids: missing });
  if (Object.values(stills).some((a) => !assets.get(a)!.mimeType.startsWith('image/'))) throw new CharacterError('invalid_stills', 'Stills must be image assets.');

  const id = characterId(uid, slug);
  const now = Date.now();
  const created = await adminDb().runTransaction(async (tx) => {
    const ref = characters().doc(id);
    const versionRef = versionsOf(id).doc(String(version));
    const [snapshot, versionSnapshot] = await Promise.all([tx.get(ref), tx.get(versionRef)]);
    const data = snapshot.data();
    if (snapshot.exists && data?.ownerUid !== uid) throw notFound();
    if (versionSnapshot.exists) {
      const stored = versionSnapshot.data() as StoredVersion;
      if (canonical({ character: stored.character, stills: stored.stills }) === canonical({ character, stills })) return false;
      throw new CharacterError('version_exists', `${formatCharacterRef(character)} is stored already with other content. A version never changes: push it as version ${Math.max(version, Number(data?.latestVersion ?? 0)) + 1}.`);
    }
    const versions = (Array.isArray(data?.versions) ? (data!.versions as CharacterVersionSummary[]) : []).filter((v) => v.version !== version);
    if (versions.length >= MAX_VERSIONS) throw new CharacterError('too_many_versions', `A character holds at most ${MAX_VERSIONS} versions.`);
    const entry = character.changelog.find((c) => c.version === version)!;
    versions.push({ version, date: entry.date, changes: entry.changes, createdAt: now });
    versions.sort((a, b) => a.version - b.version);
    const latest = Math.max(version, Number(data?.latestVersion ?? 0));
    tx.set(versionRef, { ownerUid: uid, characterId: id, version, character, stills, createdAt: now } satisfies StoredVersion);
    tx.set(ref, {
      ownerUid: uid,
      slug,
      // The listing shows the newest version's name and kind.
      name: latest === version ? character.name : String(data?.name ?? character.name),
      kind: latest === version ? character.kind : (data?.kind ?? character.kind),
      latestVersion: latest,
      versions,
      createdAt: Number(data?.createdAt ?? now),
      updatedAt: now,
    });
    return true;
  });
  return { version: await getCharacterVersion(uid, id, version, origin), created };
}

/**
 * A production's cast, checked and resolved: `[{ role, character: "rick@1" }]`
 * becomes what the production stores. Every version must be the owner's.
 */
export async function resolveCast(uid: string, raw: unknown): Promise<CastMember[]> {
  if (!Array.isArray(raw) || raw.length > 50) throw new CharacterError('invalid_cast', 'cast must be a list of { role, character: "id@version" }, at most 50.');
  const cast: CastMember[] = [];
  const roles = new Set<string>();
  for (const item of raw as unknown[]) {
    const entry = item as Record<string, unknown>;
    const role = typeof entry?.role === 'string' ? entry.role.trim() : '';
    if (!role || role.length > 80) throw new CharacterError('invalid_cast', 'Each cast member needs a role: the speaker name its cuts use.');
    if (roles.has(role)) throw new CharacterError('invalid_cast', `The role "${role}" is cast twice.`);
    roles.add(role);
    const ref = typeof entry.character === 'string' ? parseCharacterRef(entry.character) : null;
    if (!ref) throw new CharacterError('invalid_cast', `cast "${role}": character must be like "rick@1".`);
    const id = characterId(uid, ref.id);
    const snapshot = await versionsOf(id).doc(String(ref.version)).get();
    const stored = snapshot.data() as StoredVersion | undefined;
    if (!snapshot.exists || !stored || stored.ownerUid !== uid) {
      throw new CharacterError('character_not_found', `No ${formatCharacterRef(ref)} of yours: push the character first.`, { character: formatCharacterRef(ref) });
    }
    const c = stored.character;
    const first = c.stills[0];
    cast.push({
      role,
      characterId: id,
      slug: c.id,
      version: c.version,
      ref: formatCharacterRef(c),
      name: c.name,
      description: c.description,
      register: c.delivery.register,
      voice: describeVoice(c),
      stillAssetId: first ? (stored.stills[first.id] ?? null) : null,
      referenceLines: c.delivery.reference?.lines.length ?? 0,
    });
  }
  return cast;
}

/** A stored cast member, read defensively. */
export function readCastMember(value: unknown): CastMember | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.role !== 'string' || typeof v.slug !== 'string' || typeof v.version !== 'number') return null;
  const text = (x: unknown) => (typeof x === 'string' ? x : '');
  return {
    role: v.role,
    characterId: text(v.characterId),
    slug: v.slug,
    version: v.version,
    ref: text(v.ref) || `${v.slug}@${v.version}`,
    name: text(v.name) || v.role,
    description: text(v.description),
    register: text(v.register),
    voice: text(v.voice),
    stillAssetId: typeof v.stillAssetId === 'string' ? v.stillAssetId : null,
    referenceLines: typeof v.referenceLines === 'number' ? v.referenceLines : 0,
  };
}
