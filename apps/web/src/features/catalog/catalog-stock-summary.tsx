import type { StockItem } from '../inventory/inventory-api';
import { formatStockQuantity } from '../../lib/format-stock-quantity';
import styles from './catalog-stock-summary.module.css';

type CatalogStockItem = {
  id: string;
  type: 'PRODUCT' | 'SERVICE';
  status: 'ACTIVE' | 'INACTIVE';
  trackInventory: boolean;
};

export function CatalogStockSummary({ item, branchName, stocks, failed = false }: {
  item: CatalogStockItem;
  branchName?: string | undefined;
  stocks?: readonly StockItem[] | undefined;
  failed?: boolean | undefined;
}) {
  if (item.type === 'SERVICE') return <p className={styles.note}>Servicio · sin stock</p>;
  if (!item.trackInventory) return <p className={styles.note}>No controla stock</p>;
  if (item.status === 'INACTIVE') return <p className={styles.note}>Inactivo · sin stock actual</p>;
  if (!branchName) return <p className={styles.note}>Seleccioná una sucursal para ver stock</p>;
  if (failed) return <p className={styles.note}>No pudimos cargar el stock de {branchName}</p>;
  if (!stocks) return <p className={styles.note}>Consultando stock de {branchName}…</p>;
  const stock = stocks.find((entry) => entry.itemId === item.id);
  if (!stock) return <p className={styles.note}>Stock no disponible en {branchName}</p>;
  const quantity = formatStockQuantity(stock.quantity);
  return <p className={styles.stock}>
    Disponible en {branchName}: <strong>{quantity} {stock.baseUnit === 'UNIT' ? 'unidades' : 'unidades fraccionables'}</strong>
    {stock.lowStock ? <span className={styles.warning}>Stock bajo</span> : null}
  </p>;
}
