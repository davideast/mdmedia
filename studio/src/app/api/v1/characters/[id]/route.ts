import { authorize } from "@/lib/api-auth";
import { apiOrigin } from "@/lib/api-origin";
import { characterApi, getCharacter } from "@/lib/characters-server";
import { noStore } from "@/lib/productions-server";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

/** The character (by id, or by its slug), its versions, and its latest version whole. */
export const GET = (request: Request, { params }: Context) => characterApi(async () => {
  const caller = await authorize(request, "productions:read");
  if (caller instanceof Response) return caller;
  return Response.json(await getCharacter(caller.uid, (await params).id, apiOrigin(request)), { headers: noStore });
});
