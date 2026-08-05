// diagnose-vios.mjs
// Chẩn đoán vì sao một số phụ tùng/năm không có data trong catalog.
// Chạy 7 query phân tích DB và in ra kết quả.
//
// CÁCH CHẠY:
//   node diagnose-vios.mjs

import * as dotenv from 'dotenv';
import pg from 'pg';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env
const ENV_CANDIDATES = [
  path.join(__dirname, '.env'),
  path.join(__dirname, '..', '.env'),
  path.join(__dirname, '..', '..', '.env'),
];
for (const p of ENV_CANDIDATES) {
  if (fs.existsSync(p)) {
    dotenv.config({ path: p });
    break;
  }
}

function buildDbConfig() {
  if (process.env.DATABASE_URL) return { connectionString: process.env.DATABASE_URL };
  return {
    host:     process.env.DB_HOST || 'localhost',
    port:     parseInt(process.env.DB_PORT || '5432'),
    user:     process.env.DB_USER || 'crmuser',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'zalocrm',
  };
}

const pool = new pg.Pool(buildDbConfig());

function header(title) {
  console.log('\n' + '═'.repeat(85));
  console.log(`  ${title}`);
  console.log('═'.repeat(85));
}

function note(text) {
  console.log(`\n💡 ${text}`);
}

async function runQuery(title, sql, params = [], note_text = null) {
  header(title);
  try {
    const result = await pool.query(sql, params);
    if (result.rows.length === 0) {
      console.log('   (Không có kết quả)');
    } else {
      console.table(result.rows);
    }
    if (note_text) note(note_text);
    return result.rows;
  } catch (err) {
    console.log(`   ❌ Lỗi: ${err.message}`);
    return [];
  }
}

async function main() {
  console.log('═'.repeat(85));
  console.log('  CHẨN ĐOÁN ĐỘ PHỦ CATALOG VIOS');
  console.log('═'.repeat(85));

  // ───────────────────────────────────────────────────────────────
  // QUERY 1: Tất cả vehicle Vios trong catalog
  // ───────────────────────────────────────────────────────────────
  const vehicles = await runQuery(
    'QUERY 1: Tất cả vehicle Toyota Vios trong catalog_vehicles',
    `SELECT model_name, model_code, year_from, year_to
       FROM catalog_vehicles
      WHERE make ILIKE 'toyota' AND model_name ILIKE '%vios%'
      ORDER BY year_from`,
    [],
    'Kiểm tra xem catalog có phủ đủ năm 2003-2025 không. Năm nào không phủ → cần INSERT vehicle.'
  );

  // ───────────────────────────────────────────────────────────────
  // QUERY 2: Số fitment cho mỗi vehicle Vios
  // ───────────────────────────────────────────────────────────────
  await runQuery(
    'QUERY 2: Số fitment có cho mỗi vehicle Vios',
    `SELECT v.model_code,
            v.year_from,
            v.year_to,
            COUNT(f.id) AS fitment_count
       FROM catalog_vehicles v
       LEFT JOIN catalog_fitments f ON f.vehicle_id = v.id
      WHERE v.make ILIKE 'toyota' AND v.model_name ILIKE '%vios%'
      GROUP BY v.id, v.model_code, v.year_from, v.year_to
      ORDER BY v.year_from`,
    [],
    'Vehicle nào có fitment_count = 0 → có vehicle nhưng chưa import phụ tùng nào.'
  );

  // ───────────────────────────────────────────────────────────────
  // QUERY 3: Top phụ tùng "má phanh" có cho Vios (test giả thuyết tên thiếu "trước")
  // ───────────────────────────────────────────────────────────────
  await runQuery(
    'QUERY 3: Tất cả phụ tùng có chữ "má phanh" cho Vios (xem có chữ "trước/sau" không)',
    `SELECT pb.name,
            COUNT(DISTINCT v.id) AS so_vehicle,
            STRING_AGG(DISTINCT v.model_code, ', ') AS vehicles
       FROM catalog_product_base pb
       JOIN catalog_fitments f ON f.product_id = pb.id
       JOIN catalog_vehicles v ON v.id = f.vehicle_id
      WHERE v.make ILIKE 'toyota' AND v.model_name ILIKE '%vios%'
        AND pb.name ILIKE '%má phanh%'
        AND pb.is_for_sale = true
      GROUP BY pb.id, pb.name
      ORDER BY so_vehicle DESC
      LIMIT 15`,
    [],
    'NẾU tên phụ tùng không có chữ "trước"/"sau" → giả thuyết 1 đúng: script đòi keyword "trước" nên fail. Fix: chỉnh PART_KEYWORDS trong test script.'
  );

  // ───────────────────────────────────────────────────────────────
  // QUERY 4: Phụ tùng "bugi" cho Vios
  // ───────────────────────────────────────────────────────────────
  await runQuery(
    'QUERY 4: Tất cả phụ tùng có chữ "bugi" cho Vios',
    `SELECT pb.name,
            COUNT(DISTINCT v.id) AS so_vehicle,
            STRING_AGG(DISTINCT v.model_code, ', ') AS vehicles
       FROM catalog_product_base pb
       JOIN catalog_fitments f ON f.product_id = pb.id
       JOIN catalog_vehicles v ON v.id = f.vehicle_id
      WHERE v.make ILIKE 'toyota' AND v.model_name ILIKE '%vios%'
        AND pb.name ILIKE '%bugi%'
        AND pb.is_for_sale = true
      GROUP BY pb.id, pb.name
      ORDER BY so_vehicle DESC
      LIMIT 15`,
    [],
    'Nếu rỗng → fitment bugi chưa được scrape cho Vios. Nếu có nhưng thiếu model_code Gen 3 (NSP151/NSP152) → chỉ thiếu fitment cho Gen 3.'
  );

  // ───────────────────────────────────────────────────────────────
  // QUERY 5: Phụ tùng "lọc dầu" cho Vios
  // ───────────────────────────────────────────────────────────────
  await runQuery(
    'QUERY 5: Tất cả phụ tùng có chữ "lọc dầu" cho Vios',
    `SELECT pb.name,
            COUNT(DISTINCT v.id) AS so_vehicle,
            STRING_AGG(DISTINCT v.model_code, ', ') AS vehicles
       FROM catalog_product_base pb
       JOIN catalog_fitments f ON f.product_id = pb.id
       JOIN catalog_vehicles v ON v.id = f.vehicle_id
      WHERE v.make ILIKE 'toyota' AND v.model_name ILIKE '%vios%'
        AND pb.name ILIKE '%lọc dầu%'
        AND pb.is_for_sale = true
      GROUP BY pb.id, pb.name
      ORDER BY so_vehicle DESC
      LIMIT 15`,
    [],
    'Xem fitment lọc dầu cover được đời nào của Vios.'
  );

  // ───────────────────────────────────────────────────────────────
  // QUERY 6: Case study năm 2020 - liệt kê tất cả phụ tùng có
  // ───────────────────────────────────────────────────────────────
  await runQuery(
    'QUERY 6: Liệt kê tất cả phụ tùng cho Vios 2020 (case study năm thiếu cả 3 phụ tùng)',
    `SELECT pb.name,
            v.model_code,
            CONCAT(v.year_from, '-', v.year_to) AS year_range
       FROM catalog_product_base pb
       JOIN catalog_fitments f ON f.product_id = pb.id
       JOIN catalog_vehicles v ON v.id = f.vehicle_id
      WHERE v.make ILIKE 'toyota' AND v.model_name ILIKE '%vios%'
        AND v.year_from <= 2020 AND v.year_to >= 2020
        AND pb.is_for_sale = true
      ORDER BY pb.name
      LIMIT 30`,
    [],
    'Nếu rỗng hoàn toàn → vehicle 2020 không có fitment nào. Nếu có ít → fitment Gen 3 facelift đang trống.'
  );

  // ───────────────────────────────────────────────────────────────
  // QUERY 7: Tổng phụ tùng (không lọc tên) theo từng năm Vios
  // ───────────────────────────────────────────────────────────────
  await runQuery(
    'QUERY 7: Số phụ tùng có theo từng năm Vios (2003-2025)',
    `WITH years AS (
       SELECT generate_series(2003, 2025) AS y
     )
     SELECT y AS nam,
            COUNT(DISTINCT pb.id) AS so_phu_tung
       FROM years
       LEFT JOIN catalog_vehicles v
         ON v.make ILIKE 'toyota'
        AND v.model_name ILIKE '%vios%'
        AND v.year_from <= y AND v.year_to >= y
       LEFT JOIN catalog_fitments f ON f.vehicle_id = v.id
       LEFT JOIN catalog_product_base pb
         ON pb.id = f.product_id AND pb.is_for_sale = true
      GROUP BY y
      ORDER BY y`,
    [],
    'Bảng tổng quan: năm nào có 0 phụ tùng → vehicle/fitment trống hẳn. Năm có ít → fitment thiếu.'
  );

  // ───────────────────────────────────────────────────────────────
  // PHÂN TÍCH TỰ ĐỘNG
  // ───────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(85));
  console.log('  KẾT LUẬN VÀ ĐỀ XUẤT FIX');
  console.log('═'.repeat(85));
  console.log(`
1. Xem QUERY 3:
   • Nếu các phụ tùng "má phanh" KHÔNG có chữ "trước"/"sau" trong tên
     → Đây là vấn đề ở SCRIPT, không phải DB. Sửa PART_KEYWORDS bỏ keyword "trước".
   • Nếu có "trước" nhưng chỉ cho vài model_code (vd NSP152) → fitment Gen 1, 2 trống.

2. Xem QUERY 4 (bugi):
   • Rỗng hoàn toàn → fitment bugi chưa scrape lần nào.
   • Có nhưng thiếu Gen 3 (NSP151/NSP152) → cần scrape ToyoDIY mã bugi cho Gen 3.

3. Xem QUERY 6 (Vios 2020):
   • Số dòng ít (<10) → vehicle có nhưng fitment chỉ vài cái → cần scrape thêm.
   • Rỗng hoàn toàn → vehicle có nhưng KHÔNG fitment nào → scrape tất cả phụ tùng phổ thông cho đời này.

4. Xem QUERY 7 (tổng quan theo năm):
   • Năm có 0 phụ tùng → vehicle trống hoặc fitment trống cho năm đó.
   • So sánh sự chênh lệch giữa các năm để biết priority cần fill.
`);

  await pool.end();
}

main().catch(async (err) => {
  console.error('\n❌ LỖI:', err.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
