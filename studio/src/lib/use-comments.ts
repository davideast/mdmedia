'use client';

import { useEffect, useMemo, useState } from 'react';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import type { AgentHeartbeat, Message, Suggestion, Thread, TimedRef } from 'mdmedia/threads';
import { useAuth } from './auth-context';
import { readMessage, readSuggestion, readThread } from './comments-shape';
import { db } from './firebase';
import { studioFetch, studioJson } from './media-client';

/**
 * A cut's comments, live: its threads, each thread's messages and options,
 * and the agents' heartbeats, from Firestore listeners, so an agent's reply
 * appears as soon as it is written. Writes go through the API, which anchors
 * them and keeps statuses in step; the listeners then carry the result back.
 */

export interface CommentsData {
  threads: Thread[];
  messages: Record<string, Message[]>;
  suggestions: Record<string, Suggestion[]>;
  heartbeats: AgentHeartbeat[];
  ready: boolean;
  error: string;
}

const EMPTY: Record<string, never[]> = {};

export function useComments(productionId: string, cutId: string): CommentsData {
  const { user } = useAuth();
  const uid = user?.uid ?? null;
  const [threads, setThreads] = useState<{ key: string; list: Thread[] } | null>(null);
  const [messages, setMessages] = useState<Record<string, Message[]>>({});
  const [suggestions, setSuggestions] = useState<Record<string, Suggestion[]>>({});
  const [heartbeats, setHeartbeats] = useState<AgentHeartbeat[]>([]);
  const [error, setError] = useState('');
  const key = `${productionId}/${cutId}/${uid ?? ''}`;

  useEffect(() => {
    if (!uid) return;
    const threadsQuery = query(collection(db(), 'productions', productionId, 'threads'), where('ownerUid', '==', uid));
    return onSnapshot(
      threadsQuery,
      (snapshot) => setThreads({ key, list: snapshot.docs.map((doc) => readThread(doc.id, doc.data())).filter((t) => t.version.cutId === cutId).sort((a, b) => a.anchor.time - b.anchor.time || a.createdAt - b.createdAt) }),
      (e) => setError(e.message),
    );
  }, [cutId, key, productionId, uid]);

  const ids = useMemo(() => (threads?.key === key ? threads.list.map((t) => t.id).join(',') : ''), [key, threads]);

  // Each thread's messages and options, one listener each.
  useEffect(() => {
    if (!uid || !ids) return;
    const stops = ids.split(',').flatMap((threadId) => {
      const base = ['productions', productionId, 'threads', threadId] as const;
      return [
        onSnapshot(query(collection(db(), ...base, 'messages'), where('ownerUid', '==', uid)), (snapshot) => {
          const list = snapshot.docs.map((doc) => readMessage(doc.id, doc.data())).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
          setMessages((previous) => ({ ...previous, [threadId]: list }));
        }, (e) => setError(e.message)),
        onSnapshot(query(collection(db(), ...base, 'suggestions'), where('ownerUid', '==', uid)), (snapshot) => {
          const list = snapshot.docs.map((doc) => readSuggestion(doc.id, doc.data())).sort((a, b) => a.round - b.round || a.letter.localeCompare(b.letter));
          setSuggestions((previous) => ({ ...previous, [threadId]: list }));
        }, (e) => setError(e.message)),
      ];
    });
    return () => stops.forEach((stop) => stop());
  }, [ids, productionId, uid]);

  useEffect(() => {
    if (!uid) return;
    return onSnapshot(query(collection(db(), 'commentAgents'), where('ownerUid', '==', uid)), (snapshot) => {
      setHeartbeats(snapshot.docs.map((doc) => {
        const data = doc.data();
        return { agent: String(data.agent ?? ''), productionId: typeof data.productionId === 'string' ? data.productionId : null, seenAt: typeof data.seenAt === 'number' ? data.seenAt : 0 };
      }));
    }, () => setHeartbeats([]));
  }, [uid]);

  const list = threads?.key === key ? threads.list : [];
  return { threads: list, messages: ids ? messages : EMPTY, suggestions: ids ? suggestions : EMPTY, heartbeats, ready: threads?.key === key, error };
}

// --- Writes, through the API ----------------------------------------------------

const threadsPath = (productionId: string) => `/api/v1/productions/${encodeURIComponent(productionId)}/threads`;
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export function createComment(productionId: string, body: { cutId: string; time: number; text: string; view: '4:3' | '16:9'; frameAssetId?: string | null }): Promise<Thread> {
  return studioJson<Thread>(threadsPath(productionId), json('POST', body));
}

export function replyTo(productionId: string, threadId: string, body: { text: string; at?: Pick<TimedRef, 'video' | 'time'> }): Promise<Message> {
  return studioJson<Message>(`${threadsPath(productionId)}/${encodeURIComponent(threadId)}/messages`, json('POST', body));
}

export function setOptionState(productionId: string, threadId: string, suggestionId: string, state: 'accepted' | 'rejected'): Promise<Suggestion> {
  return studioJson<Suggestion>(`${threadsPath(productionId)}/${encodeURIComponent(threadId)}/suggestions/${encodeURIComponent(suggestionId)}`, json('PATCH', { state }));
}

/**
 * The frame under the playhead as a JPEG, as the viewer framed it (the TV's
 * middle 4:3, or the whole 16:9), for the comment's snapshot. Taken when C is
 * pressed and kept in memory; it is uploaded only if the comment is sent.
 * Null when it can't be taken.
 */
export async function grabFrame(video: HTMLVideoElement, view: '4:3' | '16:9'): Promise<Blob | null> {
  try {
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) return null;
    const cropWidth = view === '4:3' ? Math.round((height * 4) / 3) : width;
    const canvas = document.createElement('canvas');
    canvas.width = cropWidth;
    canvas.height = height;
    canvas.getContext('2d')?.drawImage(video, (width - cropWidth) / 2, 0, cropWidth, height, 0, 0, cropWidth, height);
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.86));
  } catch {
    return null;
  }
}

/** Uploads a grabbed frame as a production image (once per content hash) and returns its asset id, or null. */
export async function uploadFrame(blob: Blob | null): Promise<string | null> {
  if (!blob) return null;
  try {
    const bytes = await blob.arrayBuffer();
    const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
    const found = await studioJson<{ found: Record<string, { id: string }> }>(`/api/v1/productions/media?sha256=${sha}`);
    if (found.found[sha]) return found.found[sha].id;
    const response = await studioFetch(`/api/v1/productions/media/${sha}?mediaType=image`, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
    return ((await response.json()) as { id: string }).id;
  } catch {
    return null;
  }
}
