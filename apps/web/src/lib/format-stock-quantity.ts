/** Format canonical decimal quantities without losing precision or actual fractions. */
export function formatStockQuantity(quantity: string): string {
  const [integer, fraction = ''] = quantity.split('.');
  const significantFraction = fraction.replace(/0+$/, '');
  return significantFraction ? `${integer},${significantFraction}` : (integer ?? quantity);
}
