import { z } from 'zod';

const iso4217Currencies = new Set(Intl.supportedValuesOf('currency'));

export const organizationCurrencyChangeSchema = z.strictObject({
  targetCurrency: z.string().trim().toUpperCase().refine(
    (currency) => iso4217Currencies.has(currency),
    'La moneda debe ser un código ISO 4217 válido.',
  ),
});

export interface OrganizationCurrencyChangeRequest {
  readonly actorRole: string;
  readonly hasServerHistory: boolean;
  readonly targetCurrency: string;
}

export interface AuthorizedOrganizationCurrencyChange {
  readonly targetCurrency: string;
}

export class OrganizationCurrencyChangeDeniedError extends Error {
  readonly code: 'CURRENCY_CHANGE_FORBIDDEN' | 'CURRENCY_LOCKED_BY_HISTORY';

  constructor(code: 'CURRENCY_CHANGE_FORBIDDEN' | 'CURRENCY_LOCKED_BY_HISTORY', message: string) {
    super(message);
    this.name = 'OrganizationCurrencyChangeDeniedError';
    this.code = code;
  }
}

export class OrganizationCurrencyChangePolicy {
  authorize(request: OrganizationCurrencyChangeRequest): AuthorizedOrganizationCurrencyChange {
    const { targetCurrency } = organizationCurrencyChangeSchema.parse({ targetCurrency: request.targetCurrency });
    if (request.actorRole !== 'OWNER') {
      throw new OrganizationCurrencyChangeDeniedError(
        'CURRENCY_CHANGE_FORBIDDEN',
        'Solo OWNER puede modificar la moneda base.',
      );
    }
    if (request.hasServerHistory) {
      throw new OrganizationCurrencyChangeDeniedError(
        'CURRENCY_LOCKED_BY_HISTORY',
        'La moneda base queda bloqueada desde la primera referencia operativa.',
      );
    }
    return { targetCurrency };
  }
}
