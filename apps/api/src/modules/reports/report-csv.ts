import type { ReportDataset, ReportItem } from './reports.service.js';

const columns: Record<ReportDataset, readonly string[]> = {
  sales: ['id', 'branchId', 'occurredAt', 'status', 'total', 'currencyCode',
    'actorUserId', 'cashSessionId'],
  inventory: ['id', 'branchId', 'itemId', 'name', 'quantity', 'minimum', 'lowStock'],
  'inventory-movements': ['id', 'branchId', 'itemId', 'itemName', 'actorUserId',
    'delta', 'sourceType', 'sourceId', 'effectKind', 'occurredAt'],
  cash: ['id', 'branchId', 'cashRegisterId', 'ownerUserId', 'status', 'origin',
    'openingCash', 'expectedCash', 'movementTotal', 'movementCount', 'currencyCode',
    'openedAt', 'countedCash', 'difference'],
  purchases: ['id', 'branchId', 'supplierId', 'actorUserId', 'status', 'total',
    'currencyCode', 'occurredAt'],
  expenses: ['id', 'branchId', 'categoryId', 'actorUserId', 'concept', 'amount',
    'method', 'currencyCode', 'status', 'occurredAt'],
};

export function csvCell(value: unknown): string {
  const raw = value === null || value === undefined ? '' : String(value);
  const safe = /^[\s]*[=+\-@]/u.test(raw) || /^[\t\r]/u.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function csvHeader(dataset: ReportDataset): string {
  return `${columns[dataset].map(csvCell).join(',')}\r\n`;
}

export function csvRow(dataset: ReportDataset, item: ReportItem): string {
  return `${columns[dataset].map((key) => csvCell(item[key])).join(',')}\r\n`;
}
