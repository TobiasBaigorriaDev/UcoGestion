import { cleanup, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';

import { ErrorSummary } from '../src/components/error-summary.js';
import { ApiProblemError } from '../src/lib/api/client.js';

afterEach(cleanup);

describe('ErrorSummary', () => {
  it('announces and focuses a safe message with links to invalid fields', async () => {
    const error = new ApiProblemError({
      status: 400,
      code: 'BAD_REQUEST',
      message: 'Corregí los campos e intentá nuevamente.',
      traceId: 'trace-123',
      fieldErrors: { name: 'Ingresá un nombre.' },
    });
    const { container } = render(
      <div>
        <ErrorSummary error={error} fieldIds={{ name: 'customer-name' }} fieldLabels={{ name: 'Nombre' }} />
        <label htmlFor="customer-name">Nombre</label>
        <input id="customer-name" />
      </div>,
    );

    const alert = screen.getByRole('alert');
    expect(alert).toBe(document.activeElement);
    expect(alert.textContent).toContain('Corregí los campos');
    expect(screen.getByRole('link', { name: /Nombre.*Ingresá un nombre/ }).getAttribute('href')).toBe('#customer-name');
    expect((await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
  });

  it('does not render an error when there is none', () => {
    const { container } = render(<ErrorSummary error={null} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('D08 error titles', () => {
  it.each([
    [0, 'NETWORK_ERROR', 'No hay conexión con el servidor'],
    [401, 'SESSION_INVALID', 'Tu sesión venció'],
    [403, 'MEMBERSHIP_INACTIVE', 'No tenés permiso para hacer esto'],
    [409, 'VERSION_CONFLICT', 'Alguien cambió estos datos mientras trabajabas'],
    [400, 'VALIDATION_FAILED', 'Revisá los datos'],
    [422, 'SALE_PAYMENTS_INVALID', 'Revisá los datos'],
    [503, 'SERVICE_UNAVAILABLE', 'El servicio no está disponible en este momento'],
    [500, 'INTERNAL', 'Algo salió mal de nuestro lado'],
  ])('titles status %s (%s) as "%s" and keeps the server message', (status, code, title) => {
    render(<ErrorSummary error={new ApiProblemError({ status, code, message: 'Detalle del servidor.', traceId: 'abc' })} />);
    const alert = screen.getByRole('alert');
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe(title);
    expect(alert.textContent).toContain('Detalle del servidor.');
    expect(alert.textContent).toContain('Referencia: abc');
  });
});
