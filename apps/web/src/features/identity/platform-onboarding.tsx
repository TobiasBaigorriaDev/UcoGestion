'use client';

import { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { ApiClient, ApiProblemError } from '../../lib/api/client';
import { ErrorSummary } from '../../components/error-summary';
import styles from './identity.module.css';

type ProvisionCommand = Readonly<{
  organizationName: string;
  firstBranchName: string;
  ownerEmail: string;
  ownerPassword: string;
  timezone: string;
  requestId: string;
}>;
type ProvisionResult = Readonly<{ organizationId: string; branchId: string; userId: string; membershipId: string }>;
const provisionResultSchema = z.strictObject({
  organizationId: z.uuid(), branchId: z.uuid(), userId: z.uuid(), membershipId: z.uuid(),
});
const onboardingSchema = z.strictObject({
  organizationName: z.string().trim().min(1).max(200),
  firstBranchName: z.string().trim().min(1).max(160),
  ownerEmail: z.email(),
  ownerPassword: z.string().min(12).max(256),
  timezone: z.string().trim().min(1).refine((timezone) => {
    try { new Intl.DateTimeFormat('es-AR', { timeZone: timezone }); return true; }
    catch { return false; }
  }),
});
type OnboardingValues = z.infer<typeof onboardingSchema>;

const client = new ApiClient();

export async function provisionOrganization(command: ProvisionCommand): Promise<ProvisionResult> {
  const csrf = await client.request('/auth/csrf', { method: 'GET', parse: (value) => {
    if (typeof value !== 'object' || value === null || !('csrfToken' in value) || typeof value.csrfToken !== 'string') throw new Error('Invalid CSRF response');
    return value.csrfToken;
  } });
  if (!csrf) throw new Error('CSRF unavailable');
  const result = await client.request('/platform/organizations', { method: 'POST', csrfToken: csrf, body: command, parse: (value) => provisionResultSchema.parse(value) });
  if (!result) throw new Error('Empty provisioning result');
  return result;
}

export function PlatformOnboarding({ provision = provisionOrganization }: { provision?: (command: ProvisionCommand) => Promise<ProvisionResult> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiProblemError | null>(null);
  const [result, setResult] = useState<ProvisionResult | null>(null);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const { register, handleSubmit, formState: { errors } } = useForm<OnboardingValues>({
    resolver: zodResolver(onboardingSchema),
    defaultValues: { timezone: 'America/Argentina/Buenos_Aires' },
  });

  async function submit(data: OnboardingValues) {
    setBusy(true); setError(null);
    try {
      const created = await provision({
        ...data,
        requestId,
      });
      setResult(created);
    } catch (cause) {
      const detail = cause instanceof ApiProblemError && cause.status === 403
        ? 'No tenés permisos de plataforma para crear organizaciones.'
        : cause instanceof ApiProblemError && (cause.status === 0 || cause.status >= 500)
          ? 'No pudimos confirmar el resultado. Reintentá sin cambiar los datos para consultar la misma solicitud; no inicies otra alta.'
          : 'No se creó la organización. La operación se revirtió completa; revisá los datos e intentá nuevamente.';
      setError(new ApiProblemError({ status: 0, code: 'PROVISION_FAILED', message: detail }));
    } finally { setBusy(false); }
  }

  if (result) return <section className={styles.form} role="status">
    <h1>Organización creada</h1>
    <p>Se confirmaron la organización, su primera sucursal y la membresía OWNER en una sola operación.</p>
    <dl><dt>ID de organización</dt><dd>{result.organizationId}</dd><dt>ID de sucursal</dt><dd>{result.branchId}</dd></dl>
    <button type="button" onClick={() => { setResult(null); setRequestId(crypto.randomUUID()); }}>Crear otra organización</button>
  </section>;

  return <form className={styles.form} onSubmit={handleSubmit(submit)} onChange={() => setRequestId(crypto.randomUUID())} noValidate>
    <h1>Crear organización</h1>
    <p>Alta asistida de plataforma. La nueva organización tendrá ARS como moneda base.</p>
    <ErrorSummary error={error} />
    <label htmlFor="organizationName">Nombre de la organización</label>
    <input id="organizationName" maxLength={200} aria-invalid={!!errors.organizationName} {...register('organizationName')} />
    {errors.organizationName ? <p role="alert">Ingresá el nombre de la organización.</p> : null}
    <label htmlFor="firstBranchName">Primera sucursal</label>
    <input id="firstBranchName" maxLength={160} aria-invalid={!!errors.firstBranchName} {...register('firstBranchName')} />
    {errors.firstBranchName ? <p role="alert">Ingresá la primera sucursal.</p> : null}
    <label htmlFor="ownerEmail">Correo del OWNER</label>
    <input id="ownerEmail" type="email" autoComplete="off" aria-invalid={!!errors.ownerEmail} {...register('ownerEmail')} />
    {errors.ownerEmail ? <p role="alert">Ingresá un correo válido.</p> : null}
    <label htmlFor="ownerPassword">Contraseña inicial del OWNER</label>
    <input id="ownerPassword" type="password" autoComplete="new-password" aria-invalid={!!errors.ownerPassword} {...register('ownerPassword')} />
    {errors.ownerPassword ? <p role="alert">Usá una contraseña de al menos 12 caracteres.</p> : null}
    <label htmlFor="onboardingTimezone">Zona horaria</label>
    <input id="onboardingTimezone" aria-invalid={!!errors.timezone} {...register('timezone')} />
    {errors.timezone ? <p role="alert">Ingresá una zona horaria IANA válida.</p> : null}
    <button type="submit" disabled={busy}>{busy ? 'Creando…' : 'Crear organización'}</button>
  </form>;
}
