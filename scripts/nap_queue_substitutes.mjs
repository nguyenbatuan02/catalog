/**
 * scripts/nap_queue_substitutes.mjs
 * Đẩy các mã phụ tùng ưu tiên (đang bán, có dữ liệu xe/tên Việt) vào hàng đợi crawl_substitutes_queue.
 *
 * Dùng:
 *   node scripts/nap_queue_substitutes.mjs [--limit 5000]
 */

import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'catalog',
  user: process.env.DB_USER || 'catalog_user',
  password: process.env.DB_PASSWORD,
});

const args = process.argv.slice(2);
const li = args.indexOf('--limit');
const limit = li !== -1 ? parseInt(args[li + 1]) : 10000;

console.log(`Đang quét sản phẩm ưu tiên nạp vào hàng đợi (tối đa ${limit} mã)...`);

// Lấy trực tiếp từ catalog_products có định dạng mã chuẩn
const res = await pool.query(`
  INSERT INTO crawl_substitutes_queue (ref_norm, ma_goc, status)
  SELECT p.ref_norm, p.internal_ref, 'pending'
  FROM catalog_products p
  WHERE p.is_for_sale = TRUE
    AND p.ref_norm IS NOT NULL
    AND p.ref_norm ~ '^[A-Z0-9]{4,15}$'
  LIMIT $1
  ON CONFLICT (ref_norm) DO NOTHING
`, [limit]);

console.log(`Đã nạp thành công: ${res.rowCount} mã mới vào crawl_substitutes_queue.`);

const stats = await pool.query(`
  SELECT status, count(*) as count FROM crawl_substitutes_queue GROUP BY status
`);
console.table(stats.rows);

await pool.end();
