import { useId, type ComponentPropsWithRef } from 'react';

import * as Label from '@radix-ui/react-label';

type TextFieldProps = Omit<ComponentPropsWithRef<'input'>, 'children'> & {
  label: string;
  hint?: string;
  error?: string;
};

export function TextField({ label, hint, error, id, className, 'aria-describedby': describedBy, ...props }: TextFieldProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const descriptions = [describedBy, hintId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <div className="uco-field">
      <Label.Root className="uco-field__label" htmlFor={inputId}>
        {label}{props.required ? <span aria-hidden="true"> *</span> : null}
      </Label.Root>
      {hint ? <p className="uco-field__hint" id={hintId}>{hint}</p> : null}
      <input
        {...props}
        id={inputId}
        aria-describedby={descriptions}
        aria-invalid={error ? true : undefined}
        className={['uco-input', className].filter(Boolean).join(' ')}
      />
      {error ? <p className="uco-field__error" id={errorId}>{error}</p> : null}
    </div>
  );
}
