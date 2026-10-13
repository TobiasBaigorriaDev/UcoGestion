'use client';

import { useId, useRef, useState } from 'react';
import { categoryIconNames } from '@uconext/shared';
import { CategoryIcon } from './category-icon';
import styles from './category-icon-picker.module.css';

const labels: Record<typeof categoryIconNames[number], string> = {
  folder: 'Carpeta general', apple: 'Frutas', coffee: 'Café y bebidas calientes', milk: 'Lácteos', wine: 'Vinos', beef: 'Carnes', fish: 'Pescados', wheat: 'Pan y cereales', 'cake-slice': 'Pastelería', candy: 'Golosinas', shirt: 'Ropa', pill: 'Salud', wrench: 'Herramientas', package: 'Paquetes', smartphone: 'Tecnología', leaf: 'Productos naturales', 'shopping-basket': 'Almacén', utensils: 'Comidas', egg: 'Huevos', 'flower-2': 'Flores',
  'cup-soda': 'Gaseosas y refrescos', 'bottle-wine': 'Botellas', beer: 'Cervezas', sandwich: 'Sándwiches', pizza: 'Pizzas', popcorn: 'Pochoclos', 'ice-cream-cone': 'Helados', cookie: 'Galletitas', croissant: 'Facturas y panadería', banana: 'Bananas', carrot: 'Verduras', cherry: 'Cerezas', citrus: 'Cítricos', grape: 'Uvas', salad: 'Ensaladas', soup: 'Sopas', drumstick: 'Pollo', ham: 'Fiambres', 'cooking-pot': 'Comidas preparadas', snowflake: 'Congelados y hielo', 'spray-can': 'Limpieza', 'brush-cleaning': 'Escobas y cepillos', 'soap-dispenser-droplet': 'Jabones e higiene', cigarette: 'Cigarrillos', newspaper: 'Diarios y revistas', battery: 'Pilas', ticket: 'Tarjetas y recargas', 'shopping-bag': 'Bolsas', store: 'Kiosco', lollipop: 'Chupetines', nut: 'Frutos secos', droplet: 'Agua',
};

export function CategoryIconPicker({ value, onChange, disabled = false, label = 'Elegir icono' }: {
  value: string | null; onChange: (icon: string | null) => void; disabled?: boolean; label?: string;
}) {
  const id = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const normalize = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('es').trim();
  const options = categoryIconNames.filter(icon => normalize(labels[icon]).includes(normalize(query)));
  const selected = categoryIconNames.find(icon => icon === value) ?? 'folder';
  return <div className={styles.picker}>
    <div className={styles.preview}><CategoryIcon icon={value} />
      <button ref={toggleRef} type="button" disabled={disabled} aria-expanded={open} aria-controls={`${id}-library`} onClick={() => setOpen(current => !current)}>{label}</button>
    </div>
    {open ? <div id={`${id}-library`} className={styles.library}>
      <label htmlFor={`${id}-search`}>Buscar icono</label>
      <input id={`${id}-search`} type="search" placeholder="Gaseosas, golosinas, limpieza…" value={query} onChange={event => setQuery(event.target.value)} />
      <fieldset><legend>Biblioteca de iconos</legend>
        <div className={styles.choices}>{options.map(icon => <label key={icon} className={styles.choice}>
          <input type="radio" name={`${id}-icon`} aria-label={labels[icon]} value={icon} checked={selected === icon} disabled={disabled} onChange={() => {
            onChange(icon === 'folder' ? null : icon); setOpen(false); setQuery(''); toggleRef.current?.focus();
          }} />
          <CategoryIcon icon={icon} />
        </label>)}</div>
        {!options.length ? <p>No encontramos iconos. Probá con otra palabra.</p> : null}
      </fieldset>
    </div> : null}
  </div>;
}
