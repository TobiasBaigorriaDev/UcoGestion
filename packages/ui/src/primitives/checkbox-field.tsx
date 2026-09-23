import { useId } from 'react';

import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import * as Label from '@radix-ui/react-label';

type CheckboxFieldProps = Omit<CheckboxPrimitive.CheckboxProps, 'children'> & {
  label: string;
  error?: string;
};

export function CheckboxField({ label, error, id, 'aria-describedby': describedBy, ...props }: CheckboxFieldProps) {
  const generatedId = useId();
  const checkboxId = id ?? generatedId;
  const errorId = error ? `${checkboxId}-error` : undefined;

  return (
    <div className="uco-field">
      <div className="uco-check-field">
        <CheckboxPrimitive.Root
          {...props}
          id={checkboxId}
          aria-invalid={error ? true : undefined}
          aria-describedby={[describedBy, errorId].filter(Boolean).join(' ') || undefined}
          className="uco-checkbox"
        >
          <CheckboxPrimitive.Indicator className="uco-checkbox__indicator" aria-hidden="true">
            <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m4 10 4 4 8-8" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </CheckboxPrimitive.Indicator>
        </CheckboxPrimitive.Root>
        <Label.Root htmlFor={checkboxId} className="uco-field__label">{label}</Label.Root>
      </div>
      {error ? <p className="uco-field__error" id={errorId}>{error}</p> : null}
    </div>
  );
}
