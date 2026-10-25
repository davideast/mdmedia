import { authorize, readJsonObject } from "@/lib/api-auth";
import { apiOrigin } from "@/lib/api-origin";
import { deleteProduction, getProduction, noStore, productionApi, updateProduction } from "@/lib/productions-server";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

/** The production with its cut summaries, in order. */
export const GET = (request: Request, { params }: Context) => productionApi(async () => {
  const caller = await authorize(request, "productions:read");
  if (caller instanceof Response) return caller;
  return Response.json(await getProduction(caller.uid, (await params).id, apiOrigin(request)), { headers: noStore });
});

/** `{ title?, coverAssetId?, approvedCutId?, currentCutId?, cuts?: [{ id, status?, label?, notes? }] }` */
export const PATCH = (request: Request, { params }: Context) => productionApi(async () => {
  const caller = await authorize(request, "productions:write");
  if (caller instanceof Response) return caller;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  return Response.json(await updateProduction(caller.uid, (await params).id, body, apiOrigin(request)), { headers: noStore });
});

/** Deletes the production and its cuts, never its media assets. */
export const DELETE = (request: Request, { params }: Context) => productionApi(async () => {
  const caller = await authorize(request, "productions:write");
  if (caller instanceof Response) return caller;
  await deleteProduction(caller.uid, (await params).id);
  return new Response(null, { status: 204 });
});
