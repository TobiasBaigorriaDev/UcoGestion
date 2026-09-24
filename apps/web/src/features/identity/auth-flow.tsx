'use client';

import { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { ApiClient, ApiProblemError } from '../../lib/api/client';
import { ErrorSummary } from '../../components/error-summary';
import styles from './identity.module.css';
import { useIdentityContext } from './identity-context';

export type Membership = Readonly<{
  organizationId: string;
  organizationName: string;
  role: 'OWNER' | 'ADMIN' | 'CASHIER' | 'EMPLOYEE';
}>;

const client = new ApiClient();
const loginSchema = z.strictObject({ email: z.email(), password: z.string().min(1) });
type LoginValues = z.infer<typeof loginSchema>;
const membershipSchema = z.strictObject({
  organizationId: z.uuid(), organizationName: z.string(),
  role: z.enum(['OWNER', 'ADMIN', 'CASHIER', 'EMPLOYEE']),
});

function errorFor(error: unknown): ApiProblemError {
  return error instanceof ApiProblemError ? error : new ApiProblemError({ status: 0, code: 'REQUEST_FAILED', message: 'No pudimos completar la solicitud. Intentá nuevamente.' });
}

function parseMemberships(value: unknown): Membership[] {
  return z.strictObject({ organizations: z.array(membershipSchema) }).parse(value).organizations;
}

export async function loadMemberships(): Promise<Membership[]> {
  return (await client.request('/organizations', { method: 'GET', parse: parseMemberships })) ?? [];
}

export async function login(email: string, password: string): Promise<void> {
  await client.request('/auth/login', { method: 'POST', body: { email, password } });
}

export async function selectOrganization(id: string): Promise<void> {
  const csrf = await client.request('/auth/csrf', { method: 'GET', parse: (value) => {
    if (typeof value !== 'object' || value === null || !('csrfToken' in value) || typeof value.csrfToken !== 'string') throw new Error('Invalid CSRF');
    return value.csrfToken;
  } });
  if (!csrf) throw new Error('CSRF unavailable');
  await client.request(`/organizations/${encodeURIComponent(id)}/select`, { method: 'POST', csrfToken: csrf, parse: (value) => value });
}

export function LoginForm({ login: performLogin = login, onSuccess = () => { window.location.assign('/organizations/select'); } }: {
  login?: (email: string, password: string) => Promise<void>;
  onSuccess?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiProblemError | null>(null);
  const { register, handleSubmit, formState: { errors } } = useForm<LoginValues>({ resolver: zodResolver(loginSchema) });
  async function submit(data: LoginValues) {
    setBusy(true); setError(null);
    try { await performLogin(data.email, data.password); onSuccess(); }
    catch (cause) { setError(errorFor(cause)); }
    finally { setBusy(false); }
  }
  return <form className={styles.form} onSubmit={handleSubmit(submit)} noValidate>
    <h1>Iniciar sesión</h1>
    <p>Ingresá para elegir tu organización y continuar trabajando.</p>
    <ErrorSummary error={error} />
    <label htmlFor="login-email">Correo electrónico</label>
    <input id="login-email" type="email" autoComplete="email" aria-invalid={!!errors.email} aria-describedby={errors.email ? 'login-email-error' : undefined} {...register('email')} />
    {errors.email ? <p id="login-email-error" role="alert">Ingresá un correo electrónico válido.</p> : null}
    <label htmlFor="login-password">Contraseña</label>
    <input id="login-password" type="password" autoComplete="current-password" aria-invalid={!!errors.password} aria-describedby={errors.password ? 'login-password-error' : undefined} {...register('password')} />
    {errors.password ? <p id="login-password-error" role="alert">Ingresá tu contraseña.</p> : null}
    <button type="submit" disabled={busy}>{busy ? 'Ingresando…' : 'Iniciar sesión'}</button>
    <a href="/forgot-password">Olvidé mi contraseña</a>
  </form>;
}

export function OrganizationSelector({ organizations, select = selectOrganization, onSuccess = () => { window.location.assign('/workspace'); } }: {
  organizations: readonly Membership[];
  select?: (id: string) => Promise<void>;
  onSuccess?: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<ApiProblemError | null>(null);
  const setActiveOrganizationId = useIdentityContext((state) => state.setActiveOrganizationId);
  async function choose(id: string) {
    setBusyId(id); setError(null);
    try { await select(id); setActiveOrganizationId(id); onSuccess(); }
    catch (cause) { setError(errorFor(cause)); }
    finally { setBusyId(null); }
  }
  return <section className={styles.form} aria-labelledby="organization-heading">
    <h1 id="organization-heading">Elegí una organización</h1>
    <p>Podés cambiarla más adelante desde el contexto de trabajo.</p>
    <ErrorSummary error={error} />
    {organizations.length === 0 ? <p>No tenés organizaciones activas. Contactá a quien administra tu cuenta.</p> : <ul className={styles.list}>{organizations.map((organization) => <li key={organization.organizationId}>
      <button type="button" disabled={busyId !== null} onClick={() => void choose(organization.organizationId)}>
        {organization.organizationName} <span>{organization.role}</span>{busyId === organization.organizationId ? ' · Seleccionando…' : ''}
      </button>
    </li>)}</ul>}
  </section>;
}
