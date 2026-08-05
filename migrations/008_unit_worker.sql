-- ============================================================
-- Migration 008 — Ghi worker_id vào unit_log để thống kê part/fitment THEO TỪNG VPS
-- Chạy: PGCLIENTENCODING=UTF8 psql -U crmuser -d zalocrm -f migrations/008_unit_worker.sql
-- ============================================================
-- Trước đây catalog_crawl_unit_log KHÔNG có worker_id → không biết part nào do VPS nào cào.
-- Thêm cột worker_id (submit-unit ghi CFG.worker_id mỗi lần submit) + index cho thống kê nhanh.
-- Dữ liệu CŨ (trước migration này) worker_id = NULL → gộp vào "chưa gán VPS" ở dashboard.
-- ============================================================

ALTER TABLE catalog_crawl_unit_log ADD COLUMN IF NOT EXISTS worker_id TEXT;

-- Index cho: GROUP BY worker_id + lọc theo scraped_at (part/giờ mỗi VPS)
CREATE INDEX IF NOT EXISTS idx_unit_log_worker ON catalog_crawl_unit_log(worker_id, scraped_at);
