import { authorize, readJsonObject } from '@/lib/api-auth';
import { deleteStoryboard, getStoryboard, saveStoryboard, noStore, storyboardApi } from '@/lib/storyboard-server';
export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };
export const GET = (request: Request, { params }: Context) => storyboardApi(async () => {
  const caller = await authorize(request, 'storyboards:read');
  if (caller instanceof Response) return caller;
  return Response.json(await getStoryboard(caller.uid, (await params).id), { headers: noStore });
});
export const PUT = (request: Request, { params }: Context) => storyboardApi(async () => {
  const caller = await authorize(request, 'storyboards:write');
  if (caller instanceof Response) return caller;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  return Response.json(await saveStoryboard(caller.uid, (await params).id, body), { headers: noStore });
});
export const DELETE = (request: Request, { params }: Context) => storyboardApi(async () => {
  const caller = await authorize(request, 'storyboards:write');
  if (caller instanceof Response) return caller;
  await deleteStoryboard(caller.uid, (await params).id);
  return new Response(null, { status: 204, headers: noStore });
});
