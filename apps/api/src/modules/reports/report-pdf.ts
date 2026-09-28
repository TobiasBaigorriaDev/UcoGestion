import { createElement } from 'react';
import { Document, Page, Text, View, renderToBuffer } from '@react-pdf/renderer';

import type { ReportDataset, ReportItem } from './reports.service.js';

export async function renderReportPdf(dataset: ReportDataset,
  items: readonly ReportItem[]): Promise<Uint8Array> {
  const pages: ReportItem[][] = [];
  for (let index = 0; index < items.length; index += 25) {
    pages.push(items.slice(index, index + 25));
  }
  if (pages.length === 0) pages.push([]);
  const renderedPages = pages.map((pageItems, pageIndex) => {
    const renderedItems = pageItems.map((item) => {
      const line = Object.entries(item).map(([key, value]) =>
        `${key}: ${value === null ? '' : String(value)}`).join(' | ');
      return createElement(View, { key: `${item.branchId}:${item.id}`,
        style: { marginBottom: 10, paddingBottom: 6, borderBottomWidth: 1,
          borderBottomColor: '#dddddd' } }, createElement(Text, null, line));
    });
    return createElement(Page, { key: pageIndex, size: 'A4',
      style: { padding: 36, fontSize: 9 } },
    createElement(Text, { style: { fontSize: 16, marginBottom: 16 } }, `Reporte: ${dataset}`),
    ...renderedItems);
  });
  const document = createElement(Document, null, ...renderedPages);
  return new Uint8Array(await renderToBuffer(document));
}
