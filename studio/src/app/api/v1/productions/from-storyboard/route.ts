import { authorize, readJsonObject } from "@/lib/api-auth";
import { apiOrigin } from "@/lib/api-origin";
import { assemblyApi, createAssemblyProduction } from "@/lib/assembly-server";
export const runtime = "nodejs";
export const POST = (request: Request) =>
  assemblyApi(async () => {
    const caller = await authorize(request, "productions:write");
    if (caller instanceof Response) return caller;
    const reader = await authorize(request, "storyboards:read");
    if (reader instanceof Response) return reader;
    const body = await readJsonObject(request);
    if (body instanceof Response) return body;
    return Response.json(
      await createAssemblyProduction(caller.uid, body, apiOrigin(request)),
      { headers: { "Cache-Control": "no-store" } },
    );
  });
