'use client';

export interface SimilarNameWarningProps {
  readonly className?: string;
  readonly id?: string;
  readonly similarNames: readonly string[];
}

export function SimilarNameWarning({
  className = '',
  id = 'similar-name-warning',
  similarNames,
}: SimilarNameWarningProps) {
  if (similarNames.length === 0) {
    return null;
  }

  return (
    <div
      aria-live="polite"
      className={`similar-name-warning ${className}`.trim()}
      id={id}
      role="status"
      style={{
        marginTop: '0.5rem',
        marginBottom: '0.75rem',
        padding: '0.75rem 1rem',
        borderRadius: '0.375rem',
        backgroundColor: '#fef3c7',
        border: '1px solid #f59e0b',
        color: '#78350f',
        fontSize: '0.875rem',
        lineHeight: '1.25rem',
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: '0.25rem' }}>
        Posibles duplicados detectados:
      </div>
      <p style={{ margin: 0, marginBottom: '0.25rem' }}>
        Ya existen ítems con nombres similares en el catálogo:
      </p>
      <ul style={{ margin: '0 0 0.5rem 1.25rem', padding: 0 }}>
        {similarNames.map((name, index) => (
          <li key={`${name}-${index}`} style={{ fontWeight: 500 }}>
            {name}
          </li>
        ))}
      </ul>
      <div style={{ fontSize: '0.75rem', color: '#92400e' }}>
        Podés continuar con el alta si confirmás que se trata de un ítem diferente.
      </div>
    </div>
  );
}
