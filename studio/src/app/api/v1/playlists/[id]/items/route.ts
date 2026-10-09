import { apiError, authorize, readJsonObject } from "@/lib/api-auth";
import { parsePlaylistOps } from "@/lib/playlist-ops";
import { editPlaylistItems, playlistErrorResponse, reorderPlaylist } from "@/lib/playlists-server";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

/**
 * `{ ops: [{ add: [ids], at? }, { remove: [ids] }, { move: id, to }] }`, applied
 * in order to the playlist as it is now, all or nothing. Positions are
 * "start", "end", { before: id }, or { after: id }.
 */
export async function POST(request: Request, { params }: Context): Promise<Response> {
  const caller = await authorize(request, "playlists:manage");
  if (caller instanceof Response) return caller;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  const ops = parsePlaylistOps(body.ops);
  if (typeof ops === "string") return apiError(400, "invalid_ops", ops);
  try {
    return Response.json(await editPlaylistItems(caller.uid, (await params).id, ops));
  } catch (error) {
    return playlistErrorResponse(error);
  }
}

/** `{ order: [ids] }`: a new order of exactly the items already there. */
export async function PUT(request: Request, { params }: Context): Promise<Response> {
  const caller = await authorize(request, "playlists:manage");
  if (caller instanceof Response) return caller;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  try {
    return Response.json(await reorderPlaylist(caller.uid, (await params).id, body.order));
  } catch (error) {
    return playlistErrorResponse(error);
  }
}
