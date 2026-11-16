import { describe, expect, it } from 'vitest';

import { formatMoney, paymentMethodLabel, roleLabel } from '../src/lib/format';
import { formatStockQuantity } from '../src/lib/format-stock-quantity';

describe('D08 interface formatting', () => {
  it('shows money in the Argentine format with the currency symbol', () => {
    expect(formatMoney('1800.00')).toBe('$ 1.800,00');
    expect(formatMoney('4500.00', 'ARS')).toBe('$ 4.500,00');
    expect(formatMoney('10.00', 'USD')).toBe('US$ 10,00');
  });

  it('groups thousands in displayed quantities without changing fractional rounding', () => {
    expect(formatStockQuantity('22000.000')).toBe('22.000');
    expect(formatStockQuantity('17.000')).toBe('17');
    expect(formatStockQuantity('1234.500')).toBe('1.234,50');
    expect(formatStockQuantity('-1.000')).toBe('-1');
  });

  it('names roles and payment methods in shop language instead of internal codes', () => {
    expect(['OWNER', 'ADMIN', 'CASHIER', 'EMPLOYEE'].map(roleLabel)).toEqual(['Dueño', 'Administrador', 'Cajero', 'Empleado']);
    expect(['CASH', 'DEBIT_CARD', 'CREDIT_CARD', 'TRANSFER', 'QR'].map(paymentMethodLabel))
      .toEqual(['Efectivo', 'Débito', 'Crédito', 'Transferencia', 'QR']);
    expect(paymentMethodLabel('UNKNOWN')).toBe('UNKNOWN');
  });
});
