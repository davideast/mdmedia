/** Shared navigation vocabulary. Editors and generation options remain medium-specific. */
export type MediaType = 'narration' | 'image' | 'video' | 'music' | 'sfx' | 'analysis';
export const MEDIA_TYPES: Array<{ type: MediaType; label: string; composer: string; available: boolean }> = [
  { type: 'narration', label: 'Narration', composer: '/studio', available: true },
  { type: 'image', label: 'Image', composer: '/studio/image', available: true },
  { type: 'video', label: 'Video', composer: '/studio/video', available: true },
  { type: 'music', label: 'Music', composer: '/studio/music', available: true },
  { type: 'sfx', label: 'Sound effect', composer: '/studio/sfx', available: false },
  { type: 'analysis', label: 'Analysis', composer: '/studio/analysis', available: false },
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
  /** A locked item is kept until unlocked. See retention.ts. */
  locked?: boolean;
  /** When this item expires, set on the item itself. Null or absent means its type's default applies. */
  expiresAt?: number | null;
}
export type ImageThinkingLevel = 'minimal' | 'medium' | 'high';
export type ImageAction = 'initial' | 'refine' | 'regenerate';
export interface ImageSearchGrounding {
  web: boolean;
  imageSearch: boolean;
}
export interface ImageGroundingCitation {
  url: string;
  title?: string;
}
export interface ImageGroundingMetadata {
  citations: ImageGroundingCitation[];
  searchSuggestionsHtml?: string | null;
}
export interface ImageDraft {
  kind: 'image';
  prompt: string;
  model?: string;
  aspectRatio: string;
  resolution: string;
  adapt: boolean;
  instructions: string;
  referenceAssetId: string | null;
  referenceAssetIds?: string[];
  videoUri?: string;
  searchGrounding?: ImageSearchGrounding;
  thinkingLevel?: '' | ImageThinkingLevel;
}
export interface ImageRequest {
  prompt: string;
  model?: string;
  adaptation: { enabled: boolean; instructions: string };
  output: {
    aspectRatio: string;
    resolution: string | null;
    mimeType?: 'image/png' | 'image/jpeg' | null;
  };
  referenceAssetId: string | null;
  referenceAssetIds?: string[];
  videoUri?: string | null;
  searchGrounding?: ImageSearchGrounding;
  thinkingLevel?: ImageThinkingLevel | null;
  action?: ImageAction;
  fromGenerationId?: string | null;
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

export interface ImageGenerationResource extends GenerationBase {
  type: 'image';
  request: ImageRequest;
  interactionId?: string | null;
  parentGenerationId?: string | null;
  thoughtSummary?: string | null;
  grounding?: ImageGroundingMetadata | null;
}
export type GenerationResource = ImageGenerationResource | VideoGenerationResource | MusicGenerationResource | SfxGenerationResource | AnalysisGenerationResource;
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

/** API only: sound effects have no composer or web page yet. */
export interface SfxRequest {
  prompt: string;
  output: { format: 'mp3' | 'wav'; durationSeconds: number | null; loop: boolean };
  promptInfluence: number;
}
export interface SfxGenerationResource extends GenerationBase {
  type: 'sfx'; request: SfxRequest; provider: 'elevenlabs'; waveform: number[]; durationSeconds: number | null;
}
export interface SfxResource extends MediaSummary {
  type: 'sfx'; visibility: 'private'; request: SfxRequest;
  latestGenerationId: string; latestSuccessfulGenerationId: string | null;
  latestGeneration: SfxGenerationResource; result: SfxGenerationResource | null;
  links: { self: string; web: string; generations: string };
}

/** API only until the Studio UI lands: a video Gemini watched, and its Markdown answer. */
export type AnalysisSource =
  | { kind: 'video'; videoItemId: string; generationId: string | null; clip: number | null }
  | { kind: 'asset'; assetId: string }
  | { kind: 'youtube'; url: string };
export interface AnalysisRequest {
  prompt: string;
  source: AnalysisSource;
  /** Null uses the Studio default (`MDMEDIA_ANALYSIS_MODEL`, else the engine's). */
  model: string | null;
  /** Null keeps the model's default (static, 1 FPS). */
  processing: { mode: 'static' | 'agentic'; startSeconds: number | null; endSeconds: number | null; fps: number | null } | null;
  mediaResolution: 'low' | 'medium' | 'high' | 'ultra_high' | null;
  systemInstruction: string | null;
  /** A JSON Schema the answer must match; the answer is then saved as `application/json`. Null answers in Markdown. */
  responseSchema: Record<string, unknown> | null;
  /** A follow-up reuses the video context Gemini kept for this earlier attempt; no video is sent again. */
  previousInteractionId: string | null;
}
export interface AnalysisUsage { inputTokens?: number; outputTokens?: number; thoughtTokens?: number; toolUseTokens?: number; totalTokens?: number }
export interface AnalysisGenerationResource extends GenerationBase {
  type: 'analysis'; request: AnalysisRequest; provider: 'gemini';
  /** Send as `previousInteractionId` to ask a follow-up. */
  interactionId: string | null;
  /** While it runs: the latest step Gemini reported, one short line. Null otherwise. */
  progress: string | null;
  usage: AnalysisUsage | null; trace: string[];
  /** The narration started from this result, when the request asked for one. */
  narrationId: string | null;
  /** Why that narration could not start. The analysis itself is unaffected. */
  narrationError: { code: string; message: string } | null;
}
export interface AnalysisResource extends MediaSummary {
  type: 'analysis'; visibility: 'private'; request: AnalysisRequest;
  latestGenerationId: string; latestSuccessfulGenerationId: string | null;
  latestGeneration: AnalysisGenerationResource; result: AnalysisGenerationResource | null;
  links: { self: string; web: string; generations: string };
}
