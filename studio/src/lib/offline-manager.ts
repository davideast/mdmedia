'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getMediaStore } from './media-store';
import type { NarrationTimingsFile } from './wav';

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
export async function isNarrationOffline(id: string): Promise<boolean> {
  const mediaStore = getMediaStore();
  return await mediaStore.has(id);
}

/**
 * Checks whether a narration is currently being downloaded.
 */
export function isNarrationDownloading(id: string): boolean {
  return inFlightDownloads.has(id);
}

/**
 * Explicitly downloads and persists a narration and its word alignments to OPFS.
 * Deduplicates in-flight requests for the same narration ID.
 */
export function downloadNarration(
  id: string,
  metadata?: OfflineNarrationMetadata,
): Promise<boolean> {
  const existing = inFlightPromises.get(id);
  if (existing) return existing;

  const downloadPromise = (async () => {
    inFlightDownloads.add(id);
    notifyOfflineChange(id, false, true);

    try {
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

      const mediaStore = getMediaStore();
      await mediaStore.saveTrack(id, audioBlob, mergedTimings);
      notifyOfflineChange(id, true, false);
      return true;
    } catch (err) {
      const isStillOffline = await getMediaStore().has(id);
      notifyOfflineChange(id, isStillOffline, false);
      throw err;
    } finally {
      inFlightDownloads.delete(id);
      inFlightPromises.delete(id);
    }
  })();

  inFlightPromises.set(id, downloadPromise);
  return downloadPromise;
}

/**
 * Removes a narration from local offline storage.
 */
export async function removeOfflineNarration(id: string): Promise<void> {
  const mediaStore = getMediaStore();
  await mediaStore.delete(id);
  notifyOfflineChange(id, false, false);
}

/**
 * React hook to observe and manage offline status for a specific narration.
 */
export function useOfflineStatus(
  narrationId: string | null | undefined,
  metadata?: OfflineNarrationMetadata,
) {
  const [isDownloaded, setIsDownloaded] = useState(false);
  const [isDownloading, setIsDownloading] = useState(
    narrationId ? isNarrationDownloading(narrationId) : false,
  );
  const metadataRef = useRef(metadata);
  metadataRef.current = metadata;

  useEffect(() => {
    if (!narrationId) {
      setIsDownloaded(false);
      setIsDownloading(false);
      return;
    }

    let active = true;
    setIsDownloading(isNarrationDownloading(narrationId));

    void isNarrationOffline(narrationId).then((offline) => {
      if (active) setIsDownloaded(offline);
    });

    const unsubscribe = subscribeOfflineChange((changedId, offline, downloading) => {
      if (changedId === narrationId && active) {
        setIsDownloaded(offline);
        setIsDownloading(downloading);
      }
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [narrationId]);

  const download = useCallback(async () => {
    if (!narrationId || isNarrationDownloading(narrationId)) return;
    await downloadNarration(narrationId, metadataRef.current);
  }, [narrationId]);

  const remove = useCallback(async () => {
    if (!narrationId) return;
    await removeOfflineNarration(narrationId);
  }, [narrationId]);

  return {
    isDownloaded,
    isDownloading,
    download,
    remove,
  };
}
