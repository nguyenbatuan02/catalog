-- ============================================================
-- Migration 005 — Index phục vụ DASHBOARD tiến độ cào (COUNT theo thời gian)
-- Chạy: psql -U crmuser -d zalocrm -f migrations/005_dashboard_indexes.sql
-- ============================================================
-- Dashboard đếm "trong 1 giờ / 10 phút gần đây" trên bảng LỚN (catalog_fitments ~22tr).
-- Không có index trên created_at → full scan ~3s, làm chậm cả việc cào. Thêm index below.
--
-- LƯU Ý: catalog_fitments RẤT lớn và đang được worker ghi liên tục → dùng
-- CREATE INDEX CONCURRENTLY để KHÔNG khóa ghi (không chặn cào). CONCURRENTLY
-- KHÔNG được nằm trong transaction — chạy file này KHÔNG kèm --single-transaction.
-- IF NOT EXISTS: an toàn chạy lại.
-- ============================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_fitments_created
  ON catalog_fitments(created_at);

-- Bảng nhỏ hơn (unit_log ~vài chục nghìn, model_claim nhỏ) — index thường, build nhanh.
CREATE INDEX IF NOT EXISTS idx_unit_log_scraped
  ON catalog_crawl_unit_log(scraped_at);

CREATE INDEX IF NOT EXISTS idx_model_claim_finished
  ON catalog_model_claim(finished_at);
