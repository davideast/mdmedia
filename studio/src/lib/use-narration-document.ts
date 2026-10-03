"use client";

import { useEffect, useState } from 'react';
import { currentIdToken } from './firebase';
import { watchNarration } from './narrations';
import { observeNarrationDocument, type NarrationDocument } from './narration-document';
import type { NarrationTimingsFile } from './wav';

export function useNarrationDocument(id: string): NarrationDocument | null {
  const [document, setDocument] = useState<NarrationDocument | null>(null);
  useEffect(() => observeNarrationDocument(id, {
    watch: watchNarration,
    timings: async (narrationId, signal) => {
      const token = await currentIdToken();
      const response = await fetch(`/api/narrations/${narrationId}/timings?raw=1`, {
        signal, headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!response.ok) return null;
      return response.json() as Promise<NarrationTimingsFile>;
    },
  }, setDocument), [id]);
  return document?.id === id ? document : null;
}
