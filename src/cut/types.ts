/**
 * The cut file: an edit written as data. One JSON file describes a whole clip
 * (its shots, dialogue, music, sound effects and overlays), and a renderer
 * compiles it into the video. See docs/cut-format.md.
 */

/** The value of a cut file's `format` field. */
export const CUT_FORMAT = 'mdmedia.cut@1';

/**
 * A time on the output timeline, in seconds.
 *
 * - A number is absolute: `3.2` is 3.2 s into the cut.
 * - A string is an anchor: `"stun"`, `"stun.end"`, `"stun+0.4"`, `"out-0.5"`,
 *   `"@end-0.45"`. `id` alone means the item's start. `@start` is 0 and
 *   `@end` is the end of the last segment.
 */
export type TimeRef = number | string;

/**
 * Where media comes from. A string with one of these forms:
 * - `take:<name>`: a generated take, found through `media.takes`;
 * - `color:<css color>`: a generated solid picture with no sound;
 * - anything else: a path relative to `media.root` (or absolute).
 */
export type SourceRef = string;

export interface CutFile {
  format: typeof CUT_FORMAT;
  meta: CutMeta;
  media: MediaRoots;
  /** The rendered file, relative to `media.root`. */
  output?: string;
  /** The picture track, played in order. */
  segments: Segment[];
  lines?: Line[];
  music?: AudioClip[];
  sfx?: AudioClip[];
  overlays?: Overlay[];
  /** Fades over the whole finished picture, after the overlays. Seconds. */
  picture?: PictureFades;
}

/**
 * A cut written as changes to another cut, its base: `extends` names a cut in
 * the same folder (`<name>.cut.json`). `extendCut` turns it into a full cut.
 *
 * - `meta` and `media` fields replace the base's, field by field; `output` and
 *   `picture` replace the base's whole.
 * - In each list, an item whose id is in the base's list replaces that item
 *   where it stands; any other item is added at the end. A segment's `after`
 *   places it after the segment with that id, or first with `"@start"`.
 * - `remove` drops items by id, from whichever list holds them.
 */
export interface CutExtension {
  format: typeof CUT_FORMAT;
  /** The base cut's name: its file stem, e.g. `bellamy-ranch-take6`. */
  extends: string;
  meta?: Partial<CutMeta>;
  media?: Partial<MediaRoots>;
  output?: string;
  segments?: ExtensionSegment[];
  lines?: Line[];
  music?: AudioClip[];
  sfx?: AudioClip[];
  overlays?: Overlay[];
  picture?: PictureFades;
  remove?: string[];
}

/** A segment in an extension, which can say where it goes. */
export type ExtensionSegment = Segment & {
  /** Put the segment after the segment with this id, or first with `"@start"`. */
  after?: string;
};

export interface CutMeta {
  title: string;
  /** The show's key, e.g. `night-wagon`. */
  show?: string;
  /** A human version label, e.g. "Take 9 (opens on the road)". */
  version?: string;
  /** The expected output length in seconds. When set, the resolver checks it. */
  length?: number;
  fps: number;
  width: number;
  height: number;
  notes?: string;
}

export interface MediaRoots {
  /** Base for every relative path. Absolute, or relative to the cut file's folder. */
  root: string;
  /** Path pattern for `take:<name>` sources. Default `takes/{name}.mp4`. */
  takes?: string;
}

export interface Crop {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Segment {
  /** Stable id, used by anchors. Letters, digits and underscores. */
  id: string;
  /** A human label for the timeline. */
  label?: string;
  src: SourceRef;
  /** Source time where the shot starts, seconds. */
  in: number;
  /** Source time where the shot ends, seconds. */
  out: number;
  /** Where the segment starts. Default: the end of the previous segment (0 for the first). */
  at?: TimeRef;
  /** Freeze the last frame (at `out`) for this many seconds. */
  hold?: number;
  /** The segment's length when it is not `out - in + hold`. Required with `loop`. */
  duration?: number;
  /** Anchor the segment's end instead. The time past `out - in` is a hold (or more loop). */
  end?: TimeRef;
  /** `pingpong` plays in→out, out→in, in→out, … until the segment's length. */
  loop?: 'pingpong';
  /** Crop in source pixels; the result is scaled to the output size. */
  crop?: Crop;
  /** Picture fade from black at the segment's start, seconds. */
  fadeIn?: number;
  /** Picture fade to black at the segment's end, seconds. */
  fadeOut?: number;
  /**
   * The segment's sound. Default: the picture source's own audio over the same
   * `in`/`out`, at full volume. `false` makes the segment silent.
   */
  audio?: SegmentAudio | false;
  /** A push-in: the picture scaled about a fixed point, after the segment's own overlays are drawn. */
  zoom?: Zoom;
}

/**
 * A time inside a segment: a number is seconds from the segment's start; a
 * string is an anchor on the timeline, as anywhere else (`"tag.end"`).
 */
export type SegmentTimeRef = TimeRef;

/** A zoom keyframe: the picture's scale at a time in the segment. */
export interface ZoomKey {
  at: SegmentTimeRef;
  /** 1 is the picture as framed; 1.2 is 20 % larger. At least 1. */
  scale: number;
}

/**
 * A point of the segment's picture, as framed in the output (after any crop
 * and scaling): output pixels by default, or fractions of the width and height
 * with `unit: "fraction"`.
 */
export interface FocusPoint {
  x: number;
  y: number;
  unit?: 'px' | 'fraction';
}

/**
 * Scales a segment's picture about `focus`, which stays where it is on screen.
 * The scale is linear between keys and held before the first and after the last.
 */
export interface Zoom {
  /** Default: the middle of the picture. */
  focus?: FocusPoint;
  keys: ZoomKey[];
}

/**
 * Sound that belongs to a segment. It plays once from the segment's start and
 * never holds or loops; it is cut at the segment's end and is silent after its
 * own `out`.
 */
export interface SegmentAudio {
  /** Default: the segment's `src`. */
  src?: SourceRef;
  /** Default: the segment's `in`. */
  in?: number;
  /** Default: `in` plus the segment's `out - in`. */
  out?: number;
  /** Gain, 1 is unchanged. Default 1. */
  volume?: number;
  fadeIn?: number;
  fadeOut?: number;
}

/** A spoken word, in the audio's own clock (see `Line.words`). */
export interface Word {
  text: string;
  start: number;
  end: number;
}

interface LineBase {
  id: string;
  speaker: string;
  text: string;
  /** Cut the line off here if it is still playing. */
  until?: TimeRef;
  /**
   * Word timings, usually from a transcript. Times are in the audio's own
   * clock: the file's time for a TTS line, the source take's time for a line
   * from a segment. The resolver maps them onto the timeline.
   */
  words?: Word[];
}

/**
 * A line with its own sound: a TTS file, or a stretch of another take
 * (`take:<name>` with `in` and `out`). Its words are in that source's clock.
 */
export interface FileLine extends LineBase {
  src: SourceRef;
  at: TimeRef;
  /** Source time the line's sound starts from, seconds. Default 0. */
  in?: number;
  /** Source time the line's sound stops at. Default: the end of the source. */
  out?: number;
  /** The source's length in seconds, if known. A probe given to the resolver overrides it. */
  duration?: number;
  /** Gain, applied after `filters`. Default 1. */
  volume?: number;
  /** Applied in order, before `volume`. */
  filters?: AudioFilter[];
  segment?: never;
}

/** A line spoken on camera, heard in a segment's own audio. It adds no sound. */
export interface SegmentLine extends LineBase {
  /** The segment whose audio carries the line. */
  segment: string;
  /** Default: the segment's start. */
  at?: TimeRef;
  src?: never;
}

export type Line = FileLine | SegmentLine;

/** A value at a time, linear to the next key. Two keys at the same time make a jump. */
export interface VolumeKey {
  at: TimeRef;
  value: number;
}

/** An opacity keyframe, 0 to 1. Linear between keys; two keys at the same time make a jump. */
export type OpacityKey = VolumeKey;

/** Cuts everything below `frequency` Hz. */
export interface HighpassFilter {
  kind: 'highpass';
  frequency: number;
}

/** Cuts everything above `frequency` Hz. */
export interface LowpassFilter {
  kind: 'lowpass';
  frequency: number;
}

/** Reduces the bit depth, mixed with the dry sound: a cheap speaker's grit. */
export interface CrushFilter {
  kind: 'crush';
  /** 1 to 64. */
  bits: number;
  /** How much of the crushed sound is heard, 0 to 1. Default 1. */
  mix?: number;
}

/** One echo: the sound again `delay` seconds later, at `decay` of its level. */
export interface EchoFilter {
  kind: 'echo';
  /** Gain into the echo, 0 to 1. */
  inGain: number;
  /** Gain of the result, 0 to 1. */
  outGain: number;
  /** Seconds. */
  delay: number;
  /** The echo's level against the sound, 0 to 1. */
  decay: number;
}

/** A sound filter on a line or an audio clip, applied in list order. */
export type AudioFilter = HighpassFilter | LowpassFilter | CrushFilter | EchoFilter;

/** A relay-style tick: a short decaying tone at the start of every period. */
export interface TickSynth {
  kind: 'tick';
  /** Seconds between ticks. */
  period: number;
  /** Tone frequencies in Hz, one per tick, cycling. */
  tones: number[];
  /** Length of each tick, seconds. */
  click: number;
  /** Exponential decay rate per second within a tick. */
  decay: number;
  /** Peak amplitude, 0 to 1. */
  gain: number;
}

export type Synth = TickSynth;

/**
 * Music, stings and sound effects. Exactly one of `src` or `synth`.
 * Plays from `at`; it stops when its natural length runs out (`duration`,
 * else `out - in`, else the probed media length) or at `until`, whichever is first.
 */
export interface AudioClip {
  id: string;
  label?: string;
  src?: SourceRef;
  synth?: Synth;
  /** Source offset, seconds. Default 0. */
  in?: number;
  out?: number;
  at: TimeRef;
  until?: TimeRef;
  duration?: number;
  /** A constant gain, or keyframes on the timeline, linear between them. Default 1. */
  volume?: number | VolumeKey[];
  fadeIn?: number;
  fadeOut?: number;
  /** Applied in order, before `volume` and the fades. */
  filters?: AudioFilter[];
}

export interface MotionKey {
  at: TimeRef;
  x?: number;
  y?: number;
}

export interface Blink {
  /** Seconds per on-off cycle. */
  period: number;
  /** Seconds visible at the start of each cycle, counted from the overlay's start. */
  on: number;
}

/**
 * A value that swings: `center + amplitude · sin(2π(t − phase) / period)`, or
 * `cos` with `shape: "cos"`. `t` is the overlay's own clock: seconds from its
 * start, or from its segment's start for an overlay in a segment.
 */
export interface Wave {
  /** Default `sin`. */
  shape?: 'sin' | 'cos';
  center: number;
  /** Negative flips the swing. */
  amplitude: number;
  /** Seconds per cycle. */
  period: number;
  /** Seconds the wave is delayed by. Default 0. */
  phase?: number;
}

/** A PNG over the picture. Plays from `at` until `until` or for `duration`. */
export interface Overlay {
  id: string;
  label?: string;
  src: SourceRef;
  /**
   * The segment this overlay is drawn into, before the segment's zoom, so it
   * zooms with the picture. Its times are then segment times (a number is
   * seconds from the segment's start), and it must lie inside the segment.
   */
  segment?: string;
  /** Required unless the overlay is in a segment, where it defaults to the segment's start. */
  at?: TimeRef;
  /** For an overlay in a segment, defaults to the segment's end. */
  until?: TimeRef;
  duration?: number;
  /** Top-left position in output pixels. Default 0, 0. */
  x?: number;
  y?: number;
  /** Drawn size in output pixels. Default: the image's own; with only one, the other keeps the image's aspect. */
  width?: number;
  height?: number;
  /** Position keyframes on the timeline, linear between them. Overrides `x`/`y` where given. */
  motion?: MotionKey[];
  /** An axis that swings, instead of following `x`/`y` and `motion`. */
  wave?: { x?: Wave; y?: Wave };
  /** A constant alpha, or keyframes, linear between them (two at one time make a jump). Default 1. */
  opacity?: number | OpacityKey[];
  /** Alpha fades, seconds. */
  fadeIn?: number;
  fadeOut?: number;
  blink?: Blink;
}

export interface PictureFades {
  fadeIn?: number;
  fadeOut?: number;
}

// ---------------------------------------------------------------------------
// The resolved timeline: every item with absolute times and paths.

export type ResolvedSource =
  | { kind: 'take'; ref: SourceRef; name: string; path: string }
  | { kind: 'file'; ref: SourceRef; path: string }
  | { kind: 'color'; ref: SourceRef; color: string }
  | { kind: 'synth'; synth: Synth };

interface ResolvedBase {
  id: string;
  label: string;
  start: number;
  end: number;
}

export interface ResolvedSegmentAudio {
  src: ResolvedSource;
  in: number;
  out: number;
  volume: number;
  fadeIn: number;
  fadeOut: number;
  start: number;
  end: number;
}

export interface ResolvedZoom {
  /** The fixed point, in output pixels of the picture as framed. */
  focus: { x: number; y: number };
  /** Scale keyframes on the timeline. */
  keys: ResolvedKey[];
}

export interface ResolvedSegment extends ResolvedBase {
  kind: 'segment';
  index: number;
  src: ResolvedSource;
  in: number;
  out: number;
  /** Seconds of freeze on the last frame. 0 for a loop. */
  hold: number;
  loop: 'pingpong' | null;
  crop: Crop | null;
  fadeIn: number;
  fadeOut: number;
  audio: ResolvedSegmentAudio | null;
  /** The push-in, or null when the picture isn't zoomed. */
  zoom: ResolvedZoom | null;
}

/** An audio filter with its defaults filled in. */
export type ResolvedAudioFilter = HighpassFilter | LowpassFilter | (CrushFilter & { mix: number }) | EchoFilter;

export type ResolvedLineAudio =
  | {
      kind: 'file';
      src: ResolvedSource;
      /** Source seconds the line plays from. */
      in: number;
      /** `in` plus the played length. */
      out: number;
      volume: number;
      filters: ResolvedAudioFilter[];
    }
  | { kind: 'segment'; segment: string };

export interface ResolvedLine extends ResolvedBase {
  kind: 'line';
  speaker: string;
  text: string;
  audio: ResolvedLineAudio;
  /** Words on the timeline, clipped to the line. Empty when no timings are known. */
  words: Word[];
}

export interface ResolvedKey {
  t: number;
  value: number;
}

export interface ResolvedAudio extends ResolvedBase {
  kind: 'music' | 'sfx';
  src: ResolvedSource;
  in: number;
  /** `in` plus the played length. */
  out: number;
  /** Gain keyframes on the timeline. A constant volume is one key. */
  volume: ResolvedKey[];
  fadeIn: number;
  fadeOut: number;
  filters: ResolvedAudioFilter[];
}

export interface ResolvedMotionKey {
  t: number;
  x: number;
  y: number;
}

/** A wave with its defaults filled in, and the timeline time its clock starts at. */
export interface ResolvedWave {
  shape: 'sin' | 'cos';
  center: number;
  amplitude: number;
  period: number;
  phase: number;
  /** The timeline time where the wave's `t` is 0. */
  origin: number;
}

export interface ResolvedOverlay extends ResolvedBase {
  kind: 'overlay';
  src: ResolvedSource;
  /** The segment it is drawn into (before that segment's zoom), or null when it is over the finished picture. */
  segment: string | null;
  /** Drawn size in output pixels; null keeps the image's own (or its aspect). */
  width: number | null;
  height: number | null;
  /** Position keyframes; one key when the overlay doesn't move. */
  motion: ResolvedMotionKey[];
  /** Axes that swing; on its axis a wave wins over `motion`. */
  wave: { x: ResolvedWave | null; y: ResolvedWave | null };
  /** Opacity keyframes on the timeline; one key when it is constant. */
  opacity: ResolvedKey[];
  fadeIn: number;
  fadeOut: number;
  blink: Blink | null;
}

export type TimelineItem = ResolvedSegment | ResolvedLine | ResolvedAudio | ResolvedOverlay;

export interface Timeline {
  meta: CutMeta;
  /** The end of the last segment. */
  length: number;
  output: string | null;
  /** Every item, sorted by start. */
  items: TimelineItem[];
  segments: ResolvedSegment[];
  lines: ResolvedLine[];
  music: ResolvedAudio[];
  sfx: ResolvedAudio[];
  overlays: ResolvedOverlay[];
  picture: { fadeIn: number; fadeOut: number };
  /** Every item's start, by id. */
  at: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Errors

export type CutErrorCode =
  | 'bad-shape'
  | 'bad-id'
  | 'duplicate-id'
  | 'bad-anchor'
  | 'unknown-anchor'
  | 'unknown-segment'
  | 'cycle'
  | 'conflicting-fields'
  | 'out-before-in'
  | 'negative-in'
  | 'negative-length'
  | 'negative-hold'
  | 'loop-needs-length'
  | 'unknown-length'
  | 'overlap'
  | 'before-start'
  | 'fade-too-long'
  | 'keyframes-unordered'
  | 'out-past-media'
  | 'no-segments'
  | 'length-mismatch'
  | 'outside-segment'
  | 'bad-value'
  | 'unknown-item'
  | 'extends-cycle';

export interface CutError {
  code: CutErrorCode;
  message: string;
  /** The item the error is about. */
  id?: string;
  /** The field the error is about, e.g. `at` or `volume[2].at`. */
  field?: string;
  /** For `cycle`: the chain of time points, e.g. `["a.start", "b.end", "a.start"]`. */
  cycle?: string[];
}

export type CutResult<T> = { ok: true; value: T } | { ok: false; errors: CutError[] };
