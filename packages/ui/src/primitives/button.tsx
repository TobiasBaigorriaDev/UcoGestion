import type { ComponentPropsWithRef } from 'react';

type ButtonProps = ComponentPropsWithRef<'button'> & {
  variant?: 'primary' | 'secondary' | 'danger';
};

export function Button({ variant = 'primary', type = 'button', className, ...props }: ButtonProps) {
  return (
    <button
      {...props}
      type={type}
      className={['uco-button', `uco-button--${variant}`, className].filter(Boolean).join(' ')}
    />
  );
}
