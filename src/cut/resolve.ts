import { END_ANCHOR, ID_PATTERN, START_ANCHOR, parseTimeRef, type ParsedTime } from './anchor.js';
import type {
  AudioClip,
  CutError,
  CutFile,
  CutResult,
  Line,
  Overlay,
  ResolvedAudio,
  ResolvedKey,
  ResolvedLine,
  ResolvedMotionKey,
  ResolvedOverlay,
  ResolvedSegment,
  ResolvedSegmentAudio,
  ResolvedSource,
  SourceRef,
  Timeline,
  TimelineItem,
  TimeRef,
  Word,
} from './types.js';

export interface ResolveOptions {
  /** Overrides `media.root`, e.g. when the media has moved. */
  root?: string;
  /** The cut file's folder. A relative root is resolved against it. */
  cutDir?: string;
  /** The length in seconds of a take or file, if known (for example from ffprobe). */
  mediaLength?: (source: ResolvedSource) => number | undefined;
}

/** Times within this of each other are equal. */
const EPS = 1e-6;
const DEFAULT_TAKES = 'takes/{name}.mp4';

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

// ---------------------------------------------------------------------------
// Paths (kept free of node:path so a browser UI can use the resolver)

function isAbsolute(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path);
}

function normalize(path: string): string {
  const absolute = path.startsWith('/');
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..' && parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop();
    else parts.push(part);
  }
  return (absolute ? '/' : '') + parts.join('/');
}

function joinPath(base: string, rel: string): string {
  return isAbsolute(rel) ? normalize(rel) : normalize(`${base}/${rel}`);
}

// ---------------------------------------------------------------------------
// Time points

type Compute = (get: (key: string) => number | undefined) => number | undefined;

/**
 * Every item has two time points, `<id>.start` and `<id>.end`, plus `@end`.
 * Each point is computed on demand from the points it refers to; a point met
 * again while it is still being computed is a cycle.
 */
class TimeGraph {
  private readonly defs = new Map<string, Compute>();
  private readonly values = new Map<string, number | undefined>();
  private readonly stack: string[] = [];

  constructor(private readonly errors: CutError[]) {}

  define(key: string, compute: Compute): void {
    this.defs.set(key, compute);
  }

  keys(): string[] {
    return [...this.defs.keys()];
  }

  readonly get = (key: string): number | undefined => {
    if (this.values.has(key)) return this.values.get(key);
    const from = this.stack.indexOf(key);
    if (from >= 0) {
      const cycle = [...this.stack.slice(from), key];
      this.errors.push({
        code: 'cycle',
        id: key.split('.')[0],
        cycle,
        message: `Times refer to each other in a loop: ${cycle.join(' → ')}`,
      });
      return undefined;
    }
    const compute = this.defs.get(key);
    if (!compute) return undefined;
    this.stack.push(key);
    const raw = compute(this.get);
    this.stack.pop();
    const value = raw === undefined ? undefined : round(raw);
    this.values.set(key, value);
    return value;
  };
}

function add(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined || b === undefined ? undefined : a + b;
}

/** An item's end: its natural length from `start`, cut off at `until`. */
function clippedEnd(start: number | undefined, natural: number | undefined, until: number | undefined, hasUntil: boolean): number | undefined {
  if (start === undefined) return undefined;
  const naturalEnd = natural === undefined ? undefined : start + natural;
  if (!hasUntil) return naturalEnd;
  if (until === undefined) return undefined;
  return naturalEnd === undefined ? until : Math.min(naturalEnd, until);
}

// ---------------------------------------------------------------------------

type Kind = 'segment' | 'line' | 'music' | 'sfx' | 'overlay';

/**
 * Turns a cut file into a flat timeline with every item's absolute start and
 * end, and checks it. On any error it returns all the errors it found.
 */
export function resolveCut(cut: CutFile, options: ResolveOptions = {}): CutResult<Timeline> {
  const errors: CutError[] = [];
  const fail = (error: CutError): undefined => {
    errors.push(error);
    return undefined;
  };

  const lines = cut.lines ?? [];
  const music = cut.music ?? [];
  const sfx = cut.sfx ?? [];
  const overlays = cut.overlays ?? [];

  // Ids: one namespace for every item.
  const kinds = new Map<string, Kind>();
  const claim = (id: string, kind: Kind): void => {
    if (!ID_PATTERN.test(id)) {
      fail({ code: 'bad-id', id, message: `"${id}" isn't a valid id: use letters, digits and underscores` });
    } else if (kinds.has(id)) {
      fail({ code: 'duplicate-id', id, message: `The id "${id}" is used more than once` });
    } else {
      kinds.set(id, kind);
    }
  };
  cut.segments.forEach((s) => claim(s.id, 'segment'));
  lines.forEach((l) => claim(l.id, 'line'));
  music.forEach((m) => claim(m.id, 'music'));
  sfx.forEach((m) => claim(m.id, 'sfx'));
  overlays.forEach((o) => claim(o.id, 'overlay'));

  if (cut.segments.length === 0) fail({ code: 'no-segments', message: 'A cut needs at least one segment' });
  // Anchors can't be trusted until every id is unique and well formed.
  if (errors.length > 0) return { ok: false, errors };

  // Media.
  const configuredRoot = options.root ?? cut.media.root;
  const root = !isAbsolute(configuredRoot) && options.cutDir ? joinPath(options.cutDir, configuredRoot) : normalize(configuredRoot);
  const takes = cut.media.takes ?? DEFAULT_TAKES;
  const source = (ref: SourceRef): ResolvedSource => {
    if (ref.startsWith('take:')) {
      const name = ref.slice('take:'.length);
      return { kind: 'take', ref, name, path: joinPath(root, takes.replaceAll('{name}', name)) };
    }
    if (ref.startsWith('color:')) return { kind: 'color', ref, color: ref.slice('color:'.length) };
    return { kind: 'file', ref, path: joinPath(root, ref) };
  };
  const lengthOf = (src: ResolvedSource): number | undefined =>
    src.kind === 'take' || src.kind === 'file' ? options.mediaLength?.(src) : undefined;

  // Anchors are parsed once, up front, so each bad one is reported once.
  const anchor = (ref: TimeRef, id: string, field: string): ParsedTime | null => {
    const parsed = parseTimeRef(ref);
    if (!parsed) {
      fail({ code: 'bad-anchor', id, field, message: `${id}.${field}: "${String(ref)}" isn't a time or an anchor like "stun+0.4"` });
      return null;
    }
    if (parsed.kind === 'anchor' && !parsed.target.startsWith('@') && !kinds.has(parsed.target)) {
      fail({ code: 'unknown-anchor', id, field, message: `${id}.${field}: no item is called "${parsed.target}"` });
      return null;
    }
    return parsed;
  };
  const timeOf = (parsed: ParsedTime | null, get: (key: string) => number | undefined): number | undefined => {
    if (!parsed) return undefined;
    if (parsed.kind === 'absolute') return parsed.seconds;
    if (parsed.target === START_ANCHOR) return parsed.offset;
    if (parsed.target === END_ANCHOR) return add(get(END_ANCHOR), parsed.offset);
    return add(get(`${parsed.target}.${parsed.point}`), parsed.offset);
  };
  const optionalAnchor = (ref: TimeRef | undefined, id: string, field: string): ParsedTime | null | undefined =>
    ref === undefined ? undefined : anchor(ref, id, field);

  const graph = new TimeGraph(errors);

  // Segments: sequential unless placed with `at`.
  cut.segments.forEach((seg, i) => {
    if (seg.in < 0) fail({ code: 'negative-in', id: seg.id, field: 'in', message: `${seg.id}: in is negative` });
    if (seg.out < seg.in) fail({ code: 'out-before-in', id: seg.id, field: 'out', message: `${seg.id}: out (${seg.out}) is before in (${seg.in})` });
    const lengthFields = (['hold', 'duration', 'end'] as const).filter((k) => seg[k] !== undefined);
    if (lengthFields.length > 1) {
      fail({ code: 'conflicting-fields', id: seg.id, field: lengthFields[1], message: `${seg.id}: use only one of hold, duration or end (got ${lengthFields.join(', ')})` });
    }
    if (seg.loop && seg.hold !== undefined) fail({ code: 'conflicting-fields', id: seg.id, field: 'hold', message: `${seg.id}: a loop can't also hold` });
    if (seg.loop && seg.duration === undefined && seg.end === undefined) {
      fail({ code: 'loop-needs-length', id: seg.id, field: 'loop', message: `${seg.id}: a loop needs a duration or an end` });
    }
    const at = optionalAnchor(seg.at, seg.id, 'at');
    const end = optionalAnchor(seg.end, seg.id, 'end');
    const prev = i > 0 ? cut.segments[i - 1].id : undefined;
    const length = seg.duration ?? seg.out - seg.in + (seg.hold ?? 0);
    graph.define(`${seg.id}.start`, (get) => {
      if (at !== undefined) return timeOf(at, get);
      return prev === undefined ? 0 : get(`${prev}.end`);
    });
    graph.define(`${seg.id}.end`, (get) => (end !== undefined ? timeOf(end, get) : add(get(`${seg.id}.start`), length)));
  });
  const last = cut.segments[cut.segments.length - 1];
  graph.define(END_ANCHOR, (get) => (last ? get(`${last.id}.end`) : undefined));

  // Lines.
  for (const line of lines) {
    const until = optionalAnchor(line.until, line.id, 'until');
    if (line.segment !== undefined) {
      const seg = line.segment;
      if (kinds.get(seg) !== 'segment') fail({ code: 'unknown-segment', id: line.id, field: 'segment', message: `${line.id}: no segment is called "${seg}"` });
      const at = optionalAnchor(line.at, line.id, 'at');
      graph.define(`${line.id}.start`, (get) => (at !== undefined ? timeOf(at, get) : get(`${seg}.start`)));
      graph.define(`${line.id}.end`, (get) => (until !== undefined ? timeOf(until, get) : get(`${seg}.end`)));
    } else {
      const at = anchor(line.at, line.id, 'at');
      const natural = lengthOf(source(line.src)) ?? line.duration;
      if (natural === undefined && until === undefined) {
        fail({ code: 'unknown-length', id: line.id, message: `${line.id}: give a duration or an until, or a mediaLength probe` });
      }
      graph.define(`${line.id}.start`, (get) => timeOf(at, get));
      graph.define(`${line.id}.end`, (get) =>
        clippedEnd(get(`${line.id}.start`), natural, until ? timeOf(until, get) : undefined, until !== undefined),
      );
    }
  }

  // Music, stings and sound effects.
  const audioNatural = (clip: AudioClip): number | undefined => {
    if (clip.duration !== undefined) return clip.duration;
    const from = clip.in ?? 0;
    if (clip.out !== undefined) return clip.out - from;
    if (clip.src === undefined) return undefined;
    const length = lengthOf(source(clip.src));
    return length === undefined ? undefined : length - from;
  };
  for (const clip of [...music, ...sfx]) {
    if ((clip.src === undefined) === (clip.synth === undefined)) {
      fail({ code: 'conflicting-fields', id: clip.id, field: 'src', message: `${clip.id}: needs exactly one of src or synth` });
    }
    const at = anchor(clip.at, clip.id, 'at');
    const until = optionalAnchor(clip.until, clip.id, 'until');
    const natural = audioNatural(clip);
    if (natural === undefined && until === undefined) {
      fail({ code: 'unknown-length', id: clip.id, message: `${clip.id}: give an until, a duration or an out, or a mediaLength probe` });
    }
    if (clip.out !== undefined && clip.out < (clip.in ?? 0)) {
      fail({ code: 'out-before-in', id: clip.id, field: 'out', message: `${clip.id}: out is before in` });
    }
    graph.define(`${clip.id}.start`, (get) => timeOf(at, get));
    graph.define(`${clip.id}.end`, (get) =>
      clippedEnd(get(`${clip.id}.start`), natural, until ? timeOf(until, get) : undefined, until !== undefined),
    );
  }

  // Overlays.
  for (const overlay of overlays) {
    const at = anchor(overlay.at, overlay.id, 'at');
    const until = optionalAnchor(overlay.until, overlay.id, 'until');
    if (overlay.duration === undefined && until === undefined) {
      fail({ code: 'unknown-length', id: overlay.id, message: `${overlay.id}: give an until or a duration` });
    }
    graph.define(`${overlay.id}.start`, (get) => timeOf(at, get));
    graph.define(`${overlay.id}.end`, (get) =>
      clippedEnd(get(`${overlay.id}.start`), overlay.duration, until ? timeOf(until, get) : undefined, until !== undefined),
    );
  }

  // Keyframes refer to items but nothing refers to keyframes, so they can't make cycles.
  const volumeKeys = new Map<string, Array<{ ref: ParsedTime | null; value: number }>>();
  for (const clip of [...music, ...sfx]) {
    if (Array.isArray(clip.volume)) {
      volumeKeys.set(clip.id, clip.volume.map((k, i) => ({ ref: anchor(k.at, clip.id, `volume[${i}].at`), value: k.value })));
    }
  }
  const motionKeys = new Map<string, Array<{ ref: ParsedTime | null; x?: number; y?: number }>>();
  for (const overlay of overlays) {
    if (overlay.motion) {
      motionKeys.set(overlay.id, overlay.motion.map((k, i) => ({ ref: anchor(k.at, overlay.id, `motion[${i}].at`), x: k.x, y: k.y })));
    }
  }

  // Compute every point, so every cycle and unresolvable point is found.
  for (const key of graph.keys()) graph.get(key);
  if (errors.length > 0) return { ok: false, errors };

  const span = (id: string): { start: number; end: number } => {
    const start = graph.get(`${id}.start`);
    const end = graph.get(`${id}.end`);
    if (start === undefined || end === undefined) throw new Error(`unresolved time for ${id}`);
    return { start, end };
  };
  const checkFades = (id: string, length: number, fadeIn: number, fadeOut: number): void => {
    if (fadeIn < 0 || fadeOut < 0) fail({ code: 'bad-shape', id, field: 'fadeIn', message: `${id}: fades can't be negative` });
    else if (length >= 0 && fadeIn + fadeOut > length + EPS) fail({ code: 'fade-too-long', id, message: `${id}: its fades (${fadeIn + fadeOut} s) are longer than it is (${round(length)} s)` });
  };
  const checkStart = (id: string, start: number): void => {
    if (start < -EPS) fail({ code: 'before-start', id, field: 'at', message: `${id} starts before the cut (${start} s)` });
  };
  const checkMedia = (id: string, field: string, src: ResolvedSource, out: number): void => {
    const length = lengthOf(src);
    if (length !== undefined && out > length + 1e-3) {
      fail({ code: 'out-past-media', id, field, message: `${id}: ${field} (${out}) is past the end of ${src.kind === 'color' || src.kind === 'synth' ? src.kind : src.path} (${length} s)` });
    }
  };
  const resolveTime = (ref: ParsedTime | null): number => {
    const t = timeOf(ref, graph.get);
    if (t === undefined) throw new Error('unresolved keyframe');
    return round(t);
  };
  const checkOrder = (id: string, field: string, times: number[]): void => {
    for (let i = 1; i < times.length; i++) {
      if (times[i] < times[i - 1] - EPS) {
        fail({ code: 'keyframes-unordered', id, field: `${field}[${i}]`, message: `${id}: ${field} key ${i} (${times[i]} s) is before key ${i - 1} (${times[i - 1]} s)` });
        return;
      }
    }
  };

  // Segments.
  const resolvedSegments: ResolvedSegment[] = cut.segments.map((seg, index) => {
    const { start, end } = span(seg.id);
    const length = end - start;
    if (length <= EPS) fail({ code: 'negative-length', id: seg.id, message: `${seg.id} ends at ${end} s, ${length < 0 ? 'before' : 'as'} it starts (${start} s)` });
    checkStart(seg.id, start);
    const src = source(seg.src);
    checkMedia(seg.id, 'out', src, seg.out);
    const hold = seg.loop ? 0 : round(length - (seg.out - seg.in));
    if (!seg.loop && hold < -EPS && length > EPS) {
      fail({ code: 'negative-hold', id: seg.id, message: `${seg.id}: it is ${round(length)} s long, shorter than in→out (${round(seg.out - seg.in)} s); move out instead` });
    }
    const fadeIn = seg.fadeIn ?? 0;
    const fadeOut = seg.fadeOut ?? 0;
    checkFades(seg.id, length, fadeIn, fadeOut);

    let audio: ResolvedSegmentAudio | null = null;
    if (seg.audio !== false) {
      const a = seg.audio ?? {};
      const aSrc = a.src === undefined ? src : source(a.src);
      if (aSrc.kind !== 'color') {
        const aIn = a.in ?? seg.in;
        const aOut = a.out ?? aIn + (seg.out - seg.in);
        if (aOut < aIn) fail({ code: 'out-before-in', id: seg.id, field: 'audio.out', message: `${seg.id}: audio out is before audio in` });
        if (aIn < 0) fail({ code: 'negative-in', id: seg.id, field: 'audio.in', message: `${seg.id}: audio in is negative` });
        checkMedia(seg.id, 'audio.out', aSrc, aOut);
        const aEnd = round(start + Math.min(aOut - aIn, length));
        checkFades(`${seg.id}.audio`, aEnd - start, a.fadeIn ?? 0, a.fadeOut ?? 0);
        audio = { src: aSrc, in: aIn, out: aOut, volume: a.volume ?? 1, fadeIn: a.fadeIn ?? 0, fadeOut: a.fadeOut ?? 0, start, end: aEnd };
      }
    }
    return {
      kind: 'segment',
      id: seg.id,
      label: seg.label ?? seg.id,
      index,
      start,
      end,
      src,
      in: seg.in,
      out: seg.out,
      hold: Math.max(0, hold),
      loop: seg.loop ?? null,
      crop: seg.crop ?? null,
      fadeIn,
      fadeOut,
      audio,
    };
  });
  for (let i = 1; i < resolvedSegments.length; i++) {
    const prev = resolvedSegments[i - 1];
    const cur = resolvedSegments[i];
    if (cur.start < prev.end - EPS) {
      fail({ code: 'overlap', id: cur.id, field: 'at', message: `${cur.id} starts at ${cur.start} s, before ${prev.id} ends (${prev.end} s)` });
    }
  }
  const resolvedById = new Map(resolvedSegments.map((s) => [s.id, s]));

  // Lines.
  const resolvedLines: ResolvedLine[] = lines.map((line: Line) => {
    const { start, end } = span(line.id);
    if (end < start - EPS) fail({ code: 'negative-length', id: line.id, message: `${line.id} ends (${end} s) before it starts (${start} s)` });
    checkStart(line.id, start);
    let toTimeline: (t: number) => number;
    let audio: ResolvedLine['audio'];
    if (line.segment !== undefined) {
      const seg = resolvedById.get(line.segment);
      const audioIn = seg?.audio?.in ?? seg?.in ?? 0;
      const segStart = seg?.start ?? 0;
      toTimeline = (t) => segStart + (t - audioIn);
      audio = { kind: 'segment', segment: line.segment };
    } else {
      toTimeline = (t) => start + t;
      audio = { kind: 'file', src: source(line.src), volume: line.volume ?? 1 };
    }
    const words: Word[] = [];
    for (const w of line.words ?? []) {
      const ws = round(toTimeline(w.start));
      const we = round(toTimeline(w.end));
      if (we > start + EPS && ws < end - EPS) words.push({ text: w.text, start: Math.max(ws, start), end: Math.min(we, end) });
    }
    return { kind: 'line', id: line.id, label: `${line.speaker}: ${line.text}`, start, end, speaker: line.speaker, text: line.text, audio, words };
  });

  // Music and sound effects.
  const resolveAudio = (clip: AudioClip, kind: 'music' | 'sfx'): ResolvedAudio => {
    const { start, end } = span(clip.id);
    if (end < start - EPS) fail({ code: 'negative-length', id: clip.id, message: `${clip.id} ends (${end} s) before it starts (${start} s)` });
    checkStart(clip.id, start);
    const src: ResolvedSource = clip.synth ? { kind: 'synth', synth: clip.synth } : source(clip.src ?? '');
    const from = clip.in ?? 0;
    if (from < 0) fail({ code: 'negative-in', id: clip.id, field: 'in', message: `${clip.id}: in is negative` });
    const out = round(from + (end - start));
    checkMedia(clip.id, 'out', src, out);
    const fadeIn = clip.fadeIn ?? 0;
    const fadeOut = clip.fadeOut ?? 0;
    checkFades(clip.id, end - start, fadeIn, fadeOut);
    let volume: ResolvedKey[];
    const keys = volumeKeys.get(clip.id);
    if (keys) {
      volume = keys.map((k) => ({ t: resolveTime(k.ref), value: k.value }));
      checkOrder(clip.id, 'volume', volume.map((k) => k.t));
    } else {
      volume = [{ t: start, value: typeof clip.volume === 'number' ? clip.volume : 1 }];
    }
    return { kind, id: clip.id, label: clip.label ?? clip.id, start, end, src, in: from, out, volume, fadeIn, fadeOut };
  };
  const resolvedMusic = music.map((m) => resolveAudio(m, 'music'));
  const resolvedSfx = sfx.map((m) => resolveAudio(m, 'sfx'));

  // Overlays.
  const resolvedOverlays: ResolvedOverlay[] = overlays.map((overlay: Overlay) => {
    const { start, end } = span(overlay.id);
    if (end < start - EPS) fail({ code: 'negative-length', id: overlay.id, message: `${overlay.id} ends (${end} s) before it starts (${start} s)` });
    checkStart(overlay.id, start);
    const fadeIn = overlay.fadeIn ?? 0;
    const fadeOut = overlay.fadeOut ?? 0;
    checkFades(overlay.id, end - start, fadeIn, fadeOut);
    if (overlay.blink && (overlay.blink.period <= 0 || overlay.blink.on <= 0 || overlay.blink.on > overlay.blink.period)) {
      fail({ code: 'bad-shape', id: overlay.id, field: 'blink', message: `${overlay.id}: blink needs 0 < on ≤ period` });
    }
    let x = overlay.x ?? 0;
    let y = overlay.y ?? 0;
    let motion: ResolvedMotionKey[] = [{ t: start, x, y }];
    const keys = motionKeys.get(overlay.id);
    if (keys && keys.length > 0) {
      motion = keys.map((k) => {
        x = k.x ?? x;
        y = k.y ?? y;
        return { t: resolveTime(k.ref), x, y };
      });
      checkOrder(overlay.id, 'motion', motion.map((k) => k.t));
    }
    return {
      kind: 'overlay',
      id: overlay.id,
      label: overlay.label ?? overlay.id,
      start,
      end,
      src: source(overlay.src),
      motion,
      fadeIn,
      fadeOut,
      blink: overlay.blink ?? null,
    };
  });

  const length = graph.get(END_ANCHOR) ?? 0;
  const picture = { fadeIn: cut.picture?.fadeIn ?? 0, fadeOut: cut.picture?.fadeOut ?? 0 };
  checkFades('picture', length, picture.fadeIn, picture.fadeOut);
  if (cut.meta.length !== undefined && Math.abs(cut.meta.length - length) > 1e-3) {
    fail({ code: 'length-mismatch', field: 'meta.length', message: `meta.length is ${cut.meta.length} s but the segments add up to ${length} s` });
  }
  if (errors.length > 0) return { ok: false, errors };

  const items: TimelineItem[] = [...resolvedSegments, ...resolvedLines, ...resolvedMusic, ...resolvedSfx, ...resolvedOverlays];
  items.sort((a, b) => a.start - b.start);
  const at: Record<string, number> = {};
  for (const item of items) at[item.id] = item.start;

  return {
    ok: true,
    value: {
      meta: cut.meta,
      length,
      output: cut.output === undefined ? null : joinPath(root, cut.output),
      items,
      segments: resolvedSegments,
      lines: resolvedLines,
      music: resolvedMusic,
      sfx: resolvedSfx,
      overlays: resolvedOverlays,
      picture,
      at,
    },
  };
}
