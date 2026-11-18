import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PosConnectionBoundary } from '../src/offline/pos-connection-boundary';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('T236AH blocks online POS, switches locally without navigation and preserves both modes across network changes', () => {
  let online = true;
  vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online);
  const mounted = vi.fn();
  function Offline() { useState(() => mounted()); return <label>PIN sin conexión<input /></label>; }
  render(<PosConnectionBoundary offlinePos={<Offline />}><label>Carrito online<input defaultValue="Venta pendiente de respuesta" /></label><button>Confirmar venta</button></PosConnectionBoundary>);
  expect(mounted).toHaveBeenCalledTimes(1);
  act(() => { online = false; window.dispatchEvent(new Event('offline')); });
  expect(screen.queryByRole('button', { name: 'Confirmar venta' })).toBeNull();
  expect(screen.getByRole('alert')).toBe(document.activeElement);
  expect(screen.getByText(/no la vuelvas a cargar/)).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'Pasar al mostrador sin conexión' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'PIN sin conexión' }), { target: { value: 'local-secret' } });
  expect(screen.queryByRole('button', { name: 'Confirmar venta' })).toBeNull();
  act(() => { online = true; window.dispatchEvent(new Event('online')); });
  expect(screen.getByRole('textbox', { name: 'PIN sin conexión' })).toHaveProperty('value', 'local-secret');
  fireEvent.click(screen.getByRole('button', { name: 'Volver al mostrador con internet' }));
  expect(screen.getByRole('textbox', { name: 'Carrito online' })).toHaveProperty('value', 'Venta pendiente de respuesta');
  expect(mounted).toHaveBeenCalledTimes(1);
});
