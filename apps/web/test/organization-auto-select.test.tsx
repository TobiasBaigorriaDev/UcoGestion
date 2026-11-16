import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OrganizationSelector } from '../src/features/identity/auth-flow';
import { ApiProblemError } from '../src/lib/api/client';

afterEach(cleanup);
const one = [{ organizationId: 'org-1', organizationName: 'Almacén Don Pedro', role: 'OWNER' as const }];

describe('D08 organization entry', () => {
  it('enters the only business automatically', async () => {
    const select = vi.fn().mockResolvedValue(undefined);
    const onSuccess = vi.fn();
    render(<OrganizationSelector organizations={one} select={select} onSuccess={onSuccess} />);
    expect(screen.getByRole('status').textContent).toContain('Entrando a Almacén Don Pedro');
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(select).toHaveBeenCalledWith('org-1');
  });

  it('falls back to the explicit choice with the error when automatic entry fails', async () => {
    const select = vi.fn().mockRejectedValue(new ApiProblemError({ status: 403, code: 'MEMBERSHIP_INACTIVE', message: 'No tenés acceso.' }));
    render(<OrganizationSelector organizations={one} select={select} onSuccess={vi.fn()} />);
    expect(await screen.findByRole('button', { name: /Almacén Don Pedro/ })).toBeDefined();
    expect(screen.getByText('Dueño')).toBeDefined();
    expect(select).toHaveBeenCalledTimes(1);
  });

  it('asks which business when there are several, showing roles in Spanish', () => {
    const select = vi.fn();
    render(<OrganizationSelector organizations={[...one, { organizationId: 'org-2', organizationName: 'Kiosco', role: 'CASHIER' }]}
      select={select} onSuccess={vi.fn()} />);
    expect(screen.getByText('Cajero')).toBeDefined();
    expect(select).not.toHaveBeenCalled();
  });
});
