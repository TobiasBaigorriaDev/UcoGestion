import { base64, bytes, encode, hash, unbase64 } from './offline-crypto';
import { OfflineDatabase } from './offline-database';
import { OfflineKeys } from './offline-keys';
import { OfflineLease } from './offline-lease';
import { OfflineRecordCipher } from './offline-record-cipher';
import { buildSyncEnvelope, type SignedIngestionPublication } from './sync-envelope';

export interface SealInput {
  readonly operationId?: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly grant: unknown;
  readonly configVersion: string;
  readonly occurredAt: string;
}

export interface SealTransport {
  readonly certificate: string;
  readonly publication: SignedIngestionPublication;
  readonly trustedSigner: CryptoKey;
  readonly trustedSigningKeyId: string;
}

export interface SealCommit {
  readonly stateWrites?: readonly { readonly kind: string; readonly id: string; readonly value: unknown; readonly replace?: boolean }[];
  readonly assertBeforeCommit?: () => Promise<void>;
  readonly sessionOpening?: boolean;
  /** Only IndexedDB/clock checks here; cryptography is prepared before the transaction. */
  readonly assertCanCommit?: () => Promise<void>;
}

/** Cryptographic/atomic primitive. Grant and business-policy validation belongs to
 * the calling offline use case (T187/T192); possession of a DEK alone is not authorization.
 */
export class OfflineSealer {
  private readonly cipher = new OfflineRecordCipher();

  constructor(private readonly db: OfflineDatabase, private readonly keys: OfflineKeys,
    private readonly leases: OfflineLease, private readonly transport: SealTransport) {}

  async seal(input: SealInput, commit: SealCommit = {}): Promise<{ id: string; sequence: string; hash: string }> {
    // Snapshot caller objects before any asynchronous work.
    const snapshot = structuredClone(input);
    const dek = this.keys.dekFor(snapshot.userId);
    const lease = await this.leases.acquire(crypto.randomUUID());
    let committed = false;
    try {
      const device = await this.db.device_keys.get('device');
      if (!device) throw new Error('Device signer unavailable.');
      const identity = { organizationId: this.db.organizationId, deviceId: this.db.deviceId, userId: snapshot.userId };
      const sessionContext = { ...identity, kind: 'session-chain', id: snapshot.sessionId };
      const sessionRecord = await this.db.getEncrypted(snapshot.userId, 'session-chain', snapshot.sessionId);
      let sessionSequence = '0';
      if (sessionRecord) {
        const previous: unknown = JSON.parse(new TextDecoder().decode(await this.cipher.decrypt(dek, sessionContext, sessionRecord)));
        if (typeof previous !== 'string' || !/^(0|[1-9]\d*)$/.test(previous)) throw new Error('Invalid session sequence.');
        sessionSequence = previous;
      }
      const id = snapshot.operationId ?? crypto.randomUUID();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new Error('Invalid operation ID.');
      const sequence = (BigInt(lease.sequence) + 1n).toString();
      const operation = { id, actorId: snapshot.userId, organizationId: this.db.organizationId,
        deviceId: this.db.deviceId, sessionId: snapshot.sessionId, sequence,
        sessionSequence: (BigInt(sessionSequence) + 1n).toString(), previousHash: lease.headHash,
        kind: snapshot.kind, payload: snapshot.payload, grant: snapshot.grant,
        configVersion: snapshot.configVersion, occurredAt: snapshot.occurredAt, receivedAt: null };
      const operationHash = await hash(encode(operation));
      const signature = base64(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' },
        device.signingKey, bytes(unbase64(operationHash)))));
      const encrypted = await this.cipher.encrypt(dek, { ...identity, kind: 'operation', id },
        encode({ operation, hash: operationHash, signature }));
      const encryptedSession = await this.cipher.encrypt(dek, sessionContext, encode(operation.sessionSequence));
      const envelope = await buildSyncEnvelope(operation, this.transport.certificate, device.signingKey,
        this.transport.publication, this.transport.trustedSigner, this.transport.trustedSigningKeyId);
      const stateWrites = await Promise.all((commit.stateWrites ?? []).map(async (row) => ({
        replace: row.replace ?? false, userId: snapshot.userId, kind: row.kind, id: row.id,
        ciphertext: await this.cipher.encrypt(dek, { ...identity, kind: row.kind, id: row.id }, encode(row.value)),
      })));
      await this.db.transaction('rw', [this.db.records, this.db.delivery_queue, this.db.meta], async () => {
        await this.leases.assert(lease);
        if (commit.sessionOpening && lease.cashSessionOpen) throw new Error('Este dispositivo ya tiene una sesión abierta.');
        await commit.assertCanCommit?.();
        await commit.assertBeforeCommit?.();
        if (this.keys.dekFor(snapshot.userId) !== dek) throw new Error('Offline identity changed during sealing.');
        await this.db.records.add({ userId: snapshot.userId, kind: 'operation', id, ciphertext: encrypted });
        await this.db.delivery_queue.add({ id, envelope });
        await this.db.records.put({ userId: snapshot.userId, kind: 'session-chain', id: snapshot.sessionId, ciphertext: encryptedSession });
        for (const { replace, ...row } of stateWrites) {
          if (replace) await this.db.records.put(row);
          else await this.db.records.add(row);
        }
        await this.leases.assert(lease);
        await this.db.meta.put({ ...lease, ...(commit.sessionOpening ? { cashSessionOpen: true } : {}),
          sequence, headHash: operationHash, expiresAt: 0 });
        // Logout/identity changes during pending IndexedDB requests abort the entire transaction.
        if (this.keys.dekFor(snapshot.userId) !== dek) throw new Error('Offline identity changed during sealing.');
        await commit.assertCanCommit?.();
      });
      committed = true;
      return { id, sequence, hash: operationHash };
    } finally {
      // A successful commit already releases its lease in the same transaction.
      // A failed cleanup cannot consume sequence; an unreleased lease expires.
      if (!committed) await this.leases.release(lease);
    }
  }
}
