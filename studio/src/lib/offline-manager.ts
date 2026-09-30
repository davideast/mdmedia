'use client';

import { useCallback, useEffect, useState } from 'react';
import { getMediaStore } from './media-store';
import type { NarrationTimingsFile } from './wav';
import { useAuth } from './auth-context';
import { downloadMediaStore, removeIndividualDownload, trackFromTimings, updateDownloadCatalog } from './download-catalog';

async function currentIdToken(): Promise<string | null> {
  try {
    const { currentIdToken: fetchToken } = await import('./firebase');
    return await fetchToken();
  } catch {
    return null;
  }
}

export interface OfflineNarrationMetadata {
  title?: string;
  sourceMarkdown?: string;
  adapted?: boolean;
  voice?: string;
}

export type OfflineChangeListener = (
  narrationId: string,
  isOffline: boolean,
  isDownloading: boolean,
) => void;

const offlineListeners = new Set<OfflineChangeListener>();
const inFlightDownloads = new Set<string>();
const inFlightPromises = new Map<string, Promise<boolean>>();

/**
 * Subscribe to offline and download status changes across the application.
 */
export function subscribeOfflineChange(listener: OfflineChangeListener): () => void {
  offlineListeners.add(listener);
  return () => {
    offlineListeners.delete(listener);
  };
}

function notifyOfflineChange(narrationId: string, isOffline: boolean, isDownloading: boolean) {
  for (const listener of offlineListeners) {
    try {
      listener(narrationId, isOffline, isDownloading);
    } catch {
      // Ignore listener notification error
    }
  }
}

/**
 * Checks whether a narration is stored in local offline storage (OPFS).
 */
export async function isNarrationOffline(id: string, uid?: string): Promise<boolean> {
  const mediaStore = uid ? downloadMediaStore(uid) : getMediaStore();
  return await mediaStore.has(id);
}

/**
 * Checks whether a narration is currently being downloaded.
 */
export function isNarrationDownloading(id: string, uid = ''): boolean {
  return inFlightDownloads.has(`${uid}:${id}`);
}

/**
 * Explicitly downloads and persists a narration and its word alignments to OPFS.
 * Deduplicates in-flight requests for the same narration ID.
 */
export function downloadNarration(
  id: string,
  metadata?: OfflineNarrationMetadata,
  uid?: string,
  asIndividual = true,
): Promise<boolean> {
  if (!uid) return Promise.reject(new Error('Sign in before downloading.'));
  const key = `${uid}:${id}`;
  const existing = inFlightPromises.get(key);
  if (existing) return existing;

  const downloadPromise = (async () => {
    inFlightDownloads.add(key);
    notifyOfflineChange(id, false, true);

    try {
      if (typeof navigator.storage?.getDirectory !== 'function') {
        throw new Error('Offline storage is unavailable in this browser.');
      }
      // Ask during the download gesture so the browser can retain the audio
      // under storage pressure. A denied request does not prevent the download.
      void navigator.storage.persist?.().catch(() => false);
      const token = await currentIdToken();
      const headers: Record<string, string> = {};
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      const fetchFn = globalThis.fetch || fetch;
      const [audioResponse, timingsResponse] = await Promise.all([
        fetchFn(`/api/narrations/${id}/audio?raw=1`, { headers }),
        fetchFn(`/api/narrations/${id}/timings?raw=1`, { headers }),
      ]);

      if (!audioResponse.ok || !timingsResponse.ok) {
        throw new Error('Failed to fetch audio and timing data from server.');
      }

      const [audioBlob, timingsFile] = await Promise.all([
        audioResponse.blob(),
        timingsResponse.json() as Promise<NarrationTimingsFile>,
      ]);

      const mergedTimings: NarrationTimingsFile = {
        ...timingsFile,
        title: timingsFile.title || metadata?.title || '',
        sourceMarkdown: timingsFile.sourceMarkdown ?? metadata?.sourceMarkdown,
        adapted: timingsFile.adapted ?? metadata?.adapted,
      };

      // Explicit downloads must never report success after falling back to
      // the in-memory adapter, which disappears when the app closes.
      const mediaStore = downloadMediaStore(uid);
      await mediaStore.saveTrack(id, audioBlob, mergedTimings);
      await updateDownloadCatalog(uid, (current) => ({
        ...current,
        tracks: { ...current.tracks, [id]: trackFromTimings(id, mergedTimings, metadata?.voice) },
        individualIds: asIndividual && !current.individualIds.includes(id)
          ? [...current.individualIds, id]
          : current.individualIds,
      }));
      notifyOfflineChange(id, true, false);
      return true;
    } catch (err) {
      const isStillOffline = await downloadMediaStore(uid).has(id);
      notifyOfflineChange(id, isStillOffline, false);
      throw err;
    } finally {
      inFlightDownloads.delete(key);
      inFlightPromises.delete(key);
    }
  })();

  inFlightPromises.set(key, downloadPromise);
  return downloadPromise;
}

/**
 * Removes a narration from local offline storage.
 */
export async function removeOfflineNarration(id: string, uid?: string): Promise<boolean> {
  if (uid) await removeIndividualDownload(uid, id);
  else await getMediaStore().delete(id);
  const remains = await isNarrationOffline(id, uid);
  notifyOfflineChange(id, remains, false);
  return remains;
}

/**
 * React hook to observe and manage offline status for a specific narration.
 */
export function useOfflineStatus(
  narrationId: string | null | undefined,
  metadata?: OfflineNarrationMetadata,
) {
  const currentId = narrationId ?? null;
  const { user } = useAuth();
  const uid = user?.uid;
  const [status, setStatus] = useState(() => ({
    id: currentId,
    isDownloaded: false,
    isDownloading: currentId ? isNarrationDownloading(currentId, uid) : false,
  }));
  const isDownloaded = currentId === status.id && status.isDownloaded;
  const isDownloading = currentId === status.id
    ? status.isDownloading
    : currentId ? isNarrationDownloading(currentId, uid) : false;

  useEffect(() => {
    if (!currentId || !uid) return;

    let active = true;
    void isNarrationOffline(currentId, uid).then((offline) => {
      if (active) setStatus({
        id: currentId,
        isDownloaded: offline,
        isDownloading: isNarrationDownloading(currentId, uid),
      });
    });

    const unsubscribe = subscribeOfflineChange((changedId, offline, downloading) => {
      if (changedId === currentId && active) {
        setStatus({ id: currentId, isDownloaded: offline, isDownloading: downloading });
      }
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [currentId, uid]);

  const download = useCallback(async () => {
    if (!currentId || !uid || isNarrationDownloading(currentId, uid)) return;
    await downloadNarration(currentId, metadata, uid);
  }, [currentId, metadata, uid]);

  const remove = useCallback(async () => {
    if (!currentId || !uid) return;
    return await removeOfflineNarration(currentId, uid);
  }, [currentId, uid]);

  return {
    isDownloaded,
    isDownloading,
    download,
    remove,
  };
}
