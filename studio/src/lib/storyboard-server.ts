import { randomUUID } from 'node:crypto';
import { adminDb } from './firebase-admin';
import { apiError } from './api-auth';
import { emptyStoryboard, parseStoryboard, type SavedStoryboard, type StoryboardResource, type StoryboardSummary } from './storyboard';

export const noStore = { 'Cache-Control': 'no-store' };
class StoryboardError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export async function storyboardApi(fn: () => Promise<Response>): Promise<Response> {
  try { return await fn(); }
  catch (error) {
    if (error instanceof StoryboardError) return apiError(error.status, error.code, error.message, noStore);
    throw error;
  }
}
function storyboardRef(id: string) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new StoryboardError(404, 'storyboard_not_found', 'No storyboard of yours with that id.');
  return adminDb().collection('storyboards').doc(id);
}
function resource(uid: string, id: string, data: FirebaseFirestore.DocumentData | undefined): StoryboardResource {
  if (!data || data.ownerUid !== uid) throw new StoryboardError(404, 'storyboard_not_found', 'No storyboard of yours with that id.');
  return { id, title: data.title, createdAt: data.createdAt, updatedAt: data.updatedAt, storyboard: data.storyboard as SavedStoryboard };
}
function title(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new StoryboardError(400, 'invalid_storyboard', 'Provide a title of up to 200 characters.');
  return value.trim();
}
function document(value: unknown) {
  try { return parseStoryboard(value); }
  catch (error) { throw new StoryboardError(400, 'invalid_storyboard', (error as Error).message); }
}
export async function listStoryboards(uid: string): Promise<{ storyboards: StoryboardSummary[] }> {
  const saved = await adminDb().collection('storyboards').where('ownerUid', '==', uid).get();
  return { storyboards: saved.docs.map(doc => {
    const item = resource(uid, doc.id, doc.data());
    return { id: item.id, title: item.title, updatedAt: item.updatedAt, beatCount: item.storyboard?.document.beats.length ?? 0, image: item.storyboard?.document.beats.find(beat => beat.image)?.image ?? null };
  }).sort((a,b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)) };
}
export async function createStoryboard(uid: string, body: Record<string, unknown>): Promise<StoryboardResource> {
  if (Object.keys(body).some(key => !['title', 'document'].includes(key))) throw new StoryboardError(400, 'invalid_storyboard', 'Only title and document are supported.');
  const now = Date.now();
  const data = { ownerUid: uid, title: title(body.title), createdAt: now, updatedAt: now, storyboard: { revision: 1, updatedAt: now, document: document(body.document === undefined ? emptyStoryboard() : body.document) } };
  const ref = storyboardRef(`sb${randomUUID().replaceAll('-', '')}`);
  await ref.set(data);
  return resource(uid, ref.id, data);
}
export async function getStoryboard(uid: string, id: string): Promise<StoryboardResource> {
  return resource(uid, id, (await storyboardRef(id).get()).data());
}
export async function saveStoryboard(uid: string, id: string, body: Record<string, unknown>): Promise<StoryboardResource> {
  if (!Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 0) throw new StoryboardError(400, 'invalid_storyboard', 'expectedRevision must be a non-negative integer.');
  if (Object.keys(body).some(key => !['expectedRevision', 'title', 'document'].includes(key))) throw new StoryboardError(400, 'invalid_storyboard', 'Only expectedRevision, title and document are supported.');
  const nextDocument = document(body.document);
  const nextTitle = body.title === undefined ? undefined : title(body.title);
  const ref = storyboardRef(id);
  return adminDb().runTransaction(async tx => {
    const current = resource(uid, id, (await tx.get(ref)).data());
    if (current.storyboard?.revision !== body.expectedRevision) throw new StoryboardError(409, 'storyboard_conflict', 'This storyboard changed elsewhere. Your edits have been kept. Reload the saved version before applying them.');
    const updatedAt = Date.now();
    const patch = { title: nextTitle ?? current.title, updatedAt, storyboard: { revision: (body.expectedRevision as number) + 1, updatedAt, document: nextDocument } };
    tx.update(ref, patch);
    return { ...current, ...patch };
  });
}
export async function deleteStoryboard(uid: string, id: string): Promise<void> {
  const ref = storyboardRef(id);
  await adminDb().runTransaction(async tx => { resource(uid, id, (await tx.get(ref)).data()); tx.delete(ref); });
}
