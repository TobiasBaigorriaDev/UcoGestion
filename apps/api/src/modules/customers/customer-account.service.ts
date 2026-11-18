import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { subtractMoney, sumMoney } from '@uconext/shared';
import { z } from 'zod';
import { AuditEventWriter } from '../../core/audit/audit-event-writer.js';
import { IdempotencyService, toJsonValue } from '../../core/idempotency/idempotency.service.js';
import { encodeCursor, type Cursor } from '../../core/validation/pagination.js';
import { TenantTransaction, type TenantTransactionContext } from '../../database/tenant-transaction.js';
import { CashSessionDevicePolicy, recordCustomerCollectionCash } from '../cash/index.js';

export const accountMoneySchema = z.string().regex(/^(?:0|[1-9]\d{0,17})\.\d{2}$/);
const summarySchema = z.object({ balance: accountMoneySchema, creditLimit: accountMoneySchema,
  available: accountMoneySchema, version: z.number().int().positive(), currency: z.string() });
const operationSchema = z.object({ id: z.uuid(), balance: accountMoneySchema, currency: z.string() });
type AccountSummary = z.infer<typeof summarySchema>;
type AccountOperation = z.infer<typeof operationSchema>;
interface AccountRow { balance: string; creditLimit: string; version: number }
export interface AccountEntry {
  id: string; branchId: string; kind: 'SALE' | 'COLLECTION' | 'SALE_CANCELLATION' | 'COLLECTION_REVERSAL';
  amount: string; delta: string; currency: string; method: string | null; saleId: string | null;
  originalEntryId: string | null; reason: string | null; occurredAt: string; reversed: boolean;
}
export interface CollectionInput { cashSessionId: string; deviceId: string; amount: string; method: string }
interface ChargeInput { customerId: string; amount: string; saleId: string; branchId: string;
  cashSessionId: string; deviceId: string; currency: string }

export class CustomerAccountError extends Error {
  constructor(readonly code: 'CUSTOMER_ACCOUNT_FORBIDDEN' | 'CUSTOMER_ACCOUNT_NOT_FOUND' |
    'CUSTOMER_ACCOUNT_AMOUNT_INVALID' | 'CUSTOMER_ACCOUNT_LIMIT_EXCEEDED' |
    'CUSTOMER_ACCOUNT_LIMIT_BELOW_BALANCE' | 'CUSTOMER_ACCOUNT_PAYMENT_DISABLED' |
    'CUSTOMER_ACCOUNT_ALREADY_REVERSED' | 'CUSTOMER_ACCOUNT_CANCELLATION_REQUIRES_REVERSAL' |
    'CUSTOMER_ACCOUNT_CUSTOMER_INACTIVE' | 'VERSION_CONFLICT' | 'CUSTOMER_ACCOUNT_RETRY_REQUIRED', message: string) {
    super(message); this.name = 'CustomerAccountError';
  }
}
const greater = (left: string, right: string) => subtractMoney(right, left).startsWith('-');

export class CustomerAccountService {
  /** Transaction-only sales ports can operate without owning a pool/runner. */
  constructor(private readonly transactionRunner?: TenantTransaction) {}
  private get transactions(): TenantTransaction {
    if (!this.transactionRunner) throw new Error('This operation requires an account transaction runner');
    return this.transactionRunner;
  }

  async read(context: TenantTransactionContext, customerId: string,
    query: { branchId?: string | undefined; cursor?: Cursor | undefined; limit?: number | undefined }) {
    return this.transactions.read(context, async client => {
      await this.authorize(client, context);
      const customer = await client.query('SELECT 1 FROM customers WHERE organization_id=$1 AND id=$2', [context.organizationId, customerId]);
      if (!customer.rowCount) throw new CustomerAccountError('CUSTOMER_ACCOUNT_NOT_FOUND', 'Cliente no encontrado.');
      const limit = query.limit ?? 25;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new CustomerAccountError('CUSTOMER_ACCOUNT_AMOUNT_INVALID', 'Paginación inválida.');
      const entries = await client.query<AccountEntry>(`SELECT e.id,e.branch_id AS "branchId",e.kind,e.amount::text,e.delta::text,
        e.currency_code AS currency,e.method,e.sale_id AS "saleId",e.original_entry_id AS "originalEntryId",e.reason,
        to_char(e.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "occurredAt",
        EXISTS (SELECT 1 FROM customer_account_entries r WHERE r.organization_id=e.organization_id AND r.original_entry_id=e.id) AS reversed
        FROM customer_account_entries e JOIN memberships m ON m.organization_id=e.organization_id AND m.user_id=$2
        WHERE e.organization_id=$1 AND e.customer_id=$3 AND m.status='ACTIVE' AND m.revoked_at IS NULL
          AND m.role IN ('OWNER','ADMIN','CASHIER')
          AND (m.role='OWNER' OR EXISTS (SELECT 1 FROM effective_membership_branch_scope scope
            WHERE scope.organization_id=m.organization_id AND scope.membership_id=m.id AND scope.branch_id=e.branch_id))
          AND ($4::uuid IS NULL OR e.branch_id=$4)
          AND ($5::timestamptz IS NULL OR (e.occurred_at,e.id)<($5::timestamptz,$6::uuid))
        ORDER BY e.occurred_at DESC,e.id DESC LIMIT $7`,
      [context.organizationId, context.userId, customerId, query.branchId ?? null, query.cursor?.sortValue ?? null, query.cursor?.id ?? null, limit + 1]);
      const items = entries.rows.slice(0, limit); const last = items.at(-1);
      return { ...await this.summary(client, context, customerId), entries: items,
        nextCursor: entries.rows.length > limit && last ? encodeCursor({ id: last.id, sortValue: last.occurredAt }) : null };
    });
  }

  async setLimit(context: TenantTransactionContext, customerId: string, version: number,
    creditLimit: string, key: string): Promise<AccountSummary> {
    this.money(creditLimit, false);
    return this.mutate(context, customerId, 'limit', { version, creditLimit }, key,
      client => this.authorize(client, context, true), async client => {
        const account = await this.lock(client, context, customerId);
        if (account.version !== version) throw new CustomerAccountError('VERSION_CONFLICT', 'La cuenta cambió. Volvé a cargarla antes de guardar el tope.');
        if (greater(account.balance, creditLimit)) throw new CustomerAccountError('CUSTOMER_ACCOUNT_LIMIT_BELOW_BALANCE', 'El tope no puede ser menor que la deuda actual.');
        await client.query('UPDATE customer_accounts SET credit_limit=$3,version=version+1 WHERE organization_id=$1 AND customer_id=$2', [context.organizationId, customerId, creditLimit]);
        await this.audit(client, context, customerId, 'limit.changed', randomUUID(), null,
          { creditLimit }, { creditLimit: account.creditLimit });
        return this.summary(client, context, customerId);
      }, value => summarySchema.parse(value));
  }

  async collect(context: TenantTransactionContext, customerId: string, input: CollectionInput, key: string): Promise<AccountOperation> {
    this.money(input.amount, true);
    const authorize = async (client: PoolClient) => {
      await this.authorize(client, context);
      await new CashSessionDevicePolicy().requireAuthorizedActor(client, context, input.cashSessionId, input.deviceId, true);
    };
    return this.mutate(context, customerId, 'collect', input, key, authorize, async client => {
      const session = await new CashSessionDevicePolicy().requireAuthorizedActor(client, context, input.cashSessionId, input.deviceId);
      const account = await this.lock(client, context, customerId);
      if (greater(input.amount, account.balance)) throw new CustomerAccountError('CUSTOMER_ACCOUNT_AMOUNT_INVALID', 'El cobro no puede superar la deuda actual.');
      const method = await client.query<{ enabled: boolean }>('SELECT enabled FROM payment_method_settings WHERE organization_id=$1 AND method=$2 FOR SHARE', [context.organizationId, input.method]);
      if (!method.rows[0]?.enabled) throw new CustomerAccountError('CUSTOMER_ACCOUNT_PAYMENT_DISABLED', 'Elegí un medio de pago habilitado.');
      const currency = await this.currency(client, context); const id = randomUUID();
      await this.entry(client, context, { id, customerId, branchId: session.branchId, cashSessionId: input.cashSessionId,
        deviceId: input.deviceId, amount: input.amount, currency, kind: 'COLLECTION', method: input.method });
      if (input.method === 'CASH') await recordCustomerCollectionCash(client, context, { ...input, currency, entryId: id, reversal: false });
      await this.audit(client, context, customerId, 'collected', id, session.branchId, { amount: input.amount, method: input.method });
      return { id, balance: subtractMoney(account.balance, input.amount), currency };
    }, value => operationSchema.parse(value));
  }

  async reverseCollection(context: TenantTransactionContext, customerId: string, entryId: string,
    input: { cashSessionId: string; deviceId: string; reason: string }, key: string): Promise<AccountOperation> {
    const reason = input.reason.trim();
    if (!reason || reason.length > 500) throw new CustomerAccountError('CUSTOMER_ACCOUNT_AMOUNT_INVALID', 'Ingresá un motivo de hasta 500 caracteres.');
    const authorize = async (client: PoolClient) => {
      await this.authorize(client, context, true);
      await new CashSessionDevicePolicy().requireAuthorizedActor(client, context, input.cashSessionId, input.deviceId, true);
    };
    return this.mutate(context, customerId, 'reverse', { entryId, ...input }, key, authorize, async client => {
      const session = await new CashSessionDevicePolicy().requireAuthorizedActor(client, context, input.cashSessionId, input.deviceId);
      const account = await this.lock(client, context, customerId);
      const original = await client.query<{ amount: string; method: string; branchId: string; currency: string }>(`SELECT amount::text,method,branch_id AS "branchId",currency_code AS currency FROM customer_account_entries
        WHERE organization_id=$1 AND customer_id=$2 AND id=$3 AND kind='COLLECTION'`, [context.organizationId, customerId, entryId]);
      const collection = original.rows[0];
      if (!collection || collection.branchId !== session.branchId) throw new CustomerAccountError('CUSTOMER_ACCOUNT_NOT_FOUND', 'El cobro no está disponible en esta sucursal.');
      const reversed = await client.query('SELECT 1 FROM customer_account_entries WHERE organization_id=$1 AND original_entry_id=$2', [context.organizationId, entryId]);
      if (reversed.rowCount) throw new CustomerAccountError('CUSTOMER_ACCOUNT_ALREADY_REVERSED', 'El cobro ya fue revertido.');
      const id = randomUUID();
      await this.entry(client, context, { id, customerId, ...input, branchId: collection.branchId,
        amount: collection.amount, currency: collection.currency, kind: 'COLLECTION_REVERSAL', method: collection.method, originalEntryId: entryId, reason });
      if (collection.method === 'CASH') await recordCustomerCollectionCash(client, context, { ...input, amount: collection.amount, currency: collection.currency, entryId: id, reversal: true });
      await this.audit(client, context, customerId, 'collection.reversed', id, collection.branchId, { amount: collection.amount, originalEntryId: entryId });
      return { id, balance: sumMoney([account.balance, collection.amount]), currency: collection.currency };
    }, value => operationSchema.parse(value));
  }

  /** Public sales port. Session must already be locked by sales before locking the account. */
  async prepareCharge(client: PoolClient, context: TenantTransactionContext, customerId: string, amount: string) {
    this.money(amount, true);
    const account = await this.lock(client, context, customerId, true);
    if (greater(sumMoney([account.balance, amount]), account.creditLimit)) {
      throw new CustomerAccountError('CUSTOMER_ACCOUNT_LIMIT_EXCEEDED', 'La compra supera el tope del cliente. Cobrá una parte o pedí al dueño/administrador que modifique el tope.');
    }
  }
  async recordCharge(client: PoolClient, context: TenantTransactionContext, input: ChargeInput) {
    const id = randomUUID();
    await this.entry(client, context, { ...input, id, kind: 'SALE' });
    await this.audit(client, context, input.customerId, 'charged', id, input.branchId, { amount: input.amount, saleId: input.saleId });
  }
  async cancelCharge(client: PoolClient, context: TenantTransactionContext, saleId: string) {
    const result = await client.query<{ id: string; customerId: string; amount: string; branchId: string; cashSessionId: string; deviceId: string; currency: string }>(`SELECT id,customer_id AS "customerId",amount::text,branch_id AS "branchId",cash_session_id AS "cashSessionId",device_id AS "deviceId",currency_code AS currency
      FROM customer_account_entries WHERE organization_id=$1 AND sale_id=$2 AND kind='SALE'`, [context.organizationId, saleId]);
    const charge = result.rows[0]; if (!charge) return;
    const account = await this.lock(client, context, charge.customerId);
    if (greater(charge.amount, account.balance)) throw new CustomerAccountError('CUSTOMER_ACCOUNT_CANCELLATION_REQUIRES_REVERSAL', 'La venta ya tiene cobros posteriores. Revertí los cobros necesarios desde Clientes antes de anularla.');
    const id = randomUUID();
    await this.entry(client, context, { ...charge, id, saleId, originalEntryId: charge.id, kind: 'SALE_CANCELLATION' });
    await this.audit(client, context, charge.customerId, 'charge.cancelled', id, charge.branchId, { amount: charge.amount, saleId });
  }

  private async authorize(client: PoolClient, context: TenantTransactionContext, manage = false) {
    const result = await client.query<{ role: string }>('SELECT role FROM memberships WHERE organization_id=$1 AND user_id=$2 AND status=\'ACTIVE\' AND revoked_at IS NULL', [context.organizationId, context.userId]);
    if (!result.rows[0] || !(manage ? ['OWNER','ADMIN'] : ['OWNER','ADMIN','CASHIER']).includes(result.rows[0].role)) {
      throw new CustomerAccountError('CUSTOMER_ACCOUNT_FORBIDDEN', 'Tu rol no puede realizar esta operación de cuenta corriente.');
    }
  }
  private async lock(client: PoolClient, context: TenantTransactionContext, customerId: string, active = false): Promise<AccountRow> {
    const customer = await client.query<{ status: string }>('SELECT status FROM customers WHERE organization_id=$1 AND id=$2 FOR UPDATE', [context.organizationId, customerId]);
    if (!customer.rows[0]) throw new CustomerAccountError('CUSTOMER_ACCOUNT_NOT_FOUND', 'Cliente no encontrado.');
    if (active && customer.rows[0].status !== 'ACTIVE') throw new CustomerAccountError('CUSTOMER_ACCOUNT_CUSTOMER_INACTIVE', 'El cliente está inactivo.');
    await client.query('INSERT INTO customer_accounts (organization_id,customer_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [context.organizationId, customerId]);
    const result = await client.query<AccountRow>('SELECT balance::text,credit_limit::text AS "creditLimit",version::int FROM customer_accounts WHERE organization_id=$1 AND customer_id=$2 FOR UPDATE', [context.organizationId, customerId]);
    const row = result.rows[0]; if (!row) throw new Error('Account lock missing'); return row;
  }
  private async currency(client: PoolClient, context: TenantTransactionContext) {
    const result = await client.query<{ currency: string }>('SELECT base_currency AS currency FROM organizations WHERE id=$1', [context.organizationId]);
    const currency = result.rows[0]?.currency; if (!currency) throw new CustomerAccountError('CUSTOMER_ACCOUNT_NOT_FOUND', 'Organización no disponible.'); return currency;
  }
  private async summary(client: PoolClient, context: TenantTransactionContext, customerId: string): Promise<AccountSummary> {
    const result = await client.query<AccountRow>('SELECT balance::text,credit_limit::text AS "creditLimit",version::int FROM customer_accounts WHERE organization_id=$1 AND customer_id=$2', [context.organizationId, customerId]);
    const account = result.rows[0] ?? { balance: '0.00', creditLimit: '0.00', version: 1 };
    return { ...account, available: greater(account.balance, account.creditLimit) ? '0.00' : subtractMoney(account.creditLimit, account.balance), currency: await this.currency(client, context) };
  }
  private money(value: string, positive: boolean) {
    if (!accountMoneySchema.safeParse(value).success || (positive && value === '0.00')) throw new CustomerAccountError('CUSTOMER_ACCOUNT_AMOUNT_INVALID', 'Ingresá un importe válido con dos decimales.');
  }
  private async entry(client: PoolClient, context: TenantTransactionContext,
    input: { id: string; customerId: string; branchId: string; cashSessionId: string; deviceId: string; amount: string;
      currency: string; kind: AccountEntry['kind']; method?: string; saleId?: string; originalEntryId?: string; reason?: string }) {
    const negative = ['COLLECTION','SALE_CANCELLATION'].includes(input.kind);
    await client.query(`INSERT INTO customer_account_entries (id,organization_id,customer_id,branch_id,cash_session_id,device_id,actor_user_id,
      kind,amount,delta,currency_code,method,sale_id,original_entry_id,reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9::numeric * $10,$11,$12,$13,$14,$15)`,
    [input.id, context.organizationId, input.customerId, input.branchId, input.cashSessionId, input.deviceId, context.userId,
      input.kind, input.amount, negative ? -1 : 1, input.currency, input.method ?? null, input.saleId ?? null, input.originalEntryId ?? null, input.reason ?? null]);
  }
  private async audit(client: PoolClient, context: TenantTransactionContext, customerId: string, action: string,
    operationId: string, branchId: string | null, after: Record<string, string>, before: Record<string, string> = {}) {
    await new AuditEventWriter(client).append({ organizationId: context.organizationId, actorUserId: context.userId,
      requestId: context.requestId, entityType: 'customer', entityId: customerId, action: `customer.account.${action}`,
      operationId, branchId, after, afterAllowlist: Object.keys(after), before, beforeAllowlist: Object.keys(before), context: {}, contextAllowlist: [] });
  }
  private async mutate<T>(context: TenantTransactionContext, customerId: string, scope: string, payload: object,
    key: string, authorize: (client: PoolClient) => Promise<void>, operation: (client: PoolClient) => Promise<T>, decode: (value: unknown) => T): Promise<T> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await this.transactions.runWithOptionalAudit(context, async client => {
          await authorize(client);
          const idempotency = new IdempotencyService(client);
          const acquired = await idempotency.acquire({ organizationId: context.organizationId, actorUserId: context.userId,
            authorizationClass: `CUSTOMER_ACCOUNT_${scope.toUpperCase()}`, branchId: null, scope: `customer.account.${scope}`, key, payload: toJsonValue({ customerId, ...payload }) }, () => authorize(client));
          if (acquired.kind === 'replay') return { result: decode(acquired.response.body) };
          const result = await operation(client);
          await idempotency.complete(acquired.record.id, { statusCode: 200, body: toJsonValue(result) });
          return { result };
        });
      } catch (error) {
        const code = error instanceof Object && 'code' in error ? error.code : undefined;
        if (!['40P01','40001'].includes(String(code))) throw error;
        if (attempt === 3) throw new CustomerAccountError('CUSTOMER_ACCOUNT_RETRY_REQUIRED', 'La cuenta recibió cambios simultáneos. Reintentá la operación.');
      }
    }
    throw new Error('Unreachable account retry');
  }
}
