import { Money, validateNonNegativeMoney } from '@uconext/shared';
import { z } from 'zod';

import { requireOfflineCapabilities } from './capability-gate';
import { OfflineAuthorization, type OfflineAuthorizationContext } from './offline-authorization';
import { OfflineDatabase } from './offline-database';
import { OfflineKeys } from './offline-keys';
import { OfflineRecordCipher } from './offline-record-cipher';
import { OfflineSealer } from './offline-sealer';
import { offlineSaleDraftInputSchema, quoteOfflineSale } from './offline-sale';
import { OfflineSales } from './offline-sales';

const openingSchema = z.strictObject({ cashRegisterId: z.uuid(), openingCash: z.string() });
export const localCashSessionSchema = z.strictObject({ id: z.uuid(), actorUserId: z.uuid(), branchId: z.uuid(),
  cashRegisterId: z.uuid(), openingCash: z.string().regex(/^(?:0|[1-9]\d{0,17})\.\d{2}$/),
  currency: z.string().regex(/^[A-Z]{3}$/), openedAt: z.iso.datetime(), status: z.literal('OPEN') });

export class OfflinePos {
  private readonly cipher = new OfflineRecordCipher();
  constructor(private readonly db: OfflineDatabase, private readonly keys: OfflineKeys,
    private readonly authorization: OfflineAuthorization, private readonly sealer: OfflineSealer,
    private readonly capabilities: () => Promise<void> = requireOfflineCapabilities) {}

  async catalog(userId: string) {
    const { bootstrap } = await this.authorization.read(userId);
    return { configuration: bootstrap.configuration, stock: bootstrap.stock, lastSyncAt: bootstrap.serverTime };
  }

  /** Consumer-final policy for the sale pipeline; confirmation and payments are T197. */
  async prepareSale(userId: string, input: unknown) {
    const sale = offlineSaleDraftInputSchema.parse(input);
    await this.session(userId, sale.sessionId);
    const authorized = await this.authorization.require(userId);
    const dek = this.keys.dekFor(userId);
    const draft = { ...sale, id: crypto.randomUUID(), customerKind: 'CONSUMER_FINAL' as const,
      configurationVersion: authorized.claims.configurationVersion,
      quote: quoteOfflineSale(authorized.bootstrap.configuration, sale.lines,
        sale.discount === undefined ? undefined : { authority: authorized.claims, discount: sale.discount }) };
    const ciphertext = await this.cipher.encrypt(dek, { organizationId: this.db.organizationId,
      deviceId: this.db.deviceId, userId, kind: 'sale-draft', id: draft.id },
    new TextEncoder().encode(JSON.stringify(draft)));
    await this.db.transaction('rw', this.db.records, async () => {
      await this.assertAuthorization(userId, authorized);
      if (this.keys.dekFor(userId) !== dek) throw new Error('Offline identity changed.');
      await this.db.putEncrypted(userId, 'sale-draft', draft.id, ciphertext);
      await this.assertAuthorization(userId, authorized);
    });
    return draft;
  }

  async confirmSale(userId: string, input: unknown) {
    return new OfflineSales(this.db, this.keys, this.authorization, this.sealer, this.capabilities,
      (actor, id) => this.session(actor, id)).confirm(userId, input);
  }

  async open(userId: string, input: z.infer<typeof openingSchema>) {
    const request = openingSchema.parse(input);
    await this.capabilities();
    const authorized = await this.authorization.require(userId);
    if (!authorized.claims.cashRegisterIds.includes(request.cashRegisterId)) throw new Error('Caja offline no autorizada.');
    const amount = validateNonNegativeMoney(request.openingCash);
    if (amount === undefined) throw new Error('Importe de apertura inválido.');
    const session = localCashSessionSchema.parse({ id: crypto.randomUUID(), actorUserId: userId,
      branchId: authorized.claims.branchId, cashRegisterId: request.cashRegisterId, openingCash: Money.from(amount).toString(),
      currency: authorized.bootstrap.configuration.currency, openedAt: new Date().toISOString(), status: 'OPEN' });
    const sealed = await this.sealer.seal({ userId, sessionId: session.id, kind: 'cash-session-open', payload: session,
      grant: authorized.grant, configVersion: authorized.claims.configurationVersion, occurredAt: session.openedAt }, {
      sessionOpening: true, stateWrites: [{ kind: 'cash-session', id: session.id, value: session },
        { kind: 'cash-projection', id: session.id, value: session.openingCash }],
      assertCanCommit: () => this.assertAuthorization(userId, authorized),
    });
    return { sessionId: session.id, operationId: sealed.id, sequence: sealed.sequence };
  }

  async session(userId: string, sessionId: string) {
    const authorized = await this.authorization.require(userId);
    const dek = this.keys.dekFor(userId);
    const encrypted = await this.db.getEncrypted(userId, 'cash-session', sessionId);
    if (!encrypted || !(await this.db.meta.get('device-chain'))?.cashSessionOpen) throw new Error('Sesión offline no disponible.');
    const session = localCashSessionSchema.parse(JSON.parse(new TextDecoder().decode(await this.cipher.decrypt(
      dek, { organizationId: this.db.organizationId, deviceId: this.db.deviceId,
        userId, kind: 'cash-session', id: sessionId }, encrypted))));
    if (session.actorUserId !== userId || session.branchId !== authorized.claims.branchId ||
      !authorized.claims.cashRegisterIds.includes(session.cashRegisterId)) throw new Error('Sesión offline no autorizada.');
    if (this.keys.dekFor(userId) !== dek) throw new Error('Offline identity changed.');
    this.authorization.assertCurrent(authorized);
    return session;
  }

  private async assertAuthorization(userId: string, context: OfflineAuthorizationContext): Promise<void> {
    await this.authorization.assertUsable(userId, context);
    const current = await this.db.getEncrypted(userId, 'authorization', 'current');
    const original = context.authorizationBytes;
    if (!current || !original || current.length !== original.length || current.some((byte, index) => byte !== original[index])) {
      throw new Error('La autorización offline cambió.');
    }
    this.keys.dekFor(userId);
  }
}
