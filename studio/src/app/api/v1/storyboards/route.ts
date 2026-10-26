import { authorize, readJsonObject } from '@/lib/api-auth';
import { createStoryboard, listStoryboards, noStore, storyboardApi } from '@/lib/storyboard-server';
export const runtime = 'nodejs';
export const GET = (request: Request) => storyboardApi(async () => {
  const caller = await authorize(request, 'storyboards:read');
  if (caller instanceof Response) return caller;
  return Response.json(await listStoryboards(caller.uid), { headers: noStore });
});
export const POST = (request: Request) => storyboardApi(async () => {
  const caller = await authorize(request, 'storyboards:write');
  if (caller instanceof Response) return caller;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  return Response.json(await createStoryboard(caller.uid, body), { status: 201, headers: noStore });
});
