import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';

import { Button, CheckboxField, Dialog, TextField } from './index.js';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('accessible UI primitives', () => {
  it('labels fields and links errors without relying on color', async () => {
    const { container } = render(
      <div>
        <TextField label="Nombre" name="name" required error="Ingresá un nombre." />
        <CheckboxField label="Confirmo la operación" name="confirmed" />
        <Button type="submit">Guardar</Button>
        <Button>Cancelar</Button>
      </div>,
    );

    const input = screen.getByRole('textbox', { name: 'Nombre' });
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe(screen.getByText('Ingresá un nombre.').id);
    expect(screen.getByRole('checkbox', { name: 'Confirmo la operación' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Guardar' }).getAttribute('type')).toBe('submit');
    expect(screen.getByRole('button', { name: 'Cancelar' }).getAttribute('type')).toBe('button');
    expect((await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });

  it('operates checkbox and dialog with keyboard, then restores focus', async () => {
    const user = userEvent.setup();
    render(
      <div>
        <CheckboxField label="Acepto" name="accepted" />
        <Dialog trigger={<Button>Revisar</Button>} title="Revisar operación" description="Confirmá los datos antes de continuar.">
          <Button>Continuar</Button>
        </Dialog>
      </div>,
    );

    await user.tab();
    expect(screen.getByRole('checkbox', { name: 'Acepto' })).toBe(document.activeElement);
    await user.keyboard(' ');
    expect(screen.getByRole('checkbox', { name: 'Acepto' }).getAttribute('data-state')).toBe('checked');
    await user.tab();
    expect(screen.getByRole('button', { name: 'Revisar' })).toBe(document.activeElement);
    await user.keyboard('{Enter}');
    expect(screen.getByRole('dialog', { name: 'Revisar operación' })).toBeTruthy();
    expect(screen.getByText('Confirmá los datos antes de continuar.')).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Revisar' })).toBe(document.activeElement);
  });
});
