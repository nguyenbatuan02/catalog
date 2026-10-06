// Tách cột description: chỉ giữ THỊ TRƯỜNG; phần còn lại (kiểu thân, bản, mã khung...) -> cột mới `variant`.
// variant_key (khoá chống trùng) được tạo lại để tính cả `variant`.
// node scripts/split-market.cjs          : chạy thử -> market-preview.csv
// node scripts/split-market.cjs --apply  : backup catalog_vehicles_market_bak, thêm cột, ghi, tạo lại variant_key (1 transaction)
require('dotenv').config();
const fs = require('fs');
const { Pool } = require('pg');
const s = x => (x ?? '').toString().trim();

// Mã thị trường Hyundai/Kia
const HK = { GEN: 'General', EUR: 'Europe', MES: 'Middle East', DOM: 'Korea', AUS: 'Australia', HAC: 'Canada', HMA: 'USA',
  CIS: 'CIS', USA: 'USA', CAN: 'Canada', PUT: 'Puerto Rico', HMI: 'India' };
const TOYOTA_MARKET = /^(General|Europe|Japan|USA \/ Canada|USA|Canada|Australia|Middle East|Asia)$/i;
const NO_MARKET = ['Lexus', 'Land Rover', 'Peugeot'];          // phần đầu là dòng xe / loại xe
const MARKET_SECOND = ['Hyundai', 'Kia', 'Mazda'];             // "Passenger | EUR", "626 | America"

function split(v) {
  const parts = s(v.description).split(' | ').filter(Boolean);
  if (!parts.length) return { market: null, variant: null };
  let market = null, rest = parts;
  if (NO_MARKET.includes(v.make)) rest = parts;
  else if (MARKET_SECOND.includes(v.make)) { market = parts[1] || null; rest = [parts[0], ...parts.slice(2)]; }
  else if (['Toyota'].includes(v.make)) { if (TOYOTA_MARKET.test(parts[0])) { market = parts[0]; rest = parts.slice(1); } }
  else { market = parts[0]; rest = parts.slice(1); }
  // Infiniti: 3 xe phần đầu là mã model/bản ("H15E", "SPORT") chứ không phải thị trường
  if (market && (market === v.model_code || market === 'SPORT')) { rest = parts; market = null; }
  if (market && ['Hyundai', 'Kia'].includes(v.make)) market = market.split(';').map(c => HK[c] || c).filter((x, i, a) => a.indexOf(x) === i).join(', ');
  return { market: market || null, variant: rest.join(' | ') || null };
}

// Self-check
const t = (v, m, r) => { const o = split(v); if (o.market !== m || o.variant !== r) throw new Error(`${JSON.stringify(v)} -> ${JSON.stringify(o)}`); };
t({ make: 'Nissan', description: 'USA | SEAT TYPE:2 ROW SEATS; Bản: SV' }, 'USA', 'SEAT TYPE:2 ROW SEATS; Bản: SV');
t({ make: 'Nissan', description: 'Japan' }, 'Japan', null);
t({ make: 'Hyundai', description: 'Passenger | EUR;CIS;GEN' }, 'Europe, CIS, General', 'Passenger');
t({ make: 'Kia', description: 'R/V | HMA;HAC' }, 'USA, Canada', 'R/V');
t({ make: 'Mazda', description: '323 | Canada | Khung: BG' }, 'Canada', '323 | Khung: BG');
t({ make: 'Toyota', description: 'General | Seating Capacity: 7-SEATER' }, 'General', 'Seating Capacity: 7-SEATER');
t({ make: 'Toyota', description: 'CAMRY' }, null, 'CAMRY');
t({ make: 'Toyota', description: null }, null, null);
t({ make: 'Lexus', description: 'RZ | Seating Capacity: 5-SEATER' }, null, 'RZ | Seating Capacity: 5-SEATER');
t({ make: 'Mitsubishi', description: 'Europe | 2000/2WD(VAN) - DX,5CM/T LHD | K0-K3#' }, 'Europe', '2000/2WD(VAN) - DX,5CM/T LHD | K0-K3#');
t({ make: 'Honda', description: 'America | KA | 49 STATE | 2 cửa' }, 'America', 'KA | 49 STATE | 2 cửa');

const KEY_COLS = ['year_from', 'year_to', 'engine', 'transmission', 'drive_type', 'steering', 'gear_shift', 'description', 'variant'];
const VK_SQL = `upper(${KEY_COLS.map(c => `COALESCE(${c}::text, '')`).join(` || '|' || `)})`;

(async () => {
  const apply = process.argv.includes('--apply');
  const pool = new Pool({ host: process.env.DB_HOST, port: process.env.DB_PORT, database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD });
  const { rows } = await pool.query(`SELECT id, make, model_code, ${KEY_COLS.filter(c => c !== 'variant').join(', ')} FROM catalog_vehicles`);
  const keys = new Map(), errs = [], out = [], stats = {};
  for (const v of rows) {
    const o = split(v), n = { ...v, description: o.market, variant: o.variant };
    const k = [v.make, v.model_code, ...KEY_COLS.map(c => s(n[c]).toUpperCase())].join('|');
    if (keys.has(k)) errs.push(`trùng ${keys.get(k)} / ${v.id}: ${k}`); keys.set(k, v.id);
    if (s(o.market).length > 255) errs.push(`market quá dài ${v.id}`);
    out.push({ id: v.id, market: o.market, variant: o.variant });
    const st = stats[v.make] ??= {}; st[o.market || '∅'] = (st[o.market || '∅'] || 0) + 1;
  }
  for (const [mk, m] of Object.entries(stats)) console.log(mk.padEnd(11), Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}(${n})`).join(' ‖ ').slice(0, 400));
  fs.writeFileSync('market-preview.csv', 'id,make,model_code,description_cu,thi_truong,variant\n' + rows.map((v, i) =>
    [v.id, v.make, v.model_code, v.description, out[i].market, out[i].variant].map(x => `"${s(x).replace(/"/g, '""')}"`).join(',')).join('\n'));
  console.log(`-> market-preview.csv`);
  if (errs.length) { console.log(errs.slice(0, 10).join('\n'), `\n${errs.length} lỗi — KHÔNG ghi`); await pool.end(); process.exit(1); }

  if (apply) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`CREATE TABLE IF NOT EXISTS catalog_vehicles_market_bak AS SELECT id, description FROM catalog_vehicles`);
      await c.query(`ALTER TABLE catalog_vehicles ADD COLUMN IF NOT EXISTS variant text`);
      await c.query(`ALTER TABLE catalog_vehicles DROP COLUMN variant_key`);   // kéo theo index catalog_vehicles_key
      await c.query(`UPDATE catalog_vehicles c SET description = u.m, variant = u.r FROM unnest($1::uuid[], $2::text[], $3::text[]) u(id, m, r) WHERE c.id = u.id`,
        [out.map(o => o.id), out.map(o => o.market), out.map(o => o.variant)]);
      await c.query(`ALTER TABLE catalog_vehicles ADD COLUMN variant_key text GENERATED ALWAYS AS (${VK_SQL}) STORED`);
      await c.query(`CREATE UNIQUE INDEX catalog_vehicles_key ON catalog_vehicles (make, model_code, variant_key)`);
      await c.query('COMMIT');
      console.log('Đã ghi. Khôi phục description: UPDATE catalog_vehicles c SET description=b.description FROM catalog_vehicles_market_bak b WHERE c.id=b.id');
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }
  await pool.end();
})();
