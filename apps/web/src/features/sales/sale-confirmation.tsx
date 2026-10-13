'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { saleCodeFromId } from '@uconext/shared';
import styles from './pos.module.css';

export function SaleConfirmation({ saleId, total, pendingSync = false, children }: {
  saleId: string; total: string; pendingSync?: boolean; children?: ReactNode;
}) {
  const [feedback, setFeedback] = useState<{ saleId: string; message: string } | null>(null);
  const saleCode = saleCodeFromId(saleId);
  const confirmation = useRef<HTMLElement>(null);
  useEffect(() => { confirmation.current?.focus(); }, [saleId]);
  async function copy() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(saleCode);
      setFeedback({ saleId, message: 'ID de venta copiado.' });
    } catch {
      setFeedback({ saleId, message: 'No pudimos copiar el ID. Seleccioná el ID de venta y copialo manualmente.' });
    }
  }
  return <section ref={confirmation} tabIndex={-1} className={styles.success} aria-label="Confirmación de venta">
    <p role="status"><strong>{pendingSync ? 'Venta confirmada sin conexión' : 'Venta confirmada'}</strong></p>
    <p>Total: {total}. El comprobante sigue disponible aunque falle la impresión.</p>
    <div className={styles.saleIdentity}>
      <dl><dt>ID de venta</dt><dd className={styles.saleId}>{saleCode}</dd></dl>
      <button type="button" onClick={() => void copy()}>Copiar ID de venta</button>
    </div>
    <p role="status" aria-live="polite">{feedback?.saleId === saleId ? feedback.message : ''}</p>
    {pendingSync ? <p>Pendiente de sincronización. Podés consultar esta venta online con este ID cuando se sincronice.</p> : null}
    {children}
  </section>;
}
