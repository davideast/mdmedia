import { authorize, readJsonObject } from "@/lib/api-auth";
import { apiOrigin } from "@/lib/api-origin";
import {
  assemblyApi,
  getAssembly,
  updateAssembly,
} from "@/lib/assembly-server";
export const runtime = "nodejs";
export const GET = (
  request: Request,
  context: { params: Promise<{ id: string }> },
) =>
  assemblyApi(async () => {
    const caller = await authorize(request, "productions:read");
    if (caller instanceof Response) return caller;
    return Response.json(
      await getAssembly(
        caller.uid,
        (await context.params).id,
        apiOrigin(request),
      ),
      { headers: { "Cache-Control": "no-store" } },
    );
  });
export const PUT = (
  request: Request,
  context: { params: Promise<{ id: string }> },
) =>
  assemblyApi(async () => {
    const caller = await authorize(request, "productions:write");
    if (caller instanceof Response) return caller;
    const body = await readJsonObject(request);
    if (body instanceof Response) return body;
    return Response.json(
      await updateAssembly(
        caller.uid,
        (await context.params).id,
        body,
        apiOrigin(request),
      ),
      { headers: { "Cache-Control": "no-store" } },
    );
  });
