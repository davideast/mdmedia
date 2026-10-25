import { authorize } from "@/lib/api-auth";
import { apiOrigin } from "@/lib/api-origin";
import { characterApi, listCharacters } from "@/lib/characters-server";
import { noStore } from "@/lib/productions-server";

export const runtime = "nodejs";

/** Your characters, by name, each with its versions. Characters share the productions scopes. */
export const GET = (request: Request) => characterApi(async () => {
  const caller = await authorize(request, "productions:read");
  if (caller instanceof Response) return caller;
  return Response.json(await listCharacters(caller.uid, apiOrigin(request)), { headers: noStore });
});
