import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';

import VisualPreviewPage from '../app/preview/page';

afterEach(cleanup);

it('keeps the preview styled under CSP and exposes the selected section to assistive technology', async () => {
  const user = userEvent.setup();
  const { container } = render(<VisualPreviewPage />);
  expect(container.querySelector('[style]')).toBeNull();
  const customers = screen.getByRole('button', { name: 'Clientes' });
  expect(customers.getAttribute('aria-pressed')).toBe('true');
  await user.click(screen.getByRole('button', { name: 'Proveedores' }));
  expect(customers.getAttribute('aria-pressed')).toBe('false');
  expect(screen.getByRole('heading', { name: 'Proveedores', level: 1 })).toBeDefined();
  expect(screen.getByRole('button', { name: 'Proveedores' }).getAttribute('aria-pressed')).toBe('true');
});

