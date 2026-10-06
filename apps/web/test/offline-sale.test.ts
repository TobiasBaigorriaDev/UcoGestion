import { expect, it } from 'vitest';
import fc from 'fast-check';
import type { OfflineBootstrapPayload } from '@uconext/shared';
import { quoteOfflineSale } from '../src/offline/offline-sale';

const itemId = '11111111-1111-4111-8111-111111111111';
const item: OfflineBootstrapPayload['configuration']['items'][number] = { id: itemId, name: 'Producto', sku: 'P1', barcode: null,
  type: 'PRODUCT', baseUnit: 'UNIT', trackInventory: true, price: '1.25', priceVersion: 3 };
const configuration: OfflineBootstrapPayload['configuration'] = {
  currency: 'ARS', items: [item],
  categories: [], branches: [], cashRegisters: [], paymentMethods: ['CASH'],
};

it('T195 snapshots only synchronized prices and their verifiable version', () => {
  expect(quoteOfflineSale(configuration, [{ itemId, quantity: '2' }])).toMatchObject({
    currency: 'ARS', subtotal: '2.50', total: '2.50',
    lines: [{ itemId, itemName: 'Producto', quantity: '2', unitPrice: '1.25', priceVersion: 3, lineTotal: '2.50' }],
  });
  expect(() => quoteOfflineSale(configuration, [{ itemId, quantity: '1', unitPrice: '0.01' }])).toThrow();
  expect(() => quoteOfflineSale({ ...configuration, items: [] }, [{ itemId, quantity: '1' }])).toThrow();
  for (const unavailable of [{ ...item, price: null }, { ...item, priceVersion: 0 }]) {
    expect(() => quoteOfflineSale({ ...configuration, items: [unavailable] }, [{ itemId, quantity: '1' }])).toThrow();
  }
});

it('T195 validates units, quantity precision and numeric bounds', () => {
  for (const quantity of ['0', '-1', '1.5', '0.0001', '100000000000000000']) {
    expect(() => quoteOfflineSale(configuration, [{ itemId, quantity }])).toThrow();
  }
  const fractional = { ...configuration, items: configuration.items.map(item => ({ ...item, baseUnit: 'FRACTIONAL' as const })) };
  expect(quoteOfflineSale(fractional, [{ itemId, quantity: '0.004' }]).total).toBe('0.01');
  expect(() => quoteOfflineSale({ ...configuration, items: configuration.items.map(item => ({ ...item,
    price: '999999999999999999.99' })) }, [{ itemId, quantity: '2' }])).toThrow();
});

it('T195 preserves decimal line totals and subtotal invariants', () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 10000 }), quantity => {
    const quoted = quoteOfflineSale(configuration, [{ itemId, quantity: String(quantity) }]);
    const cents = BigInt(quantity) * 125n;
    expect(quoted.total).toBe(`${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`);
  }));
  fc.assert(fc.property(fc.bigInt({ min: 1000000000000000000n, max: 9000000000000000000n }),
    fc.integer({ min: 1, max: 1000 }), (priceCents, quantityMillis) => {
      const price = `${priceCents / 100n}.${(priceCents % 100n).toString().padStart(2, '0')}`;
      const millis = BigInt(quantityMillis);
      const quantity = `${millis / 1000n}.${(millis % 1000n).toString().padStart(3, '0')}`;
      const config = { ...configuration, items: [{ ...item, baseUnit: 'FRACTIONAL' as const, price }] };
      const expectedCents = (priceCents * BigInt(quantityMillis) + 500n) / 1000n;
      expect(quoteOfflineSale(config, [{ itemId, quantity }]).total).toBe(
        `${expectedCents / 100n}.${(expectedCents % 100n).toString().padStart(2, '0')}`);
    }));
});

it('T196 records global discount and authority from the current grant', () => {
  const authority = { actorUserId: itemId, grantId: itemId, configurationVersion: '7',
    role: 'ADMIN' as const, permissions: { canDiscount: true } };
  const quote = quoteOfflineSale(configuration, [{ itemId, quantity: '2' }], {
    authority, discount: { kind: 'PERCENTAGE', value: '10' },
  });
  expect(quote).toMatchObject({ subtotal: '2.50', discount: '0.25', total: '2.25', discountEvidence: {
    ...authority, kind: 'PERCENTAGE', value: '10', amount: '0.25',
  } });
  expect(quoteOfflineSale(configuration, [{ itemId, quantity: '2' }], {
    authority, discount: { kind: 'FIXED', value: '2.50' },
  }).total).toBe('0.00');
  for (const discount of [{ kind: 'FIXED', value: '-1.00' }, { kind: 'FIXED', value: '2.51' },
    { kind: 'PERCENTAGE', value: '101' }, { kind: 'FIXED', value: '0.001' }]) {
    expect(() => quoteOfflineSale(configuration, [{ itemId, quantity: '2' }], { authority, discount })).toThrow();
  }
  for (const denied of [{ ...authority, role: 'CASHIER' as const }, { ...authority, permissions: { canDiscount: false } }]) {
    expect(() => quoteOfflineSale(configuration, [{ itemId, quantity: '2' }], {
      authority: denied, discount: { kind: 'PERCENTAGE', value: '0' },
    })).toThrow();
  }
});
