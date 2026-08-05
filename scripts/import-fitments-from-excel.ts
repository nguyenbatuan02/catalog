/**
 * import-fitments-from-excel.ts
 * Import 1.5 triệu cặp fitment từ file Excel vào PostgreSQL
 *
 * Cách dùng:
 *   npx tsx scripts/import-fitments-from-excel.ts --file ./data/fitment-mapping.json
 *
 * fitment-mapping.json format:
 * { "0-115": ["ALE20L-AEFLXW", "ALE20L-AEFLYW", ...], ... }
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
  console.error('Dung: npx tsx scripts/import-fitments-from-excel.ts --file ./data/fitment-mapping.json');
  process.exit(1);
}

const filePath = path.resolve(args[fi+1]);
console.log(`Doc file: ${filePath}`);
const mapping: Record<string, string[]> = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

const productCodes = Object.keys(mapping);
console.log(`San pham: ${productCodes.length}`);
console.log(`Uoc tinh fitments: ${Object.values(mapping).reduce((s,a)=>s+a.length,0).toLocaleString()}`);
console.log('');

const client = await pool.connect();
let fitAdded=0, fitSkip=0, prodNotFound=0, vehNotFound=0;

// Cache product IDs va vehicle IDs
console.log('Dang load product IDs tu DB...');
const prodRes = await pool.query(`SELECT id, internal_ref FROM catalog_products WHERE internal_ref IS NOT NULL`);
const prodMap: Record<string,string> = {};
for (const row of prodRes.rows) prodMap[row.internal_ref] = row.id;
console.log(`  → ${prodRes.rows.length} san pham trong DB`);

console.log('Dang load vehicle IDs tu DB...');
const vehRes = await pool.query(`SELECT id, model_code FROM catalog_vehicles`);
const vehMap: Record<string,string> = {};
for (const row of vehRes.rows) vehMap[row.model_code] = row.id;
console.log(`  → ${vehRes.rows.length} model xe trong DB`);
console.log('');

try {
  await client.query('BEGIN');

  // Batch INSERT 1000 records/lần
  const BATCH = 1000;
  let batch: [string,string][] = [];

  async function flushBatch() {
    if (!batch.length) return;
    const values = batch.map((_,i) => `($${i*2+1},$${i*2+2})`).join(',');
    const params = batch.flatMap(([pid,vid]) => [pid,vid]);
    try {
      await client.query(`
        INSERT INTO catalog_fitments (product_id, vehicle_id)
        VALUES ${values}
        ON CONFLICT (product_id, vehicle_id) DO NOTHING
      `, params);
      fitAdded += batch.length;
    } catch(e) { fitSkip += batch.length; }
    batch = [];
  }

  let processed = 0;
  for (const code of productCodes) {
    const prodId = prodMap[code];
    if (!prodId) { prodNotFound++; continue; }

    const modelCodes = mapping[code];
    for (const modelCode of modelCodes) {
      const vehId = vehMap[modelCode];
      if (!vehId) { vehNotFound++; continue; }
      batch.push([prodId, vehId]);
      if (batch.length >= BATCH) await flushBatch();
    }

    processed++;
    if (processed % 500 === 0) {
      process.stdout.write(`\r  ${processed}/${productCodes.length} san pham | Fitments: ${fitAdded.toLocaleString()} | Khong tim thay xe: ${vehNotFound.toLocaleString()}...`);
    }
  }

  await flushBatch(); // Flush remaining
  await client.query('COMMIT');

  console.log('\n');
  console.log('========== KET QUA ==========');
  console.log(`Fitments da them : ${fitAdded.toLocaleString()}`);
  console.log(`Bo qua (trung)   : ${fitSkip.toLocaleString()}`);
  console.log(`SP khong trong DB: ${prodNotFound.toLocaleString()}`);
  console.log(`Xe khong trong DB: ${vehNotFound.toLocaleString()}`);
  console.log('=============================');
  console.log('');
  console.log('TIP: Neu "Xe khong trong DB" cao, chay import vehicles truoc:');
  console.log('  npx tsx scripts/import-vehicles.ts --file ./data/vehicles-export.json');

} catch(err) {
  await client.query('ROLLBACK');
  console.error('\nImport that bai:', err);
} finally {
  client.release();
  await pool.end();
}
