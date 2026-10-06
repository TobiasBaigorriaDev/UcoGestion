import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import axe from 'axe-core';
import { OnlineOnlyBoundary } from '../src/offline/online-only-boundary';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('T199 removes an already-open administrative form when connectivity is lost and restores it online', () => {
  let online = true;
  vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online);
  render(<OnlineOnlyBoundary><form aria-label="Compra"><button>Confirmar compra</button></form></OnlineOnlyBoundary>);
  expect(screen.getByRole('button', { name: 'Confirmar compra' })).toBeDefined();
  act(() => { online = false; window.dispatchEvent(new Event('offline')); });
  expect(screen.queryByRole('button', { name: 'Confirmar compra' })).toBeNull();
  expect(screen.getByRole('heading', { name: 'Esta pantalla necesita conexión' })).toBeDefined();
  expect(screen.getByRole('alert')).toBe(document.activeElement);
  act(() => { online = true; window.dispatchEvent(new Event('online')); });
  expect(screen.getByRole('button', { name: 'Confirmar compra' })).toBeDefined();
});

it('T199 never mounts cached reports on an offline route', () => {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  render(<OnlineOnlyBoundary><p>Reporte privado ya cargado</p></OnlineOnlyBoundary>);
  expect(screen.queryByText('Reporte privado ya cargado')).toBeNull();
  expect(screen.getByText(/operaciones pendientes del POS se conservan/)).toBeDefined();
});

it('T199 exposes an accessible offline notice', async () => {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  const { container } = render(<OnlineOnlyBoundary><p>Administración</p></OnlineOnlyBoundary>);
  // JSDOM has no rendered contrast calculation; browser captures cover the notice.
  expect((await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations).toEqual([]);
});
