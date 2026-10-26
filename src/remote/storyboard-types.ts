/** An independent story plan. Board and Script edit the same document. */
export interface StoryBeat {
  id: string;
  title: string;
  purpose: string;
  /** A concise walkthrough of this moment, separate from verbatim narration. */
  summary?: string;
  script: string;
  visual: string;
  /** Optional local concept artwork, separate from production footage. */
  image?: string;
  notes: string;
  status: 'draft' | 'decided';
  estimatedSeconds: number | null;
}

export interface StoryboardDocument {
  version: 1;
  premise: string;
  beats: StoryBeat[];
}

export interface SavedStoryboard {
  revision: number;
  updatedAt: number;
  document: StoryboardDocument;
}

export interface StoryboardResource {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  storyboard: SavedStoryboard | null;
}

export interface StoryboardSummary {
  id: string;
  title: string;
  beatCount: number;
  image: string | null;
  updatedAt: number;
}

export interface StoryboardNarrationRequest {
  markdown: string;
  voice: string;
  voiceProvider: 'gemini' | 'elevenlabs';
  voiceId: string;
  model?: string;
  promptStyle: string;
  speed: number;
}
