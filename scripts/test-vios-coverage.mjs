// test-vios-coverage.mjs (v2 - sửa lỗi không đọc được .env)
// Script test độ phủ catalog Vios theo năm — query trực tiếp PostgreSQL.
//
// CÁCH CHẠY:
//   node test-vios-coverage.mjs
//   node test-vios-coverage.mjs <đường-dẫn-file-input> <đường-dẫn-file-output>

import * as dotenv from 'dotenv';
import pg from 'pg';
import XLSX from 'xlsx';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =================== LOAD .ENV (TỪ NHIỀU VỊ TRÍ) ===================
const ENV_CANDIDATES = [
  path.join(__dirname, '.env'),                  // CHATAI/scripts/.env
  path.join(__dirname, '..', '.env'),            // CHATAI/.env  ← phổ biến nhất
  path.join(__dirname, '..', '..', '.env'),      // cha của cha
  path.resolve(process.cwd(), '.env'),           // thư mục đang chạy
];

let envLoadedFrom = null;
for (const p of ENV_CANDIDATES) {
  if (fs.existsSync(p)) {
    dotenv.config({ path: p });
    envLoadedFrom = p;
    break;
  }
}

console.log('=== TEST VIOS CATALOG COVERAGE (v2) ===');
if (envLoadedFrom) {
  console.log(`✓ Đã load .env từ: ${envLoadedFrom}`);
} else {
  console.log('⚠ KHÔNG tìm thấy file .env ở các vị trí:');
  for (const p of ENV_CANDIDATES) console.log(`   - ${p}`);
}

// =================== CẤU HÌNH ===================
const INPUT_FILE = process.argv[2]
  || path.join(__dirname, 'vios_coverage_by_year_2003_2025.xlsx');
const OUTPUT_FILE = process.argv[3]
  || path.join(__dirname, 'vios_coverage_results.xlsx');

const PART_KEYWORDS = {
  'má phanh trước':   ['má phanh', 'trước'],
  'má phanh sau':     ['má phanh', 'sau'],
  'đĩa phanh trước':  ['đĩa phanh', 'trước'],
  'đĩa phanh sau':    ['đĩa phanh', 'sau'],
  'lọc dầu động cơ':  ['lọc dầu'],
  'lọc gió động cơ':  ['lọc gió'],
  'lọc nhiên liệu':   ['lọc nhiên liệu'],
  'bugi':             ['bugi'],
  'mô bin đánh lửa':  ['mô bin'],
  'ắc quy':           ['ắc quy'],
  'dây curoa cam':    ['curoa', 'cam'],
  'dây curoa tổng':   ['curoa', 'tổng'],
  'giảm sóc trước':   ['giảm sóc', 'trước'],
  'giảm sóc sau':     ['giảm sóc', 'sau'],
  'bơm nước':         ['bơm nước'],
  'cảm biến oxy':     ['cảm biến', 'oxy'],
};

function getKeywords(partName) {
  const key = partName.toLowerCase().trim();
  return PART_KEYWORDS[key] || [partName];
}

// =================== BUILD DB CONFIG ===================
function buildDbConfig() {
  if (process.env.DATABASE_URL) {
    return { connectionString: process.env.DATABASE_URL };
  }

  const password =
       process.env.DB_PASSWORD
    || process.env.PG_PASSWORD
    || process.env.POSTGRES_PASSWORD
    || process.env.PGPASSWORD;

  return {
    host:     process.env.DB_HOST || process.env.PG_HOST || process.env.POSTGRES_HOST || process.env.PGHOST || 'localhost',
    port:     parseInt(process.env.DB_PORT || process.env.PG_PORT || process.env.POSTGRES_PORT || process.env.PGPORT || '5432'),
    user:     process.env.DB_USER || process.env.PG_USER || process.env.POSTGRES_USER || process.env.PGUSER || 'crmuser',
    password: password,
    database: process.env.DB_NAME || process.env.PG_DATABASE || process.env.POSTGRES_DB || process.env.PGDATABASE || 'zalocrm',
  };
}

const dbConfig = buildDbConfig();

if (!dbConfig.connectionString && !dbConfig.password) {
  console.error('\n❌ KHÔNG TÌM THẤY PASSWORD DB.\n');
  console.error('Script đã thử các tên biến: DB_PASSWORD, PG_PASSWORD, POSTGRES_PASSWORD, PGPASSWORD, DATABASE_URL');
  console.error('');
  console.error('Các biến env liên quan đến DB hiện đang có trong env:');
  const dbVars = Object.keys(process.env).filter(k => /^(DB_|PG|POSTGRES|DATABASE)/i.test(k));
  if (dbVars.length === 0) {
    console.error('   (không có biến nào liên quan)');
  } else {
    for (const k of dbVars) {
      const v = process.env[k];
      const display = /password|pwd/i.test(k) ? `(có ${v?.length || 0} ký tự)` : v;
      console.error(`   ${k} = ${display}`);
    }
  }
  console.error('');
  console.error('CÁCH FIX:');
  console.error('1. Mở file .env trong C:\\Users\\Administrator\\Desktop\\CHATAI\\');
  console.error('2. Tìm dòng chứa mật khẩu DB (vd: DB_PASSWORD=xxx hoặc DATABASE_URL=postgres://...)');
  console.error('3. Copy tên biến đúng vào hàm buildDbConfig() trong script này.');
  console.error('');
  process.exit(1);
}

const pool = new pg.Pool(dbConfig);

console.log(`✓ DB config: ${dbConfig.connectionString
  ? '(qua DATABASE_URL)'
  : `${dbConfig.user}@${dbConfig.host}:${dbConfig.port}/${dbConfig.database}`}`);
console.log(`✓ Input:  ${INPUT_FILE}`);
console.log(`✓ Output: ${OUTPUT_FILE}`);
console.log('');

// =================== QUERY DB ===================

async function checkVehicle(year) {
  const result = await pool.query(`
    SELECT id, model_code, year_from, year_to
    FROM catalog_vehicles
    WHERE make ILIKE 'toyota'
      AND model_name ILIKE '%vios%'
      AND year_from <= $1
      AND year_to   >= $1
    ORDER BY year_from
  `, [year]);
  return result.rows;
}

async function checkPart(year, partName) {
  const keywords = getKeywords(partName);
  const partConds = keywords.map((_, i) => `pb.name ILIKE $${i + 2}`).join(' AND ');
  const partParams = keywords.map(k => `%${k}%`);

  const sql = `
    SELECT COUNT(DISTINCT pb.id) AS cnt
    FROM catalog_product_base pb
    JOIN catalog_fitments  f ON f.product_id = pb.id
    JOIN catalog_vehicles  v ON v.id = f.vehicle_id
    WHERE v.make ILIKE 'toyota'
      AND v.model_name ILIKE '%vios%'
      AND v.year_from <= $1
      AND v.year_to   >= $1
      AND pb.is_for_sale = true
      AND ${partConds}
  `;
  const result = await pool.query(sql, [year, ...partParams]);
  return parseInt(result.rows[0].cnt, 10);
}

// =================== MAIN ===================

async function main() {
  try {
    await pool.query('SELECT 1');
    console.log('✓ Kết nối DB thành công\n');
  } catch (err) {
    throw new Error(`Không kết nối được DB. Chi tiết: ${err.message}`);
  }

  if (!fs.existsSync(INPUT_FILE)) {
    throw new Error(`Không tìm thấy file input: ${INPUT_FILE}`);
  }
  const wb = XLSX.readFile(INPUT_FILE);
  const sheet = wb.Sheets['Vios_by_year'];
  if (!sheet) {
    throw new Error('Không tìm thấy sheet "Vios_by_year" trong file input');
  }
  const data = XLSX.utils.sheet_to_json(sheet);
  console.log(`Đã đọc ${data.length} dòng test\n`);

  const vehicleCache = new Map();
  const results = [];

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const year = parseInt(row['Năm'], 10);
    const part = String(row['Phụ tùng']).trim();

    let vehicles;
    if (vehicleCache.has(year)) {
      vehicles = vehicleCache.get(year);
    } else {
      vehicles = await checkVehicle(year);
      vehicleCache.set(year, vehicles);
    }
    const vehicleFound = vehicles.length > 0 ? 'Y' : 'N';
    const vehicleInfo  = vehicles.map(v => `${v.model_code} (${v.year_from}-${v.year_to})`).join(', ');

    let partCount = 0;
    let partFound = 'N';
    if (vehicleFound === 'Y') {
      partCount = await checkPart(year, part);
      partFound = partCount > 0 ? 'Y' : 'N';
    }

    let diagnosis;
    if (vehicleFound === 'N') {
      diagnosis = 'Vehicle thiếu — catalog_vehicles không phủ năm này';
    } else if (partFound === 'N') {
      diagnosis = 'Vehicle OK, fitment thiếu — cần scrape phụ tùng này';
    } else {
      diagnosis = 'OK';
    }

    results.push({
      'STT':                       row['STT'],
      'Câu hỏi':                   row['Câu hỏi mô phỏng khách'],
      'Năm':                       year,
      'Thế hệ':                    row['Thế hệ'],
      'Phụ tùng':                  part,
      'Vehicle (Y/N)':             vehicleFound,
      'Phụ tùng (Y/N)':            partFound,
      'Số kết quả':                partCount,
      'Vehicle khớp (model_code)': vehicleInfo,
      'Chẩn đoán':                 diagnosis,
    });

    const symbol = (vehicleFound === 'Y' && partFound === 'Y') ? '✓'
                 : (vehicleFound === 'N') ? '✗V' : '✗P';
    console.log(`[${i + 1}/${data.length}] ${symbol}  ${year} - ${part.padEnd(22)} V=${vehicleFound} P=${partFound} (${partCount} kết quả)`);
  }

  const newWs = XLSX.utils.json_to_sheet(results);
  newWs['!cols'] = [
    { wch: 5 }, { wch: 35 }, { wch: 6 }, { wch: 20 }, { wch: 22 },
    { wch: 13 }, { wch: 14 }, { wch: 12 }, { wch: 30 }, { wch: 55 },
  ];
  const newWb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(newWb, newWs, 'Kết quả');
  XLSX.writeFile(newWb, OUTPUT_FILE);

  const total = results.length;
  const vehicleY = results.filter(r => r['Vehicle (Y/N)'] === 'Y').length;
  const partY    = results.filter(r => r['Phụ tùng (Y/N)'] === 'Y').length;

  console.log('\n=== TỔNG KẾT ===');
  console.log(`Tổng test:           ${total}`);
  console.log(`Vehicle tìm thấy:    ${vehicleY}/${total} (${(vehicleY / total * 100).toFixed(1)}%)`);
  console.log(`Phụ tùng tìm thấy:   ${partY}/${total} (${(partY / total * 100).toFixed(1)}%)`);

  const missingYears = [...new Set(
    results.filter(r => r['Vehicle (Y/N)'] === 'N').map(r => r['Năm'])
  )].sort((a, b) => a - b);
  if (missingYears.length > 0) {
    console.log(`\n⚠ Năm thiếu vehicle: ${missingYears.join(', ')}`);
    console.log('   → cần bổ sung dòng vào catalog_vehicles');
  }

  const fitmentGaps = {};
  for (const r of results) {
    if (r['Vehicle (Y/N)'] === 'Y' && r['Phụ tùng (Y/N)'] === 'N') {
      const y = r['Năm'];
      if (!fitmentGaps[y]) fitmentGaps[y] = [];
      fitmentGaps[y].push(r['Phụ tùng']);
    }
  }
  const fitmentGapYears = Object.keys(fitmentGaps);
  if (fitmentGapYears.length > 0) {
    console.log(`\n⚠ Năm có vehicle nhưng thiếu fitment:`);
    for (const y of fitmentGapYears) {
      console.log(`   ${y}: thiếu [${fitmentGaps[y].join(', ')}]`);
    }
    console.log('   → cần scrape ToyoDIY cho các phụ tùng trên');
  }

  console.log(`\n📂 Kết quả lưu tại: ${OUTPUT_FILE}\n`);

  await pool.end();
}

main().catch(async (err) => {
  console.error('\n❌ LỖI:', err.message);
  if (err.stack) console.error(err.stack.split('\n').slice(0, 5).join('\n'));
  await pool.end().catch(() => {});
  process.exit(1);
});
