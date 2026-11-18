'use client';

import { useState } from 'react';

import type { CatalogReadData } from '../catalog/catalog-read';
import { PosCart, type CartLine } from './pos-cart';
import { PosCheckout } from './pos-checkout';
import type { SaleConfirmation } from './sales-api';
import { ReceiptActions } from './receipt-actions';
import { SaleConfirmation as ConfirmedSale } from './sale-confirmation';
import styles from './pos.module.css';
import { formatMoney } from '../../lib/format';

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
    <header className={styles.posHeader}><h1>Mostrador</h1></header>
    {sale ? <ConfirmedSale saleId={sale.id} total={sale.total}>
      {typeof sale.receipt.onAccountAmount === 'string' && sale.receipt.onAccountAmount !== '0.00' ? <p>A cuenta del cliente: {formatMoney(sale.receipt.onAccountAmount, String(sale.receipt.currency ?? 'ARS'))}</p> : null}
      <ReceiptActions organizationId={organizationId} saleId={sale.id} />
    </ConfirmedSale> : null}
    <div className={styles.layout}>
      <PosCart key={`cart-${revision}`} items={items} onLinesChange={setLines} />
      <PosCheckout key={`checkout-${revision}`} organizationId={organizationId} branchId={branchId} role={role}
        lines={lines} items={items} onConfirmed={confirmed} />
    </div>
  </section>;
}
