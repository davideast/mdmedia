import { MediaError, validMediaId } from './image-request';
import type { MusicRequest } from './media-types';
export const MAX_MUSIC_PROMPT = 32_000;
export const MAX_MUSIC_BYTES = 100 * 1024 * 1024;
export const DEFAULT_MUSIC_REQUEST: MusicRequest = {
  prompt: '', adaptation: { enabled: false, instructions: '' },
  output: { mode: 'song', format: 'mp3' }, vocals: 'auto', lyrics: '', referenceAssetId: null,
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MediaError(400, 'invalid_body', 'Send a JSON object.');
  return value as Record<string, unknown>;
}
function fields(raw: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(raw).some(key => !allowed.includes(key))) throw new MediaError(400, 'unknown_fields', 'Unknown music settings.');
}
export function parseMusicRequest(body: unknown, defaults = DEFAULT_MUSIC_REQUEST): MusicRequest {
  const raw = object(body); fields(raw, ['prompt', 'adaptation', 'output', 'vocals', 'lyrics', 'referenceAssetId']);
  if (typeof raw.prompt !== 'string' || !raw.prompt.trim() || raw.prompt.length > MAX_MUSIC_PROMPT) throw new MediaError(400, 'invalid_prompt', 'Enter a prompt of 1–32,000 characters.');
  const adaptation = raw.adaptation === undefined ? {} : object(raw.adaptation); fields(adaptation, ['enabled', 'instructions']);
  const enabled = adaptation.enabled ?? defaults.adaptation.enabled;
  const instructions = adaptation.instructions ?? defaults.adaptation.instructions;
  if (typeof enabled !== 'boolean' || typeof instructions !== 'string' || instructions.length > 4000) throw new MediaError(400, 'invalid_adaptation', 'Use a toggle and instructions of at most 4,000 characters.');
  const output = raw.output === undefined ? {} : object(raw.output); fields(output, ['mode', 'format']);
  const mode = output.mode ?? defaults.output.mode, format = output.format ?? defaults.output.format;
  if (mode !== 'song' && mode !== 'clip') throw new MediaError(400, 'invalid_mode', 'Choose a full song or a 30-second clip.');
  if (format !== 'mp3' && format !== 'wav') throw new MediaError(400, 'invalid_format', 'Choose MP3 or WAV.');
  const vocals = raw.vocals === undefined ? defaults.vocals : raw.vocals, lyrics = raw.lyrics === undefined ? defaults.lyrics : raw.lyrics;
  if (!['auto', 'vocals', 'instrumental'].includes(String(vocals))) throw new MediaError(400, 'invalid_vocals', 'Choose automatic, vocals, or instrumental.');
  if (typeof lyrics !== 'string' || lyrics.length > 8000) throw new MediaError(400, 'invalid_lyrics', 'Lyrics must be at most 8,000 characters.');
  if (vocals === 'instrumental' && lyrics.trim()) throw new MediaError(400, 'conflicting_lyrics', 'Remove lyrics for an instrumental.');
  const referenceAssetId = raw.referenceAssetId === undefined ? defaults.referenceAssetId : raw.referenceAssetId;
  if (referenceAssetId !== null && (typeof referenceAssetId !== 'string' || !validMediaId(referenceAssetId))) throw new MediaError(400, 'invalid_reference', 'Choose an uploaded reference image.');
  return { prompt: raw.prompt, adaptation: { enabled, instructions }, output: { mode, format }, vocals: vocals as MusicRequest['vocals'], lyrics, referenceAssetId };
}
export function readMusicDefaults(value: unknown): MusicRequest {
  try { return { ...parseMusicRequest({ ...object(value), prompt: 'defaults', lyrics: '' }), prompt: '', lyrics: '', referenceAssetId: null }; }
  catch { return structuredClone(DEFAULT_MUSIC_REQUEST); }
}
/** These are explicit prompt directions, not native finite-song API configuration. */
export function musicPrompt(request: MusicRequest, prepared = request.prompt): string {
  return [prepared, request.vocals === 'instrumental' ? 'Instrumental only. No vocals or sung words.' : request.vocals === 'vocals' ? 'Include sung vocals.' : '',
    request.lyrics.trim() ? `Sing these lyrics:\n${request.lyrics}` : ''].filter(Boolean).join('\n\n');
}
