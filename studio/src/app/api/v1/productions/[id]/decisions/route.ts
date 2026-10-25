import { authorize, readJsonObject } from "@/lib/api-auth";
import { apiOrigin } from "@/lib/api-origin";
import { addDecision, commentsApi, listDecisions } from "@/lib/comments-server";
import { noStore } from "@/lib/productions-server";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

/** The production's decision log: `{ decisions, constraints }`, in order. */
export const GET = (request: Request, { params }: Context) => commentsApi(async () => {
  const caller = await authorize(request, "comments:read");
  if (caller instanceof Response) return caller;
  return Response.json(await listDecisions(caller.uid, (await params).id, apiOrigin(request)), { headers: noStore });
});

/** `{ text, kind?, take?, source?, quote?, revised?, threadIds?, cutIds?, id? }`: adds a decision or constraint at the end of the log. */
export const POST = (request: Request, { params }: Context) => commentsApi(async () => {
  const caller = await authorize(request, "comments:write");
  if (caller instanceof Response) return caller;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  return Response.json(await addDecision(caller.uid, (await params).id, body, apiOrigin(request)), { status: 201, headers: noStore });
});
