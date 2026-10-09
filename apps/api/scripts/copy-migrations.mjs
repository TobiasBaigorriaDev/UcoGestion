import { cpSync, mkdirSync } from 'node:fs';
const source = new URL('../src/database/migrations/', import.meta.url);
const target = new URL('../dist/database/migrations/', import.meta.url);
mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });
