import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { ReferenceFor } from '../cut/check.js';
import type { CharacterDelivery, CharacterFor } from '../cut/storyboard.js';
import { findRepoRoot, readProductionManifest, type CastEntry, type ProductionManifest } from '../production/manifest.js';
import { formatCharacterRef, type Character } from './character.js';
import { charactersDir, loadCharacter } from './files.js';

/**
 * A production's cast, loaded: each role's character at the version the
 * production names. A cut's line `speaker` is a role, so the cast gives
 * `mdmedia cut check` each speaker's reference levels and
 * `mdmedia cut storyboard` their look, "never" rules and delivery profile.
 */

export interface CastMember {
  role: string;
  character: Character;
  file: string;
}

export interface LoadedCast {
  /** The production manifest the cast is from. */
  manifest: string;
  members: CastMember[];
}

/** Loads every role's character at its version. */
export async function loadCast(cast: readonly CastEntry[], dir: string): Promise<CastMember[]> {
  const members: CastMember[] = [];
  for (const entry of cast) {
    const { character, file } = await loadCharacter(dir, formatCharacterRef(entry.character));
    members.push({ role: entry.role, character, file });
  }
  return members;
}

/** The production manifests in `<repo>/docs/productions`. */
async function manifestFiles(repo: string): Promise<string[]> {
  const dir = path.join(repo, 'docs', 'productions');
  if (!existsSync(dir)) return [];
  return (await readdir(dir)).filter((n) => n.endsWith('.production.json')).sort().map((n) => path.join(dir, n));
}

/**
 * The production a cut belongs to: `production` when given, else the
 * manifest in `<repo>/docs/productions` that lists this cut file. Null when
 * none does. A manifest that can't be read is skipped unless it was named.
 */
export async function productionOfCut(cutPath: string, options: { production?: string } = {}): Promise<ProductionManifest | null> {
  if (options.production) return readProductionManifest(options.production);
  const cut = path.resolve(cutPath);
  for (const file of await manifestFiles(findRepoRoot(path.dirname(cut)))) {
    let manifest: ProductionManifest;
    try {
      manifest = await readProductionManifest(file);
    } catch {
      continue;
    }
    if (manifest.cuts.some((c) => c.kind === 'cut' && path.resolve(c.cut) === cut)) return manifest;
  }
  return null;
}

/** The cast of the production a cut belongs to, or null when it has none. */
export async function castOfCut(cutPath: string, options: { production?: string; charactersDir?: string } = {}): Promise<LoadedCast | null> {
  const manifest = await productionOfCut(cutPath, options);
  if (!manifest || manifest.cast.length === 0) return null;
  const dir = charactersDir({ dir: options.charactersDir, from: path.dirname(manifest.file) });
  return { manifest: manifest.file, members: await loadCast(manifest.cast, dir) };
}

const byRole = (members: readonly CastMember[]) => new Map(members.map((m) => [m.role, m]));

/** Each speaker's reference levels, with where they came from: the `reference` hook of `mdmedia cut check`. */
export function castReference(members: readonly CastMember[]): ReferenceFor {
  const roles = byRole(members);
  return (speaker) => {
    const member = roles.get(speaker);
    const reference = member?.character.delivery.reference;
    if (!member || !reference) return undefined;
    const n = reference.lines.length;
    return { ...reference.levels, source: `${formatCharacterRef(member.character)}, from ${n} approved line${n === 1 ? '' : 's'}` };
  };
}

/** What a storyboard gets from a speaker's character: the `character` hook of `mdmedia cut storyboard`. */
export function castDelivery(members: readonly CastMember[]): CharacterFor {
  const roles = byRole(members);
  return (speaker): CharacterDelivery | undefined => {
    const member = roles.get(speaker);
    if (!member) return undefined;
    const c = member.character;
    return {
      register: c.delivery.register,
      never: c.delivery.never,
      ...(c.delivery.reference ? { reference: c.delivery.reference.levels, typical: c.delivery.reference.typical } : {}),
      look: c.look,
      ref: formatCharacterRef(c),
    };
  };
}

/** One line per member: "Big Hal = big-hal@1 (reference from 9 approved lines)". */
export function describeCast(cast: LoadedCast): string[] {
  return cast.members.map((m) => {
    const reference = m.character.delivery.reference;
    return `${m.role} = ${formatCharacterRef(m.character)} (${reference ? `reference from ${reference.lines.length} approved line${reference.lines.length === 1 ? '' : 's'}` : 'no reference levels yet'})`;
  });
}
