import { verifyIdToken } from "@/lib/firebase-admin";
import { GeminiMarkdownStructureAdapter } from "mdmedia/markdown";
import { createGeminiClient } from "mdmedia/tts";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  const uid = await verifyIdToken(request.headers.get("authorization"));
  if (!uid) {
    return Response.json(
      { message: "Please sign in to format document structure." },
      { status: 401 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  if (!body || typeof body !== "object" || !("markdown" in body)) {
    return Response.json(
      { message: "Missing markdown in request body." },
      { status: 400 },
    );
  }

  const rawMarkdown = String((body as { markdown: unknown }).markdown ?? "");
  const trimmed = rawMarkdown.trim();
  if (!trimmed) {
    return Response.json({ markdown: "" }, { status: 200 });
  }

  try {
    const client = createGeminiClient();
    const adapter = new GeminiMarkdownStructureAdapter(client);
    const structuredMarkdown = await adapter.structureMarkdown(trimmed);
    return Response.json({ markdown: structuredMarkdown }, { status: 200 });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Failed to format markdown structure.";
    return Response.json({ message }, { status: 500 });
  }
}
