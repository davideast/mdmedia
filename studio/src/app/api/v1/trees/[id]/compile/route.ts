import { apiError, readJsonObject } from '../../../../../../lib/api-auth';
import type { TreeCompileRequest } from '../../../../../../lib/tree-types';
import type { VoiceName } from '../../../../../../lib/types';
import { decodeParam, getTreeStore, requireTreeAuth, treeErrorResponse } from '../../route';

export const runtime = 'nodejs';

type Context = { params: Promise<{ id: string }> };

/**
 * POST /api/v1/trees/[id]/compile — accepts `TreeCompileRequest`; returns `{ result: TreeCompileResult }`.
 */
export async function POST(request: Request, { params }: Context): Promise<Response> {
  const caller = await requireTreeAuth(request);
  if (caller instanceof Response) return caller;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;

  if (body.targets !== undefined && (!Array.isArray(body.targets) || !body.targets.every((t) => typeof t === 'string'))) {
    return apiError(400, 'invalid_targets', 'targets must be an array of strings.');
  }
  if (body.preset !== undefined && typeof body.preset !== 'string') {
    return apiError(400, 'invalid_preset', 'preset must be a string.');
  }
  if (body.mode !== undefined && body.mode !== 'concat' && body.mode !== 'synthesize') {
    return apiError(400, 'invalid_mode', 'mode must be "concat" or "synthesize".');
  }
  if (body.title !== undefined && typeof body.title !== 'string') {
    return apiError(400, 'invalid_title', 'title must be a string.');
  }
  if (body.instructions !== undefined && typeof body.instructions !== 'string') {
    return apiError(400, 'invalid_instructions', 'instructions must be a string.');
  }
  if (body.saveAsPath !== undefined && typeof body.saveAsPath !== 'string') {
    return apiError(400, 'invalid_save_as_path', 'saveAsPath must be a string.');
  }
  if (body.narrate !== undefined && typeof body.narrate !== 'boolean') {
    return apiError(400, 'invalid_narrate', 'narrate must be a boolean.');
  }
  if (body.voice !== undefined && typeof body.voice !== 'string') {
    return apiError(400, 'invalid_voice', 'voice must be a string.');
  }

  const compileRequest: TreeCompileRequest = {
    ...(Array.isArray(body.targets) ? { targets: body.targets as string[] } : {}),
    ...(typeof body.preset === 'string' ? { preset: body.preset } : {}),
    ...(body.mode === 'concat' || body.mode === 'synthesize' ? { mode: body.mode } : {}),
    ...(typeof body.title === 'string' ? { title: body.title } : {}),
    ...(typeof body.instructions === 'string' ? { instructions: body.instructions } : {}),
    ...(typeof body.saveAsPath === 'string' ? { saveAsPath: body.saveAsPath } : {}),
    ...(typeof body.narrate === 'boolean' ? { narrate: body.narrate } : {}),
    ...(typeof body.voice === 'string' ? { voice: body.voice as VoiceName } : {}),
    ...(body.voiceProvider === 'gemini' || body.voiceProvider === 'elevenlabs'
      ? { voiceProvider: body.voiceProvider }
      : {}),
    ...(typeof body.voiceId === 'string' ? { voiceId: body.voiceId } : {}),
    ...(typeof body.promptStyle === 'string' ? { promptStyle: body.promptStyle } : {}),
  };

  try {
    const store = await getTreeStore();
    const id = decodeParam((await params).id);
    const result = await store.compileSelection(caller.uid, id, compileRequest);
    return Response.json({ result });
  } catch (error) {
    return treeErrorResponse(error);
  }
}
