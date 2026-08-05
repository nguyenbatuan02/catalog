/**
 * update-vehicles.ts
 * Cap nhat model_name, year_from, year_to cho catalog_vehicles
 * Chay: npx tsx scripts/update-vehicles.ts --file ./data/vehicles-mapping.json
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

const args = process.argv.slice(2);
const fi   = args.indexOf('--file');
if (fi === -1 || !args[fi+1]) {
  console.error('Dung: npx tsx scripts/update-vehicles.ts --file ./data/vehicles-mapping.json');
  process.exit(1);
}

const filePath = path.resolve(args[fi+1]);
console.log(`[1/3] Doc file: ${filePath}`);
const mapping: Record<string, {model_name:string; year:number; make:string}> = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

const codes = Object.keys(mapping);
console.log(`[1/3] Mapping: ${codes.length} model codes`);

// Load tat ca vehicles tu DB
console.log('[2/3] Load vehicles tu DB...');
const res = await pool.query(`SELECT id, model_code FROM catalog_vehicles`);
const dbMap: Record<string, string> = {};
for (const row of res.rows) dbMap[row.model_code] = row.id;
console.log(`[2/3] DB co ${res.rows.length} vehicles`);

// Update batch
console.log('[3/3] Bat dau update...');
const client = await pool.connect();
let updated = 0, notFound = 0;
const BATCH = 500;

try {
  await client.query('BEGIN');

  let batch: {id:string; name:string; year:number; make:string}[] = [];

  async function flushBatch() {
    if (!batch.length) return;
    for (const item of batch) {
      await client.query(
        `UPDATE catalog_vehicles 
         SET model_name=$1, year_from=$2, year_to=$2, make=$3, updated_at=NOW()
         WHERE id=$4`,
        [item.name, item.year, item.make, item.id]
      );
    }
    updated += batch.length;
    batch = [];
  }

  let processed = 0;
  for (const code of codes) {
    const id = dbMap[code];
    if (!id) { notFound++; processed++; continue; }

    const info = mapping[code];
    batch.push({ id, name: info.model_name, year: info.year, make: info.make });

    if (batch.length >= BATCH) await flushBatch();

    processed++;
    if (processed % 1000 === 0) {
      const pct = ((processed / codes.length) * 100).toFixed(1);
      console.log(`  [${pct}%] ${processed}/${codes.length} | Updated: ${updated} | Not found: ${notFound}`);
    }
  }

  await flushBatch();
  await client.query('COMMIT');

  console.log('');
  console.log('========== KET QUA ==========');
  console.log(`Da update : ${updated}`);
  console.log(`Khong co  : ${notFound}`);
  console.log('=============================');

  // Verify
  const check = await pool.query(`
    SELECT model_name, COUNT(*) cnt, MIN(year_from) yr_min, MAX(year_to) yr_max
    FROM catalog_vehicles
    WHERE model_name IS NOT NULL
    GROUP BY model_name
    ORDER BY cnt DESC
    LIMIT 10
  `);
  console.log('\nTop 10 dong xe:');
  for (const row of check.rows) {
    console.log(`  ${row.model_name.padEnd(20)} ${row.cnt} xe | ${row.yr_min}-${row.yr_max}`);
  }

} catch(err) {
  await client.query('ROLLBACK');
  console.error('Loi:', err);
} finally {
  client.release();
  await pool.end();
}
