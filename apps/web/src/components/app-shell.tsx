'use client';

import { useId, type ReactNode } from 'react';

import styles from './app-shell.module.css';

export type BranchOption = Readonly<{ id: string; name: string }>;
export type OrganizationOption = Readonly<{
  id: string;
  name: string;
  branches: readonly BranchOption[];
}>;
export type NavigationItem = Readonly<{ href: string; label: string }>;

export type AppShellProps = Readonly<{
  organizations: readonly OrganizationOption[];
  activeOrganizationId: string | null;
  activeBranchId: string | null;
  onOrganizationChange: (id: string) => void;
  onBranchChange: (id: string) => void;
  navigation: readonly NavigationItem[];
  currentPath: string;
  children: ReactNode;
}>;

export function AppShell({
  organizations,
  activeOrganizationId,
  activeBranchId,
  onOrganizationChange,
  onBranchChange,
  navigation,
  currentPath,
  children,
}: AppShellProps) {
  const organizationLabelId = useId();
  const branchLabelId = useId();
  const activeOrganization = organizations.find((organization) => organization.id === activeOrganizationId);
  const branches = activeOrganization?.branches ?? [];
  const selectedBranchId = branches.some((branch) => branch.id === activeBranchId) ? activeBranchId : '';

  return (
    <div className={styles.shell}>
      <a className={styles.skipLink} href="#contenido-principal">Ir al contenido principal</a>
      <header className={styles.header}>
        <a className={styles.brand} href="/" aria-label="UcoNext, inicio">UcoNext</a>
        <div className={styles.context} role="group" aria-label="Contexto de trabajo">
          <div className={styles.contextField}>
            <label htmlFor={organizationLabelId}>Organización activa</label>
            <select
              id={organizationLabelId}
              value={activeOrganization?.id ?? ''}
              onChange={(event) => onOrganizationChange(event.target.value)}
              disabled={organizations.length === 0}
            >
              <option value="" disabled>Seleccioná una organización</option>
              {organizations.map((organization) => (
                <option key={organization.id} value={organization.id}>{organization.name}</option>
              ))}
            </select>
          </div>
          <div className={styles.contextField}>
            <label htmlFor={branchLabelId}>Sucursal activa</label>
            <select
              id={branchLabelId}
              value={selectedBranchId ?? ''}
              onChange={(event) => onBranchChange(event.target.value)}
              disabled={!activeOrganization || branches.length === 0}
            >
              <option value="" disabled>Seleccioná una sucursal</option>
              {branches.map((branch) => (
                <option key={branch.id} value={branch.id}>{branch.name}</option>
              ))}
            </select>
          </div>
        </div>
      </header>
      <nav className={styles.navigation} aria-label="Navegación principal">
        {navigation.map((item) => (
          <a key={item.href} href={item.href} aria-current={currentPath === item.href ? 'page' : undefined}>
            {item.label}
          </a>
        ))}
      </nav>
      <main className={styles.main} id="contenido-principal" tabIndex={-1}>{children}</main>
    </div>
  );
}
