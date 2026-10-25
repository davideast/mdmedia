import { apiError, readJsonObject } from '../../../../../../lib/api-auth';
import type { TreeOp } from '../../../../../../lib/tree-types';
import {
  decodeParam,
  getTreeStore,
  readIdempotencyKeyHeader,
  requireTreeAuth,
  treeErrorResponse,
} from '../../route';

export const runtime = 'nodejs';

type Context = { params: Promise<{ id: string }> };

/**
 * POST /api/v1/trees/[id]/ops — accepts `{ ops: TreeOp[], expectedRevision?: number }`
 * and optional `Idempotency-Key` header; returns `{ tree: TreeDetail }`.
 */
export async function POST(request: Request, { params }: Context): Promise<Response> {
  const caller = await requireTreeAuth(request);
  if (caller instanceof Response) return caller;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;

  if (!Array.isArray(body.ops)) {
    return apiError(400, 'invalid_ops', 'ops must be an array of tree operations.');
  }

  let expectedRevision: number | undefined;
  if (body.expectedRevision !== undefined) {
    if (typeof body.expectedRevision !== 'number' || !Number.isInteger(body.expectedRevision)) {
      return apiError(400, 'invalid_revision', 'expectedRevision must be an integer.');
    }
    expectedRevision = body.expectedRevision;
  }

  const idempotencyKey =
    readIdempotencyKeyHeader(request) ??
    (typeof body.idempotencyKey === 'string' && body.idempotencyKey.trim()
      ? body.idempotencyKey.trim()
      : undefined);

  try {
    const store = await getTreeStore();
    const id = decodeParam((await params).id);
    const tree = await store.applyOps(caller.uid, id, body.ops as TreeOp[], {
      ...(expectedRevision !== undefined ? { expectedRevision } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
    return Response.json({ tree });
  } catch (error) {
    return treeErrorResponse(error);
  }
}
