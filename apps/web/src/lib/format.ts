import { formatMoneyForDisplay } from '@uconext/shared';

/** One money format for the whole interface: `$ 1.800,00`. Exact over the API's decimal strings. */
export function formatMoney(value: string, currency = 'ARS'): string {
  return formatMoneyForDisplay(value, currency);
}

const roleLabels: Readonly<Record<string, string>> = {
  OWNER: 'Dueño', ADMIN: 'Administrador', CASHIER: 'Cajero', EMPLOYEE: 'Empleado',
};

export function roleLabel(role: string): string {
  return roleLabels[role] ?? role;
}

const paymentMethodLabels: Readonly<Record<string, string>> = {
  CASH: 'Efectivo', DEBIT_CARD: 'Débito', CREDIT_CARD: 'Crédito', TRANSFER: 'Transferencia', QR: 'QR', CARD: 'Tarjeta',
};

export function paymentMethodLabel(method: string): string {
  return paymentMethodLabels[method] ?? method;
}

const shiftStatusLabels: Readonly<Record<string, string>> = {
  OPEN: 'Abierta', CLOSING: 'En cierre', CLOSED: 'Cerrada', CONFLICTED: 'Con conflicto',
  CLOSED_WITH_UNRECOVERED_DEVICE: 'Cerrada sin equipo recuperado', CLOSED_CONFLICT_RESOLVED: 'Cerrada tras resolver conflicto',
};

/** Cash shift (internally "cash session") status in shop language. */
export function shiftStatusLabel(status: string): string {
  return shiftStatusLabels[status] ?? status;
}
