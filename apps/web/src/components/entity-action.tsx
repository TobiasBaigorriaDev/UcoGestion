import styles from './entity-action.module.css';

/**
 * Short visible verb for row actions ("Editar") while screen readers still hear
 * which record it acts on ("Editar Distribuidora Sur").
 */
export function EntityAction({ label, name }: { label: string; name: string }) {
  return <>{label}{' '}<span className={styles.hidden}>{name}</span></>;
}
