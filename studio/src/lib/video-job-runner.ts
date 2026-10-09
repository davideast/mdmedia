import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IVideoProvider } from 'mdmedia/video';
import { videoFailure, VIDEO_TIMEOUT_MS, type VideoJob, type VideoRequest } from './video-generation';
import { planSceneGeneration, sceneDuration } from './scene-generation-plan';
import { serializeSceneDirection } from './scene-direction';

export interface VideoJobDependencies {
  provider: IVideoProvider;
  update: (patch: Partial<VideoJob> & { interactionId?: string }) => Promise<void>;
  save: (bytes: Uint8Array) => Promise<void>;
}

/** Owns temporary inputs, provider execution, and the persisted terminal state. */
export async function runVideoJob(request: VideoRequest, dependencies: VideoJobDependencies): Promise<void> {
  let directory: string | undefined;
  let savedDuration: number | undefined = request.resume?.durationSeconds;
  let savedClip = !!request.resume;
  let previousInteractionId: string | undefined = request.resume?.interactionId ?? request.continuation?.interactionId;
  const deadline = Date.now() + VIDEO_TIMEOUT_MS;
  const origin=request.continuation?.startSeconds??0;
  const localDuration=sceneDuration(request.draft);
  const requestedDuration = localDuration===undefined?undefined:origin+localDuration;
  try {
    directory = await mkdtemp(path.join(os.tmpdir(), 'mdmedia-scene-'));
    const writeImage = async (file: File, name: string) => {
      const extension = file.type === 'image/png' ? '.png' : file.type === 'image/webp' ? '.webp' : '.jpg';
      const filename = path.join(directory!, name + extension);
      await writeFile(filename, new Uint8Array(await file.arrayBuffer()));
      return filename;
    };
    const [firstFrame, referenceImages] = await Promise.all([
      request.firstFrame ? writeImage(request.firstFrame, 'first-frame') : Promise.resolve(undefined),
      Promise.all(request.references.map((file, index) => writeImage(file, `reference-${index}`))),
    ]);
    const baseOptions = {
      aspectRatio: request.draft.frame,
      task: firstFrame || request.draft.mode === 'image' ? 'image_to_video' as const : request.draft.mode === 'references' ? 'reference_to_video' as const : 'text_to_video' as const,
      firstFrame, referenceImages, delivery: 'uri' as const, timeoutMs: VIDEO_TIMEOUT_MS,
    };
    const steps = planSceneGeneration(request.draft);
    // Untimed scenes still use one model-selected clip. Timed scenes use explicit durations.
    const firstIndex = request.resume ? steps.findIndex(step => origin+step.end > request.resume!.durationSeconds + 0.25) : 0;
    if (firstIndex < 0) throw new Error('This scene is already complete.');
    for (let index = firstIndex; index < Math.max(1, steps.length); index++) {
      const step = steps[index];
      const extension = !!request.continuation || index > 0;
      const timeoutMs = Math.max(1, deadline - Date.now());
      if (extension) await dependencies.update({ status: 'generating', message: `Continuing shot ${Number((origin+step.start).toFixed(2))}–${Number((origin+step.end).toFixed(2))}s`, updatedAt: Date.now() });
      const prompt = extension
        ? `Extend the previous video by ${step.durationSeconds} seconds, continuing it to a total of ${Number((origin+step.end).toFixed(3))} seconds. Preserve the previous footage, subject identity, lighting, camera movement, and audio continuity. The following time cues are relative to the NEW continuation, covering shot time ${Number((origin+step.start).toFixed(3))}–${Number((origin+step.end).toFixed(3))}s. Continue any action already in progress in one continuous, unbroken shot; do not restart the scene or add cuts, fades, or dissolves.\n\n${step.direction}`
        : steps.length > 1
          ? `Generate the opening ${step.durationSeconds} seconds of this scene. Later beats will be generated in follow-up extensions.\n\n${request.prompt.replace(serializeSceneDirection(request.draft), step.direction)}`
          : request.prompt;
      const result = await dependencies.provider.generateVideoClip(prompt, extension
        ? { aspectRatio: request.draft.frame, referenceImages, previousInteractionId, durationSeconds: step.durationSeconds, delivery: 'uri', timeoutMs }
        : { ...baseOptions, timeoutMs, ...(step ? { durationSeconds: step.durationSeconds } : {}) });
      // Empty or non-MP4 data must never be labelled as a playable result.
      if (result.videoBytes.byteLength < 12 || result.videoBytes.byteLength > 200 * 1024 * 1024 ||
          String.fromCharCode(...result.videoBytes.slice(4, 8)) !== 'ftyp') throw new Error('Invalid MP4 returned by provider.');
      const duration = Number.isFinite(result.durationSeconds) ? result.durationSeconds : undefined;
      // An extension must return the full continued scene, not just a shorter tail.
      if (extension && (duration === undefined || duration <= (savedDuration??origin) + 0.25)) throw new Error('The extension did not return a longer scene.');
      await dependencies.update({ status: 'saving', updatedAt: Date.now() });
      await dependencies.save(result.videoBytes);
      savedClip = true; savedDuration = duration; previousInteractionId = result.interactionId;
      if (index < steps.length - 1) await dependencies.update({ status: 'generating', interactionId: previousInteractionId, updatedAt: Date.now(), ...(duration !== undefined ? { durationSeconds: duration } : {}) });
      if ((steps.length > 1||request.continuation) && (duration === undefined || Math.abs(duration - (origin+step.end)) > 0.25)) throw new Error('The generated duration did not match the scene timing.');
    }
    const mismatch = requestedDuration !== undefined && savedDuration !== undefined && Math.abs(savedDuration - requestedDuration) > 0.25;
    await dependencies.update({ status: mismatch ? 'partial' : 'ready', interactionId: previousInteractionId, ...(savedDuration !== undefined ? { durationSeconds: savedDuration } : {}), message: mismatch ? `Generated ${savedDuration!.toFixed(1)}s of the requested ${requestedDuration}s. The model did not match the requested duration.` : '', updatedAt: Date.now() });
  } catch (error) {
    console.error('[video] generation failed:', error instanceof Error ? error.message : error);
    await dependencies.update({ status: savedClip ? 'partial' : 'error', ...(savedDuration !== undefined ? { durationSeconds: savedDuration } : {}), ...(previousInteractionId ? { interactionId: previousInteractionId } : {}), message: savedClip ? `${savedDuration?.toFixed(1) ?? 'Some'} seconds saved${requestedDuration ? ` of ${requestedDuration}s requested` : ''}. The full scene could not be completed. ${videoFailure(error)}` : videoFailure(error), updatedAt: Date.now() });
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
