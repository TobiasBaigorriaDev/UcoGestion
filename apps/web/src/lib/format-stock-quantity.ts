import { formatQuantityForDisplay } from '@uconext/shared';

/** Display whole quantities without padding, fractions with two decimals and thousands grouped (22.000). */
export function formatStockQuantity(quantity: string): string {
  const [whole = '', fraction] = formatQuantityForDisplay(quantity).split(',');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return fraction === undefined ? grouped : `${grouped},${fraction}`;
}
