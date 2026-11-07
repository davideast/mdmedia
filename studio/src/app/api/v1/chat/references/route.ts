import { apiError, authorize } from '@/lib/api-auth';
import { apiOrigin } from '@/lib/api-origin';
import {
  CHAT_REFERENCE_CATEGORIES,
  isChatReferenceKind,
} from '@/lib/chat/references';
import { searchChatReferences } from '@/lib/chat/references-server';
import type {
  ChatReferenceCategory,
  ChatReferenceKind,
} from '@/lib/chat/types';

export const runtime = 'nodejs';

const VALID_CATEGORIES = new Set<string>(
  CHAT_REFERENCE_CATEGORIES.map((c) => c.id),
);

/**
 * GET /api/v1/chat/references?q=<query>&category=<category>&kind=<kind>&activeRoute=<route>&limit=<n>
 *
 * Returns ranked `ChatEntityReference[]` across all mdmedia Studio stores the
 * authenticated caller is scoped to read.
 */
export async function GET(request: Request): Promise<Response> {
  const caller = await authorize(request, 'chat:use');
  if (caller instanceof Response) return caller;

  const url = new URL(request.url);
  const q = url.searchParams.get('q')?.trim() ?? '';
  if (q.length > 200) {
    return apiError(400, 'invalid_query', 'Reference search query is limited to 200 characters.');
  }

  const rawCategory = url.searchParams.get('category')?.trim() ?? 'all';
  if (!VALID_CATEGORIES.has(rawCategory)) {
    return apiError(400, 'invalid_category', `Unknown reference category "${rawCategory}".`);
  }
  const category = rawCategory as ChatReferenceCategory;

  const rawKind = url.searchParams.get('kind')?.trim() ?? '';
  let kind: ChatReferenceKind | null = null;
  if (rawKind) {
    if (!isChatReferenceKind(rawKind)) {
      return apiError(400, 'invalid_kind', `Unknown reference kind "${rawKind}".`);
    }
    kind = rawKind;
  }

  const rawLimit = url.searchParams.get('limit');
  let limit = 30;
  if (rawLimit !== null) {
    const parsedLimit = Number(rawLimit);
    if (!Number.isFinite(parsedLimit) || parsedLimit < 1 || parsedLimit > 60) {
      return apiError(400, 'invalid_limit', '`limit` must be between 1 and 60.');
    }
    limit = Math.floor(parsedLimit);
  }

  const activeRoute = url.searchParams.get('activeRoute')?.trim() || null;

  const result = await searchChatReferences(caller, {
    origin: apiOrigin(request),
    query: q,
    category,
    kind,
    activeRoute,
    limit,
  });

  return Response.json(result, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
