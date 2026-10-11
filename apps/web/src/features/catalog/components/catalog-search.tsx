'use client';

import { useId, useRef } from 'react';

import styles from '../catalog-read.module.css';

function normalizeSearch(value: string): string {
  return value.trim().toLocaleLowerCase('es').normalize('NFD').replace(/\p{M}/gu, '');
}

export function filterCatalogItems<T extends { name: string; sku: string | null; barcode: string | null }>(items: T[], query: string): T[] {
  const normalizedQuery = normalizeSearch(query);
  return items.filter((item) => [item.name, item.sku, item.barcode].some((value) => value !== null && normalizeSearch(value).includes(normalizedQuery)));
}

export function CatalogSearch({ query, onQueryChange, total, matched }: {
  query: string;
  onQueryChange: (query: string) => void;
  total: number;
  matched: number;
}) {
  const id = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  return <div className={styles.searchField} role="search" aria-label="Buscar en el catálogo">
    <label htmlFor={id}>Buscar producto</label>
    <p id={`${id}-hint`} className={styles.searchHint}>Por nombre, SKU o código de barras. También podés buscar servicios.</p>
    <div className={styles.searchControls}>
      <div className={styles.searchInput}>
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></svg>
        <input ref={searchRef} id={id} type="search" placeholder="Nombre, SKU o código de barras" aria-describedby={`${id}-hint`} value={query} onChange={(event) => onQueryChange(event.target.value)} />
      </div>
      {query ? <button className={styles.clearSearch} type="button" onClick={() => { onQueryChange(''); searchRef.current?.focus(); }}>Limpiar búsqueda</button> : null}
    </div>
    <p className={styles.resultCount} role="status" aria-atomic="true">{query.trim() ? `${matched} de ${total} ítems` : `${total} ${total === 1 ? 'ítem disponible' : 'ítems disponibles'}`}</p>
  </div>;
}
