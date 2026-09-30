'use client';

import { useEffect } from 'react';

export function OfflineServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV === 'production' && 'serviceWorker' in navigator) {
      const localPreview = window.location.port === '3100' &&
        ['127.0.0.1', 'localhost'].includes(window.location.hostname);
      void navigator.serviceWorker.register(localPreview ? '/sw-preview.js' : '/sw.js', {
        scope: '/',
        updateViaCache: 'none',
      }).catch((error) => console.error('Offline app setup failed:', error));
    }
  }, []);
  return null;
}
