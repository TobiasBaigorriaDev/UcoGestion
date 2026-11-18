import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, expect, it, vi } from 'vitest';

import {
  PaymentMethodsManagement,
  type ManagedPaymentMethod,
} from '../src/features/organizations/payment-methods-management.js';

afterEach(cleanup);

const initialMethods: ManagedPaymentMethod[] = [
  { method: 'CASH', enabled: true },
  { method: 'DEBIT_CARD', enabled: true },
  { method: 'CREDIT_CARD', enabled: false },
  { method: 'TRANSFER', enabled: true },
  { method: 'QR', enabled: false },
];

it('allows OWNER/ADMIN to toggle payment methods with accessible feedback', async () => {
  const onToggle = vi.fn().mockResolvedValue({ method: 'CREDIT_CARD', enabled: true });
  const onReload = vi.fn();

  const { container } = render(
    <PaymentMethodsManagement
      organizationId="org"
      role="OWNER"
      methods={initialMethods}
      onReload={onReload}
      onToggle={onToggle}
    />,
  );

  expect(screen.getByRole('heading', { name: 'Medios de pago' })).toBeTruthy();
  expect(screen.getByText('Efectivo')).toBeTruthy();
  expect(screen.getByText('Tarjeta de débito')).toBeTruthy();
  expect(screen.getByText('Tarjeta de crédito')).toBeTruthy();
  expect(screen.getByText('Transferencia')).toBeTruthy();
  expect(screen.getByText('QR / Billetera digital')).toBeTruthy();

  // Toggle CREDIT_CARD from inactive to active
  const creditToggle = screen.getByRole('switch', { name: 'Aceptar Tarjeta de crédito' });
  expect(creditToggle.getAttribute('aria-checked')).toBe('false');
  expect(screen.getByRole('switch', { name: 'Aceptar Efectivo' }).getAttribute('aria-checked')).toBe('true');
  await userEvent.click(creditToggle);
  expect(onToggle).toHaveBeenCalledWith('org', 'CREDIT_CARD', true);

  expect((await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
}, 15000);

it('renders read-only view for CASHIER and EMPLOYEE without toggling capabilities', async () => {
  render(
    <PaymentMethodsManagement
      organizationId="org"
      role="CASHIER"
      methods={initialMethods}
      onReload={vi.fn()}
    />,
  );

  expect(screen.queryByRole('switch')).toBeNull();
  expect(screen.getAllByText('Habilitado').length).toBe(3);
  expect(screen.getAllByText('Deshabilitado').length).toBe(2);
});
