'use client';

import { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { ApiClient, ApiProblemError } from '../../lib/api/client';
import { ErrorSummary } from '../../components/error-summary';
import styles from './identity.module.css';

export type OrganizationSettingsData = Readonly<{
  profile: Readonly<Record<string, string | null>>;
  timezone: string;
  currency?: string | undefined;
  baseCurrency?: string | undefined;
  role?: 'OWNER' | 'ADMIN' | 'CASHIER' | 'EMPLOYEE' | undefined;
  version: number;
}>;

const client = new ApiClient();
const settingsSchema = z.strictObject({
  profile: z.record(z.string(), z.string().nullable()),
  timezone: z.string(),
  currency: z.string().optional(),
  baseCurrency: z.string().optional(),
  version: z.number().int().positive(),
  role: z.enum(['OWNER', 'ADMIN', 'CASHIER', 'EMPLOYEE']).optional(),
});
const profileResultSchema = z.strictObject({ profile: z.record(z.string(), z.string().nullable()), version: z.number().int().positive() });
const timezoneResultSchema = z.strictObject({ timezone: z.string(), version: z.number().int().positive() });
const currencyResultSchema = z.strictObject({ currency: z.string(), version: z.number().int().positive() });

const profileSchema = z.strictObject({
  displayName: z.string().max(200),
  address: z.string().max(300),
  email: z.union([z.literal(''), z.string().email()]),
  phone: z.string().max(80),
});
const timezoneSchema = z.strictObject({ timezone: z.string().min(1).refine((value) => {
  try { new Intl.DateTimeFormat('es-AR', { timeZone: value }); return true; }
  catch { return false; }
}) });
const currencySchema = z.strictObject({
  currency: z.string().trim().min(3).max(3).toUpperCase(),
});

type ProfileValues = z.infer<typeof profileSchema>;
type TimezoneValues = z.infer<typeof timezoneSchema>;
type CurrencyValues = z.infer<typeof currencySchema>;

async function csrfToken(): Promise<string> {
  return (await client.request('/auth/csrf', { method: 'GET', parse: (value) => {
    if (typeof value !== 'object' || value === null || !('csrfToken' in value) || typeof value.csrfToken !== 'string') throw new Error('Invalid CSRF response');
    return value.csrfToken;
  } })) ?? '';
}

export async function loadOrganizationSettings(organizationId: string): Promise<OrganizationSettingsData> {
  const data = await client.request('/organizations/settings', { method: 'GET', organizationId, parse: (value) => settingsSchema.parse(value) });
  if (!data) throw new Error('Empty settings');
  return data;
}

export async function saveProfile(organizationId: string, version: number, profile: Record<string, string | null>) {
  const result = await client.request('/organizations/profile', { method: 'PATCH', organizationId, csrfToken: await csrfToken(), ifMatch: String(version), body: profile, parse: (value) => profileResultSchema.parse(value) });
  if (!result) throw new Error('Empty profile');
  return result;
}

export async function saveTimezone(organizationId: string, version: number, timezone: string) {
  const result = await client.request('/organizations/timezone', { method: 'PATCH', organizationId, csrfToken: await csrfToken(), ifMatch: String(version), body: { timezone }, parse: (value) => timezoneResultSchema.parse(value) });
  if (!result) throw new Error('Empty timezone');
  return result;
}

export async function saveCurrency(organizationId: string, version: number, targetCurrency: string) {
  const result = await client.request('/organizations/currency', {
    method: 'PATCH',
    organizationId,
    csrfToken: await csrfToken(),
    idempotencyKey: crypto.randomUUID(),
    ifMatch: String(version),
    body: { targetCurrency },
    parse: (value) => currencyResultSchema.parse(value),
  });
  if (!result) throw new Error('Empty currency response');
  return result;
}

function readableError(error: unknown): ApiProblemError {
  if (error instanceof ApiProblemError || (typeof error === 'object' && error !== null && 'code' in error)) {
    const code = (error as { code: string }).code;
    const status = (error as { status?: number }).status ?? 409;
    let message = (error as { message?: string }).message ?? 'No pudimos guardar los cambios.';

    if (code === 'CURRENCY_LOCKED_BY_HISTORY') {
      message = 'La moneda no puede modificarse porque la organización ya registró operaciones comerciales o movimientos con la moneda actual.';
    } else if (code === 'CURRENCY_LOCKED_BY_OFFLINE_UNCERTAINTY') {
      message = 'La moneda no puede modificarse porque existen dispositivos offline con autorizaciones o posibles operaciones pendientes. Sincronizá los dispositivos antes de intentar el cambio.';
    } else if (code === 'CURRENCY_PERMANENTLY_LOCKED') {
      message = 'La moneda está bloqueada permanentemente debido a que un dispositivo irrecuperable pudo haber operado sin sincronizar.';
    } else if (code === 'CURRENCY_CHANGE_FORBIDDEN') {
      message = 'Solo el rol Propietario (OWNER) puede modificar la moneda de la organización.';
    } else if (code === 'VERSION_CONFLICT') {
      message = 'Otra persona modificó la organización. Volvé a cargar para revisar los datos actuales antes de guardar.';
    }
    return new ApiProblemError({ status, code, message });
  }
  return new ApiProblemError({ status: 0, code: 'REQUEST_FAILED', message: 'No pudimos guardar los cambios. Intentá nuevamente.' });
}

export function OrganizationSettings({
  organizationId,
  role,
  initial,
  saveProfile: performProfile = saveProfile,
  saveTimezone: performTimezone = saveTimezone,
  saveCurrency: performCurrency = saveCurrency,
}: {
  organizationId: string;
  role: 'OWNER' | 'ADMIN' | 'CASHIER' | 'EMPLOYEE';
  initial: OrganizationSettingsData;
  saveProfile?: typeof saveProfile;
  saveTimezone?: typeof saveTimezone;
  saveCurrency?: typeof saveCurrency;
}) {
  const [settings, setSettings] = useState(initial);
  const [error, setError] = useState<ApiProblemError | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const canEditProfile = role === 'OWNER' || role === 'ADMIN';
  const profileForm = useForm<ProfileValues>({ resolver: zodResolver(profileSchema), defaultValues: {
    displayName: initial.profile.displayName ?? '', address: initial.profile.address ?? '',
    email: initial.profile.email ?? '', phone: initial.profile.phone ?? '',
  } });
  const timezoneForm = useForm<TimezoneValues>({ resolver: zodResolver(timezoneSchema), defaultValues: { timezone: initial.timezone } });
  const currencyForm = useForm<CurrencyValues>({
    resolver: zodResolver(currencySchema),
    defaultValues: { currency: initial.currency ?? initial.baseCurrency ?? 'ARS' },
  });

  async function submitProfile(data: ProfileValues) {
    setError(null); setMessage(''); setBusy(true);
    const profile = {
      displayName: data.displayName.trim() || null,
      address: data.address.trim() || null,
      email: data.email.trim() || null,
      phone: data.phone.trim() || null,
    };
    try { const result = await performProfile(organizationId, settings.version, profile); setSettings((old) => ({ ...old, profile: result.profile, version: result.version })); setMessage('Perfil comercial actualizado.'); }
    catch (cause) { setError(readableError(cause)); }
    finally { setBusy(false); }
  }

  async function submitTimezone(data: TimezoneValues) {
    setError(null); setMessage(''); setBusy(true);
    try { const result = await performTimezone(organizationId, settings.version, data.timezone.trim()); setSettings((old) => ({ ...old, timezone: result.timezone, version: result.version })); setMessage('Zona horaria actualizada. Los registros históricos conservan su fecha original.'); }
    catch (cause) { setError(readableError(cause)); }
    finally { setBusy(false); }
  }

  async function submitCurrency(data: CurrencyValues) {
    setError(null);
    setMessage('');
    setBusy(true);
    try {
      const result = await performCurrency(organizationId, settings.version, data.currency.trim().toUpperCase());
      setSettings((old) => ({ ...old, currency: result.currency, version: result.version }));
      setMessage('Moneda base actualizada.');
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.form} aria-labelledby="settings-heading">
      <h1 id="settings-heading">Configuración de la organización</h1>
      <ErrorSummary error={error} />
      {error?.code === 'VERSION_CONFLICT' ? <a href="" onClick={(event) => { event.preventDefault(); window.location.reload(); }}>Volver a cargar</a> : null}
      {message ? <p role="status">{message}</p> : null}
      <form className={styles.innerForm} onSubmit={profileForm.handleSubmit(submitProfile)} noValidate>
        <h2>Perfil comercial</h2>
        <label htmlFor="displayName">Nombre comercial</label>
        <input id="displayName" disabled={!canEditProfile || busy} maxLength={200} aria-invalid={!!profileForm.formState.errors.displayName} {...profileForm.register('displayName')} />
        <label htmlFor="address">Dirección comercial</label>
        <input id="address" disabled={!canEditProfile || busy} maxLength={300} aria-invalid={!!profileForm.formState.errors.address} {...profileForm.register('address')} />
        <label htmlFor="profile-email">Correo comercial</label>
        <input id="profile-email" type="email" disabled={!canEditProfile || busy} aria-invalid={!!profileForm.formState.errors.email} {...profileForm.register('email')} />
        {profileForm.formState.errors.email ? <p role="alert">Ingresá un correo comercial válido.</p> : null}
        <label htmlFor="phone">Teléfono comercial</label>
        <input id="phone" type="tel" disabled={!canEditProfile || busy} maxLength={80} aria-invalid={!!profileForm.formState.errors.phone} {...profileForm.register('phone')} />
        {canEditProfile ? <button type="submit" disabled={busy}>Guardar perfil</button> : <p>Tu rol permite consultar estos datos, pero no modificarlos.</p>}
      </form>
      <form className={styles.innerForm} onSubmit={timezoneForm.handleSubmit(submitTimezone)} noValidate>
        <h2>Zona horaria</h2>
        <label htmlFor="timezone">Zona horaria</label>
        <input id="timezone" disabled={role !== 'OWNER' || busy} aria-invalid={!!timezoneForm.formState.errors.timezone} {...timezoneForm.register('timezone')} />
        {timezoneForm.formState.errors.timezone ? <p role="alert">Ingresá una zona horaria IANA válida.</p> : null}
        <p>Solo OWNER puede cambiarla. Los timestamps históricos no se modifican.</p>
        {role === 'OWNER' ? <button type="submit" disabled={busy}>Guardar zona horaria</button> : null}
      </form>
      <form className={styles.innerForm} onSubmit={currencyForm.handleSubmit(submitCurrency)} noValidate>
        <h2>Moneda base</h2>
        <label htmlFor="currency">Moneda base</label>
        <input
          id="currency"
          disabled={role !== 'OWNER' || busy}
          maxLength={3}
          aria-invalid={!!currencyForm.formState.errors.currency}
          {...currencyForm.register('currency')}
        />
        {currencyForm.formState.errors.currency ? <p role="alert">Ingresá un código ISO 4217 de 3 letras (por ejemplo ARS o USD).</p> : null}
        <p>Solo OWNER puede cambiar la moneda base. Si la organización ya registró operaciones o incertidumbre offline, el cambio queda bloqueado.</p>
        {role === 'OWNER' ? <button type="submit" disabled={busy}>Guardar moneda</button> : null}
      </form>
    </section>
  );
}
