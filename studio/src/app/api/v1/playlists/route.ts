import { authorize, readJsonObject } from "@/lib/api-auth";
import { createPlaylist, listPlaylists, playlistErrorResponse } from "@/lib/playlists-server";

export const runtime = "nodejs";

/** Your playlists, most recently changed first, with length and readiness. */
export async function GET(request: Request): Promise<Response> {
  const caller = await authorize(request, "playlists:manage");
  if (caller instanceof Response) return caller;
  return Response.json({ playlists: await listPlaylists(caller.uid) }, { headers: { "Cache-Control": "no-store" } });
}

/** `{ title, description?, narrationIds? }` */
export async function POST(request: Request): Promise<Response> {
  const caller = await authorize(request, "playlists:manage");
  if (caller instanceof Response) return caller;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  try {
    return Response.json(await createPlaylist(caller.uid, body), { status: 201 });
  } catch (error) {
    return playlistErrorResponse(error);
  }
}
