-- ============================================================
-- Migration 007 — Đánh dấu UNIT bị Cloudflare checkbox chặn → CẦN CÀO LẠI
-- Chạy: PGCLIENTENCODING=UTF8 psql -U crmuser -d zalocrm -f migrations/007_unit_retry.sql
-- ============================================================
-- Unit bị Cloudflare Turnstile (checkbox) → worker không tự qua được → KHÔNG lấy được data.
-- Trước đây: coi như unit trống (0 part) → submit-unit → ghi catalog_crawl_unit_log → MẤT VĨNH VIỄN.
-- Nay: KHÔNG submit khi bị chặn → unit KHÔNG có trong catalog_crawl_unit_log → should-scrape-unit
--      vẫn trả TRUE → lần chạy sau tự cào lại (lúc CF nhẹ hơn sẽ lấy được).
-- Bảng này CHỈ để ĐẾM số lần thử (chặn retry vô hạn), KHÔNG dùng cho should-scrape-unit.
-- ============================================================

CREATE TABLE IF NOT EXISTS catalog_unit_retry (
  id              SERIAL PRIMARY KEY,
  make            TEXT NOT NULL,
  model_key       TEXT NOT NULL,
  unit_key        TEXT NOT NULL,
  attempts        INT  NOT NULL DEFAULT 1,   -- số lần bị chặn (checkbox)
  last_blocked_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(make, model_key, unit_key)
);

CREATE INDEX IF NOT EXISTS idx_unit_retry ON catalog_unit_retry(make, model_key, unit_key);
