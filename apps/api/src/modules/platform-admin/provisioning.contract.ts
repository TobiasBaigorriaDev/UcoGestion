import { z } from 'zod';

const ianaTimezoneSchema = z.string().trim().min(1).refine((timezone) => {
  try {
    new Intl.DateTimeFormat('es-AR', { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}, 'La zona horaria debe ser un identificador IANA válido.');

export const provisionOrganizationCommandSchema = z.strictObject({
  firstBranchName: z.string().trim().min(1).max(160),
  organizationName: z.string().trim().min(1).max(200),
  ownerEmail: z.string().trim().toLowerCase().pipe(z.email()),
  ownerPassword: z.string().min(12).max(256),
  requestId: z.string().trim().min(1).max(200),
  timezone: ianaTimezoneSchema,
});

export type ProvisionOrganizationCommand = z.infer<typeof provisionOrganizationCommandSchema>;
