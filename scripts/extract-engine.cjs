// Tách động cơ từ dữ liệu có sẵn của từng model xe -> cột engine.
// node scripts/extract-engine.cjs          : chạy thử, in thống kê + mẫu, ghi engine-preview.csv
// node scripts/extract-engine.cjs --apply  : backup cột engine vào catalog_vehicles_engine_bak rồi ghi đè
// Không tìm thấy thông tin động cơ -> engine = NULL (bỏ qua, không đoán).
require('dotenv').config();
const fs = require('fs');
const { Pool } = require('pg');

// Mã động cơ dạng Nhật/Hàn: 1NZFE, 2KD-FTV, 1GR-FE, QR25DE, VQ37VHR, MR20DD, 4G63, K12B, SR20DE, A14S
// (7K, 5NRF, R9M, VG30, TD42, CD17, K9K, VR30DDTT)
const JP_CODE = /^\d?[A-Z]{1,3}\d{0,3}[A-Z]{0,8}\d?$/;
// Mã động cơ VAG/Porsche: 4 chữ cái (CAXA, DDPA) hoặc 3 (DJU, DKD)
const VAG_CODE = /^[A-Z]{3,4}$/;
// Mô tả có dung tích + từ khoá động cơ: "2.2L DIESEL ENGINE", "3.5 V8 Petrol", "1.6 THP 16v 200", "1.3 HDI 75"
const DESC = /\(([A-Z0-9]{2,10})\)|^\d[.,]\d{1,2}\s?L?$|\b(DV\d|DW\d{1,2}|TU\d)|\b\d[.,]\d{1,2}\s?L?\b.*\b(TD|D|I|V\d|I\d|PETROL|DIESEL|GASOLINE|TURBO|TDI|TDCI|HDI|THP|VTI|PURETECH|BLUEHDI|E-HDI|MPI|EFI|16V|8V|DSL|DI|IDI|ENGINE|K16|SUPERCHARGED|HYBRID|NAT ASP|CARB)\b/i;
// Không phải động cơ
const NOT_ENGINE = /(DOOR|SEDAN|HATCH|COUPE|WAGON|VAN\b|CONVERTIBLE|SALOON|ESTATE|TRANSMISSION|GEARBOX|SPEED|AREA:|SEAT|LHD|RHD|#|[A-Z0-9]{3},[A-Z])/i;

function clean(s) { return (s || '').toString().trim(); }

function isEngine(s, make) {
  if (!s || s.length > 60 || NOT_ENGINE.test(s)) return false;
  if (DESC.test(s)) return true;
  const code = s.toUpperCase();
  // Toyota/Lexus: động cơ luôn bắt đầu bằng số (1NZFE, 7K, 2L); bắt đầu bằng chữ là mã khung (UCF20, JZS147)
  if (['Toyota', 'Lexus'].includes(make)) return /^\d[A-Z]{1,3}[A-Z0-9]*$/.test(code);
  if (['Volkswagen', 'Audi', 'Porsche', 'Skoda', 'Seat'].includes(make)) return VAG_CODE.test(code);
  return JP_CODE.test(code) && /\d/.test(code);
}

function extract(v) {
  const make = v.make;
  // 1) "Engine: (1FZFE)" nhúng trong chuỗi thuộc tính (Lexus/Toyota)
  for (const f of [v.transmission, v.engine, v.gear_shift, v.specs_raw]) {
    const m = clean(f).match(/Engine:\s*\(?([A-Z0-9-]{2,10})\)?/i);
    if (m) return m[1].toUpperCase();
  }
  // 2) Mercedes: model_code là mã động cơ ("M 115", "OM 651"), mô tả có "ENGINE ... KW (PS)"
  if (make === 'Mercedes') {
    const m = clean(v.model_name).match(/^(OM|M)\s?\d{3}/i);
    const ps = clean(v.description).match(/(\d{2,3})\s?KW\s?\((\d{2,3})\s?PS/i);
    const fuel = /DIESEL/i.test(v.description) ? 'Diesel' : /GASOLINE|BENZIN/i.test(v.description) ? 'Petrol' : '';
    if (m) return [m[0].replace(/\s+/, ' ').toUpperCase(), fuel, ps ? `${ps[2]}PS` : ''].filter(Boolean).join(' ');
    return null;
  }
  // 3) Mitsubishi: chuỗi option "1400/2WD(VAN)<87M-> - ..." -> chỉ có dung tích
  if (make === 'Mitsubishi') {
    const m = clean(v.engine).match(/^(\d{3,4})(DIESEL|DIE|TURBO|GDI)?\//);
    if (m) return [`${(m[1] / 1000).toFixed(1)}L`, /^DIE/.test(m[2] || '') ? 'Diesel' : m[2]].filter(Boolean).join(' ');
  }
  // 4) Các cột có thể chứa động cơ, theo thứ tự tin cậy
  // gear_shift/transmission chỉ Land Rover mới chứa động cơ; hãng khác là mã hộp số (5F, MCX(VA)), mã khung (BNR32)
  const fields = make === 'Land Rover' ? [v.engine, v.gear_shift, v.transmission] : [v.engine];
  for (const f of fields) {
    const s = clean(f).replace(/\s+TYPE ENGINE$/i, '');
    if (isEngine(s, make)) return s;
  }
  return null;
}

// Self-check
const t = (v, want) => { const got = extract({ make: 'Toyota', ...v }); if (got !== want) throw new Error(`${JSON.stringify(v)} -> ${got}, want ${want}`); };
t({ engine: '1NZFE' }, '1NZFE');
t({ engine: 'ACV40,GSV40' }, null);
t({ engine: 'USF4#' }, null);
t({ transmission: 'ATM 5F' }, null);
t({ transmission: 'ATM,MTM: AUTOMATIC TRANSMISSION; Engine: (1FZFE) 4' }, '1FZFE');
t({ make: 'Nissan', engine: '2 DOOR SEDAN' }, null);
t({ make: 'Nissan', engine: 'QR25DE' }, 'QR25DE');
t({ make: 'Nissan', engine: 'VQ37VHR' }, 'VQ37VHR');
t({ make: 'Infiniti', engine: '2.2L DIESEL ENGINE' }, '2.2L DIESEL ENGINE');
t({ make: 'Land Rover', engine: 'RHD', transmission: '2.4 VM Diesel Turbo' }, '2.4 VM Diesel Turbo');
t({ make: 'Land Rover', engine: '5 Speed Manual Transmission', gear_shift: '1.8 K16 Petrol' }, '1.8 K16 Petrol');
t({ make: 'Volkswagen', engine: 'CDBA', transmission: 'MCX(VA)' }, 'CDBA');
t({ make: 'Peugeot', engine: '1.3 HDI 75' }, '1.3 HDI 75');
t({ make: 'Mitsubishi', engine: '1400/2WD(VAN)<87M-> - DX(4DOOR),4CM/T RHD' }, '1.4L');
t({ make: 'Mercedes', model_name: 'M 115', description: 'Japan | GASOLINE ENGINE 70 KW (95 PS)' }, 'M 115 Petrol 95PS');
t({ engine: '7K' }, '7K');
t({ make: 'Lexus', engine: 'UCF20' }, null);
t({ make: 'Lexus', engine: 'JZS147' }, null);
t({ make: 'Nissan', engine: 'R9M' }, 'R9M');
t({ make: 'Nissan', engine: 'VG30' }, 'VG30');
t({ make: 'Infiniti', engine: 'VR30DDTT TYPE ENGINE' }, 'VR30DDTT');
t({ make: 'Peugeot', engine: '2.8 TD (SOFIM)' }, '2.8 TD (SOFIM)');
t({ make: 'Peugeot', engine: '1.9' }, '1.9');
t({ make: 'Peugeot', engine: '2,5 L TD (DJ5TED)' }, '2,5 L TD (DJ5TED)');
t({ make: 'Peugeot', engine: 'DV6FC PEF 85KW TURBO DIESEL' }, 'DV6FC PEF 85KW TURBO DIESEL');
t({ make: 'Mitsubishi', engine: '2500DIESEL/4WD(TRUCK) - STANDARD CAB,5FM/T RHD' }, '2.5L Diesel');
t({ make: 'Mazda', drive_type: 'AA5PA 100001' }, null);

// Giá trị cũ ở cột engine không phải động cơ -> chuyển sang đúng cột, không xoá (giữ phân biệt phiên bản).
const COLS = ['engine', 'transmission', 'drive_type', 'steering', 'gear_shift', 'description'];
function patch(v) {
  // Nissan crawl lệch cột: engine="5 DOOR HATCHBACK", drive_type=bản (UPPER), steering/gear_shift=mã động cơ (HR15DE/E15)
  if (['Nissan', 'Infiniti'].includes(v.make) && /DOOR|SEDAN|COUPE|HATCH|CONVERTIBLE/i.test(v.engine || '')) {
    const src = isEngine(v.gear_shift || '', v.make) ? 'gear_shift' : isEngine(v.steering || '', v.make) ? 'steering' : null;
    if (src === 'steering') return { engine: v.steering, drive_type: v.engine, steering: v.drive_type || null };
    if (src === 'gear_shift') return { engine: v.gear_shift, drive_type: v.engine, gear_shift: null };
  }
  const e = extract(v), old = v.engine || null, p = { engine: e };
  if (old === e) return p;
  // Land Rover: động cơ lấy từ transmission/gear_shift -> cột đó trống ra
  for (const c of ['transmission', 'gear_shift']) if (e && v[c] === e) p[c] = null;
  if (!old || (e && old.replace(/\s+TYPE ENGINE$/i, '') === e)) return p;
  if (/^(LHD|RHD)$/.test(old)) p.steering = old;
  // Mitsubishi "2000/2WD(VAN) - DX(4DOOR),5CM/T LHD" (63 ký tự > gear_shift 50) -> nối vào description: "Japan | ..."
  else if (v.make === 'Mitsubishi') p.description = `${v.description} | ${old}`;
  else if (/TRANS|SPEED|GEAR/i.test(old)) p[p.transmission === null || !v.transmission ? 'transmission' : 'gear_shift'] = old;
  else if (/DOOR|SEDAN|COUPE|HATCH|CONVERTIBLE|WAGON/i.test(old)) p.drive_type = old;
  // còn lại (mã khung Lexus "USF4#") -> bỏ
  for (const c of Object.keys(p)) if (!['engine', 'description'].includes(c) && p[c] && v[c] && v[c] !== e) throw new Error(`đè ${c} ${v.id}: ${v[c]} <- ${p[c]}`);
  return p;
}
const vk = v => [v.make, v.model_code, v.year_from, v.year_to, v.engine, v.transmission, v.drive_type, v.steering, v.gear_shift, v.description].map(x => (x ?? '').toString().toUpperCase()).join('|');

(async () => {
  const apply = process.argv.includes('--apply');
  const pool = new Pool({ host: process.env.DB_HOST, port: process.env.DB_PORT, database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD });
  const { rows } = await pool.query(`SELECT id, make, model_code, model_name, year_from, year_to, engine, transmission, drive_type, steering, gear_shift, description, specs_raw::text FROM catalog_vehicles`);
  const stats = {}, changes = [], keys = new Map();
  for (const v of rows) {
    const p = patch(v), n = { ...v, ...p };
    const s = stats[v.make] ??= { total: 0, before: 0, after: 0, changed: 0 };
    s.total++; if (v.engine) s.before++; if (p.engine) s.after++;
    if (COLS.some(c => (v[c] || null) !== (n[c] || null))) { s.changed++; changes.push(n); }
    const k = vk(n); if (keys.has(k)) throw new Error(`trùng variant_key: ${keys.get(k)} / ${v.id} ${k}`); keys.set(k, v.id);
  }
  console.table(stats);
  const byId = new Map(rows.map(v => [v.id, v]));
  fs.writeFileSync('engine-preview.csv', 'id,make,model_code,cột,cũ,mới\n' + changes.flatMap(n => COLS
    .filter(c => (byId.get(n.id)[c] || null) !== (n[c] || null))
    .map(c => [n.id, n.make, n.model_code, c, byId.get(n.id)[c], n[c]].map(x => `"${(x ?? '').toString().replace(/"/g, '""')}"`).join(','))).join('\n'));
  console.log(`${changes.length} xe thay đổi, không trùng variant_key -> engine-preview.csv`);

  if (apply) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`DROP TABLE IF EXISTS catalog_vehicles_engine_bak`);
      await c.query(`CREATE TABLE catalog_vehicles_engine_bak AS SELECT id, ${COLS.join(', ')} FROM catalog_vehicles`);
      await c.query(`UPDATE catalog_vehicles c SET ${COLS.map(k => `${k} = u.${k}`).join(', ')}
        FROM unnest($1::uuid[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[]) u(id, ${COLS.join(', ')}) WHERE c.id = u.id`,
        [changes.map(n => n.id), ...COLS.map(k => changes.map(n => n[k] || null))]);
      await c.query('COMMIT');
      console.log(`Đã ghi. Khôi phục: UPDATE catalog_vehicles c SET ${COLS.map(k => `${k}=b.${k}`).join(',')} FROM catalog_vehicles_engine_bak b WHERE c.id=b.id`);
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }
  await pool.end();
})();
