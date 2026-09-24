'use client';

import { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { ErrorSummary } from '../../components/error-summary';
import { ApiClient, ApiProblemError } from '../../lib/api/client';
import styles from './identity.module.css';

const client = new ApiClient();
const emailSchema = z.object({ email: z.email() });
const passwordSchema = z.object({ password: z.string().min(12).max(256) });
const genericError = (cause: unknown) => cause instanceof ApiProblemError ? cause : new ApiProblemError({ status: 0, code: 'REQUEST_FAILED', message: 'No pudimos completar la solicitud. Intentá nuevamente.' });

export async function requestPasswordReset(email: string): Promise<void> {
  await client.request('/auth/forgot-password', { method: 'POST', body: { email }, parse: (value) => z.object({ accepted: z.literal(true) }).parse(value) });
}

export async function resetPassword(token: string, password: string): Promise<void> {
  await client.request('/auth/reset-password', { method: 'POST', body: { token, password } });
}

export async function acceptInvitation(token: string, password?: string): Promise<void> {
  await client.request('/auth/accept-invitation', { method: 'POST', body: password === undefined ? { token } : { token, password }, parse: (value) => z.object({ membershipId: z.string(), organizationId: z.string() }).parse(value) });
}

export function ForgotPasswordForm({ request = requestPasswordReset }: { request?: (email: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<ApiProblemError | null>(null);
  const { register, handleSubmit, formState: { errors } } = useForm<z.infer<typeof emailSchema>>({ resolver: zodResolver(emailSchema) });
  async function submit({ email }: z.infer<typeof emailSchema>) {
    setBusy(true); setError(null);
    try { await request(email); setSent(true); }
    catch (cause) { setError(genericError(cause)); }
    finally { setBusy(false); }
  }
  return <form className={styles.form} onSubmit={handleSubmit(submit)} noValidate>
    <h1>Recuperar contraseña</h1><p>Te enviaremos un enlace si el correo está asociado a una cuenta.</p>
    <ErrorSummary error={error} />
    {sent ? <p role="status">Si existe una cuenta con ese correo, recibirás un enlace para restablecer la contraseña.</p> : null}
    <label htmlFor="recovery-email">Correo electrónico</label>
    <input id="recovery-email" type="email" autoComplete="email" aria-invalid={!!errors.email} aria-describedby={errors.email ? 'recovery-email-error' : undefined} {...register('email')} />
    {errors.email ? <p id="recovery-email-error" role="alert">Ingresá un correo electrónico válido.</p> : null}
    <button type="submit" disabled={busy}>{busy ? 'Enviando…' : 'Enviar enlace'}</button>
    <a href="/login">Volver a iniciar sesión</a>
  </form>;
}

export function ResetPasswordForm({ token, resetPassword: reset = resetPassword }: { token: string | null; resetPassword?: (token: string, password: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<ApiProblemError | null>(null);
  const { register, handleSubmit, formState: { errors } } = useForm<z.infer<typeof passwordSchema>>({ resolver: zodResolver(passwordSchema) });
  async function submit({ password }: z.infer<typeof passwordSchema>) {
    if (!token) return;
    setBusy(true); setError(null);
    try { await reset(token, password); setDone(true); }
    catch (cause) { setError(cause instanceof ApiProblemError && cause.status === 400 ? new ApiProblemError({ status: 400, code: 'INVALID_RESET_TOKEN', message: 'El enlace venció o ya se usó. Solicitá otro enlace.' }) : genericError(cause)); }
    finally { setBusy(false); }
  }
  return <form className={styles.form} onSubmit={handleSubmit(submit)} noValidate>
    <h1>Elegí una contraseña nueva</h1>
    {!token ? <p role="alert">Falta el enlace de recuperación. Solicitá uno nuevo.</p> : null}
    <ErrorSummary error={error} />
    {done ? <p role="status">Contraseña actualizada. Ya podés iniciar sesión.</p> : null}
    {!done && token ? <><label htmlFor="reset-password">Nueva contraseña</label>
      <input id="reset-password" type="password" autoComplete="new-password" aria-invalid={!!errors.password} aria-describedby={errors.password ? 'reset-password-error' : undefined} {...register('password')} />
      {errors.password ? <p id="reset-password-error" role="alert">Usá entre 12 y 256 caracteres.</p> : null}
      <button type="submit" disabled={busy}>{busy ? 'Guardando…' : 'Guardar contraseña'}</button></> : null}
    <a href="/forgot-password">Solicitar otro enlace</a><a href="/login">Ir a iniciar sesión</a>
  </form>;
}

export function AcceptInvitationForm({ token, accept = acceptInvitation }: { token: string | null; accept?: (token: string, password?: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<ApiProblemError | null>(null);
  const [existingAccount, setExistingAccount] = useState(false);
  const { register, handleSubmit, formState: { errors } } = useForm<z.infer<typeof passwordSchema>>({ resolver: zodResolver(passwordSchema) });
  async function submit({ password }: z.infer<typeof passwordSchema>) {
    if (!token) return;
    setBusy(true); setError(null);
    try { await accept(token, password); setDone(true); }
    catch (cause) { setError(cause instanceof ApiProblemError && cause.status === 400 ? new ApiProblemError({ status: 400, code: 'INVITATION_NOT_ACCEPTABLE', message: 'No pudimos aceptar la invitación. Si ya tenés cuenta, elegí esa opción; si el enlace venció o se usó, pedí uno nuevo.' }) : genericError(cause)); }
    finally { setBusy(false); }
  }
  async function acceptExisting() {
    if (!token) return;
    setBusy(true); setError(null);
    try { await accept(token); setDone(true); }
    catch (cause) { setError(cause instanceof ApiProblemError && cause.status === 400 ? new ApiProblemError({ status: 400, code: 'INVITATION_NOT_ACCEPTABLE', message: 'No pudimos aceptar la invitación. Si el enlace venció o se usó, pedí uno nuevo.' }) : genericError(cause)); }
    finally { setBusy(false); }
  }
  return <form className={styles.form} onSubmit={handleSubmit(submit)} noValidate>
    <h1>Aceptar invitación</h1><p>Elegí cómo activar tu acceso.</p>
    {!token ? <p role="alert">Falta el enlace de invitación. Pedí uno nuevo.</p> : null}
    <ErrorSummary error={error} />
    {done ? <p role="status">Invitación aceptada. Ya podés iniciar sesión.</p> : null}
    {!done && token ? <><label><input type="checkbox" checked={existingAccount} onChange={(event) => setExistingAccount(event.target.checked)} /> Ya tengo una cuenta</label>
      {!existingAccount ? <><label htmlFor="invite-password">Crear contraseña</label>
      <input id="invite-password" type="password" autoComplete="new-password" aria-invalid={!!errors.password} aria-describedby={errors.password ? 'invite-password-error' : undefined} {...register('password')} />
      {errors.password ? <p id="invite-password-error" role="alert">Usá entre 12 y 256 caracteres.</p> : null}
      <button type="submit" disabled={busy}>{busy ? 'Aceptando…' : 'Aceptar invitación'}</button></> : <button type="button" disabled={busy} onClick={() => void acceptExisting()}>{busy ? 'Aceptando…' : 'Aceptar con mi cuenta'}</button>}</> : null}
    <a href="/login">Ir a iniciar sesión</a>
  </form>;
}
