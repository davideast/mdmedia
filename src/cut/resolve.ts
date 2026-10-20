import { END_ANCHOR, ID_PATTERN, START_ANCHOR, parseTimeRef, type ParsedTime } from './anchor.js';
import { inSeconds, type InSeconds } from './seconds.js';
import { resolvePerformances } from './performance.js';
import { ASSET_PREFIX } from './types.js';
import type {
  AnchoredFadeIn,
  AnchoredFadeOut,
  AudioClip,
  AudioFilter,
  CutError,
  CutFile,
  CutResult,
  Line,
  MixFilter,
  Overlay,
  ResolvedAudio,
  ResolvedAudioFilter,
  ResolvedBedPart,
  ResolvedFades,
  ResolvedKey,
  ResolvedLayer,
  ResolvedLine,
  ResolvedMixFilter,
  ResolvedMotionKey,
  ResolvedOverlay,
  ResolvedProvenance,
  ResolvedSegment,
  ResolvedSegmentAudio,
  ResolvedSource,
  ResolvedWave,
  ResolvedZoom,
  Segment,
  SourceRef,
  Timeline,
  TimelineItem,
  TimeRef,
  Wave,
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

/** The folder every relative media path resolves against: `options.root`, else `media.root`, relative to `cutDir`. */
export function mediaRoot(cut: Pick<CutFile, 'media'>, options: Pick<ResolveOptions, 'root' | 'cutDir'> = {}): string {
  const configured = options.root ?? cut.media.root;
  return !isAbsolute(configured) && options.cutDir ? joinPath(options.cutDir, configured) : normalize(configured);
}

/** `path` relative to `root` when it is inside it, else `path` unchanged. */
export function relativeToRoot(root: string, path: string): string {
  const base = normalize(root);
  const full = normalize(path);
  return full.startsWith(`${base}/`) ? full.slice(base.length + 1) : full;
}

// ---------------------------------------------------------------------------
// Time points

type Compute = (get: (key: string) => number | undefined) => number | undefined;

/**
 * Every item has two time points, `<id>.start` and `<id>.end`, plus `@end`
 * (and, for a music or sfx clip, `<id>.in`, its source in-point). Each point
 * is computed on demand from the points it refers to; a point met again
 * while it is still being computed is a cycle.
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

function min(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined || b === undefined ? undefined : Math.min(a, b);
}

/** An item's end: its natural length from `start`, cut off at `until`. */
function clippedEnd(start: number | undefined, natural: number | undefined, until: number | undefined, hasUntil: boolean): number | undefined {
  if (start === undefined) return undefined;
  const naturalEnd = natural === undefined ? undefined : start + natural;
  if (!hasUntil) return naturalEnd;
  if (until === undefined) return undefined;
  return naturalEnd === undefined ? until : Math.min(naturalEnd, until);
}

/** Filters with their defaults filled in. */
function resolveFilters(filters: AudioFilter[] | undefined): ResolvedAudioFilter[] {
  return (filters ?? []).map((f) => (f.kind === 'crush' ? { ...f, mix: f.mix ?? 1 } : { ...f }));
}

function resolveMixFilters(filters: MixFilter[] | undefined): ResolvedMixFilter[] {
  return (filters ?? []).map((f) => (f.kind === 'crush' ? { ...f, mix: f.mix ?? 1 } : { ...f }));
}

function resolveWave(wave: Wave | undefined, origin: number): ResolvedWave | null {
  if (!wave) return null;
  return { shape: wave.shape ?? 'sin', center: wave.center, amplitude: wave.amplitude, period: wave.period, phase: wave.phase ?? 0, origin };
}

// ---------------------------------------------------------------------------

type Kind = 'segment' | 'line' | 'music' | 'sfx' | 'overlay';
type Cut = InSeconds<CutFile>;
type Clip = InSeconds<AudioClip>;
type Seg = InSeconds<Segment>;

/**
 * Turns a cut file into a flat timeline with every item's absolute start and
 * end, and checks it. On any error it returns all the errors it found.
 */
export function resolveCut(input: CutFile, options: ResolveOptions = {}): CutResult<Timeline> {
  const errors: CutError[] = [];
  const fail = (error: CutError): undefined => {
    errors.push(error);
    return undefined;
  };

  const fps = input.meta.fps;
  if (!(fps > 0)) return { ok: false, errors: [{ code: 'bad-value', field: 'meta.fps', message: `meta.fps must be above 0 (got ${fps})` }] };
  // Frame counts ("f191") become seconds at the cut's fps.
  const cut: Cut = inSeconds(input);

  const lines = cut.lines ?? [];
  const music = cut.music ?? [];
  const sfx = cut.sfx ?? [];
  const overlays = cut.overlays ?? [];
  const clips: Clip[] = [...music, ...sfx];

  // Ids: one namespace for every item.
  const kinds = new Map<string, Kind>();
  const claim = (id: string, kind: Kind): void => {
    if (!ID_PATTERN.test(id)) {
      const frames = /^f\d+$/.test(id);
      fail({ code: 'bad-id', id, message: frames ? `"${id}" isn't a valid id: it reads as a frame count` : `"${id}" isn't a valid id: use letters, digits and underscores` });
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
  const root = mediaRoot(cut, options);
  const takes = cut.media.takes ?? DEFAULT_TAKES;
  const source = (ref: SourceRef): ResolvedSource => {
    if (ref.startsWith('take:')) {
      const name = ref.slice('take:'.length);
      return { kind: 'take', ref, name, path: joinPath(root, takes.replaceAll('{name}', name)) };
    }
    if (ref.startsWith('color:')) return { kind: 'color', ref, color: ref.slice('color:'.length) };
    if (ref.startsWith(ASSET_PREFIX)) return { kind: 'asset', ref, id: ref.slice(ASSET_PREFIX.length) };
    return { kind: 'file', ref, path: joinPath(root, ref) };
  };
  const lengthOf = (src: ResolvedSource): number | undefined =>
    src.kind === 'take' || src.kind === 'file' || src.kind === 'asset' ? options.mediaLength?.(src) : undefined;

  // Anchors are parsed once, up front, so each bad one is reported once.
  const anchor = (ref: TimeRef, id: string, field: string): ParsedTime | null => {
    const parsed = parseTimeRef(ref, fps);
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
  /** A time inside segment `scope`: a number is seconds from its start, a string an anchor as usual. */
  const scopedAnchor = (ref: TimeRef, scope: string | undefined, id: string, field: string): ParsedTime | null =>
    scope !== undefined && typeof ref === 'number' && Number.isFinite(ref)
      ? { kind: 'anchor', target: scope, point: 'start', offset: ref }
      : anchor(ref, id, field);
  const needSegment = (id: string, field: string, segment: string): boolean => {
    if (kinds.get(segment) === 'segment') return true;
    fail({ code: 'unknown-segment', id, field, message: `${id}: no segment is called "${segment}"` });
    return false;
  };

  const graph = new TimeGraph(errors);
  const segmentsById = new Map<string, Seg>(cut.segments.map((s) => [s.id, s]));

  // Segments: sequential unless placed with `at`.
  cut.segments.forEach((seg, i) => {
    let length: number | undefined;
    if (seg.still) {
      if (seg.duration !== undefined && seg.end !== undefined) {
        fail({ code: 'conflicting-fields', id: seg.id, field: 'end', message: `${seg.id}: use only one of duration or end` });
      }
      if (seg.duration === undefined && seg.end === undefined) {
        fail({ code: 'unknown-length', id: seg.id, field: 'duration', message: `${seg.id}: a still needs a duration or an end` });
      }
      length = seg.duration;
    } else {
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
      length = seg.duration ?? seg.out - seg.in + (seg.hold ?? 0);
    }
    const at = optionalAnchor(seg.at, seg.id, 'at');
    const end = optionalAnchor(seg.end, seg.id, 'end');
    const prev = i > 0 ? cut.segments[i - 1].id : undefined;
    graph.define(`${seg.id}.start`, (get) => {
      if (at !== undefined) return timeOf(at, get);
      return prev === undefined ? 0 : get(`${prev}.end`);
    });
    graph.define(`${seg.id}.end`, (get) => (end !== undefined ? timeOf(end, get) : add(get(`${seg.id}.start`), length)));
  });
  const last = cut.segments[cut.segments.length - 1];
  graph.define(END_ANCHOR, (get) => (last ? get(`${last.id}.end`) : undefined));

  /** A segment's sound as written: its source (none for a still without one) and in-point. Static: no anchors. */
  const segmentSound = (seg: Seg): { src: ResolvedSource | null; in: number; synth: boolean } | null => {
    if (seg.audio === false) return null;
    const a = seg.audio ?? {};
    if (a.synth) return { src: { kind: 'synth', synth: a.synth }, in: a.in ?? 0, synth: true };
    if (a.src === undefined && seg.still) return null;
    const src = a.src === undefined ? source(seg.src) : source(a.src);
    if (src.kind === 'color') return null;
    return { src, in: a.in ?? (seg.still ? 0 : seg.in), synth: false };
  };

  /** A layer's end: cut off at its segment's end. */
  const layered = (layer: string | undefined, end: number | undefined, get: (key: string) => number | undefined): number | undefined =>
    layer === undefined || kinds.get(layer) !== 'segment' ? end : min(end, get(`${layer}.end`));

  // Lines.
  for (const line of lines) {
    const until = optionalAnchor(line.until, line.id, 'until');
    if (line.segment !== undefined) {
      const seg = line.segment;
      needSegment(line.id, 'segment', seg);
      const at = optionalAnchor(line.at, line.id, 'at');
      graph.define(`${line.id}.start`, (get) => (at !== undefined ? timeOf(at, get) : get(`${seg}.start`)));
      graph.define(`${line.id}.end`, (get) => (until !== undefined ? timeOf(until, get) : get(`${seg}.end`)));
    } else if (line.clip !== undefined) {
      const clipId = line.clip;
      const kind = kinds.get(clipId);
      if (kind !== 'music' && kind !== 'sfx') {
        fail({ code: 'unknown-clip', id: line.id, field: 'clip', message: `${line.id}: no music or sfx clip is called "${clipId}"` });
      }
      const { in: from, out } = line;
      if (from !== undefined && out !== undefined && out < from) {
        fail({ code: 'out-before-in', id: line.id, field: 'out', message: `${line.id}: out (${out}) is before in (${from})` });
      }
      // The clip's clock: a source time t plays at clip.start + (t − clip.in).
      const at = (t: number, get: (key: string) => number | undefined): number | undefined => {
        const start = get(`${clipId}.start`);
        const clipIn = get(`${clipId}.in`);
        return start === undefined || clipIn === undefined ? undefined : start + (t - clipIn);
      };
      graph.define(`${line.id}.start`, (get) => (from === undefined ? get(`${clipId}.start`) : at(from, get)));
      graph.define(`${line.id}.end`, (get) => {
        const natural = out === undefined ? get(`${clipId}.end`) : min(at(out, get), get(`${clipId}.end`));
        return until === undefined ? natural : min(natural, timeOf(until, get));
      });
    } else {
      const at = anchor(line.at, line.id, 'at');
      const from = line.in ?? 0;
      const sourceLength = lengthOf(source(line.src)) ?? line.duration;
      const natural = line.out !== undefined ? line.out - from : sourceLength === undefined ? undefined : sourceLength - from;
      if (line.out !== undefined && line.out < from) {
        fail({ code: 'out-before-in', id: line.id, field: 'out', message: `${line.id}: out (${line.out}) is before in (${from})` });
      }
      if (natural === undefined && until === undefined) {
        fail({ code: 'unknown-length', id: line.id, message: `${line.id}: give an out, a duration or an until, or a mediaLength probe` });
      }
      if (line.layer !== undefined) needSegment(line.id, 'layer', line.layer);
      graph.define(`${line.id}.start`, (get) => timeOf(at, get));
      graph.define(`${line.id}.end`, (get) =>
        layered(line.layer, clippedEnd(get(`${line.id}.start`), natural, until ? timeOf(until, get) : undefined, until !== undefined), get),
      );
    }
  }

  // Music, stings and sound effects.
  /** A bed's parts in its own clock: each starts where the one before ends, less its crossfade. */
  const bedLayout = (clip: Clip): Array<{ src: ResolvedSource; in: number; out: number; at: number; crossfade: number }> | undefined => {
    if (!clip.parts) return undefined;
    const out: Array<{ src: ResolvedSource; in: number; out: number; at: number; crossfade: number }> = [];
    let cursor = 0;
    for (const [i, part] of clip.parts.entries()) {
      const src = source(part.src);
      const from = part.in ?? 0;
      const probed = lengthOf(src);
      const to = part.out ?? (probed !== undefined ? probed : part.duration !== undefined ? from + part.duration : undefined);
      if (to === undefined) {
        fail({ code: 'unknown-length', id: clip.id, field: `parts[${i}]`, message: `${clip.id}: part ${i} needs an out or a duration, or a mediaLength probe` });
        return undefined;
      }
      if (to < from) {
        fail({ code: 'out-before-in', id: clip.id, field: `parts[${i}].out`, message: `${clip.id}: part ${i}'s out is before its in` });
        return undefined;
      }
      const crossfade = i === 0 ? 0 : (part.crossfade ?? 0);
      const prevLength = i === 0 ? Infinity : out[i - 1].out - out[i - 1].in;
      if (crossfade > Math.min(prevLength, to - from) + EPS) {
        fail({ code: 'fade-too-long', id: clip.id, field: `parts[${i}].crossfade`, message: `${clip.id}: part ${i}'s crossfade (${crossfade} s) is longer than a part it joins` });
      }
      const at = i === 0 ? 0 : cursor - crossfade;
      out.push({ src, in: from, out: to, at, crossfade });
      cursor = at + (to - from);
    }
    return out;
  };
  const beds = new Map<string, ReturnType<typeof bedLayout>>();
  const audioNatural = (clip: Clip, from: number): number | undefined => {
    if (clip.duration !== undefined) return clip.duration;
    if (clip.out !== undefined) return clip.out - from;
    if (clip.parts) {
      const layout = beds.get(clip.id);
      if (!layout || layout.length === 0) return undefined;
      const lastPart = layout[layout.length - 1];
      return lastPart.at + (lastPart.out - lastPart.in) - from;
    }
    if (clip.src === undefined) return undefined;
    const length = lengthOf(source(clip.src));
    return length === undefined ? undefined : length - from;
  };
  for (const clip of clips) {
    const sounds = [clip.src, clip.synth, clip.parts, clip.segment].filter((x) => x !== undefined).length;
    if (sounds !== 1) {
      fail({ code: 'conflicting-fields', id: clip.id, field: 'src', message: `${clip.id}: needs exactly one of src, synth, parts or segment` });
    }
    if (clip.parts) beds.set(clip.id, bedLayout(clip));
    const at = optionalAnchor(clip.at, clip.id, 'at');
    const until = optionalAnchor(clip.until, clip.id, 'until');
    const syncAt = clip.sync ? anchor(clip.sync.at, clip.id, 'sync.at') : undefined;
    if (clip.layer !== undefined) needSegment(clip.id, 'layer', clip.layer);

    if (clip.segment !== undefined) {
      // Sound heard in a segment's own audio: it labels that stretch and adds none.
      const segId = clip.segment;
      const seg = needSegment(clip.id, 'segment', segId) ? segmentsById.get(segId) : undefined;
      const sound = seg ? segmentSound(seg) : null;
      if (seg && !sound) fail({ code: 'bad-shape', id: clip.id, field: 'segment', message: `${clip.id}: its segment "${segId}" has no sound to be heard in` });
      graph.define(`${clip.id}.start`, (get) => (at !== undefined ? timeOf(at, get) : get(`${segId}.start`)));
      graph.define(`${clip.id}.end`, (get) => (until !== undefined ? timeOf(until, get) : get(`${segId}.end`)));
      graph.define(`${clip.id}.in`, (get) => {
        const start = get(`${clip.id}.start`);
        const segStart = get(`${segId}.start`);
        return start === undefined || segStart === undefined || !sound ? undefined : sound.in + (start - segStart);
      });
      continue;
    }

    if (clip.sync && at === undefined && clip.in === undefined) {
      fail({ code: 'bad-shape', id: clip.id, field: 'sync', message: `${clip.id}: a sync point needs the clip's at (to work out its in) or its in (to work out where it starts)` });
    }
    // With a sync point and an at, the in-point is solved: sync.source plays at sync.at.
    graph.define(`${clip.id}.in`, (get) => {
      if (clip.sync && at !== undefined) {
        const start = get(`${clip.id}.start`);
        const syncTime = timeOf(syncAt ?? null, get);
        return start === undefined || syncTime === undefined ? undefined : clip.sync.source - (syncTime - start);
      }
      return clip.in ?? 0;
    });
    graph.define(`${clip.id}.start`, (get) => {
      if (at !== undefined) return timeOf(at, get);
      // Placed by its sync point and its in: sync.source plays at sync.at.
      if (clip.sync && clip.in !== undefined) return add(timeOf(syncAt ?? null, get), -(clip.sync.source - clip.in));
      return undefined;
    });
    const staticIn = clip.sync && at !== undefined ? undefined : (clip.in ?? 0);
    if (staticIn !== undefined && audioNatural(clip, staticIn) === undefined && until === undefined && !clip.parts) {
      fail({ code: 'unknown-length', id: clip.id, message: `${clip.id}: give an until, a duration or an out, or a mediaLength probe` });
    }
    if (clip.out !== undefined && staticIn !== undefined && clip.out < staticIn) {
      fail({ code: 'out-before-in', id: clip.id, field: 'out', message: `${clip.id}: out is before in` });
    }
    graph.define(`${clip.id}.end`, (get) => {
      const from = get(`${clip.id}.in`);
      const natural = from === undefined ? undefined : audioNatural(clip, from);
      const end = clippedEnd(get(`${clip.id}.start`), natural, until ? timeOf(until, get) : undefined, until !== undefined);
      return layered(clip.layer, end, get);
    });
  }

  // Overlays. One in a segment is timed in the segment's clock, and by default spans it.
  const overlayScope = new Map<string, string | undefined>();
  for (const overlay of overlays) {
    let scope: string | undefined;
    if (overlay.segment !== undefined && needSegment(overlay.id, 'segment', overlay.segment)) scope = overlay.segment;
    overlayScope.set(overlay.id, scope);
    const at = overlay.at === undefined ? undefined : scopedAnchor(overlay.at, scope, overlay.id, 'at');
    const until = overlay.until === undefined ? undefined : scopedAnchor(overlay.until, scope, overlay.id, 'until');
    if (overlay.at === undefined && overlay.segment === undefined) {
      fail({ code: 'bad-shape', id: overlay.id, field: 'at', message: `${overlay.id}: an overlay needs an at, unless it is in a segment` });
    }
    if (overlay.segment === undefined && overlay.duration === undefined && until === undefined) {
      fail({ code: 'unknown-length', id: overlay.id, message: `${overlay.id}: give an until or a duration` });
    }
    graph.define(`${overlay.id}.start`, (get) => (at !== undefined ? timeOf(at, get) : scope ? get(`${scope}.start`) : undefined));
    graph.define(`${overlay.id}.end`, (get) => {
      const start = get(`${overlay.id}.start`);
      if (until !== undefined) return clippedEnd(start, overlay.duration, timeOf(until, get), true);
      if (overlay.duration !== undefined) return add(start, overlay.duration);
      return scope ? get(`${scope}.end`) : undefined;
    });
  }

  // Keyframes and anchored fades refer to items but nothing refers to them, so they can't make cycles.
  const volumeKeys = new Map<string, Array<{ ref: ParsedTime | null; value: number }>>();
  const fadeRefs = new Map<string, { in?: ParsedTime | null; out?: ParsedTime | null }>();
  const readFades = (id: string, fadeIn: number | AnchoredFadeIn | undefined, fadeOut: number | AnchoredFadeOut | undefined): void => {
    fadeRefs.set(id, {
      in: typeof fadeIn === 'object' ? anchor(fadeIn.start, id, 'fadeIn.start') : undefined,
      out: typeof fadeOut === 'object' ? anchor(fadeOut.end, id, 'fadeOut.end') : undefined,
    });
  };
  for (const clip of clips) {
    if (Array.isArray(clip.volume)) {
      volumeKeys.set(clip.id, clip.volume.map((k, i) => ({ ref: anchor(k.at, clip.id, `volume[${i}].at`), value: k.value })));
    }
    readFades(clip.id, clip.fadeIn, clip.fadeOut);
  }
  for (const line of lines) if (line.src !== undefined) readFades(line.id, line.fadeIn, line.fadeOut);
  const motionKeys = new Map<string, Array<{ ref: ParsedTime | null; x?: number; y?: number }>>();
  const opacityKeys = new Map<string, Array<{ ref: ParsedTime | null; value: number }>>();
  for (const overlay of overlays) {
    const scope = overlayScope.get(overlay.id);
    if (overlay.motion) {
      motionKeys.set(overlay.id, overlay.motion.map((k, i) => ({ ref: scopedAnchor(k.at, scope, overlay.id, `motion[${i}].at`), x: k.x, y: k.y })));
    }
    if (Array.isArray(overlay.opacity)) {
      opacityKeys.set(overlay.id, overlay.opacity.map((k, i) => ({ ref: scopedAnchor(k.at, scope, overlay.id, `opacity[${i}].at`), value: k.value })));
    }
    for (const axis of ['x', 'y'] as const) {
      if (!overlay.wave?.[axis]) continue;
      const also = [overlay[axis] !== undefined ? axis : undefined, overlay.motion?.some((k) => k[axis] !== undefined) ? `motion ${axis}` : undefined].filter(Boolean);
      if (also.length > 0) {
        fail({ code: 'conflicting-fields', id: overlay.id, field: `wave.${axis}`, message: `${overlay.id}: wave.${axis} sets ${axis}, so drop its ${also.join(' and ')}` });
      }
    }
  }
  const zoomKeys = new Map<string, Array<{ ref: ParsedTime | null; scale: number }>>();
  for (const seg of cut.segments) {
    if (seg.zoom) zoomKeys.set(seg.id, seg.zoom.keys.map((k, i) => ({ ref: scopedAnchor(k.at, seg.id, seg.id, `zoom.keys[${i}].at`), scale: k.scale })));
  }

  // Compute every point, so every cycle and unresolvable point is found.
  for (const key of graph.keys()) graph.get(key);
  if (errors.length > 0) return { ok: false, errors };
  // Anything still unknown has nothing that says how long it runs (e.g. a clip placed by its sync point, with no length).
  for (const id of kinds.keys()) {
    if (graph.get(`${id}.start`) === undefined || graph.get(`${id}.end`) === undefined) {
      fail({ code: 'unknown-length', id, message: `${id}: nothing says when it starts or how long it runs` });
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  const span = (id: string): { start: number; end: number } => {
    const start = graph.get(`${id}.start`);
    const end = graph.get(`${id}.end`);
    if (start === undefined || end === undefined) throw new Error(`unresolved time for ${id}`);
    return { start, end };
  };
  const checkFades = (id: string, length: number, fadeIn: number, fadeOut: number): void => {
    if (fadeIn < 0 || fadeOut < 0) fail({ code: 'bad-shape', id, field: 'fadeIn', message: `${id}: fades can't be negative` });
    else if (length >= 0 && fadeIn + fadeOut > length + EPS) fail({ code: 'fade-too-long', id, message: `${id}: its fades (${round(fadeIn + fadeOut)} s) are longer than it is (${round(length)} s)` });
  };
  const checkStart = (id: string, start: number): void => {
    if (start < -EPS) fail({ code: 'before-start', id, field: 'at', message: `${id} starts before the cut (${start} s)` });
  };
  const checkMedia = (id: string, field: string, src: ResolvedSource, out: number): void => {
    const length = lengthOf(src);
    if (length !== undefined && out > length + 1e-3) {
      const name = src.kind === 'take' || src.kind === 'file' ? src.path : src.kind === 'asset' ? src.ref : src.kind;
      fail({ code: 'out-past-media', id, field, message: `${id}: ${field} (${out}) is past the end of ${name} (${length} s)` });
    }
  };
  const resolveTime = (ref: ParsedTime | null): number => {
    const t = timeOf(ref, graph.get);
    if (t === undefined) throw new Error('unresolved keyframe');
    return round(t);
  };
  const checkInside = (id: string, field: string, from: number, to: number, segment: string, segStart: number, segEnd: number): void => {
    if (from < segStart - EPS || to > segEnd + EPS) {
      const what = from === to ? `${from} s` : `${from}–${to} s`;
      fail({ code: 'outside-segment', id, field, message: `${id}: ${field} (${what}) is outside its segment ${segment} (${segStart}–${segEnd} s)` });
    }
  };
  const checkOrder = (id: string, field: string, times: number[]): void => {
    for (let i = 1; i < times.length; i++) {
      if (times[i] < times[i - 1] - EPS) {
        fail({ code: 'keyframes-unordered', id, field: `${field}[${i}]`, message: `${id}: ${field} key ${i} (${times[i]} s) is before key ${i - 1} (${times[i - 1]} s)` });
        return;
      }
    }
  };
  /** An item's fades on the timeline: a number is at its own start or end; an anchored fade wherever its anchor is. */
  const fadesOf = (id: string, start: number, end: number, fadeIn: number | AnchoredFadeIn | undefined, fadeOut: number | AnchoredFadeOut | undefined): ResolvedFades => {
    const refs = fadeRefs.get(id) ?? {};
    const inLength = typeof fadeIn === 'object' ? fadeIn.duration : (fadeIn ?? 0);
    const outLength = typeof fadeOut === 'object' ? fadeOut.duration : (fadeOut ?? 0);
    const fades: ResolvedFades = {
      fadeIn: inLength,
      fadeOut: outLength,
      fadeInStart: refs.in !== undefined ? resolveTime(refs.in) : start,
      fadeOutEnd: refs.out !== undefined ? resolveTime(refs.out) : end,
    };
    // Fades at the item's own ends must fit in it; an anchored fade may run past either end.
    checkFades(id, end - start, typeof fadeIn === 'object' ? 0 : inLength, typeof fadeOut === 'object' ? 0 : outLength);
    if (fades.fadeIn < 0 || fades.fadeOut < 0) fail({ code: 'bad-shape', id, field: 'fadeIn', message: `${id}: fades can't be negative` });
    return fades;
  };

  // Segments.
  const resolvedSegments: ResolvedSegment[] = cut.segments.map((seg, index) => {
    const { start, end } = span(seg.id);
    const length = end - start;
    if (length <= EPS) fail({ code: 'negative-length', id: seg.id, message: `${seg.id} ends at ${end} s, ${length < 0 ? 'before' : 'as'} it starts (${start} s)` });
    checkStart(seg.id, start);
    const src = source(seg.src);
    const segIn = seg.still ? 0 : seg.in;
    const segOut = seg.still ? 0 : seg.out;
    if (!seg.still) checkMedia(seg.id, 'out', src, seg.out);
    const hold = seg.loop ? 0 : round(length - (segOut - segIn));
    if (!seg.loop && hold < -EPS && length > EPS) {
      fail({ code: 'negative-hold', id: seg.id, message: `${seg.id}: it is ${round(length)} s long, shorter than in→out (${round(segOut - segIn)} s); move out instead` });
    }
    const fadeIn = seg.fadeIn ?? 0;
    const fadeOut = seg.fadeOut ?? 0;
    checkFades(seg.id, length, fadeIn, fadeOut);
    const mix = { fadeIn: seg.mix?.fadeIn ?? 0, fadeOut: seg.mix?.fadeOut ?? 0 };
    checkFades(`${seg.id}.mix`, length, mix.fadeIn, mix.fadeOut);

    let audio: ResolvedSegmentAudio | null = null;
    const a = seg.audio === false ? undefined : (seg.audio ?? {});
    const sound = segmentSound(seg);
    if (seg.still && a && a.src === undefined && !a.synth && seg.audio !== undefined) {
      fail({ code: 'bad-shape', id: seg.id, field: 'audio', message: `${seg.id}: a still has no sound of its own; give its audio a src or a synth` });
    }
    if (a && sound?.src) {
      const aIn = sound.in;
      // A shot's sound runs over the same stretch as its picture; a still's or a synth's for the segment's length.
      const aOut = a.out ?? aIn + (seg.still || sound.synth ? length : segOut - segIn);
      if (aOut < aIn) fail({ code: 'out-before-in', id: seg.id, field: 'audio.out', message: `${seg.id}: audio out is before audio in` });
      if (aIn < 0) fail({ code: 'negative-in', id: seg.id, field: 'audio.in', message: `${seg.id}: audio in is negative` });
      checkMedia(seg.id, 'audio.out', sound.src, aOut);
      const aEnd = round(start + Math.min(aOut - aIn, length));
      checkFades(`${seg.id}.audio`, aEnd - start, a.fadeIn ?? 0, a.fadeOut ?? 0);
      audio = { src: sound.src, in: aIn, out: round(aOut), volume: a.volume ?? 1, fadeIn: a.fadeIn ?? 0, fadeOut: a.fadeOut ?? 0, start, end: aEnd };
    }

    let zoom: ResolvedZoom | null = null;
    const zKeys = zoomKeys.get(seg.id);
    if (seg.zoom && zKeys) {
      const { width, height } = cut.meta;
      const f = seg.zoom.focus;
      const focus = !f ? { x: width / 2, y: height / 2 } : f.unit === 'fraction' ? { x: round(f.x * width), y: round(f.y * height) } : { x: f.x, y: f.y };
      if (focus.x > width + EPS || focus.y > height + EPS) {
        fail({ code: 'bad-value', id: seg.id, field: 'zoom.focus', message: `${seg.id}: zoom.focus (${focus.x}, ${focus.y}) is outside the ${width}×${height} picture` });
      }
      const keys = zKeys.map((k) => ({ t: resolveTime(k.ref), value: k.scale }));
      checkOrder(seg.id, 'zoom.keys', keys.map((k) => k.t));
      keys.forEach((k, i) => checkInside(seg.id, `zoom.keys[${i}].at`, k.t, k.t, seg.id, start, end));
      zoom = { focus, keys };
    }
    return {
      kind: 'segment',
      id: seg.id,
      label: seg.label ?? seg.id,
      index,
      start,
      end,
      src,
      still: seg.still === true,
      in: segIn,
      out: segOut,
      hold: Math.max(0, hold),
      loop: (seg.still ? undefined : seg.loop) ?? null,
      crop: seg.crop ?? null,
      fadeIn,
      fadeOut,
      audio,
      mix,
      zoom,
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
  /** A layer's segment, and a check that the item starts inside it. */
  const layerOf = (id: string, layer: string | undefined, start: number): ResolvedLayer | null => {
    if (layer === undefined) return null;
    const seg = resolvedById.get(layer);
    if (!seg) return null;
    if (start < seg.start - EPS || start > seg.end + EPS) {
      fail({ code: 'outside-segment', id, field: 'layer', message: `${id}: it starts at ${start} s, outside the segment it is a layer of, ${layer} (${seg.start}–${seg.end} s)` });
    }
    return { segment: layer, start: seg.start, end: seg.end, fadeIn: seg.mix.fadeIn, fadeOut: seg.mix.fadeOut };
  };

  // Music and sound effects (before lines, which can be heard in them).
  const resolveAudio = (clip: Clip, kind: 'music' | 'sfx'): ResolvedAudio => {
    const { start, end } = span(clip.id);
    if (end < start - EPS) fail({ code: 'negative-length', id: clip.id, message: `${clip.id} ends (${end} s) before it starts (${start} s)` });
    checkStart(clip.id, start);
    const from = graph.get(`${clip.id}.in`) ?? 0;
    if (from < -EPS) fail({ code: 'negative-in', id: clip.id, field: clip.sync ? 'sync' : 'in', message: `${clip.id}: its in (${from} s) is negative${clip.sync ? ', from its sync point' : ''}` });
    const out = round(from + (end - start));
    const label = clip.label ?? clip.id;
    const filters = resolveFilters(clip.filters);

    if (clip.segment !== undefined) {
      const seg = resolvedById.get(clip.segment);
      if (seg) checkInside(clip.id, 'at', start, start, seg.id, seg.start, seg.end);
      const src: ResolvedSource = seg?.audio?.src ?? { kind: 'color', ref: 'color:black', color: 'black' };
      return {
        kind, id: clip.id, label, start, end, src, in: from, out, volume: [{ t: start, value: seg?.audio?.volume ?? 1 }],
        fadeIn: 0, fadeOut: 0, fadeInStart: start, fadeOutEnd: end, filters, parts: null, segment: clip.segment, sync: null, layer: null,
      };
    }

    let src: ResolvedSource;
    let parts: ResolvedBedPart[] | null = null;
    if (clip.synth) src = { kind: 'synth', synth: clip.synth };
    else if (clip.parts) {
      const layout = beds.get(clip.id) ?? [];
      src = { kind: 'bed', parts: layout.length };
      parts = [];
      layout.forEach((p, i) => {
        // A part's place on the timeline, from the bed's clock (bed time `from` plays at `start`).
        const partStart = round(start + (p.at - from));
        const partEnd = round(partStart + (p.out - p.in));
        const next = layout[i + 1];
        const fades: ResolvedFades = { fadeIn: p.crossfade, fadeOut: next ? next.crossfade : 0, fadeInStart: partStart, fadeOutEnd: partEnd };
        const s = Math.max(partStart, start);
        const e = Math.min(partEnd, end);
        checkMedia(clip.id, `parts[${i}].out`, p.src, p.out);
        if (e <= s + EPS) return;
        parts?.push({ src: p.src, in: round(p.in + (s - partStart)), out: round(p.in + (e - partStart)), start: s, end: e, ...fades });
      });
    } else src = source(clip.src ?? '');
    if (!clip.parts) checkMedia(clip.id, 'out', src, out);
    const fades = fadesOf(clip.id, start, end, clip.fadeIn, clip.fadeOut);
    let volume: ResolvedKey[];
    const keys = volumeKeys.get(clip.id);
    if (keys) {
      volume = keys.map((k) => ({ t: resolveTime(k.ref), value: k.value }));
      checkOrder(clip.id, 'volume', volume.map((k) => k.t));
    } else {
      volume = [{ t: start, value: typeof clip.volume === 'number' ? clip.volume : 1 }];
    }
    const sync = clip.sync ? { source: clip.sync.source, at: round(clip.sync.source - from + start) } : null;
    return {
      kind, id: clip.id, label, start, end, src, in: from, out, volume, ...fades, filters, parts,
      segment: null, sync, layer: layerOf(clip.id, clip.layer, start),
    };
  };
  const resolvedMusic = music.map((m) => resolveAudio(m, 'music'));
  const resolvedSfx = sfx.map((m) => resolveAudio(m, 'sfx'));
  const clipsById = new Map([...resolvedMusic, ...resolvedSfx].map((c) => [c.id, c]));

  // Lines.
  const resolvedLines: ResolvedLine[] = lines.map((line: InSeconds<Line>) => {
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
    } else if (line.clip !== undefined) {
      const clip = clipsById.get(line.clip);
      if (clip && (start < clip.start - EPS || start > clip.end + EPS)) {
        fail({ code: 'outside-clip', id: line.id, field: 'in', message: `${line.id}: it starts at ${start} s, outside its clip ${clip.id} (${clip.start}–${clip.end} s)` });
      }
      const clipIn = clip?.in ?? 0;
      const clipStart = clip?.start ?? 0;
      toTimeline = (t) => clipStart + (t - clipIn);
      audio = { kind: 'clip', clip: line.clip };
    } else {
      const from = line.in ?? 0;
      const src = source(line.src);
      const out = round(from + Math.max(0, end - start));
      checkMedia(line.id, 'out', src, out);
      toTimeline = (t) => start + (t - from);
      audio = {
        kind: 'file', src, in: from, out, volume: line.volume ?? 1, filters: resolveFilters(line.filters),
        ...fadesOf(line.id, start, end, line.fadeIn, line.fadeOut), layer: layerOf(line.id, line.layer, start),
      };
    }
    const words: Word[] = [];
    for (const w of line.words ?? []) {
      const ws = round(toTimeline(w.start));
      const we = round(toTimeline(w.end));
      if (we > start + EPS && ws < end - EPS) words.push({ text: w.text, start: Math.max(ws, start), end: Math.min(we, end) });
    }
    return {
      kind: 'line', id: line.id, label: `${line.speaker}: ${line.text}`, start, end, speaker: line.speaker, text: line.text,
      sung: line.sung === true, delivery: line.delivery ?? null, audio, words,
    };
  });

  const length = graph.get(END_ANCHOR) ?? 0;

  // Overlays. Anything past the cut's end is cut off there (a fade out keeps its place).
  const resolvedOverlays: ResolvedOverlay[] = overlays.map((overlay: InSeconds<Overlay>) => {
    const timed = span(overlay.id);
    const start = timed.start;
    const end = Math.min(timed.end, length);
    if (start >= length - EPS) fail({ code: 'after-end', id: overlay.id, field: 'at', message: `${overlay.id} starts at ${start} s, at or after the cut ends (${length} s)` });
    else if (timed.end < start - EPS) fail({ code: 'negative-length', id: overlay.id, message: `${overlay.id} ends (${timed.end} s) before it starts (${start} s)` });
    checkStart(overlay.id, start);
    const fadeIn = overlay.fadeIn ?? 0;
    const fadeOut = overlay.fadeOut ?? 0;
    checkFades(overlay.id, timed.end - start, fadeIn, fadeOut);
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
    let opacity: ResolvedKey[] = [{ t: start, value: typeof overlay.opacity === 'number' ? overlay.opacity : 1 }];
    const oKeys = opacityKeys.get(overlay.id);
    if (oKeys && oKeys.length > 0) {
      opacity = oKeys.map((k) => ({ t: resolveTime(k.ref), value: k.value }));
      checkOrder(overlay.id, 'opacity', opacity.map((k) => k.t));
    }
    const scope = overlayScope.get(overlay.id);
    const segment = scope === undefined ? undefined : resolvedById.get(scope);
    if (segment) checkInside(overlay.id, 'at', start, timed.end, segment.id, segment.start, segment.end);
    // A wave's clock is the overlay's own: from its segment's start when it is in one, else from its start.
    const origin = segment ? segment.start : start;
    return {
      kind: 'overlay',
      id: overlay.id,
      label: overlay.label ?? overlay.id,
      start,
      end,
      src: source(overlay.src),
      segment: scope ?? null,
      width: overlay.width ?? null,
      height: overlay.height ?? null,
      motion,
      wave: { x: resolveWave(overlay.wave?.x, origin), y: resolveWave(overlay.wave?.y, origin) },
      opacity,
      fadeIn,
      fadeOut,
      fadeOutEnd: timed.end,
      blink: overlay.blink ?? null,
    };
  });

  const picture = { fadeIn: cut.picture?.fadeIn ?? 0, fadeOut: cut.picture?.fadeOut ?? 0 };
  checkFades('picture', length, picture.fadeIn, picture.fadeOut);
  if (cut.meta.length !== undefined && Math.abs(cut.meta.length - length) > 1e-3) {
    fail({ code: 'length-mismatch', field: 'meta.length', message: `meta.length is ${cut.meta.length} s but the segments add up to ${length} s` });
  }
  const sources: Record<SourceRef, ResolvedProvenance> = {};
  for (const [ref, p] of Object.entries(cut.sources ?? {})) {
    sources[ref] = {
      step: p.step ?? null,
      extendedFrom: p.extendedFrom === undefined ? null : source(p.extendedFrom),
      swappedFrom: p.swappedFrom === undefined ? null : source(p.swappedFrom),
      voice: p.voice ?? null,
      storyboard: p.storyboard ?? null,
      firstFrame: p.firstFrame === undefined ? null : source(p.firstFrame),
      notes: p.notes ?? null,
    };
  }
  const performances = resolvePerformances({
    performances: cut.performances ?? [],
    itemIds: new Set(kinds.keys()),
    lines: resolvedLines,
    segments: resolvedSegments,
    clips: [...resolvedMusic, ...resolvedSfx],
    sources: cut.sources ?? {},
    source,
    mediaLength: options.mediaLength,
    fail,
  });
  if (errors.length > 0) return { ok: false, errors };

  const items: TimelineItem[] = [...resolvedSegments, ...resolvedLines, ...resolvedMusic, ...resolvedSfx, ...resolvedOverlays];
  items.sort((a, b) => a.start - b.start);
  const at: Record<string, number> = {};
  for (const item of items) at[item.id] = item.start;

  return {
    ok: true,
    value: {
      meta: input.meta,
      length,
      output: cut.output === undefined ? null : joinPath(root, cut.output),
      items,
      segments: resolvedSegments,
      lines: resolvedLines,
      music: resolvedMusic,
      sfx: resolvedSfx,
      overlays: resolvedOverlays,
      picture,
      filters: { picture: [...(cut.picture?.filters ?? [])], mix: resolveMixFilters(cut.mix?.filters) },
      sources,
      at,
      performances,
      check: { thresholds: { ...cut.check?.thresholds } },
    },
  };
}
