import type { ReactElement, ReactNode } from 'react';

import * as DialogPrimitive from '@radix-ui/react-dialog';

type DialogProps = {
  trigger: ReactElement;
  title: string;
  description: string;
  children: ReactNode;
};

export function Dialog({ trigger, title, description, children }: DialogProps) {
  return (
    <DialogPrimitive.Root>
      <DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="uco-dialog-overlay" />
        <DialogPrimitive.Content className="uco-dialog uco-glass uco-glass--strong">
          <DialogPrimitive.Title className="uco-dialog__title">{title}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="uco-dialog__description">{description}</DialogPrimitive.Description>
          <div className="uco-dialog__body">{children}</div>
          <DialogPrimitive.Close className="uco-button uco-button--secondary" type="button">Cerrar</DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
