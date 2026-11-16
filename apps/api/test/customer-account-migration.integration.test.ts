import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { expect, it } from 'vitest';

it('upgrades schema 0112 preserving existing customers and starting accounts at zero', async () => {
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const pool = new Pool({ connectionString: container.getConnectionUri() });
  const folder = new URL('../src/database/migrations/', import.meta.url);
  try {
    for (const name of (await readdir(folder)).filter(name => /^\d+.*\.sql$/.test(name) && name < '0113').sort()) {
      await pool.query(await readFile(new URL(name, folder), 'utf8'));
    }
    const org = randomUUID(), foreign = randomUUID(), customer = randomUUID();
    await pool.query("INSERT INTO organizations (id,base_currency,timezone) VALUES ($1,'ARS','UTC'),($2,'ARS','UTC')", [org, foreign]);
    await pool.query("INSERT INTO customers (id,organization_id,name) VALUES ($1,$2,'Cliente existente')", [customer, org]);
    const before = (await pool.query('SELECT * FROM customers WHERE id=$1', [customer])).rows;
    await pool.query(await readFile(new URL('0113_customer_accounts.sql', folder), 'utf8'));
    expect((await pool.query('SELECT * FROM customers WHERE id=$1', [customer])).rows).toEqual(before);
    expect((await pool.query('SELECT 1 FROM customer_account_entries')).rowCount).toBe(0);
    await pool.query('INSERT INTO customer_accounts (organization_id,customer_id) VALUES ($1,$2)', [org, customer]);
    expect((await pool.query('SELECT balance::text,credit_limit::text FROM customer_accounts')).rows)
      .toEqual([{ balance: '0.00', credit_limit: '0.00' }]);
    await expect(pool.query('INSERT INTO customer_accounts (organization_id,customer_id) VALUES ($1,$2)', [foreign, customer]))
      .rejects.toMatchObject({ code: '23503' });
  } finally { await pool.end(); await container.stop(); }
});
