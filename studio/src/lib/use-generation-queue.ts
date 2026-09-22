'use client';

import { useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { auth } from './firebase';
import { deleteNarration, generateNarrationId } from './narrations';
import type { NarrationErrorCategory, StreamEvent, Visibility, VoiceName } from './types';

export type JobStatus = 'queued' | 'starting' | 'streaming' | 'ready' | 'error';

export interface GenerationJob {
  id: string;
  narrationId: string | null;
  title: string;
  markdown: string;
  voice: VoiceName;
  promptStyle: string;
  rewriteForNarration: boolean;
  rewriteInstructions?: string;
  visibility: Visibility;
  status: JobStatus;
  errorMessage: string | null;
  errorCode?: string;
  errorCategory?: NarrationErrorCategory;
  errorChunkIndex?: number;
  errorActionableHint?: string;
  errorRetryable?: boolean;
  totalChunks: number;
  completedChunks: number;
  totalChars: number;
  createdAt: number;
  updatedAt: number;
}

export interface GenerationQueueState {
  jobs: GenerationJob[];
  activeCount: number;
  queueNarration: (input: {
    markdown: string;
    voice: VoiceName;
    promptStyle: string;
    rewriteForNarration: boolean;
    rewriteInstructions?: string;
    visibility: Visibility;
  }) => Promise<string>;
  retryJob: (jobId: string) => Promise<string | null>;
  cancelJob: (jobId: string) => void;
  dismissJob: (jobId: string) => void;
  clearCompleted: () => void;
}

async function currentIdToken(): Promise<string | null> {
  const user = auth().currentUser;
  if (!user) return null;
  try {
    return await user.getIdToken();
  } catch {
    return null;
  }
}

function deriveInitialTitle(markdown: string): string {
  const lines = markdown
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return 'Untitled Narration';
  const first = lines[0].replace(/^#+\s*/, '').replace(/[*_`]/g, '').trim();
  return first.slice(0, 60) || 'Untitled Narration';
}

/**
 * Manages asynchronous background generation of narrations in a non-blocking queue.
 * Processing runs in the background without interrupting current playback.
 */
export function useGenerationQueue(): GenerationQueueState {
  const [jobs, setJobs] = useState<GenerationJob[]>([]);
  const router = useRouter();
  const controllersRef = useRef<Map<string, AbortController>>(new Map());
  const jobsRef = useRef<GenerationJob[]>([]);
  jobsRef.current = jobs;

  const updateJob = useCallback((jobId: string, patch: Partial<GenerationJob>) => {
    setJobs((previous) =>
      previous.map((job) => (job.id === jobId ? { ...job, ...patch, updatedAt: Date.now() } : job)),
    );
  }, []);

  const cancelJob = useCallback(
    async (jobId: string) => {
      const controller = controllersRef.current.get(jobId);
      if (controller) {
        controller.abort();
        controllersRef.current.delete(jobId);
      }

      const job = jobsRef.current.find((j) => j.id === jobId);
      const narrationId = job?.narrationId;

      // Remove job immediately from local state so it does not spin or linger
      setJobs((previous) => previous.filter((j) => j.id !== jobId));
      toast.info('Generation cancelled');

      if (narrationId) {
        try {
          void deleteNarration(narrationId);
        } catch (err) {
          console.error('Failed to purge cancelled narration data:', err);
        }
      }
    },
    [],
  );

  const dismissJob = useCallback((jobId: string) => {
    setJobs((previous) => previous.filter((job) => job.id !== jobId));
  }, []);

  const clearCompleted = useCallback(() => {
    setJobs((previous) =>
      previous.filter((job) => job.status === 'queued' || job.status === 'starting' || job.status === 'streaming'),
    );
  }, []);

  const queueNarration = useCallback(
    async (input: {
      markdown: string;
      voice: VoiceName;
      promptStyle: string;
      rewriteForNarration: boolean;
      rewriteInstructions?: string;
      visibility: Visibility;
    }): Promise<string> => {
      const jobId = `job_${Math.random().toString(36).slice(2, 9)}_${Date.now()}`;
      const narrationId = generateNarrationId();
      const controller = new AbortController();
      controllersRef.current.set(jobId, controller);

      const title = deriveInitialTitle(input.markdown);
      const newJob: GenerationJob = {
        id: jobId,
        narrationId,
        title,
        markdown: input.markdown,
        voice: input.voice,
        promptStyle: input.promptStyle,
        rewriteForNarration: input.rewriteForNarration,
        rewriteInstructions: input.rewriteInstructions,
        visibility: input.visibility,
        status: 'queued',
        errorMessage: null,
        totalChunks: 0,
        completedChunks: 0,
        totalChars: input.markdown.length,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      setJobs((previous) => [newJob, ...previous]);

      // Execute synthesis asynchronously in the background
      (async () => {
        updateJob(jobId, { status: 'starting' });

        const token = await currentIdToken();
        if (!token) {
          updateJob(jobId, {
            status: 'error',
            errorMessage: 'Please sign in to create a narration.',
          });
          toast.error('Please sign in to create a narration.');
          controllersRef.current.delete(jobId);
          return;
        }

        let response: Response;
        try {
          response = await fetch('/api/narrations', {
            method: 'POST',
            signal: controller.signal,
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ ...input, id: narrationId }),
          });
        } catch {
          if (controller.signal.aborted) {
            controllersRef.current.delete(jobId);
            return;
          }
          const errorMsg = 'Failed to connect to narration service.';
          updateJob(jobId, { status: 'error', errorMessage: errorMsg });
          toast.error(errorMsg);
          controllersRef.current.delete(jobId);
          return;
        }

        if (!response.ok || !response.body) {
          let errorMsg = 'Failed to start synthesis.';
          try {
            const body = (await response.json()) as { message?: string };
            if (body.message) errorMsg = body.message;
          } catch {
            // Ignore json parse error
          }
          updateJob(jobId, { status: 'error', errorMessage: errorMsg });
          toast.error(errorMsg);
          controllersRef.current.delete(jobId);
          return;
        }

        updateJob(jobId, { status: 'streaming' });

        let currentJobTitle = title;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        const handleEvent = (event: StreamEvent) => {
          switch (event.type) {
            case 'meta': {
              currentJobTitle = event.title;
              updateJob(jobId, {
                narrationId: event.id,
                title: event.title,
                totalChunks: event.totalChunks ?? 0,
                totalChars: event.totalChars ?? 0,
              });
              break;
            }
            case 'chunk': {
              setJobs((previous) =>
                previous.map((j) =>
                  j.id === jobId
                    ? {
                        ...j,
                        completedChunks: j.completedChunks + 1,
                        updatedAt: Date.now(),
                      }
                    : j,
                ),
              );
              break;
            }
            case 'done': {
              updateJob(jobId, {
                status: 'ready',
                narrationId: event.id,
              });
              toast.success(`Narration "${currentJobTitle}" is ready`, {
                action: {
                  label: 'View',
                  onClick: () => router.push(`/narration/${event.id}`),
                },
              });
              break;
            }
            case 'error': {
              updateJob(jobId, {
                status: 'error',
                errorMessage: event.message,
                errorCode: event.code,
                errorCategory: event.category,
                errorChunkIndex: event.chunkIndex,
                errorActionableHint: event.actionableHint,
                errorRetryable: event.retryable,
              });
              if (event.category === 'policy') {
                toast.error(`Narration "${currentJobTitle}" blocked by safety policy`, {
                  description: event.actionableHint || event.message,
                });
              } else {
                toast.error(`Narration "${currentJobTitle}" failed: ${event.message}`);
              }
              break;
            }
          }
        };

        const consumeLines = (flush: boolean) => {
          let newline = buffer.indexOf('\n');
          while (newline >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (line.length > 0) {
              try {
                handleEvent(JSON.parse(line) as StreamEvent);
              } catch {
                // Ignore incomplete frame
              }
            }
            newline = buffer.indexOf('\n');
          }
          if (flush && buffer.trim().length > 0) {
            try {
              handleEvent(JSON.parse(buffer.trim()) as StreamEvent);
            } catch {
              // Ignore incomplete frame
            }
            buffer = '';
          }
        };

        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            consumeLines(false);
          }
          buffer += decoder.decode();
          consumeLines(true);
        } catch {
          if (!controller.signal.aborted) {
            updateJob(jobId, {
              status: 'error',
              errorMessage: 'Connection lost during synthesis.',
            });
          }
        } finally {
          controllersRef.current.delete(jobId);
        }
      })();

      return jobId;
    },
    [router, updateJob],
  );

  const activeCount = jobs.filter(
    (job) => job.status === 'queued' || job.status === 'starting' || job.status === 'streaming',
  ).length;

  const retryJob = useCallback(
    async (jobId: string): Promise<string | null> => {
      const existingJob = jobsRef.current.find((job) => job.id === jobId);
      if (!existingJob) return null;
      dismissJob(jobId);
      return queueNarration({
        markdown: existingJob.markdown,
        voice: existingJob.voice,
        promptStyle: existingJob.promptStyle,
        rewriteForNarration: existingJob.rewriteForNarration,
        rewriteInstructions: existingJob.rewriteInstructions,
        visibility: existingJob.visibility,
      });
    },
    [dismissJob, queueNarration],
  );

  return {
    jobs,
    activeCount,
    queueNarration,
    retryJob,
    cancelJob,
    dismissJob,
    clearCompleted,
  };
}
