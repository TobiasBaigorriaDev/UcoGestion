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
