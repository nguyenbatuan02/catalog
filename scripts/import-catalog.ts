/**
 * import-catalog.ts
 * Import JSON từ Odoo vào PostgreSQL
 * Dùng: npm run import -- --file ./data/odoo-export.json
 */

import 'dotenv/config';
import fs   from 'fs';
import path from 'path';
import pg   from 'pg';

const pool = new pg.Pool({
  host: process.env.DB_HOST||'localhost', port: Number(process.env.DB_PORT)||5432,
  database: process.env.DB_NAME||'zalocrm', user: process.env.DB_USER||'crmuser',
  password: process.env.DB_PASSWORD||'devpassword',
});

const args = process.argv.slice(2);
const fi   = args.indexOf('--file');
if (fi === -1 || !args[fi+1]) { console.error('Dùng: npm run import -- --file ./data/odoo-export.json'); process.exit(1); }
const filePath = path.resolve(args[fi+1]);

const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
const isByVehicle = Array.isArray(data) && data[0]?.products;
console.log(`📋 Format: ${isByVehicle ? 'grouped by vehicle' : 'flat products'}`);
console.log(`📦 Records: ${isByVehicle ? data.length + ' vehicles' : data.length + ' products'}`);

const client = await pool.connect();
let vCount=0, pCount=0, fCount=0, skip=0;

async function upsertVehicle(make: string, model_code: string, opts?: any): Promise<string> {
  const r = await client.query(`
    INSERT INTO catalog_vehicles (make,model_code,model_name,year_from,year_to,odoo_ref)
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (make,model_code) DO UPDATE SET
      model_name=COALESCE(EXCLUDED.model_name,catalog_vehicles.model_name),
      year_from=COALESCE(EXCLUDED.year_from,catalog_vehicles.year_from),
      year_to=COALESCE(EXCLUDED.year_to,catalog_vehicles.year_to),
      updated_at=NOW()
    RETURNING id
  `, [make, model_code, opts?.model_name, opts?.year_from, opts?.year_to, opts?.odoo_ref]);
  return r.rows[0].id;
}

async function upsertProduct(p: any): Promise<string> {
  const r = await client.query(`
    INSERT INTO catalog_products (name,internal_ref,oem_code,is_for_sale,odoo_id)
    VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (internal_ref) WHERE internal_ref IS NOT NULL DO UPDATE SET
      name=EXCLUDED.name, oem_code=COALESCE(EXCLUDED.oem_code,catalog_products.oem_code),
      is_for_sale=EXCLUDED.is_for_sale, updated_at=NOW()
    RETURNING id
  `, [p.name.trim(), p.default_code?.trim()||null, p.barcode?.trim()||null, p.sale_ok!==false, p.id]);
  return r.rows[0].id;
}

try {
  await client.query('BEGIN');

  if (isByVehicle) {
    for (const v of data) {
      const parts = v.odoo_ref?.split('/')||[];
      const make  = v.make||parts[0]||'Unknown';
      const code  = v.model_code||parts[1]||v.odoo_ref;
      const vid   = await upsertVehicle(make, code, { model_name:v.model_name, year_from:v.year_from, year_to:v.year_to, odoo_ref:v.odoo_ref });
      vCount++;
      for (const p of (v.products||[])) {
        if (!p.name?.trim()) { skip++; continue; }
        try {
          const pid = await upsertProduct(p); pCount++;
          await client.query(`INSERT INTO catalog_fitments (product_id,vehicle_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [pid,vid]);
          fCount++;
        } catch { skip++; }
      }
      process.stdout.write(`\r✅ ${vCount}/${data.length} model xe...`);
    }
  } else {
    const vcache: Record<string,string> = {};
    for (let i=0; i<data.length; i++) {
      const p = data[i];
      if (!p.name?.trim()) { skip++; continue; }
      try {
        const pid = await upsertProduct(p); pCount++;
        if (p.vehicle_model||(p.make&&p.model_code)) {
          const ref = p.vehicle_model||`${p.make}/${p.model_code}`;
          if (!vcache[ref]) { const pts=ref.split('/'); vcache[ref]=await upsertVehicle(p.make||pts[0],p.model_code||pts[1],{odoo_ref:ref}); vCount++; }
          await client.query(`INSERT INTO catalog_fitments (product_id,vehicle_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [pid,vcache[ref]]);
          fCount++;
        }
      } catch { skip++; }
      if (i%500===0) process.stdout.write(`\r📦 ${i}/${data.length}...`);
    }
  }

  await client.query('COMMIT');
  console.log('\n\n========== KẾT QUẢ ==========');
  console.log(`✅ Model xe : ${vCount}`);
  console.log(`✅ Sản phẩm : ${pCount}`);
  console.log(`✅ Fitments : ${fCount}`);
  console.log(`⚠️  Bỏ qua  : ${skip}`);
  console.log('==============================');
} catch (err) {
  await client.query('ROLLBACK');
  console.error('\n❌ Import thất bại:', err);
} finally {
  client.release();
  await pool.end();
}
