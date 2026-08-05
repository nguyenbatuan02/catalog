/**
 * vin-lookup.ts v3
 * CHI tra cache DB. Khong dung WebSocket nua.
 * Neu cache khong co → tra ve vehicles rong, de index.html
 * tu goi extension PartSouq (chrome.runtime.sendMessage).
 */

import pg from 'pg';

const pool = new pg.Pool({
  host    : process.env.DB_HOST     || 'localhost',
  port    : Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME     || 'zalocrm',
  user    : process.env.DB_USER     || 'crmuser',
  password: process.env.DB_PASSWORD || 'devpassword',
});

export interface VinResult {
  vin        : string;
  vin_prefix : string;
  vehicles   : VinVehicle[];
  source     : 'cache' | 'extension' | 'manual';
  error?     : string;
}

export interface VinVehicle {
  model_code  : string;
  make        : string;
  model_name  : string;
  year        : number | null;
  vehicle_id  : string | null;
}

// ============================================================
// CACHE — tra theo vin_full truoc, roi vin_prefix
// ============================================================
async function checkCache(vinClean: string): Promise<VinVehicle[] | null> {
  const vinPrefix = vinClean.slice(0, 12).toUpperCase();

  // Uu tien khop chinh xac vin_full
  let res = await pool.query(`
    SELECT vc.*, cv.id AS vehicle_id
    FROM catalog_vin_cache vc
    LEFT JOIN catalog_vehicles cv ON cv.model_code = vc.model_code
    WHERE vc.vin_full = $1
    ORDER BY vc.created_at DESC
  `, [vinClean.toUpperCase()]);

  // Khong co → thu vin_prefix (xe cung dong)
  if (!res.rows.length) {
    res = await pool.query(`
      SELECT vc.*, cv.id AS vehicle_id
      FROM catalog_vin_cache vc
      LEFT JOIN catalog_vehicles cv ON cv.model_code = vc.model_code
      WHERE vc.vin_prefix = $1
      ORDER BY vc.created_at DESC
    `, [vinPrefix]);
  }

  if (!res.rows.length) return null;
  return res.rows.map((r: any) => ({
    model_code : r.model_code || '',
    make       : r.make || '',
    model_name : r.model_name || '',
    year       : r.year || null,
    vehicle_id : r.vehicle_id || null,
  }));
}

async function saveCache(vin: string, vehicles: VinVehicle[], source = 'extension'): Promise<void> {
  const vinPrefix = vin.slice(0, 12).toUpperCase();
  const client    = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const v of vehicles) {
      if (!v.model_code) continue;
      await client.query(`
        INSERT INTO catalog_vin_cache
          (vin_full, vin_prefix, model_code, make, model_name, year, source)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (vin_full, model_code) DO UPDATE SET
          make=EXCLUDED.make, model_name=EXCLUDED.model_name,
          year=EXCLUDED.year, updated_at=NOW()
      `, [vin.toUpperCase(), vinPrefix, v.model_code, v.make, v.model_name, v.year, source]);
    }
    await client.query('COMMIT');
    console.log(`[VIN] Saved ${vehicles.length} vehicles to cache`);
  } catch(e) {
    await client.query('ROLLBACK');
    console.error('[VIN] Cache save error:', e);
  } finally {
    client.release();
  }
}

// ============================================================
// MATCH CATALOG
// ============================================================
// Nhãn DANH MỤC PartSouq (không phải hãng xe thật) → coi như rỗng để chuẩn hóa
function isJunkMake(m: string): boolean {
  const s = (m || '').trim().toLowerCase();
  return !s || s.includes('catalog') || s === 'genuine' || s === 'parts';
}
// Chuẩn hóa hãng: make thật thì giữ; rác/rỗng thì suy từ token đầu của model_name
// (VD "LEXUS LX450D/460/570" → "LEXUS"). Không lấy model_code làm mất.
function cleanMake(make: string, modelName: string): string {
  if (make && !isJunkMake(make)) return make;
  const first = (modelName || '').trim().split(/[\s/,]+/)[0] || '';
  return isJunkMake(first) ? '' : first;
}

async function matchWithCatalog(vehicles: VinVehicle[]): Promise<VinVehicle[]> {
  for (const v of vehicles) {
    if (!v.model_code) continue;
    const res = await pool.query(
      `SELECT id, model_name, make, year_from FROM catalog_vehicles WHERE model_code=$1 LIMIT 1`,
      [v.model_code]
    );
    if (res.rows.length) {
      v.vehicle_id = res.rows[0].id;
      if (!v.model_name) v.model_name = res.rows[0].model_name || '';
      if (!v.year)       v.year       = res.rows[0].year_from || null;
    }
    // Chuẩn hóa make (ưu tiên make thật từ extension → catalog → suy từ model_name). model_code luôn giữ.
    v.make = cleanMake(v.make || (res.rows[0]?.make || ''), v.model_name);
  }
  return vehicles;
}

// ============================================================
// MAIN LOOKUP — chi tra cache DB
// ============================================================
export async function lookupVin(vin: string): Promise<VinResult> {
  const vinClean  = vin.toUpperCase().replace(/\s/g, '');
  const vinPrefix = vinClean.slice(0, 12);

  const cached = await checkCache(vinClean);
  if (cached && cached.length > 0) {
    console.log(`[VIN] Cache hit: ${vinClean} -> ${cached.length} vehicles`);
    return { vin: vinClean, vin_prefix: vinPrefix, vehicles: cached, source: 'cache' };
  }

  // Khong co trong cache — tra ve rong, KHONG bao loi
  // index.html se tu goi extension PartSouq de tra
  console.log(`[VIN] Cache miss: ${vinClean}`);
  return { vin: vinClean, vin_prefix: vinPrefix, vehicles: [], source: 'cache' };
}

// ============================================================
// SAVE — luu ket qua tu extension PartSouq vao cache
// Goi tu endpoint /vin/save khi extension scrape xong
// ============================================================
export async function saveVinFromExtension(
  vin: string, vehicles: VinVehicle[]
): Promise<VinVehicle[]> {
  const vinClean = vin.toUpperCase().replace(/\s/g, '');
  const matched  = await matchWithCatalog(vehicles);
  await saveCache(vinClean, matched, 'extension');
  return matched;
}

// ============================================================
// MANUAL SAVE
// ============================================================
export async function saveVinManual(
  vin: string, modelCode: string, make: string, modelName: string, year: number | null
): Promise<void> {
  const vinClean = vin.toUpperCase().replace(/\s/g, '');
  const vehicles: VinVehicle[] = [{ model_code: modelCode, make, model_name: modelName, year, vehicle_id: null }];
  const matched  = await matchWithCatalog(vehicles);
  await saveCache(vinClean, matched, 'manual');
  console.log(`[VIN] Manual save: ${vinClean} -> ${modelCode}`);
}