import {
  apiError,
  authenticate,
  forbiddenScope,
  hasScope,
  readJsonObject,
  unauthorized,
  type Caller,
} from '../../../../lib/api-auth';
import type { ApiKeyScope } from '../../../../lib/api-key-token';
import { getServerTreeStore } from '../../../../lib/trees-server';
import { TreeOpError, type TreeOp, type TreeStorePort } from '../../../../lib/tree-types';

export const runtime = 'nodejs';

let testingStore: TreeStorePort | null = null;
let testingUid: string | null = null;

export function setTreeStoreForTesting(store: TreeStorePort | null, uid?: string): void {
  testingStore = store;
  testingUid = uid ?? null;
}

export async function getTreeStore(): Promise<TreeStorePort> {
  return testingStore ?? getServerTreeStore();
}

export async function requireTreeAuth(
  request: Request,
  options: { allowReadScope?: boolean } = {},
): Promise<Caller | Response> {
  if (testingStore) {
    const header = request.headers.get('authorization');
    const [scheme, rawToken] = header ? header.split(' ') : [];
    const token = rawToken?.trim() ?? '';
    if (scheme?.toLowerCase() !== 'bearer' || !token || token === 'invalid' || token === 'revoked') {
      return unauthorized();
    }
    const uid =
      request.headers.get('x-test-uid')?.trim() ||
      testingUid ||
      (testingStore as unknown as { defaultUid?: string }).defaultUid ||
      'user_test';
    const scopesHeader = request.headers.get('x-test-scopes');
    if (scopesHeader !== null) {
      const scopes = scopesHeader
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean) as ApiKeyScope[];
      const caller: Caller = { kind: 'apiKey', uid, keyId: 'test_key', scopes };
      const allowed =
        hasScope(caller, 'trees:manage') ||
        (Boolean(options.allowReadScope) && hasScope(caller, 'narrations:read'));
      if (!allowed) return forbiddenScope('trees:manage');
      return caller;
    }
    return { kind: 'user', uid, email: `${uid}@example.com` };
  }

  const caller = await authenticate(request);
  if (!caller) return unauthorized();
  const allowed =
    hasScope(caller, 'trees:manage') ||
    (Boolean(options.allowReadScope) && hasScope(caller, 'narrations:read'));
  if (!allowed) return forbiddenScope('trees:manage');
  return caller;
}

export function decodeParam(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function readIdempotencyKeyHeader(request: Request): string | undefined {
  const raw = request.headers.get('idempotency-key')?.trim();
  return raw ? raw : undefined;
}

export function treeErrorResponse(error: unknown): Response {
  if (
    error instanceof TreeOpError ||
    (error instanceof Error && error.name === 'TreeOpError' && 'code' in error && 'status' in error)
  ) {
    const treeErr = error as TreeOpError;
    return Response.json(
      {
        error: {
          code: treeErr.code,
          message: treeErr.message,
          ...(treeErr.details !== undefined ? { details: treeErr.details } : {}),
        },
      },
      { status: treeErr.status },
    );
  }
  throw error;
}

/** GET /api/v1/trees — returns `{ trees: TreeSummary[] }`. */
export async function GET(request: Request): Promise<Response> {
  const caller = await requireTreeAuth(request, { allowReadScope: true });
  if (caller instanceof Response) return caller;
  try {
    const store = await getTreeStore();
    const trees = await store.listTrees(caller.uid);
    return Response.json({ trees }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return treeErrorResponse(error);
  }
}

/** POST /api/v1/trees — accepts `{ title, description?, ops? }` and optional `Idempotency-Key` header; returns `{ tree: TreeDetail }` (201). */
export async function POST(request: Request): Promise<Response> {
  const caller = await requireTreeAuth(request);
  if (caller instanceof Response) return caller;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;

  if (typeof body.title !== 'string') {
    return apiError(400, 'invalid_title', 'title must be non-empty text.');
  }
  if (body.description !== undefined && typeof body.description !== 'string') {
    return apiError(400, 'invalid_description', 'description must be a string.');
  }
  if (body.ops !== undefined && !Array.isArray(body.ops)) {
    return apiError(400, 'invalid_ops', 'ops must be an array of tree operations.');
  }

  const idempotencyKey = readIdempotencyKeyHeader(request);
  try {
    const store = await getTreeStore();
    const tree = await store.createTree(caller.uid, {
      title: body.title,
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(Array.isArray(body.ops) ? { ops: body.ops as TreeOp[] } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
    return Response.json({ tree }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return treeErrorResponse(error);
  }
}
