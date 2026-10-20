import type {
  PictureFilter,
  ResolvedAudio,
  ResolvedAudioFilter,
  ResolvedFades,
  ResolvedKey,
  ResolvedLine,
  ResolvedMixFilter,
  ResolvedOverlay,
  ResolvedSegment,
  ResolvedSource,
  Synth,
  Timeline,
} from '../types.js';
import { isConstant, isStepwise, keysExpr, num, quote, shiftKeys, shownExpr, shownFramesExpr, waveExpr } from './expr.js';
import { framesIn } from '../envelope.js';

/**
 * Planning a render: a resolved timeline in, an ffmpeg job out (its inputs,
 * one filter graph and its output settings). Pure: it reads no files and runs
 * nothing, so it can be tested without ffmpeg. `renderArgs` turns a plan into
 * ffmpeg's arguments; `runRender` (in `run.ts`) runs them.
 *
 * The graph is built the way the CRT TV edit scripts built theirs, so a cut
 * renders what its script rendered:
 *
 * - each segment is its own picture chain (trim, crop, `fps`, scale to the
 *   output size, hold, its overlays, its zoom, its fades) and its own sound
 *   (its audio, plus every layer mixed in, under its mix fades), exactly as
 *   long as the segment; the segments are joined with `concat`;
 * - every other line, music and sound effect is its own chain, placed on the
 *   timeline with `adelay` and summed with the segments' sound (`amix`,
 *   unnormalised), then the mix filters;
 * - the overlays are drawn over the joined picture in order, then the picture
 *   filters and the picture fades.
 */

/** Sample rate of every sound in the graph, and of the output. */
export const RENDER_SAMPLE_RATE = 48_000;

/** The originals' encoder settings: x264 `slow` at CRF 16, AAC at 192 kb/s, `+faststart`. */
export const FULL_QUALITY = { preset: 'slow', crf: 16, audioBitrate: '192k' } as const;

/** `--preview`: half size, a fast preset and a looser quality. */
export const PREVIEW_QUALITY = { preset: 'veryfast', crf: 26, audioBitrate: '128k', scale: 0.5 } as const;

export interface RenderOptions {
  /** The output file. Default: the timeline's `output`. */
  output?: string;
  /** Render only from this time (seconds on the timeline). Default 0. */
  from?: number;
  /** Render only up to this time. Default: the cut's length. */
  to?: number;
  /** A fast low-resolution render. */
  preview?: boolean;
  /** x264 CRF. Default 16 (26 for a preview). */
  crf?: number;
  /** x264 preset. Default `slow` (`veryfast` for a preview). */
  preset?: string;
  /** Whether a take or file has a sound track. Default: every take and file has one. */
  hasAudio?: (source: ResolvedSource) => boolean;
  /** The local file for an `asset:<id>` source. Without one, a cut that plays assets can't be planned. */
  assetPath?: (id: string) => string | undefined;
  /**
   * Where each segment lands. `cut` (the default): on the cut's own times, its
   * picture on the frames from its start up to its end and its sound to the
   * sample. `script`: as the CRT TV edit scripts joined them, picture and sound
   * together with `concat`, so each segment lasts as long as the longer of its
   * picture (whole frames) and its sound, and later segments drift late of the
   * cut's times by that rounding. Only for comparing with those scripts' renders.
   */
  timing?: RenderTiming;
}

export type RenderTiming = 'cut' | 'script';

/** One ffmpeg input: the options before its `-i`, and what follows it. */
export interface RenderInput {
  options: string[];
  source: string;
  /** What reads it, e.g. `segment open` or `overlay nmd`. */
  use: string;
}

export interface RenderOutput {
  path: string;
  /** Seconds of the timeline rendered. */
  duration: number;
  /**
   * ffmpeg's `-t`. In cut timing, half a frame past the end of the last frame, so the frame that starts before the
   * end and runs past it is kept (as the scripts' renders kept it); in script timing, the duration, as they wrote it.
   */
  limit: number;
  width: number;
  height: number;
  fps: number;
  video: { codec: 'libx264'; preset: string; crf: number; pixelFormat: 'yuv420p' };
  audio: { codec: 'aac'; bitrate: string; sampleRate: number };
}

export interface RenderPlan {
  inputs: RenderInput[];
  /** The filter graph, one chain per entry (joined with `;`). */
  filters: string[];
  /** The graph's output labels. */
  video: string;
  audio: string;
  output: RenderOutput;
  /** The stretch of the timeline rendered. */
  range: { from: number; to: number };
  timing: RenderTiming;
  /** Things rendered differently from the cut, e.g. a take with no sound track played as silence. */
  notes: string[];
}

export type RenderPlanResult = { ok: true; plan: RenderPlan } | { ok: false; errors: string[] };

const EPS = 1e-6;
const VIDEO_NORMAL = (fps: number, width: number, height: number): string =>
  `setpts=PTS-STARTPTS,fps=${num(fps)},scale=${width}:${height},setsar=1,format=yuv420p`;
const AUDIO_NORMAL = `asetpts=PTS-STARTPTS,aresample=${RENDER_SAMPLE_RATE},aformat=channel_layouts=stereo`;

/**
 * The `trim` for a source's frames from `from` up to `to`. Times are rounded to the microsecond, so a frame
 * time like 5.166667 (frame 124 at 24 fps, 5.1666667) is read a microsecond early: the frame at `from` is
 * kept and the frame at `to` is not, whichever way the rounding went.
 */
function sourceTrim(from: number, to: number): string {
  return `trim=start=${num(Math.max(0, from - 1e-6))}:end=${num(to - 1e-6)}`;
}

/** Seconds as whole samples at the render's rate. */
function samples(seconds: number): number {
  return Math.round(seconds * RENDER_SAMPLE_RATE);
}

function audioFilter(filter: ResolvedAudioFilter | ResolvedMixFilter): string {
  switch (filter.kind) {
    case 'highpass':
      return `highpass=f=${num(filter.frequency)}`;
    case 'lowpass':
      return `lowpass=f=${num(filter.frequency)}`;
    case 'crush':
      return `acrusher=bits=${num(filter.bits)}:mix=${num(filter.mix)}`;
    case 'echo':
      return `aecho=${num(filter.inGain)}:${num(filter.outGain)}:${num(filter.delay * 1000)}:${num(filter.decay)}`;
    case 'limiter':
      return `alimiter=limit=${num(filter.limit)}`;
  }
}

function pictureFilter(filter: PictureFilter, width: number, height: number): string {
  switch (filter.kind) {
    case 'rescale':
      return `scale=${filter.width}:${filter.height}:flags=bilinear,scale=${width}:${height}:flags=bicubic`;
    case 'chroma-shift': {
      const opts = [
        ['cbh', filter.cb?.x], ['cbv', filter.cb?.y], ['crh', filter.cr?.x], ['crv', filter.cr?.y],
      ].filter((o): o is [string, number] => typeof o[1] === 'number' && o[1] !== 0);
      return opts.length === 0 ? 'null' : `chromashift=${opts.map(([k, v]) => `${k}=${num(v)}`).join(':')}`;
    }
    case 'color': {
      const opts = (['saturation', 'contrast', 'gamma', 'brightness'] as const)
        .filter((k) => filter[k] !== undefined)
        .map((k) => `${k}=${num(filter[k] as number)}`);
      return opts.length === 0 ? 'null' : `eq=${opts.join(':')}`;
    }
    case 'color-balance': {
      const opts: string[] = [];
      for (const [range, letter] of [['shadows', 's'], ['midtones', 'm'], ['highlights', 'h']] as const) {
        const shift = filter[range];
        for (const c of ['r', 'g', 'b'] as const) if (shift?.[c] !== undefined && shift[c] !== 0) opts.push(`${c}${letter}=${num(shift[c] as number)}`);
      }
      return opts.length === 0 ? 'null' : `colorbalance=${opts.join(':')}`;
    }
    case 'grain':
      return `noise=alls=${num(filter.strength)}${filter.moving === false ? '' : ':allf=t'}`;
  }
}

/** A synth as a mono source filter, `length` seconds from `from` seconds into its clock. */
function synthSource(synth: Synth, from: number, length: number): string {
  const d = num(length);
  if (synth.kind === 'tone') {
    // ffmpeg's sine source plays at 1/8 of full scale: RIGG's beep is exactly that.
    if (synth.gain === 0.125 && from === 0) return `sine=frequency=${num(synth.frequency)}:duration=${d}:sample_rate=${RENDER_SAMPLE_RATE}`;
    const t = from === 0 ? 't' : `(t+${num(from)})`;
    return `aevalsrc=exprs=${quote(`${num(synth.gain)}*sin(2*PI*${num(synth.frequency)}*${t})`)}:s=${RENDER_SAMPLE_RATE}:d=${d}`;
  }
  const t = from === 0 ? 't' : `(t+${num(from)})`;
  const p = num(synth.period);
  const index = `mod(floor(${t}/${p}),${synth.tones.length})`;
  let tone = num(synth.tones[synth.tones.length - 1]);
  for (let i = synth.tones.length - 2; i >= 0; i--) tone = `if(eq(${index},${i}),${num(synth.tones[i])},${tone})`;
  const u = `mod(${t},${p})`;
  const expr = `if(lt(${u},${num(synth.click)}),${num(synth.gain)}*sin(2*PI*(${tone})*${t})*exp(-${u}*${num(synth.decay)}),0)`;
  return `aevalsrc=exprs=${quote(expr)}:s=${RENDER_SAMPLE_RATE}:d=${d}`;
}

/**
 * The filters for a sound's fades, in its own clock (0 at the sound's start,
 * `length` long): `afade`, sample-exact, wherever it can say the fade, else a
 * per-frame volume expression for a fade already under way at the start.
 */
function fadeFilters(fades: ResolvedFades, start: number, length: number): string[] {
  const out: string[] = [];
  if (fades.fadeIn > 0) {
    const st = fades.fadeInStart - start;
    if (st >= -EPS) out.push(`afade=t=in:st=${num(Math.max(0, st))}:d=${num(fades.fadeIn)}`);
    else if (st + fades.fadeIn > EPS) out.push(`asetnsamples=n=256:p=0,volume=${quote(`min(1,(t+${num(-st)})/${num(fades.fadeIn)})`)}:eval=frame`);
  }
  if (fades.fadeOut > 0) {
    const st = fades.fadeOutEnd - fades.fadeOut - start;
    if (st >= -EPS) {
      if (st < length + EPS) out.push(`afade=t=out:st=${num(Math.max(0, st))}:d=${num(fades.fadeOut)}`);
    } else if (st + fades.fadeOut > EPS) out.push(`asetnsamples=n=256:p=0,volume=${quote(`max(0,(${num(st + fades.fadeOut)}-t)/${num(fades.fadeOut)})`)}:eval=frame`);
    else out.push('volume=0');
  }
  return out;
}

/** A gain as filters: nothing at unity, a constant, or keyframes as a per-frame expression in the sound's clock. */
function gainFilters(keys: readonly ResolvedKey[], start: number): string[] {
  if (keys.length === 0 || isConstant(keys)) {
    const value = keys[0]?.value ?? 1;
    return value === 1 ? [] : [`volume=${num(value)}`];
  }
  return [`asetnsamples=n=256:p=0`, `volume=${quote(keysExpr(shiftKeys(keys, start)))}:eval=frame`];
}

interface Sound {
  /** The chain's label in the graph. */
  label: string;
  start: number;
  end: number;
}

/** Builds one plan. */
class Planner {
  readonly inputs: RenderInput[] = [];
  readonly filters: string[] = [];
  readonly errors: string[] = [];
  readonly notes: string[] = [];
  private labels = 0;

  constructor(
    readonly timeline: Timeline,
    readonly options: RenderOptions,
    readonly from: number,
    readonly to: number,
    readonly timing: RenderTiming,
  ) {}

  /** The first frame at or after `t`: a segment from `start` to `end` is frames `frameAt(start)` up to `frameAt(end)`. */
  frameAt(t: number): number {
    // Times are rounded to the microsecond: 5.166667 is frame 124 at 24 fps.
    return Math.ceil((t - 1e-6) * this.fps);
  }

  /** The first sample at `t`, so segments' sample counts add up to the cut's. */
  sampleAt(t: number): number {
    return samples(t);
  }

  get fps(): number {
    return this.timeline.meta.fps;
  }
  get width(): number {
    return this.timeline.meta.width;
  }
  get height(): number {
    return this.timeline.meta.height;
  }

  label(prefix: string): string {
    return `${prefix}${this.labels++}`;
  }

  input(options: string[], source: string, use: string): number {
    this.inputs.push({ options, source, use });
    return this.inputs.length - 1;
  }

  /** A file path for a source that is read from disk, or null (with an error) when there is none. */
  pathOf(src: ResolvedSource, use: string): string | null {
    if (src.kind === 'take' || src.kind === 'file') return src.path;
    if (src.kind === 'asset') {
      const path = this.options.assetPath?.(src.id);
      if (path) return path;
      this.errors.push(`${use}: ${src.ref} is a stored asset with no local file; pass its file to render it`);
      return null;
    }
    this.errors.push(`${use}: a ${src.kind} source can't be read as a file`);
    return null;
  }

  hasAudio(src: ResolvedSource): boolean {
    return this.options.hasAudio ? this.options.hasAudio(src) : true;
  }

  /**
   * The filters that repeat a still image's one frame at the cut's fps for `seconds` and a second more, frame k at
   * k / fps, as `-loop 1 -framerate <fps>` does, but decoding the image once rather than for every frame.
   */
  loopImage(seconds: number): string {
    const frames = Math.ceil((seconds + 1) * this.fps);
    return `loop=loop=${frames - 1}:size=1:start=0,settb=expr=1/${num(this.fps)},setpts=N`;
  }

  // -------------------------------------------------------------------------
  // Sound

  /**
   * One sound's chain in its own clock, from 0 at `start` for `end − start`:
   * its source, its filters, its gain and its fades. Null when it is silent.
   */
  soundChain(
    use: string,
    src: ResolvedSource,
    from: number,
    start: number,
    end: number,
    filters: readonly ResolvedAudioFilter[],
    gain: readonly ResolvedKey[],
    fades: ResolvedFades | null,
    parts: ResolvedAudio['parts'],
  ): string | null {
    const length = end - start;
    if (length <= EPS) return null;
    let head: string;
    if (src.kind === 'synth') {
      head = `${synthSource(src.synth, from, length)},aformat=channel_layouts=stereo`;
    } else if (src.kind === 'bed') {
      const bed = this.bedChain(use, parts ?? [], start, end);
      if (!bed) return null;
      head = bed;
    } else if (src.kind === 'color') {
      return null;
    } else {
      if (!this.hasAudio(src)) {
        this.notes.push(`${use}: ${src.ref} has no sound track, so it is silent`);
        return null;
      }
      const path = this.pathOf(src, use);
      if (path === null) return null;
      const i = this.input([], path, use);
      head = `[${i}:a]atrim=start=${num(from)}:end=${num(from + length)},${AUDIO_NORMAL}`;
    }
    const chain = [head, ...filters.map(audioFilter), ...gainFilters(gain, start), ...(fades ? fadeFilters(fades, start, length) : [])];
    return chain.join(',');
  }

  /**
   * A bed's sound from its clip's start to its end: its parts, each from
   * where it would start (before any cut to the clip's span), joined with
   * linear crossfades, then cut to the clip's span.
   */
  bedChain(use: string, parts: NonNullable<ResolvedAudio['parts']>, start: number, end: number): string | null {
    if (parts.length === 0) return null;
    const labels: string[] = [];
    for (const [i, part] of parts.entries()) {
      // Where the part would start and end, and its source in-point there.
      const fullStart = part.fadeInStart;
      const fullEnd = part.fadeOutEnd;
      const fullIn = part.in - (part.start - fullStart);
      const path = this.pathOf(part.src, `${use} part ${i}`);
      if (path === null) return null;
      if (!this.hasAudio(part.src)) {
        this.errors.push(`${use}: part ${i} (${part.src.kind === 'take' || part.src.kind === 'file' ? part.src.path : part.src.kind}) has no sound track`);
        return null;
      }
      const n = this.input([], path, `${use} part ${i}`);
      const label = this.label('bed');
      this.filters.push(`[${n}:a]atrim=start=${num(fullIn)}:end=${num(fullIn + (fullEnd - fullStart))},${AUDIO_NORMAL}[${label}]`);
      labels.push(label);
    }
    let joined = labels[0];
    for (let i = 1; i < labels.length; i++) {
      const crossfade = parts[i].fadeIn;
      const label = this.label('bed');
      this.filters.push(
        crossfade > EPS
          ? `[${joined}][${labels[i]}]acrossfade=d=${num(crossfade)}[${label}]`
          : `[${joined}][${labels[i]}]concat=n=2:v=0:a=1[${label}]`,
      );
      joined = label;
    }
    // The joined bed starts where its first part would; the clip plays its stretch from `start`.
    const origin = parts[0].fadeInStart;
    return `[${joined}]atrim=start=${num(start - origin)}:end=${num(end - origin)},asetpts=PTS-STARTPTS`;
  }

  /** A line's own sound, or null when it is heard in other sound. */
  lineSound(line: ResolvedLine): string | null {
    const a = line.audio;
    if (a.kind !== 'file') return null;
    return this.soundChain(`line ${line.id}`, a.src, a.in, line.start, line.end, a.filters, [{ t: line.start, value: a.volume }], a, null);
  }

  /** A music or sfx clip's sound, or null when it only labels a segment's own sound. */
  clipSound(clip: ResolvedAudio): string | null {
    if (clip.segment !== null) return null;
    return this.soundChain(`${clip.kind} ${clip.id}`, clip.src, clip.in, clip.start, clip.end, clip.filters, clip.volume, clip, clip.parts);
  }

  /** Places a chain at `start` on the rendered stretch: delayed, or with its head cut off when it began before the stretch. */
  place(chain: string, start: number, origin: number, end: number): Sound {
    const label = this.label('s');
    const offset = start - origin;
    const tail = offset >= -EPS
      ? (samples(offset) > 0 ? `,adelay=delays=${samples(offset)}S:all=1` : '')
      : `,atrim=start=${num(-offset)},asetpts=PTS-STARTPTS`;
    this.filters.push(`${chain}${tail}[${label}]`);
    return { label, start, end };
  }

  // -------------------------------------------------------------------------
  // Segments

  /** A segment's picture, from its start to its end, ready to join. */
  segmentPicture(seg: ResolvedSegment, overlays: readonly ResolvedOverlay[]): { label: string | null; input: number | null } {
    const length = seg.end - seg.start;
    const vn = VIDEO_NORMAL(this.fps, this.width, this.height);
    const crop = seg.crop ? `,crop=${seg.crop.width}:${seg.crop.height}:${seg.crop.x}:${seg.crop.y}` : '';
    const use = `segment ${seg.id}`;
    // The segment's clock: 0 at its first frame. In cut timing that is frame frameAt(start), which can be up to a
    // frame after its start; in script timing its start.
    const clock = this.timing === 'cut' ? this.frameAt(seg.start) / this.fps : seg.start;
    let input: number | null = null;
    let chain: string;
    if (seg.src.kind === 'color') {
      const n = this.input(['-f', 'lavfi'], `color=c=${seg.src.color}:s=${this.width}x${this.height}:r=${num(this.fps)}:d=${num(length + 1)}`, use);
      chain = `[${n}:v]trim=start=0:end=${num(length)},${vn}`;
    } else {
      const path = this.pathOf(seg.src, use);
      if (path === null) return { label: 'missing', input: null };
      if (seg.still) {
        input = this.input([], path, use);
        chain = `[${input}:v]${this.loopImage(length)},trim=start=0:end=${num(length)}${crop},${vn}`;
      } else {
        input = this.input([], path, use);
        const span = seg.out - seg.in;
        if (seg.loop === 'pingpong' && span > EPS) {
          // in→out, out→in, in→out, … until the segment's length.
          const copies = Math.max(1, Math.ceil(length / span - EPS));
          const split = Array.from({ length: copies }, () => this.label('pp'));
          const outs = split.map((l) => `[${l}]`).join('');
          this.filters.push(`[${input}:v]${sourceTrim(seg.in, seg.out)}${crop},setpts=PTS-STARTPTS${copies > 1 ? `,split=${copies}` : ''}${outs}`);
          const parts = split.map((l, i) => {
            if (i % 2 === 0) return `[${l}]`;
            const r = this.label('ppr');
            this.filters.push(`[${l}]reverse[${r}]`);
            return `[${r}]`;
          });
          chain = `${parts.join('')}concat=n=${copies}:v=1:a=0,trim=end=${num(length)},${vn}`;
        } else if (span < 0.5 / this.fps) {
          // No frame inside in→out: freeze the frame at `out` for the whole length.
          chain = `[${input}:v]trim=start=${num(seg.out)},trim=end_frame=1${crop},${vn},tpad=stop_mode=clone:stop_duration=${num(length)},trim=end=${num(length)}`;
        } else if (this.timing === 'cut') {
          // Frame k of the output shows the source frame nearest to in + (k / fps − start), the time its sound is
          // playing: the source's clock is moved onto the segment's (0 at its first frame) and `fps` picks the
          // nearest frame for each tick, from tick 0.
          const shift = seg.start - clock - seg.in;
          const move = shift < 0 ? `-${num(-shift)}` : `+${num(shift)}`;
          chain = `[${input}:v]trim=start=${num(Math.max(0, seg.in - 0.5 / this.fps))}:end=${num(seg.out - 1e-6)}${crop},` +
            `setpts=PTS${move}/TB,fps=${num(this.fps)}:start_time=0,scale=${this.width}:${this.height},setsar=1,format=yuv420p`;
          if (seg.hold > EPS) chain += `,tpad=stop_mode=clone:stop_duration=${num(seg.hold)}`;
        } else {
          chain = `[${input}:v]${sourceTrim(seg.in, seg.out)}${crop},${vn}`;
          if (seg.hold > EPS) chain += `,tpad=stop_mode=clone:stop_duration=${num(seg.hold)}`;
        }
      }
    }
    let label = this.label('seg');
    this.filters.push(`${chain}[${label}]`);

    // Overlays drawn into the segment, in its clock, before its zoom.
    for (const overlay of overlays) label = this.drawOverlay(label, overlay, clock, seg.end - clock);

    const after: string[] = [];
    if (seg.zoom) after.push(this.zoomFilter(seg, clock));
    if (seg.fadeIn > 0) after.push(`fade=t=in:st=${num(Math.max(0, seg.start - clock))}:d=${num(seg.fadeIn)}`);
    if (seg.fadeOut > 0) after.push(`fade=t=out:st=${num(Math.max(0, seg.end - seg.fadeOut - clock))}:d=${num(seg.fadeOut)}`);
    if (this.timing === 'cut') {
      // Exactly the frames from the segment's start up to its end (within the rendered stretch): its last frame held
      // if the source runs short, the frames past its end dropped.
      const first = this.frameAt(seg.start);
      const keepFrom = Math.max(first, this.frameAt(this.from)) - first;
      const keepTo = Math.min(this.frameAt(seg.end), this.frameAt(this.to)) - first;
      if (keepTo <= keepFrom) return { label: null, input };
      after.push(`tpad=stop_mode=clone:stop_duration=${num(Math.max(1, length))}`, `trim=start_frame=${keepFrom}:end_frame=${keepTo}`, 'setpts=PTS-STARTPTS');
    } else {
      const cut = this.rangeCut(seg, false);
      if (cut) after.push(cut);
    }
    if (after.length > 0) {
      const next = this.label('seg');
      this.filters.push(`[${label}]${after.join(',')}[${next}]`);
      label = next;
    }
    return { label, input };
  }

  /** The push-in: scaled about the focus each frame, then cropped back to the picture, the focus held in place. */
  zoomFilter(seg: ResolvedSegment, clock: number): string {
    const zoom = seg.zoom;
    if (!zoom) return 'null';
    const s = keysExpr(shiftKeys(zoom.keys, clock));
    const w = this.width;
    const h = this.height;
    const centred = Math.abs(zoom.focus.x - w / 2) < EPS && Math.abs(zoom.focus.y - h / 2) < EPS;
    const place = centred ? '' : `:x=${quote(`${num(zoom.focus.x)}*(iw/${w}-1)`)}:y=${quote(`${num(zoom.focus.y)}*(ih/${h}-1)`)}`;
    return `scale=w=${quote(`${w}*(${s})`)}:h=${quote(`${h}*(${s})`)}:eval=frame,crop=${w}:${h}${place},setsar=1,format=yuv420p`;
  }

  /** The trim that keeps only the rendered stretch of a segment, or null when it is all inside. */
  rangeCut(seg: ResolvedSegment, audio: boolean): string | null {
    const startCut = this.from > seg.start + EPS ? this.from - seg.start : 0;
    const endCut = this.to < seg.end - EPS ? this.to - seg.start : null;
    if (startCut === 0 && endCut === null) return null;
    if (audio) {
      const first = this.sampleAt(seg.start);
      const opts = [startCut > 0 ? `start_sample=${this.sampleAt(this.from) - first}` : null, endCut !== null ? `end_sample=${this.sampleAt(this.to) - first}` : null];
      return `atrim=${opts.filter(Boolean).join(':')},asetpts=PTS-STARTPTS`;
    }
    const opts = [startCut > 0 ? `start=${num(startCut)}` : null, endCut !== null ? `end=${num(endCut)}` : null].filter(Boolean).join(':');
    return `trim=${opts},setpts=PTS-STARTPTS`;
  }

  /** A segment's whole sound: its own audio and its layers, under its mix fades, exactly as long as the segment. */
  segmentSound(seg: ResolvedSegment, pictureInput: number | null, layers: ReadonlyArray<{ chain: string; start: number }>): string {
    const length = seg.end - seg.start;
    const use = `segment ${seg.id}`;
    // In cut timing, the segment's sound is exactly its samples on the timeline, so the joined sound stays on the cut's times.
    const count = this.sampleAt(seg.end) - this.sampleAt(seg.start);
    const pad = this.timing === 'cut' ? `apad=whole_len=${count},atrim=end_sample=${count}` : `apad=whole_dur=${num(length)}`;
    let own: string | null = null;
    const a = seg.audio;
    if (a) {
      const playLength = a.end - a.start;
      let head: string | null = null;
      if (a.src.kind === 'synth') {
        head = `${synthSource(a.src.synth, a.in, playLength)},${AUDIO_NORMAL}`;
      } else if (a.src.kind !== 'color' && a.src.kind !== 'bed') {
        if (!this.hasAudio(a.src)) {
          this.notes.push(`${use}: ${a.src.ref} has no sound track, so the segment's own sound is silent`);
        } else {
          const samePicture = pictureInput !== null && 'ref' in seg.src && a.src.ref === seg.src.ref && !seg.still;
          const path = samePicture ? null : this.pathOf(a.src, use);
          const n = samePicture ? pictureInput : path === null ? null : this.input([], path, `${use} sound`);
          if (n !== null) head = `[${n}:a]atrim=start=${num(a.in)}:end=${num(a.in + playLength)},${AUDIO_NORMAL}`;
        }
      }
      if (head !== null && playLength > EPS) {
        const fades = fadeFilters({ fadeIn: a.fadeIn, fadeOut: a.fadeOut, fadeInStart: a.start, fadeOutEnd: a.end }, a.start, playLength);
        own = [head, ...(a.volume === 1 ? [] : [`volume=${num(a.volume)}`]), ...fades, pad].join(',');
      }
    }
    const base = own ?? (this.timing === 'cut' ? `anullsrc=r=${RENDER_SAMPLE_RATE}:cl=stereo,atrim=end_sample=${count}` : `anullsrc=r=${RENDER_SAMPLE_RATE}:cl=stereo:d=${num(length)}`);
    let label = this.label('sa');
    if (layers.length === 0) {
      this.filters.push(`${base}[${label}]`);
    } else {
      const placed = layers.map((l) => this.place(l.chain, l.start, seg.start, seg.end).label);
      this.filters.push(`${base}[${label}]`);
      const mixed = this.label('sa');
      this.filters.push(`[${label}]${placed.map((p) => `[${p}]`).join('')}amix=inputs=${placed.length + 1}:normalize=0:duration=first[${mixed}]`);
      label = mixed;
    }
    const after: string[] = [];
    if (seg.mix.fadeIn > 0) after.push(`afade=t=in:st=0:d=${num(seg.mix.fadeIn)}`);
    if (seg.mix.fadeOut > 0) after.push(`afade=t=out:st=${num(length - seg.mix.fadeOut)}:d=${num(seg.mix.fadeOut)}`);
    const cut = this.rangeCut(seg, true);
    if (cut) after.push(cut);
    if (after.length > 0) {
      const next = this.label('sa');
      this.filters.push(`[${label}]${after.join(',')}[${next}]`);
      label = next;
    }
    return label;
  }

  // -------------------------------------------------------------------------
  // Overlays

  /**
   * Draws one overlay over `main`, whose clock is 0 at timeline time
   * `clockStart`: its image (sized, faded, at its opacity) placed at its
   * position, shown from its start through its end.
   */
  drawOverlay(main: string, overlay: ResolvedOverlay, clockStart: number, clockLength: number): string {
    const use = `overlay ${overlay.id}`;
    const path = this.pathOf(overlay.src, use);
    if (path === null) return main;
    const inSegment = overlay.segment !== null;
    const n = this.input([], path, use);
    const local = (t: number): number => t - clockStart;
    // Sized once, then repeated a frame per tick.
    const image: string[] = [`[${n}:v]format=rgba`];
    if (overlay.width !== null || overlay.height !== null) image.push(`scale=${overlay.width ?? -1}:${overlay.height ?? -1}`);
    image.push(this.loopImage(clockLength));
    // In a segment, the image runs exactly as long as the segment: overlay keeps going while either input
    // does, so a longer image would hold the segment's last frame past its end.
    if (inSegment) image.push(`trim=end=${num(clockLength)}`, 'setpts=PTS-STARTPTS');
    if (overlay.fadeIn > 0) image.push(`fade=t=in:st=${num(Math.max(0, local(overlay.start)))}:d=${num(overlay.fadeIn)}:alpha=1`);
    if (overlay.fadeOut > 0) image.push(`fade=t=out:st=${num(Math.max(0, local(overlay.fadeOutEnd - overlay.fadeOut)))}:d=${num(overlay.fadeOut)}:alpha=1`);

    // On the frames it covers, both ends included (`framesIn`); in script timing over the joined picture, by its
    // drifting clock as the scripts did.
    let shown: string;
    if (this.timing === 'script' && !inSegment) shown = shownExpr(local(overlay.start), local(overlay.end), overlay.blink);
    else {
      const frames = framesIn(local(overlay.start), local(overlay.end), this.fps);
      shown = frames ? shownFramesExpr(frames.first, frames.last, this.fps, local(overlay.start), overlay.blink) : '0';
    }
    const opacity = shiftKeys(overlay.opacity, clockStart);
    if (!isConstant(opacity) && isStepwise(opacity) && opacity.every((k) => k.value === 0 || k.value === 1)) {
      shown += `*(${keysExpr(opacity)})`;
    } else if (isConstant(opacity)) {
      const value = opacity[0]?.value ?? 1;
      if (value !== 1) image.push(`colorchannelmixer=aa=${num(value)}`);
    } else {
      const alpha = keysExpr(opacity, 'T');
      image.push(`geq=r=${quote('r(X,Y)')}:g=${quote('g(X,Y)')}:b=${quote('b(X,Y)')}:a=${quote(`alpha(X,Y)*(${alpha})`)}`);
    }
    const g = this.label('g');
    this.filters.push(`${image.join(',')}[${g}]`);

    const axis = (which: 'x' | 'y'): string => {
      const wave = overlay.wave[which];
      if (wave) return quote(waveExpr(wave, clockStart));
      const keys = shiftKeys(overlay.motion.map((k) => ({ t: k.t, value: k[which] })), clockStart);
      return isConstant(keys) ? num(keys[0]?.value ?? 0) : quote(keysExpr(keys));
    };
    const out = this.label('o');
    // An overlay in a segment ends with the segment; one over the finished picture with the picture.
    this.filters.push(`[${main}][${g}]overlay=x=${axis('x')}:y=${axis('y')}${inSegment ? '' : ':shortest=1'}:enable=${quote(shown)}[${out}]`);
    return out;
  }
}

function overlaps(start: number, end: number, from: number, to: number): boolean {
  return end > from + EPS && start < to - EPS;
}

/**
 * Plans the render of a resolved cut: every segment, line, music and sound
 * effect clip, overlay, filter and fade the timeline holds, between `from` and
 * `to` (default: all of it). With `preview`, the picture is halved and encoded
 * fast.
 */
export function planRender(timeline: Timeline, options: RenderOptions = {}): RenderPlanResult {
  const errors: string[] = [];
  const length = timeline.length;
  const from = options.from ?? 0;
  const to = options.to ?? length;
  if (!(from >= 0)) errors.push(`--from must be at least 0 (got ${from})`);
  if (!(to <= length + EPS)) errors.push(`--to must be at most the cut's length, ${num(length)} s (got ${to})`);
  if (!(to > from + EPS)) errors.push(`--to (${to}) must be after --from (${from})`);
  const output = options.output ?? timeline.output;
  if (!output) errors.push('The cut has no output; give an output path');
  if (errors.length > 0 || !output) return { ok: false, errors };

  const timing = options.timing ?? 'cut';
  const p = new Planner(timeline, options, from, Math.min(to, length), timing);
  const end = Math.min(to, length);

  // Layers belong to their segment's sound; everything else is placed on the timeline.
  const layerChains = new Map<string, Array<{ chain: string; start: number }>>();
  const globalSounds: Array<{ chain: string; start: number; end: number }> = [];
  const addSound = (chain: string | null, start: number, stop: number, layer: string | null): void => {
    if (chain === null) return;
    if (layer !== null) {
      const list = layerChains.get(layer) ?? [];
      list.push({ chain, start });
      layerChains.set(layer, list);
    } else if (overlaps(start, stop, from, end)) {
      globalSounds.push({ chain, start, end: stop });
    }
  };
  const segmentsInRange = timeline.segments.filter((s) => overlaps(s.start, s.end, from, end));
  const inRange = new Set(segmentsInRange.map((s) => s.id));
  for (const line of timeline.lines) {
    const layer = line.audio.kind === 'file' ? (line.audio.layer?.segment ?? null) : null;
    if (layer !== null ? inRange.has(layer) : overlaps(line.start, line.end, from, end)) addSound(p.lineSound(line), line.start, line.end, layer);
  }
  for (const clip of [...timeline.music, ...timeline.sfx]) {
    const layer = clip.layer?.segment ?? null;
    if (layer !== null ? inRange.has(layer) : overlaps(clip.start, clip.end, from, end)) addSound(p.clipSound(clip), clip.start, clip.end, layer);
  }

  // The segments, picture and sound, joined.
  const pictures: string[] = [];
  const sounds: string[] = [];
  for (const seg of segmentsInRange) {
    const own = timeline.overlays.filter((o) => o.segment === seg.id);
    const picture = p.segmentPicture(seg, own);
    const sound = p.segmentSound(seg, picture.input, layerChains.get(seg.id) ?? []);
    if (picture.label !== null) pictures.push(`[${picture.label}]`);
    sounds.push(`[${sound}]`);
  }
  const vcat = p.label('vcat');
  const acat = p.label('acat');
  if (timing === 'script') {
    // Picture and sound joined together: each segment lasts as long as the longer of the two.
    p.filters.push(`${pictures.map((v, i) => `${v}${sounds[i]}`).join('')}concat=n=${sounds.length}:v=1:a=1[${vcat}][${acat}]`);
  } else {
    p.filters.push(`${pictures.join('')}concat=n=${pictures.length}:v=1:a=0[${vcat}]`);
    p.filters.push(`${sounds.join('')}concat=n=${sounds.length}:v=0:a=1[${acat}]`);
  }

  // The finished picture: overlays over it in timeline time, its look, its fades.
  let video = vcat;
  // The joined picture's clock is moved onto the timeline's: its first frame is frame frameAt(from) (or `from` itself, in script timing).
  const shift = timing === 'cut' || from > EPS;
  if (timing === 'cut') {
    // Every joined frame on the grid, numbered from the stretch's first: frame k at exactly k / fps.
    const next = p.label('v');
    p.filters.push(`[${video}]settb=expr=1/${num(timeline.meta.fps)},setpts=N+${p.frameAt(from)}[${next}]`);
    video = next;
  } else if (shift) {
    const next = p.label('v');
    p.filters.push(`[${video}]setpts=PTS+${num(from)}/TB[${next}]`);
    video = next;
  }
  for (const overlay of timeline.overlays) {
    if (overlay.segment !== null || !overlaps(overlay.start, overlay.end + 1 / timeline.meta.fps, from, end)) continue;
    video = p.drawOverlay(video, overlay, 0, end);
  }
  const finish: string[] = timeline.filters.picture.map((f) => pictureFilter(f, timeline.meta.width, timeline.meta.height));
  if (finish.length > 0) finish.push('format=yuv420p');
  if (timeline.picture.fadeIn > 0) finish.push(`fade=t=in:st=0:d=${num(timeline.picture.fadeIn)}`);
  if (timeline.picture.fadeOut > 0) finish.push(`fade=t=out:st=${num(length - timeline.picture.fadeOut)}:d=${num(timeline.picture.fadeOut)}`);
  if (shift) finish.push('setpts=PTS-STARTPTS');
  if (options.preview) {
    const w = Math.max(2, Math.round((timeline.meta.width * PREVIEW_QUALITY.scale) / 2) * 2);
    const h = Math.max(2, Math.round((timeline.meta.height * PREVIEW_QUALITY.scale) / 2) * 2);
    finish.push(`scale=${w}:${h}`);
  }
  if (finish.length > 0) {
    const next = p.label('vout');
    p.filters.push(`[${video}]${finish.join(',')}[${next}]`);
    video = next;
  }

  // The finished sound: the segments' sound and everything placed on it, then the mix filters.
  const placed = globalSounds.map((s) => p.place(s.chain, s.start, from, s.end).label);
  const mix = timeline.filters.mix.map(audioFilter);
  let audio = acat;
  if (placed.length > 0 || mix.length > 0) {
    const next = p.label('aout');
    const sum = placed.length > 0 ? `[${acat}]${placed.map((l) => `[${l}]`).join('')}amix=inputs=${placed.length + 1}:normalize=0:duration=first` : `[${acat}]anull`;
    p.filters.push(`${sum}${mix.length > 0 ? `,${mix.join(',')}` : ''}[${next}]`);
    audio = next;
  }

  if (p.errors.length > 0) return { ok: false, errors: p.errors };
  const quality = options.preview ? PREVIEW_QUALITY : FULL_QUALITY;
  const scale = options.preview ? PREVIEW_QUALITY.scale : 1;
  return {
    ok: true,
    plan: {
      inputs: p.inputs,
      filters: p.filters,
      video,
      audio,
      output: {
        path: output,
        duration: Math.round((end - from) * 1e6) / 1e6,
        limit: timing === 'cut'
          ? Math.round(((p.frameAt(end) - p.frameAt(from) + 0.5) / timeline.meta.fps) * 1e6) / 1e6
          : Math.round((end - from) * 1e6) / 1e6,
        width: options.preview ? Math.max(2, Math.round((timeline.meta.width * scale) / 2) * 2) : timeline.meta.width,
        height: options.preview ? Math.max(2, Math.round((timeline.meta.height * scale) / 2) * 2) : timeline.meta.height,
        fps: timeline.meta.fps,
        video: { codec: 'libx264', preset: options.preset ?? quality.preset, crf: options.crf ?? quality.crf, pixelFormat: 'yuv420p' },
        audio: { codec: 'aac', bitrate: quality.audioBitrate, sampleRate: RENDER_SAMPLE_RATE },
      },
      range: { from, to: end },
      timing,
      notes: p.notes,
    },
  };
}

/** The ffmpeg arguments for a plan (without the ffmpeg binary itself). */
export function renderArgs(plan: RenderPlan, extra: { progress?: boolean } = {}): string[] {
  const o = plan.output;
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    ...(extra.progress ? ['-progress', 'pipe:1', '-nostats'] : []),
    ...plan.inputs.flatMap((i) => [...i.options, '-i', i.source]),
    '-filter_complex', plan.filters.join(';'),
    '-map', `[${plan.video}]`, '-map', `[${plan.audio}]`,
    '-t', num(o.limit),
    '-c:v', o.video.codec, '-preset', o.video.preset, '-crf', String(o.video.crf), '-pix_fmt', o.video.pixelFormat, '-r', num(o.fps),
    '-c:a', o.audio.codec, '-b:a', o.audio.bitrate, '-ar', String(o.audio.sampleRate),
    '-movflags', '+faststart',
    o.path,
  ];
}

const LEADING_LABELS = /^(?:\[[^\]]+\])+/;
const TRAILING_LABELS = /(?:\[[^\]]+\])+$/;

function labelsIn(text: string | undefined): string[] {
  return text ? [...text.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]) : [];
}

/**
 * The chains of a plan's graph that its sound needs, in order: everything
 * the sound output is made from, and nothing of the picture. A kept chain's
 * outputs that nothing reads go to `anullsink`.
 */
export function soundFilters(plan: Pick<RenderPlan, 'filters' | 'audio'>): string[] {
  const chains = plan.filters.flatMap((f) => f.split(';')).map((text) => ({
    text,
    inputs: labelsIn(LEADING_LABELS.exec(text)?.[0]),
    outputs: labelsIn(TRAILING_LABELS.exec(text)?.[0]),
  }));
  const needed = new Set([plan.audio]);
  const keep = new Set<number>();
  for (let i = chains.length - 1; i >= 0; i--) {
    if (!chains[i].outputs.some((o) => needed.has(o))) continue;
    keep.add(i);
    for (const input of chains[i].inputs) needed.add(input);
  }
  const kept = chains.filter((_, i) => keep.has(i));
  const unread = kept.flatMap((c) => c.outputs).filter((o) => o !== plan.audio && !kept.some((c) => c.inputs.includes(o)));
  return [...kept.map((c) => c.text), ...unread.map((o) => `[${o}]anullsink`)];
}

/**
 * The ffmpeg arguments for a plan's sound alone, as a 16-bit WAV at the
 * render's sample rate (mono by default) at `output`: only the chains the
 * sound needs (`soundFilters`), so no picture is decoded or made. Used to
 * measure a cut's sound (`mdmedia cut check`). (Discarding the picture into
 * a `nullsink` instead now and then left ffmpeg 7 deadlocked at the end.)
 */
export function soundArgs(plan: RenderPlan, output: string, options: { channels?: 1 | 2 } = {}): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    ...plan.inputs.flatMap((i) => [...i.options, '-i', i.source]),
    '-filter_complex', soundFilters(plan).join(';'),
    '-map', `[${plan.audio}]`,
    '-t', num(plan.output.duration),
    '-ac', String(options.channels ?? 1), '-c:a', 'pcm_s16le', '-ar', String(plan.output.audio.sampleRate),
    output,
  ];
}
