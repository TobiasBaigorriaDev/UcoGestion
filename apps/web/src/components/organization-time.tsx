'use client';

import { createContext, useContext } from 'react';

export const OrganizationTimezone = createContext('UTC');

export function OrganizationTime({ value, timezone, dateOnly = false }: { value: string; timezone?: string; dateOnly?: boolean }) {
  const context = useContext(OrganizationTimezone);
  const date = new Date(value), options = { timeZone: timezone ?? context };
  return <time dateTime={value}>{dateOnly ? date.toLocaleDateString('es-AR', options) : date.toLocaleString('es-AR', options)}</time>;
}
