/** A video Gemini should watch: a local file, bytes already in memory, or a public YouTube link. */
export type VideoSource =
  | { kind: 'path'; path: string }
  | { kind: 'bytes'; bytes: Uint8Array; mimeType: string; name?: string }
  | { kind: 'youtube'; url: string };

export type VideoProcessing = 'static' | 'agentic';
export type MediaResolution = 'low' | 'medium' | 'high' | 'ultra_high';

/** Where a running analysis is; reported so a caller can show progress. */
export type AnalysisPhase = 'uploading' | 'processing' | 'analyzing';

export interface AnalyzeVideoOptions {
  /** Default `gemini-3.8-flash`. */
  model?: string;
  /** `static` (default) samples frames at a fixed rate; `agentic` lets the model navigate the timeline. */
  processing?: VideoProcessing;
  /** Static only: analyze from this many seconds in. */
  startSeconds?: number;
  /** Static only: analyze up to this many seconds in. */
  endSeconds?: number;
  /** Static only: frames sampled per second (the model's default is 1). */
  fps?: number;
  /** Maximum tokens per frame. Higher reads fine detail at more cost. */
  mediaResolution?: MediaResolution;
  systemInstruction?: string;
  /** A JSON Schema the answer must match. The answer is then JSON text instead of Markdown. */
  responseSchema?: Record<string, unknown>;
  /** Ask a follow-up about an earlier analysis; its video context is kept by the server. */
  previousInteractionId?: string;
  /** Run on the server and poll for the result (default true). */
  background?: boolean;
  /** Persist the provider receipt before waiting. A paid create is never retried. */
  onInteraction?: (interactionId: string) => Promise<void> | void;
  onPhase?: (phase: AnalysisPhase) => void;
  /**
   * While a background analysis runs: a short line each time Gemini reports a new step
   * (the title of a thought summary). Best effort; the answer never depends on it.
   */
  onProgress?: (step: string) => void;
  /** Non-fatal concerns found before the request, e.g. a model that cannot hear audio. */
  onWarning?: (message: string) => void;
  signal?: AbortSignal;
  /** Whole-request deadline (default 20 minutes). */
  timeoutMs?: number;
}

export interface VideoAnalysisUsage {
  inputTokens?: number;
  outputTokens?: number;
  thoughtTokens?: number;
  toolUseTokens?: number;
  totalTokens?: number;
}

export interface VideoAnalysisResult {
  interactionId: string;
  model: string;
  text: string;
  usage?: VideoAnalysisUsage;
  /** Thought summaries the model shared while it worked, oldest first. */
  trace: string[];
}

export interface IVideoAnalysisProvider {
  analyzeVideo(prompt: string, sources: VideoSource[], options?: AnalyzeVideoOptions): Promise<VideoAnalysisResult>;
  retrieveAnalysis(interactionId: string, options?: Pick<AnalyzeVideoOptions, 'signal' | 'timeoutMs' | 'onPhase' | 'onProgress'>): Promise<VideoAnalysisResult>;
}
