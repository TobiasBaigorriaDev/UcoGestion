import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { OfflinePosWorkspace } from '../src/features/offline/offline-pos-workspace';
import { createOfflinePosActions } from '../src/offline/offline-pos-actions';
import { OfflineDatabase } from '../src/offline/offline-database';
import { OfflineRevocation } from '../src/offline/offline-revocation';
import { actor, org, device } from './offline-authorization.fixture';
import { posFixture } from './offline-pos.fixture';
import { saleCodeFromId } from '@uconext/shared';

afterEach(async () => { cleanup(); await Dexie.delete(OfflineDatabase.nameFor(org, device)); });

it('D03 confirms through the real offline engine and recovers the same receipt after remount', async () => {
  const setup = await posFixture();
  try {
    const controller = createOfflinePosActions(setup.pos, actor);
    const view = render(<OfflinePosWorkspace controller={controller} expired={false} />);
    await screen.findByRole('button', { name: 'Abrir caja sin conexión' });
    fireEvent.click(screen.getByRole('button', { name: 'Abrir caja sin conexión' }));
    await screen.findByLabelText('Buscar producto');
    fireEvent.change(screen.getByLabelText('Buscar producto'), { target: { value: 'Producto' } });
    fireEvent.click(screen.getByRole('button', { name: 'Agregar Producto' }));
    fireEvent.click(screen.getByRole('button', { name: 'Preparar cobro sin conexión' }));
    await screen.findByRole('button', { name: 'Confirmar venta sin conexión' });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar venta sin conexión' }));
    await screen.findByText('Venta confirmada sin conexión');
    const pending = await setup.db.deliveryBytes();
    expect(pending).toHaveLength(2);
    const saleId = (await setup.db.records.filter(row => row.kind === 'sale').first())?.id;
    if (!saleId) throw new Error('Missing committed sale');
    const saleCode = saleCodeFromId(saleId);
    expect(within(screen.getByRole('region', { name: 'Confirmación de venta' })).getByText(saleCode)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Copiar ID de venta' })).toBeDefined();
    fireEvent.click(await screen.findByRole('button', { name: 'Ver comprobante local' }));
    expect(await screen.findByText(`ID de venta: ${saleCode}`)).toBeDefined();
    view.unmount(); setup.db.close(); await setup.db.open();
    render(<OfflinePosWorkspace controller={controller} expired={false} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Ver comprobante de venta pendiente' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Ver comprobante local' }));
    await screen.findByText(`ID de venta: ${saleCode}`);
    expect(await setup.db.deliveryBytes()).toEqual(pending);
    await new OfflineRevocation(setup.db, setup.keys).learn(actor);
    await waitFor(() => expect(screen.queryByText(`ID de venta: ${saleCode}`)).toBeNull());
    expect(await setup.db.deliveryBytes()).toEqual(pending);
    await expect(controller.receipt(saleId)).rejects.toThrow();
  } finally { setup.db.close(); }
});

it('D03 never shows confirmation on seal failure and restores the unconfirmed attempt without a new ID', async () => {
  const setup = await posFixture();
  try {
    const controller = createOfflinePosActions(setup.pos, actor);
    const session = await controller.open({ cashRegisterId: setup.bootstrap.configuration.cashRegisters[0]?.id ?? '', openingCash: '0.00' });
    const draft = await controller.prepare({ sessionId: session.sessionId, lines: [{ itemId: org, quantity: '1' }] });
    const fail = () => { throw new Error('Envelope failed'); };
    setup.db.delivery_queue.hook('creating', fail);
    const view = render(<OfflinePosWorkspace controller={controller} expired={false} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirmar venta sin conexión' }));
    await screen.findByRole('alert');
    expect(screen.queryByText('Venta confirmada sin conexión')).toBeNull();
    expect(await setup.db.getEncrypted(actor, 'sale', draft.id)).toBeUndefined();
    view.unmount(); setup.db.delivery_queue.hook('creating').unsubscribe(fail);
    render(<OfflinePosWorkspace controller={controller} expired={false} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirmar venta sin conexión' }));
    await waitFor(() => expect(within(screen.getByRole('region', { name: 'Confirmación de venta' })).getByText(draft.id)).toBeDefined());
    expect(await setup.db.delivery_queue.count()).toBe(2);
    await expect(setup.pos.receipt('77777777-7777-4777-8777-777777777777', draft.id)).rejects.toThrow();
  } finally { setup.db.close(); }
});
