-- ============================================================
-- Migration 004 — KHÓA CẤP MODEL THẬT (chống 2 VPS cào TRÙNG 1 model)
-- Chạy: psql -U crmuser -d zalocrm -f migrations/004_model_claim.sql
-- ============================================================
-- Vấn đề: chống trùng cũ ở cấp JOB (make, model_line), nhưng nhiều job khác
-- nhau lại trỏ về CÙNG một model thật → 2 VPS cùng ghi 1 part, tranh khóa DB.
-- Giải pháp: trước khi cào 1 model, VPS phải CLAIM (khóa) model đó ở server.
-- model_key = model_code (Loại A) HOẶC "model_line [market year_range]" (Loại B),
--             CHÍNH LÀ effCode mà worker gửi lên trong should-scrape / submit-unit.
-- ============================================================

CREATE TABLE IF NOT EXISTS catalog_model_claim (
  id           SERIAL PRIMARY KEY,
  make         TEXT NOT NULL,
  model_key    TEXT NOT NULL,                       -- khóa model duy nhất (= effCode của worker)
  status       TEXT NOT NULL DEFAULT 'crawling',    -- crawling | done
  claimed_by   TEXT,                                -- worker_id đang cào
  claimed_at   TIMESTAMPTZ DEFAULT NOW(),           -- cập nhật mỗi lần submit-unit (heartbeat)
  finished_at  TIMESTAMPTZ,
  units_total  INT DEFAULT 0,
  units_done   INT DEFAULT 0,
  UNIQUE(make, model_key)
);

CREATE INDEX IF NOT EXISTS idx_model_claim ON catalog_model_claim(make, model_key, status);
