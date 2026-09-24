'use client';

import { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { ErrorSummary } from '../../components/error-summary';
import { ApiClient, ApiProblemError } from '../../lib/api/client';
import styles from './management.module.css';

const roleSchema = z.enum(['OWNER', 'ADMIN', 'CASHIER', 'EMPLOYEE']);
const branchSchema = z.object({ id: z.string(), name: z.string(), status: z.enum(['ACTIVE', 'INACTIVE']) });
const memberSchema = z.object({ id: z.string(), email: z.string(), role: roleSchema, status: z.enum(['ACTIVE', 'INACTIVE', 'REVOKED']), version: z.number().int(), branchIds: z.array(z.string()), hasOutsideScope: z.boolean() });
const invitationSchema = z.object({ id: z.string(), email: z.string(), role: roleSchema, status: z.string(), expiresAt: z.string(), branchIds: z.array(z.string()) });
const dataSchema = z.object({ actorRole: roleSchema, branches: z.array(branchSchema), memberships: z.array(memberSchema), invitations: z.array(invitationSchema) });
const inviteSchema = z.object({ email: z.email(), role: roleSchema });
export type UserManagementData = z.infer<typeof dataSchema>;
type Role = z.infer<typeof roleSchema>;
type InviteValues = z.infer<typeof inviteSchema>;
const client = new ApiClient();

async function mutation<T>(organizationId: string, path: string, method: 'POST' | 'PATCH' | 'DELETE', schema: z.ZodType<T>, body?: unknown, version?: number): Promise<T> {
  const csrf = await client.request('/auth/csrf', { method: 'GET', parse: (value) => z.object({ csrfToken: z.string() }).parse(value) });
  if (!csrf) throw new Error('CSRF unavailable');
  const result = await client.request(path, { method, organizationId, csrfToken: csrf.csrfToken, idempotencyKey: crypto.randomUUID(), ...(version === undefined ? {} : { ifMatch: String(version) }), body, parse: (value) => schema.parse(value) });
  if (!result) throw new Error('Empty response');
  return result;
}

export async function loadUserManagement(organizationId: string): Promise<UserManagementData> {
  const data = await client.request('/users/management', { method: 'GET', organizationId, parse: (value) => dataSchema.parse(value) });
  if (!data) throw new Error('Empty response');
  return data;
}
export async function inviteUser(organizationId: string, email: string, role: Role, branchIds: string[]) {
  return mutation(organizationId, '/users/invitations', 'POST', z.object({ invitationId: z.string(), expiresAt: z.string() }), { email, role, branchIds });
}
export async function revokeInvitation(organizationId: string, id: string) {
  return mutation(organizationId, `/users/invitations/${encodeURIComponent(id)}`, 'DELETE', z.object({ invitationId: z.string(), status: z.literal('REVOKED') }));
}
export async function resendInvitation(organizationId: string, id: string) {
  return mutation(organizationId, `/users/invitations/${encodeURIComponent(id)}/resend`, 'POST', z.object({ invitationId: z.string(), expiresAt: z.string() }));
}
export async function changeMembershipRole(organizationId: string, id: string, version: number, role: Role, branchIds: string[]) {
  return mutation(organizationId, `/users/memberships/${encodeURIComponent(id)}/role`, 'PATCH', z.object({ role: roleSchema, version: z.number().int() }), { role, branchIds }, version);
}
export async function changeMembershipStatus(organizationId: string, id: string, version: number, status: 'ACTIVE' | 'INACTIVE') {
  return mutation(organizationId, `/users/memberships/${encodeURIComponent(id)}/status`, 'PATCH', z.object({ status: z.enum(['ACTIVE', 'INACTIVE']), version: z.number().int() }), { status }, version);
}
export async function revokeMembership(organizationId: string, id: string, version: number) {
  return mutation(organizationId, `/users/memberships/${encodeURIComponent(id)}`, 'DELETE', z.object({ revokedAt: z.string(), version: z.number().int() }), undefined, version);
}

function asError(cause: unknown): ApiProblemError {
  if (cause instanceof ApiProblemError && (cause.code === 'MEMBERSHIP_VERSION_CONFLICT' || cause.code === 'VERSION_CONFLICT') || typeof cause === 'object' && cause !== null && 'code' in cause && (cause.code === 'MEMBERSHIP_VERSION_CONFLICT' || cause.code === 'VERSION_CONFLICT')) {
    return new ApiProblemError({ status: 409, code: 'VERSION_CONFLICT', message: 'Otra persona modificó esta membresía. Volvé a cargar antes de guardar.' });
  }
  return cause instanceof ApiProblemError ? cause : new ApiProblemError({ status: 0, code: 'REQUEST_FAILED', message: 'No pudimos completar la solicitud. Intentá nuevamente.' });
}

const roleLabels: Record<Role, string> = { OWNER: 'Propietario', ADMIN: 'Administrador', CASHIER: 'Cajero', EMPLOYEE: 'Empleado' };

export function UserManagement({ organizationId, data, onInvite = inviteUser, onRevokeInvitation = revokeInvitation, onResendInvitation = resendInvitation, onChangeRole = changeMembershipRole, onChangeStatus = changeMembershipStatus, onRevokeMembership = revokeMembership, onReload }: {
  organizationId: string;
  data: UserManagementData;
  onInvite?: typeof inviteUser;
  onRevokeInvitation?: typeof revokeInvitation;
  onResendInvitation?: typeof resendInvitation;
  onChangeRole?: typeof changeMembershipRole;
  onChangeStatus?: typeof changeMembershipStatus;
  onRevokeMembership?: typeof revokeMembership;
  onReload: () => void;
}) {
  const [error, setError] = useState<ApiProblemError | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [inviteBranches, setInviteBranches] = useState<string[]>([]);
  const { register, handleSubmit, watch, formState: { errors }, reset } = useForm<InviteValues>({ resolver: zodResolver(inviteSchema), defaultValues: { email: '', role: 'EMPLOYEE' } });
  const inviteRole = watch('role');
  const allowedRoles: Role[] = data.actorRole === 'OWNER' ? ['OWNER', 'ADMIN', 'CASHIER', 'EMPLOYEE'] : ['ADMIN', 'CASHIER', 'EMPLOYEE'];
  async function run(action: () => Promise<unknown>, success: string): Promise<boolean> {
    setBusy(true); setError(null); setMessage('');
    try { await action(); setMessage(success); onReload(); return true; }
    catch (cause) { setError(asError(cause)); return false; }
    finally { setBusy(false); }
  }
  async function submitInvite(values: InviteValues) {
    if (values.role !== 'OWNER' && inviteBranches.length === 0) { setError(new ApiProblemError({ status: 400, code: 'BRANCH_REQUIRED', message: 'Seleccioná al menos una sucursal para esta invitación.' })); return; }
    if (await run(() => onInvite(organizationId, values.email, values.role, values.role === 'OWNER' ? [] : inviteBranches), 'Invitación creada.')) {
      reset(); setInviteBranches([]);
    }
  }
  return <section className={styles.page} aria-labelledby="users-heading">
    <header className={styles.heading}><div><h1 id="users-heading">Usuarios y accesos</h1><p>Administrá invitaciones, roles y sucursales asignadas.</p></div></header>
    <ErrorSummary error={error} />
    {error?.code === 'VERSION_CONFLICT' ? <button type="button" onClick={onReload}>Volver a cargar</button> : null}
    {message ? <p role="status">{message}</p> : null}
    <form className={styles.panel} onSubmit={handleSubmit(submitInvite)} noValidate>
      <h2>Invitar a una persona</h2>
      <div className={styles.fields}><div><label htmlFor="invite-email">Correo electrónico</label><input id="invite-email" type="email" autoComplete="email" aria-invalid={!!errors.email} {...register('email')} />{errors.email ? <p role="alert">Ingresá un correo válido.</p> : null}</div>
      <div><label htmlFor="invite-role">Rol</label><select id="invite-role" {...register('role')}>{allowedRoles.map((role) => <option key={role} value={role}>{roleLabels[role]}</option>)}</select></div></div>
      {inviteRole === 'OWNER' ? <p>El propietario tiene acceso a todas las sucursales.</p> : <fieldset><legend>Sucursales asignadas</legend><div className={styles.checks}>{data.branches.filter((branch) => branch.status === 'ACTIVE').map((branch) => <label key={branch.id}><input type="checkbox" checked={inviteBranches.includes(branch.id)} onChange={(event) => setInviteBranches(event.target.checked ? [...inviteBranches, branch.id] : inviteBranches.filter((id) => id !== branch.id))} />{branch.name}</label>)}</div></fieldset>}
      <button type="submit" disabled={busy}>Enviar invitación</button>
    </form>
    <section className={styles.panel} aria-labelledby="members-heading"><h2 id="members-heading">Personas con acceso</h2>
      {data.memberships.length === 0 ? <p>No hay personas administrables en tu alcance.</p> : <div className={styles.rows}>{data.memberships.map((member) => <MemberEditor key={`${member.id}:${member.version}`} member={member} branches={data.branches} actorRole={data.actorRole} busy={busy} onSave={(role, branchIds) => run(() => onChangeRole(organizationId, member.id, member.version, role, branchIds), 'Membresía actualizada.')} onStatus={() => run(() => onChangeStatus(organizationId, member.id, member.version, member.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE'), 'Estado actualizado.')} onRevoke={() => run(() => onRevokeMembership(organizationId, member.id, member.version), 'Acceso revocado.')} />)}</div>}
    </section>
    <section className={styles.panel} aria-labelledby="invites-heading"><h2 id="invites-heading">Invitaciones pendientes</h2>
      {data.invitations.length === 0 ? <p>No hay invitaciones pendientes en tu alcance.</p> : <ul className={styles.rows}>{data.invitations.map((invitation) => <li key={invitation.id} className={styles.row}><div><strong>{invitation.email}</strong><p>{roleLabels[invitation.role]} · {invitation.status === 'EXPIRED' ? 'Vencida' : `Vence el ${new Date(invitation.expiresAt).toLocaleDateString('es-AR')}`}</p></div><button type="button" disabled={busy} onClick={() => void run(() => onResendInvitation(organizationId, invitation.id), 'Invitación reenviada. El enlace anterior dejó de ser válido.')}>Reenviar invitación a {invitation.email}</button>{invitation.status === 'PENDING' ? <button type="button" disabled={busy} onClick={() => void run(() => onRevokeInvitation(organizationId, invitation.id), 'Invitación revocada.')}>Revocar invitación de {invitation.email}</button> : null}</li>)}</ul>}
    </section>
  </section>;
}

function MemberEditor({ member, branches, actorRole, busy, onSave, onStatus, onRevoke }: {
  member: UserManagementData['memberships'][number]; branches: UserManagementData['branches']; actorRole: Role; busy: boolean;
  onSave: (role: Role, branchIds: string[]) => void; onStatus: () => void; onRevoke: () => void;
}) {
  const [role, setRole] = useState<Role>(member.role);
  const [branchIds, setBranchIds] = useState(member.branchIds);
  const allowedRoles: Role[] = actorRole === 'OWNER' ? ['OWNER', 'ADMIN', 'CASHIER', 'EMPLOYEE'] : ['ADMIN', 'CASHIER', 'EMPLOYEE'];
  return <article className={styles.row}><div className={styles.memberTitle}><strong>{member.email}</strong><span>{member.status === 'ACTIVE' ? 'Activo' : member.status === 'INACTIVE' ? 'Inactivo' : 'Revocado'}</span></div>
    <div className={styles.fields}><div><label htmlFor={`role-${member.id}`}>Rol de {member.email}</label><select id={`role-${member.id}`} value={role} disabled={busy || member.status === 'REVOKED'} onChange={(event) => setRole(roleSchema.parse(event.target.value))}>{allowedRoles.map((value) => <option key={value} value={value}>{roleLabels[value]}</option>)}</select></div></div>
    {role !== 'OWNER' ? <fieldset><legend>Sucursales de {member.email}</legend><div className={styles.checks}>{branches.filter((branch) => branch.status === 'ACTIVE').map((branch) => <label key={branch.id}><input type="checkbox" checked={branchIds.includes(branch.id)} disabled={busy} onChange={(event) => setBranchIds(event.target.checked ? [...branchIds, branch.id] : branchIds.filter((id) => id !== branch.id))} />{branch.name}</label>)}</div>{member.hasOutsideScope ? <p>Esta persona también tiene acceso a sucursales fuera de tu alcance. Se conservarán.</p> : null}</fieldset> : <p>Acceso a todas las sucursales.</p>}
    <div className={styles.actions}><button type="button" disabled={busy || member.status !== 'ACTIVE' || role !== 'OWNER' && branchIds.length === 0} onClick={() => onSave(role, role === 'OWNER' ? [] : branchIds)}>Guardar cambios de {member.email}</button><button type="button" disabled={busy || member.status === 'REVOKED'} onClick={onStatus}>{member.status === 'ACTIVE' ? 'Desactivar' : 'Activar'} a {member.email}</button><button type="button" disabled={busy || member.status !== 'ACTIVE'} onClick={onRevoke}>Revocar acceso de {member.email}</button></div>
  </article>;
}
