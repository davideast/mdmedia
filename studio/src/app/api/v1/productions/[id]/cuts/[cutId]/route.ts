import { authorize, readJsonObject } from "@/lib/api-auth";
import { apiOrigin } from "@/lib/api-origin";
import { deleteProductionCut, getProductionCut, noStore, productionApi, putProductionCut } from "@/lib/productions-server";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string; cutId: string }> };

/** The whole cut: its stored cut file and words, the resolved timeline with words applied, and the assets it names. */
export const GET = (request: Request, { params }: Context) => productionApi(async () => {
  const caller = await authorize(request, "productions:read");
  if (caller instanceof Response) return caller;
  const { id, cutId } = await params;
  return Response.json(await getProductionCut(caller.uid, id, cutId, apiOrigin(request)), { headers: noStore });
});

/** Replaces the cut, or adds it: `{ label, status, kind, notes?, order, createdAt?, cut?, words?, renderedAssetId?, thumbs?, source? }`. */
export const PUT = (request: Request, { params }: Context) => productionApi(async () => {
  const caller = await authorize(request, "productions:write");
  if (caller instanceof Response) return caller;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  const { id, cutId } = await params;
  const { cut, created } = await putProductionCut(caller.uid, id, cutId, body, apiOrigin(request));
  return Response.json(cut, { status: created ? 201 : 200, headers: noStore });
});

/** Removes one cut. Its media assets are kept. */
export const DELETE = (request: Request, { params }: Context) => productionApi(async () => {
  const caller = await authorize(request, "productions:write");
  if (caller instanceof Response) return caller;
  const { id, cutId } = await params;
  await deleteProductionCut(caller.uid, id, cutId);
  return new Response(null, { status: 204 });
});
