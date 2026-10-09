import { randomUUID } from 'node:crypto';
import { decodeImage, imageMimeType } from './image-data.js';
import { ImageHttpClient, type ImageHttpOptions } from './http.js';
import { parseImageSize, validateImageRequest } from './selection.js';
import type { IImageProvider, ImageRequest, ImageResult } from './types.js';

export interface RetroDiffusionOptions extends ImageHttpOptions {
  /** Persist the key before the paid POST so ambiguous admission can be investigated. */
  onSubmitting?: (receipt: { idempotencyKey: string }) => Promise<void>;
  /** Persist this receipt before polling; useful for recovering a job without resubmission. */
  onSubmitted?: (receipt: { taskId: string; requestId?: string; idempotencyKey: string }) => Promise<void>;
}

export class RetroDiffusionImageProvider implements IImageProvider {
  private readonly http: ImageHttpClient;
  constructor(private readonly apiKey: string, private readonly options: RetroDiffusionOptions = {}) {
    if (!apiKey.trim()) throw new Error('RETRODIFFUSION_API_KEY is required for image generation.');
    this.http = new ImageHttpClient(options);
  }

  async generate(input: ImageRequest): Promise<ImageResult> {
    const request = validateImageRequest('retrodiffusion', input);
    const idempotencyKey = randomUUID();
    await this.options.onSubmitting?.({ idempotencyKey });
    const { body, requestId } = await this.http.json('https://api.retrodiffusion.ai/v2/inferences', {
      method: 'POST', headers: this.headers(idempotencyKey),
      body: JSON.stringify({
        prompt: request.prompt, prompt_style: request.style ?? `${request.model}__default`,
        ...parseImageSize(request.size ?? '128x128'), num_images: 1,
        remove_bg: request.background === 'transparent', seed: request.seed,
        input_image: request.reference ? Buffer.from(request.reference.bytes).toString('base64') : undefined,
      }),
    });
    if (!body.task_id) throw new Error('Retro Diffusion returned no task ID; submission was not retried.');
    const taskId = String(body.task_id);
    try {
      await this.options.onSubmitted?.({ taskId, requestId, idempotencyKey });
      return await this.poll(taskId, request.model, requestId);
    } catch (error) {
      throw new Error(`Retro Diffusion task ${taskId}: ${error instanceof Error ? error.message : 'polling failed'}. Retrieve this task before generating again.`, { cause: error });
    }
  }

  /** Poll a previously submitted job without creating another paid inference. */
  async poll(taskId: string, model: string, requestId?: string): Promise<ImageResult> {
    const deadline = Date.now() + this.http.timeoutMs;
    while (Date.now() < deadline) {
      const { body } = await this.http.json(
        `https://api.retrodiffusion.ai/v2/inferences/tasks/${encodeURIComponent(taskId)}`,
        { headers: this.headers() }, deadline - Date.now()
      );
      if (body.status === 'failed') throw new Error(`Job failed: ${body.error?.code ?? 'inference_failed'}.`);
      if (body.status === 'succeeded') {
        const result = body.result;
        let imageBytes: Uint8Array;
        if (result?.base64_images?.[0]) imageBytes = decodeImage(result.base64_images[0]);
        else if (result?.output_urls?.[0]) imageBytes = await this.http.download(result.output_urls[0], Math.max(1, deadline - Date.now()));
        else throw new Error('Job completed without an image.');
        return {
          imageBytes, mimeType: imageMimeType(imageBytes), provider: 'retrodiffusion', model,
          requestId: result.request_id ?? requestId ?? taskId,
          usage: { balanceCost: result.balance_cost, taskId, outputsRetainedUntil: result.outputs_retained_until },
        };
      }
      if (!['pending', 'running'].includes(body.status)) throw new Error(`Unexpected job status: ${body.status}.`);
      await this.http.sleep(Math.min(this.http.pollIntervalMs, Math.max(0, deadline - Date.now())));
    }
    throw new Error(`Polling timed out for task ${taskId}; the job may still finish.`);
  }

  private headers(idempotencyKey?: string): Record<string, string> {
    return { 'X-RD-Token': this.apiKey, 'Content-Type': 'application/json', ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) };
  }
}
