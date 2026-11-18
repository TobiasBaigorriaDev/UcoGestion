'use client';

import { useEffect, useRef } from 'react';

import type { ApiProblemError } from '../lib/api/client';
import styles from './error-summary.module.css';

type ErrorSummaryProps = Readonly<{
  error: ApiProblemError | null;
  fieldIds?: Readonly<Record<string, string>>;
  fieldLabels?: Readonly<Record<string, string>>;
}>;

/** What happened, in the shop's words; the server message below says what to do. */
export function errorTitle(error: ApiProblemError): string {
  if (error.status === 0) return 'No hay conexión con el servidor';
  if (error.status === 401) return 'Tu sesión venció';
  if (error.status === 403) return 'No tenés permiso para hacer esto';
  if (error.status === 409) return 'Alguien cambió estos datos mientras trabajabas';
  if (error.status === 503) return 'El servicio no está disponible en este momento';
  if (error.status >= 500) return 'Algo salió mal de nuestro lado';
  return 'Revisá los datos';
}

export function ErrorSummary({ error, fieldIds = {}, fieldLabels = {} }: ErrorSummaryProps) {
  const summaryRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (error) summaryRef.current?.focus();
  }, [error]);

  if (!error) return null;

  return (
    <div ref={summaryRef} className={styles.summary} role="alert" tabIndex={-1}>
      <h2>{errorTitle(error)}</h2>
      <p>{error.message}</p>
      {Object.entries(error.fieldErrors).length > 0 ? (
        <ul>
          {Object.entries(error.fieldErrors).map(([field, message]) => (
            <li key={field}>
              {fieldIds[field] ? (
                <a href={`#${encodeURIComponent(fieldIds[field])}`}>
                  {fieldLabels[field] ?? 'Campo'}: {message}
                </a>
              ) : `${fieldLabels[field] ?? 'Campo'}: ${message}`}
            </li>
          ))}
        </ul>
      ) : null}
      {error.traceId ? <p className={styles.reference}>Referencia: {error.traceId}</p> : null}
    </div>
  );
}
