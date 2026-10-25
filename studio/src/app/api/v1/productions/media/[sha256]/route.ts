import { authorize } from "@/lib/api-auth";
import { apiOrigin } from "@/lib/api-origin";
import { parseProductionUpload, productionAssetResource, saveProductionMedia } from "@/lib/production-media-server";
import { noStore, productionApi } from "@/lib/productions-server";

export const runtime = "nodejs";

type Context = { params: Promise<{ sha256: string }> };

/**
 * Uploads one production file as raw bytes, named by its SHA-256:
 * `?mediaType=video|image|voice|music|sfx[&durationMs=&width=&height=]`, with
 * its Content-Type. The bytes stream to Storage, bounded, and must hash to
 * the path. 201 when stored; 200, without reading the body, when you already
 * have it.
 */
export const PUT = (request: Request, { params }: Context) => productionApi(async () => {
  const caller = await authorize(request, "productions:write");
  if (caller instanceof Response) return caller;
  const upload = parseProductionUpload((await params).sha256, new URL(request.url), request.headers);
  const { asset, created } = await saveProductionMedia(caller.uid, upload, request.body);
  return Response.json(productionAssetResource(asset, apiOrigin(request)), { status: created ? 201 : 200, headers: noStore });
});
