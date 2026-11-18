import { calculateSaleSettlement } from '@uconext/shared';

export type PosPayment = { method: string; appliedAmount: string; receivedAmount?: string | undefined };

/**
 * Reads a typed amount as a cashier writes it in Argentina ("5000", "5.000", "5.000,50", "25.50")
 * and returns the canonical API decimal ("5000.50"), or null when it is not an unambiguous amount.
 * Works on the string only; no floating point.
 */
export function parseMoneyInput(text: string): string | null {
  const value = text.trim();
  let whole: string | undefined;
  let fraction = '';
  let match: RegExpExecArray | null;
  if ((match = /^(\d{1,3}(?:\.\d{3})+|\d+),(\d{1,2})$/.exec(value))) [, whole = '', fraction = ''] = match;
  else if ((match = /^(\d{1,3}(?:\.\d{3})+)$/.exec(value))) [, whole = ''] = match;
  else if ((match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value))) [, whole = '', fraction = ''] = match;
  if (whole === undefined) return null;
  return `${BigInt(whole.replaceAll('.', '')).toString()}.${fraction.padEnd(2, '0')}`;
}

export function normalizePayments(payments: readonly PosPayment[]): PosPayment[] {
  return payments.map(payment => ({
    method: payment.method,
    appliedAmount: parseMoneyInput(payment.appliedAmount) ?? payment.appliedAmount,
    ...(payment.receivedAmount !== undefined
      ? { receivedAmount: parseMoneyInput(payment.receivedAmount) ?? payment.receivedAmount } : {}),
  }));
}

export function accountPaymentBalance(total: string, payments: readonly PosPayment[]) {
  try {
    const settlement = calculateSaleSettlement(total, payments.map(payment => payment.appliedAmount), true);
    return { ...paymentBalance(settlement.paidAmount, payments), deferred: settlement.onAccountAmount };
  } catch { return { valid: false, change: '0.00', deferred: '0.00', reason: 'Revisá los pagos: no pueden superar el total ni tener importes inválidos.' }; }
}

function cents(value: string): bigint | null {
  if (!/^(?:0|[1-9]\d{0,17})\.\d{2}$/.test(value)) return null;
  const [whole, fraction] = value.split('.');
  if (!whole || !fraction) return null;
  return BigInt(whole) * 100n + BigInt(fraction);
}

function money(value: bigint): string {
  return `${value / 100n}.${(value % 100n).toString().padStart(2, '0')}`;
}

export function paymentBalance(total: string, payments: readonly PosPayment[]): {
  valid: boolean; change: string; reason?: string;
} {
  const expected = cents(total);
  if (expected === null) return { valid: false, change: '0.00', reason: 'El total no es válido.' };
  if (expected === 0n) return payments.length === 0
    ? { valid: true, change: '0.00' }
    : { valid: false, change: '0.00', reason: 'Una venta sin cargo no lleva pagos.' };
  if (!payments.length) return { valid: false, change: '0.00', reason: 'Agregá al menos un pago.' };
  let applied = 0n;
  let change = 0n;
  for (const payment of payments) {
    const amount = cents(payment.appliedAmount);
    if (amount === null || amount <= 0n) return { valid: false, change: '0.00',
      reason: 'Cada pago aplicado debe ser mayor que cero.' };
    applied += amount;
    if (payment.method === 'CASH') {
      const received = cents(payment.receivedAmount ?? payment.appliedAmount);
      if (received === null || received < amount) return { valid: false, change: '0.00',
        reason: 'El efectivo recibido debe cubrir el importe aplicado.' };
      change += received - amount;
    } else if (payment.receivedAmount !== undefined) return { valid: false,
      change: '0.00', reason: 'Solo el efectivo admite importe recibido.' };
  }
  if (applied !== expected) return { valid: false, change: money(change),
    reason: 'La suma de pagos aplicados debe coincidir con el total.' };
  return { valid: true, change: money(change) };
}
