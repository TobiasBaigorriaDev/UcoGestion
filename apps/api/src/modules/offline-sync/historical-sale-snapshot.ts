import { arePaymentsValidForSale,calculatePercentageDiscount,calculateSaleLine,offlineConfigurationSchema,
  offlineConfirmedSaleSchema,Quantity,subtractMoney,sumMoney,validateFixedDiscount,validatePercentageDiscount } from '@uconext/shared';
import { z } from 'zod';
const saleSchema=z.object({quote:offlineConfirmedSaleSchema.shape.quote,payments:offlineConfirmedSaleSchema.shape.payments});
/** Only the server-retained signed version is consulted. Current masters may be
 * inactive or changed; they cannot redefine a sealed sale's business meaning. */
export function validateHistoricalSaleSnapshot(configuration:unknown,input:unknown):void {
  try {
    const snapshot=offlineConfigurationSchema.parse(configuration),sale=saleSchema.parse(input),quote=sale.quote;
    if (quote.currency!==snapshot.currency) throw new Error();
    for (const line of quote.lines) {
      const item=snapshot.items.find(row=>row.id===line.itemId);
      if (!item || line.itemName!==item.name || line.sku!==item.sku || line.barcode!==item.barcode ||
        line.type!==item.type || line.baseUnit!==item.baseUnit || line.trackInventory!==item.trackInventory ||
        line.unitPrice!==item.price || line.priceVersion!==item.priceVersion ||
        Quantity.from(line.quantity,item.baseUnit).toString()!==line.quantity ||
        line.lineTotal!==calculateSaleLine(line.quantity,line.unitPrice)) throw new Error();
    }
    const subtotal=sumMoney(quote.lines.map(line=>line.lineTotal));
    const evidence=quote.discountEvidence;
    let discount='0.00';
    if (evidence) {
      if (evidence.kind==='FIXED') {
        if (validateFixedDiscount(evidence.value,subtotal)===undefined) throw new Error();
        discount=sumMoney([evidence.value]);
      } else {
        if (validatePercentageDiscount(evidence.value)===undefined) throw new Error();
        discount=calculatePercentageDiscount(subtotal,evidence.value);
      }
      if (evidence.amount!==discount) throw new Error();
    }
    if (quote.subtotal!==subtotal || quote.discount!==discount || quote.total!==subtractMoney(subtotal,discount) ||
      !arePaymentsValidForSale(quote.total,sale.payments.map(row=>row.appliedAmount))) throw new Error();
    for (const payment of sale.payments) {
      if (!snapshot.paymentMethods.includes(payment.method) || (payment.method==='CASH' ?
        payment.receivedAmount===null || payment.changeAmount!==subtractMoney(payment.receivedAmount,payment.appliedAmount) :
        payment.receivedAmount!==null || payment.changeAmount!=='0.00')) throw new Error();
    }
  } catch {throw new Error('OFFLINE_SNAPSHOT_INVALID');}
}
