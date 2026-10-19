import {
  CUT_FORMAT,
  type AudioClip,
  type Blink,
  type Crop,
  type CutError,
  type CutFile,
  type CutMeta,
  type CutResult,
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
  type Word,
} from './types.js';

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
}

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
    until,
    words,
    duration: r.num(o, 'duration', where, false),
    volume: r.num(o, 'volume', where, false),
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

function readVolume(r: Reader, o: Obj, where: string): number | VolumeKey[] | undefined {
  const v = o.volume;
  if (v === undefined || typeof v === 'number') return v;
  if (!Array.isArray(v)) return r.fail(`${where}.volume`, 'expected a number or an array of keyframes');
  const keys: VolumeKey[] = [];
  v.forEach((item, i) => {
    const k = r.obj(item, `${where}.volume[${i}]`);
    if (!k) return;
    const at = r.time(k, 'at', `${where}.volume[${i}]`, true);
    const value = r.num(k, 'value', `${where}.volume[${i}]`, true);
    if (at !== undefined && value !== undefined) keys.push({ at, value });
  });
  return keys;
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

function readOverlay(r: Reader, value: unknown, where: string): Overlay | undefined {
  const o = r.obj(value, where);
  if (!o) return undefined;
  const id = r.str(o, 'id', where, true);
  const src = r.str(o, 'src', where, true);
  const at = r.time(o, 'at', where, true);
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
  if (id === undefined || src === undefined || at === undefined) return undefined;
  return defined({
    id,
    label: r.str(o, 'label', where, false),
    src,
    at,
    until: r.time(o, 'until', where, false),
    duration: r.num(o, 'duration', where, false),
    x: r.num(o, 'x', where, false),
    y: r.num(o, 'y', where, false),
    motion,
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
