export type PosPayment = { method: string; appliedAmount: string; receivedAmount?: string | undefined };

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
