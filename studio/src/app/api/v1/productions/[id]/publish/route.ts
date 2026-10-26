import { authorize, readJsonObject } from "@/lib/api-auth";
import { apiOrigin } from "@/lib/api-origin";
import { assemblyApi, publishAssembly } from "@/lib/assembly-server";
export const runtime = "nodejs";
export const POST = (
  request: Request,
  context: { params: Promise<{ id: string }> },
) =>
  assemblyApi(async () => {
    const caller = await authorize(request, "productions:write");
    if (caller instanceof Response) return caller;
    const body = await readJsonObject(request);
    if (body instanceof Response) return body;
    return Response.json(
      await publishAssembly(
        caller.uid,
        (await context.params).id,
        body,
        apiOrigin(request),
      ),
      { headers: { "Cache-Control": "no-store" } },
    );
  });
