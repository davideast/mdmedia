import type { ImageRequest } from './media-types';

/** Provider-independent execution seam. Persistence/leases live in the server repository. */
export interface ImageJobExecutor {
  prepare(source: string, instructions: string): Promise<string>;
  generate(prompt: string, request: ImageRequest): Promise<Uint8Array>;
  checkpoint(phase: string, preparedPrompt?: string): Promise<void>;
  save(bytes: Uint8Array): Promise<void>;
}
export async function executeImageJob(request: ImageRequest, executor: ImageJobExecutor) {
  let prompt = request.prompt;
  if (request.adaptation.enabled) {
    await executor.checkpoint('preparing');
    prompt = await executor.prepare(request.prompt, request.adaptation.instructions);
  }
  await executor.checkpoint('generating', prompt);
  const bytes = await executor.generate(prompt, request);
  await executor.checkpoint('saving', prompt);
  await executor.save(bytes);
}

export function decideIdempotentReplay(stored: { requestHash: string; itemId: string; generationId: string } | null, requestHash: string) {
  if (!stored) return { kind: 'new' as const };
  if (stored.requestHash !== requestHash) return { kind: 'conflict' as const };
  return { kind: 'replay' as const, itemId: stored.itemId, generationId: stored.generationId };
}
