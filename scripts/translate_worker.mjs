/**
 * translate_worker.mjs — WORKER DỊCH TÊN SANG TIẾNG VIỆT (OFFLINE, KHÔNG API)
 *
 * Chạy nền, định kỳ lấy sản phẩm cào về (is_for_sale=FALSE) chưa có name_vi,
 * dịch bằng tool offline (translate_offline.mjs), cập nhật catalog_products.name_vi.
 * Tên nào không dịch được → name_vi=NULL, needs_translation=TRUE (để xử lý sau).
 *
 * Chạy:  node scripts/translate_worker.mjs
 * Dừng:  Ctrl+C (hoặc kill process)
 *
 * ENV (đọc từ .env qua dotenv nếu có, hoặc dùng mặc định giống db.ts):
 *   DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD
 *   TRANSLATE_BATCH   (mặc định 200)   — số bản ghi mỗi vòng
 *   TRANSLATE_IDLE_MS (mặc định 60000) — nghỉ khi hết việc (60s)
 *   TRANSLATE_ONCE=1  — chạy 1 lượt hết việc rồi thoát (để test)
 */
import 'dotenv/config';
import pg from 'pg';
import { translateOffline, _stats } from './lib/translate_offline.mjs';

const DB = {
  host    : process.env.DB_HOST     || 'localhost',
  port    : Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME     || 'zalocrm',
  user    : process.env.DB_USER     || 'crmuser',
  password: process.env.DB_PASSWORD || 'devpassword',
  max     : 4,
};
const BATCH   = Number(process.env.TRANSLATE_BATCH)   || 200;
const IDLE_MS = Number(process.env.TRANSLATE_IDLE_MS) || 60000;
const ONCE    = process.env.TRANSLATE_ONCE === '1';

const pool = new pg.Pool(DB);
let stop = false;
process.on('SIGINT',  () => { console.log('\n[worker] Nhận SIGINT — dừng sau vòng hiện tại...'); stop = true; });
process.on('SIGTERM', () => { stop = true; });

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

async function withRetry(fn, label, tries = 3) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try { return await fn(); }
    catch (e) { lastErr = e; log(`  ! ${label} lỗi lần ${i}/${tries}: ${e.message}`); await sleep(1000 * i); }
  }
  throw lastErr;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** Xử lý 1 batch. Trả về số bản ghi đã xử lý.
 *  Hàng đợi = needs_translation=TRUE (chưa thử). Sau mỗi lần THỬ dịch → needs_translation=FALSE
 *  để không chọn lại (tránh lặp vô hạn với tên không dịch được). */
async function processBatch() {
  const rows = (await withRetry(
    () => pool.query(
      `SELECT id, name, oem_code, internal_ref
       FROM catalog_products
       WHERE is_for_sale = FALSE AND needs_translation = TRUE
       LIMIT $1`, [BATCH]),
    'SELECT batch'
  )).rows;

  if (!rows.length) return 0;

  let translated = 0, unknown = 0;
  for (const r of rows) {
    const code = r.oem_code || r.internal_ref || null;
    const vi = translateOffline(r.name, code);
    // Đã THỬ dịch xong → needs_translation=FALSE dù dịch được hay không.
    // Dòng không dịch được: name_vi giữ NULL (lọc bằng name_vi IS NULL AND needs_translation=FALSE).
    await withRetry(
      () => pool.query(
        `UPDATE catalog_products SET name_vi = $1, needs_translation = FALSE, updated_at = NOW() WHERE id = $2`,
        [vi, r.id]),
      `UPDATE ${r.id}`
    );
    if (vi === null) unknown++; else translated++;
  }
  log(`  Batch ${rows.length}: dịch được ${translated}, chưa dịch được ${unknown}`);
  return rows.length;
}

async function main() {
  log(`Khởi động worker dịch OFFLINE. Từ điển: ${_stats.codeMapSize} mã OEM, ${_stats.exactSize} tên exact, ${_stats.kwRules} rule từ khóa.`);
  await withRetry(() => pool.query('SELECT 1'), 'kết nối DB');
  log('Kết nối DB OK.');

  let totalDone = 0;
  while (!stop) {
    let n = 0;
    try { n = await processBatch(); }
    catch (e) { log(`Batch thất bại hẳn: ${e.message}`); await sleep(5000); continue; }

    if (n === 0) {
      if (ONCE) { log('Hết việc — thoát (TRANSLATE_ONCE=1).'); break; }
      log(`Hết việc — nghỉ ${IDLE_MS / 1000}s rồi kiểm tra lại. (Đã xử lý tổng ${totalDone})`);
      // nghỉ nhưng vẫn phản hồi stop
      for (let t = 0; t < IDLE_MS && !stop; t += 1000) await sleep(1000);
    } else {
      totalDone += n;
    }
  }
  log(`Dừng. Tổng đã xử lý phiên này: ${totalDone}.`);
  await pool.end();
}

main().catch(async e => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
