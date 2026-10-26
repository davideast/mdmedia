import { castVoices, type CastEvent, type CastingResult } from './cast.js';
import { parseStory } from './parse.js';
import { mixClips, wavFromPcm } from './pcm.js';
import { buildMixPlan, renderMusic, sceneLeads, type MusicEvent, type MusicResult } from './music.js';
import type { AudioRuntime, CachedMusic, Composer, FileSink, RenderCache, Speaker, Transcriber, VoiceJudge } from './ports.js';
import { renderLines, type LineEvent, type LineResult } from './render-lines.js';
import { scheduleStory, type StoryTimeline } from './schedule.js';
import { StoryError, type Diagnostic, type Line, type StoryScript } from './types.js';

export const LOUDNESS = { loudnessLufs: -19, truePeakDb: -2 } as const;
export const MP3_KBPS = 160;

export interface BuildOptions {
  source: { path: string; markdown: string };
  out: FileSink;
  speaker: Speaker;
  transcriber: Transcriber;
  runtime: AudioRuntime;
  cache: RenderCache;
  /** Casts voices for cast members who have a brief and no voice. */
  judge?: VoiceJudge;
  /** Each voice's gender, from a person listening; VOICE_FACTS by default. */
  facts?: Readonly<Record<string, { gender: 'man' | 'woman' }>>;
  /** Scene music; without one, or with `music: false`, the build has voices only. */
  composer?: Composer;
  music?: boolean;
  tool?: { name: string; version: string };
  concurrency?: { speak?: number; transcribe?: number };
  signal?: AbortSignal;
  onEvent?: (event: BuildEvent) => void;
}

export type BuildEvent = CastEvent | LineEvent | MusicEvent | { type: 'mix-done'; durationMs: number } | { type: 'build-done'; summary: BuildSummary };

export interface BuildSummary {
  lines: number;
  cached: number;
  retakes: number;
  fallbacks: number;
  refused: number;
  /** Lines whose kept take still does not match the script. */
  failures: number;
  /** Scenes that got their music clip. */
  musicClips: number;
  audioSeconds: number;
  wallMs: number;
}

export interface StoryBuild {
  schema: 'mdmedia.story.build/1';
  tool: { name: string; version: string };
  source: { path: string; sha256: string };
  models: { speech: { name: string; model: string }; transcription: string; music?: string };
  encoder: { path: string; version: string };
  summary: BuildSummary;
  /** Voices cast from briefs in this build, with every audition's score. */
  casting: CastingResult[];
  lines: LineResult[];
  music: MusicResult[];
  outputs: Array<{ path: string; sha256: string; bytes: number }>;
}

export interface BuildResult {
  /** Errors in the story stop the build before anything is rendered. */
  diagnostics: Diagnostic[];
  build?: StoryBuild;
}

/**
 * Builds an audio drama from a story file: every line voiced in context and
 * checked, scheduled, mixed, normalized and written to the output folder.
 */
export async function buildStory(options: BuildOptions): Promise<BuildResult> {
  const started = Date.now();
  const emit = options.onEvent ?? (() => {});
  const parsed = await parseStory(options.source.markdown, { path: options.source.path });
  const diagnostics = parsed.diagnostics;
  if (!parsed.script) return { diagnostics };
  const { script, casting } = await castCast(parsed.script, options, emit);

  const rendered = await renderLines(script, {
    speaker: options.speaker,
    transcriber: options.transcriber,
    cache: options.cache,
    concurrency: options.concurrency,
    signal: options.signal,
    onEvent: emit,
  });

  const withMusic = Boolean(options.composer) && options.music !== false;
  const { clips, results: musicResults } = withMusic
    ? await renderMusic(script, { composer: options.composer!, cache: options.cache, signal: options.signal, onEvent: emit })
    : { clips: new Map<string, CachedMusic>(), results: [] as MusicResult[] };

  const durations = new Map([...rendered].map(([id, r]) => [id, r.result.durationMs]));
  const renders = new Map([...rendered].map(([id, r]) => [id, r.result.key]));
  const timeline = scheduleStory(script, durations, renders, { leads: sceneLeads(clips) });
  const voice = mixClips(timeline.lines.map((l) => ({ pcm: rendered.get(l.id)!.pcm, startMs: l.startMs })), timeline.durationMs);
  const plan = buildMixPlan(timeline, voice, clips);
  emit({ type: 'mix-done', durationMs: plan.durationMs });

  options.signal?.throwIfAborted();
  const master = await options.runtime.mix(plan, LOUDNESS);
  const mp3 = await options.runtime.mp3(master, MP3_KBPS);
  const slug = slugify(script.meta.title);

  const outputs: StoryBuild['outputs'] = [];
  const write = async (path: string, data: Uint8Array | string) => {
    await options.out.write(path, data);
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    outputs.push({ path, sha256: await sha256Bytes(bytes), bytes: bytes.byteLength });
  };

  await write('script.json', json(script));
  await write('timeline.json', json(timeline));
  await write(`audio/${slug}.mp3`, mp3);
  await write('audio/master.wav', master);
  for (const line of timeline.lines) await write(linePath(line.id), wavFromPcm(rendered.get(line.id)!.pcm));
  for (const [sceneId, clip] of clips) await write(musicPath(sceneId, clip.mimeType), clip.bytes);
  await write('text/transcript.md', transcript(script, timeline));

  const results = timeline.lines.map((l) => rendered.get(l.id)!.result);
  const summary: BuildSummary = {
    lines: results.length,
    cached: results.filter((r) => r.cached).length,
    retakes: results.reduce((n, r) => n + Math.max(0, r.attempts - 1), 0),
    fallbacks: results.filter((r) => r.level > 0).length,
    refused: results.filter((r) => r.refused).length,
    failures: results.filter((r) => !r.ok).length,
    musicClips: clips.size,
    audioSeconds: Math.round(plan.durationMs / 100) / 10,
    wallMs: Date.now() - started,
  };
  const build: StoryBuild = {
    schema: 'mdmedia.story.build/1',
    tool: options.tool ?? { name: 'mdmedia', version: '0.0.0' },
    source: script.source,
    models: {
      speech: options.speaker.provider,
      transcription: options.transcriber.model,
      ...(withMusic ? { music: options.composer!.model } : {}),
    },
    encoder: await options.runtime.describe(),
    summary,
    casting,
    lines: results,
    music: musicResults,
    outputs: [...outputs],
  };
  await options.out.write('build.json', json(build));
  emit({ type: 'build-done', summary });
  return { diagnostics, build };
}

/** Casts the cast members who need a voice, or explains what is missing. */
export async function castCast(
  script: StoryScript,
  options: { speaker: Speaker; judge?: VoiceJudge; cache: RenderCache; facts?: Readonly<Record<string, { gender: 'man' | 'woman' }>>; signal?: AbortSignal },
  emit: (event: CastEvent) => void
): Promise<{ script: StoryScript; casting: CastingResult[] }> {
  const uncast = Object.values(script.cast).filter((m) => !m.voice);
  if (!uncast.length) return { script, casting: [] };
  if (!options.judge) throw new StoryError('uncast', `${uncast.map((m) => m.id).join(', ')} need a voice: give them a voice:, or build with a judge to cast from their briefs.`);
  return castVoices(script, { speaker: options.speaker, judge: options.judge, cache: options.cache, facts: options.facts, signal: options.signal, onEvent: emit });
}

/** `00/03/0007-june` → `audio/lines/00-03/0007-june.wav` */
export function linePath(id: string): string {
  const parts = id.split('/');
  return `audio/lines/${parts.slice(0, -1).join('-')}/${parts.at(-1)}.wav`;
}

/** `00/03` → `audio/music/00-03.mp3` */
export function musicPath(sceneId: string, mimeType: string): string {
  return `audio/music/${sceneId.replace(/\//g, '-')}.${mimeType.includes('wav') ? 'wav' : 'mp3'}`;
}

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'story';
}

function transcript(script: StoryScript, timeline: StoryTimeline): string {
  const lines = new Map(script.chapters.flatMap((c) => c.scenes.flatMap((s) => s.segments)).filter((s): s is Line => s.kind === 'line').map((l) => [l.id, l]));
  const out = [`# ${script.meta.title}`, ''];
  for (const scene of timeline.scenes) {
    if (scene.title) out.push(`## ${scene.title}`, '');
    for (const t of timeline.lines.filter((l) => l.id.startsWith(`${scene.id}/`))) {
      const line = lines.get(t.id)!;
      out.push(line.narration ? line.display : `**${line.speaker}**: ${line.display}`, '');
    }
  }
  return out.join('\n');
}

const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
