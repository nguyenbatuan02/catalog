-- ============================================================
-- Migration 001 — Hàng đợi công việc cào PartSouq phân tán
-- Chạy: psql -U crmuser -d zalocrm -f migrations/001_crawl_jobs.sql
-- ============================================================
-- LƯU Ý: bảng catalog_scrape_log CŨ (khóa oem_code) được GIỮ NGUYÊN.
-- Bảng đánh dấu "model đã cào" dùng TÊN MỚI: catalog_crawl_log.
-- ============================================================

-- ---- Bảng hàng đợi job ----
CREATE TABLE IF NOT EXISTS catalog_crawl_jobs (
  id           SERIAL PRIMARY KEY,
  make         TEXT NOT NULL,               -- hãng: Toyota, Honda...
  model_line   TEXT,                         -- dòng xe: Camry, Vios (NULL = cào cả hãng)
  status       TEXT NOT NULL DEFAULT 'pending',   -- pending | running | done | failed
  claimed_by   TEXT,                         -- IP/tên VPS đang làm
  claimed_at   TIMESTAMPTZ,
  finished_at  TIMESTAMPTZ,
  parts_found  INT DEFAULT 0,
  models_found INT DEFAULT 0,
  error        TEXT,
  attempts     INT DEFAULT 0,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- UNIQUE(make, model_line): NULL không bị chặn trùng trong Postgres,
-- nên dùng unique index có COALESCE để "cào cả hãng" (model_line NULL) cũng chỉ 1 job.
CREATE UNIQUE INDEX IF NOT EXISTS uq_crawl_jobs_make_line
  ON catalog_crawl_jobs (make, COALESCE(model_line, ''));

CREATE INDEX IF NOT EXISTS idx_crawl_jobs_status ON catalog_crawl_jobs(status);

-- ---- Bảng log đánh dấu model_code đã cào (tránh cào lại) ----
-- TÊN MỚI catalog_crawl_log để KHÔNG đụng bảng catalog_scrape_log cũ (keyed by oem_code)
CREATE TABLE IF NOT EXISTS catalog_crawl_log (
  id           SERIAL PRIMARY KEY,
  make         TEXT NOT NULL,
  model_code   TEXT NOT NULL,
  model_line   TEXT,
  scraped_at   TIMESTAMPTZ DEFAULT NOW(),
  parts_count  INT DEFAULT 0,
  source       TEXT DEFAULT 'partsouq',
  UNIQUE(make, model_code, source)
);

CREATE INDEX IF NOT EXISTS idx_crawl_log_model ON catalog_crawl_log(make, model_code);
