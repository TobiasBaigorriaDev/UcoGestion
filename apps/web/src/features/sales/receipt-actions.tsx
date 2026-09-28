'use client';

import { useState } from 'react';

import { ErrorSummary } from '../../components/error-summary';
import { ApiProblemError } from '../../lib/api/client';
import { problemFromResponse } from '../../lib/api/problem-details';
import styles from './pos.module.css';

async function receiptBlob(organizationId: string, saleId: string,
  kind: 'print' | 'pdf'): Promise<Blob> {
  const suffix = kind === 'pdf' ? 'receipt.pdf' : 'receipt/print';
  let response: Response;
  try {
    response = await fetch(`/api/v1/sales/${encodeURIComponent(saleId)}/${suffix}`, {
      method: 'GET', credentials: 'include', cache: 'no-store',
      headers: { 'X-Organization-Id': organizationId,
        Accept: kind === 'pdf' ? 'application/pdf' : 'text/html' },
    });
  } catch {
    throw new ApiProblemError({ status: 0, code: 'RECEIPT_NETWORK_ERROR',
      message: 'No pudimos cargar el comprobante. Revisá la conexión y reintentá.' });
  }
  if (!response.ok) throw await problemFromResponse(response);
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.includes(kind === 'pdf' ? 'application/pdf' : 'text/html')) {
    throw new ApiProblemError({ status: response.status, code: 'RECEIPT_INVALID_RESPONSE',
      message: 'El comprobante no pudo procesarse. Reintentá la descarga.' });
  }
  return response.blob();
}

export function ReceiptActions({ organizationId, saleId }: {
  organizationId: string; saleId: string;
}) {
  const [error, setError] = useState<ApiProblemError | null>(null);
  const [busy, setBusy] = useState<'pdf' | 'print' | null>(null);
  const failure = (cause: unknown) => cause instanceof ApiProblemError ? cause
    : new ApiProblemError({ status: 0, code: 'RECEIPT_FAILED',
      message: 'No pudimos abrir el comprobante. La venta sigue confirmada; reintentá.' });
  async function download() {
    setBusy('pdf'); setError(null);
    try {
      const blob = await receiptBlob(organizationId, saleId, 'pdf');
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url; anchor.download = `comprobante-${saleId}.pdf`;
      document.body.append(anchor); anchor.click(); anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (cause) { setError(failure(cause)); }
    finally { setBusy(null); }
  }
  async function printable() {
    const tab = window.open('', '_blank');
    if (!tab) {
      setError(new ApiProblemError({ status: 0, code: 'PRINT_WINDOW_BLOCKED',
        message: 'El navegador bloqueó la ventana. Permití ventanas emergentes o descargá el PDF.' }));
      return;
    }
    setBusy('print'); setError(null);
    try {
      const blob = await receiptBlob(organizationId, saleId, 'print');
      const url = URL.createObjectURL(blob);
      tab.location.href = url;
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (cause) { tab.close(); setError(failure(cause)); }
    finally { setBusy(null); }
  }
  return <div className={styles.receiptActions} aria-label="Comprobante de venta">
    <button type="button" disabled={busy !== null} onClick={() => void printable()}>
      {busy === 'print' ? 'Abriendo…' : 'Ver para imprimir'}</button>
    <button type="button" disabled={busy !== null} onClick={() => void download()}>
      {busy === 'pdf' ? 'Descargando…' : 'Descargar PDF'}</button>
    {error ? <><ErrorSummary error={error} /><p>La venta sigue confirmada. Podés reintentar estas acciones.</p></> : null}
  </div>;
}
