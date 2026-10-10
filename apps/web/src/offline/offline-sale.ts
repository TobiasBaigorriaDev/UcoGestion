import { calculateSaleLine, calculatePercentageDiscount, Quantity, subtractMoney, sumMoney,
  validateFixedDiscount, validatePercentageDiscount, type OfflineBootstrapPayload, type OfflineGrantClaims } from '@uconext/shared';
import { offlineSaleLinesSchema, offlineDiscountSchema, offlineSaleQuoteSchema, offlineSaleResultSchema, type OfflineDiscountEvidence } from '@uconext/shared';
export { offlineSaleLinesSchema, offlineDiscountSchema, offlineSaleDraftInputSchema, offlineSaleDraftSchema, offlineSaleQuoteSchema, offlinePaymentSchema, offlineSaleConfirmSchema, offlineSaleResultSchema, offlineConfirmedSaleSchema } from '@uconext/shared';
type DiscountAuthority = Pick<OfflineGrantClaims, 'role' | 'permissions' | 'actorUserId' | 'grantId' | 'configurationVersion'>;
const moneySchema = offlineSaleResultSchema.shape.total;

/** The verified bootstrap contains only active items. Absence is a local denial,
 * including a deactivation learned through a newer synchronized snapshot. */
export function quoteOfflineSale(configuration: OfflineBootstrapPayload['configuration'], input: unknown,
  options?: { authority: DiscountAuthority; discount: unknown }) {
  const requested = offlineSaleLinesSchema.parse(input);
  const lines = requested.map(line => {
    const item = configuration.items.find(candidate => candidate.id === line.itemId);
    if (!item || item.price === null || item.priceVersion < 1) throw new Error('Ítem offline no disponible.');
    const quantity = Quantity.from(line.quantity, item.baseUnit).toString();
    const lineTotal = moneySchema.parse(calculateSaleLine(quantity, item.price));
    return { itemId: item.id, itemName: item.name, sku: item.sku, barcode: item.barcode,
      ...('category' in item ? { category: item.category === null ? null : { ...item.category } } : {}),
      type: item.type, baseUnit: item.baseUnit, trackInventory: item.trackInventory,
      quantity, unitPrice: item.price, priceVersion: item.priceVersion, lineTotal };
  });
  const subtotal = moneySchema.parse(sumMoney(lines.map(line => line.lineTotal)));
  let discount = '0.00';
  let discountEvidence: OfflineDiscountEvidence | null = null;
  if (options) {
    const { authority } = options;
    if (!['OWNER', 'ADMIN'].includes(authority.role) || !authority.permissions.canDiscount) {
      throw new Error('Descuento offline no autorizado.');
    }
    const requestedDiscount = offlineDiscountSchema.parse(options.discount);
    if (requestedDiscount.kind === 'PERCENTAGE' && validatePercentageDiscount(requestedDiscount.value) !== undefined) {
      discount = calculatePercentageDiscount(subtotal, requestedDiscount.value);
    } else if (requestedDiscount.kind === 'FIXED' && validateFixedDiscount(requestedDiscount.value, subtotal) !== undefined) {
      discount = sumMoney([requestedDiscount.value]);
    } else throw new Error('Descuento offline inválido.');
    discountEvidence = { actorUserId: authority.actorUserId, grantId: authority.grantId,
      configurationVersion: authority.configurationVersion, role: authority.role,
      permissions: { canDiscount: authority.permissions.canDiscount }, ...requestedDiscount, amount: discount };
  }
  return offlineSaleQuoteSchema.parse({ ...('schemaVersion' in configuration ? { schemaVersion: 2 } : {}),
    currency: configuration.currency, lines, subtotal, discount,
    discountEvidence, total: moneySchema.parse(subtractMoney(subtotal, discount)) });
}

