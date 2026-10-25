import { authorize, readJsonObject } from "@/lib/api-auth";
import { apiOrigin } from "@/lib/api-origin";
import { commentsApi, postMessage } from "@/lib/comments-server";
import { noStore } from "@/lib/productions-server";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string; threadId: string }> };

/** `{ text, replyTo?, at?: { video, time }, version?: { cutId }, agent?, keepClaim? }`: a reply. A time on a cut is anchored there. */
export const POST = (request: Request, { params }: Context) => commentsApi(async () => {
  const caller = await authorize(request, "comments:write");
  if (caller instanceof Response) return caller;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  const { id, threadId } = await params;
  return Response.json(await postMessage(caller, id, threadId, body, apiOrigin(request)), { status: 201, headers: noStore });
});
