import { authorize, readJsonObject } from "@/lib/api-auth";
import { apiOrigin } from "@/lib/api-origin";
import { listProductions, noStore, productionApi, upsertProduction } from "@/lib/productions-server";

export const runtime = "nodejs";

/** Your productions, most recently changed first, each with its cuts; and your series, with the productions in each. */
export const GET = (request: Request) => productionApi(async () => {
  const caller = await authorize(request, "productions:read");
  if (caller instanceof Response) return caller;
  return Response.json(await listProductions(caller.uid, apiOrigin(request)), { headers: noStore });
});

/** `{ slug, title, series?: { title, slug? } | null, coverAssetId? }`: creates the production with this slug, or updates it. */
export const POST = (request: Request) => productionApi(async () => {
  const caller = await authorize(request, "productions:write");
  if (caller instanceof Response) return caller;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  const { production, created } = await upsertProduction(caller.uid, body, apiOrigin(request));
  return Response.json(production, { status: created ? 201 : 200, headers: noStore });
});
