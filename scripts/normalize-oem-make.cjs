// Gộp các kiểu viết khác nhau của cùng 1 hãng trong catalog_oem_codes.make
// ("TOYOTA"/"Toyota", "MERCEDES-BENZ"/"MERCEDES", "CHRYSLER (USA)"...) về 1 tên.
// node scripts/normalize-oem-make.cjs          : chạy thử, in bảng gộp
// node scripts/normalize-oem-make.cjs --apply  : backup catalog_oem_codes_make_bak rồi ghi
require('dotenv').config();
const { Pool } = require('pg');

// Tên chuẩn cho các hãng có nhiều cách viết. Hãng không có ở đây: nếu cùng hãng có cả
// dạng HOA lẫn dạng thường ("TOYOTA"/"Toyota") thì lấy dạng thường; chỉ 1 cách viết thì giữ nguyên.
const ALIAS = {
  'HYUNDAI / KIA': 'Hyundai / Kia', 'HYUNDAI': 'Hyundai', 'KIA': 'Kia',
  'MERCEDES': 'Mercedes', 'MERCEDES-BENZ': 'Mercedes', 'DAIMLER AG': 'Mercedes',
  'CHRYSLER (USA)': 'Chrysler', 'CHRYSLER US': 'Chrysler',
  'DODGE (CHRYSLER)': 'Dodge', 'JEEP (CHRYSLER)': 'Jeep', 'PLYMOUTH (CHRYSLER)': 'Plymouth',
  'CHEVROLET (GM)': 'Chevrolet', 'BUICK (GM)': 'Buick', 'CADILLAC (GM)': 'Cadillac', 'BEDFORD (GM)': 'Bedford',
  'GENERAL MOTORS': 'GM', 'DAEWOO-GM': 'Daewoo',
  'FORD (USA)': 'Ford', 'FORD (EUROPE)': 'Ford', 'FORD (JMC)': 'Ford',
  'MINI (BY BMW)': 'Mini', 'MINI': 'Mini', 'NISSAN UD': 'Nissan UD',
  'PEUGEOT / CITROEN': 'Peugeot / Citroen', 'PSA': 'Peugeot / Citroen',
  'CHERRY': 'Chery', 'MITSU': 'Mitsubishi',
  'KASHIYAMA': 'Kashiyama', 'NIBK': 'NiBK',
};

function canon(make, popular) {
  const u = make.trim().toUpperCase();
  if (ALIAS[u]) return ALIAS[u];
  return popular.get(u) || make.trim();
}

const t = (m, w, pop = new Map()) => { if (canon(m, pop) !== w) throw new Error(`${m} -> ${canon(m, pop)}, want ${w}`); };
t('TOYOTA', 'Toyota', new Map([['TOYOTA', 'Toyota']]));
t('HYUNDAI / KIA', 'Hyundai / Kia');
t('MERCEDES-BENZ', 'Mercedes');
t('CHRYSLER (USA)', 'Chrysler');
t('LAND ROVER', 'Land Rover', new Map([['LAND ROVER', 'Land Rover']]));
t('FMSI', 'FMSI');
t('BMW', 'BMW');

(async () => {
  const pool = new Pool({ host: process.env.DB_HOST, port: process.env.DB_PORT, database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD });
  const { rows } = await pool.query(`SELECT make, count(*)::int n FROM catalog_oem_codes WHERE make IS NOT NULL GROUP BY 1`);
  // Cách viết phổ biến nhất của mỗi hãng (theo UPPER), ưu tiên dạng có chữ thường
  const popular = new Map();
  for (const r of [...rows].sort((a, b) => b.n - a.n)) {
    const u = r.make.trim().toUpperCase();
    if (!popular.has(u) && r.make !== u) popular.set(u, r.make.trim());
  }
  const map = rows.map(r => ({ from: r.make, to: canon(r.make, popular), n: r.n })).filter(x => x.from !== x.to);
  for (const x of map.sort((a, b) => a.to.localeCompare(b.to))) console.log(`${x.from.padEnd(22)} -> ${x.to} (${x.n})`);
  const after = new Set(rows.map(r => canon(r.make, popular)));
  console.log(`${rows.length} giá trị -> ${after.size}; đổi ${map.reduce((s, x) => s + x.n, 0)} dòng`);
  if (process.argv.includes('--apply')) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`CREATE TABLE IF NOT EXISTS catalog_oem_codes_make_bak AS SELECT DISTINCT make FROM catalog_oem_codes`);
      await c.query(`UPDATE catalog_oem_codes o SET make = m.t FROM unnest($1::text[], $2::text[]) m(f, t) WHERE o.make = m.f`,
        [map.map(x => x.from), map.map(x => x.to)]);
      await c.query('COMMIT'); console.log('Đã ghi.');
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }
  await pool.end();
})();
