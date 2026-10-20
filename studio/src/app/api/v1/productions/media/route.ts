import { apiError, authorize } from "@/lib/api-auth";
import { apiOrigin } from "@/lib/api-origin";
import { findProductionMedia, isSha256, MAX_LOOKUP_HASHES, productionAssetResource } from "@/lib/production-media-server";
import { noStore, productionApi } from "@/lib/productions-server";

export const runtime = "nodejs";

/** `?sha256=<hex>,<hex>,…`: which of these files you have already uploaded, as `{ found: { [sha256]: asset } }`. */
export const GET = (request: Request) => productionApi(async () => {
  const caller = await authorize(request, "productions:read");
  if (caller instanceof Response) return caller;
  const hashes = (new URL(request.url).searchParams.get("sha256") ?? "").split(",").filter(Boolean);
  if (hashes.length === 0 || hashes.length > MAX_LOOKUP_HASHES || !hashes.every(isSha256)) {
    return apiError(400, "invalid_hash", `Pass 1 to ${MAX_LOOKUP_HASHES} comma-separated SHA-256 hashes as ?sha256=.`);
  }
  const origin = apiOrigin(request);
  const found = await findProductionMedia(caller.uid, hashes);
  return Response.json({ found: Object.fromEntries([...found].map(([sha, asset]) => [sha, productionAssetResource(asset, origin)])) }, { headers: noStore });
});
