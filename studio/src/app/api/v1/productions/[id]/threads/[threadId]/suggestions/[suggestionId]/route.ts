import { authorize, readJsonObject } from "@/lib/api-auth";
import { apiOrigin } from "@/lib/api-origin";
import { commentsApi, setSuggestionState } from "@/lib/comments-server";
import { noStore } from "@/lib/productions-server";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string; threadId: string; suggestionId: string }> };

/** `{ state, appliedAs? }`: proposed, accepted, rejected, or applied as one of the production's cuts. */
export const PATCH = (request: Request, { params }: Context) => commentsApi(async () => {
  const caller = await authorize(request, "comments:write");
  if (caller instanceof Response) return caller;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  const { id, threadId, suggestionId } = await params;
  return Response.json(await setSuggestionState(caller, id, threadId, suggestionId, body, apiOrigin(request)), { headers: noStore });
});
