import { VOICES } from './direct/voices.js';
import { RENDER_VERSION } from './key.js';
import { limiter } from './limit.js';
import { sha256 } from './parse.js';
import { wavFromPcm } from './pcm.js';
import type { RenderCache, Speaker, VoiceJudge, VoiceScore } from './ports.js';
import { spokenText } from './pronounce.js';
import type { CastId, Line, StoryScript } from './types.js';

export interface Audition extends VoiceScore {
  voice: string;
}

export interface CastingResult {
  id: CastId;
  voice: string;
  cached: boolean;
  /** The sample line the voices auditioned with. */
  sample: string;
  /** Every audition, best first. */
  ranked: Audition[];
}

export type CastEvent = { type: 'cast-done'; result: CastingResult };

export interface CastOptions {
  speaker: Speaker;
  judge: VoiceJudge;
  cache: RenderCache;
  /** The voices to audition; Gemini's prebuilt voices by default. */
  voices?: readonly string[];
  concurrency?: number;
  signal?: AbortSignal;
  onEvent?: (event: CastEvent) => void;
}

/**
 * Casts a voice for every cast member who has a brief and no voice. Each voice
 * auditions the character's first line with the brief as its delivery note; a
 * judge scores every take against the brief; the best fit is cast. The voice
 * names alone say little: a brief can make the same voice an old woman or a
 * child (voice audition, round 2), so every voice gets a turn. Results are
 * cached until the brief or the sample line changes. Returns the script with
 * the voices filled in.
 */
export async function castVoices(script: StoryScript, options: CastOptions): Promise<{ script: StoryScript; casting: CastingResult[] }> {
  const voices = options.voices ?? VOICES.map((v) => v.name);
  const limit = limiter(options.concurrency ?? 5);
  const lines = script.chapters.flatMap((c) => c.scenes.flatMap((s) => s.segments)).filter((s): s is Line => s.kind === 'line');
  const cast = { ...script.cast };

  // Characters cast at the same time, sharing one limit on requests.
  const results = await Promise.all(Object.values(script.cast).map(async (member): Promise<CastingResult | undefined> => {
    if (member.voice || !member.brief) return undefined;
    const line = lines.find((l) => l.speaker === member.id);
    if (!line) return undefined;
    const sample = spokenText(line.text, script.meta.pronounce);
    const note = `${member.brief.replace(/\.$/, '')}. ${line.cue}`.replace(/\. $/, '');
    const key = `casting:${await sha256(JSON.stringify([RENDER_VERSION, options.speaker.provider, options.judge.model, member.brief, sample, line.cue, voices]))}`;
    const hit = await options.cache.getImage(key);
    let result: CastingResult;
    if (hit) {
      result = { id: member.id, cached: true, ...(hit.meta as { voice: string; sample: string; ranked: Audition[] }) };
    } else {
      const auditions = await Promise.all(
        voices.map((voice) =>
          limit(async (): Promise<Audition | undefined> => {
            try {
              const pcm = await options.speaker.speak({ text: sample, voice, note, signal: options.signal });
              return { voice, ...(await options.judge.score({ wav: wavFromPcm(pcm), brief: member.brief!, signal: options.signal })) };
            } catch (error) {
              if (options.signal?.aborted) throw error;
              return undefined; // A refused or failed audition just doesn't count.
            }
          })
        )
      );
      const ranked = auditions.filter((a): a is Audition => Boolean(a)).sort((a, b) => b.fit - a.fit || b.who - a.who || b.texture - a.texture || b.accent - a.accent);
      if (!ranked.length) throw new Error(`No voice could audition for ${member.id}.`);
      result = { id: member.id, voice: ranked[0]!.voice, cached: false, sample, ranked };
      const meta = { voice: result.voice, sample, ranked };
      await options.cache.putImage(key, { bytes: new TextEncoder().encode(JSON.stringify(meta)), mimeType: 'application/json', meta });
    }
    cast[member.id] = { ...member, voice: result.voice };
    options.onEvent?.({ type: 'cast-done', result });
    return result;
  }));
  return { script: { ...script, cast }, casting: results.filter((r): r is CastingResult => Boolean(r)) };
}
