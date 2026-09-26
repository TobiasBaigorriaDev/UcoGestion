'use client';

import { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { ErrorSummary } from '../../components/error-summary';
import { ApiClient, ApiProblemError } from '../../lib/api/client';
import { SimilarNameWarning } from './components/similar-name-warning';
import styles from '../identity/management.module.css';

const itemSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(['PRODUCT', 'SERVICE']),
  status: z.enum(['ACTIVE', 'INACTIVE']),
  trackInventory: z.boolean(),
  baseUnit: z.enum(['UNIT', 'FRACTIONAL']),
  price: z.string().nullable(),
  priceVersion: z.number().int(),
  sku: z.string().nullable(),
  barcode: z.string().nullable(),
  version: z.number().int().positive(),
});

const createResultSchema = itemSchema.omit({ price: true, priceVersion: true });
const editResultSchema = itemSchema.pick({ id: true, name: true, sku: true, barcode: true, version: true });
const priceResultSchema = z.object({ itemId: z.string(), price: z.string(), priceVersion: z.number().int(), version: z.number().int(), currency: z.string() });
const createSchema = z.object({
  name: z.string().trim().min(1).max(255),
  type: z.enum(['PRODUCT', 'SERVICE']),
  trackInventory: z.boolean(),
  baseUnit: z.enum(['UNIT', 'FRACTIONAL']),
  sku: z.string(),
  barcode: z.string(),
});
const editSchema = z.object({ name: z.string().trim().min(1).max(255), sku: z.string(), barcode: z.string() });
const priceSchema = z.object({ price: z.string().regex(/^(?:0|[1-9]\d{0,17})\.\d{2}$/) });
const structuralSchema = z.object({
  type: z.enum(['PRODUCT', 'SERVICE']),
  baseUnit: z.enum(['UNIT', 'FRACTIONAL']),
  trackInventory: z.boolean(),
});

type CreateValues = z.infer<typeof createSchema>;
type EditValues = z.infer<typeof editSchema>;
type PriceValues = z.infer<typeof priceSchema>;
type StructuralValues = z.infer<typeof structuralSchema>;
export type ManagedItem = z.infer<typeof itemSchema>;

const client = new ApiClient();

async function csrfToken(): Promise<string> {
  const result = await client.request('/auth/csrf', {
    method: 'GET',
    parse: (value) => z.object({ csrfToken: z.string() }).parse(value),
  });
  if (!result) throw new Error('CSRF unavailable');
  return result.csrfToken;
}

export async function loadManagedItems(organizationId: string): Promise<ManagedItem[]> {
  const result = await client.request('/catalog/items/manage', {
    method: 'GET',
    organizationId,
    parse: (value) => z.object({ items: z.array(itemSchema) }).parse(value),
  });
  if (!result) throw new Error('Empty items response');
  return result.items;
}

export async function createCatalogItem(organizationId: string, input: {
  name: string; type: 'PRODUCT' | 'SERVICE'; trackInventory?: boolean; baseUnit: 'UNIT' | 'FRACTIONAL';
  sku: string | null; barcode: string | null;
}) {
  const result = await client.request('/catalog/items', {
    method: 'POST',
    organizationId,
    csrfToken: await csrfToken(),
    idempotencyKey: crypto.randomUUID(),
    body: input,
    parse: (value) => createResultSchema.parse(value),
  });
  if (!result) throw new Error('Empty item response');
  return result;
}

export async function editCatalogItem(organizationId: string, id: string, version: number,
  input: { name: string; sku: string | null; barcode: string | null }) {
  const result = await client.request(`/catalog/items/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    organizationId,
    csrfToken: await csrfToken(),
    idempotencyKey: crypto.randomUUID(),
    ifMatch: String(version),
    body: input,
    parse: (value) => editResultSchema.parse(value),
  });
  if (!result) throw new Error('Empty item response');
  return result;
}

export async function setCatalogPrice(organizationId: string, id: string, version: number, price: string) {
  const result = await client.request(`/catalog/items/${encodeURIComponent(id)}/price`, {
    method: 'PATCH',
    organizationId,
    csrfToken: await csrfToken(),
    idempotencyKey: crypto.randomUUID(),
    ifMatch: String(version),
    body: { price },
    parse: (value) => priceResultSchema.parse(value),
  });
  if (!result) throw new Error('Empty price response');
  return result;
}

export async function changeCatalogItemStatus(
  organizationId: string,
  id: string,
  version: number,
  status: 'ACTIVE' | 'INACTIVE',
) {
  const result = await client.request(`/catalog/items/${encodeURIComponent(id)}/status`, {
    method: 'PATCH',
    organizationId,
    csrfToken: await csrfToken(),
    idempotencyKey: crypto.randomUUID(),
    ifMatch: String(version),
    body: { status },
    parse: (value) => itemSchema.pick({ id: true, status: true, version: true }).parse(value),
  });
  if (!result) throw new Error('Empty status response');
  return result;
}

export async function deleteCatalogItem(
  organizationId: string,
  id: string,
  version: number,
) {
  const result = await client.request(`/catalog/items/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    organizationId,
    csrfToken: await csrfToken(),
    idempotencyKey: crypto.randomUUID(),
    ifMatch: String(version),
    parse: (value) => z.object({ id: z.string(), deleted: z.literal(true) }).parse(value),
  });
  if (!result) throw new Error('Empty delete response');
  return result;
}

export async function changeCatalogItemStructure(
  organizationId: string,
  id: string,
  version: number,
  input: { type: 'PRODUCT' | 'SERVICE'; baseUnit: 'UNIT' | 'FRACTIONAL'; trackInventory?: boolean },
) {
  const result = await client.request(`/catalog/items/${encodeURIComponent(id)}/structure`, {
    method: 'PATCH',
    organizationId,
    csrfToken: await csrfToken(),
    idempotencyKey: crypto.randomUUID(),
    ifMatch: String(version),
    body: input,
    parse: (value) => itemSchema.pick({ id: true, type: true, baseUnit: true, trackInventory: true, version: true }).parse(value),
  });
  if (!result) throw new Error('Empty structure response');
  return result;
}

export async function lookupSimilarCatalogNames(organizationId: string, name: string): Promise<string[]> {
  const result = await client.request(`/catalog/items/similar?name=${encodeURIComponent(name)}`, {
    method: 'GET',
    organizationId,
    parse: (value) => z.object({ names: z.array(z.string()) }).parse(value),
  });
  return result?.names ?? [];
}

export function explainCatalogError(cause: unknown): ApiProblemError {
  if (cause instanceof ApiProblemError || (typeof cause === 'object' && cause !== null && 'code' in cause)) {
    const errorObj = cause as { code: string; status?: number; message?: string; traceId?: string };
    const code = errorObj.code;
    const status = errorObj.status ?? 409;
    let message = errorObj.message ?? 'Operación no permitida.';

    if (code === 'CATALOG_ITEM_DELETE_BLOCKED_BY_HISTORY') {
      message = 'El ítem posee referencias históricas y solo puede desactivarse.';
    } else if (code === 'CATALOG_ITEM_DELETE_BLOCKED_BY_OFFLINE_UNCERTAINTY') {
      message = 'El ítem pudo haber sido utilizado en operaciones offline pendientes y solo puede desactivarse.';
    } else if (code === 'CATALOG_ITEM_STRUCTURAL_CHANGE_BLOCKED_BY_HISTORY') {
      message = 'El ítem posee referencias históricas y no permite cambios estructurales. Creá un nuevo ítem si necesitás otra configuración.';
    } else if (code === 'CATALOG_ITEM_STRUCTURAL_CHANGE_BLOCKED_BY_OFFLINE_UNCERTAINTY') {
      message = 'El ítem puede tener operaciones offline pendientes bajo la configuración actual. Sincronizá los dispositivos antes de intentar el cambio.';
    } else if (code === 'VERSION_CONFLICT') {
      message = 'El ítem cambió desde que lo cargaste. Volvé a cargar antes de guardar.';
    } else if (code === 'CATALOG_ITEM_STATUS_UNCHANGED') {
      message = 'El ítem ya se encuentra en el estado solicitado.';
    } else if (code === 'CATALOG_ITEM_SERVICE_TRACK_INVENTORY_NOT_ALLOWED') {
      message = 'Los servicios no pueden tener control de inventario.';
    }
    return new ApiProblemError({ status, code, message, traceId: errorObj.traceId });
  }
  return new ApiProblemError({ status: 0, code: 'REQUEST_FAILED', message: 'No pudimos guardar el ítem. Intentá nuevamente.' });
}

export function CatalogItemManagement({
  organizationId,
  items,
  onReload,
  onCreate = createCatalogItem,
  onEdit = editCatalogItem,
  onPrice = setCatalogPrice,
  onLookupSimilar = lookupSimilarCatalogNames,
  onChangeStatus = changeCatalogItemStatus,
  onDelete = deleteCatalogItem,
  onChangeStructure = changeCatalogItemStructure,
}: {
  organizationId: string;
  items: ManagedItem[];
  onReload: () => void;
  onCreate?: typeof createCatalogItem;
  onEdit?: typeof editCatalogItem;
  onPrice?: typeof setCatalogPrice;
  onLookupSimilar?: typeof lookupSimilarCatalogNames;
  onChangeStatus?: typeof changeCatalogItemStatus;
  onDelete?: typeof deleteCatalogItem;
  onChangeStructure?: typeof changeCatalogItemStructure;
}) {
  const [similar, setSimilar] = useState<string[]>([]);
  const [error, setError] = useState<ApiProblemError | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const form = useForm<CreateValues>({
    resolver: zodResolver(createSchema),
    defaultValues: {
      name: '', type: 'PRODUCT', trackInventory: false, baseUnit: 'UNIT', sku: '', barcode: '',
    },
  });
  const type = form.watch('type');

  async function submit(values: CreateValues) {
    setError(null);
    setMessage('');
    setBusy(true);
    try {
      await onCreate(organizationId, {
        name: values.name.trim(),
        type: values.type,
        baseUnit: values.baseUnit,
        ...(values.type === 'PRODUCT' ? { trackInventory: values.trackInventory } : {}),
        sku: values.sku.trim() || null,
        barcode: values.barcode.trim() || null,
      });
      form.reset();
      setSimilar([]);
      setMessage('Ítem creado. Podés definir su precio desde el listado.');
      onReload();
    } catch (cause) {
      setError(explainCatalogError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function findSimilar() {
    const name = form.getValues('name').trim();
    if (!name) { setSimilar([]); return; }
    try { setSimilar(await onLookupSimilar(organizationId, name)); }
    catch { setSimilar([]); }
  }

  return (
    <section className={styles.page} aria-labelledby="items-heading">
      <header className={styles.heading}>
        <h1 id="items-heading">Administrar ítems</h1>
        <p>Creá productos o servicios y actualizá sus datos y precios.</p>
      </header>
      <ErrorSummary error={error} />
      {message ? <p role="status">{message}</p> : null}
      <form className={styles.panel} onSubmit={form.handleSubmit(submit)} noValidate>
        <h2>Ítem nuevo</h2>
        <div className={styles.fields}>
          <div>
            <label htmlFor="item-new-name">Nombre del ítem nuevo</label>
            <input
              id="item-new-name"
              aria-invalid={!!form.formState.errors.name}
              {...form.register('name', { onBlur: () => void findSimilar() })}
            />
            {form.formState.errors.name ? <p role="alert">Ingresá un nombre de hasta 255 caracteres.</p> : null}
          </div>
          <div>
            <label htmlFor="item-new-type">Tipo</label>
            <select id="item-new-type" {...form.register('type')}>
              <option value="PRODUCT">Producto</option>
              <option value="SERVICE">Servicio</option>
            </select>
          </div>
          <div>
            <label htmlFor="item-new-unit">Unidad base</label>
            <select id="item-new-unit" {...form.register('baseUnit')}>
              <option value="UNIT">Unidad</option>
              <option value="FRACTIONAL">Fraccionable</option>
            </select>
          </div>
          <div>
            <label htmlFor="item-new-sku">SKU opcional</label>
            <input id="item-new-sku" {...form.register('sku')} />
          </div>
          <div>
            <label htmlFor="item-new-barcode">Código de barras opcional</label>
            <input id="item-new-barcode" {...form.register('barcode')} />
          </div>
        </div>
        {type === 'PRODUCT' ? (
          <div className={styles.checks}>
            <label>
              <input type="checkbox" {...form.register('trackInventory')} />
              Controlar inventario
            </label>
          </div>
        ) : (
          <p>Los servicios no controlan inventario.</p>
        )}
        <SimilarNameWarning similarNames={similar} />
        <button type="submit" disabled={busy}>{busy ? 'Creando…' : 'Crear ítem'}</button>
      </form>
      <section className={styles.panel} aria-labelledby="items-list-heading">
        <h2 id="items-list-heading">Ítems de la organización</h2>
        {items.length === 0 ? (
          <p>No hay ítems registrados.</p>
        ) : (
          <ul className={styles.rows}>
            {items.map((item) => (
              <li className={styles.row} key={item.id}>
                <strong>{item.name}</strong>
                <span>
                  {item.status === 'ACTIVE' ? 'Activo' : 'Inactivo'} · {item.type === 'PRODUCT' ? 'Producto' : 'Servicio'} · {item.baseUnit === 'UNIT' ? 'Unidad' : 'Fraccionable'} · {item.trackInventory ? 'Control de inventario' : 'Sin control de inventario'}
                </span>
                <span>{item.price === null ? 'Sin precio' : `Precio: ${item.price}`}</span>
                <ItemEditor
                  organizationId={organizationId}
                  item={item}
                  onReload={onReload}
                  onEdit={onEdit}
                  onPrice={onPrice}
                  onChangeStatus={onChangeStatus}
                  onDelete={onDelete}
                  onChangeStructure={onChangeStructure}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}

function ItemEditor({
  organizationId,
  item,
  onReload,
  onEdit,
  onPrice,
  onChangeStatus,
  onDelete,
  onChangeStructure,
}: {
  organizationId: string;
  item: ManagedItem;
  onReload: () => void;
  onEdit: typeof editCatalogItem;
  onPrice: typeof setCatalogPrice;
  onChangeStatus: typeof changeCatalogItemStatus;
  onDelete: typeof deleteCatalogItem;
  onChangeStructure: typeof changeCatalogItemStructure;
}) {
  const [mode, setMode] = useState<'closed' | 'edit' | 'price' | 'structure' | 'delete'>('closed');
  const [error, setError] = useState<ApiProblemError | null>(null);
  const [busy, setBusy] = useState(false);
  const edit = useForm<EditValues>({
    resolver: zodResolver(editSchema),
    defaultValues: {
      name: item.name, sku: item.sku ?? '', barcode: item.barcode ?? '',
    },
  });
  const price = useForm<PriceValues>({ resolver: zodResolver(priceSchema), defaultValues: { price: item.price ?? '' } });
  const structure = useForm<StructuralValues>({
    resolver: zodResolver(structuralSchema),
    defaultValues: {
      type: item.type,
      baseUnit: item.baseUnit,
      trackInventory: item.trackInventory,
    },
  });
  const structureType = structure.watch('type');

  async function saveEdit(values: EditValues) {
    setError(null);
    setBusy(true);
    try {
      await onEdit(organizationId, item.id, item.version, {
        name: values.name.trim(),
        sku: values.sku.trim() || null,
        barcode: values.barcode.trim() || null,
      });
      setMode('closed');
      onReload();
    } catch (cause) {
      setError(explainCatalogError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function savePrice(values: PriceValues) {
    setError(null);
    setBusy(true);
    try {
      await onPrice(organizationId, item.id, item.version, values.price);
      setMode('closed');
      onReload();
    } catch (cause) {
      setError(explainCatalogError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function toggleStatus() {
    setError(null);
    setBusy(true);
    const nextStatus = item.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    try {
      await onChangeStatus(organizationId, item.id, item.version, nextStatus);
      onReload();
    } catch (cause) {
      setError(explainCatalogError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function saveStructure(values: StructuralValues) {
    setError(null);
    setBusy(true);
    try {
      await onChangeStructure(organizationId, item.id, item.version, {
        type: values.type,
        baseUnit: values.baseUnit,
        ...(values.type === 'PRODUCT' ? { trackInventory: values.trackInventory } : { trackInventory: false }),
      });
      setMode('closed');
      onReload();
    } catch (cause) {
      setError(explainCatalogError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete() {
    setError(null);
    setBusy(true);
    try {
      await onDelete(organizationId, item.id, item.version);
      setMode('closed');
      onReload();
    } catch (cause) {
      setError(explainCatalogError(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <ErrorSummary error={error} />
      <div className={styles.actions}>
        <button type="button" onClick={() => setMode(mode === 'edit' ? 'closed' : 'edit')}>
          Editar {item.name}
        </button>
        <button type="button" onClick={() => setMode(mode === 'price' ? 'closed' : 'price')}>
          Cambiar precio de {item.name}
        </button>
        <button type="button" onClick={() => setMode(mode === 'structure' ? 'closed' : 'structure')}>
          Cambiar estructura de {item.name}
        </button>
        <button type="button" onClick={() => void toggleStatus()} disabled={busy}>
          {item.status === 'ACTIVE' ? `Desactivar ${item.name}` : `Activar ${item.name}`}
        </button>
        <button type="button" onClick={() => setMode(mode === 'delete' ? 'closed' : 'delete')}>
          Eliminar {item.name}
        </button>
      </div>
      {mode === 'edit' ? (
        <form onSubmit={edit.handleSubmit(saveEdit)} noValidate>
          <p>
            {item.type === 'PRODUCT' ? 'Producto' : 'Servicio'} · {item.baseUnit === 'UNIT' ? 'Unidad' : 'Fraccionable'} · {item.trackInventory ? 'Control de inventario' : 'Sin control de inventario'}
          </p>
          <div className={styles.fields}>
            <div>
              <label htmlFor={`edit-name-${item.id}`}>Nombre de {item.name}</label>
              <input id={`edit-name-${item.id}`} aria-invalid={!!edit.formState.errors.name} {...edit.register('name')} />
              {edit.formState.errors.name ? <p role="alert">Ingresá un nombre válido.</p> : null}
            </div>
            <div>
              <label htmlFor={`edit-sku-${item.id}`}>SKU de {item.name}</label>
              <input id={`edit-sku-${item.id}`} {...edit.register('sku')} />
            </div>
            <div>
              <label htmlFor={`edit-barcode-${item.id}`}>Código de barras de {item.name}</label>
              <input id={`edit-barcode-${item.id}`} {...edit.register('barcode')} />
            </div>
          </div>
          <button type="submit" disabled={busy}>Guardar cambios de {item.name}</button>
        </form>
      ) : null}
      {mode === 'price' ? (
        <form onSubmit={price.handleSubmit(savePrice)} noValidate>
          <label htmlFor={`price-${item.id}`}>Precio nuevo de {item.name}</label>
          <input
            id={`price-${item.id}`}
            inputMode="decimal"
            aria-invalid={!!price.formState.errors.price}
            {...price.register('price')}
          />
          {price.formState.errors.price ? <p role="alert">Ingresá un importe con dos decimales, por ejemplo 150.00.</p> : null}
          <button type="submit" disabled={busy}>Guardar precio de {item.name}</button>
        </form>
      ) : null}
      {mode === 'structure' ? (
        <form onSubmit={structure.handleSubmit(saveStructure)} noValidate>
          <h3>Estructura de {item.name}</h3>
          <div className={styles.fields}>
            <div>
              <label htmlFor={`structure-type-${item.id}`}>Tipo estructural de {item.name}</label>
              <select id={`structure-type-${item.id}`} {...structure.register('type')}>
                <option value="PRODUCT">Producto</option>
                <option value="SERVICE">Servicio</option>
              </select>
            </div>
            <div>
              <label htmlFor={`structure-unit-${item.id}`}>Unidad de {item.name}</label>
              <select id={`structure-unit-${item.id}`} {...structure.register('baseUnit')}>
                <option value="UNIT">Unidad</option>
                <option value="FRACTIONAL">Fraccionable</option>
              </select>
            </div>
          </div>
          {structureType === 'PRODUCT' ? (
            <div className={styles.checks}>
              <label>
                <input type="checkbox" {...structure.register('trackInventory')} />
                Controlar inventario
              </label>
            </div>
          ) : (
            <p>Los servicios no controlan inventario.</p>
          )}
          <button type="submit" disabled={busy}>Guardar estructura de {item.name}</button>
        </form>
      ) : null}
      {mode === 'delete' ? (
        <div role="region" aria-label={`Confirmar eliminación de ${item.name}`}>
          <p>¿Confirmás eliminar definitivamente {item.name}?</p>
          <p>Si el ítem posee referencias históricas o incertidumbre offline, la operación será rechazada y deberás desactivarlo.</p>
          <div className={styles.actions}>
            <button type="button" onClick={() => void confirmDelete()} disabled={busy}>
              Confirmar eliminación de {item.name}
            </button>
            <button type="button" onClick={() => setMode('closed')} disabled={busy}>
              Cancelar
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
