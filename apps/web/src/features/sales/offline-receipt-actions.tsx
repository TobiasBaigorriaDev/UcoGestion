'use client';

import { useEffect, useRef, useState } from 'react';
import { saleCodeFromId } from '@uconext/shared';
import type { OfflineReceipt } from '../../offline/offline-pos-actions';
import styles from './pos.module.css';

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);

export function offlineReceiptLines(receipt: OfflineReceipt): string[] {
  return [receipt.label, `ID de venta: ${saleCodeFromId(receipt.saleId)}`,
    'Confirmada sin conexión · Pendiente de sincronización', receipt.branchName,
    `Referencia local: ${receipt.localReference}`, 'Consumidor final',
    ...receipt.items.map(item => `${item.itemName} | ${item.quantity} ${item.baseUnit} | ${item.lineTotal}`),
    `Subtotal: ${receipt.subtotal} ${receipt.currency}`, `Descuento: ${receipt.discount} ${receipt.currency}`,
    `Total: ${receipt.total} ${receipt.currency}`,
    ...receipt.payments.map(payment => `${payment.method}: ${payment.appliedAmount} · Vuelto: ${payment.changeAmount}`),
    'Podés consultar esta venta online con este ID cuando se sincronice.'];
}

export function offlineReceiptHtml(receipt: OfflineReceipt): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Comprobante no fiscal</title>
<style>body{font:16px system-ui,sans-serif;max-width:42rem;margin:2rem auto;padding:0 1rem;color:#111}p{overflow-wrap:anywhere}@media print{body{margin:0;max-width:none}}</style>
</head><body><main>${offlineReceiptLines(receipt).map(line => `<p>${escapeHtml(line)}</p>`).join('\n')}</main></body></html>`;
}

export function OfflineReceiptActions({ receipt }: { receipt: OfflineReceipt }) {
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState('');
  const urls = useRef(new Set<string>());
  const tabs = useRef(new Set<Window>());
  useEffect(() => {
    const ownedUrls = urls.current;
    const ownedTabs = tabs.current;
    // Revoke downloads/print views when the owning presentation is retired.
    return () => { ownedTabs.forEach(tab => tab.close()); ownedTabs.clear(); ownedUrls.forEach(url => URL.revokeObjectURL(url)); ownedUrls.clear(); };
  }, [receipt.saleId]);
  function artifact(print: boolean) {
    setError('');
    let tab: Window | null = null;
    try {
      if (print) { tab = window.open('', '_blank'); if (!tab) throw new Error('popup'); }
      const url = URL.createObjectURL(new Blob([offlineReceiptHtml(receipt)], { type: 'text/html;charset=utf-8' }));
      urls.current.add(url);
      if (tab) { tabs.current.add(tab); tab.opener = null; tab.location.href = url; }
      else {
        const anchor = document.createElement('a'); anchor.href = url; anchor.download = `comprobante-${saleCodeFromId(receipt.saleId)}.html`;
        document.body.append(anchor); anchor.click(); anchor.remove();
      }
      window.setTimeout(() => { URL.revokeObjectURL(url); urls.current.delete(url); }, 60_000);
    } catch {
      tab?.close(); setError('No pudimos abrir el comprobante. Permití ventanas emergentes o reintentá la descarga. La venta sigue confirmada.');
    }
  }
  return <div className={styles.receiptActions}>
    <button type="button" onClick={() => setVisible(current => !current)}>{visible ? 'Ocultar comprobante local' : 'Ver comprobante local'}</button>
    <button type="button" onClick={() => artifact(true)}>Ver comprobante local para imprimir</button>
    <button type="button" onClick={() => artifact(false)}>Descargar comprobante local</button>
    {error ? <p role="alert">{error}</p> : null}
    {visible ? <section aria-label="Comprobante no fiscal local">{offlineReceiptLines(receipt).map((line, index) => <p key={index}>{line}</p>)}</section> : null}
  </div>;
}
