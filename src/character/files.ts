import { existsSync } from 'node:fs';
import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findRepoRoot } from '../production/manifest.js';
import { CHARACTER_ID_PATTERN, formatCharacterRef, parseCharacter, parseCharacterRef, serializeCharacter, type Character, type CharacterRef } from './character.js';

/**
 * Character files on disk. A character's folder (default `docs/characters` in
 * the repository) holds its current version as `<id>.character.json` and
 * every earlier version as `<id>@<version>.character.json`. Versions are
 * never edited once a production uses them; a change is a new version, and
 * the old file is kept so `rick@1` always means the same thing.
 */

export const CHARACTERS_DIR = 'docs/characters';

/** The characters folder: `dir`, else MDMEDIA_CHARACTERS_DIR, else `docs/characters` in the repository around `from`. */
export function charactersDir(options: { dir?: string; from?: string; env?: Record<string, string | undefined> } = {}): string {
  const env = options.env ?? process.env;
  if (options.dir) return path.resolve(options.dir);
  if (env.MDMEDIA_CHARACTERS_DIR) return path.resolve(env.MDMEDIA_CHARACTERS_DIR);
  return path.join(findRepoRoot(options.from ?? process.cwd()), CHARACTERS_DIR);
}

export const currentFile = (dir: string, id: string) => path.join(dir, `${id}.character.json`);
export const archivedFile = (dir: string, id: string, version: number) => path.join(dir, `${id}@${version}.character.json`);

export class CharacterFileError extends Error {
  constructor(file: string, problems: string[]) {
    super(`${file}:\n${problems.map((p) => `  ${p}`).join('\n')}`);
    this.name = 'CharacterFileError';
  }
}

/** Reads and checks one character file. */
export async function readCharacterFile(file: string): Promise<Character> {
  let json: unknown;
  try {
    json = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new CharacterFileError(file, [(error as { code?: string }).code === 'ENOENT' ? 'no such file' : 'not valid JSON']);
  }
  const parsed = parseCharacter(json);
  if (!parsed.ok) throw new CharacterFileError(file, parsed.errors);
  const stem = path.basename(file).replace(/\.character\.json$/, '');
  const expected = stem.includes('@') ? formatCharacterRef(parsed.value) : parsed.value.id;
  if (stem !== expected) throw new CharacterFileError(file, [`its name says "${stem}" but it holds ${formatCharacterRef(parsed.value)}`]);
  return parsed.value;
}

/**
 * A character by id, or by `id@version`: the current file when it is that
 * version (or no version is asked), else the archived one.
 */
export async function loadCharacter(dir: string, refOrId: string): Promise<{ character: Character; file: string }> {
  const ref: CharacterRef | null = parseCharacterRef(refOrId);
  const id = ref?.id ?? refOrId.trim();
  if (!CHARACTER_ID_PATTERN.test(id)) throw new Error(`"${refOrId}" is not a character id (like "big-hal") or id@version (like "big-hal@1").`);
  const current = currentFile(dir, id);
  if (!ref) {
    if (!existsSync(current)) throw new Error(`No character "${id}" in ${dir}.`);
    return { character: await readCharacterFile(current), file: current };
  }
  if (existsSync(current)) {
    const character = await readCharacterFile(current);
    if (character.version === ref.version) return { character, file: current };
  }
  const archived = archivedFile(dir, id, ref.version);
  if (existsSync(archived)) return { character: await readCharacterFile(archived), file: archived };
  throw new Error(`No ${formatCharacterRef(ref)} in ${dir}${existsSync(current) ? ' (the current version is another)' : ''}.`);
}

/** Every character's current version in `dir`, by name. */
export async function listCharacters(dir: string): Promise<Array<{ character: Character; file: string; versions: number[] }>> {
  const names = existsSync(dir) ? await readdir(dir) : [];
  const out: Array<{ character: Character; file: string; versions: number[] }> = [];
  for (const name of names.filter((n) => /^[a-z0-9-]+\.character\.json$/.test(n)).sort()) {
    const file = path.join(dir, name);
    const character = await readCharacterFile(file);
    const archived = names
      .map((n) => new RegExp(`^${character.id}@(\\d+)\\.character\\.json$`).exec(n)?.[1])
      .filter((v): v is string => v !== undefined)
      .map(Number);
    out.push({ character, file, versions: [...new Set([...archived, character.version])].sort((a, b) => a - b) });
  }
  return out.sort((a, b) => a.character.name.localeCompare(b.character.name));
}

/** Writes a character's current file; refuses to replace a file that holds another character or an older version than the one on disk. */
export async function writeCharacter(dir: string, character: Character, options: { create?: boolean } = {}): Promise<string> {
  const file = currentFile(dir, character.id);
  if (options.create && existsSync(file)) throw new Error(`${file} exists; a character is created once.`);
  if (!options.create && existsSync(file)) {
    const before = await readCharacterFile(file);
    if (before.version > character.version) throw new Error(`${file} is at version ${before.version}; won't write version ${character.version} over it.`);
  }
  await writeFile(file, serializeCharacter(character), options.create ? { flag: 'wx' } : undefined);
  return file;
}

/**
 * Moves to a new version: the current file is kept as `<id>@<old>.character.json`
 * (never replacing one that exists), then the new version is written as current.
 */
export async function writeNewVersion(dir: string, next: Character): Promise<{ file: string; archived: string }> {
  const file = currentFile(dir, next.id);
  const before = await readCharacterFile(file);
  if (next.version !== before.version + 1) throw new Error(`${next.id} is at version ${before.version}; the next is ${before.version + 1}, not ${next.version}.`);
  const archived = archivedFile(dir, next.id, before.version);
  if (existsSync(archived)) throw new Error(`${archived} exists already.`);
  await rename(file, archived);
  await writeFile(file, serializeCharacter(next), { flag: 'wx' });
  return { file, archived };
}

/** A character's media root, with `~` expanded. */
export function characterRoot(character: Character, home = os.homedir()): string {
  const root = character.media.root;
  return root === '~' ? home : root.startsWith('~/') ? path.join(home, root.slice(2)) : path.resolve(root);
}

/** A still's absolute path. */
export function stillPath(character: Character, file: string, home = os.homedir()): string {
  return path.resolve(characterRoot(character, home), file);
}
