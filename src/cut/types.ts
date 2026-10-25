/**
 * The cut file: an edit written as data. One JSON file describes a whole clip
 * (its shots, dialogue, music, sound effects and overlays), and a renderer
 * compiles it into the video. See docs/cut-format.md.
 */

/** The value of a cut file's `format` field. */
export const CUT_FORMAT = 'mdmedia.cut@1';

/** The prefix of an opaque stored source, `asset:<id>` (see `SourceRef`). */
export const ASSET_PREFIX = 'asset:';

/**
 * A whole number of frames at the cut's `meta.fps`, written `"f191"`. At
 * 24 fps, `"f191"` is 191 / 24 = 7.958333 s.
 */
export type FrameCount = `f${number}`;

/** A length or a source time: seconds, or frames at `meta.fps` (`"f191"`). */
export type Seconds = number | FrameCount;

/**
 * A time on the output timeline, in seconds.
 *
 * - A number is absolute: `3.2` is 3.2 s into the cut.
 * - A string is an anchor: `"stun"`, `"stun.end"`, `"stun+0.4"`, `"out-0.5"`,
 *   `"@end-0.45"`. `id` alone means the item's start. `@start` is 0 and
 *   `@end` is the end of the last segment.
 * - Frames at `meta.fps` work too: `"f191"` is frame 191, and an offset can be
 *   frames, as in `"stun+f12"`.
 */
export type TimeRef = number | string;

/**
 * Where media comes from. A string with one of these forms:
 * - `take:<name>`: a generated take, found through `media.takes`;
 * - `color:<css color>`: a generated solid picture with no sound;
 * - `asset:<id>`: a file stored somewhere else, such as a Studio media asset.
 *   The resolver passes it through untouched; whoever plays or renders the
 *   cut maps the id to its bytes;
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
  /** The whole finished picture: its look (`filters`), then its fades, after the overlays. */
  picture?: PictureSettings;
  /** The whole mix: processing applied to the sum of every sound, last. */
  mix?: MixSettings;
  /** Where each source came from, by its `src` as written. Optional, and only recorded. */
  sources?: Record<SourceRef, SourceProvenance>;
  /**
   * Groups of lines that must sound like one continuous delivery, each with
   * its intent and delivery direction. Optional; it changes nothing in the
   * edit. `mdmedia cut check` measures and listens to them.
   */
  performances?: Performance[];
  /** Settings for `mdmedia cut check`: the thresholds its measured flags use. */
  check?: CheckSettings;
}

/**
 * A cut written as changes to another cut, its base: `extends` names a cut in
 * the same folder (`<name>.cut.json`). `extendCut` turns it into a full cut.
 *
 * - `meta` and `media` fields replace the base's, field by field; `output`,
 *   `picture` and `mix` replace the base's whole; `sources` entries replace
 *   the base's by source; `check.thresholds` replace the base's field by
 *   field. Performances merge by id like the lists below.
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
  picture?: PictureSettings;
  mix?: MixSettings;
  sources?: Record<SourceRef, SourceProvenance>;
  performances?: Performance[];
  check?: CheckSettings;
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

/**
 * How a source was made, for tracing a take back to its generation. Nothing
 * here changes the edit; the resolver passes it through.
 */
export interface SourceProvenance {
  /**
   * The generation step that made it: `generate` (a fresh generation from a
   * storyboard, or from a still), `extend` (another take continued, returned
   * as one file), `compose` (our graphics or edit laid over another file),
   * or `swap` (another take's speech converted to a character's voice, the
   * picture and timing unchanged; see docs/characters.md).
   */
  step?: 'generate' | 'extend' | 'compose' | 'swap';
  /** The take this one was extended from, or the file it was composed over. */
  extendedFrom?: SourceRef;
  /** For a `swap`: the take whose speech was converted. It is the same generation, so the same performance. */
  swappedFrom?: SourceRef;
  /** For a `swap`: the voice it was converted to, a character version (`chet@1`) or a provider voice name. */
  voice?: string;
  /** The storyboard (prompt) name it was generated from, e.g. `ch-meridian-2`. */
  storyboard?: string;
  /** The still it was started from (its first frame). */
  firstFrame?: SourceRef;
  notes?: string;
}

/**
 * Lines that must sound like one continuous delivery: a sentence split over
 * several lines, or a setup and its payoff. A line is in at most one
 * performance. By the splitting rule, a performance's lines should all come
 * from one generation (see `ResolvedPerformance.splits`).
 */
export interface Performance {
  /** Letters, digits and underscores, unique across the whole file. */
  id: string;
  label?: string;
  /** Its line ids, in the order they are spoken. At least one. */
  lines: string[];
  /** What it is for, e.g. "setup and punchline". */
  intent?: string;
  /** How it is delivered, e.g. "an ordinary selling point, one breath, no pause before 'wheels'". */
  delivery?: string;
  /** This performance's own check thresholds, over the cut's `check.thresholds`. */
  thresholds?: CheckThresholds;
}

/**
 * How big a jump `mdmedia cut check` flags. Each is optional; the cut's
 * values override the defaults (`DEFAULT_THRESHOLDS`), and a performance's
 * override the cut's.
 */
export interface CheckThresholds {
  /** Loudness change across a boundary between a performance's lines, in LU. */
  loudness?: number;
  /** Median pitch change across a boundary, in semitones. */
  pitch?: number;
  /** Speech-rate change across a boundary, as a fraction of the slower line's rate (0.35 is 35 %). */
  rate?: number;
  /** The pause between two of a performance's lines, in seconds. */
  pause?: number;
  /** Room-tone level change across a segment cut inside a performance, in dB. */
  roomTone?: number;
  /** A word louder than the median word of its performance by this many LU. */
  word?: number;
}

export interface CheckSettings {
  thresholds?: CheckThresholds;
}

export interface Crop {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface SegmentBase {
  /** Stable id, used by anchors. Letters, digits and underscores. */
  id: string;
  /** A human label for the timeline. */
  label?: string;
  src: SourceRef;
  /** Where the segment starts. Default: the end of the previous segment (0 for the first). */
  at?: TimeRef;
  /** Crop in source pixels; the result is scaled to the output size. */
  crop?: Crop;
  /** Picture fade from black at the segment's start, seconds. */
  fadeIn?: number;
  /** Picture fade to black at the segment's end, seconds. */
  fadeOut?: number;
  /**
   * The segment's sound. Default: the picture source's own audio over the same
   * `in`/`out`, at full volume (a still has none). `false` makes it silent.
   */
  audio?: SegmentAudio | false;
  /** A push-in: the picture scaled about a fixed point, after the segment's own overlays are drawn. */
  zoom?: Zoom;
  /**
   * Fades over the segment's whole sound: its own audio and every line, music
   * or sound effect laid into it with `layer`, faded together at the
   * segment's start and end.
   */
  mix?: SegmentMix;
}

/** A shot: a stretch of a video source. */
export interface ShotSegment extends SegmentBase {
  still?: false;
  /** Source time where the shot starts. */
  in: Seconds;
  /** Source time where the shot ends. */
  out: Seconds;
  /** Freeze the last frame (at `out`) for this long. */
  hold?: Seconds;
  /** The segment's length when it is not `out - in + hold`. Required with `loop`. */
  duration?: Seconds;
  /** Anchor the segment's end instead. The time past `out - in` is a hold (or more loop). */
  end?: TimeRef;
  /** `pingpong` plays in→out, out→in, in→out, … until the segment's length. */
  loop?: 'pingpong';
}

/** A still image (a PNG or JPEG) held for a length: `duration`, or until `end`. */
export interface StillSegment extends SegmentBase {
  still: true;
  duration?: Seconds;
  end?: TimeRef;
  in?: never;
  out?: never;
  hold?: never;
  loop?: never;
}

export type Segment = ShotSegment | StillSegment;

/** Fades over everything heard in a segment, together. Seconds. */
export interface SegmentMix {
  fadeIn?: number;
  fadeOut?: number;
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
  /** Default: the segment's `src`. Not with `synth`. */
  src?: SourceRef;
  /** A generated sound instead of a file (its clock starts at 0). */
  synth?: Synth;
  /** Default: the segment's `in` (0 for a synth). */
  in?: Seconds;
  /** Default: `in` plus the segment's `out - in` (for a synth or a still, the segment's length). */
  out?: Seconds;
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
   * Sung rather than spoken. `mdmedia cut words` doesn't snap a sung line's
   * first word to the speech onset or warn about its loss, and marks its words
   * approximate.
   */
  sung?: boolean;
  /**
   * How this line is delivered, in words: a note for whoever generates or
   * checks it, e.g. "the same note and loudness as 'comes with'". Changes
   * nothing in the edit.
   */
  delivery?: string;
  /**
   * Word timings, usually from a transcript. Times are in the audio's own
   * clock: the file's time for a TTS line, the source take's time for a line
   * from a segment. The resolver maps them onto the timeline.
   */
  words?: Word[];
}

/**
 * A fade timed to an anchor instead of to the item's own start or end: a fade
 * in from `start`, or a fade out that reaches silence at `end`, whether or not
 * the item is still playing there.
 */
export interface AnchoredFadeIn {
  duration: number;
  start: TimeRef;
}

export interface AnchoredFadeOut {
  duration: number;
  end: TimeRef;
}

/**
 * A line with its own sound: a TTS file, or a stretch of another take
 * (`take:<name>` with `in` and `out`). Its words are in that source's clock.
 */
export interface FileLine extends LineBase {
  src: SourceRef;
  at: TimeRef;
  /** Source time the line's sound starts from. Default 0. */
  in?: Seconds;
  /** Source time the line's sound stops at. Default: the end of the source. */
  out?: Seconds;
  /** The source's length, if known. A probe given to the resolver overrides it. */
  duration?: Seconds;
  /** Gain, applied after `filters`. Default 1. */
  volume?: number;
  /** Applied in order, before `volume`. */
  filters?: AudioFilter[];
  /** Seconds at its start, or a fade timed to an anchor. */
  fadeIn?: number | AnchoredFadeIn;
  /** Seconds at its end, or a fade timed to an anchor. */
  fadeOut?: number | AnchoredFadeOut;
  /** Mixed into this segment's sound: cut at its end and faded with its `mix`. */
  layer?: string;
  segment?: never;
  clip?: never;
}

/** A line spoken on camera, heard in a segment's own audio. It adds no sound. */
export interface SegmentLine extends LineBase {
  /** The segment whose audio carries the line. */
  segment: string;
  /** Default: the segment's start. */
  at?: TimeRef;
  src?: never;
  clip?: never;
}

/**
 * A line heard in a music or sound-effect clip, such as a sung lyric. It adds
 * no sound and follows the clip's clock: `in` and `out` are times in the
 * clip's source, so moving the clip moves the line.
 */
export interface ClipLine extends LineBase {
  /** The music or sfx clip whose sound carries the line. */
  clip: string;
  /** Source time in the clip's audio where the line starts. Default: where the clip starts. */
  in?: Seconds;
  /** Source time where it ends. Default: where the clip ends. */
  out?: Seconds;
  src?: never;
  segment?: never;
}

export type Line = FileLine | SegmentLine | ClipLine;

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

/** A peak limiter: the sound never goes above `limit` (linear, 0 to 1, of full scale). */
export interface LimiterFilter {
  kind: 'limiter';
  limit: number;
}

/** Processing over the whole mix, in list order. */
export type MixFilter = AudioFilter | LimiterFilter;

export interface MixSettings {
  filters?: MixFilter[];
}

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

/** A steady sine tone, `gain · sin(2π·frequency·t)`, for as long as it plays. */
export interface ToneSynth {
  kind: 'tone';
  /** Hz. */
  frequency: number;
  /** Peak amplitude, 0 to 1. */
  gain: number;
}

export type Synth = TickSynth | ToneSynth;

/**
 * One pass of a bed's source. Each part starts where the one before it ends,
 * less its `crossfade`: the two overlap for that long, one fading out as the
 * other fades in (linearly).
 */
export interface BedPart {
  src: SourceRef;
  /** Source time it plays from. Default 0. */
  in?: Seconds;
  /** Source time it stops at. Default: the end of the source (probed, or `in + duration`). */
  out?: Seconds;
  /** Its length when there is no `out` and no probe. */
  duration?: Seconds;
  /** Seconds it overlaps the part before it. Default 0; the first part has none. */
  crossfade?: number;
}

/**
 * Places a clip so that a moment in its source lands on a time in the cut:
 * `source` (seconds in the file) plays at `at`. With the clip's own `at`, the
 * resolver works out its `in`; with its `in`, it works out where it starts.
 */
export interface AudioSync {
  source: Seconds;
  at: TimeRef;
}

/**
 * Music, stings and sound effects. Exactly one of:
 * - `src`: a file or a take;
 * - `synth`: a generated sound;
 * - `parts`: a bed, several passes of sound played one after another with
 *   crossfades, treated as one clip with one volume curve;
 * - `segment`: sound heard in that segment's own audio. It labels the
 *   timeline (as a segment line does for speech) and adds no sound, so it
 *   takes no `in`, `out`, `volume`, fades or filters.
 *
 * It plays from `at`; it stops when its natural length runs out (`duration`,
 * else `out - in`, else the probed media length) or at `until`, whichever is first.
 */
export interface AudioClip {
  id: string;
  label?: string;
  src?: SourceRef;
  synth?: Synth;
  parts?: BedPart[];
  segment?: string;
  /** Source offset. Default 0; worked out from `sync` when it has one. */
  in?: Seconds;
  out?: Seconds;
  /**
   * Required, except for a clip in a segment (default: the segment's start) or
   * one placed by its `sync` and `in`.
   */
  at?: TimeRef;
  until?: TimeRef;
  duration?: Seconds;
  /** Places the clip by a moment in its source; see `AudioSync`. */
  sync?: AudioSync;
  /**
   * A constant gain, or keyframes on the timeline, linear between them.
   * Keys may lie outside the clip, as a duck that ends after it does. Default 1.
   */
  volume?: number | VolumeKey[];
  /** Seconds at its start, or a fade timed to an anchor. */
  fadeIn?: number | AnchoredFadeIn;
  /** Seconds at its end, or a fade timed to an anchor. */
  fadeOut?: number | AnchoredFadeOut;
  /** Applied in order, before `volume` and the fades. */
  filters?: AudioFilter[];
  /** Mixed into this segment's sound: cut at its end and faded with its `mix`. */
  layer?: string;
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

/**
 * A PNG over the picture. It is drawn on every frame from `at` through
 * `until` (or for `duration`), both ends included: an overlay until 14.0 s is
 * on the frame at 14.0 s. Anything past the cut's end is cut off.
 */
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
  duration?: Seconds;
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

/** Scales the picture down to `width` × `height` and back up to the output size, which softens it. */
export interface RescaleFilter {
  kind: 'rescale';
  width: number;
  height: number;
}

/** A pixel offset. */
export interface Offset {
  x?: number;
  y?: number;
}

/** Shifts the colour planes against the brightness, in pixels: the smear of tape. */
export interface ChromaShiftFilter {
  kind: 'chroma-shift';
  /** The blue-difference plane (Cb). */
  cb?: Offset;
  /** The red-difference plane (Cr). */
  cr?: Offset;
}

/** Saturation, contrast, gamma and brightness. 1 (0 for brightness) is unchanged. */
export interface ColorFilter {
  kind: 'color';
  saturation?: number;
  contrast?: number;
  gamma?: number;
  /** -1 to 1. */
  brightness?: number;
}

/** A shift of red, green and blue, each -1 to 1. */
export interface ColorShift {
  r?: number;
  g?: number;
  b?: number;
}

/** Colour balance by tonal range. */
export interface ColorBalanceFilter {
  kind: 'color-balance';
  shadows?: ColorShift;
  midtones?: ColorShift;
  highlights?: ColorShift;
}

/** Film or tape grain: noise of `strength` (0 to 100, ffmpeg's noise scale), new on every frame unless `moving` is false. */
export interface GrainFilter {
  kind: 'grain';
  strength: number;
  /** Default true. */
  moving?: boolean;
}

/** A look applied to the whole finished picture, in list order. */
export type PictureFilter = RescaleFilter | ChromaShiftFilter | ColorFilter | ColorBalanceFilter | GrainFilter;

export interface PictureSettings extends PictureFades {
  /** Applied over the finished picture, overlays included, before the fades. */
  filters?: PictureFilter[];
}

// ---------------------------------------------------------------------------
// The resolved timeline: every item with absolute times and paths.

export type ResolvedSource =
  | { kind: 'take'; ref: SourceRef; name: string; path: string }
  | { kind: 'file'; ref: SourceRef; path: string }
  | { kind: 'color'; ref: SourceRef; color: string }
  /** An opaque stored file, `asset:<id>`. It has no path; its id names it. */
  | { kind: 'asset'; ref: SourceRef; id: string }
  | { kind: 'synth'; synth: Synth }
  /** A bed: its sound is its `parts` (see `ResolvedAudio.parts`). */
  | { kind: 'bed'; parts: number };

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
  /** A still image held for the segment's length (its `in` and `out` are 0 and its `hold` the length). */
  still: boolean;
  in: number;
  out: number;
  /** Seconds of freeze on the last frame. 0 for a loop. */
  hold: number;
  loop: 'pingpong' | null;
  crop: Crop | null;
  fadeIn: number;
  fadeOut: number;
  audio: ResolvedSegmentAudio | null;
  /** Fades over the segment's whole sound (its audio and its layers). 0 when there are none. */
  mix: { fadeIn: number; fadeOut: number };
  /** The push-in, or null when the picture isn't zoomed. */
  zoom: ResolvedZoom | null;
}

/** An audio filter with its defaults filled in. */
export type ResolvedAudioFilter = HighpassFilter | LowpassFilter | (CrushFilter & { mix: number }) | EchoFilter;

/** A mix filter with its defaults filled in. */
export type ResolvedMixFilter = ResolvedAudioFilter | LimiterFilter;

/** The segment a sound is a layer of: its span and its mix fades, so the sound's gain can be worked out alone. */
export interface ResolvedLayer {
  segment: string;
  start: number;
  end: number;
  fadeIn: number;
  fadeOut: number;
}

/**
 * Fades on the timeline. `fadeIn` and `fadeOut` are their lengths; the fade in
 * runs from `fadeInStart` and the fade out reaches silence at `fadeOutEnd`,
 * which are the item's start and end unless the fade was anchored.
 */
export interface ResolvedFades {
  fadeIn: number;
  fadeOut: number;
  fadeInStart: number;
  fadeOutEnd: number;
}

export type ResolvedLineAudio =
  | ({
      kind: 'file';
      src: ResolvedSource;
      /** Source seconds the line plays from. */
      in: number;
      /** `in` plus the played length. */
      out: number;
      volume: number;
      filters: ResolvedAudioFilter[];
      /** The segment it is mixed into, or null. */
      layer: ResolvedLayer | null;
    } & ResolvedFades)
  | { kind: 'segment'; segment: string }
  /** Heard in a music or sfx clip; it adds no sound. */
  | { kind: 'clip'; clip: string };

export interface ResolvedLine extends ResolvedBase {
  kind: 'line';
  speaker: string;
  text: string;
  sung: boolean;
  /** Its delivery note, or null. */
  delivery: string | null;
  audio: ResolvedLineAudio;
  /** Words on the timeline, clipped to the line. Empty when no timings are known. */
  words: Word[];
}

export interface ResolvedKey {
  t: number;
  value: number;
}

/** One pass of a bed, on the timeline. Its crossfades are its own fades in and out. */
export interface ResolvedBedPart extends ResolvedFades {
  src: ResolvedSource;
  /** Source seconds it plays from and to, within the clip's span. */
  in: number;
  out: number;
  /** Where it plays on the timeline, within the clip's span. */
  start: number;
  end: number;
  /**
   * `fadeIn` is the crossfade from the part before (from `fadeInStart`, where
   * the part would start), `fadeOut` the crossfade into the part after (to
   * `fadeOutEnd`, where it would end), both 0 when there is none.
   */
}

export interface ResolvedAudio extends ResolvedBase, ResolvedFades {
  kind: 'music' | 'sfx';
  /**
   * The sound: a file, take or asset, a synth, a bed (see `parts`), or for a
   * clip heard in a segment's sound, that segment's audio source.
   */
  src: ResolvedSource;
  /** Source seconds it plays from (for a bed, seconds into the bed). */
  in: number;
  /** `in` plus the played length. */
  out: number;
  /** Gain keyframes on the timeline. A constant volume is one key. */
  volume: ResolvedKey[];
  filters: ResolvedAudioFilter[];
  /** For a bed: its passes, cut to the clip's span. Null otherwise. */
  parts: ResolvedBedPart[] | null;
  /** The segment whose own sound this is, when it is a label on it (it adds no sound); else null. */
  segment: string | null;
  /** The sync point it was placed by, on the timeline, or null. */
  sync: { source: number; at: number } | null;
  /** The segment it is mixed into, or null. */
  layer: ResolvedLayer | null;
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
  /**
   * Where the fade out reaches 0: its `end`, or past it for an overlay timed
   * past the cut's end, whose `end` is cut to the cut's length.
   */
  fadeOutEnd: number;
  blink: Blink | null;
}

/**
 * One generation a performance's lines come from: a source, or one side of
 * an extended take's seam (an extend returns the take it continued plus the
 * new tail, so the first part is the original generation).
 */
export interface PerformanceGeneration {
  /** The generation's key: the source ref, or `<ref>@<seam>` for an extended take's new tail. */
  key: string;
  /** The source the lines are heard in, as written. */
  source: SourceRef;
  /**
   * `whole`: a plain generation. `original` and `extension`: before or after
   * an extended take's seam. `unknown`: an extended take whose seam isn't
   * known (its original's length wasn't given to the resolver).
   */
  part: 'whole' | 'original' | 'extension' | 'unknown';
  /** The take it was extended from, for `original`. */
  extendedFrom: SourceRef | null;
  /** Where the seam is in the source's clock, when known. */
  seam: number | null;
  lines: string[];
}

export type PerformanceSplitCode =
  /** Its lines come from more than one generation. */
  | 'separate-generations'
  /** A line's speech runs across an extended take's seam. */
  | 'across-extend'
  /** A line is in an extended take whose seam isn't known, so the rule can't be checked. */
  | 'unknown-seam'
  /** Its lines are said by more than one speaker. */
  | 'mixed-speakers';

/** A way a performance breaks (or may break) the splitting rule. */
export interface PerformanceSplit {
  code: PerformanceSplitCode;
  message: string;
  /** The lines involved. */
  lines: string[];
}

export interface ResolvedPerformance {
  kind: 'performance';
  id: string;
  label: string;
  /** Its line ids, in order. */
  lines: string[];
  intent: string | null;
  delivery: string | null;
  speakers: string[];
  /** From its first line's start to its last line's end. */
  start: number;
  end: number;
  /** Its own thresholds, as written. */
  thresholds: CheckThresholds;
  /** The generations its lines come from, in order of first use. */
  generations: PerformanceGeneration[];
  /** Splitting-rule problems; empty when its lines are one generation. */
  splits: PerformanceSplit[];
}

export type TimelineItem = ResolvedSegment | ResolvedLine | ResolvedAudio | ResolvedOverlay;

/** A source's provenance with its sources resolved. */
export interface ResolvedProvenance {
  step: SourceProvenance['step'] | null;
  extendedFrom: ResolvedSource | null;
  swappedFrom: ResolvedSource | null;
  voice: string | null;
  storyboard: string | null;
  firstFrame: ResolvedSource | null;
  notes: string | null;
}

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
  /** The look over the whole picture, and the processing over the whole mix, in order. */
  filters: { picture: PictureFilter[]; mix: ResolvedMixFilter[] };
  /** Provenance by source, as written in the cut. */
  sources: Record<SourceRef, ResolvedProvenance>;
  /** Every item's start, by id. */
  at: Record<string, number>;
  /** The performances, in the cut's order. Empty when it has none. */
  performances: ResolvedPerformance[];
  /** The cut's check settings, as written. */
  check: { thresholds: CheckThresholds };
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
  | 'unknown-clip'
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
  | 'after-end'
  | 'fade-too-long'
  | 'keyframes-unordered'
  | 'out-past-media'
  | 'no-segments'
  | 'length-mismatch'
  | 'outside-segment'
  | 'outside-clip'
  | 'bad-value'
  | 'unknown-item'
  | 'extends-cycle'
  | 'unknown-line'
  | 'shared-line';

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
