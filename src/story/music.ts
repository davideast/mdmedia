import { RENDER_VERSION } from './key.js';
import { limiter } from './limit.js';
import { sha256 } from './parse.js';
import type { CachedMusic, Composer, MixBed, MixPlan, RenderCache } from './ports.js';
import type { StoryTimeline } from './schedule.js';
import type { StoryScript } from './types.js';

/** Music alone before a scene's first line. */
export const LEAD_MS = 3000;
/** The theme after the last line. */
export const OUTRO_MS = 12_000;
/** The bed's level under speech: about -10 dB. */
export const BED_GAIN = 0.3;
/** Every music prompt starts with this. */
export const MUSIC_PREFIX = 'Instrumental only, no vocals. ';

export interface MusicResult {
  scene: string;
  key: string;
  cached: boolean;
  ok: boolean;
  error?: string;
}

export type MusicEvent = { type: 'music-done'; result: MusicResult };

export async function musicRenderKey(cue: string, model: string): Promise<string> {
  return `music:${await sha256(JSON.stringify([RENDER_VERSION, model, MUSIC_PREFIX + cue]))}`;
}

/**
 * Composes one clip per distinct music cue, at most `concurrency` at a time,
 * and caches it. A failed clip is reported for its scenes, which then build
 * without music.
 */
export async function renderMusic(
  script: StoryScript,
  options: { composer: Composer; cache: RenderCache; concurrency?: number; signal?: AbortSignal; onEvent?: (event: MusicEvent) => void }
): Promise<{ clips: Map<string, CachedMusic>; results: MusicResult[] }> {
  const scenes = script.chapters.flatMap((c) => c.scenes).filter((s) => s.music);
  const byCue = new Map<string, Promise<{ music?: CachedMusic; key: string; cached: boolean; error?: string }>>();
  const limit = limiter(options.concurrency ?? 2);

  const compose = (cue: string) =>
    limit(async () => {
      const key = await musicRenderKey(cue, options.composer.model);
      const hit = await options.cache.getMusic(key);
      if (hit) return { music: hit, key, cached: true };
      try {
        options.signal?.throwIfAborted();
        const music = await options.composer.compose(MUSIC_PREFIX + cue, options.signal);
        await options.cache.putMusic(key, music);
        return { music, key, cached: false };
      } catch (error) {
        if (options.signal?.aborted) throw error;
        return { key, cached: false, error: error instanceof Error ? error.message : String(error) };
      }
    });

  const done = await Promise.all(
    scenes.map(async (scene) => {
      if (!byCue.has(scene.music!)) byCue.set(scene.music!, compose(scene.music!));
      const clip = await byCue.get(scene.music!)!;
      const result: MusicResult = { scene: scene.id, key: clip.key, cached: clip.cached, ok: Boolean(clip.music), ...(clip.error ? { error: clip.error } : {}) };
      options.onEvent?.({ type: 'music-done', result });
      return { scene: scene.id, music: clip.music, result };
    })
  );
  // Scene order, whatever order the clips finished in.
  const clips = new Map(done.filter((d) => d.music).map((d) => [d.scene, d.music!] as const));
  return { clips, results: done.map((d) => d.result) };
}

/**
 * The mix as data: the voice track, and each scene's clip starting where its
 * scene starts, full for the lead, down to a bed under the voices, then faded
 * out. The first scene's clip returns over an outro after the last line.
 */
export function buildMixPlan(timeline: StoryTimeline, voice: Uint8Array, clips: ReadonlyMap<string, CachedMusic>): MixPlan {
  const beds: MixBed[] = [];
  for (const scene of timeline.scenes) {
    const clip = clips.get(scene.id);
    if (!clip) continue;
    beds.push({
      audio: clip.bytes,
      mimeType: clip.mimeType,
      atMs: scene.startMs,
      envelope: [[0, 1], [LEAD_MS, 1], [LEAD_MS + 1500, BED_GAIN], [LEAD_MS + 16_000, BED_GAIN], [LEAD_MS + 22_000, 0]],
    });
  }
  const theme = timeline.scenes.map((s) => clips.get(s.id)).find(Boolean);
  if (!theme) return { voice, beds, durationMs: timeline.durationMs };
  beds.push({
    audio: theme.bytes,
    mimeType: theme.mimeType,
    atMs: Math.max(0, timeline.durationMs - 1000),
    envelope: [[0, BED_GAIN], [1000, 1], [8000, 1], [13_000, 0]],
  });
  return { voice, beds, durationMs: timeline.durationMs + OUTRO_MS };
}

/** Leads for the scenes that have a clip. */
export function sceneLeads(clips: ReadonlyMap<string, CachedMusic>): Map<string, number> {
  return new Map([...clips.keys()].map((id) => [id, LEAD_MS]));
}
