-- ============================================================
-- Migration 002 — Đánh dấu ĐÃ CÀO theo từng UNIT (resume unit-level, idempotent)
-- Chạy: psql -U crmuser -d zalocrm -f migrations/002_crawl_unit_log.sql
-- ============================================================
CREATE TABLE IF NOT EXISTS catalog_crawl_unit_log (
  id           SERIAL PRIMARY KEY,
  make         TEXT NOT NULL,
  model_code   TEXT NOT NULL,       -- hoặc khóa tạm nếu model_code rỗng (Loại B)
  unit_key     TEXT NOT NULL,       -- định danh unit (href của unit)
  parts_count  INT DEFAULT 0,
  scraped_at   TIMESTAMPTZ DEFAULT NOW(),
  source       TEXT DEFAULT 'partsouq',
  UNIQUE(make, model_code, unit_key, source)
);
CREATE INDEX IF NOT EXISTS idx_unit_log ON catalog_crawl_unit_log(make, model_code, unit_key);
