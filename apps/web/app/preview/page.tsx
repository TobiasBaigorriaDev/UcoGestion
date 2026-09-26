'use client';

import { useState } from 'react';

import { CustomerManagement, type ManagedCustomer } from '../../src/features/customers/customer-management';
import { SupplierManagement, type ManagedSupplier } from '../../src/features/suppliers/supplier-management';
import { CashRegisterManagement, type ManagedCashRegister } from '../../src/features/cash/cash-register-management';
import { PaymentMethodsManagement, type ManagedPaymentMethod } from '../../src/features/organizations/payment-methods-management';
import { OrganizationSettings } from '../../src/features/identity/organization-settings';
import { CatalogItemManagement, type ManagedItem } from '../../src/features/catalog/catalog-item-management';

const initialCustomers: ManagedCustomer[] = [
  {
    id: 'c-1',
    name: 'Distribuidora Los Andes SRL',
    taxId: '30-71234567-8',
    contact: 'compras@losandes.com.ar | Tel: (261) 420-1122',
    address: 'Av. San Martín 450, Mendoza',
    notes: 'Cliente mayorista con cuenta corriente 15 días',
    status: 'ACTIVE',
    version: 1,
    createdAt: '2026-09-01T10:00:00Z',
    updatedAt: '2026-09-01T10:00:00Z',
  },
  {
    id: 'c-2',
    name: 'Almacén Don Pedro',
    taxId: '20-28999888-3',
    contact: '+54 9 2622 555-1234',
    address: 'Belgrano 120, Tunuyán',
    notes: 'Consumidor final habitual de mostrador',
    status: 'ACTIVE',
    version: 1,
    createdAt: '2026-09-02T11:00:00Z',
    updatedAt: '2026-09-02T11:00:00Z',
  },
  {
    id: 'c-3',
    name: 'Kiosco Central (Inactivo)',
    taxId: null,
    contact: null,
    address: null,
    notes: 'Cerró sucursal en agosto',
    status: 'INACTIVE',
    version: 2,
    createdAt: '2026-08-15T09:00:00Z',
    updatedAt: '2026-09-10T14:00:00Z',
  },
];

const initialSuppliers: ManagedSupplier[] = [
  {
    id: 's-1',
    name: 'Molinos del Valle S.A.',
    taxId: '30-55443322-1',
    contact: 'ventas@molinosvalle.com.ar | Tel: (2622) 42-5000',
    address: 'Ruta 40 Km 80, Tupungato',
    notes: 'Proveedor principal de harinas y cereales',
    status: 'ACTIVE',
    version: 1,
    createdAt: '2026-08-01T08:00:00Z',
    updatedAt: '2026-08-01T08:00:00Z',
  },
  {
    id: 's-2',
    name: 'Bodega La Consulta',
    taxId: '30-66778899-4',
    contact: 'contacto@laconsulta.com',
    address: 'Eugenio Bustos, San Carlos',
    notes: 'Vinos regionales y espumantes',
    status: 'ACTIVE',
    version: 1,
    createdAt: '2026-08-10T12:00:00Z',
    updatedAt: '2026-08-10T12:00:00Z',
  },
];

const initialRegisters: ManagedCashRegister[] = [
  { id: 'r-1', branchId: 'b-1', name: 'Caja Mostrador 1', status: 'ACTIVE', version: 1 },
  { id: 'r-2', branchId: 'b-1', name: 'Caja Mostrador 2 (Rápida)', status: 'ACTIVE', version: 1 },
  { id: 'r-3', branchId: 'b-1', name: 'Caja Depósito (Cerrada)', status: 'INACTIVE', version: 2 },
  { id: 'r-4', branchId: 'b-2', name: 'Caja Principal Tupungato', status: 'ACTIVE', version: 1 },
];

const initialPaymentMethods: ManagedPaymentMethod[] = [
  { method: 'CASH', enabled: true },
  { method: 'DEBIT_CARD', enabled: true },
  { method: 'CREDIT_CARD', enabled: true },
  { method: 'TRANSFER', enabled: true },
  { method: 'QR', enabled: false },
];

const initialItems: ManagedItem[] = [
  {
    id: 'i-1',
    name: 'Aceite de Oliva Extra Virgen 500ml',
    sku: 'OLIV-500',
    barcode: '7791234567890',
    baseUnit: 'UNIT',
    type: 'PRODUCT',
    status: 'ACTIVE',
    price: '4500.00',
    priceVersion: 1,
    trackInventory: true,
    version: 1,
  },
  {
    id: 'i-2',
    name: 'Vino Malbec Reserva 750ml',
    sku: 'MALB-RES',
    barcode: '7799876543210',
    baseUnit: 'UNIT',
    type: 'PRODUCT',
    status: 'ACTIVE',
    price: '9800.00',
    priceVersion: 1,
    trackInventory: true,
    version: 1,
  },
  {
    id: 'i-3',
    name: 'Servicio de Envíos Locales',
    sku: 'SERV-ENV',
    barcode: null,
    baseUnit: 'UNIT',
    type: 'SERVICE',
    status: 'ACTIVE',
    price: '1500.00',
    priceVersion: 1,
    trackInventory: false,
    version: 1,
  },
];

type TabKey = 'customers' | 'suppliers' | 'cash-registers' | 'payment-methods' | 'settings' | 'catalog-items';

export default function VisualPreviewPage() {
  const [activeTab, setActiveTab] = useState<TabKey>('customers');
  const [role, setRole] = useState<'OWNER' | 'ADMIN' | 'CASHIER' | 'EMPLOYEE'>('OWNER');

  const [customers, setCustomers] = useState<ManagedCustomer[]>(initialCustomers);
  const [suppliers, setSuppliers] = useState<ManagedSupplier[]>(initialSuppliers);
  const [registers, setRegisters] = useState<ManagedCashRegister[]>(initialRegisters);
  const [methods, setMethods] = useState<ManagedPaymentMethod[]>(initialPaymentMethods);
  const [items, setItems] = useState<ManagedItem[]>(initialItems);

  const tabs: Array<{ key: TabKey; label: string }> = [
    { key: 'customers', label: 'Clientes (T095B)' },
    { key: 'suppliers', label: 'Proveedores (T095G)' },
    { key: 'cash-registers', label: 'Cajas (T095C)' },
    { key: 'payment-methods', label: 'Medios de Pago (T095H)' },
    { key: 'settings', label: 'Moneda Base / Config (T095D)' },
    { key: 'catalog-items', label: 'Ítems Catálogo (T095F)' },
  ];

  return (
    <div style={{ minHeight: '100vh', backgroundColor: '#f8fafc', color: '#0f172a', fontFamily: 'system-ui, sans-serif' }}>
      {/* Top Banner */}
      <header style={{ backgroundColor: '#1e293b', color: '#f8fafc', padding: '1rem 1.5rem', borderBottom: '1px solid #334155' }}>
        <div style={{ maxWidth: '1200px', margin: '0 auto', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
          <div>
            <h1 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 700, color: '#38bdf8' }}>
              UcoGestión — Visual Showcase & Preview
            </h1>
            <p style={{ margin: '0.25rem 0 0', fontSize: '0.875rem', color: '#94a3b8' }}>
              Vista previa interactiva sin necesidad de base de datos ni credenciales.
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', backgroundColor: '#0f172a', padding: '0.4rem 0.8rem', borderRadius: '0.5rem' }}>
            <label htmlFor="role-select" style={{ fontSize: '0.8125rem', color: '#cbd5e1' }}>Rol simulado:</label>
            <select
              id="role-select"
              value={role}
              onChange={(e) => setRole(e.target.value as typeof role)}
              style={{ backgroundColor: '#1e293b', color: '#f8fafc', border: '1px solid #475569', borderRadius: '0.375rem', padding: '0.25rem 0.5rem', fontSize: '0.8125rem' }}
            >
              <option value="OWNER">OWNER (Propietario)</option>
              <option value="ADMIN">ADMIN (Administrador)</option>
              <option value="CASHIER">CASHIER (Cajero)</option>
              <option value="EMPLOYEE">EMPLOYEE (Empleado)</option>
            </select>
          </div>
        </div>

        {/* Navigation Tabs */}
        <nav style={{ maxWidth: '1200px', margin: '1rem auto 0', display: 'flex', gap: '0.5rem', overflowX: 'auto', paddingBottom: '0.25rem' }}>
          {tabs.map((tab) => {
            const isActive = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => setActiveTab(tab.key)}
                style={{
                  padding: '0.5rem 1rem',
                  fontSize: '0.875rem',
                  fontWeight: isActive ? 600 : 400,
                  color: isActive ? '#0f172a' : '#cbd5e1',
                  backgroundColor: isActive ? '#ffffff' : 'transparent',
                  border: 'none',
                  borderRadius: '0.375rem 0.375rem 0 0',
                  cursor: 'pointer',
                  transition: 'background-color 0.15s',
                }}
              >
                {tab.label}
              </button>
            );
          })}
        </nav>
      </header>

      {/* Main Content Area */}
      <main style={{ maxWidth: '1200px', margin: '2rem auto', padding: '0 1rem' }}>
        <div style={{ backgroundColor: '#ffffff', borderRadius: '0.75rem', border: '1px solid #e2e8f0', padding: '1.5rem', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
          {activeTab === 'customers' ? (
            <CustomerManagement
              organizationId="org-demo"
              role={role}
              customers={customers}
              onReload={() => {}}
              onCreate={async (_org, input) => {
                const newCustomer: ManagedCustomer = {
                  id: `c-${Date.now()}`,
                  name: input.name,
                  taxId: input.taxId ?? null,
                  contact: input.contact ?? null,
                  address: input.address ?? null,
                  notes: input.notes ?? null,
                  status: 'ACTIVE',
                  version: 1,
                  createdAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                };
                setCustomers((prev) => [newCustomer, ...prev]);
                return newCustomer;
              }}
              onEdit={async (_org, id, version, input) => {
                let updated = customers.find((c) => c.id === id)!;
                setCustomers((prev) =>
                  prev.map((c) => {
                    if (c.id === id) {
                      updated = { ...c, ...input, version: version + 1 };
                      return updated;
                    }
                    return c;
                  })
                );
                return updated;
              }}
              onChangeStatus={async (_org, id, version, status) => {
                let updated = customers.find((c) => c.id === id)!;
                setCustomers((prev) =>
                  prev.map((c) => {
                    if (c.id === id) {
                      updated = { ...c, status, version: version + 1 };
                      return updated;
                    }
                    return c;
                  })
                );
                return updated;
              }}
              onDelete={async (_org, id) => {
                setCustomers((prev) => prev.filter((c) => c.id !== id));
                return { id, deleted: true as const };
              }}
            />
          ) : activeTab === 'suppliers' ? (
            <SupplierManagement
              organizationId="org-demo"
              role={role}
              suppliers={suppliers}
              onReload={() => {}}
              onCreate={async (_org, input) => {
                const newSupplier: ManagedSupplier = {
                  id: `s-${Date.now()}`,
                  name: input.name,
                  taxId: input.taxId ?? null,
                  contact: input.contact ?? null,
                  address: input.address ?? null,
                  notes: input.notes ?? null,
                  status: 'ACTIVE',
                  version: 1,
                  createdAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                };
                setSuppliers((prev) => [newSupplier, ...prev]);
                return newSupplier;
              }}
              onEdit={async (_org, id, version, input) => {
                let updated = suppliers.find((s) => s.id === id)!;
                setSuppliers((prev) =>
                  prev.map((s) => {
                    if (s.id === id) {
                      updated = { ...s, ...input, version: version + 1 };
                      return updated;
                    }
                    return s;
                  })
                );
                return updated;
              }}
              onChangeStatus={async (_org, id, version, status) => {
                let updated = suppliers.find((s) => s.id === id)!;
                setSuppliers((prev) =>
                  prev.map((s) => {
                    if (s.id === id) {
                      updated = { ...s, status, version: version + 1 };
                      return updated;
                    }
                    return s;
                  })
                );
                return updated;
              }}
              onDelete={async (_org, id) => {
                setSuppliers((prev) => prev.filter((s) => s.id !== id));
                return { id, deleted: true as const };
              }}
            />
          ) : activeTab === 'cash-registers' ? (
            <CashRegisterManagement
              organizationId="org-demo"
              role={role}
              branches={[
                { id: 'b-1', name: 'Sucursal 1 — Casa Central' },
                { id: 'b-2', name: 'Sucursal 2 — Tupungato' },
              ]}
              selectedBranchId="b-1"
              cashRegisters={registers}
              onReload={() => {}}
              onCreate={async (_org, branchId, name) => {
                const newReg: ManagedCashRegister = {
                  id: `r-${Date.now()}`,
                  branchId,
                  name,
                  status: 'ACTIVE',
                  version: 1,
                };
                setRegisters((prev) => [...prev, newReg]);
                return newReg;
              }}
              onRename={async (_org, _branchId, regId, version, name) => {
                let updated = registers.find((r) => r.id === regId)!;
                setRegisters((prev) =>
                  prev.map((r) => {
                    if (r.id === regId) {
                      updated = { ...r, name, version: version + 1 };
                      return updated;
                    }
                    return r;
                  })
                );
                return updated;
              }}
              onDeactivate={async (_org, _branchId, regId, version) => {
                let updated = registers.find((r) => r.id === regId)!;
                setRegisters((prev) =>
                  prev.map((r) => {
                    if (r.id === regId) {
                      updated = { ...r, status: 'INACTIVE', version: version + 1 };
                      return updated;
                    }
                    return r;
                  })
                );
                return updated;
              }}
            />
          ) : activeTab === 'payment-methods' ? (
            <PaymentMethodsManagement
              organizationId="org-demo"
              role={role}
              methods={methods}
              onReload={() => {}}
              onToggle={async (_org, method, enabled) => {
                setMethods((prev) =>
                  prev.map((m) => (m.method === method ? { ...m, enabled } : m))
                );
                return { method, enabled };
              }}
            />
          ) : activeTab === 'settings' ? (
            <OrganizationSettings
              organizationId="org-demo"
              role={role}
              initial={{
                profile: {
                  displayName: 'Uco Gestión Comercial Demo',
                  address: 'Av. San Martín 1024, Tunuyán, Mendoza',
                  email: 'contacto@ucodigital.com',
                  phone: '+54 2622 422000',
                },
                timezone: 'America/Argentina/Mendoza',
                baseCurrency: 'ARS',
                currency: 'ARS',
                version: 1,
              }}
            />
          ) : (
            <CatalogItemManagement
              organizationId="org-demo"
              items={items}
              onReload={() => {}}
              onChangeStatus={async (_org, id, version, status) => {
                setItems((prev) =>
                  prev.map((item) => (item.id === id ? { ...item, status, version: version + 1 } : item))
                );
                const current = items.find((i) => i.id === id)!;
                return { id: current.id, status, version: version + 1 };
              }}
              onDelete={async (_org, id) => {
                setItems((prev) => prev.filter((item) => item.id !== id));
                return { id, deleted: true as const };
              }}
              onChangeStructure={async (_org, id, version, input) => {
                setItems((prev) =>
                  prev.map((item) =>
                    item.id === id
                      ? {
                          ...item,
                          type: input.type,
                          baseUnit: input.baseUnit,
                          trackInventory: input.trackInventory ?? false,
                          version: version + 1,
                        }
                      : item
                  )
                );
                return {
                  id,
                  type: input.type,
                  baseUnit: input.baseUnit,
                  trackInventory: input.trackInventory ?? false,
                  version: version + 1,
                };
              }}
            />
          )}
        </div>
      </main>
    </div>
  );
}
