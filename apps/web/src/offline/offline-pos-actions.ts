import type { OfflinePos } from './offline-pos';

/** Public UI port: keys, storage and identity selection stay inside the controller. */
export function createOfflinePosActions(pos: OfflinePos, userId: string) {
  return {
    workspace: () => pos.workspace(userId),
    open: (input: Parameters<OfflinePos['open']>[1]) => pos.open(userId, input),
    prepare: (input: Parameters<OfflinePos['prepareSale']>[1]) => pos.prepareSale(userId, input),
    confirm: (input: Parameters<OfflinePos['confirmSale']>[1]) => pos.confirmSale(userId, input),
    receipt: (saleId: string) => pos.receipt(userId, saleId),
  };
}

export type OfflinePosActions = ReturnType<typeof createOfflinePosActions>;
export type OfflinePosWorkspaceData = Awaited<ReturnType<OfflinePosActions['workspace']>>;
export type OfflineReceipt = NonNullable<Awaited<ReturnType<OfflinePosActions['receipt']>>>;
