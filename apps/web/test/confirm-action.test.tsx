import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfirmAction } from '../src/components/confirm-action';

afterEach(cleanup);
const view = (onConfirm = vi.fn(), disabled = false) => render(<ConfirmAction label="Anular venta" confirmLabel="Sí, anular la venta"
  disabled={disabled} onConfirm={onConfirm}>Se devuelve el efectivo cobrado. No se puede deshacer.</ConfirmAction>);

describe('D08 in-place confirmation', () => {
  it('asks before running and explains the consequence', async () => {
    const onConfirm = vi.fn();
    const { container } = view(onConfirm);
    await userEvent.click(screen.getByRole('button', { name: 'Anular venta' }));
    expect(onConfirm).not.toHaveBeenCalled();
    const question = screen.getByRole('group', { name: '¿Anular venta?' });
    expect(question.textContent).toContain('No se puede deshacer');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'No, volver' }));
    await userEvent.click(screen.getByRole('button', { name: 'Sí, anular la venta' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect((await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });

  it('goes back without acting, by button or Escape, returning focus', async () => {
    const onConfirm = vi.fn();
    view(onConfirm);
    await userEvent.click(screen.getByRole('button', { name: 'Anular venta' }));
    await userEvent.click(screen.getByRole('button', { name: 'No, volver' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Anular venta' }));
    await userEvent.click(screen.getByRole('button', { name: 'Anular venta' }));
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('group', { name: '¿Anular venta?' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Anular venta' }));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('cannot be started while disabled', () => {
    view(vi.fn(), true);
    expect(screen.getByRole('button', { name: 'Anular venta' })).toHaveProperty('disabled', true);
  });
});
