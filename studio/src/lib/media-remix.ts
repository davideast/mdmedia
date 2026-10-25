import { studioJson } from './media-client';
import { formatMediaMarkdownRef } from './tree-fakes';
import type {
  MediaRemixKind,
  MediaRemixRequest,
  MediaRemixResult,
  TreeMediaRef,
  TreeNodeId,
  TreeOp,
} from './tree-types';

export interface RemixActionSpec {
  kind: MediaRemixKind;
  label: string;
  targetType: TreeMediaRef['type'];
}

export const REMIX_ACTIONS_BY_SOURCE: Record<TreeMediaRef['type'], RemixActionSpec[]> = {
  image: [
    { kind: 'image_to_image', label: 'Refine Image', targetType: 'image' },
    {
      kind: 'image_to_video_first_frame',
      label: 'Animate as Video (First Frame)',
      targetType: 'video',
    },
    { kind: 'image_to_video_reference', label: 'Video with Reference', targetType: 'video' },
    { kind: 'image_to_music', label: 'Score Music from Mood', targetType: 'music' },
  ],
  video: [
    { kind: 'video_extend', label: 'Continue Shot', targetType: 'video' },
    { kind: 'video_edit', label: 'Remix Video', targetType: 'video' },
    { kind: 'video_to_image', label: 'Extract / Restyle Frame', targetType: 'image' },
  ],
  mermaid: [{ kind: 'mermaid_to_image', label: 'Render Illustration', targetType: 'image' }],
  asset: [
    { kind: 'image_to_image', label: 'Refine Image', targetType: 'image' },
    {
      kind: 'image_to_video_first_frame',
      label: 'Animate as Video (First Frame)',
      targetType: 'video',
    },
    { kind: 'image_to_video_reference', label: 'Video with Reference', targetType: 'video' },
    { kind: 'image_to_music', label: 'Score Music from Mood', targetType: 'music' },
  ],
  music: [{ kind: 'image_to_image', label: 'Generate Cover Art', targetType: 'image' }],
  sfx: [{ kind: 'image_to_image', label: 'Generate Sound Illustration', targetType: 'image' }],
  narration: [
    { kind: 'image_to_image', label: 'Generate Chapter Illustration', targetType: 'image' },
  ],
};

export interface MediaRemixApiPayload {
  endpoint: string;
  method: 'POST';
  targetType: TreeMediaRef['type'];
  body: Record<string, unknown>;
}

function getSourceId(source: MediaRemixRequest['source']): string {
  return 'code' in source ? source.code : source.id;
}

function getSourceGenerationId(source: MediaRemixRequest['source']): string | undefined {
  return 'code' in source ? undefined : source.generationId;
}

export function buildMediaRemixApiPayload(request: MediaRemixRequest): MediaRemixApiPayload {
  const prompt = request.prompt.trim();
  const sourceId = getSourceId(request.source);
  const sourceGenId = getSourceGenerationId(request.source);

  switch (request.kind) {
    case 'image_to_image': {
      const isDirectImage = request.source.type === 'image';
      const effectivePrompt = prompt || 'Refine this visual with crisp detail and balanced composition.';
      if (isDirectImage && sourceGenId) {
        return {
          endpoint: `/api/v1/images/${encodeURIComponent(sourceId)}/generations`,
          method: 'POST',
          targetType: 'image',
          body: {
            prompt: effectivePrompt,
            action: 'refine',
            fromGenerationId: sourceGenId,
            adaptation: { enabled: true, instructions: '' },
            output: { aspectRatio: '16:9', resolution: null },
          },
        };
      }
      return {
        endpoint: isDirectImage
          ? `/api/v1/images/${encodeURIComponent(sourceId)}/generations`
          : '/api/v1/images',
        method: 'POST',
        targetType: 'image',
        body: {
          prompt: effectivePrompt,
          ...(isDirectImage
            ? { action: 'refine' }
            : {
                referenceAssetId: isDirectImage ? sourceId : null,
              }),
          adaptation: { enabled: true, instructions: '' },
          output: { aspectRatio: '16:9', resolution: null },
        },
      };
    }

    case 'image_to_video_first_frame': {
      return {
        endpoint: '/api/v1/videos',
        method: 'POST',
        targetType: 'video',
        body: {
          prompt: prompt || 'Animate this scene with subtle cinematic motion.',
          referenceAssetId: sourceGenId ?? sourceId,
          referenceRole: 'first_frame',
          adaptation: { enabled: true, instructions: '' },
          output: { aspectRatio: '16:9', resolution: '720p', durationSeconds: 8 },
        },
      };
    }

    case 'image_to_video_reference': {
      return {
        endpoint: '/api/v1/videos',
        method: 'POST',
        targetType: 'video',
        body: {
          prompt: prompt || 'Create a video inspired by this reference image.',
          referenceAssetId: sourceGenId ?? sourceId,
          referenceRole: 'reference',
          adaptation: { enabled: true, instructions: '' },
          output: { aspectRatio: '16:9', resolution: '720p', durationSeconds: 8 },
        },
      };
    }

    case 'image_to_music': {
      return {
        endpoint: '/api/v1/music',
        method: 'POST',
        targetType: 'music',
        body: {
          prompt: prompt || 'Ambient instrumental score matching the mood of this image.',
          referenceAssetId: sourceGenId ?? sourceId,
          adaptation: { enabled: true, instructions: '' },
          output: { mode: 'clip', format: 'mp3' },
          vocals: 'instrumental',
          lyrics: '',
        },
      };
    }

    case 'video_extend': {
      return {
        endpoint: `/api/v1/videos/${encodeURIComponent(sourceId)}/generations`,
        method: 'POST',
        targetType: 'video',
        body: {
          prompt: prompt || 'Continue the shot smoothly.',
          action: 'continue',
          ...(sourceGenId ? { fromGenerationId: sourceGenId } : {}),
          adaptation: { enabled: true, instructions: '' },
          output: { aspectRatio: '16:9', resolution: '720p', durationSeconds: 8 },
        },
      };
    }

    case 'video_edit': {
      return {
        endpoint: `/api/v1/videos/${encodeURIComponent(sourceId)}/generations`,
        method: 'POST',
        targetType: 'video',
        body: {
          prompt: prompt || 'Regenerate this clip with refined pacing.',
          action: 'regenerate_latest',
          ...(sourceGenId ? { fromGenerationId: sourceGenId } : {}),
          adaptation: { enabled: true, instructions: '' },
          output: { aspectRatio: '16:9', resolution: '720p', durationSeconds: 8 },
        },
      };
    }

    case 'video_to_image': {
      return {
        endpoint: '/api/v1/images',
        method: 'POST',
        targetType: 'image',
        body: {
          prompt: prompt || `Still illustration inspired by video ${sourceId}.`,
          adaptation: { enabled: true, instructions: '' },
          output: { aspectRatio: '16:9', resolution: null },
        },
      };
    }

    case 'mermaid_to_image': {
      const mermaidCode = sourceId;
      const instructions =
        prompt || 'Render this architecture diagram as a crisp editorial technical illustration.';
      const combinedPrompt = prompt ? `${prompt}\n\n${mermaidCode}` : mermaidCode;
      return {
        endpoint: '/api/v1/images',
        method: 'POST',
        targetType: 'image',
        body: {
          prompt: combinedPrompt,
          adaptation: { enabled: true, instructions },
          output: { aspectRatio: '16:9', resolution: null },
        },
      };
    }
  }
}

export function applyMediaRemixToMarkdown(
  markdown: string,
  from: TreeMediaRef,
  to: TreeMediaRef,
  placement: 'replace' | 'insert_below',
): string {
  const replacement = formatMediaMarkdownRef(to);
  if (from.type === 'mermaid') {
    const trimmedCode = from.id.trim();
    const exactFence = `\`\`\`mermaid\n${trimmedCode}\n\`\`\``;
    if (markdown.includes(exactFence)) {
      return placement === 'replace'
        ? markdown.replace(exactFence, replacement)
        : markdown.replace(exactFence, `${exactFence}\n\n${replacement}`);
    }
    const fenceRegex = /```mermaid[^\n]*\n([\s\S]*?)```/g;
    let match: RegExpExecArray | null;
    while ((match = fenceRegex.exec(markdown)) !== null) {
      if (match[1]?.trim() === trimmedCode) {
        const fullMatch = match[0];
        return placement === 'replace'
          ? markdown.slice(0, match.index) +
              replacement +
              markdown.slice(match.index + fullMatch.length)
          : markdown.slice(0, match.index) +
              `${fullMatch}\n\n${replacement}` +
              markdown.slice(match.index + fullMatch.length);
      }
    }
    return `${markdown.trimEnd()}\n\n${replacement}\n`;
  }

  const targetUri = `mdmedia://${from.type}/${from.id}`;
  const escapedUri = targetUri.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`!?\\[[^\\]]*\\]\\(${escapedUri}[^)]*\\)`);
  const match = markdown.match(regex);
  if (match && match[0]) {
    return placement === 'replace'
      ? markdown.replace(match[0], replacement)
      : markdown.replace(match[0], `${match[0]}\n\n${replacement}`);
  }
  return `${markdown.trimEnd()}\n\n${replacement}\n`;
}

function makeIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `remix_${crypto.randomUUID()}`;
  }
  return `remix_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
}

async function waitForGenerationReady(generationId: string): Promise<void> {
  const maxAttempts = 60;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const gen = await studioJson<{
      id: string;
      status: string;
      error?: { message?: string } | null;
    }>(`/api/v1/generations/${encodeURIComponent(generationId)}`);
    if (gen.status === 'ready') {
      return;
    }
    if (gen.status === 'error' || gen.status === 'interrupted') {
      throw new Error(gen.error?.message || 'Media generation did not complete.');
    }
  }
  throw new Error('Timed out waiting for media generation to complete.');
}

async function defaultGenerateMedia(
  _request: MediaRemixRequest,
  payload: MediaRemixApiPayload,
): Promise<TreeMediaRef> {
  const response = await studioJson<{
    id?: string;
    itemId?: string;
    latestGenerationId?: string;
    generation?: {
      id?: string;
      status?: string;
      error?: { message?: string } | null;
    };
  }>(payload.endpoint, {
    method: payload.method,
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': makeIdempotencyKey(),
    },
    body: JSON.stringify(payload.body),
  });

  const itemId = response.itemId ?? response.id ?? 'generated';
  const generationId =
    response.generation?.id ??
    (response.itemId ? response.id : response.latestGenerationId);

  if (
    generationId &&
    (response.generation?.status === 'queued' ||
      response.generation?.status === 'generating')
  ) {
    await waitForGenerationReady(generationId);
  }

  return generationId
    ? { type: payload.targetType, id: itemId, generationId }
    : { type: payload.targetType, id: itemId };
}

export interface ExecuteMediaRemixDeps {
  nodeId: TreeNodeId;
  markdown?: string;
  generateMedia?: (
    req: MediaRemixRequest,
    payload: MediaRemixApiPayload,
  ) => Promise<TreeMediaRef>;
  applyReplaceOp?: (
    op: Extract<TreeOp, { op: 'replace_media_ref' }>,
  ) => Promise<void>;
}

export async function executeMediaRemix(
  request: MediaRemixRequest,
  deps: ExecuteMediaRemixDeps,
): Promise<MediaRemixResult> {
  const payload = buildMediaRemixApiPayload(request);
  const fromRef: TreeMediaRef =
    'code' in request.source
      ? { type: 'mermaid', id: request.source.code }
      : request.source;

  const generate = deps.generateMedia ?? defaultGenerateMedia;
  const createdRef = await generate(request, payload);

  if (request.placement === 'library_only') {
    return { createdRef };
  }

  const replaceOp: Extract<TreeOp, { op: 'replace_media_ref' }> = {
    op: 'replace_media_ref',
    nodeId: deps.nodeId,
    from: fromRef,
    to: createdRef,
    placement: request.placement,
  };

  if (deps.applyReplaceOp) {
    await deps.applyReplaceOp(replaceOp);
  }

  const updatedMarkdown =
    deps.markdown !== undefined
      ? applyMediaRemixToMarkdown(
          deps.markdown,
          fromRef,
          createdRef,
          request.placement,
        )
      : undefined;

  return {
    createdRef,
    ...(updatedMarkdown !== undefined ? { updatedMarkdown } : {}),
  };
}
