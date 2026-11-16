import { formatQuantityForDisplay } from '@uconext/shared';

/** Display whole quantities without padding and fractions with two decimal places. */
export function formatStockQuantity(quantity: string): string {
  return formatQuantityForDisplay(quantity);
}
