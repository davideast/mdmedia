import { authorize, readJsonObject } from "@/lib/api-auth";
import { apiOrigin } from "@/lib/api-origin";
import { claimThread, commentsApi, releaseThread } from "@/lib/comments-server";
import { noStore } from "@/lib/productions-server";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string; threadId: string }> };

/** `{ agent, minutes? }`: an agent takes the thread (in progress) for a while; again to renew. Another agent's live claim is 409. */
export const POST = (request: Request, { params }: Context) => commentsApi(async () => {
  const caller = await authorize(request, "comments:write");
  if (caller instanceof Response) return caller;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  const { id, threadId } = await params;
  return Response.json(await claimThread(caller, id, threadId, body, apiOrigin(request)), { headers: noStore });
});

/** Ends the claim; a thread still in progress goes back to open. */
export const DELETE = (request: Request, { params }: Context) => commentsApi(async () => {
  const caller = await authorize(request, "comments:write");
  if (caller instanceof Response) return caller;
  const { id, threadId } = await params;
  return Response.json(await releaseThread(caller.uid, id, threadId, apiOrigin(request)), { headers: noStore });
});
