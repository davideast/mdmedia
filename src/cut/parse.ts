import { FRAMES_PATTERN } from './anchor.js';
import {
  ASSET_PREFIX,
  CUT_FORMAT,
  type AnchoredFadeIn,
  type AnchoredFadeOut,
  type AudioClip,
  type AudioFilter,
  type AudioSync,
  type BedPart,
  type CheckSettings,
  type CheckThresholds,
  type Blink,
  type ColorShift,
  type Crop,
  type CutError,
  type CutExtension,
  type CutFile,
  type CutMeta,
  type CutResult,
  type ExtensionSegment,
  type FocusPoint,
  type Line,
  type MediaRoots,
  type MixFilter,
  type MixSettings,
  type MotionKey,
  type Offset,
  type Overlay,
  type Performance,
  type PictureFilter,
  type PictureSettings,
  type Seconds,
  type Segment,
  type SegmentAudio,
  type SegmentMix,
  type SourceProvenance,
  type Synth,
  type TimeRef,
  type VolumeKey,
  type Wave,
  type Word,
  type Zoom,
  type ZoomKey,
} from './types.js';

/** The id in an `asset:<id>` source. */
export const ASSET_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** Cut names are file stems: lowercase words joined by hyphens, as in `night-wagon-take9`. */
export const CUT_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads fields off untrusted JSON, recording a `bad-shape` error for each wrong one. */
class Reader {
  readonly errors: CutError[] = [];

  fail(where: string, message: string): undefined {
    this.errors.push({ code: 'bad-shape', field: where, message: `${where}: ${message}` });
    return undefined;
  }

  conflict(id: string | undefined, where: string, message: string): undefined {
    this.errors.push({ code: 'conflicting-fields', ...(id === undefined ? {} : { id }), field: where, message: `${where}: ${message}` });
    return undefined;
  }

  obj(value: unknown, where: string): Obj | undefined {
    return isObj(value) ? value : this.fail(where, 'expected an object');
  }

  list(o: Obj, key: string, where: string, required: boolean): unknown[] | undefined {
    const v = o[key];
    if (v === undefined) return required ? this.fail(`${where}.${key}`, 'is required') : undefined;
    return Array.isArray(v) ? v : this.fail(`${where}.${key}`, 'expected an array');
  }

  num(o: Obj, key: string, where: string, required: boolean): number | undefined {
    const v = o[key];
    if (v === undefined) return required ? this.fail(`${where}.${key}`, 'is required') : undefined;
    return typeof v === 'number' && Number.isFinite(v) ? v : this.fail(`${where}.${key}`, 'expected a number');
  }

  /** Seconds as a number, or frames at the cut's fps as `"f191"`. */
  seconds(o: Obj, key: string, where: string, required: boolean, ok: (n: number) => boolean = () => true, should = ''): Seconds | undefined {
    const v = o[key];
    if (typeof v === 'string') {
      if (FRAMES_PATTERN.test(v)) return v as Seconds;
      return this.fail(`${where}.${key}`, 'expected a number of seconds, or frames like "f191"');
    }
    return this.ranged(o, key, where, required, ok, should);
  }

  str(o: Obj, key: string, where: string, required: boolean): string | undefined {
    const v = o[key];
    if (v === undefined) return required ? this.fail(`${where}.${key}`, 'is required') : undefined;
    return typeof v === 'string' ? v : this.fail(`${where}.${key}`, 'expected a string');
  }

  bool(o: Obj, key: string, where: string): boolean | undefined {
    const v = o[key];
    if (v === undefined) return undefined;
    return typeof v === 'boolean' ? v : this.fail(`${where}.${key}`, 'expected true or false');
  }

  time(o: Obj, key: string, where: string, required: boolean): TimeRef | undefined {
    const v = o[key];
    if (v === undefined) return required ? this.fail(`${where}.${key}`, 'is required') : undefined;
    if (typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))) return v;
    return this.fail(`${where}.${key}`, 'expected a number of seconds or an anchor string');
  }

  /** A media source: any string, except that `asset:` must be followed by an asset id. */
  source(o: Obj, key: string, where: string, required: boolean): string | undefined {
    const v = this.str(o, key, where, required);
    if (v === undefined) return v;
    return this.sourceValue(v, `${where}.${key}`);
  }

  sourceValue(v: string, where: string): string | undefined {
    if (!v.startsWith(ASSET_PREFIX) || ASSET_ID_PATTERN.test(v.slice(ASSET_PREFIX.length))) return v;
    this.errors.push({ code: 'bad-value', field: where, message: `${where}: expected "asset:" and an asset id of letters, digits, "_" and "-" (got ${JSON.stringify(v)})` });
    return undefined;
  }

  /** One of a fixed set of strings. */
  choice<T extends string>(o: Obj, key: string, where: string, options: readonly T[]): T | undefined {
    const v = o[key];
    if (v === undefined) return undefined;
    if (typeof v === 'string' && (options as readonly string[]).includes(v)) return v as T;
    return this.fail(`${where}.${key}`, `expected ${options.map((x) => `"${x}"`).join(' or ')}`);
  }

  /** A number that must also pass `ok`, else a `bad-value` error that says what it should be. */
  ranged(o: Obj, key: string, where: string, required: boolean, ok: (n: number) => boolean, should: string): number | undefined {
    const v = this.num(o, key, where, required);
    if (v === undefined || ok(v)) return v;
    this.errors.push({ code: 'bad-value', field: `${where}.${key}`, message: `${where}.${key}: ${should} (got ${v})` });
    return undefined;
  }
}

const positive = (n: number): boolean => n > 0;
const unit = (n: number): boolean => n >= 0 && n <= 1;
const nonNegative = (n: number): boolean => n >= 0;

/** Copies only the defined entries, so optional fields stay absent rather than `undefined`. */
function defined<T extends object>(value: T): T {
  const out: Obj = {};
  for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = v;
  return out as T;
}

function readMeta(r: Reader, value: unknown): CutMeta | undefined {
  const o = r.obj(value, 'meta');
  if (!o) return undefined;
  const title = r.str(o, 'title', 'meta', true);
  const fps = r.num(o, 'fps', 'meta', true);
  const width = r.num(o, 'width', 'meta', true);
  const height = r.num(o, 'height', 'meta', true);
  if (title === undefined || fps === undefined || width === undefined || height === undefined) return undefined;
  return defined({
    title,
    show: r.str(o, 'show', 'meta', false),
    version: r.str(o, 'version', 'meta', false),
    length: r.num(o, 'length', 'meta', false),
    fps,
    width,
    height,
    notes: r.str(o, 'notes', 'meta', false),
  });
}

function readMedia(r: Reader, value: unknown): MediaRoots | undefined {
  const o = r.obj(value, 'media');
  if (!o) return undefined;
  const root = r.str(o, 'root', 'media', true);
  if (root === undefined) return undefined;
  return defined({ root, takes: r.str(o, 'takes', 'media', false) });
}

function readCrop(r: Reader, value: unknown, where: string): Crop | undefined {
  if (value === undefined) return undefined;
  const o = r.obj(value, where);
  if (!o) return undefined;
  const x = r.num(o, 'x', where, true);
  const y = r.num(o, 'y', where, true);
  const width = r.num(o, 'width', where, true);
  const height = r.num(o, 'height', where, true);
  if (x === undefined || y === undefined || width === undefined || height === undefined) return undefined;
  return { x, y, width, height };
}

function readSegmentAudio(r: Reader, value: unknown, where: string): SegmentAudio | false | undefined {
  if (value === undefined) return undefined;
  if (value === false) return false;
  const o = r.obj(value, where);
  if (!o) return undefined;
  if (o.src !== undefined && o.synth !== undefined) return r.conflict(undefined, `${where}.synth`, 'give a src or a synth, not both');
  return defined({
    src: r.source(o, 'src', where, false),
    synth: readSynth(r, o.synth, `${where}.synth`),
    in: r.seconds(o, 'in', where, false),
    out: r.seconds(o, 'out', where, false),
    volume: r.num(o, 'volume', where, false),
    fadeIn: r.num(o, 'fadeIn', where, false),
    fadeOut: r.num(o, 'fadeOut', where, false),
  });
}

function readSegmentMix(r: Reader, value: unknown, where: string): SegmentMix | undefined {
  if (value === undefined) return undefined;
  const o = r.obj(value, where);
  if (!o) return undefined;
  return defined({
    fadeIn: r.ranged(o, 'fadeIn', where, false, nonNegative, 'expected a fade of 0 s or more'),
    fadeOut: r.ranged(o, 'fadeOut', where, false, nonNegative, 'expected a fade of 0 s or more'),
  });
}

function readFocus(r: Reader, value: unknown, where: string): FocusPoint | undefined {
  if (value === undefined) return undefined;
  const o = r.obj(value, where);
  if (!o) return undefined;
  const unitKind = r.choice(o, 'unit', where, ['px', 'fraction'] as const);
  const check = unitKind === 'fraction' ? unit : (n: number) => n >= 0;
  const should = unitKind === 'fraction' ? 'expected a fraction from 0 to 1' : "expected a pixel position, 0 or more";
  const x = r.ranged(o, 'x', where, true, check, should);
  const y = r.ranged(o, 'y', where, true, check, should);
  if (x === undefined || y === undefined) return undefined;
  return defined({ x, y, unit: unitKind });
}

function readZoom(r: Reader, value: unknown, where: string): Zoom | undefined {
  if (value === undefined) return undefined;
  const o = r.obj(value, where);
  if (!o) return undefined;
  const focus = readFocus(r, o.focus, `${where}.focus`);
  const list = r.list(o, 'keys', where, true);
  if (!list) return undefined;
  if (list.length === 0) return r.fail(`${where}.keys`, 'needs at least one key');
  const keys: ZoomKey[] = [];
  list.forEach((item, i) => {
    const k = r.obj(item, `${where}.keys[${i}]`);
    if (!k) return;
    const at = r.time(k, 'at', `${where}.keys[${i}]`, true);
    const scale = r.ranged(k, 'scale', `${where}.keys[${i}]`, true, (n) => n >= 1, 'expected a scale of 1 or more (1 is the picture as framed)');
    if (at !== undefined && scale !== undefined) keys.push({ at, scale });
  });
  return defined({ focus, keys });
}

/** One audio filter, or a limiter when `limiter` is allowed (the whole mix). */
function readFilter(r: Reader, item: unknown, at: string, limiter: boolean): MixFilter | undefined {
  const f = r.obj(item, at);
  if (!f) return undefined;
  const kind = f.kind;
  if (kind === 'highpass' || kind === 'lowpass') {
    const frequency = r.ranged(f, 'frequency', at, true, positive, 'expected a frequency in Hz above 0');
    return frequency === undefined ? undefined : { kind, frequency };
  }
  if (kind === 'crush') {
    const bits = r.ranged(f, 'bits', at, true, (n) => n >= 1 && n <= 64, 'expected a bit depth from 1 to 64');
    const mix = r.ranged(f, 'mix', at, false, unit, 'expected a mix from 0 to 1');
    return bits === undefined ? undefined : defined({ kind: 'crush' as const, bits, mix });
  }
  if (kind === 'echo') {
    const inGain = r.ranged(f, 'inGain', at, true, unit, 'expected a gain from 0 to 1');
    const outGain = r.ranged(f, 'outGain', at, true, unit, 'expected a gain from 0 to 1');
    const delay = r.ranged(f, 'delay', at, true, positive, 'expected a delay in seconds above 0');
    const decay = r.ranged(f, 'decay', at, true, unit, 'expected a decay from 0 to 1');
    if (inGain === undefined || outGain === undefined || delay === undefined || decay === undefined) return undefined;
    return { kind, inGain, outGain, delay, decay };
  }
  if (kind === 'limiter' && limiter) {
    const limit = r.ranged(f, 'limit', at, true, (n) => n > 0 && n <= 1, 'expected a limit above 0 and up to 1 (of full scale)');
    return limit === undefined ? undefined : { kind, limit };
  }
  return r.fail(`${at}.kind`, `expected "highpass", "lowpass", "crush"${limiter ? ', "echo" or "limiter"' : ' or "echo"'}`);
}

function readFilters(r: Reader, o: Obj, where: string): AudioFilter[] | undefined {
  const list = r.list(o, 'filters', where, false);
  if (!list) return undefined;
  const filters: AudioFilter[] = [];
  list.forEach((item, i) => {
    const filter = readFilter(r, item, `${where}.filters[${i}]`, false);
    if (filter && filter.kind !== 'limiter') filters.push(filter);
  });
  return filters;
}

/** A fade: seconds, or `{ duration, start }` (in) / `{ duration, end }` (out) timed to an anchor. */
function readFade(r: Reader, o: Obj, key: 'fadeIn', where: string): number | AnchoredFadeIn | undefined;
function readFade(r: Reader, o: Obj, key: 'fadeOut', where: string): number | AnchoredFadeOut | undefined;
function readFade(r: Reader, o: Obj, key: 'fadeIn' | 'fadeOut', where: string): number | AnchoredFadeIn | AnchoredFadeOut | undefined {
  const v = o[key];
  if (v === undefined || typeof v === 'number') return r.num(o, key, where, false);
  const f = r.obj(v, `${where}.${key}`);
  if (!f) return undefined;
  const point = key === 'fadeIn' ? 'start' : 'end';
  const duration = r.ranged(f, 'duration', `${where}.${key}`, true, nonNegative, 'expected a fade of 0 s or more');
  const at = r.time(f, point, `${where}.${key}`, true);
  if (duration === undefined || at === undefined) return undefined;
  return key === 'fadeIn' ? { duration, start: at } : { duration, end: at };
}

function readSegment(r: Reader, value: unknown, where: string): Segment | undefined {
  const o = r.obj(value, where);
  if (!o) return undefined;
  const id = r.str(o, 'id', where, true);
  const src = r.source(o, 'src', where, true);
  const still = r.bool(o, 'still', where);
  const common = {
    label: r.str(o, 'label', where, false),
    at: r.time(o, 'at', where, false),
    end: r.time(o, 'end', where, false),
    crop: readCrop(r, o.crop, `${where}.crop`),
    fadeIn: r.num(o, 'fadeIn', where, false),
    fadeOut: r.num(o, 'fadeOut', where, false),
    audio: readSegmentAudio(r, o.audio, `${where}.audio`),
    zoom: readZoom(r, o.zoom, `${where}.zoom`),
    mix: readSegmentMix(r, o.mix, `${where}.mix`),
  };
  if (still === true) {
    const shotFields = ['in', 'out', 'hold', 'loop'].filter((k) => o[k] !== undefined);
    const duration = r.seconds(o, 'duration', where, false, positive, 'expected a length above 0');
    if (id === undefined || src === undefined) return undefined;
    if (shotFields.length > 0) {
      return r.conflict(id, `${where}.${shotFields[0]}`, `a still has no ${shotFields.join(', ')}; give it a duration or an end`);
    }
    return defined({ id, src, still: true as const, duration, ...common });
  }
  const inPoint = r.seconds(o, 'in', where, true);
  const out = r.seconds(o, 'out', where, true);
  const loop = o.loop;
  if (loop !== undefined && loop !== 'pingpong') r.fail(`${where}.loop`, 'expected "pingpong"');
  const hold = r.seconds(o, 'hold', where, false);
  const duration = r.seconds(o, 'duration', where, false);
  if (id === undefined || src === undefined || inPoint === undefined || out === undefined) return undefined;
  return defined({
    id,
    src,
    ...(still === false ? { still: false as const } : {}),
    in: inPoint,
    out,
    hold,
    duration,
    loop: loop === 'pingpong' ? ('pingpong' as const) : undefined,
    ...common,
  });
}

function readWords(r: Reader, o: Obj, where: string): Word[] | undefined {
  const list = r.list(o, 'words', where, false);
  if (!list) return undefined;
  const words: Word[] = [];
  list.forEach((item, i) => {
    const w = r.obj(item, `${where}.words[${i}]`);
    if (!w) return;
    const text = r.str(w, 'text', `${where}.words[${i}]`, true);
    const start = r.num(w, 'start', `${where}.words[${i}]`, true);
    const end = r.num(w, 'end', `${where}.words[${i}]`, true);
    if (text !== undefined && start !== undefined && end !== undefined) words.push({ text, start, end });
  });
  return words;
}

function readLine(r: Reader, value: unknown, where: string): Line | undefined {
  const o = r.obj(value, where);
  if (!o) return undefined;
  const id = r.str(o, 'id', where, true);
  const speaker = r.str(o, 'speaker', where, true);
  const text = r.str(o, 'text', where, true);
  const src = r.source(o, 'src', where, false);
  const segment = r.str(o, 'segment', where, false);
  const clip = r.str(o, 'clip', where, false);
  const until = r.time(o, 'until', where, false);
  const sung = r.bool(o, 'sung', where);
  const delivery = r.str(o, 'delivery', where, false);
  const words = readWords(r, o, where);
  if (id === undefined || speaker === undefined || text === undefined) return undefined;
  const carriers = [src, segment, clip].filter((x) => x !== undefined).length;
  if (carriers !== 1) {
    return r.conflict(id, `${where}.src`, 'a line needs exactly one of "src" (its own sound), "segment" or "clip" (heard in theirs)');
  }
  const base = { id, speaker, text, until, sung, delivery, words };
  if (segment !== undefined || clip !== undefined) {
    const allowed = segment !== undefined ? ['at'] : ['in', 'out'];
    const own = ['at', 'in', 'out', 'duration', 'volume', 'filters', 'fadeIn', 'fadeOut', 'layer'].filter((k) => o[k] !== undefined && !allowed.includes(k));
    if (own.length > 0) {
      const heard = segment !== undefined ? "in the segment's sound" : "in the clip's sound";
      return r.conflict(id, `${where}.${own[0]}`, `a line heard ${heard} adds no sound, so it can't have ${own.join(', ')}; give it a "src" to carry its own sound`);
    }
    if (segment !== undefined) return defined({ ...base, segment, at: r.time(o, 'at', where, false) });
    if (clip === undefined) return undefined;
    return defined({ ...base, clip, in: r.seconds(o, 'in', where, false, nonNegative, 'expected a source time, 0 or more'), out: r.seconds(o, 'out', where, false) });
  }
  const at = r.time(o, 'at', where, true);
  if (src === undefined || at === undefined) return undefined;
  return defined({
    ...base,
    src,
    at,
    in: r.seconds(o, 'in', where, false, nonNegative, 'expected a source time, 0 or more'),
    out: r.seconds(o, 'out', where, false),
    duration: r.seconds(o, 'duration', where, false),
    volume: r.num(o, 'volume', where, false),
    filters: readFilters(r, o, where),
    fadeIn: readFade(r, o, 'fadeIn', where),
    fadeOut: readFade(r, o, 'fadeOut', where),
    layer: r.str(o, 'layer', where, false),
  });
}

function readSynth(r: Reader, value: unknown, where: string): Synth | undefined {
  if (value === undefined) return undefined;
  const o = r.obj(value, where);
  if (!o) return undefined;
  if (o.kind === 'tone') {
    const frequency = r.ranged(o, 'frequency', where, true, positive, 'expected a frequency in Hz above 0');
    const gain = r.ranged(o, 'gain', where, true, unit, 'expected a gain from 0 to 1');
    if (frequency === undefined || gain === undefined) return undefined;
    return { kind: 'tone', frequency, gain };
  }
  if (o.kind !== 'tick') return r.fail(`${where}.kind`, 'expected "tick" or "tone"');
  const period = r.num(o, 'period', where, true);
  const click = r.num(o, 'click', where, true);
  const decay = r.num(o, 'decay', where, true);
  const gain = r.num(o, 'gain', where, true);
  const tonesRaw = r.list(o, 'tones', where, true);
  const tones = tonesRaw?.filter((t): t is number => typeof t === 'number');
  if (tonesRaw && tones && tones.length !== tonesRaw.length) r.fail(`${where}.tones`, 'expected numbers');
  if (period === undefined || click === undefined || decay === undefined || gain === undefined || !tones) return undefined;
  return { kind: 'tick', period, tones, click, decay, gain };
}

/** A constant or a list of `{ at, value }` keyframes, under `key` (`volume`, `opacity`). */
function readKeyed(r: Reader, o: Obj, key: string, where: string, ok: (n: number) => boolean = () => true, should = ''): number | VolumeKey[] | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v === 'number') return r.ranged(o, key, where, false, ok, should);
  if (!Array.isArray(v)) return r.fail(`${where}.${key}`, 'expected a number or an array of keyframes');
  const keys: VolumeKey[] = [];
  v.forEach((item, i) => {
    const k = r.obj(item, `${where}.${key}[${i}]`);
    if (!k) return;
    const at = r.time(k, 'at', `${where}.${key}[${i}]`, true);
    const value = r.ranged(k, 'value', `${where}.${key}[${i}]`, true, ok, should);
    if (at !== undefined && value !== undefined) keys.push({ at, value });
  });
  return keys;
}

function readVolume(r: Reader, o: Obj, where: string): number | VolumeKey[] | undefined {
  return readKeyed(r, o, 'volume', where);
}

function readParts(r: Reader, o: Obj, where: string): BedPart[] | undefined {
  const list = r.list(o, 'parts', where, false);
  if (!list) return undefined;
  if (list.length === 0) return r.fail(`${where}.parts`, 'needs at least one part');
  const parts: BedPart[] = [];
  list.forEach((item, i) => {
    const at = `${where}.parts[${i}]`;
    const p = r.obj(item, at);
    if (!p) return;
    const src = r.source(p, 'src', at, true);
    const crossfade = r.ranged(p, 'crossfade', at, false, nonNegative, 'expected a crossfade of 0 s or more');
    if (i === 0 && crossfade !== undefined && crossfade > 0) r.fail(`${at}.crossfade`, 'the first part has nothing to cross-fade from');
    if (src === undefined) return;
    parts.push(defined({
      src,
      in: r.seconds(p, 'in', at, false, nonNegative, 'expected a source time, 0 or more'),
      out: r.seconds(p, 'out', at, false),
      duration: r.seconds(p, 'duration', at, false, positive, 'expected a length above 0'),
      crossfade,
    }));
  });
  return parts;
}

function readSync(r: Reader, value: unknown, where: string): AudioSync | undefined {
  if (value === undefined) return undefined;
  const o = r.obj(value, where);
  if (!o) return undefined;
  const source = r.seconds(o, 'source', where, true, nonNegative, 'expected a time in the source, 0 or more');
  const at = r.time(o, 'at', where, true);
  if (source === undefined || at === undefined) return undefined;
  return { source, at };
}

function readAudioClip(r: Reader, value: unknown, where: string): AudioClip | undefined {
  const o = r.obj(value, where);
  if (!o) return undefined;
  const id = r.str(o, 'id', where, true);
  const src = r.source(o, 'src', where, false);
  const synth = readSynth(r, o.synth, `${where}.synth`);
  const parts = readParts(r, o, where);
  const segment = r.str(o, 'segment', where, false);
  const sync = readSync(r, o.sync, `${where}.sync`);
  const at = r.time(o, 'at', where, false);
  if (id === undefined) return undefined;
  const sounds = (['src', 'synth', 'parts', 'segment'] as const).filter((k) => o[k] !== undefined);
  if (sounds.length !== 1) {
    return r.conflict(id, `${where}.src`, 'needs exactly one of "src", "synth", "parts" (a bed) or "segment" (sound heard in a segment)');
  }
  if (segment !== undefined) {
    const own = ['in', 'out', 'duration', 'sync', 'volume', 'fadeIn', 'fadeOut', 'filters', 'layer'].filter((k) => o[k] !== undefined);
    if (own.length > 0) {
      return r.conflict(id, `${where}.${own[0]}`, `sound heard in a segment's own audio adds none, so it can't have ${own.join(', ')}`);
    }
  }
  if (sync !== undefined && at !== undefined && o.in !== undefined) {
    return r.conflict(id, `${where}.sync`, 'a sync point places the clip from its at or its in, so give one of them, not both');
  }
  if (at === undefined && segment === undefined && !(sync !== undefined && o.in !== undefined)) {
    return r.fail(`${where}.at`, 'is required (unless the clip is in a segment, or placed by its sync and in)');
  }
  return defined({
    id,
    label: r.str(o, 'label', where, false),
    src,
    synth,
    parts,
    segment,
    in: r.seconds(o, 'in', where, false),
    out: r.seconds(o, 'out', where, false),
    at,
    until: r.time(o, 'until', where, false),
    duration: r.seconds(o, 'duration', where, false),
    sync,
    volume: readVolume(r, o, where),
    fadeIn: readFade(r, o, 'fadeIn', where),
    fadeOut: readFade(r, o, 'fadeOut', where),
    filters: readFilters(r, o, where),
    layer: r.str(o, 'layer', where, false),
  });
}

function readBlink(r: Reader, value: unknown, where: string): Blink | undefined {
  if (value === undefined) return undefined;
  const o = r.obj(value, where);
  if (!o) return undefined;
  const period = r.num(o, 'period', where, true);
  const on = r.num(o, 'on', where, true);
  if (period === undefined || on === undefined) return undefined;
  return { period, on };
}

function readWave(r: Reader, value: unknown, where: string): Wave | undefined {
  if (value === undefined) return undefined;
  const o = r.obj(value, where);
  if (!o) return undefined;
  const shape = r.choice(o, 'shape', where, ['sin', 'cos'] as const);
  const center = r.num(o, 'center', where, true);
  const amplitude = r.num(o, 'amplitude', where, true);
  const period = r.ranged(o, 'period', where, true, positive, 'expected a period in seconds above 0');
  const phase = r.num(o, 'phase', where, false);
  if (center === undefined || amplitude === undefined || period === undefined) return undefined;
  return defined({ shape, center, amplitude, period, phase });
}

function readWaves(r: Reader, value: unknown, where: string): Overlay['wave'] {
  if (value === undefined) return undefined;
  const o = r.obj(value, where);
  if (!o) return undefined;
  for (const key of Object.keys(o)) if (key !== 'x' && key !== 'y') r.fail(`${where}.${key}`, 'expected only "x" or "y"');
  return defined({ x: readWave(r, o.x, `${where}.x`), y: readWave(r, o.y, `${where}.y`) });
}

function readOverlay(r: Reader, value: unknown, where: string): Overlay | undefined {
  const o = r.obj(value, where);
  if (!o) return undefined;
  const id = r.str(o, 'id', where, true);
  const src = r.source(o, 'src', where, true);
  const segment = r.str(o, 'segment', where, false);
  // An overlay in a segment starts with it unless told otherwise.
  const at = r.time(o, 'at', where, o.segment === undefined);
  let motion: MotionKey[] | undefined;
  const motionRaw = r.list(o, 'motion', where, false);
  if (motionRaw) {
    motion = [];
    for (const [i, item] of motionRaw.entries()) {
      const k = r.obj(item, `${where}.motion[${i}]`);
      if (!k) continue;
      const kAt = r.time(k, 'at', `${where}.motion[${i}]`, true);
      if (kAt !== undefined) {
        motion.push(defined({ at: kAt, x: r.num(k, 'x', `${where}.motion[${i}]`, false), y: r.num(k, 'y', `${where}.motion[${i}]`, false) }));
      }
    }
  }
  const wave = readWaves(r, o.wave, `${where}.wave`);
  const opacity = readKeyed(r, o, 'opacity', where, unit, 'expected an opacity from 0 to 1');
  if (id === undefined || src === undefined || (at === undefined && segment === undefined)) return undefined;
  return defined({
    id,
    label: r.str(o, 'label', where, false),
    src,
    segment,
    at,
    until: r.time(o, 'until', where, false),
    duration: r.seconds(o, 'duration', where, false),
    x: r.num(o, 'x', where, false),
    y: r.num(o, 'y', where, false),
    width: r.ranged(o, 'width', where, false, positive, 'expected a width in pixels above 0'),
    height: r.ranged(o, 'height', where, false, positive, 'expected a height in pixels above 0'),
    motion,
    wave,
    opacity,
    fadeIn: r.num(o, 'fadeIn', where, false),
    fadeOut: r.num(o, 'fadeOut', where, false),
    blink: readBlink(r, o.blink, `${where}.blink`),
  });
}

function readOffset(r: Reader, value: unknown, where: string): Offset | undefined {
  if (value === undefined) return undefined;
  const o = r.obj(value, where);
  if (!o) return undefined;
  return defined({ x: r.num(o, 'x', where, false), y: r.num(o, 'y', where, false) });
}

function readShift(r: Reader, value: unknown, where: string): ColorShift | undefined {
  if (value === undefined) return undefined;
  const o = r.obj(value, where);
  if (!o) return undefined;
  const shift = (n: number) => n >= -1 && n <= 1;
  const should = 'expected a shift from -1 to 1';
  return defined({ r: r.ranged(o, 'r', where, false, shift, should), g: r.ranged(o, 'g', where, false, shift, should), b: r.ranged(o, 'b', where, false, shift, should) });
}

function readPictureFilter(r: Reader, item: unknown, at: string): PictureFilter | undefined {
  const f = r.obj(item, at);
  if (!f) return undefined;
  switch (f.kind) {
    case 'rescale': {
      const width = r.ranged(f, 'width', at, true, positive, 'expected a width in pixels above 0');
      const height = r.ranged(f, 'height', at, true, positive, 'expected a height in pixels above 0');
      return width === undefined || height === undefined ? undefined : { kind: 'rescale', width, height };
    }
    case 'chroma-shift':
      return defined({ kind: 'chroma-shift' as const, cb: readOffset(r, f.cb, `${at}.cb`), cr: readOffset(r, f.cr, `${at}.cr`) });
    case 'color':
      return defined({
        kind: 'color' as const,
        saturation: r.ranged(f, 'saturation', at, false, nonNegative, 'expected a saturation of 0 or more (1 is unchanged)'),
        contrast: r.ranged(f, 'contrast', at, false, nonNegative, 'expected a contrast of 0 or more (1 is unchanged)'),
        gamma: r.ranged(f, 'gamma', at, false, positive, 'expected a gamma above 0 (1 is unchanged)'),
        brightness: r.ranged(f, 'brightness', at, false, (n) => n >= -1 && n <= 1, 'expected a brightness from -1 to 1 (0 is unchanged)'),
      });
    case 'color-balance':
      return defined({
        kind: 'color-balance' as const,
        shadows: readShift(r, f.shadows, `${at}.shadows`),
        midtones: readShift(r, f.midtones, `${at}.midtones`),
        highlights: readShift(r, f.highlights, `${at}.highlights`),
      });
    case 'grain': {
      const strength = r.ranged(f, 'strength', at, true, (n) => n >= 0 && n <= 100, 'expected a strength from 0 to 100');
      return strength === undefined ? undefined : defined({ kind: 'grain' as const, strength, moving: r.bool(f, 'moving', at) });
    }
    default:
      return r.fail(`${at}.kind`, 'expected "rescale", "chroma-shift", "color", "color-balance" or "grain"');
  }
}

function readPicture(r: Reader, value: unknown): PictureSettings | undefined {
  if (value === undefined) return undefined;
  const o = r.obj(value, 'picture');
  if (!o) return undefined;
  let filters: PictureFilter[] | undefined;
  const list = r.list(o, 'filters', 'picture', false);
  if (list) {
    filters = [];
    list.forEach((item, i) => {
      const filter = readPictureFilter(r, item, `picture.filters[${i}]`);
      if (filter) filters?.push(filter);
    });
  }
  return defined({ fadeIn: r.num(o, 'fadeIn', 'picture', false), fadeOut: r.num(o, 'fadeOut', 'picture', false), filters });
}

function readMix(r: Reader, value: unknown): MixSettings | undefined {
  if (value === undefined) return undefined;
  const o = r.obj(value, 'mix');
  if (!o) return undefined;
  const list = r.list(o, 'filters', 'mix', false);
  if (!list) return {};
  const filters: MixFilter[] = [];
  list.forEach((item, i) => {
    const filter = readFilter(r, item, `mix.filters[${i}]`, true);
    if (filter) filters.push(filter);
  });
  return { filters };
}

function readSources(r: Reader, value: unknown): Record<string, SourceProvenance> | undefined {
  if (value === undefined) return undefined;
  const o = r.obj(value, 'sources');
  if (!o) return undefined;
  const out: Record<string, SourceProvenance> = {};
  for (const [ref, entry] of Object.entries(o)) {
    const where = `sources[${JSON.stringify(ref)}]`;
    if (r.sourceValue(ref, where) === undefined) continue;
    const e = r.obj(entry, where);
    if (!e) continue;
    out[ref] = defined({
      step: r.choice(e, 'step', where, ['generate', 'extend', 'compose', 'swap'] as const),
      extendedFrom: r.source(e, 'extendedFrom', where, false),
      swappedFrom: r.source(e, 'swappedFrom', where, false),
      voice: r.str(e, 'voice', where, false),
      storyboard: r.str(e, 'storyboard', where, false),
      firstFrame: r.source(e, 'firstFrame', where, false),
      notes: r.str(e, 'notes', where, false),
    });
  }
  return out;
}

const THRESHOLD_KEYS = ['loudness', 'pitch', 'rate', 'pause', 'roomTone', 'word'] as const;

function readThresholds(r: Reader, value: unknown, where: string): CheckThresholds | undefined {
  if (value === undefined) return undefined;
  const o = r.obj(value, where);
  if (!o) return undefined;
  for (const key of Object.keys(o)) {
    if (!(THRESHOLD_KEYS as readonly string[]).includes(key)) r.fail(`${where}.${key}`, `isn't a threshold; use ${THRESHOLD_KEYS.join(', ')}`);
  }
  const out: CheckThresholds = {};
  for (const key of THRESHOLD_KEYS) {
    const v = r.ranged(o, key, where, false, positive, 'expected a number above 0');
    if (v !== undefined) out[key] = v;
  }
  return out;
}

function readCheck(r: Reader, value: unknown): CheckSettings | undefined {
  if (value === undefined) return undefined;
  const o = r.obj(value, 'check');
  if (!o) return undefined;
  return defined({ thresholds: readThresholds(r, o.thresholds, 'check.thresholds') });
}

function readPerformance(r: Reader, value: unknown, where: string): Performance | undefined {
  const o = r.obj(value, where);
  if (!o) return undefined;
  const id = r.str(o, 'id', where, true);
  const raw = r.list(o, 'lines', where, true);
  let lines: string[] | undefined;
  if (raw) {
    lines = raw.filter((x): x is string => typeof x === 'string');
    if (lines.length !== raw.length) r.fail(`${where}.lines`, 'expected line ids');
    else if (lines.length === 0) r.fail(`${where}.lines`, 'expected at least one line id');
  }
  const performance = defined({
    id,
    label: r.str(o, 'label', where, false),
    lines,
    intent: r.str(o, 'intent', where, false),
    delivery: r.str(o, 'delivery', where, false),
    thresholds: readThresholds(r, o.thresholds, `${where}.thresholds`),
  });
  if (performance.id === undefined || performance.lines === undefined) return undefined;
  return { ...performance, id: performance.id, lines: performance.lines };
}

function readItems<T>(r: Reader, o: Obj, key: string, required: boolean, read: (r: Reader, v: unknown, where: string) => T | undefined): T[] | undefined {
  const list = r.list(o, key, 'cut', required);
  if (!list) return undefined;
  const out: T[] = [];
  list.forEach((v, i) => {
    const item = read(r, v, `${key}[${i}]`);
    if (item !== undefined) out.push(item);
  });
  return out;
}

/**
 * Checks that parsed JSON has the cut file's shape and returns it typed.
 * Timing problems (anchors, cycles, lengths) are found by `resolveCut`.
 */
export function parseCut(json: unknown): CutResult<CutFile> {
  const r = new Reader();
  const o = r.obj(json, 'cut');
  if (!o) return { ok: false, errors: r.errors };
  if (o.extends !== undefined) {
    r.fail('extends', `this cut extends ${JSON.stringify(o.extends)}: load it with loadCutSource (or readCutFile), which merges in its base`);
    return { ok: false, errors: r.errors };
  }
  if (o.format !== CUT_FORMAT) r.fail('format', `expected "${CUT_FORMAT}"`);
  const meta = readMeta(r, o.meta);
  const media = readMedia(r, o.media);
  const segments = readItems(r, o, 'segments', true, readSegment);
  const cut = defined({
    format: CUT_FORMAT,
    meta,
    media,
    output: r.str(o, 'output', 'cut', false),
    segments,
    lines: readItems(r, o, 'lines', false, readLine),
    music: readItems(r, o, 'music', false, readAudioClip),
    sfx: readItems(r, o, 'sfx', false, readAudioClip),
    overlays: readItems(r, o, 'overlays', false, readOverlay),
    picture: readPicture(r, o.picture),
    mix: readMix(r, o.mix),
    sources: readSources(r, o.sources),
    performances: readItems(r, o, 'performances', false, readPerformance),
    check: readCheck(r, o.check),
  });
  if (r.errors.length > 0 || !cut.meta || !cut.media || !cut.segments) return { ok: false, errors: r.errors };
  return { ok: true, value: { ...cut, format: CUT_FORMAT, meta: cut.meta, media: cut.media, segments: cut.segments } };
}

/** Whether parsed JSON is a cut that extends another (it has an `extends`). */
export function isCutExtension(json: unknown): boolean {
  return isObj(json) && json.extends !== undefined;
}

function readMetaPatch(r: Reader, value: unknown): Partial<CutMeta> | undefined {
  if (value === undefined) return undefined;
  const o = r.obj(value, 'meta');
  if (!o) return undefined;
  return defined({
    title: r.str(o, 'title', 'meta', false),
    show: r.str(o, 'show', 'meta', false),
    version: r.str(o, 'version', 'meta', false),
    length: r.num(o, 'length', 'meta', false),
    fps: r.num(o, 'fps', 'meta', false),
    width: r.num(o, 'width', 'meta', false),
    height: r.num(o, 'height', 'meta', false),
    notes: r.str(o, 'notes', 'meta', false),
  });
}

function readMediaPatch(r: Reader, value: unknown): Partial<MediaRoots> | undefined {
  if (value === undefined) return undefined;
  const o = r.obj(value, 'media');
  if (!o) return undefined;
  return defined({ root: r.str(o, 'root', 'media', false), takes: r.str(o, 'takes', 'media', false) });
}

function readExtensionSegment(r: Reader, value: unknown, where: string): ExtensionSegment | undefined {
  const segment = readSegment(r, value, where);
  if (!segment || !isObj(value)) return segment;
  const after = r.str(value, 'after', where, false);
  return after === undefined ? segment : { ...segment, after };
}

/**
 * Checks that parsed JSON is a cut extension: `extends` names its base, and
 * every other field is optional. Items in its lists are whole items, checked
 * as in `parseCut`. `extendCut` merges it onto its base.
 */
export function parseCutExtension(json: unknown): CutResult<CutExtension> {
  const r = new Reader();
  const o = r.obj(json, 'cut');
  if (!o) return { ok: false, errors: r.errors };
  if (o.format !== CUT_FORMAT) r.fail('format', `expected "${CUT_FORMAT}"`);
  const base = r.str(o, 'extends', 'cut', true);
  if (base !== undefined && !CUT_NAME_PATTERN.test(base)) {
    r.fail('extends', `expected the base cut's name, its file stem in the same folder, like "bellamy-ranch-take6" (got ${JSON.stringify(base)})`);
  }
  let remove: string[] | undefined;
  const removeRaw = r.list(o, 'remove', 'cut', false);
  if (removeRaw) {
    remove = removeRaw.filter((id): id is string => typeof id === 'string');
    if (remove.length !== removeRaw.length) r.fail('remove', 'expected item ids');
  }
  const extension = defined({
    format: CUT_FORMAT,
    extends: base,
    meta: readMetaPatch(r, o.meta),
    media: readMediaPatch(r, o.media),
    output: r.str(o, 'output', 'cut', false),
    segments: readItems(r, o, 'segments', false, readExtensionSegment),
    lines: readItems(r, o, 'lines', false, readLine),
    music: readItems(r, o, 'music', false, readAudioClip),
    sfx: readItems(r, o, 'sfx', false, readAudioClip),
    overlays: readItems(r, o, 'overlays', false, readOverlay),
    picture: readPicture(r, o.picture),
    mix: readMix(r, o.mix),
    sources: readSources(r, o.sources),
    performances: readItems(r, o, 'performances', false, readPerformance),
    check: readCheck(r, o.check),
    remove,
  });
  if (r.errors.length > 0 || extension.extends === undefined) return { ok: false, errors: r.errors };
  return { ok: true, value: { ...extension, format: CUT_FORMAT, extends: extension.extends } };
}
