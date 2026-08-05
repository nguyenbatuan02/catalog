/**
 * import-vehicles.ts
 * Import danh sach model xe tu JSON vao PostgreSQL
 * Dung: npx tsx scripts/import-vehicles.ts --file ./data/vehicles-export.json
 */

import 'dotenv/config';
import fs   from 'fs';
import path from 'path';
import pg   from 'pg';

const pool = new pg.Pool({
  host    : process.env.DB_HOST     || 'localhost',
  port    : Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME     || 'zalocrm',
  user    : process.env.DB_USER     || 'crmuser',
  password: process.env.DB_PASSWORD || 'devpassword',
});

const args   = process.argv.slice(2);
const fi     = args.indexOf('--file');
if (fi === -1 || !args[fi+1]) {
  console.error('Dung: npx tsx scripts/import-vehicles.ts --file ./data/vehicles-export.json');
  process.exit(1);
}
const filePath = path.resolve(args[fi+1]);
const data: any[] = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
console.log(`Doc duoc ${data.length} model xe`);

const client = await pool.connect();
let added = 0, skipped = 0;

try {
  await client.query('BEGIN');

  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (!v.make?.trim() || !v.model_code?.trim()) { skipped++; continue; }

    try {
      await client.query(`
        INSERT INTO catalog_vehicles (make, model_code, model_name, vehicle_type, year_from, year_to, odoo_ref)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (make, model_code) DO UPDATE SET
          model_name   = COALESCE(EXCLUDED.model_name, catalog_vehicles.model_name),
          vehicle_type = COALESCE(EXCLUDED.vehicle_type, catalog_vehicles.vehicle_type),
          odoo_ref     = COALESCE(EXCLUDED.odoo_ref, catalog_vehicles.odoo_ref),
          updated_at   = NOW()
      `, [
        v.make.trim(),
        v.model_code.trim(),
        v.model_name || null,
        v.vehicle_type || 'car',
        v.year_from || null,
        v.year_to   || null,
        v.odoo_ref  || null,
      ]);
      added++;
    } catch { skipped++; }

    if (i % 1000 === 0) process.stdout.write(`\r${i}/${data.length}...`);
  }

  await client.query('COMMIT');
  console.log('\n========== KET QUA ==========');
  console.log(`Da them/cap nhat : ${added}`);
  console.log(`Bo qua           : ${skipped}`);
  console.log('==============================');

} catch (err) {
  await client.query('ROLLBACK');
  console.error('Import that bai:', err);
} finally {
  client.release();
  await pool.end();
}
