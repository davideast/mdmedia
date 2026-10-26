import { createHash } from 'node:crypto';
import { after } from 'next/server';
import { authorize, readJsonObject, apiError, hasScope, forbiddenScope } from '@/lib/api-auth';
import { adminDb } from '@/lib/firebase-admin';
import { noStore, storyboardApi } from '@/lib/storyboard-server';
import { getStoryboard } from '@/lib/storyboard-server';
import { parseNarrationRequest } from '@/lib/narration-request';
import { startNarration } from '@/lib/narration-start';

export const runtime = 'nodejs';
export const maxDuration = 300;

/** Reuse a recording for the same owner, storyboard, text, voice and delivery.
 * Reserve before starting synthesis so concurrent play clicks cannot double-charge. */
export const POST = (request: Request, { params }: { params: Promise<{ id: string }> }) => storyboardApi(async () => {
  const caller = await authorize(request, 'narrations:create');
  if (caller instanceof Response) return caller;
  if (!hasScope(caller, 'storyboards:read')) return forbiddenScope('storyboards:read');
  const storyboardId = (await params).id;
  await getStoryboard(caller.uid, storyboardId);
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  if (typeof body.markdown !== 'string' || body.markdown.length > 100_000) return apiError(400, 'invalid_narration', 'Provide up to 100,000 characters to narrate.');
  const parsed = parseNarrationRequest({
    ...body, id: undefined, visibility: 'private', rewriteForNarration: false,
    rewriteInstructions: undefined, structureMarkdown: false, verbalizeDiagrams: false,
  });
  if (!parsed) return apiError(400, 'invalid_narration', 'Choose a reader and add text to narrate.');
  const fingerprint = createHash('sha256').update(JSON.stringify([caller.uid, storyboardId, parsed])).digest('hex');
  const id = `story_${fingerprint}`;
  const db = adminDb();
  const narration = db.collection('narrations').doc(id);
  const state = await db.runTransaction(async tx => {
    const saved = await tx.get(narration);
    if (saved.exists) return saved.data()?.status === 'error' ? 'error' : 'reuse';
    tx.set(narration, { ownerUid: caller.uid, status: 'streaming', visibility: 'private', title: parsed.markdown.slice(0, 60), sourceMarkdown: parsed.markdown, createdAt: Date.now(), updatedAt: Date.now() });
    return 'start';
  });
  if (state === 'error') return apiError(409, 'narration_failed', 'This narration failed. Review it in the narration library before retrying.');
  if (state === 'reuse') return Response.json({ id }, { headers: noStore });
  let started;
  try { started = await startNarration({ uid: caller.uid, request: { ...parsed, id }, signal: request.signal }); }
  catch (error) { await narration.delete(); throw error; }
  if (!started.ok) {
    await narration.delete();
    return apiError(started.status, started.code, started.message);
  }
  // Wait for the engine to create its real narration document before the player subscribes.
  const reader = started.stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) return apiError(502, 'narration_failed', 'Narration ended before it was ready.');
    buffer += decoder.decode(chunk.value, { stream: true });
    const lines = buffer.split('\n'); buffer = lines.pop()!;
    for (const line of lines.filter(Boolean)) {
      const event = JSON.parse(line);
      if (event.type === 'error') return apiError(502, 'narration_failed', event.message);
      if (event.type === 'meta') {
        after(async () => { try { while (!(await reader.read()).done) { /* Drain the existing engine stream. */ } } finally { reader.releaseLock(); } });
        return Response.json({ id }, { status: 201, headers: noStore });
      }
    }
  }
});
