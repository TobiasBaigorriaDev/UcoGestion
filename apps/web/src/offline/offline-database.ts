import type { RevocationCheckpoint } from '@uconext/shared';
import Dexie, { type EntityTable, type Table } from 'dexie';

interface EncryptedRecord {
  readonly userId: string;
  readonly kind: string;
  readonly id: string;
  readonly ciphertext: Uint8Array;
}

export interface DeliveryEnvelope {
  readonly ack?:string;
  readonly id: string;
  readonly envelope: Uint8Array;
}

export interface DeliveryReceipt {
  readonly id: string;
  readonly envelopeHash: string;
  readonly status: 'ACKED' | 'SECURITY_REJECTED';
}

export interface KeyEnvelope {
  readonly userId: string;
  readonly wrappedDek: Uint8Array;
  readonly salt: Uint8Array;
  readonly version: number;
}

export interface DeviceKeys {
  readonly certificate?: string;
  readonly registrationKey?: string;
  readonly registrationActor?: string;
  readonly retiredUsers?: readonly string[];
  readonly closeCheckpoints?:readonly {readonly checkpoint:{readonly version:1;readonly organizationId:string;readonly deviceId:string;
    readonly actorUserId:string;readonly sessionId:string;readonly sequence:string;readonly headHash:string;
    readonly sessionSequence:string;readonly creationFrozen:true;readonly pending:0};readonly signature:string;readonly key:string}[];
  readonly closingSessions?: readonly string[];
  readonly freeze?: {readonly id:string;readonly epoch:number};
  readonly exposures?: readonly {readonly id:string;readonly epoch:number}[];
  readonly revoked?: boolean;
  readonly revokedUsers?: readonly string[];
  readonly knowledge?: readonly RevocationCheckpoint[];
  readonly ackKeys?: Readonly<Record<string,CryptoKey>>;
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
  readonly deviceRevoked?:boolean;
  readonly key: 'device-chain';
  readonly owner: string;
  readonly fence: string;
  readonly expiresAt: number;
  readonly sequence: string;
  readonly headHash: string | null;
  readonly cashSessionOpen?: boolean;
  readonly cashSessionId?:string;
}

export class OfflineDatabase extends Dexie {
  readonly records!: Table<EncryptedRecord, [string, string, string]>;
  readonly delivery_queue!: EntityTable<DeliveryEnvelope, 'id'>;
  readonly delivery_receipts!: EntityTable<DeliveryReceipt, 'id'>;
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
    this.version(4).stores({ delivery_receipts: 'id' });
  }

  async putEncrypted(userId: string, kind: string, id: string, ciphertext: Uint8Array): Promise<void> {
    await this.records.put({ userId, kind, id, ciphertext: ciphertext.slice() });
  }

  async getEncrypted(userId: string, kind: string, id: string): Promise<Uint8Array | undefined> {
    const record = await this.records.get([userId, kind, id]);
    return record?.ciphertext.slice();
  }

  async enqueueOpaque(id: string, envelope: Uint8Array): Promise<void> {
    await this.transaction('rw', [this.delivery_queue, this.delivery_receipts], async () => {
      if (await this.delivery_receipts.get(id)) throw new Error('OFFLINE_OPERATION_FINAL');
      await this.delivery_queue.add({ id, envelope: envelope.slice() });
    });
  }

  async deliveryBytes(): Promise<DeliveryEnvelope[]> {
    const rows = await this.delivery_queue.toArray();
    return rows.map(({ id, envelope,ack }) => ({ id, envelope: envelope.slice(),...(ack ? {ack}: {}) }));
  }
}
