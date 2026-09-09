-- ============================================================
-- Migration 012 — Index cho GET /products (duyệt/phân trang catalog).
-- Chạy: psql -U <user> -d <db> -f migrations/012_products_browse_index.sql
-- ============================================================
-- Không có index này, ORDER BY name trên 5.4tr dòng phải sort CẢ BẢNG
-- trước khi cắt LIMIT — chậm như nhau dù LIMIT 24 hay không LIMIT gì
-- (đã đo: ~12-13s/trang). Có index, Postgres đọc thẳng theo thứ tự index,
-- không cần sort nữa → LIMIT 24 chỉ đọc đúng 24 dòng.
--
-- CONCURRENTLY để không khoá ghi trong lúc build (mất thời gian hơn build
-- thường nhưng an toàn cho hệ thống đang chạy). KHÔNG chạy được trong
-- transaction block — chạy trực tiếp bằng psql, không bọc BEGIN/COMMIT.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_products_forsale_name
  ON catalog_products (is_for_sale, name);

ANALYZE catalog_products;
