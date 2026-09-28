'use client';

import { useState } from 'react';

import type { CatalogReadData } from '../catalog/catalog-read';
import { PosCart, type CartLine } from './pos-cart';
import { PosCheckout } from './pos-checkout';
import type { SaleConfirmation } from './sales-api';
import { ReceiptActions } from './receipt-actions';
import styles from './pos.module.css';

export function PosOnline({ organizationId, branchId, role, items }: {
  organizationId: string; branchId: string;
  role: 'OWNER' | 'ADMIN' | 'CASHIER' | 'EMPLOYEE';
  items: CatalogReadData['items'];
}) {
  const [lines, setLines] = useState<readonly CartLine[]>([]);
  const [sale, setSale] = useState<SaleConfirmation | null>(null);
  const [revision, setRevision] = useState(0);
  const confirmed = (value: SaleConfirmation) => {
    setSale(value); setLines([]); setRevision((current) => current + 1);
  };
  return <section className={styles.page}>
    <header><h1>Venta online</h1><p>Agregá productos, revisá el total y confirmá el cobro.</p></header>
    {sale ? <div className={styles.success} role="status"><strong>Venta confirmada</strong>
      <p>Total: {sale.total}. El comprobante sigue disponible aunque falle la impresión.</p>
      <ReceiptActions organizationId={organizationId} saleId={sale.id} />
    </div> : null}
    <div className={styles.layout}>
      <PosCart key={`cart-${revision}`} items={items} onLinesChange={setLines} />
      <PosCheckout key={`checkout-${revision}`} organizationId={organizationId} branchId={branchId} role={role}
        lines={lines} items={items} onConfirmed={confirmed} />
    </div>
  </section>;
}
