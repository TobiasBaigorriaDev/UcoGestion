'use client';

import { useEffect } from 'react';

import { deliverAllOpaqueDatabases,startOpaqueDelivery } from '../src/offline/opaque-delivery';
import { prepareOfflineUpdate } from '../src/offline/prepare-offline-update';
import { observeIdentityRetirement } from '../src/offline/offline-identity';
import { OpaqueProgress } from '../src/features/offline/opaque-progress';

export function OfflineProvider() {
  useEffect(() => {
    const stopIdentity = observeIdentityRetirement();
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
    return ()=>{stopIdentity();stop();navigator.serviceWorker?.removeEventListener('message',requestDelivery);};
  }, []);
  return <OpaqueProgress />;
}
