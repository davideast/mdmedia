import { authorize, readJsonObject } from "@/lib/api-auth";
import { apiOrigin } from "@/lib/api-origin";
import { characterApi, getCharacterVersion, putCharacterVersion } from "@/lib/characters-server";
import { noStore } from "@/lib/productions-server";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string; version: string }> };

const versionOf = (text: string) => (/^[1-9][0-9]{0,5}$/.test(text) ? Number(text) : NaN);

/** One version of a character, whole, with links to its stills. */
export const GET = (request: Request, { params }: Context) => characterApi(async () => {
  const caller = await authorize(request, "productions:read");
  if (caller instanceof Response) return caller;
  const { id, version } = await params;
  return Response.json(await getCharacterVersion(caller.uid, id, versionOf(version), apiOrigin(request)), { headers: noStore });
});

/**
 * `{ character, stills: { [stillId]: assetId } }`: stores this version of the
 * character whose slug is `{id}`. `201` when new, `200` when the same version
 * is already stored with the same content, `409 version_exists` when with other.
 */
export const PUT = (request: Request, { params }: Context) => characterApi(async () => {
  const caller = await authorize(request, "productions:write");
  if (caller instanceof Response) return caller;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  const { id, version } = await params;
  const result = await putCharacterVersion(caller.uid, id, versionOf(version), body, apiOrigin(request));
  return Response.json(result.version, { status: result.created ? 201 : 200, headers: noStore });
});
