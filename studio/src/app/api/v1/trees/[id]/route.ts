import { apiError, readJsonObject } from '../../../../../lib/api-auth';
import { decodeParam, getTreeStore, requireTreeAuth, treeErrorResponse } from '../route';

export const runtime = 'nodejs';

type Context = { params: Promise<{ id: string }> | { id: string } };

/** GET /api/v1/trees/[id] — returns `{ tree: TreeDetail }`. */
export async function GET(request: Request, { params }: Context): Promise<Response> {
  const caller = await requireTreeAuth(request, { allowReadScope: true });
  if (caller instanceof Response) return caller;
  try {
    const store = await getTreeStore();
    const id = decodeParam((await params).id);
    const tree = await store.getTree(caller.uid, id);
    return Response.json({ tree }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return treeErrorResponse(error);
  }
}

/** PATCH /api/v1/trees/[id] — accepts `{ title?, description? }`; returns `{ tree: TreeDetail }`. */
export async function PATCH(request: Request, { params }: Context): Promise<Response> {
  const caller = await requireTreeAuth(request);
  if (caller instanceof Response) return caller;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;

  if (body.title !== undefined && typeof body.title !== 'string') {
    return apiError(400, 'invalid_title', 'title must be a string.');
  }
  if (body.description !== undefined && typeof body.description !== 'string') {
    return apiError(400, 'invalid_description', 'description must be a string.');
  }

  try {
    const store = await getTreeStore();
    const id = decodeParam((await params).id);
    const tree = await store.updateTreeMeta(caller.uid, id, {
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
    });
    return Response.json({ tree });
  } catch (error) {
    return treeErrorResponse(error);
  }
}

/** DELETE /api/v1/trees/[id] — deletes tree and returns `{ deleted: true, id }`. */
export async function DELETE(request: Request, { params }: Context): Promise<Response> {
  const caller = await requireTreeAuth(request);
  if (caller instanceof Response) return caller;
  try {
    const store = await getTreeStore();
    const idOrTitle = decodeParam((await params).id);
    const existing = await store.getTree(caller.uid, idOrTitle);
    await store.deleteTree(caller.uid, existing.id);
    return Response.json({ deleted: true, id: existing.id });
  } catch (error) {
    return treeErrorResponse(error);
  }
}
