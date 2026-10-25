import { apiError, readJsonObject } from '../../../../../../../lib/api-auth';
import type { VoiceName } from '../../../../../../../lib/types';
import { decodeParam, getTreeStore, requireTreeAuth, treeErrorResponse } from '../../../route';

export const runtime = 'nodejs';

type Context = {
  params: Promise<{ id: string; nodeId: string }> | { id: string; nodeId: string };
};

/**
 * GET /api/v1/trees/[id]/nodes/[nodeId] — returns `{ document: TreeDocument }`.
 * Decodes `decodeURIComponent(nodeId)` so virtual paths or node IDs work.
 */
export async function GET(request: Request, { params }: Context): Promise<Response> {
  const caller = await requireTreeAuth(request, { allowReadScope: true });
  if (caller instanceof Response) return caller;
  try {
    const store = await getTreeStore();
    const resolvedParams = await params;
    const treeId = decodeParam(resolvedParams.id);
    const nodeIdOrPath = decodeParam(resolvedParams.nodeId);
    const document = await store.getDocument(caller.uid, treeId, nodeIdOrPath);
    return Response.json({ document }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return treeErrorResponse(error);
  }
}

/**
 * PUT /api/v1/trees/[id]/nodes/[nodeId] — updates a document's Markdown/title and/or starts narration.
 */
export async function PUT(request: Request, { params }: Context): Promise<Response> {
  const caller = await requireTreeAuth(request);
  if (caller instanceof Response) return caller;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;

  if (body.markdown !== undefined && typeof body.markdown !== 'string') {
    return apiError(400, 'invalid_markdown', 'markdown must be a string.');
  }
  if (body.title !== undefined && typeof body.title !== 'string') {
    return apiError(400, 'invalid_title', 'title must be a string.');
  }
  if (body.voice !== undefined && typeof body.voice !== 'string') {
    return apiError(400, 'invalid_voice', 'voice must be a string.');
  }

  try {
    const store = await getTreeStore();
    const resolvedParams = await params;
    const treeId = decodeParam(resolvedParams.id);
    const nodeIdOrPath = decodeParam(resolvedParams.nodeId);
    let doc = await store.getDocument(caller.uid, treeId, nodeIdOrPath);

    if (typeof body.markdown === 'string') {
      await store.applyOps(caller.uid, doc.treeId, [
        {
          op: 'put_doc',
          path: doc.path,
          nodeId: doc.nodeId,
          markdown: body.markdown,
          ...(typeof body.title === 'string' ? { title: body.title } : {}),
        },
      ]);
      doc = await store.getDocument(caller.uid, doc.treeId, doc.nodeId);
    }

    let narrationId: string | undefined;
    if (body.narrate === true) {
      const storeWithNarration = store as unknown as {
        startNodeNarration?: (
          ...args: unknown[]
        ) => Promise<{ narrationId: string }>;
      };
      if (typeof storeWithNarration.startNodeNarration === 'function') {
        const voiceOpt = {
          ...(typeof body.voice === 'string' ? { voice: body.voice as VoiceName } : {}),
          ...(body.voiceProvider === 'gemini' || body.voiceProvider === 'elevenlabs'
            ? { voiceProvider: body.voiceProvider as 'gemini' | 'elevenlabs' }
            : {}),
          ...(typeof body.voiceId === 'string' ? { voiceId: body.voiceId } : {}),
          ...(typeof body.promptStyle === 'string' ? { promptStyle: body.promptStyle } : {}),
        };
        const hasVoiceOpts = Object.keys(voiceOpt).length > 0;
        const resolvedOpt = hasVoiceOpts ? voiceOpt : undefined;
        // Support both FirestoreTreeStore.startNodeNarration(uid, treeId, nodeId, options)
        // and InMemoryTreeStore.startNodeNarration(treeId, nodeId, options)
        const arity = storeWithNarration.startNodeNarration.length;
        const started =
          arity >= 4
            ? await storeWithNarration.startNodeNarration(caller.uid, doc.treeId, doc.nodeId, resolvedOpt)
            : await storeWithNarration.startNodeNarration(doc.treeId, doc.nodeId, resolvedOpt);
        narrationId = started.narrationId;
        doc = await store.getDocument(caller.uid, doc.treeId, doc.nodeId);
      }
    }

    return Response.json({
      document: doc,
      ...(narrationId ? { narrationId } : {}),
    });
  } catch (error) {
    return treeErrorResponse(error);
  }
}

