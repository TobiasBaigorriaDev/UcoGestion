import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { OpaqueProgress } from '../src/features/offline/opaque-progress';
afterEach(cleanup);
it('T220B allows a generic retry and never renders error payload or foreign identity details', async () => {
  render(<OpaqueProgress load={vi.fn().mockResolvedValue({ pending: 2, rejected: 1 })} deliver={vi.fn().mockRejectedValue(new Error('private tenant alice sale 700'))} />);
  await screen.findByText(/2 entregas pendientes/);
  await userEvent.click(screen.getByRole('button', { name: 'Reintentar entrega del equipo' }));
  await screen.findByText(/La entrega no pudo completarse/);
  expect(document.body.textContent).not.toMatch(/alice|700|private/);
  expect(screen.getByText(/rechazo definitivo/)).toBeTruthy();
});
