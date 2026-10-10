import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { expect, it } from 'vitest';

it('T236J upgrades the previous schema without inferring old document categories and enforces tenant FKs', async () => {
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const pool = new Pool({ connectionString: container.getConnectionUri() });
  const folder = new URL('../src/database/migrations/', import.meta.url);
  try {
    // Apply the actual previous SQL files, then seed documents before 0109.
    for (const name of (await readdir(folder)).filter(name => /^\d+.*\.sql$/.test(name) && name < '0109').sort()) {
      await pool.query(await readFile(new URL(name, folder), 'utf8'));
    }
    const org = randomUUID(), foreign = randomUUID(), actor = randomUUID(), branch = randomUUID(),
      device = randomUUID(), register = randomUUID(), session = randomUUID(), item = randomUUID(),
      supplier = randomUUID(), sale = randomUUID(), purchase = randomUUID(), category = randomUUID(), foreignCategory = randomUUID();
    await pool.query("INSERT INTO users (id,email_normalized,password_hash,password_hash_version) VALUES ($1,'migration-category@example.com','$argon2id$v=19$test',1)", [actor]);
    await pool.query("INSERT INTO organizations (id,base_currency,timezone) VALUES ($1,'ARS','UTC'),($2,'ARS','UTC')", [org, foreign]);
    await pool.query("INSERT INTO branches (id,organization_id,name) VALUES ($1,$2,'Branch')", [branch, org]);
    await pool.query("INSERT INTO devices (id,organization_id,branch_id,status,authorized_by_user_id,authorized_at) VALUES ($1,$2,$3,'ACTIVE',$4,now())", [device, org, branch, actor]);
    await pool.query("INSERT INTO cash_registers (id,organization_id,branch_id,name) VALUES ($1,$2,$3,'Register')", [register, org, branch]);
    await pool.query(`INSERT INTO cash_sessions (id,organization_id,branch_id,cash_register_id,owner_user_id,device_id,origin,status,opening_cash,expected_cash,currency_code)
      VALUES ($1,$2,$3,$4,$5,$6,'ONLINE','OPEN',0,0,'ARS')`, [session, org, branch, register, actor, device]);
    await pool.query("INSERT INTO catalog_items (id,organization_id,name,type,base_unit) VALUES ($1,$2,'Old item','PRODUCT','UNIT')", [item, org]);
    await pool.query("INSERT INTO catalog_categories (id,organization_id,name) VALUES ($1,$3,'Current'),($2,$4,'Foreign')", [category, foreignCategory, org, foreign]);
    await pool.query("INSERT INTO suppliers (id,organization_id,name) VALUES ($1,$2,'Supplier')", [supplier, org]);
    const receipt = { label: 'Comprobante no fiscal', items: [{ name: 'Old item', unit: 'UNIT' }] };
    await pool.query(`INSERT INTO sales (id,organization_id,branch_id,cash_session_id,device_id,actor_user_id,session_owner_user_id,client_operation_id,currency_code,subtotal,discount,total,receipt_snapshot)
      VALUES ($1,$2,$3,$4,$5,$6,$6,$1,'ARS',1,0,1,$7::jsonb)`, [sale, org, branch, session, device, actor, JSON.stringify(receipt)]);
    await pool.query(`INSERT INTO sale_items (id,organization_id,sale_id,item_id,item_name,item_type,unit,quantity,unit_price,price_version,line_total,currency_code,track_inventory)
      VALUES ($1,$2,$3,$4,'Old item','PRODUCT','UNIT',1,1,1,1,'ARS',false)`, [randomUUID(), org, sale, item]);
    await pool.query(`INSERT INTO purchases (id,organization_id,branch_id,supplier_id,actor_user_id,client_operation_id,confirmation_status,currency_code,total,supplier_snapshot)
      VALUES ($1,$2,$3,$4,$5,$1,'PENDING_PAYMENT','ARS',1,'{}')`, [purchase, org, branch, supplier, actor]);
    await pool.query(`INSERT INTO purchase_items (id,organization_id,purchase_id,item_id,item_name,item_type,unit,quantity,unit_cost,line_total,currency_code,track_inventory)
      VALUES ($1,$2,$3,$4,'Old item','PRODUCT','UNIT',1,1,1,'ARS',false)`, [randomUUID(), org, purchase, item]);
    const before = (await pool.query('SELECT receipt_snapshot FROM sales WHERE id=$1', [sale])).rows;
    await pool.query(await readFile(new URL('0109_document_category_snapshots.sql', folder), 'utf8'));
    await pool.query('UPDATE catalog_items SET category_id=$1 WHERE id=$2', [category, item]);
    for (const table of ['sale_items', 'purchase_items']) {
      expect((await pool.query(`SELECT category_id,category_name,category_snapshot_status FROM ${table}`)).rows)
        .toEqual([{ category_id: null, category_name: null, category_snapshot_status: 'UNKNOWN' }]);
      await expect(pool.query(`UPDATE ${table} SET category_name='Invented'`)).rejects.toMatchObject({ code: '55000' });
    }
    expect((await pool.query('SELECT receipt_snapshot FROM sales WHERE id=$1', [sale])).rows).toEqual(before);
    expect((await pool.query('SELECT 1 FROM catalog_category_history_references')).rowCount).toBe(0);
    await pool.query("CREATE ROLE category_migration_runtime LOGIN PASSWORD 'runtime-password' IN ROLE uco_app");
    const url = new URL(container.getConnectionUri()); url.username = 'category_migration_runtime'; url.password = 'runtime-password';
    const runtime = new Pool({ connectionString: url.toString() });
    const client = await runtime.connect();
    try {
      for (const [categoryId, name, status, code] of [
        [foreignCategory, 'Foreign', 'ASSIGNED', '23503'], [category, null, 'ASSIGNED', '23514'],
        [category, 'Current', 'NONE', '23514'], [null, null, 'INVALID', '23514'],
      ]) {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.organization_id',$1,true)", [org]);
        await expect(client.query(`INSERT INTO sale_items (id,organization_id,sale_id,item_id,item_name,item_type,unit,quantity,unit_price,price_version,line_total,currency_code,track_inventory,category_id,category_name,category_snapshot_status)
          VALUES ($1,$2,$3,$4,'Item','PRODUCT','UNIT',1,1,1,1,'ARS',false,$5,$6,$7)`,
          [randomUUID(), org, sale, item, categoryId, name, status])).rejects.toMatchObject({ code });
        await client.query('ROLLBACK');
      }
    } finally { client.release(); await runtime.end(); }
  } finally { await pool.end(); await container.stop(); }
});
