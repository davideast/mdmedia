import type { LevelRange, ReferenceLevels } from '../cut/check.js';

/**
 * A character: a person or a talking thing that appears across productions
 * (Rick, Buddy, Big Hal, Chet and Moose). One file per character,
 * `<id>.character.json`, holds its current version; earlier versions are kept
 * beside it as `<id>@<version>.character.json`, so a production that was made
 * with `rick@1` still finds exactly that. See docs/characters.md.
 *
 * Everything here is pure: parsing, checking and writing the file's JSON.
 */

/** The value of a character file's `format` field. */
export const CHARACTER_FORMAT = 'mdmedia.character@1';

/** Lowercase words joined by hyphens, like a production's slug: `big-hal`. */
export const CHARACTER_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const STILL_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type CharacterKind = 'person' | 'thing';
const KINDS: readonly CharacterKind[] = ['person', 'thing'];

/** How a character's lines get their voice. */
export type VoiceUse =
  /** Voice-only lines are text-to-speech in this voice (Buddy, the announcers over the plays). */
  | 'tts'
  /** On-camera lines are the video model's speech converted to this voice (speech-to-speech), keeping its timing and acting. */
  | 'swap'
  /** On-camera lines keep the video model's own voice, so they are cut from as few takes as possible (Rick, Big Hal). */
  | 'on-camera';
const USES: readonly VoiceUse[] = ['tts', 'swap', 'on-camera'];

export type VoiceProvider = 'elevenlabs' | 'video-model';
const PROVIDERS: readonly VoiceProvider[] = ['elevenlabs', 'video-model'];

export interface CharacterVoice {
  provider: VoiceProvider;
  /** The provider's voice name, as `mdmedia voices` lists it ("Bill - Wise, Mature, Balanced", "Eric"). */
  name?: string;
  /** The provider's voice id, when known; it wins over the name. */
  id?: string;
  /** Provider settings: model, stability, similarity and the like. */
  settings?: Record<string, string | number | boolean>;
  uses: VoiceUse[];
  notes?: string;
}

/** Where a reference still came from: a frame of a take, or a generation. */
export type StillSource =
  | { take: string; at: number }
  | { generated: { provider: string; prompt?: string; ref?: string; at?: string } };

export interface CharacterStill {
  id: string;
  /** Relative to the character file's media root. */
  file: string;
  from: StillSource;
  /** What it shows: "medium close-up, facing camera". */
  note?: string;
}

/** One approved line a character's reference levels were measured from. */
export interface MeasuredLine {
  /** The cut file, relative to the repository. */
  cut: string;
  line: string;
  text: string;
  /** LUFS. */
  loudness: number | null;
  /** Median pitch, Hz. */
  pitch: number | null;
  /** 10th to 90th percentile, semitones. */
  pitchRange: number | null;
  /** Words per second. */
  rate: number | null;
}

/** How far the reference ranges reach past what the approved lines measured. */
export interface ReferenceMargins {
  /** LU either side. */
  loudness: number;
  /** Semitones either side of the median pitch. */
  pitch: number;
  /** Semitones above the widest pitch range. */
  pitchRange: number;
  /** A fraction of the rate, either side. */
  rate: number;
}

export interface CharacterReference {
  /** The ranges `mdmedia cut check` holds the character's lines to. */
  levels: ReferenceLevels;
  /** Each measure's median over the approved lines. */
  typical: { loudness: number | null; pitch: number | null; pitchRange: number | null; rate: number | null };
  margins: ReferenceMargins;
  lines: MeasuredLine[];
  /** The check's measuring method, e.g. `dialogue-stem@1`. */
  method: string;
  measuredAt: string;
}

export interface CharacterDeliveryProfile {
  /** E.g. "a proud, sincere, steady local pitchman". */
  register: string;
  /** E.g. ["never shouts", "never winks"]. */
  never: string[];
  /** Measured from approved lines (`mdmedia character measure`), or null until then. */
  reference: CharacterReference | null;
}

export interface ChangelogEntry {
  version: number;
  /** An ISO date. */
  date: string;
  changes: string;
}

export interface Character {
  format: typeof CHARACTER_FORMAT;
  id: string;
  version: number;
  name: string;
  kind: CharacterKind;
  description: string;
  look: { description: string; never: string[] };
  /** Where `stills` paths are relative to; `~` is the home folder. */
  media: { root: string };
  stills: CharacterStill[];
  voice: CharacterVoice;
  delivery: CharacterDeliveryProfile;
  /** Newest last; it has an entry for `version`. */
  changelog: ChangelogEntry[];
}

/** `big-hal@1`: a character and the version a production was made with. */
export interface CharacterRef {
  id: string;
  version: number;
}

export function parseCharacterRef(text: string): CharacterRef | null {
  const match = /^([a-z0-9]+(?:-[a-z0-9]+)*)@([1-9][0-9]{0,5})$/.exec(text.trim());
  return match ? { id: match[1]!, version: Number(match[2]) } : null;
}

export const formatCharacterRef = (ref: CharacterRef): string => `${ref.id}@${ref.version}`;

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
const isNum = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export type CharacterResult = { ok: true; value: Character } | { ok: false; errors: string[] };

function text(json: Obj, key: string, problems: string[], where: string, required = true): string {
  const value = json[key];
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || (required && !value.trim())) {
    problems.push(`${where}${key}: expected ${required ? 'non-empty ' : ''}text`);
    return '';
  }
  return value.trim();
}

function texts(value: unknown, problems: string[], where: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !v.trim())) {
    problems.push(`${where}: expected a list of text`);
    return [];
  }
  return (value as string[]).map((v) => v.trim());
}

function range(value: unknown, problems: string[], where: string): LevelRange | undefined {
  if (value === undefined) return undefined;
  if (!isObj(value) || (value.min !== undefined && !isNum(value.min)) || (value.max !== undefined && !isNum(value.max))) {
    problems.push(`${where}: expected { min?, max? } numbers`);
    return undefined;
  }
  if (isNum(value.min) && isNum(value.max) && value.min > value.max) problems.push(`${where}: min is above max`);
  return { ...(isNum(value.min) ? { min: value.min } : {}), ...(isNum(value.max) ? { max: value.max } : {}) };
}

function numOrNull(value: unknown, problems: string[], where: string): number | null {
  if (value === null || value === undefined) return null;
  if (!isNum(value)) {
    problems.push(`${where}: expected a number or null`);
    return null;
  }
  return value;
}

function parseReference(value: unknown, problems: string[]): CharacterReference | null {
  if (value === null || value === undefined) return null;
  const where = 'delivery.reference';
  if (!isObj(value)) {
    problems.push(`${where}: expected the measured reference, or null`);
    return null;
  }
  const levelsRaw = isObj(value.levels) ? value.levels : {};
  if (!isObj(value.levels)) problems.push(`${where}.levels: expected the reference ranges`);
  const levels: ReferenceLevels = {};
  for (const key of ['loudness', 'pitch', 'pitchRange', 'rate'] as const) {
    const r = range(levelsRaw[key], problems, `${where}.levels.${key}`);
    if (r) levels[key] = r;
  }
  if (levelsRaw.source !== undefined) {
    if (typeof levelsRaw.source === 'string') levels.source = levelsRaw.source;
    else problems.push(`${where}.levels.source: expected text`);
  }
  const typicalRaw = isObj(value.typical) ? value.typical : {};
  const typical = {
    loudness: numOrNull(typicalRaw.loudness, problems, `${where}.typical.loudness`),
    pitch: numOrNull(typicalRaw.pitch, problems, `${where}.typical.pitch`),
    pitchRange: numOrNull(typicalRaw.pitchRange, problems, `${where}.typical.pitchRange`),
    rate: numOrNull(typicalRaw.rate, problems, `${where}.typical.rate`),
  };
  const m = isObj(value.margins) ? value.margins : {};
  if (!isObj(value.margins) || !isNum(m.loudness) || !isNum(m.pitch) || !isNum(m.pitchRange) || !isNum(m.rate)) {
    problems.push(`${where}.margins: expected { loudness, pitch, pitchRange, rate } numbers`);
  }
  const margins: ReferenceMargins = {
    loudness: isNum(m.loudness) ? m.loudness : 0,
    pitch: isNum(m.pitch) ? m.pitch : 0,
    pitchRange: isNum(m.pitchRange) ? m.pitchRange : 0,
    rate: isNum(m.rate) ? m.rate : 0,
  };
  const lines: MeasuredLine[] = [];
  if (!Array.isArray(value.lines) || value.lines.length === 0) problems.push(`${where}.lines: expected the approved lines it was measured from`);
  (Array.isArray(value.lines) ? value.lines : []).forEach((raw, i) => {
    const at = `${where}.lines[${i}]`;
    if (!isObj(raw)) {
      problems.push(`${at}: expected an object`);
      return;
    }
    lines.push({
      cut: text(raw, 'cut', problems, `${at}.`),
      line: text(raw, 'line', problems, `${at}.`),
      text: text(raw, 'text', problems, `${at}.`, false),
      loudness: numOrNull(raw.loudness, problems, `${at}.loudness`),
      pitch: numOrNull(raw.pitch, problems, `${at}.pitch`),
      pitchRange: numOrNull(raw.pitchRange, problems, `${at}.pitchRange`),
      rate: numOrNull(raw.rate, problems, `${at}.rate`),
    });
  });
  const method = text(value, 'method', problems, `${where}.`);
  const measuredAt = text(value, 'measuredAt', problems, `${where}.`);
  if (measuredAt && Number.isNaN(Date.parse(measuredAt))) problems.push(`${where}.measuredAt: expected an ISO date`);
  return { levels, typical, margins, lines, method, measuredAt };
}

function parseStill(raw: unknown, i: number, problems: string[]): CharacterStill | null {
  const where = `stills[${i}]`;
  if (!isObj(raw)) {
    problems.push(`${where}: expected an object`);
    return null;
  }
  const id = typeof raw.id === 'string' && STILL_ID_PATTERN.test(raw.id) ? raw.id : '';
  if (!id) problems.push(`${where}.id: expected lowercase words joined by hyphens, like "front"`);
  const file = text(raw, 'file', problems, `${where}.`);
  if (file && (path_isAbsolute(file) || file.split(/[\\/]/).includes('..'))) problems.push(`${where}.file: expected a path under the media root`);
  let from: StillSource | null = null;
  const src = raw.from;
  if (isObj(src) && typeof src.take === 'string' && src.take && isNum(src.at) && src.at >= 0) from = { take: src.take, at: src.at };
  else if (isObj(src) && isObj(src.generated) && typeof src.generated.provider === 'string' && src.generated.provider) {
    const g = src.generated;
    from = {
      generated: {
        provider: g.provider as string,
        ...(typeof g.prompt === 'string' ? { prompt: g.prompt } : {}),
        ...(typeof g.ref === 'string' ? { ref: g.ref } : {}),
        ...(typeof g.at === 'string' ? { at: g.at } : {}),
      },
    };
  } else problems.push(`${where}.from: expected { take, at } (a frame of a take) or { generated: { provider, prompt?, ref?, at? } }`);
  const note = raw.note === undefined ? undefined : text(raw, 'note', problems, `${where}.`);
  return from ? { id, file, from, ...(note ? { note } : {}) } : null;
}

/** `path.isAbsolute` without importing node:path, so this module stays usable anywhere. */
function path_isAbsolute(p: string): boolean {
  return p.startsWith('/') || p.startsWith('~') || /^[A-Za-z]:[\\/]/.test(p);
}

function parseVoice(raw: unknown, problems: string[]): CharacterVoice {
  const fallback: CharacterVoice = { provider: 'video-model', uses: ['on-camera'] };
  if (!isObj(raw)) {
    problems.push('voice: expected { provider, name?, id?, settings?, uses }');
    return fallback;
  }
  const provider = raw.provider as VoiceProvider;
  if (!PROVIDERS.includes(provider)) problems.push(`voice.provider: expected ${PROVIDERS.join(' or ')}`);
  const name = raw.name === undefined ? undefined : text(raw, 'name', problems, 'voice.');
  const id = raw.id === undefined ? undefined : text(raw, 'id', problems, 'voice.');
  if (provider === 'elevenlabs' && !name && !id) problems.push('voice: an ElevenLabs voice needs its name or id');
  let settings: Record<string, string | number | boolean> | undefined;
  if (raw.settings !== undefined) {
    if (!isObj(raw.settings) || Object.values(raw.settings).some((v) => !['string', 'number', 'boolean'].includes(typeof v))) {
      problems.push('voice.settings: expected names with text, number or true/false values');
    } else settings = { ...(raw.settings as Record<string, string | number | boolean>) };
  }
  const uses = Array.isArray(raw.uses) ? raw.uses : [];
  if (uses.length === 0 || uses.some((u) => !USES.includes(u as VoiceUse))) problems.push(`voice.uses: expected a list of ${USES.join(', ')}`);
  if (provider === 'video-model' && uses.some((u) => u !== 'on-camera')) problems.push('voice.uses: a video-model voice is only "on-camera"; text-to-speech and swaps need a provider voice');
  const notes = raw.notes === undefined ? undefined : text(raw, 'notes', problems, 'voice.');
  return {
    provider: PROVIDERS.includes(provider) ? provider : 'video-model',
    ...(name ? { name } : {}),
    ...(id ? { id } : {}),
    ...(settings ? { settings } : {}),
    uses: [...new Set(uses.filter((u): u is VoiceUse => USES.includes(u as VoiceUse)))],
    ...(notes ? { notes } : {}),
  };
}

/** Checks a character file's JSON. Every problem is reported at once. */
export function parseCharacter(json: unknown): CharacterResult {
  const problems: string[] = [];
  if (!isObj(json)) return { ok: false, errors: ['expected a JSON object'] };
  if (json.format !== CHARACTER_FORMAT) problems.push(`format: expected "${CHARACTER_FORMAT}"`);
  const id = typeof json.id === 'string' && CHARACTER_ID_PATTERN.test(json.id) && json.id.length <= 80 ? json.id : '';
  if (!id) problems.push('id: expected lowercase words joined by hyphens, like "big-hal"');
  const version = isNum(json.version) && Number.isInteger(json.version) && json.version >= 1 && json.version < 1e6 ? json.version : 0;
  if (!version) problems.push('version: expected a whole number, 1 or more');
  const name = text(json, 'name', problems, '');
  const kind = (json.kind === undefined ? 'person' : json.kind) as CharacterKind;
  if (!KINDS.includes(kind)) problems.push(`kind: expected ${KINDS.join(' or ')}`);
  const description = text(json, 'description', problems, '');

  const lookRaw = isObj(json.look) ? json.look : {};
  if (!isObj(json.look)) problems.push('look: expected { description, never }');
  const look = { description: text(lookRaw, 'description', problems, 'look.'), never: texts(lookRaw.never, problems, 'look.never') };

  const media = isObj(json.media) && typeof json.media.root === 'string' && json.media.root ? { root: json.media.root } : null;
  if (!media) problems.push('media.root: expected the media root its stills are under, e.g. "~/.local/share/mdmedia/productions/crt-tv"');

  if (json.stills !== undefined && !Array.isArray(json.stills)) problems.push('stills: expected a list');
  const stills = (Array.isArray(json.stills) ? json.stills : []).map((s, i) => parseStill(s, i, problems)).filter((s): s is CharacterStill => s !== null);
  const stillIds = stills.map((s) => s.id);
  for (const dup of new Set(stillIds.filter((s, i) => stillIds.indexOf(s) !== i))) problems.push(`stills: the id "${dup}" is used twice`);

  const voice = parseVoice(json.voice, problems);

  const deliveryRaw = isObj(json.delivery) ? json.delivery : {};
  if (!isObj(json.delivery)) problems.push('delivery: expected { register, never, reference }');
  const delivery: CharacterDeliveryProfile = {
    register: text(deliveryRaw, 'register', problems, 'delivery.'),
    never: texts(deliveryRaw.never, problems, 'delivery.never'),
    reference: parseReference(deliveryRaw.reference, problems),
  };

  const changelog: ChangelogEntry[] = [];
  if (!Array.isArray(json.changelog) || json.changelog.length === 0) problems.push('changelog: expected at least one entry, { version, date, changes }');
  (Array.isArray(json.changelog) ? json.changelog : []).forEach((raw, i) => {
    const where = `changelog[${i}]`;
    if (!isObj(raw) || !isNum(raw.version) || !Number.isInteger(raw.version) || raw.version < 1) {
      problems.push(`${where}: expected { version, date, changes }`);
      return;
    }
    const date = text(raw, 'date', problems, `${where}.`);
    if (date && Number.isNaN(Date.parse(date))) problems.push(`${where}.date: expected an ISO date`);
    changelog.push({ version: raw.version, date, changes: text(raw, 'changes', problems, `${where}.`) });
  });
  for (let i = 1; i < changelog.length; i++) {
    if (changelog[i]!.version < changelog[i - 1]!.version) problems.push('changelog: expected oldest first');
  }
  if (version && changelog.length > 0) {
    if (!changelog.some((c) => c.version === version)) problems.push(`changelog: expected an entry for version ${version}`);
    if (changelog.some((c) => c.version > version)) problems.push(`changelog: has an entry for a version after ${version}`);
  }

  if (problems.length > 0) return { ok: false, errors: problems };
  return {
    ok: true,
    value: { format: CHARACTER_FORMAT, id, version, name, kind, description, look, media: media!, stills, voice, delivery, changelog },
  };
}

/**
 * A character's JSON as it is written to its file: the fields in a fixed
 * order, two-space indents and a final newline, so writing an unchanged
 * character changes nothing.
 */
export function serializeCharacter(character: Character): string {
  const ordered: Character = {
    format: CHARACTER_FORMAT,
    id: character.id,
    version: character.version,
    name: character.name,
    kind: character.kind,
    description: character.description,
    look: { description: character.look.description, never: character.look.never },
    media: { root: character.media.root },
    stills: character.stills,
    voice: character.voice,
    delivery: { register: character.delivery.register, never: character.delivery.never, reference: character.delivery.reference },
    changelog: character.changelog,
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/** A new character at version 1, to be filled in. */
export function newCharacter(input: {
  id: string;
  name: string;
  description?: string;
  kind?: CharacterKind;
  root: string;
  voice?: CharacterVoice;
  date: string;
}): Character {
  return {
    format: CHARACTER_FORMAT,
    id: input.id,
    version: 1,
    name: input.name,
    kind: input.kind ?? 'person',
    description: input.description ?? `${input.name}: who they are, in a sentence.`,
    look: { description: `What ${input.name} looks like, in the words every storyboard should use.`, never: [] },
    media: { root: input.root },
    stills: [],
    voice: input.voice ?? { provider: 'video-model', uses: ['on-camera'] },
    delivery: { register: `How ${input.name} speaks, in a phrase.`, never: [], reference: null },
    changelog: [{ version: 1, date: input.date, changes: 'First version.' }],
  };
}

/**
 * The next version of a character, with its changelog entry. A version is
 * never changed once a production uses it, so anything that changes what a
 * production gets (its look, voice, delivery or reference levels) is a new
 * version.
 */
export function nextVersion(character: Character, changes: string, date: string): Character {
  const version = character.version + 1;
  return { ...character, version, changelog: [...character.changelog, { version, date, changes }] };
}

/** The voice in a few words: "ElevenLabs “Eric” (text-to-speech, swap)". */
export function describeVoice(voice: CharacterVoice): string {
  const uses = voice.uses.map((u) => (u === 'tts' ? 'text-to-speech' : u === 'swap' ? 'voice swap' : 'on camera')).join(', ');
  if (voice.provider === 'video-model') return `the video model's own voice (${uses})`;
  return `ElevenLabs "${voice.name ?? voice.id}" (${uses})`;
}
