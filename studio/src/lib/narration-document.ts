import type { Narration } from './types';
import type { NarrationTimingsFile } from './wav';

export interface NarrationDocument {
  id: string;
  title: string;
  durationMs?:number;
  ownerUid?: string;
  voice: string | null;
  transcript: string;
  sourceMarkdown: string | null;
  adapted: boolean;
  chunks: NarrationTimingsFile['chunks'];
  status: 'loading' | 'streaming' | 'ready' | 'error';
  errorMessage: string | null;
}

interface DocumentSource {
  watch: (id: string, receive: (narration: Narration | null) => void, fail: (error: Error) => void) => () => void;
  timings: (id: string, signal: AbortSignal) => Promise<NarrationTimingsFile | null>;
}

/** Reads a document and alignment checkpoints. It has no audio/player dependency. */
export function observeNarrationDocument(id: string, source: DocumentSource, receive: (document: NarrationDocument) => void): () => void {
  const controller = new AbortController();
  let document: NarrationDocument = { id, title: '', voice: null, transcript: '', sourceMarkdown: null, adapted: false,
    chunks: [], status: 'loading', errorMessage: null };
  let checkpoint = '';
  let revision = 0;
  const publish = () => { if (!controller.signal.aborted) receive(document); };
  publish();
  const unsubscribe = source.watch(id, (narration) => {
    if (controller.signal.aborted) return;
    if (!narration) {
      revision++;
      document = { ...document, chunks: [], transcript: '', sourceMarkdown: null, status: 'error', errorMessage: "That narration isn't available." };
      publish();
      return;
    }
    document = { ...document,ownerUid:narration.ownerUid,durationMs:narration.durationMs, title: narration.title, voice: narration.voice, transcript: narration.transcript,
      sourceMarkdown: narration.sourceMarkdown, adapted: narration.adapted, status: narration.status,
      errorMessage: narration.errorMessage ?? null };
    publish();
    const nextCheckpoint = `${narration.status}:${narration.durationMs}`;
    if (checkpoint === nextCheckpoint || narration.status === 'error' || !narration.durationMs) return;
    checkpoint = nextCheckpoint;
    const request = ++revision;
    void source.timings(id, controller.signal).then((timings) => {
      if (controller.signal.aborted || request !== revision || !timings) return;
      document = { ...document, chunks: [...timings.chunks].sort((a, b) => a.index - b.index),
        transcript: document.transcript || timings.transcript || '',
        sourceMarkdown: document.sourceMarkdown ?? timings.sourceMarkdown ?? null };
      publish();
    }).catch(() => {
      // Text remains readable if a checkpoint is unavailable. Playback reports audio errors separately.
    });
  }, (error) => {
    revision++;
    document = { ...document, chunks: [], transcript: '', sourceMarkdown: null, status: 'error', errorMessage: error.message || 'Could not load this narration.' };
    publish();
  });
  return () => { controller.abort(); unsubscribe(); };
}
