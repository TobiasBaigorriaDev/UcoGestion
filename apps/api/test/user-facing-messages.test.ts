import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const source = fileURLToPath(new URL('../src', import.meta.url));

function files(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : [];
  });
}

// A Spanish sentence (a word with an accent or a common connector) that names a role code.
const roleCode = /\b(OWNER|ADMIN|CASHIER|EMPLOYEE)\b/;
const spanishSentence = /\b(Solo|solo|puede|pueden|debe|membresía|organización|sucursal|alcance|vigente|activo)\b/;
const literal = /'([^'\n]*)'|`([^`\n]*)`/g;

describe('user-facing API messages', () => {
  it('speak the shop language instead of internal role codes', () => {
    const offenders = files(source).flatMap((path) => {
      const text = readFileSync(path, 'utf8');
      return [...text.matchAll(literal)]
        .map((match) => match[1] ?? match[2] ?? '')
        .filter((value) => roleCode.test(value) && spanishSentence.test(value))
        .map((value) => `${relative(source, path)}: ${value}`);
    });
    expect(offenders).toEqual([]);
  });
});
