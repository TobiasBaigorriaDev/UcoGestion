'use client';

import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import styles from '../identity/management.module.css';
import { ErrorSummary } from '../../components/error-summary';
import { ApiProblemError } from '../../lib/api/client';

const schema = z.object({
  currentPin: z.string().min(1, 'Ingresá tu PIN actual.'),
  newPin: z.string().min(8, 'Ingresá un PIN de al menos 8 caracteres.'),
  confirmation: z.string(),
}).refine(value => value.newPin === value.confirmation, { path: ['confirmation'], message: 'Los PIN nuevos no coinciden.' })
  .refine(value => value.newPin !== value.currentPin, { path: ['newPin'], message: 'Elegí un PIN distinto del actual.' });

export function OfflinePinChange({ busy, onChange, onCancel }: {
  busy: boolean; onChange: (currentPin: string, newPin: string) => Promise<void>; onCancel: () => void;
}) {
  const [summary, setSummary] = useState<ApiProblemError | null>(null);
  const { register, handleSubmit, reset, setFocus, formState: { errors } } = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), shouldFocusError: false });
  useEffect(() => { setFocus('currentPin'); }, [setFocus]);
  return <form id="offline-pin-change" className={styles.panel} noValidate aria-labelledby="offline-pin-change-heading"
    onChangeCapture={() => setSummary(null)} onSubmit={handleSubmit(async ({ currentPin, newPin }) => {
      setSummary(null); try { await onChange(currentPin, newPin); } finally { reset(); }
    }, invalid => setSummary(new ApiProblemError({ status: 400, code: 'OFFLINE_PIN_INVALID', message: 'Revisá los campos para cambiar tu PIN.',
      fieldErrors: Object.fromEntries(Object.entries(invalid).map(([field, error]) => [field, error.message ?? 'Revisá este campo.'])) })))}>
    <h2 id="offline-pin-change-heading">Cambiar PIN offline</h2>
    <ErrorSummary error={summary} fieldIds={{ currentPin: 'offline-change-currentPin', newPin: 'offline-change-newPin', confirmation: 'offline-change-confirmation' }}
      fieldLabels={{ currentPin: 'PIN actual', newPin: 'Nuevo PIN', confirmation: 'Confirmar nuevo PIN' }} />
    <p>El cambio se aplica a tu usuario en este equipo. Conserva tus datos y operaciones pendientes, incluso sin conexión.</p>
    <div className={styles.fields}>
      {(['currentPin', 'newPin', 'confirmation'] as const).map(field => <div key={field}>
        <label htmlFor={`offline-change-${field}`}>{field === 'currentPin' ? 'PIN actual' : field === 'newPin' ? 'Nuevo PIN' : 'Confirmar nuevo PIN'}</label>
        <input id={`offline-change-${field}`} type="password" autoComplete={field === 'currentPin' ? 'current-password' : 'new-password'}
          disabled={busy} aria-invalid={!!errors[field]} aria-describedby={errors[field] ? `offline-change-${field}-error` : field === 'newPin' ? 'offline-change-help' : undefined}
          {...register(field)} />
        {errors[field] ? <p id={`offline-change-${field}-error`} role="alert">{errors[field].message}</p> : null}
      </div>)}
    </div>
    <p id="offline-change-help">Al menos 8 caracteres. Elegí uno difícil de adivinar y distinto de tu contraseña de acceso.</p>
    <div className={styles.actions}>
      <button type="submit" disabled={busy}>{busy ? 'Guardando PIN…' : 'Guardar nuevo PIN'}</button>
      <button type="button" disabled={busy} onClick={() => { reset(); onCancel(); }}>Cancelar</button>
    </div>
  </form>;
}
