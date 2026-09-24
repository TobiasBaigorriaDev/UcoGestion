import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, expect, it, vi } from 'vitest';

import { ExpenseCategoryManagement } from '../src/features/expenses/expense-category-management.js';

afterEach(cleanup);

it('separates expense categories and only offers active entries for new expenses', async () => {
  const categories = [
    { id: 'one', name: 'Servicios', status: 'ACTIVE' as const, version: 1 },
    { id: 'two', name: 'Anterior', status: 'INACTIVE' as const, version: 2 },
  ];
  const changeStatus = vi.fn().mockResolvedValue({ ...categories[1], status: 'ACTIVE', version: 3 });
  const { container } = render(<ExpenseCategoryManagement organizationId="org" categories={categories}
    onCreate={vi.fn()} onChangeStatus={changeStatus} onDelete={vi.fn()} onReload={vi.fn()} />);
  expect(screen.getByRole('heading', { name: 'Categorías de gasto' })).toBeTruthy();
  const selector = screen.getByRole('combobox', { name: 'Categoría activa para un gasto nuevo' });
  expect(selector.querySelectorAll('option')).toHaveLength(2);
  expect(screen.getByRole('option', { name: 'Servicios' })).toBeTruthy();
  expect(screen.queryByRole('option', { name: 'Anterior' })).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Activar Anterior' }));
  expect(changeStatus).toHaveBeenCalledWith('org', 'two', 2, 'ACTIVE');
  expect((await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
});
