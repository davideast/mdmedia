import { GoogleGenAI } from '@google/genai';
import { LyriaMusicProvider } from '../../music/lyria-music-provider.js';
import type { Composer } from '../ports.js';

export const DEFAULT_STORY_MUSIC_MODEL = 'lyria-3-clip-preview';

/** Scene music from Lyria: about 30 seconds per prompt, as MP3. */
export function createLyriaComposer(options: { apiKey: string; model?: string }): Composer {
  const model = options.model ?? DEFAULT_STORY_MUSIC_MODEL;
  const lyria = new LyriaMusicProvider(new GoogleGenAI({ apiKey: options.apiKey }));
  return {
    model,
    async compose(prompt, signal) {
      const result = await lyria.generate(prompt, { model, signal });
      return { bytes: result.audioBytes, mimeType: result.mimeType || 'audio/mpeg' };
    },
  };
}
