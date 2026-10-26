import { castCast, LOUDNESS } from '../build.js';
import { wavFromPcm } from '../pcm.js';
import type { CastEvent, CastingResult } from '../cast.js';
import { limiter } from '../limit.js';
import type { AudioRuntime, FileSink, ImageBytes, ImageModel, RenderCache, Speaker, Transcriber, Vision, VoiceJudge } from '../ports.js';
import type { LineEvent, RenderedLine } from '../render-lines.js';
import type { StoryScript } from '../types.js';
import { drawComic, type DrawEvent, type DrawResult } from './draw.js';
import { letterPanel, type Measure } from './letter.js';
import { readerHtml } from './reader.js';
import type { ReaderData } from './reader-client.js';
import type { ComicScript } from './types.js';
import { itemId, voiceComic } from './voices.js';

/** Reader audio: small files, one per caption or balloon. */
export const READER_MP3_KBPS = 96;
export const READER_WEBP_QUALITY = 82;
/** The guided view's minimum lettering size and the phone width it is checked at. */
export const GUIDED = { minFontPx: 15, widthPx: 390 } as const;

export interface ComicBuildOptions {
  comic: ComicScript;
  story: StoryScript;
  image: ImageModel;
  vision: Vision;
  cache: RenderCache;
  runtime: AudioRuntime;
  /** Where the reader goes; paths are `reader/...`. */
  sink: FileSink;
  /** Without a speaker and transcriber, the reader has no audio. */
  speaker?: Speaker;
  transcriber?: Transcriber;
  /** Casts voices for cast members who have a brief and no voice. */
  judge?: VoiceJudge;
  signal?: AbortSignal;
  onEvent?: (event: DrawEvent | LineEvent | CastEvent) => void;
  /** Draw again panels that failed their checks in an earlier build. */
  redraw?: boolean;
  /** What David approved: used as it is (plan 009). */
  lock?: { images?: Map<string, ImageBytes>; cast?: Record<string, string>; lines?: Map<string, Uint8Array> };
}

export interface ComicBuildResult {
  draw: DrawResult;
  lines: Map<string, RenderedLine>;
  casting: CastingResult[];
  /** Panels whose lettering may not fit clear of faces, estimated at page size and in the guided view. */
  crowded: Array<{ panel: string; view: 'page' | 'guided'; items: number[] }>;
  data: ReaderData;
}

/** Bold Comic Neue capitals average about 0.6 em; the reader measures exactly. */
const estimate: Measure = (text, px, face) => text.length * px * (face === 'display' ? 0.55 : 0.6);

export const readerImage = (panelId: string) => `img/panel-${panelId.replace('.', '-')}.webp`;
export const readerAudio = (id: string) => `audio/${id.replace('.', '-')}.mp3`;

/**
 * The graphic novel: draws the panels (cached panels cost nothing), voices
 * every caption and balloon, and writes the reader: one page with the
 * lettering laid out live, the art as WebP and an MP3 per item.
 */
export async function buildComic(options: ComicBuildOptions): Promise<ComicBuildResult> {
  const { comic, runtime, sink, signal } = options;
  // Locked cast voices are written into the story, so casting leaves them alone.
  const lockedCast = options.lock?.cast ?? {};
  const story = { ...options.story, cast: Object.fromEntries(Object.entries(options.story.cast).map(([id, m]) => [id, lockedCast[id] ? { ...m, voice: lockedCast[id] } : m])) };
  const draw = await drawComic(comic, story.cast, { image: options.image, vision: options.vision, cache: options.cache, redraw: options.redraw, locked: options.lock?.images, signal, onEvent: options.onEvent });
  // Cast from the story file, so the comic and the audio drama audition the same line.
  const { script: cast, casting } =
    options.speaker && options.transcriber ? await castCast(story, { ...options, speaker: options.speaker }, options.onEvent ?? (() => {})) : { script: story, casting: [] };
  const lines =
    options.speaker && options.transcriber
      ? await voiceComic(comic, cast, { speaker: options.speaker, transcriber: options.transcriber, cache: options.cache, locked: options.lock?.lines, signal, onEvent: options.onEvent })
      : new Map<string, RenderedLine>();

  const encode = limiter(4);
  const panels = comic.pages.flatMap((p) => p.panels);
  await Promise.all([
    ...panels.map((p) =>
      encode(async () => {
        const art = draw.images.get(p.id)!;
        // Locked WebP art is written as it is: re-encoding would change approved pixels.
        await sink.write(`reader/${readerImage(p.id)}`, art.mimeType.includes('webp') ? art.bytes : await runtime.webp(art.bytes, READER_WEBP_QUALITY));
      })
    ),
    ...[...lines].map(([id, line]) =>
      encode(async () => {
        // The raw take, so it can be locked once approved.
        await sink.write(`comic/lines/${id.replace(/\./g, '-')}.wav`, wavFromPcm(line.pcm));
        const wav = await runtime.mix({ voice: line.pcm, beds: [], durationMs: line.result.durationMs }, LOUDNESS);
        await sink.write(`reader/${readerAudio(id)}`, await runtime.mp3(wav, READER_MP3_KBPS));
      })
    ),
  ]);

  const heads = new Map(draw.panels.map((p) => [p.id, p.heads]));
  const data: ReaderData = {
    title: comic.meta.title,
    page: comic.page,
    pages: comic.pages.map((page) => ({
      index: page.index,
      panels: page.panels.map((panel) => ({
        id: panel.id,
        slot: panel.slot,
        aspect: panel.aspect,
        positions: panel.positions,
        zone: panel.zone,
        image: readerImage(panel.id),
        heads: heads.get(panel.id) ?? [],
        items: panel.items.map((item, i) => {
          const base = item.kind === 'balloon' ? { kind: item.kind, who: item.who, text: item.text, ...(item.mark ? { mark: item.mark } : {}) } : { kind: item.kind, text: item.text };
          return lines.has(itemId(panel.id, i)) ? { ...base, audio: readerAudio(itemId(panel.id, i)) } : base;
        }),
      })),
    })),
  };
  await sink.write('reader/index.html', readerHtml(data));

  const crowded: ComicBuildResult['crowded'] = [];
  for (const panel of data.pages.flatMap((p) => p.panels)) {
    const page = letterPanel(panel, panel.heads, panel.slot.w, panel.slot.h, estimate, { fontPx: comic.page.width * 0.02 });
    if (page.crowded.length) crowded.push({ panel: panel.id, view: 'page', items: page.crowded });
    const k = GUIDED.widthPx / panel.slot.w;
    const guided = letterPanel(panel, panel.heads, GUIDED.widthPx, panel.slot.h * k, estimate, { fontPx: GUIDED.minFontPx, minFontPx: GUIDED.minFontPx });
    if (guided.crowded.length) crowded.push({ panel: panel.id, view: 'guided', items: guided.crowded });
  }
  return { draw, lines, casting, crowded, data };
}
