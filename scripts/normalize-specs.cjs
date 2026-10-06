// Sắp xếp lại thông số xe vào đúng cột, theo kiểu dữ liệu riêng của từng hãng.
//   engine       động cơ
//   gear_shift   hộp số (AT/MT/CVT, số cấp, mã hộp số)
//   drive_type   dẫn động (2WD/4WD/AWD/FWD)
//   steering     tay lái (LHD/RHD)
//   transmission để trống sau khi tách (trước đây là nơi dồn mọi thứ)
//   description  thị trường + phần còn lại không thuộc cột nào (kiểu thân, bản, số chỗ...) — nối thêm, không xoá
//   vehicle_type loại xe
// node scripts/normalize-specs.cjs          : chạy thử -> specs-preview.csv
// node scripts/normalize-specs.cjs --apply  : backup catalog_vehicles_specs_bak rồi ghi (1 transaction)
// ĐÃ CHẠY XONG 2026-10-05, viết cho cấu trúc cũ (description gồm cả biến thể). Sau split-market.cjs
// phần biến thể nằm ở cột variant — chạy lại script này sẽ ghi sai. Giữ để tham khảo luật tách.
if (!process.argv.includes('--legacy')) { console.error('Script cũ, đã chạy xong. Xem ghi chú đầu file.'); process.exit(1); }
require('dotenv').config();
const fs = require('fs');
const { Pool } = require('pg');

const COLS = ['engine', 'gear_shift', 'drive_type', 'steering', 'transmission', 'description', 'vehicle_type'];
const MAXLEN = { engine: 100, gear_shift: 50, drive_type: 20, steering: 10, transmission: 50, description: 255, vehicle_type: 50 };
const s = x => (x ?? '').toString().trim();

// ── từ điển chung ───────────────────────────────────────────
function gearType(x) {
  const t = /EV TRACTION/i.test(x) ? 'EV' : /AUTOMATED SEQ/i.test(x) ? 'AMT' : /CONTINUOUSLY|\bCVT?\b|^CVFC$/i.test(x) ? 'CVT'
    : /AUTO|\bATM?\b|A\/T/i.test(x) ? 'AT' : /MANUAL|\bMTM?\b|M\/T/i.test(x) ? 'MT' : '';
  const n = x.match(/(\d)[- ]?SPEED/i);
  return [t, n ? `${n[1]} cấp` : ''].filter(Boolean).join(' ');
}
function driveOf(x) {
  if (/AWD|ALL WHEEL/i.test(x)) return 'AWD';
  if (/4WD|4X4|4 WHEEL/i.test(x)) return '4WD';
  if (/FWD/i.test(x)) return 'FWD';
  if (/2WD|2 WHEEL/i.test(x)) return '2WD';
  return null;
}
const steerOf = x => /\bLHD\b|LEFT|\(LH/i.test(x) ? 'LHD' : /\bRHD\b|RIGHT|\(RH/i.test(x) ? 'RHD' : null;
const addDesc = (n, ...parts) => { const p = parts.map(s).filter(Boolean); if (p.length) n.description = [s(n.description), ...p].filter(Boolean).join(' | '); };

// ── theo hãng ───────────────────────────────────────────────
const RULES = {
  // "ATM,MTM: AUTOMATIC TRANSMISSION; Driver's Position: LEFT-HAND DRI" (bị cắt 32 ký tự lúc crawl) hoặc mã ngắn "MTM 5F"
  Toyota(v, n) {
    const t = s(v.transmission); if (!t) return;
    n.transmission = null;
    if (!t.includes(':')) { n.gear_shift = /^ATM CV$|^CVFC$/.test(t) ? 'CVT' : t.replace(/\bATM\b/, 'AT').replace(/\bMTM\b/, 'MT'); return; }
    const rest = [];
    for (const seg of t.split(';')) {
      const i = seg.indexOf(':'); if (i < 0) continue;              // đoạn cuối bị cắt mất ("Dr", "Se") -> bỏ
      const k = seg.slice(0, i).trim(), val = seg.slice(i + 1).trim(); if (!val) continue;
      if (/^ATM,MTM$|^Gear Shift/i.test(k)) n.gear_shift = gearType(val) || val;
      else if (/^Driver's Position/i.test(k)) n.steering = steerOf(val);
      else if (/^Drive Train/i.test(k)) n.drive_type = driveOf(val);
      else if (/^Engine$/i.test(k)) { const m = val.match(/\(([A-Z0-9-]+)\)/); if (m && !n.engine) n.engine = m[1]; }
      else rest.push(`${k}: ${val}`);
    }
    addDesc(n, rest.join('; '));
  },
  // VAG: "VUQ(7A)" = mã hộp số + (số cấp + S thường / A tự động / C ly hợp kép / E điện / HA hybrid)
  Volkswagen(v, n) {
    const m = s(v.transmission).match(/^([A-Z0-9]{3,5})\((\d?)([A-Z]{1,2})\)$/); if (!m) return;
    const t = { S: 'MT', A: 'AT', C: 'DSG', E: 'EV', HA: 'AT Hybrid' }[m[3]];
    n.gear_shift = t ? `${t}${m[2] && m[3] !== 'E' ? ` ${m[2]} cấp` : ''} (${m[1]})` : s(v.transmission);
    n.transmission = null;
  },
  // "2000/2WD(VAN)<87M-> - DX(4DOOR),5CM/T LHD" đã nằm trong description; transmission = nhóm mã khung "K0-K3#"
  Mitsubishi(v, n) {
    const opt = s(v.description).split(' | ')[1] || '';
    n.drive_type = driveOf(opt) || n.drive_type;
    const e = s(v.engine).match(/^(\d{4})D\//); if (e) { n.engine = `${(e[1] / 1000).toFixed(1)}L Diesel`; addDesc(n, v.engine); }  // "2500D/2WD/LONG(TRUCK)..."
    const g = opt.match(/(\d)([A-Z]{0,2})(A|M)\/T/); if (g) n.gear_shift = `${g[3] === 'A' ? 'AT' : 'MT'} ${g[1]} cấp`;
    n.steering = steerOf(opt) || n.steering;
    if (v.transmission) { addDesc(n, v.transmission); n.transmission = null; }
  },
  // transmission = loại xe (Car/Van/Cross-country Vehicle) — phân biệt bản trùng nên nối vào description (vehicle_type không nằm trong variant_key)
  Mercedes(v, n) { if (v.transmission) { addDesc(n, v.transmission); n.transmission = null; } },
  // model_code "2.2 EXECUTIVE"/"3.0IV6" chứa dung tích; transmission = thị trường/tùy chọn; steering = số cửa; drive_type = mã kiểu JP
  Honda(v, n) {
    const m = s(v.model_code).match(/^(\d\.\d)\s?I?(V6)?/); if (m && !n.engine) n.engine = `${m[1]}L${m[2] ? ' V6' : ''}`;
    const doors = s(v.steering).match(/^(\d)/);
    addDesc(n, v.transmission, doors ? `${doors[1]} cửa` : '', v.drive_type);
    n.transmission = null; n.steering = null; n.drive_type = null;
  },
  // transmission "WHEEL DRIVE:4WD; AREA:EUROPE; SEAT TYPE:..."; drive_type = kiểu thân; steering = bản trang bị; gear_shift = mã khung
  Nissan(v, n) {
    if (!v.transmission && /^(2WD|4WD|AWD|FWD)?$/.test(s(v.drive_type)) && /^(LHD|RHD)?$/.test(s(v.steering))) return; // đã chuẩn hoá
    const rest = [];
    for (const seg of s(v.transmission).split(';').map(x => x.trim()).filter(Boolean)) {
      const [k, val] = seg.split(':').map(x => x.trim());
      if (/^WHEEL DRIVE$/i.test(k) && val) n.drive_type = driveOf(val) || (/2WD/.test(val) ? '2WD' : null);
      else rest.push(seg);
    }
    const st = s(v.steering);
    if (/^\d[AM]T$/.test(st)) n.gear_shift = `${st[1]}T ${st[0]} cấp`;
    else if (/^(M9R|R9M|TD27|Z24S)$/.test(st)) { if (!n.engine) n.engine = st; }
    else if (st && !/^(Europe \(LH|USA)$/.test(st)) rest.push(`Bản: ${st}`);
    const body = s(v.drive_type);
    if (body) rest.unshift(body);
    if (v.gear_shift && !/^\d[AM]T$/.test(st)) rest.push(`Khung: ${v.gear_shift}`), n.gear_shift = null;
    if (!v.transmission || !driveOf(s(v.transmission))) n.drive_type = n.drive_type === body ? null : n.drive_type;
    n.steering = steerOf(s(v.description)) || (/^Europe \(LH$/.test(st) ? 'LHD' : null);
    n.transmission = null;
    addDesc(n, rest.join('; '));
  },
  // transmission = kiểu thân; gear_shift đã đúng (hộp số)
  Peugeot(v, n) {
    if (v.transmission) { addDesc(n, v.transmission); n.transmission = null; }
    const g = s(v.gear_shift); if (g) { n.drive_type = driveOf(g) || n.drive_type; }
  },
  // LHD/RHD lẫn ở transmission/gear_shift; hộp số ở transmission hoặc gear_shift; động cơ bị cắt ở steering
  'Land Rover'(v, n) {
    const t = s(v.transmission), g = s(v.gear_shift), st = s(v.steering);
    const box = [t, g].find(x => /TRANS|SPEED|MAN|AUTO|^(AT|MT|AMT)\b/i.test(x)) || null;
    n.steering = steerOf(st) || steerOf(t) || steerOf(g);
    if (!steerOf(st) && st && !n.engine) n.engine = { 'Lion Diese': 'Lion Diesel' }[st] || st;
    n.gear_shift = box; n.transmission = null;
    if (box) n.drive_type = driveOf(box) || n.drive_type;
  },
  Mazda(v, n) {
    if (/^[LR]$/.test(s(v.steering))) n.steering = `${v.steering}HD`;
    if (v.drive_type) { addDesc(n, `Khung: ${v.drive_type}`); n.drive_type = null; }
  },
  Suzuki(v, n) { if (v.transmission) { addDesc(n, v.transmission); n.transmission = null; } },
};
RULES.Lexus = RULES.Toyota;
RULES.Audi = RULES.Porsche = RULES.Volkswagen;
RULES.Infiniti = RULES.Nissan;
RULES.Isuzu = RULES.Suzuki;

// Thống nhất hộp số về "AT|MT|CVT|AMT N cấp (mã)". Đã đúng dạng thì giữ nguyên.
function unifyGear(g) {
  g = s(g); if (!g || /^(AT|MT|CVT|AMT|DSG|EV)( |$)/.test(g) && !/\d[A-Z]{1,2}$/.test(g)) return g || null;
  const n = (g.match(/(\d)[- ]?SPEED/i) || g.match(/GEARBOX (\d)|GBOX (\d)|BVA ?(?:AM)?(\d)|^(?:AT|MT) (\d)F/i) || []).slice(1).find(Boolean);
  const t = /PILOTED/i.test(g) ? 'AMT' : /AUTO|BVA|^AT\b/i.test(g) ? 'AT' : /MAN|^MT\b/i.test(g) ? 'MT' : null;
  if (!t) return g;                                                      // "5F", "4FC" (Toyota): không rõ AT/MT -> giữ
  const code = g.match(/\b(\dHP\d\d|AWF\d\d|M66|MT82|S6-53|AM6)\b/i);
  return `${t}${n ? ` ${n} cấp` : ''}${code ? ` (${code[1]})` : ''}`;
}

function normalize(v) {
  const n = Object.fromEntries(COLS.map(c => [c, v[c] ?? null]));
  RULES[v.make]?.(v, n);
  n.gear_shift = unifyGear(n.gear_shift);
  for (const c of COLS) if (n[c] === '') n[c] = null;
  return n;
}

// Self-check
const eq = (v, want) => { const n = normalize(v); for (const [k, x] of Object.entries(want)) if ((n[k] ?? null) !== x) throw new Error(`${JSON.stringify(v)}.${k} -> ${n[k]}, want ${x}`); };
eq({ make: 'Toyota', transmission: "ATM,MTM: AUTOMATIC TRANSMISSION; Driver's Position: LEFT-HAND DRI", description: 'CAMRY' },
  { gear_shift: 'AT', steering: 'LHD', transmission: null, description: 'CAMRY' });
eq({ make: 'Toyota', transmission: 'ATM,MTM: MANUAL TRANSMISSION; Dr' }, { gear_shift: 'MT' });
eq({ make: 'Toyota', transmission: 'Gear Shift Type: ATM, 5-SPEED FL' }, { gear_shift: 'AT 5 cấp' });
eq({ make: 'Toyota', transmission: 'Drive Train: 4 WHEEL DRIVE; Roof' }, { drive_type: '4WD' });
eq({ make: 'Toyota', transmission: 'Body: WAGON; Grade: B TYPE; Engine: (4KM) ELECTRIC', description: 'X' }, { engine: '4KM', description: 'X | Body: WAGON; Grade: B TYPE' });
eq({ make: 'Toyota', transmission: 'MTM 5F' }, { gear_shift: 'MT 5 cấp' });
eq({ make: 'Toyota', transmission: 'ATM CV' }, { gear_shift: 'CVT' });
eq({ make: 'Audi', transmission: 'VUQ(7A)' }, { gear_shift: 'AT 7 cấp (VUQ)', transmission: null });
eq({ make: 'Volkswagen', transmission: 'SQT(5S)' }, { gear_shift: 'MT 5 cấp (SQT)' });
eq({ make: 'Mitsubishi', transmission: 'K0-K3#', description: 'Europe | 2000/2WD(VAN)<87M-> - DX(4DOOR),5CM/T LHD' },
  { drive_type: '2WD', gear_shift: 'MT 5 cấp', steering: 'LHD', description: 'Europe | 2000/2WD(VAN)<87M-> - DX(4DOOR),5CM/T LHD | K0-K3#' });
eq({ make: 'Mitsubishi', description: 'Japan | 3000/2WD - XLS(WIDE),4FA/T FED' }, { gear_shift: 'AT 4 cấp' });
eq({ make: 'Honda', model_code: '2.2 EXECUTIVE', steering: '5', transmission: 'CALIFORNIA', description: 'Europe | KG' },
  { engine: '2.2L', steering: null, description: 'Europe | KG | CALIFORNIA | 5 cửa' });
eq({ make: 'Honda', model_code: '3.0IV6' }, { engine: '3.0L V6' });
eq({ make: 'Nissan', transmission: 'SEAT TYPE:2 ROW SEATS; WHEEL DRIVE:4WD; AREA:EUROP', drive_type: '5 DOOR HATCHBACK', steering: 'SV', description: 'Europe (RHD)' },
  { drive_type: '4WD', steering: 'RHD', transmission: null, description: 'Europe (RHD) | 5 DOOR HATCHBACK; SEAT TYPE:2 ROW SEATS; AREA:EUROP; Bản: SV' });
eq({ make: 'Infiniti', steering: '7AT', drive_type: 'SEDAN', description: 'USA' }, { gear_shift: 'AT 7 cấp', drive_type: null, description: 'USA | SEDAN' });
eq({ make: 'Nissan', steering: 'R9M', gear_shift: 'BNR32', description: 'Japan' }, { engine: 'R9M', gear_shift: null, description: 'Japan | Khung: BNR32' });
eq({ make: 'Land Rover', engine: '2.5 DI Diesel Nat Asp', transmission: 'LHD', gear_shift: '5 Speed Manual Transmission' },
  { steering: 'LHD', gear_shift: 'MT 5 cấp', transmission: null });
eq({ make: 'Land Rover', transmission: '8 Speed Auto Trans ZF 8HP70 4WD', steering: 'RHD' }, { gear_shift: 'AT 8 cấp (8HP70)', drive_type: '4WD', transmission: null });
eq({ make: 'Land Rover', steering: 'Lion Diese' }, { engine: 'Lion Diesel', steering: null });
eq({ make: 'Mazda', steering: 'L', drive_type: 'BG3P 100001', description: '323 | Canada' }, { steering: 'LHD', drive_type: null, description: '323 | Canada | Khung: BG3P 100001' });
eq({ make: 'Peugeot', transmission: '5 DOOR SALOON', gear_shift: '4X4 5-speed Manual Gearbox', description: 'Private vehicles' },
  { drive_type: '4WD', transmission: null, description: 'Private vehicles | 5 DOOR SALOON' });
eq({ make: 'Mercedes', transmission: 'Van', description: 'Japan' }, { description: 'Japan | Van', transmission: null });

const ug = (x, want) => { if (unifyGear(x) !== want) throw new Error(`unifyGear(${x}) -> ${unifyGear(x)}, want ${want}`); };
ug('5 Speed Manual Transmission', 'MT 5 cấp');
ug('6 Speed Auto ZF 6HP26 Steptronic', 'AT 6 cấp (6HP26)');
ug('8 Speed Auto Trans ZF 8HP70 4WD', 'AT 8 cấp (8HP70)');
ug('6-Speed Manual Tranmission - MT82', 'MT 6 cấp (MT82)');
ug('Automatic Transmission', 'AT');
ug('Manual Gearbox 5 (With Stop And Start)', 'MT 5 cấp');
ug('BVA AM6', 'AT 6 cấp (AM6)');
ug('BVA4', 'AT 4 cấp');
ug('Piloted Manual Gearbox 5', 'AMT 5 cấp');
ug('MT 5F', 'MT 5 cấp');
ug('AT 4F', 'AT 4 cấp');
ug('5F', '5F');
ug('AT 7 cấp (VUQ)', 'AT 7 cấp (VUQ)');
ug('CVT', 'CVT');
const vk = (v, n) => [v.make, v.model_code, v.year_from, v.year_to, n.engine, n.transmission, n.drive_type, n.steering, n.gear_shift, n.description].map(x => s(x).toUpperCase()).join('|');

(async () => {
  const apply = process.argv.includes('--apply');
  const pool = new Pool({ host: process.env.DB_HOST, port: process.env.DB_PORT, database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD });
  const { rows } = await pool.query(`SELECT id, make, model_code, model_name, year_from, year_to, ${COLS.join(', ')} FROM catalog_vehicles`);
  const changes = [], keys = new Map(), stats = {}, errs = [];
  for (const v of rows) {
    const n = normalize(v);
    const k = vk(v, n); if (keys.has(k)) errs.push(`trùng variant_key ${keys.get(k)} / ${v.id}: ${k}`); keys.set(k, v.id);
    for (const c of COLS) if (s(n[c]).length > MAXLEN[c]) errs.push(`${c} quá dài ${v.id}: ${n[c]}`);
    const diff = COLS.filter(c => (v[c] ?? null) !== (n[c] ?? null));
    if (!diff.length) continue;
    changes.push({ id: v.id, ...n });
    const st = stats[v.make] ??= {}; for (const c of diff) st[c] = (st[c] || 0) + 1;
    fs.appendFileSync('specs-preview.tmp', diff.map(c => [v.id, v.make, v.model_code, c, v[c], n[c]].map(x => `"${s(x).replace(/"/g, '""')}"`).join(',')).join('\n') + '\n');
  }
  if (fs.existsSync('specs-preview.tmp')) fs.renameSync('specs-preview.tmp', 'specs-preview.csv');
  console.table(stats);
  console.log(`${changes.length} xe thay đổi -> specs-preview.csv`);
  if (errs.length) { console.log(errs.slice(0, 20).join('\n')); console.log(`${errs.length} lỗi — KHÔNG ghi`); await pool.end(); process.exit(1); }

  if (apply) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`DROP TABLE IF EXISTS catalog_vehicles_specs_bak`);
      await c.query(`CREATE TABLE catalog_vehicles_specs_bak AS SELECT id, ${COLS.join(', ')} FROM catalog_vehicles`);
      await c.query(`UPDATE catalog_vehicles c SET ${COLS.map(k => `${k} = u.${k}`).join(', ')}
        FROM unnest($1::uuid[], ${COLS.map((_, i) => `$${i + 2}::text[]`).join(', ')}) u(id, ${COLS.join(', ')}) WHERE c.id = u.id`,
        [changes.map(n => n.id), ...COLS.map(k => changes.map(n => n[k] ?? null))]);
      await c.query('COMMIT');
      console.log(`Đã ghi. Khôi phục: UPDATE catalog_vehicles c SET ${COLS.map(k => `${k}=b.${k}`).join(',')} FROM catalog_vehicles_specs_bak b WHERE c.id=b.id`);
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }
  await pool.end();
})();
