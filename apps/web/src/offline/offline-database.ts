import Dexie, { type EntityTable, type Table } from 'dexie';

interface EncryptedRecord {
  readonly userId: string;
  readonly kind: string;
  readonly id: string;
  readonly ciphertext: Uint8Array;
}

interface DeliveryEnvelope {
  readonly id: string;
  readonly envelope: Uint8Array;
}

export interface KeyEnvelope {
  readonly userId: string;
  readonly wrappedDek: Uint8Array;
  readonly salt: Uint8Array;
  readonly version: number;
}

export interface DeviceKeys {
  readonly id: 'device';
  readonly signingKey: CryptoKey;
  readonly publicKey: CryptoKey;
  readonly wrappingKey: CryptoKey;
}

export interface PinAttempt {
  readonly userId: string;
  readonly failures: number;
  readonly retryAfter: number;
  readonly locked: boolean;
}

export interface DeviceChain {
  readonly key: 'device-chain';
  readonly owner: string;
  readonly fence: string;
  readonly expiresAt: number;
  readonly sequence: string;
  readonly headHash: string | null;
  readonly cashSessionOpen?: boolean;
}

export class OfflineDatabase extends Dexie {
  readonly records!: Table<EncryptedRecord, [string, string, string]>;
  readonly delivery_queue!: EntityTable<DeliveryEnvelope, 'id'>;
  readonly key_envelopes!: EntityTable<KeyEnvelope, 'userId'>;
  readonly pin_attempts!: EntityTable<PinAttempt, 'userId'>;
  readonly device_keys!: EntityTable<DeviceKeys, 'id'>;
  readonly meta!: Table<DeviceChain, string>;

  static nameFor(organizationId: string, deviceId: string): string {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuid.test(organizationId) || !uuid.test(deviceId)) throw new Error('Invalid offline database identity.');
    return `uconext-offline-${organizationId}-${deviceId}`;
  }

  constructor(readonly organizationId: string, readonly deviceId: string) {
    super(OfflineDatabase.nameFor(organizationId, deviceId));
    this.version(1).stores({ records: '[userId+kind+id]', delivery_queue: 'id', meta: 'key' });
    this.version(2).stores({ records: '[userId+kind+id]', delivery_queue: 'id', meta: 'key',
      key_envelopes: 'userId', pin_attempts: 'userId', device_keys: 'id' });
    // Validate before committing the forward migration; never rewrite ciphertext.
    this.version(3).stores({}).upgrade(async (transaction) => {
      for (const record of await transaction.table<EncryptedRecord>('records').toArray()) {
        if (record.ciphertext[0] !== 1 || record.ciphertext.length < 29) {
          throw new Error('OFFLINE_UPDATE_INCOMPATIBLE');
        }
      }
      for (const row of await transaction.table<DeliveryEnvelope>('delivery_queue').toArray()) {
        const envelope: unknown = JSON.parse(new TextDecoder().decode(row.envelope));
        if (!envelope || typeof envelope !== 'object' || !('version' in envelope) || envelope.version !== 1 ||
          !('keyId' in envelope) || typeof envelope.keyId !== 'string' || !envelope.keyId) {
          throw new Error('OFFLINE_UPDATE_INCOMPATIBLE');
        }
      }
      for (const row of await transaction.table<KeyEnvelope>('key_envelopes').toArray()) {
        if (row.version !== 1) throw new Error('OFFLINE_UPDATE_INCOMPATIBLE');
      }
    });
  }

  async putEncrypted(userId: string, kind: string, id: string, ciphertext: Uint8Array): Promise<void> {
    await this.records.put({ userId, kind, id, ciphertext: ciphertext.slice() });
  }

  async getEncrypted(userId: string, kind: string, id: string): Promise<Uint8Array | undefined> {
    const record = await this.records.get([userId, kind, id]);
    return record?.ciphertext.slice();
  }

  async enqueueOpaque(id: string, envelope: Uint8Array): Promise<void> {
    await this.delivery_queue.add({ id, envelope: envelope.slice() });
  }

  async deliveryBytes(): Promise<DeliveryEnvelope[]> {
    const rows = await this.delivery_queue.toArray();
    return rows.map(({ id, envelope }) => ({ id, envelope: envelope.slice() }));
  }
}
