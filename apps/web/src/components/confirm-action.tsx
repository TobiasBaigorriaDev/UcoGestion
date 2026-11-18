'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

import styles from './confirm-action.module.css';

/**
 * Irreversible action with an in-place second step: no modal, the question appears where the
 * button was, explains the consequence and keeps "No, volver" as the default focus.
 */
export function ConfirmAction({ label, confirmLabel, busyLabel, busy = false, disabled = false, onConfirm, children }: {
  label: string; confirmLabel: string; busyLabel?: string; busy?: boolean; disabled?: boolean;
  onConfirm: () => void; children: ReactNode;
}) {
  const [asking, setAsking] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const returnFocus = useRef(false);
  useEffect(() => {
    if (asking) back.current?.focus();
    else if (returnFocus.current) { trigger.current?.focus(); returnFocus.current = false; }
  }, [asking]);
  const close = () => { returnFocus.current = true; setAsking(false); };
  if (!asking) return <button ref={trigger} type="button" className={styles.trigger} disabled={disabled || busy}
    onClick={() => setAsking(true)}>{busy && busyLabel ? busyLabel : label}</button>;
  return <div role="group" aria-labelledby={titleId} className={styles.question}
    onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); close(); } }}>
    <p id={titleId} className={styles.title}>¿{label}?</p>
    <div className={styles.consequence}>{children}</div>
    <div className={styles.actions}>
      <button ref={back} type="button" className={styles.back} onClick={close}>No, volver</button>
      <button type="button" className={styles.confirm} disabled={busy}
        onClick={() => { setAsking(false); onConfirm(); }}>{busy && busyLabel ? busyLabel : confirmLabel}</button>
    </div>
  </div>;
}
