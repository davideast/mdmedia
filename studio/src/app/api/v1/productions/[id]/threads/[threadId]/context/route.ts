import { authorize } from "@/lib/api-auth";
import { apiOrigin } from "@/lib/api-origin";
import { threadContext } from "@/lib/comments-context";
import { commentsApi } from "@/lib/comments-server";
import { noStore } from "@/lib/productions-server";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string; threadId: string }> };

/** Everything an agent needs to act on the thread, in one answer (`mdmedia.thread-context@2`). */
export const GET = (request: Request, { params }: Context) => commentsApi(async () => {
  const caller = await authorize(request, "comments:read");
  if (caller instanceof Response) return caller;
  const { id, threadId } = await params;
  return Response.json(await threadContext(caller.uid, id, threadId, apiOrigin(request)), { headers: noStore });
});
