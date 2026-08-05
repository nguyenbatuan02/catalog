-- ============================================================
-- Migration 009 — Tách 3 số đóng góp mỗi unit (để thống kê theo VPS)
-- Chạy: PGCLIENTENCODING=UTF8 psql -U crmuser -d zalocrm -f migrations/009_unit_part_counts.sql
-- ============================================================
--   parts_total  = số part CÀO ĐƯỢC của unit (unique trong unit, GỒM cả part đã có sẵn trong DB) → công sức cào
--   parts_new    = số part THỰC SỰ INSERT mới (chưa từng có trong catalog_products) → dữ liệu mới thật
--   fitments_new = số fitment (quan hệ xe-part) THỰC SỰ tạo mới → thứ giá trị nhất, ít trùng
-- submit-unit đã tính sẵn (partsInserted/fitmentsCreated qua RETURNING) — nay lưu vào đây.
-- Cột parts_count CŨ giữ nguyên (= partList.length) để tương thích query cũ.
-- ============================================================

ALTER TABLE catalog_crawl_unit_log ADD COLUMN IF NOT EXISTS parts_total  INT DEFAULT 0;
ALTER TABLE catalog_crawl_unit_log ADD COLUMN IF NOT EXISTS parts_new    INT DEFAULT 0;
ALTER TABLE catalog_crawl_unit_log ADD COLUMN IF NOT EXISTS fitments_new INT DEFAULT 0;

-- Backfill parts_total = parts_count cho dòng CŨ (đã cào trước migration này) → "part cào được" đủ cả lịch sử.
-- parts_new/fitments_new KHÔNG backfill được (không biết lịch sử trùng/mới) → để 0, tính từ giờ trở đi.
UPDATE catalog_crawl_unit_log
   SET parts_total = parts_count
 WHERE parts_total = 0 AND parts_count > 0;
