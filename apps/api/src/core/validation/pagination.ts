import { z } from 'zod';

const cursorSchema = z
  .object({
    id: z.uuid(),
    sortValue: z.string().min(1).max(128),
  })
  .strict();
const filterValueSchema = z.string().trim().min(1).max(128);
const limitSchema = z.coerce.number().int().min(1).max(100);

export interface CursorPageQuery {
  readonly cursor: Cursor | undefined;
  readonly filters: Readonly<Record<string, string>>;
  readonly limit: number;
}

export interface Cursor {
  readonly id: string;
  readonly sortValue: string;
}

export const encodeCursor = (cursor: Cursor): string =>
  Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');

export const parseCursorPageQuery = (
  query: Readonly<Record<string, unknown>>,
  allowedFilters: readonly string[],
): CursorPageQuery => {
  const permitted = new Set(['cursor', 'limit', ...allowedFilters]);
  for (const key of Object.keys(query)) {
    if (!permitted.has(key)) {
      throw new Error(`Unsupported query filter: ${key}`);
    }
  }

  const limit = limitSchema.safeParse(query.limit ?? 25);
  if (!limit.success) {
    throw new Error('Invalid query parameter: limit');
  }

  const cursor = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
  const filters: Record<string, string> = {};
  for (const filter of allowedFilters) {
    const rawValue = query[filter];
    if (rawValue === undefined) {
      continue;
    }
    const value = filterValueSchema.safeParse(rawValue);
    if (!value.success) {
      throw new Error(`Invalid query parameter: ${filter}`);
    }
    filters[filter] = value.data;
  }

  return { cursor, filters, limit: limit.data };
};

function decodeCursor(value: unknown): Cursor {
  if (typeof value !== 'string' || value.length > 512) {
    throw new Error('Invalid query parameter: cursor');
  }

  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    const cursor = cursorSchema.safeParse(decoded);
    if (!cursor.success) {
      throw new Error('Invalid query parameter: cursor');
    }
    return cursor.data;
  } catch {
    throw new Error('Invalid query parameter: cursor');
  }
}
