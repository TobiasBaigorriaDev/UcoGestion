import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  out: './src/database/migrations',
  schema: './src/database/schema.ts',
});
