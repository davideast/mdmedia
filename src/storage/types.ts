import type { VoiceName } from '../types/voice.js';

export interface WordTiming {
  wordIndex: number;
  word: string;
  startMs: number;
  endMs: number;
  charStart: number;
  charEnd: number;
}

export interface ChunkTiming {
  chunkIndex: number;
  startMs: number;
  endMs: number;
  text: string;
  wordTimings?: WordTiming[];
}

export interface TrackMetadata {
  id: string;
  sessionId: string;
  stepIndex: number;
  title: string;
  slug: string;
  voice: VoiceName;
  style?: string;
  durationMs: number;
  charCount: number;
  chunkCount: number;
  createdAt: string;
  audioPath: string;
  transcriptPath: string;
  metadataPath: string;
  chunkTimings?: ChunkTiming[];
  transcript?: string;
}

export interface CatalogIndex {
  version: 1;
  updatedAt: string;
  tracks: TrackMetadata[];
}

export interface SaveTrackInput {
  id?: string;
  sessionId: string;
  stepIndex: number;
  markdown: string;
  transcript?: string;
  audioBuffer: Uint8Array;
  voice: VoiceName;
  style?: string;
  chunkTimings?: ChunkTiming[];
}

export interface TrackFilter {
  sessionId?: string;
  query?: string;
}
