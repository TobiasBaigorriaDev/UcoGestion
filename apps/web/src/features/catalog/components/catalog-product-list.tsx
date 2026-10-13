'use client';

import { useId, useState, type ReactNode } from 'react';
import styles from '../../identity/management.module.css';
import groupStyles from './catalog-product-list.module.css';
import { CategoryIcon } from './category-icon';

export function CatalogGrouping({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
  return <div className={styles.checks}>
    <label><input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} />Agrupar por categorías</label>
  </div>;
}

export function CatalogProductList<T extends { id: string; categoryId?: string | null | undefined }>({ items, categories, grouped, renderItem }: {
  items: readonly T[];
  categories: readonly { id: string; name: string; icon?: string | null | undefined }[];
  grouped: boolean;
  renderItem: (item: T) => ReactNode;
}) {
  if (!grouped) return <ul className={styles.rows}>{items.map(renderItem)}</ul>;
  const names = new Map(categories.map(category => [category.id, category]));
  const groups = new Map<string, { name: string; icon: string | null; items: T[] }>();
  for (const item of items) {
    const key = item.categoryId ?? '';
    const group = groups.get(key) ?? { name: key ? names.get(key)?.name ?? 'Categoría no disponible' : 'Sin categoría', icon: names.get(key)?.icon ?? null, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  const collator = new Intl.Collator('es', { sensitivity: 'base', numeric: true });
  const ordered = [...groups].sort(([a, left], [b, right]) => a === '' ? 1 : b === '' ? -1 : collator.compare(left.name, right.name) || a.localeCompare(b));
  return <div className={groupStyles.groups}>{ordered.map(([key, group]) =>
    <CategoryFolder key={key} name={group.name} icon={group.icon} items={group.items} renderItem={renderItem} />)}</div>;
}

function CategoryFolder<T>({ name, icon, items, renderItem }: { name: string; icon: string | null; items: readonly T[]; renderItem: (item: T) => ReactNode }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return <section aria-labelledby={`${id}-name`} className={groupStyles.group}>
    <h3 className={groupStyles.heading}>
      <button type="button" className={groupStyles.folderButton} aria-expanded={open} aria-controls={`${id}-products`}
        aria-label={`${open ? 'Cerrar' : 'Abrir'} categoría ${name}`} onClick={() => setOpen(value => !value)}>
        <CategoryIcon className={groupStyles.folderIcon} icon={icon} />
        <span id={`${id}-name`} className={groupStyles.title}>{name}</span>
        <span className={groupStyles.count}>{items.length} {items.length === 1 ? 'ítem' : 'ítems'}</span>
        <svg className={groupStyles.chevron} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>
      </button>
    </h3>
    <div id={`${id}-products`} hidden={!open} className={groupStyles.contents}>
      {open ? <ul className={styles.rows}>{items.map(renderItem)}</ul> : null}
    </div>
  </section>;
}
