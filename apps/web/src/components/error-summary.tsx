'use client';

import { useEffect, useRef } from 'react';

import type { ApiProblemError } from '../lib/api/client';
import styles from './error-summary.module.css';

type ErrorSummaryProps = Readonly<{
  error: ApiProblemError | null;
  fieldIds?: Readonly<Record<string, string>>;
  fieldLabels?: Readonly<Record<string, string>>;
}>;

export function ErrorSummary({ error, fieldIds = {}, fieldLabels = {} }: ErrorSummaryProps) {
  const summaryRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (error) summaryRef.current?.focus();
  }, [error]);

  if (!error) return null;

  return (
    <div ref={summaryRef} className={styles.summary} role="alert" tabIndex={-1}>
      <h2>Revisá la solicitud</h2>
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
