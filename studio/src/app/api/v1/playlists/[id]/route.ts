import { authorize, readJsonObject } from "@/lib/api-auth";
import { deletePlaylist, getPlaylist, playlistErrorResponse, updatePlaylistDetails } from "@/lib/playlists-server";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

/** The playlist with its items in order. */
export async function GET(request: Request, { params }: Context): Promise<Response> {
  const caller = await authorize(request, "playlists:manage");
  if (caller instanceof Response) return caller;
  try {
    return Response.json(await getPlaylist(caller.uid, (await params).id), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return playlistErrorResponse(error);
  }
}

/** `{ title?, description? }` */
export async function PATCH(request: Request, { params }: Context): Promise<Response> {
  const caller = await authorize(request, "playlists:manage");
  if (caller instanceof Response) return caller;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  try {
    return Response.json(await updatePlaylistDetails(caller.uid, (await params).id, body));
  } catch (error) {
    return playlistErrorResponse(error);
  }
}

/** Deletes the playlist, never its narrations. */
export async function DELETE(request: Request, { params }: Context): Promise<Response> {
  const caller = await authorize(request, "playlists:manage");
  if (caller instanceof Response) return caller;
  try {
    await deletePlaylist(caller.uid, (await params).id);
    return new Response(null, { status: 204 });
  } catch (error) {
    return playlistErrorResponse(error);
  }
}
