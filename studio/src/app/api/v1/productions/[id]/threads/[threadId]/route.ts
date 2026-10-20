import { authorize, readJsonObject } from "@/lib/api-auth";
import { apiOrigin } from "@/lib/api-origin";
import { commentsApi, getThread, setThreadStatus } from "@/lib/comments-server";
import { noStore } from "@/lib/productions-server";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string; threadId: string }> };

/** The thread with all its messages and options. */
export const GET = (request: Request, { params }: Context) => commentsApi(async () => {
  const caller = await authorize(request, "comments:read");
  if (caller instanceof Response) return caller;
  const { id, threadId } = await params;
  return Response.json(await getThread(caller.uid, id, threadId, apiOrigin(request)), { headers: noStore });
});

/** `{ status }`: open, in-progress, addressed or resolved. */
export const PATCH = (request: Request, { params }: Context) => commentsApi(async () => {
  const caller = await authorize(request, "comments:write");
  if (caller instanceof Response) return caller;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  const { id, threadId } = await params;
  return Response.json(await setThreadStatus(caller.uid, id, threadId, body, apiOrigin(request)), { headers: noStore });
});
