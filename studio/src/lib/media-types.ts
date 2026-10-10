/** Shared navigation vocabulary. Editors and generation options remain medium-specific. */
export type MediaType = 'narration' | 'image' | 'video' | 'music';
export const MEDIA_TYPES: Array<{ type: MediaType; label: string; composer: string; available: boolean }> = [
  { type: 'narration', label: 'Narration', composer: '/studio', available: true },
  { type: 'image', label: 'Image', composer: '/studio/image', available: true },
  { type: 'video', label: 'Video', composer: '/studio/video', available: false },
  { type: 'music', label: 'Music', composer: '/studio/music', available: false },
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
  id: string;
  mimeType: string;
  width: number;
  height: number;
  byteLength: number;
  links: { content: string; thumbnail: string };
}
export interface GenerationResource {
  id: string;
  itemId: string;
  type: MediaType;
  title: string;
  status: GenerationStatus;
  phase: string;
  createdAt: number;
  updatedAt: number;
  request: ImageRequest;
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
  latestGeneration: GenerationResource | null;
  result: GenerationResource | null;
  links: { self: string; web: string; generations: string };
}
