'use client';

import { useEffect } from 'react';

import { prepareOfflineUpdate } from '../src/offline/prepare-offline-update';

export function OfflineProvider() {
  useEffect(() => {
    if (window.isSecureContext && 'serviceWorker' in navigator) {
      void prepareOfflineUpdate().then(() =>
        navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }),
      ).catch(() => {
        window.dispatchEvent(new CustomEvent('uco:offline-update-blocked'));
      });
    }
  }, []);
  return null;
}
