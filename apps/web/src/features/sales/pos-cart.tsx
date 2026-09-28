'use client';

import { useState } from 'react';

import { BarcodeCapture } from '../catalog/components/barcode-capture';
import type { CatalogReadData } from '../catalog/catalog-read';
import styles from './pos.module.css';

type Item = CatalogReadData['items'][number];
export type CartLine = { itemId: string; quantity: string };

function quantityError(value: string, unit: Item['baseUnit']): string | null {
  if (unit === 'UNIT' && !/^[1-9]\d*$/.test(value)) return 'Ingresá una cantidad entera positiva.';
  if (unit === 'FRACTIONAL' && !/^(?:0|[1-9]\d*)(?:\.\d{1,3})?$/.test(value)) {
    return 'Ingresá una cantidad positiva con hasta tres decimales.';
  }
  if (unit === 'FRACTIONAL' && !/[1-9]/.test(value)) return 'Ingresá una cantidad mayor que cero.';
  return null;
}

export function PosCart({ items, onLinesChange }: {
  items: readonly Item[];
  onLinesChange?: (lines: readonly CartLine[]) => void;
}) {
  const [query, setQuery] = useState('');
  const [lines, setLines] = useState<CartLine[]>([]);
  const [error, setError] = useState('');
  const available = items.filter((item) => item.status === 'ACTIVE' && item.price !== null);
  const matches = available.filter((item) => {
    const term = query.trim().toLocaleLowerCase();
    return term !== '' && (item.name.toLocaleLowerCase().includes(term) ||
      item.sku?.toLocaleLowerCase().includes(term) || item.barcode?.toLocaleLowerCase().includes(term));
  });
  const publish = (next: CartLine[]) => {
    setLines(next);
    const valid = next.every((line) => {
      const item = available.find((candidate) => candidate.id === line.itemId);
      return item && !quantityError(line.quantity, item.baseUnit);
    });
    onLinesChange?.(valid ? next : []);
  };
  const add = (item: Item) => {
    const current = lines.find((line) => line.itemId === item.id);
    if (current) {
      setError(`${item.name} ya está en el carrito. Ajustá su cantidad.`);
      return;
    }
    setError(''); setQuery('');
    publish([...lines, { itemId: item.id, quantity: '1' }]);
  };
  const scan = (barcode: string) => {
    const item = available.find((candidate) => candidate.barcode?.toLocaleUpperCase() === barcode.toLocaleUpperCase());
    if (item) add(item);
    else setError('No encontramos un producto disponible con ese código. Revisá el código o buscá por nombre.');
  };
  return <section className={styles.panel} aria-labelledby="pos-cart-heading">
    <h2 id="pos-cart-heading">Carrito</h2>
    <div className={styles.searchFields}>
      <div><label htmlFor="pos-search">Buscar producto</label>
        <input id="pos-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)}
          placeholder="Nombre, SKU o código" /></div>
      <BarcodeCapture onScan={scan} />
    </div>
    {error ? <p role="alert" className={styles.error}>{error}</p> : null}
    {query.trim() ? <ul className={styles.results} aria-label="Resultados de búsqueda">
      {matches.length ? matches.map((item) => <li key={item.id}>
        <span><strong>{item.name}</strong><small>Precio vigente: {item.price}</small></span>
        <button type="button" onClick={() => add(item)}>Agregar {item.name}</button>
      </li>) : <li>No hay productos disponibles para esa búsqueda.</li>}
    </ul> : null}
    {lines.length ? <ul className={styles.cart} aria-label="Carrito">{lines.map((line) => {
      const item = items.find((candidate) => candidate.id === line.itemId);
      if (!item) return null;
      const invalid = quantityError(line.quantity, item.baseUnit);
      return <li key={line.itemId}>
        <div><strong>{item.name}</strong><span>Precio vigente: {item.price}</span></div>
        <div><label htmlFor={`quantity-${item.id}`}>Cantidad de {item.name}</label>
          <input id={`quantity-${item.id}`} inputMode="decimal" value={line.quantity}
            aria-invalid={invalid !== null} aria-describedby={invalid ? `quantity-error-${item.id}` : undefined}
            onChange={(event) => { setError(''); publish(lines.map((entry) => entry.itemId === item.id
              ? { ...entry, quantity: event.target.value } : entry)); }} />
          {invalid ? <p id={`quantity-error-${item.id}`} role="alert" className={styles.error}>{invalid}</p> : null}</div>
        <button type="button" onClick={() => publish(lines.filter((entry) => entry.itemId !== item.id))}
          aria-label={`Quitar ${item.name}`}>Quitar</button>
      </li>;
    })}</ul> : <p className={styles.empty}>El carrito está vacío. Buscá un producto o escaneá su código.</p>}
    <p role="status" className={styles.status}>{lines.length} {lines.length === 1 ? 'ítem' : 'ítems'} en el carrito.</p>
  </section>;
}
