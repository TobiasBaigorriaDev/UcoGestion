'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

import { NavIcon, type NavIconName } from './nav-icons';
import styles from './app-shell.module.css';

export type BranchOption = Readonly<{ id: string; name: string }>;
export type OrganizationOption = Readonly<{
  id: string;
  name: string;
  branches: readonly BranchOption[];
}>;
export type NavigationItem = Readonly<{ href: string; label: string; icon?: NavIconName }>;
export type NavigationGroup = Readonly<{ label: string; items: readonly NavigationItem[] }>;

export type AppShellProps = Readonly<{
  organizations: readonly OrganizationOption[];
  activeOrganizationId: string | null;
  activeBranchId: string | null;
  onOrganizationChange: (id: string) => void;
  onBranchChange: (id: string) => void;
  /** Grouped by task; a bare item is shown as its own ungrouped entry. */
  navigation: readonly (NavigationGroup | NavigationItem)[];
  /** Up to three daily destinations for the mobile bar; the rest stays behind "Más". */
  primaryNavigation?: readonly NavigationItem[];
  currentPath: string;
  children: ReactNode;
}>;

const isGroup = (entry: NavigationGroup | NavigationItem): entry is NavigationGroup => 'items' in entry;

export function AppShell({
  organizations,
  activeOrganizationId,
  activeBranchId,
  onOrganizationChange,
  onBranchChange,
  navigation,
  primaryNavigation = [],
  currentPath,
  children,
}: AppShellProps) {
  const organizationLabelId = useId();
  const branchLabelId = useId();
  const navigationId = useId();
  const [menuOpen, setMenuOpen] = useState(false);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const activeNavigationRef = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    activeNavigationRef.current?.scrollIntoView?.({ block: 'nearest' });
    setMenuOpen(false);
  }, [currentPath]);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setMenuOpen(false);
      moreButtonRef.current?.focus();
    };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [menuOpen]);

  const activeOrganization = organizations.find((organization) => organization.id === activeOrganizationId);
  const branches = activeOrganization?.branches ?? [];
  const selectedBranchId = branches.some((branch) => branch.id === activeBranchId) ? activeBranchId : '';
  const groups = navigation.map((entry) => isGroup(entry) ? entry : { label: '', items: [entry] });
  const link = (item: NavigationItem, className?: string) => {
    const current = currentPath === item.href;
    return <a key={item.href} href={item.href} className={className} ref={current ? activeNavigationRef : undefined}
      aria-current={current ? 'page' : undefined}>
      {item.icon ? <NavIcon name={item.icon} className={styles.icon} /> : null}<span>{item.label}</span>
    </a>;
  };

  return (
    <div className={styles.shell} data-menu-open={menuOpen}>
      <a className={styles.skipLink} href="#contenido-principal">Ir al contenido principal</a>
      <header className={styles.header}>
        <a className={styles.brand} href="/workspace" aria-label="UcoNext, inicio">
          <span className={styles.brandMark} aria-hidden="true">U</span><span className={styles.brandName}>UcoNext</span>
        </a>
        <div className={styles.context} role="group" aria-label="Contexto de trabajo">
          {organizations.length > 1 ? <div className={styles.contextField}>
            <label htmlFor={organizationLabelId}>Organización activa</label>
            <select id={organizationLabelId} value={activeOrganization?.id ?? ''}
              onChange={(event) => onOrganizationChange(event.target.value)}>
              <option value="" disabled>Seleccioná una organización</option>
              {organizations.map((organization) => (
                <option key={organization.id} value={organization.id}>{organization.name}</option>
              ))}
            </select>
          </div> : <p className={styles.contextValue}><span className={styles.visuallyHidden}>Organización activa: </span>
            <strong>{activeOrganization?.name ?? 'Sin organización'}</strong></p>}
          {branches.length > 1 ? <div className={styles.contextField}>
            <label htmlFor={branchLabelId}>Sucursal activa</label>
            <select id={branchLabelId} value={selectedBranchId ?? ''} onChange={(event) => onBranchChange(event.target.value)}>
              <option value="" disabled>Seleccioná una sucursal</option>
              {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
            </select>
          </div> : <p className={styles.contextValue}>
            <NavIcon name="pin" className={styles.contextIcon} />
            <span className={styles.visuallyHidden}>Sucursal activa: </span>
            <span>{branches[0]?.name ?? 'Sin sucursal'}</span></p>}
        </div>
      </header>
      <nav id={navigationId} className={styles.navigation} aria-label="Navegación principal" data-open={menuOpen}>
        {groups.map((group, index) => {
          const headingId = `${navigationId}-group-${index}`;
          return <div key={group.label || group.items[0]?.href || index} className={styles.group}>
            {group.label && group.items.length > 1 ? <p id={headingId} className={styles.groupLabel}>{group.label}</p> : null}
            <ul aria-labelledby={group.label && group.items.length > 1 ? headingId : undefined}
              aria-label={group.label && group.items.length <= 1 ? group.label : undefined}>
              {group.items.map((item) => <li key={item.href}>{link(item)}</li>)}
            </ul>
          </div>;
        })}
      </nav>
      <main className={styles.main} id="contenido-principal" tabIndex={-1}>{children}</main>
      <nav className={styles.bottomBar} aria-label="Accesos principales">
        {primaryNavigation.slice(0, 3).map((item) => link(item, styles.bottomLink))}
        <button ref={moreButtonRef} type="button" className={styles.bottomLink} aria-expanded={menuOpen}
          aria-controls={navigationId} aria-label="Ver todas las secciones" onClick={() => setMenuOpen(!menuOpen)}>
          <NavIcon name={menuOpen ? 'close' : 'grid'} className={styles.icon} /><span aria-hidden="true">Más</span>
        </button>
      </nav>
    </div>
  );
}
