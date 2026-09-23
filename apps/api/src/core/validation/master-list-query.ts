import { BadRequestException } from '@nestjs/common';

import {
  parseCursorPageQuery,
  type Cursor,
} from './pagination.js';

export interface MasterListQuery {
  readonly cursor?: string | undefined;
  readonly limit: number;
  readonly search?: string | undefined;
  readonly status?: 'ACTIVE' | 'INACTIVE' | undefined;
}

export type ReceptionListQuery = Pick<MasterListQuery, 'cursor' | 'limit' | 'search'>;

export function parseMasterListQuery(raw: Readonly<Record<string, unknown>>): MasterListQuery {
  try {
    const page = parseCursorPageQuery(raw, ['status', 'search']);
    const status = page.filters.status;
    if (status !== undefined && status !== 'ACTIVE' && status !== 'INACTIVE') {
      throw new Error('Invalid query parameter: status');
    }
    if (page.cursor) validateTimestamp(page.cursor.sortValue);
    return {
      ...(typeof raw.cursor === 'string' ? { cursor: raw.cursor } : {}),
      limit: page.limit,
      ...(page.filters.search === undefined ? {} : { search: page.filters.search }),
      ...(status === undefined ? {} : { status }),
    };
  } catch {
    throw new BadRequestException({
      code: 'QUERY_INVALID',
      title: 'Filtros inválidos',
      detail: 'Revisá el cursor, el límite y los filtros del listado.',
    });
  }
}

export function parseReceptionListQuery(raw: Readonly<Record<string, unknown>>): ReceptionListQuery {
  try {
    const page = parseCursorPageQuery(raw, ['search']);
    if (page.cursor) validateTimestamp(page.cursor.sortValue);
    return {
      ...(typeof raw.cursor === 'string' ? { cursor: raw.cursor } : {}),
      limit: page.limit,
      ...(page.filters.search === undefined ? {} : { search: page.filters.search }),
    };
  } catch {
    throw new BadRequestException({
      code: 'QUERY_INVALID',
      title: 'Filtros inválidos',
      detail: 'Revisá el cursor, el límite y los filtros del listado.',
    });
  }
}

export function decodeMasterCursor(value: string): Cursor {
  const cursor = parseCursorPageQuery({ cursor: value }, []).cursor;
  if (!cursor) throw new Error('Invalid query parameter: cursor');
  validateTimestamp(cursor.sortValue);
  return cursor;
}

function validateTimestamp(value: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?([+-])(\d{2})(?::?(\d{2}))?$/.exec(value);
  if (!match || Number.isNaN(Date.parse(value))) {
    throw new Error('Invalid query parameter: cursor');
  }
  const [, rawYear, rawMonth, rawDay, rawHour, rawMinute, rawSecond, , rawOffsetHour, rawOffsetMinute] = match;
  const year = Number(rawYear);
  const month = Number(rawMonth);
  const day = Number(rawDay);
  const hour = Number(rawHour);
  const minute = Number(rawMinute);
  const second = Number(rawSecond);
  const offsetHour = Number(rawOffsetHour);
  const offsetMinute = Number(rawOffsetMinute ?? '0');
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (year < 1000 || calendar.getUTCFullYear() !== year ||
      calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day ||
      hour > 23 || minute > 59 || second > 59 || offsetHour > 15 || offsetMinute > 59) {
    throw new Error('Invalid query parameter: cursor');
  }
}
