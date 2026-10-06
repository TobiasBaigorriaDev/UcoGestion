import { OfflineDatabase } from './offline-database';

export class OpaqueDelivery {
  constructor(private readonly db: OfflineDatabase) {}

  pendingBytes(): Promise<readonly { readonly id: string; readonly envelope: Uint8Array }[]> {
    return this.db.deliveryBytes();
  }

  async signChallenge(challenge: Uint8Array): Promise<Uint8Array> {
    const device = await this.db.device_keys.get('device');
    if (!device) throw new Error('Dispositivo no autorizado.');
    const domain = new TextEncoder().encode('UcoNext:delivery-challenge:v1:');
    const message = new Uint8Array(domain.length + challenge.length);
    message.set(domain);
    message.set(challenge, domain.length);
    return new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' },
      device.signingKey, message as BufferSource));
  }
}
