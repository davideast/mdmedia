import type { VideoBrief, VideoScript, ScriptShot } from './video-script';
import type { AudioPlacement } from './audio-placement';
import { readSceneDraft, serializeSceneDirection, type SceneDraft } from './scene-direction';
import { planSceneGeneration } from './scene-generation-plan';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_VIDEO_REQUEST_BYTES = 32 * 1024 * 1024;
export const MAX_REFERENCE_IMAGES = 6;
export const VIDEO_TIMEOUT_MS = 10 * 60 * 1000;
export const VIDEO_MODEL = 'gemini-omni-1.1-flash';
export const isVideoId = (value: string): boolean => /^v_[a-f0-9]{32}$/.test(value);

export interface VideoJob {
  id: string;
  status: 'generating' | 'saving' | 'ready' | 'partial' | 'error';
  message?: string;
  model: string;
  mode: SceneDraft['mode'];
  frame: SceneDraft['frame'];
  createdAt: number;
  updatedAt: number;
  durationSeconds?: number;
  requestedDurationSeconds?: number;
  direction?: SceneDraft;
  sourceAssetId?: string;
  exportInputs?: VideoExportClip[];
  exportAudio?: AudioPlacement[];
  exportCaptions?: {text:string;start:number;end:number}[];
  canContinue?: boolean;
  canExtend?: boolean;
  continuation?: { sourceVideoId: string; startSeconds: number };
}

export interface SceneBeatClip { placement?: ScriptShot; pendingVideoId?: string; takeHistory?: {videoId:string;inSeconds?:number;outSeconds?:number}[]; timingAccepted?: boolean; videoId?: string; inSeconds?: number; outSeconds?: number; muted?: boolean; excluded?: boolean; generationMode?: 'new' | 'continue'; transition?: 'cut' | 'fade'; transitionSeconds?: number }
export interface VideoExportClip { videoId: string; inSeconds: number; outSeconds: number; muted: boolean; transition?: 'cut' | 'fade'; transitionSeconds?: number }
export interface SceneDraftRecord { builtScript?: VideoScript; videoBrief?: VideoBrief; title?:string; audioPlacements?:AudioPlacement[]; draft: SceneDraft; videoId?: string; beatClips?: Record<string, SceneBeatClip>; exportId?: string; view?: 'writing' | 'tracks' }
export interface VideoRequest { id: string; draft: SceneDraft; prompt: string; firstFrame: File | null; references: File[]; resume?: { interactionId: string; durationSeconds: number }; continuation?: {sourceVideoId:string;startSeconds:number;interactionId?:string} }
export class VideoRequestError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

/** Bounded JSON bodies for continuation and export requests, including chunked uploads. */
export async function readVideoJson(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new VideoRequestError('The request is empty.');
  const parts: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 128 * 1024) { await reader.cancel(); throw new VideoRequestError('The request is too large.', 413); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new VideoRequestError('The request could not be read.'); }
}

export async function readVideoForm(request: Request): Promise<FormData> {
  const reader = request.body?.getReader();
  if (!reader) throw new VideoRequestError('Add scene direction before generating.');
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_VIDEO_REQUEST_BYTES) {
        await reader.cancel();
        throw new VideoRequestError('Keep the combined image upload under 32 MB.', 413);
      }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  try {
    return await new Request(request.url, { method: 'POST', headers: request.headers, body: bytes }).formData();
  } catch { throw new VideoRequestError('The scene upload could not be read. Try again.'); }
}

async function validateImage(file: File): Promise<void> {
  if (!file.size || file.size > MAX_IMAGE_BYTES) throw new VideoRequestError('Each image must be between 1 byte and 10 MB.', 413);
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const png = file.type === 'image/png' && [137,80,78,71,13,10,26,10].every((byte, index) => bytes[index] === byte);
  const jpeg = file.type === 'image/jpeg' && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const webp = file.type === 'image/webp' && String.fromCharCode(...bytes.slice(0,4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8,12)) === 'WEBP';
  if (!png && !jpeg && !webp) throw new VideoRequestError('Choose valid PNG, JPEG, or WebP images.');
}

export async function parseVideoRequest(form: FormData): Promise<VideoRequest> {
  const id = form.get('id');
  if (typeof id !== 'string' || !isVideoId(id)) throw new VideoRequestError('The generation request is invalid. Start a new request.');
  let draft: SceneDraft | null = null;
  const serialized = form.get('draft');
  if (typeof serialized !== 'string' || serialized.length > 30000) throw new VideoRequestError('Keep scene direction under 20,000 characters.');
  try { draft = readSceneDraft({ version: 1, draft: JSON.parse(serialized) }); } catch { /* validation below */ }
  if (!draft || !draft.beats.some(beat => beat.text.trim())) throw new VideoRequestError('Write what happens in your scene before generating.');
  try { planSceneGeneration(draft); } catch (error) { throw new VideoRequestError(error instanceof Error ? error.message : 'The scene timing is invalid.'); }
  const prompt = serializeSceneDirection(draft);
  if (prompt.length > 20000) throw new VideoRequestError('Keep scene direction under 20,000 characters.');
  const first = form.get('firstFrame');
  const firstFrame = first instanceof File ? first : null;
  const references = form.getAll('reference');
  if (references.some(value => !(value instanceof File)) || references.length > MAX_REFERENCE_IMAGES) throw new VideoRequestError('Use up to six reference images.');
  if (draft.mode === 'image' && !firstFrame) throw new VideoRequestError('Choose a first frame to animate.');
  if (draft.mode === 'references' && !references.length) throw new VideoRequestError('Choose at least one reference image.');
  if (draft.mode === 'text' && (firstFrame || references.length)) throw new VideoRequestError('Use image or reference mode when attaching images.');
  if (first !== null && !firstFrame) throw new VideoRequestError('Choose a valid first-frame image.');
  await Promise.all([...(firstFrame ? [firstFrame] : []), ...references as File[]].map(validateImage));
  const roles = [
    form.get('scope') === 'beat' ? 'Generate one standalone beat clip. Do not add editorial fade-in, fade-out, dissolves, or transitions. Track transitions are added separately during editing.' : '',
    firstFrame ? '[# Sources <FIRST_FRAME>@Image1] Use Image1 as the starting frame.' : '',
    references.length ? `[# References ${references.map((_, index) => `<IMAGE_REF_${index}>@Image${index + (firstFrame ? 2 : 1)}`).join(' ')}] Use the reference images for appearance and atmosphere, rather than literal initial frames.` : '',
  ].filter(Boolean).join('\n');
  return { id, draft, prompt: [roles, prompt].filter(Boolean).join('\n\n'), firstFrame, references: references as File[] };
}

export function videoFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout|timed out|abort/i.test(message)) return 'Generation took too long. Your direction is saved; try again.';
  if (/429|quota|resource.exhausted/i.test(message)) return 'Video generation is busy or its quota is exhausted. Try again later.';
  if (/safety|prohibited|blocked|policy/i.test(message)) return 'The model could not generate this scene. Adjust your direction and try again.';
  if (/403|404|permission|not found|api.key|credential/i.test(message)) return 'Video generation is unavailable for the configured model or credentials.';
  return 'The video could not be generated. Your direction is saved; try again.';
}
