import { apiError } from "@/lib/api-auth";
import { pollDeviceAuthorization } from "@/lib/api-keys";

export const runtime = "nodejs";

/** The client's poll. Returns the API key exactly once, after approval. */
export async function POST(request: Request): Promise<Response> {
  let deviceCode: unknown;
  try { deviceCode = (await request.json())?.deviceCode; } catch { /* Handled below. */ }
  if (typeof deviceCode !== "string") return apiError(400, "invalid_request", "Send { \"deviceCode\": \"…\" }.");
  try {
    const result = await pollDeviceAuthorization(deviceCode);
    if (result.status !== "approved") return Response.json({ status: result.status }, { headers: { "Cache-Control": "no-store" } });
    return Response.json({ status: "approved", apiKey: result.token, key: result.key }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiError(409, "cannot_issue", error instanceof Error ? error.message : "Could not issue a key.");
  }
}
