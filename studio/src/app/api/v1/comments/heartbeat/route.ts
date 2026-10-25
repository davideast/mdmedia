import { authorize, readJsonObject } from "@/lib/api-auth";
import { apiOrigin } from "@/lib/api-origin";
import { commentsApi, heartbeat } from "@/lib/comments-server";
import { noStore } from "@/lib/productions-server";

export const runtime = "nodejs";

/** `{ agent, productionId? }`: an agent says it is watching for comments. Studio shows comments as waiting when none has for 3 minutes. */
export const POST = (request: Request) => commentsApi(async () => {
  const caller = await authorize(request, "comments:write");
  if (caller instanceof Response) return caller;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  return Response.json(await heartbeat(caller.uid, body, apiOrigin(request)), { headers: noStore });
});
