'use client';

import { useEffect } from 'react';

import { deliverAllOpaqueDatabases,startOpaqueDelivery } from '../src/offline/opaque-delivery';
import { prepareOfflineUpdate } from '../src/offline/prepare-offline-update';

export function OfflineProvider() {
  useEffect(() => {
    const stop=startOpaqueDelivery(deliverAllOpaqueDatabases);
    const requestDelivery=(event:MessageEvent)=>{if (event.data?.type==='uco:delivery-request') window.dispatchEvent(new Event('uco:delivery-request'));};
    navigator.serviceWorker?.addEventListener('message',requestDelivery);
    if (window.isSecureContext && 'serviceWorker' in navigator) {
      void prepareOfflineUpdate().then(() =>
        navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }),
      ).catch(() => {
        window.dispatchEvent(new CustomEvent('uco:offline-update-blocked'));
      });
    }
    return ()=>{stop();navigator.serviceWorker?.removeEventListener('message',requestDelivery);};
  }, []);
  return null;
}
