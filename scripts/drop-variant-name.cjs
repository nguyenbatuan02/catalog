// Bỏ tên dòng xe bị lặp ở đầu cột variant (đã có trong model_name -> bộ lọc "Dòng xe").
// Giữ lại nếu: variant cụ thể hơn model_name ("LAND CRUISER 200" vs "LAND CRUISER"),
// hoặc bỏ đi làm 2 bản trùng variant_key (Mazda: 1 model_code dùng cho 2 dòng 626/MX-6).
// node scripts/drop-variant-name.cjs [--apply]
require('dotenv').config();
const { Pool } = require('pg');
const norm = x => (x || '').toUpperCase().replace(/^LEXUS /, '').replace(/[^A-Z0-9]/g, '');
const KEY = ['year_from', 'year_to', 'engine', 'transmission', 'drive_type', 'steering', 'gear_shift', 'description'];

function strip(v) {
  const parts = (v.variant || '').split(' | '), f = norm(parts[0]), name = norm(v.model_name);
  const names = (v.model_name || '').toUpperCase().replace(/^LEXUS /, '').split('/').map(norm);
  // f trùng tên, hoặc f là tiền tố của tên (Lexus "ES" vs "LEXUS ES300")
  if (f && (f === name || names.includes(f) || name.startsWith(f))) return parts.slice(1).join(' | ') || null;
  return v.variant;
}
const t = (v, w) => { if (strip(v) !== w) throw new Error(`${JSON.stringify(v)} -> ${strip(v)}`); };
t({ model_name: 'Defender 1987-2006', variant: 'Defender 1987-2006' }, null);
t({ model_name: 'LEXUS ES300', variant: 'ES | Body: HARDTOP' }, 'Body: HARDTOP');
t({ model_name: 'PREVIA/TARAGO', variant: 'PREVIA' }, null);
t({ model_name: 'LAND CRUISER', variant: 'LAND CRUISER 200' }, 'LAND CRUISER 200');
t({ model_name: 'Nissan', variant: '2 DOOR COUPE; Bản: GT-R' }, '2 DOOR COUPE; Bản: GT-R');

(async () => {
  const pool = new Pool({ host: process.env.DB_HOST, port: process.env.DB_PORT, database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD });
  const { rows } = await pool.query(`SELECT id, make, model_code, model_name, variant, ${KEY.join(',')} FROM catalog_vehicles`);
  const key = (v, variant) => [v.make, v.model_code, ...KEY.map(c => v[c]), variant].map(x => (x ?? '').toString().toUpperCase()).join('|');
  const next = new Map(rows.map(v => [v.id, strip(v)]));
  // lặp: bản nào bỏ tên mà đụng key -> giữ nguyên
  for (let changed = true; changed;) {
    changed = false; const seen = new Map();
    for (const v of rows) { const k = key(v, next.get(v.id)); if (seen.has(k)) for (const id of [v.id, seen.get(k)]) { const o = rows.find(r => r.id === id); if (next.get(id) !== o.variant) { next.set(id, o.variant); changed = true; } } else seen.set(k, v.id); }
  }
  const ch = rows.filter(v => next.get(v.id) !== v.variant), kept = rows.filter(v => v.variant && strip(v) !== v.variant && next.get(v.id) === v.variant);
  const by = {}; for (const v of ch) by[v.make] = (by[v.make] || 0) + 1;
  console.log('bỏ tên lặp:', ch.length, by, '| giữ vì sẽ trùng:', kept.length);
  if (process.argv.includes('--apply')) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`CREATE TABLE IF NOT EXISTS catalog_vehicles_variant_bak AS SELECT id, variant FROM catalog_vehicles`);
      await c.query(`UPDATE catalog_vehicles c SET variant = u.v FROM unnest($1::uuid[], $2::text[]) u(id, v) WHERE c.id = u.id`, [ch.map(v => v.id), ch.map(v => next.get(v.id))]);
      await c.query('COMMIT'); console.log('Đã ghi. Khôi phục: UPDATE catalog_vehicles c SET variant=b.variant FROM catalog_vehicles_variant_bak b WHERE c.id=b.id');
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }
  await pool.end();
})();
