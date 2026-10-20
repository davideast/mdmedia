import { authorize, readJsonObject } from "@/lib/api-auth";
import { apiOrigin } from "@/lib/api-origin";
import { commentsApi, createThread, listThreads } from "@/lib/comments-server";
import { noStore } from "@/lib/productions-server";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

/** `?cutId=&needsAgent=1`: the production's threads (or one cut's), in timeline order, each with its status line. */
export const GET = (request: Request, { params }: Context) => commentsApi(async () => {
  const caller = await authorize(request, "comments:read");
  if (caller instanceof Response) return caller;
  const query = new URL(request.url).searchParams;
  const threads = await listThreads(caller.uid, (await params).id, apiOrigin(request), { cutId: query.get("cutId"), needsAgent: query.get("needsAgent") === "1" });
  return Response.json({ threads }, { headers: noStore });
});

/** `{ cutId, time, text, range?, view?, frameAssetId?, agent? }`: a new comment, anchored on the cut as it resolves now. */
export const POST = (request: Request, { params }: Context) => commentsApi(async () => {
  const caller = await authorize(request, "comments:write");
  if (caller instanceof Response) return caller;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  return Response.json(await createThread(caller, (await params).id, body, apiOrigin(request)), { status: 201, headers: noStore });
});
