/**
 * vin-lookup.ts v4
 * Tra cache DB truoc. Cache miss → TU DONG cao PartSouq server-side qua
 * scripts/vin.py (undetected_chromedriver — ne duoc chan Cloudflare vi gia
 * lap trinh duyet that). Khong con phu thuoc extension client nua — khach
 * khong can cai gi ca, server tu lam het.
 */

import pg from 'pg';
import { spawn } from 'node:child_process';

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
  source     : 'cache' | 'live-scrape' | 'extension' | 'manual';
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
// CAO LIVE server-side — spawn scripts/vin.py (undetected_chromedriver).
// CHI 1 phien Chrome chay cung luc (queue) — mo nhieu cua so that dong
// thoi rat ton tai nguyen server va de bi Cloudflare nghi ngo hon.
// ============================================================
interface VinScrapeResult {
  ok: boolean;
  brand?: string;
  year?: string;
  name?: string;
  model_code?: string;
  error?: string;
}

const VIN_PY_PATH = process.env.VIN_PY_PATH || 'scripts/vin.py'; // tương đối với thư mục chạy npm start
const PYTHON_BIN   = process.env.PYTHON_BIN  || 'python';
// IP server nay bi PartSouq chan → cao qua worker chay o IP khac.
// VIN_WORKER_URL=http://103.154.244.98:3388  (rong = cao local nhu cu)
const VIN_WORKER_URL   = process.env.VIN_WORKER_URL   || '';
const VIN_WORKER_TOKEN = process.env.VIN_WORKER_TOKEN || '';
let vinScrapeQueue: Promise<any> = Promise.resolve();

async function scrapeVinViaWorker(vin: string, timeoutMs: number): Promise<VinScrapeResult> {
  const url = `${VIN_WORKER_URL.replace(/\/$/, '')}/vin?vin=${encodeURIComponent(vin)}`
            + (VIN_WORKER_TOKEN ? `&token=${encodeURIComponent(VIN_WORKER_TOKEN)}` : '');
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, error: `Worker VIN loi HTTP ${res.status}` };
    return await res.json() as VinScrapeResult;
  } catch (e: any) {
    return { ok: false, error: `Khong goi duoc worker VIN: ${e.message}` };
  }
}

function scrapeVinLiveRaw(vin: string, timeoutMs = 75000): Promise<VinScrapeResult> {
  if (VIN_WORKER_URL) return scrapeVinViaWorker(vin, timeoutMs);
  return new Promise((resolve) => {
    const proc = spawn(PYTHON_BIN, [VIN_PY_PATH, vin]);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill();
      resolve({ ok: false, error: 'Timeout tra VIN (quá 75s)' });
    }, timeoutMs);

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', () => {
      clearTimeout(timer);
      const lines = stdout.trim().split('\n').filter(Boolean);
      const lastLine = lines[lines.length - 1];
      try {
        resolve(JSON.parse(lastLine));
      } catch {
        resolve({ ok: false, error: `Không đọc được kết quả scrape: ${(stderr || stdout).slice(0, 300)}` });
      }
    });
    proc.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `Không chạy được vin.py: ${e.message}` });
    });
  });
}

// Xep hang — request sau doi request truoc xong moi chay, tranh mo nhieu Chrome cung luc.
function scrapeVinLive(vin: string): Promise<VinScrapeResult> {
  const run = vinScrapeQueue.then(() => scrapeVinLiveRaw(vin));
  vinScrapeQueue = run.catch(() => {});
  return run;
}

// ============================================================
// MAIN LOOKUP — tra cache truoc, cache miss thi tu dong cao live
// ============================================================
export async function lookupVin(vin: string): Promise<VinResult> {
  const vinClean  = vin.toUpperCase().replace(/\s/g, '');
  const vinPrefix = vinClean.slice(0, 12);

  const cached = await checkCache(vinClean);
  if (cached && cached.length > 0) {
    console.log(`[VIN] Cache hit: ${vinClean} -> ${cached.length} vehicles`);
    return { vin: vinClean, vin_prefix: vinPrefix, vehicles: cached, source: 'cache' };
  }

  console.log(`[VIN] Cache miss: ${vinClean} — cào live qua PartSouq...`);
  const scraped = await scrapeVinLive(vinClean);
  if (scraped.ok && scraped.model_code) {
    const matched = await saveVinFromScraper(vinClean, [{
      model_code: scraped.model_code,
      make      : scraped.brand || '',
      model_name: scraped.name || '',
      year      : scraped.year ? parseInt(scraped.year) : null,
      vehicle_id: null,
    }]);
    console.log(`[VIN] Cào live thành công: ${vinClean} -> ${scraped.brand} ${scraped.name} (${scraped.model_code})`);
    return { vin: vinClean, vin_prefix: vinPrefix, vehicles: matched, source: 'live-scrape' };
  }

  console.log(`[VIN] Cào live thất bại: ${vinClean} — ${scraped.error}`);
  return { vin: vinClean, vin_prefix: vinPrefix, vehicles: [], source: 'cache', error: scraped.error };
}

// ============================================================
// SAVE — luu ket qua cao duoc (live scrape hoac extension) vao cache
// ============================================================
export async function saveVinFromScraper(
  vin: string, vehicles: VinVehicle[]
): Promise<VinVehicle[]> {
  const vinClean = vin.toUpperCase().replace(/\s/g, '');
  const matched  = await matchWithCatalog(vehicles);
  await saveCache(vinClean, matched, 'live-scrape');
  return matched;
}

// Giu lai ten cu — /vin/save (extension client, neu sau nay co ai cai) van goi duoc.
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