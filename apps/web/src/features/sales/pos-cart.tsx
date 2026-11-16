'use client';

import { useState, type KeyboardEvent } from 'react';

import { BarcodeCapture } from '../catalog/components/barcode-capture';
import type { CatalogReadData } from '../catalog/catalog-read';
import { formatMoney } from '../../lib/format';
import styles from './pos.module.css';

type Item = CatalogReadData['items'][number];
export type CartLine = { itemId: string; quantity: string };

const QUICK_PRODUCTS = 12;

function quantityError(value: string, unit: Item['baseUnit']): string | null {
  if (unit === 'UNIT' && !/^[1-9]\d*$/.test(value)) return 'Ingresá una cantidad entera positiva.';
  if (unit === 'FRACTIONAL' && !/^(?:0|[1-9]\d*)(?:\.\d{1,3})?$/.test(value)) {
    return 'Ingresá una cantidad positiva con hasta tres decimales.';
  }
  if (unit === 'FRACTIONAL' && !/[1-9]/.test(value)) return 'Ingresá una cantidad mayor que cero.';
  return null;
}

/** Whole-unit step; invalid text stays untouched so its validation message remains visible. */
function stepUnits(value: string, delta: 1n | -1n): string {
  if (!/^[1-9]\d*$/.test(value)) return value;
  const next = BigInt(value) + delta;
  return next < 1n ? value : next.toString();
}

export function PosCart({ items, onLinesChange }: {
  items: readonly Item[];
  onLinesChange?: (lines: readonly CartLine[]) => void;
}) {
  const [query, setQuery] = useState('');
  const [lines, setLines] = useState<CartLine[]>([]);
  const [error, setError] = useState('');
  const available = items.filter((item) => item.status === 'ACTIVE' && item.price !== null);
  const term = query.trim().toLocaleLowerCase();
  const matches = available.filter((item) => term !== '' && (item.name.toLocaleLowerCase().includes(term) ||
    item.sku?.toLocaleLowerCase().includes(term) || item.barcode?.toLocaleLowerCase().includes(term)));
  const quick = [...available].sort((left, right) => left.name.localeCompare(right.name, 'es')).slice(0, QUICK_PRODUCTS);
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
    setQuery('');
    if (current && item.baseUnit === 'UNIT') {
      setError('');
      publish(lines.map((line) => line.itemId === item.id ? { ...line, quantity: stepUnits(line.quantity, 1n) } : line));
      return;
    }
    if (current) {
      setError(`${item.name} ya está en el carrito. Ajustá su cantidad.`);
      return;
    }
    setError('');
    publish([...lines, { itemId: item.id, quantity: '1' }]);
  };
  const addFirstMatch = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const first = matches[0];
    if (first) add(first);
    else if (term) setError('No hay productos disponibles para esa búsqueda.');
  };
  const scan = (barcode: string) => {
    const item = available.find((candidate) => candidate.barcode?.toLocaleUpperCase() === barcode.toLocaleUpperCase());
    if (item) add(item);
    else setError('No encontramos un producto disponible con ese código. Revisá el código o buscá por nombre.');
  };
  const productButton = (item: Item) => <button type="button" className={styles.productButton} onClick={() => add(item)}
    aria-label={`Agregar ${item.name}`}>
    <span className={styles.productName}>{item.name}</span>
    <span className={styles.productPrice}>{item.price ? formatMoney(item.price) : ''}</span>
  </button>;
  return <section className={styles.panel} aria-labelledby="pos-cart-heading">
    <h2 id="pos-cart-heading">Carrito</h2>
    <div className={styles.searchFields}>
      <div><label htmlFor="pos-search">Buscar producto</label>
        <input id="pos-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)}
          onKeyDown={addFirstMatch} placeholder="Nombre, SKU o código" aria-describedby="pos-search-hint" autoComplete="off" />
        <p id="pos-search-hint" className={styles.hint}>Enter agrega el primer resultado.</p></div>
      <BarcodeCapture onScan={scan} />
    </div>
    {error ? <p role="alert" className={styles.error}>{error}</p> : null}
    {term ? <ul className={styles.productGrid} aria-label="Resultados de búsqueda">
      {matches.length ? matches.map((item) => <li key={item.id}>{productButton(item)}</li>)
        : <li className={styles.empty}>No hay productos disponibles para esa búsqueda.</li>}
    </ul> : null}
    {lines.length ? <ul className={styles.cart} aria-label="Carrito">{lines.map((line) => {
      const item = items.find((candidate) => candidate.id === line.itemId);
      if (!item) return null;
      const invalid = quantityError(line.quantity, item.baseUnit);
      const update = (quantity: string) => { setError(''); publish(lines.map((entry) => entry.itemId === item.id
        ? { ...entry, quantity } : entry)); };
      return <li key={line.itemId}>
        <div className={styles.lineItem}><strong>{item.name}</strong>
          <span>{item.price ? formatMoney(item.price) : ''}{item.baseUnit === 'FRACTIONAL' ? ' por unidad de medida' : ' c/u'}</span></div>
        <div className={styles.quantity}>
          <label htmlFor={`quantity-${item.id}`} className={styles.quantityLabel}>Cantidad de {item.name}</label>
          {item.baseUnit === 'UNIT' ? <button type="button" className={styles.stepper} aria-label={`Restar una unidad de ${item.name}`}
            disabled={line.quantity === '1'} onClick={() => update(stepUnits(line.quantity, -1n))}>−</button> : null}
          <input id={`quantity-${item.id}`} inputMode={item.baseUnit === 'UNIT' ? 'numeric' : 'decimal'} value={line.quantity}
            aria-invalid={invalid !== null} aria-describedby={invalid ? `quantity-error-${item.id}` : undefined}
            onChange={(event) => update(event.target.value)} />
          {item.baseUnit === 'UNIT' ? <button type="button" className={styles.stepper} aria-label={`Sumar una unidad de ${item.name}`}
            onClick={() => update(stepUnits(line.quantity, 1n))}>+</button> : null}
          {invalid ? <p id={`quantity-error-${item.id}`} role="alert" className={styles.error}>{invalid}</p> : null}
        </div>
        <button type="button" className={styles.remove} onClick={() => publish(lines.filter((entry) => entry.itemId !== item.id))}
          aria-label={`Quitar ${item.name}`}>Quitar</button>
      </li>;
    })}</ul> : <p className={styles.empty}>El carrito está vacío. Tocá un producto, buscalo o escaneá su código.</p>}
    <p role="status" className={styles.status}>{lines.length} {lines.length === 1 ? 'ítem' : 'ítems'} en el carrito.</p>
    {!term && quick.length ? <ul className={styles.productGrid} aria-label="Productos">
      {quick.map((item) => <li key={item.id}>{productButton(item)}</li>)}
    </ul> : null}
  </section>;
}
