import { consumeKnownStock, sumMoney, subtractMoney } from '@uconext/shared';
import { z } from 'zod';
import { paymentBalance } from '../features/sales/pos-payment-rules';
import { encode, hash } from './offline-crypto';
import { OfflineAuthorization, type OfflineAuthorizationContext } from './offline-authorization';
import { OfflineDatabase } from './offline-database';
import { OfflineKeys } from './offline-keys';
import { OfflineRecordCipher } from './offline-record-cipher';
import { OfflineSealer } from './offline-sealer';
import { offlineConfirmedSaleSchema, offlinePaymentSchema, offlineSaleConfirmSchema, offlineSaleDraftSchema, quoteOfflineSale } from './offline-sale';

const projectionSchema = z.strictObject({ configurationVersion: z.string(), remaining: z.string() });
const equalBytes = (a: Uint8Array | undefined, b: Uint8Array | undefined) =>
  a === undefined ? b === undefined : b !== undefined && a.length === b.length && a.every((value, index) => value === b[index]);

export class OfflineSales {
  private readonly cipher = new OfflineRecordCipher();
  constructor(private readonly db: OfflineDatabase, private readonly keys: OfflineKeys,
    private readonly authorization: OfflineAuthorization, private readonly sealer: OfflineSealer,
    private readonly capabilities: () => Promise<void>,
    private readonly session: (userId: string, sessionId: string) => Promise<unknown>) {}

  async confirm(userId: string, input: unknown) {
    const request = offlineSaleConfirmSchema.parse(input);
    const requestHash = await hash(encode(request));
    const existing = await this.read(userId, 'sale', request.draftId);
    if (existing !== undefined) {
      const sale = offlineConfirmedSaleSchema.parse(existing);
      if (sale.requestHash !== requestHash) throw new Error('La misma venta recibió un payload distinto.');
      return sale.result;
    }
    await this.capabilities();
    const authorized = await this.authorization.require(userId);
    const draft = offlineSaleDraftSchema.parse(await this.read(userId, 'sale-draft', request.draftId));
    if (draft.id !== request.draftId || draft.configurationVersion !== authorized.claims.configurationVersion) {
      throw new Error('Actualizá la preparación con el catálogo vigente.');
    }
    await this.session(userId, draft.sessionId);
    const sessionBytes = await this.db.getEncrypted(userId, 'cash-session', draft.sessionId);
    const quote = quoteOfflineSale(authorized.bootstrap.configuration, draft.lines,
      draft.discount === undefined ? undefined : { authority: authorized.claims, discount: draft.discount });
    const balance = paymentBalance(quote.total, request.payments);
    if (!balance.valid) throw new Error(balance.reason);
    if (request.payments.some(payment => !authorized.bootstrap.configuration.paymentMethods.includes(payment.method))) {
      throw new Error('Medio de pago offline no disponible.');
    }
    const payments = request.payments.map(payment => ({ ...payment,
      receivedAmount: payment.method === 'CASH' ? payment.receivedAmount ?? payment.appliedAmount : null,
      changeAmount: payment.method === 'CASH' ? subtractMoney(payment.receivedAmount ?? payment.appliedAmount, payment.appliedAmount) : '0.00',
    }));
    const localReference = `OFF-${this.db.deviceId}-${draft.id}`;
    const result = { id: draft.id, operationId: draft.id, localReference, total: quote.total, change: balance.change };
    const occurredAt = new Date().toISOString();
    const sale = offlineConfirmedSaleSchema.parse({ id: draft.id, localReference, reference: null,
      status: 'CONFIRMED', requestHash, actorUserId: userId, organizationId: this.db.organizationId,
      deviceId: this.db.deviceId, branchId: authorized.claims.branchId, cashSessionId: draft.sessionId,
      customerId: null, customerKind: 'CONSUMER_FINAL', configurationVersion: draft.configurationVersion, quote, payments,
      occurredAt, receivedAt: null,
      audit: { action: 'sale.confirmed.offline', actorUserId: userId, grantId: authorized.claims.grantId },
      receipt: { label: 'Comprobante no fiscal', branchName: authorized.bootstrap.configuration.branches.find(
        branch => branch.id === authorized.claims.branchId)?.name ?? '' }, result });
    const stocks = await Promise.all([...new Set(quote.lines.filter(line => line.trackInventory).map(line => line.itemId))]
      .map(async itemId => {
        const id = `${authorized.claims.branchId}:${itemId}`;
        const bytes = await this.db.getEncrypted(userId, 'stock-projection', id);
        const stored = bytes ? projectionSchema.parse(await this.read(userId, 'stock-projection', id)) : undefined;
        const available = stored?.configurationVersion === draft.configurationVersion ? stored.remaining
          : authorized.bootstrap.stock.find(stock => stock.itemId === itemId)?.quantity;
        if (available === undefined) throw new Error('Stock conocido no disponible.');
        return { id, bytes, value: { configurationVersion: draft.configurationVersion,
          remaining: consumeKnownStock(available, quote.lines.filter(line => line.itemId === itemId).map(line => line.quantity)) } };
      }));
    const cashId = draft.sessionId;
    const cashBytes = await this.db.getEncrypted(userId, 'cash-projection', cashId);
    if (!cashBytes) throw new Error('Efectivo local no disponible.');
    const cash = offlinePaymentSchema.shape.appliedAmount.parse(await this.read(userId, 'cash-projection', cashId));
    const cashValue = offlinePaymentSchema.shape.appliedAmount.parse(sumMoney([cash,
      ...payments.filter(payment => payment.method === 'CASH').map(payment => payment.appliedAmount)]));
    await this.sealer.seal({ operationId: draft.id, userId, sessionId: draft.sessionId, kind: 'sale-confirm', payload: sale,
      grant: authorized.grant, configVersion: draft.configurationVersion, occurredAt }, {
      stateWrites: [{ kind: 'sale', id: draft.id, value: sale },
        { kind: 'cash-projection', id: cashId, value: cashValue, replace: true },
        ...stocks.map(stock => ({ kind: 'stock-projection', id: stock.id, value: stock.value, replace: true }))],
      assertCanCommit: () => this.assertAuthorization(userId, authorized),
      assertBeforeCommit: async () => {
        if (!equalBytes(sessionBytes, await this.db.getEncrypted(userId, 'cash-session', draft.sessionId)) ||
          !(await this.db.meta.get('device-chain'))?.cashSessionOpen ||
          !equalBytes(cashBytes, await this.db.getEncrypted(userId, 'cash-projection', cashId))) {
          throw new Error('Estado local cambió. Reintentá la venta.');
        }
        for (const stock of stocks) if (!equalBytes(stock.bytes, await this.db.getEncrypted(userId, 'stock-projection', stock.id))) {
          throw new Error('Stock local cambió. Reintentá la venta.');
        }
      },
    });
    return result;
  }

  private async read(userId: string, kind: string, id: string): Promise<unknown> {
    const dek = this.keys.dekFor(userId);
    const record = await this.db.getEncrypted(userId, kind, id);
    if (!record) return undefined;
    const value: unknown = JSON.parse(new TextDecoder().decode(await this.cipher.decrypt(dek,
      { organizationId: this.db.organizationId, deviceId: this.db.deviceId, userId, kind, id }, record)));
    if (this.keys.dekFor(userId) !== dek) throw new Error('Offline identity changed.');
    return value;
  }

  private async assertAuthorization(userId: string, context: OfflineAuthorizationContext): Promise<void> {
    await this.authorization.assertUsable(userId, context);
    if (!equalBytes(context.authorizationBytes, await this.db.getEncrypted(userId, 'authorization', 'current'))) {
      throw new Error('La autorización offline cambió.');
    }
    this.keys.dekFor(userId);
  }
}
