'use client';

import { useCallback, useState, type FormEvent, type KeyboardEvent } from 'react';

export interface BarcodeCaptureProps {
  readonly autoFocus?: boolean;
  readonly className?: string;
  readonly disabled?: boolean;
  readonly id?: string;
  readonly label?: string;
  readonly onScan: (barcode: string) => void;
  readonly placeholder?: string;
}

export function BarcodeCapture({
  autoFocus = false,
  className = '',
  disabled = false,
  id = 'barcode-scanner-input',
  label = 'Código de barras',
  onScan,
  placeholder = 'Escanear o ingresar código de barras...',
}: BarcodeCaptureProps) {
  const [value, setValue] = useState('');

  const submitBarcode = useCallback(() => {
    const trimmed = value.trim();
    if (trimmed.length > 0 && !disabled) {
      onScan(trimmed);
      setValue('');
    }
  }, [disabled, onScan, value]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submitBarcode();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submitBarcode();
    }
  };

  return (
    <form className={`barcode-capture-form ${className}`.trim()} onSubmit={handleSubmit}>
      <label
        htmlFor={id}
        style={{
          display: 'block',
          fontSize: '0.875rem',
          fontWeight: 600,
          marginBottom: '0.375rem',
          color: '#1e293b',
        }}
      >
        {label}
      </label>
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
        <input
          autoCapitalize="off"
          autoComplete="off"
          autoFocus={autoFocus}
          disabled={disabled}
          id={id}
          name="barcode"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          spellCheck={false}
          style={{
            flex: 1,
            padding: '0.5rem 0.75rem',
            fontSize: '1rem',
            borderRadius: '0.375rem',
            border: '1px solid #cbd5e1',
            outline: 'none',
            backgroundColor: disabled ? '#f1f5f9' : '#ffffff',
            color: '#0f172a',
            transition: 'border-color 0.15s ease-in-out, box-shadow 0.15s ease-in-out',
          }}
          type="text"
          value={value}
        />
        <button
          disabled={disabled}
          style={{
            padding: '0.5rem 1rem',
            fontSize: '0.875rem',
            fontWeight: 600,
            borderRadius: '0.375rem',
            border: 'none',
            backgroundColor: disabled ? '#94a3b8' : '#059669',
            color: '#ffffff',
            cursor: disabled ? 'not-allowed' : 'pointer',
            transition: 'background-color 0.15s ease-in-out',
          }}
          type="submit"
        >
          Capturar código
        </button>
      </div>
    </form>
  );
}
