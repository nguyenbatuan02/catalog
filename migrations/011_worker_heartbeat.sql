-- ============================================================
-- Migration 011 — Heartbeat + điều khiển VPS worker (poll-based, KHÔNG cần SSH)
--   Chạy: PGCLIENTENCODING=UTF8 psql -U crmuser -d zalocrm -f migrations/011_worker_heartbeat.sql
-- ============================================================
-- VPS (Chrome extension) mỗi ~60s POST /crawl/heartbeat → ghi last_seen + trả về `command`.
-- Admin đặt command qua POST /crawl/worker-command → lần heartbeat kế VPS nhận & tự xử lý.
--   command: continue | restart | idle | stop
-- ============================================================

CREATE TABLE IF NOT EXISTS catalog_worker_heartbeat (
  worker_id   TEXT PRIMARY KEY,
  status      TEXT,
  current_job TEXT,
  parts_hour  INT DEFAULT 0,
  last_seen   TIMESTAMPTZ DEFAULT NOW(),
  command     TEXT DEFAULT 'continue'
);
