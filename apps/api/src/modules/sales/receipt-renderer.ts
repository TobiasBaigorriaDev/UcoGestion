import { PDFDocument, StandardFonts } from 'pdf-lib';

import type { SaleConfirmationResult } from './sales-operations.service.js';

type Receipt = SaleConfirmationResult['receipt'];
const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
const field = (value: unknown): string => typeof value === 'string' ? value : '';
const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (character) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);

export const receiptLines = (receipt: Receipt): string[] => {
  const organization = record(receipt.organization);
  const branch = record(receipt.branch);
  const customer = record(receipt.customer);
  const items = Array.isArray(receipt.items) ? receipt.items : [];
  const payments = Array.isArray(receipt.payments) ? receipt.payments : [];
  return [field(receipt.label), field(organization.name), field(branch.name),
    ...(customer.name ? [`Cliente: ${field(customer.name)}`] : []),
    ...items.map((value) => { const item = record(value);
      return `${field(item.name)} | ${field(item.quantity)} ${field(item.unit)} | ${field(item.lineTotal)}`; }),
    `Subtotal: ${field(receipt.subtotal)} ${field(receipt.currency)}`,
    `Descuento: ${field(receipt.discount)} ${field(receipt.currency)}`,
    `Total: ${field(receipt.total)} ${field(receipt.currency)}`,
    ...payments.map((value) => { const payment = record(value);
      return `${field(payment.method)}: ${field(payment.appliedAmount)}`; })];
};

export const renderReceiptHtml = (receipt: Receipt): string => {
  const lines = receiptLines(receipt).map((line) => `<p>${escapeHtml(line)}</p>`).join('\n');
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Comprobante no fiscal</title>
<style>body{font:16px system-ui,sans-serif;max-width:42rem;margin:2rem auto;padding:0 1rem;color:#111}
p{border-bottom:1px solid #ddd;padding:.35rem 0}@media print{body{margin:0;max-width:none}}</style>
</head><body><main>${lines}</main></body></html>`;
};

export const renderReceiptPdf = async (receipt: Receipt): Promise<Uint8Array> => {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  let page = pdf.addPage([595, 842]);
  let y = 800;
  for (const text of receiptLines(receipt)) {
    let remaining = text.replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
    do {
      if (y < 48) { page = pdf.addPage([595, 842]); y = 800; }
      let length = remaining.length;
      while (length > 1 && font.widthOfTextAtSize(remaining.slice(0, length), 11) > 515) length -= 1;
      page.drawText(remaining.slice(0, length), { x: 40, y, size: 11, font });
      remaining = remaining.slice(length);
      y -= 20;
    } while (remaining.length > 0);
  }
  return pdf.save();
};
