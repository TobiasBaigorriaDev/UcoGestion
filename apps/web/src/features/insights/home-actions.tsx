'use client';

import { useQuery } from '@tanstack/react-query';

import { NavIcon, type NavIconName } from '../../components/nav-icons';
import { loadCheckoutContext, type CheckoutContext } from '../sales/sales-api';
import styles from './home-actions.module.css';

type Role = 'OWNER' | 'ADMIN' | 'CASHIER' | 'EMPLOYEE';
type Action = { href: string; label: string; icon: NavIconName; primary?: boolean };

function actionsFor(role: Role): Action[] {
  if (role === 'EMPLOYEE') return [
    { href: '/workspace/catalog', label: 'Ver productos', icon: 'package', primary: true },
    { href: '/workspace/purchases', label: 'Registrar compra', icon: 'truck' },
  ];
  return [
    { href: '/workspace/pos', label: 'Vender', icon: 'counter', primary: true },
    { href: '/workspace/cash-sessions', label: 'Turno de caja', icon: 'wallet' },
    { href: '/workspace/customers', label: 'Cobrar a un cliente', icon: 'users' },
    ...(role === 'CASHIER' ? [] : [{ href: '/workspace/purchases', label: 'Registrar compra', icon: 'truck' } satisfies Action]),
    { href: '/workspace/expenses', label: 'Registrar gasto', icon: 'banknote' },
  ];
}

/** Start of the day: what to do next and whether there is a register to sell with. */
export function HomeActions({ organizationId, branchId, role, loadContext = loadCheckoutContext }: {
  organizationId: string; branchId: string | null; role: Role;
  loadContext?: (organizationId: string, branchId: string) => Promise<CheckoutContext>;
}) {
  const sells = role !== 'EMPLOYEE';
  const cash = useQuery({ queryKey: ['sale-checkout-context', organizationId, branchId],
    queryFn: () => loadContext(organizationId, branchId ?? ''), enabled: sells && !!branchId });
  const open = cash.data?.sessions ?? [];
  return <section className={styles.panel} aria-label="Accesos rápidos">
    {sells && branchId ? <div role="status" className={styles.cash} data-state={cash.isPending ? 'loading' : cash.error ? 'unknown' : open.length ? 'open' : 'closed'}>
      <NavIcon name="wallet" className={styles.cashIcon} />
      {cash.isPending ? <span>Consultando la caja…</span>
        : cash.error ? <span>No pudimos consultar la caja. Revisá la conexión.</span>
        : open.length ? <span><strong>Caja abierta: {open.map(session => session.registerName).join(', ')}</strong> · Podés vender.</span>
        : <span><strong>No hay una caja abierta.</strong> Para vender, primero abrí un turno.{' '}
          <a href="/workspace/cash-sessions">Abrir turno de caja</a></span>}
    </div> : null}
    <nav aria-label="¿Qué querés hacer?">
      <ul className={styles.actions}>
        {actionsFor(role).map(action => <li key={action.href}>
          <a href={action.href} className={action.primary ? styles.primaryAction : styles.action}>
            <NavIcon name={action.icon} className={styles.actionIcon} />{action.label}
          </a>
        </li>)}
      </ul>
    </nav>
  </section>;
}
