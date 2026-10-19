import {
  CUT_FORMAT,
  type AudioClip,
  type AudioFilter,
  type Blink,
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
  type MotionKey,
  type Overlay,
  type PictureFades,
  type Segment,
  type SegmentAudio,
  type Synth,
  type TimeRef,
  type VolumeKey,
  type Wave,
  type Word,
  type Zoom,
  type ZoomKey,
} from './types.js';

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

  str(o: Obj, key: string, where: string, required: boolean): string | undefined {
    const v = o[key];
    if (v === undefined) return required ? this.fail(`${where}.${key}`, 'is required') : undefined;
    return typeof v === 'string' ? v : this.fail(`${where}.${key}`, 'expected a string');
  }

  time(o: Obj, key: string, where: string, required: boolean): TimeRef | undefined {
    const v = o[key];
    if (v === undefined) return required ? this.fail(`${where}.${key}`, 'is required') : undefined;
    if (typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))) return v;
    return this.fail(`${where}.${key}`, 'expected a number of seconds or an anchor string');
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
  return defined({
    src: r.str(o, 'src', where, false),
    in: r.num(o, 'in', where, false),
    out: r.num(o, 'out', where, false),
    volume: r.num(o, 'volume', where, false),
    fadeIn: r.num(o, 'fadeIn', where, false),
    fadeOut: r.num(o, 'fadeOut', where, false),
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

function readFilters(r: Reader, o: Obj, where: string): AudioFilter[] | undefined {
  const list = r.list(o, 'filters', where, false);
  if (!list) return undefined;
  const filters: AudioFilter[] = [];
  list.forEach((item, i) => {
    const at = `${where}.filters[${i}]`;
    const f = r.obj(item, at);
    if (!f) return;
    const kind = f.kind;
    if (kind === 'highpass' || kind === 'lowpass') {
      const frequency = r.ranged(f, 'frequency', at, true, positive, 'expected a frequency in Hz above 0');
      if (frequency !== undefined) filters.push({ kind, frequency });
    } else if (kind === 'crush') {
      const bits = r.ranged(f, 'bits', at, true, (n) => n >= 1 && n <= 64, 'expected a bit depth from 1 to 64');
      const mix = r.ranged(f, 'mix', at, false, unit, 'expected a mix from 0 to 1');
      if (bits !== undefined) filters.push(defined({ kind, bits, mix }));
    } else if (kind === 'echo') {
      const inGain = r.ranged(f, 'inGain', at, true, unit, 'expected a gain from 0 to 1');
      const outGain = r.ranged(f, 'outGain', at, true, unit, 'expected a gain from 0 to 1');
      const delay = r.ranged(f, 'delay', at, true, positive, 'expected a delay in seconds above 0');
      const decay = r.ranged(f, 'decay', at, true, unit, 'expected a decay from 0 to 1');
      if (inGain !== undefined && outGain !== undefined && delay !== undefined && decay !== undefined) {
        filters.push({ kind, inGain, outGain, delay, decay });
      }
    } else {
      r.fail(`${at}.kind`, 'expected "highpass", "lowpass", "crush" or "echo"');
    }
  });
  return filters;
}

function readSegment(r: Reader, value: unknown, where: string): Segment | undefined {
  const o = r.obj(value, where);
  if (!o) return undefined;
  const id = r.str(o, 'id', where, true);
  const src = r.str(o, 'src', where, true);
  const inPoint = r.num(o, 'in', where, true);
  const out = r.num(o, 'out', where, true);
  const loop = o.loop;
  if (loop !== undefined && loop !== 'pingpong') r.fail(`${where}.loop`, 'expected "pingpong"');
  if (id === undefined || src === undefined || inPoint === undefined || out === undefined) return undefined;
  return defined({
    id,
    label: r.str(o, 'label', where, false),
    src,
    in: inPoint,
    out,
    at: r.time(o, 'at', where, false),
    hold: r.num(o, 'hold', where, false),
    duration: r.num(o, 'duration', where, false),
    end: r.time(o, 'end', where, false),
    loop: loop === 'pingpong' ? ('pingpong' as const) : undefined,
    crop: readCrop(r, o.crop, `${where}.crop`),
    fadeIn: r.num(o, 'fadeIn', where, false),
    fadeOut: r.num(o, 'fadeOut', where, false),
    audio: readSegmentAudio(r, o.audio, `${where}.audio`),
    zoom: readZoom(r, o.zoom, `${where}.zoom`),
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
  const src = r.str(o, 'src', where, false);
  const segment = r.str(o, 'segment', where, false);
  const until = r.time(o, 'until', where, false);
  const words = readWords(r, o, where);
  if (id === undefined || speaker === undefined || text === undefined) return undefined;
  if ((src === undefined) === (segment === undefined)) {
    r.errors.push({ code: 'conflicting-fields', id, field: `${where}.src`, message: `${where}: a line needs exactly one of "src" or "segment"` });
    return undefined;
  }
  if (segment !== undefined) {
    const own = ['in', 'out', 'duration', 'volume', 'filters'].filter((k) => o[k] !== undefined);
    if (own.length > 0) {
      r.errors.push({
        code: 'conflicting-fields', id, field: `${where}.${own[0]}`,
        message: `${where}: a line from a segment is heard in the segment's sound, so it can't have ${own.join(', ')}; give it a "src" to carry its own sound`,
      });
      return undefined;
    }
    return defined({ id, speaker, text, segment, at: r.time(o, 'at', where, false), until, words });
  }
  const at = r.time(o, 'at', where, true);
  if (src === undefined || at === undefined) return undefined;
  return defined({
    id,
    speaker,
    text,
    src,
    at,
    in: r.ranged(o, 'in', where, false, (n) => n >= 0, 'expected a source time, 0 or more'),
    out: r.num(o, 'out', where, false),
    until,
    words,
    duration: r.num(o, 'duration', where, false),
    volume: r.num(o, 'volume', where, false),
    filters: readFilters(r, o, where),
  });
}

function readSynth(r: Reader, value: unknown, where: string): Synth | undefined {
  if (value === undefined) return undefined;
  const o = r.obj(value, where);
  if (!o) return undefined;
  if (o.kind !== 'tick') return r.fail(`${where}.kind`, 'expected "tick"');
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

function readAudioClip(r: Reader, value: unknown, where: string): AudioClip | undefined {
  const o = r.obj(value, where);
  if (!o) return undefined;
  const id = r.str(o, 'id', where, true);
  const at = r.time(o, 'at', where, true);
  const src = r.str(o, 'src', where, false);
  const synth = readSynth(r, o.synth, `${where}.synth`);
  if (id === undefined || at === undefined) return undefined;
  if ((src === undefined) === (o.synth === undefined)) {
    r.errors.push({ code: 'conflicting-fields', id, field: `${where}.src`, message: `${where}: needs exactly one of "src" or "synth"` });
    return undefined;
  }
  return defined({
    id,
    label: r.str(o, 'label', where, false),
    src,
    synth,
    in: r.num(o, 'in', where, false),
    out: r.num(o, 'out', where, false),
    at,
    until: r.time(o, 'until', where, false),
    duration: r.num(o, 'duration', where, false),
    volume: readVolume(r, o, where),
    fadeIn: r.num(o, 'fadeIn', where, false),
    fadeOut: r.num(o, 'fadeOut', where, false),
    filters: readFilters(r, o, where),
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
  const src = r.str(o, 'src', where, true);
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
    duration: r.num(o, 'duration', where, false),
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

function readPicture(r: Reader, value: unknown): PictureFades | undefined {
  if (value === undefined) return undefined;
  const o = r.obj(value, 'picture');
  if (!o) return undefined;
  return defined({ fadeIn: r.num(o, 'fadeIn', 'picture', false), fadeOut: r.num(o, 'fadeOut', 'picture', false) });
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
    remove,
  });
  if (r.errors.length > 0 || extension.extends === undefined) return { ok: false, errors: r.errors };
  return { ok: true, value: { ...extension, format: CUT_FORMAT, extends: extension.extends } };
}
