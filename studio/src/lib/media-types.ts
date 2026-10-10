/** Shared navigation vocabulary. Editors and generation options remain medium-specific. */
export type MediaType = 'narration' | 'image' | 'video' | 'music';
export const MEDIA_TYPES: Array<{ type: MediaType; label: string; composer: string; available: boolean }> = [
  { type: 'narration', label: 'Narration', composer: '/studio', available: true },
  { type: 'image', label: 'Image', composer: '/studio/image', available: true },
  { type: 'video', label: 'Video', composer: '/studio/video', available: true },
  { type: 'music', label: 'Music', composer: '/studio/music', available: true },
];
export type GenerationStatus = 'queued' | 'generating' | 'ready' | 'error' | 'interrupted';
export interface MediaSummary {
  id: string;
  type: MediaType;
  title: string;
  status: GenerationStatus;
  createdAt: number;
  updatedAt: number;
  href: string;
  thumbnailAssetId: string | null;
  durationMs?: number;
  sourcePreview?: string;
}
export interface ImageDraft {
  kind: 'image';
  prompt: string;
  aspectRatio: string;
  resolution: string;
  adapt: boolean;
  instructions: string;
  referenceAssetId: string | null;
}
export interface ImageRequest {
  prompt: string;
  adaptation: { enabled: boolean; instructions: string };
  output: { aspectRatio: string; resolution: string | null };
  referenceAssetId: string | null;
}
export interface AssetResource {
  durationMs?: number;
  id: string;
  mimeType: string;
  width: number;
  height: number;
  byteLength: number;
  links: { content: string; thumbnail: string };
}
interface GenerationBase {
  id: string;
  itemId: string;
  title: string;
  status: GenerationStatus;
  phase: string;
  createdAt: number;
  updatedAt: number;
  preparedPrompt: string | null;
  provider: string;
  model: string;
  assets: AssetResource[];
  error: { code: string; message: string } | null;
  links: { self: string; web: string };
}
export interface ImageResource extends MediaSummary {
  visibility: 'private';
  request: ImageRequest;
  latestGenerationId: string;
  latestSuccessfulGenerationId: string | null;
  latestGeneration: ImageGenerationResource | null;
  result: ImageGenerationResource | null;
  links: { self: string; web: string; generations: string };
}

export interface ImageGenerationResource extends GenerationBase { type: 'image'; request: ImageRequest }
export type GenerationResource = ImageGenerationResource | VideoGenerationResource | MusicGenerationResource;
export interface VideoRequest {
  prompt: string;
  adaptation: { enabled: boolean; instructions: string };
  output: { aspectRatio: '16:9' | '9:16'; resolution: '360p' | '720p' | '1080p' | '4k'; durationSeconds: number };
  referenceAssetId: string | null;
  referenceRole: 'first_frame' | 'reference';
}
export interface VideoDraft extends VideoRequest { kind: 'video' }
export type VideoAction = 'initial' | 'continue' | 'regenerate_latest';
export interface VideoClip { index: number; generationId: string; startSeconds: number; endSeconds: number; thumbnail: string; content: string }
export interface VideoGenerationResource extends GenerationBase {
  type: 'video'; request: VideoRequest; action: VideoAction; parentGenerationId: string | null;
  replacesGenerationId: string | null; clipNumber: number; durationSeconds: number | null; clipDurationSeconds: number | null;
}
export interface VideoResource extends MediaSummary {
  type: 'video'; visibility: 'private'; request: VideoRequest;
  latestGenerationId: string; latestSuccessfulGenerationId: string | null;
  latestGeneration: VideoGenerationResource; result: VideoGenerationResource | null;
  clips: VideoClip[];
  canContinue: boolean;
  links: { self: string; web: string; generations: string };
}

export interface MusicRequest {
  prompt: string;
  adaptation: { enabled: boolean; instructions: string };
  output: { mode: 'song' | 'clip'; format: 'mp3' | 'wav' };
  vocals: 'auto' | 'vocals' | 'instrumental';
  lyrics: string;
  referenceAssetId: string | null;
}
export interface MusicDraft extends MusicRequest { kind: 'music' }
export interface MusicGenerationResource extends GenerationBase {
  type: 'music'; request: MusicRequest; lyrics: string | null; waveform: number[]; durationSeconds: number | null;
}
export interface MusicResource extends MediaSummary {
  type: 'music'; visibility: 'private'; request: MusicRequest;
  latestGenerationId: string; latestSuccessfulGenerationId: string | null;
  latestGeneration: MusicGenerationResource; result: MusicGenerationResource | null;
  links: { self: string; web: string; generations: string };
}
