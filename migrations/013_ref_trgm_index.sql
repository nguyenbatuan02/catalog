-- ============================================================
-- Migration 013 — Index trigram cho internal_ref/oem_code.
-- Chạy: psql -U <user> -d <db> -f migrations/013_ref_trgm_index.sql
-- ============================================================
-- 03_indexes.sql đã có trigram cho "name" (idx_prod_name_unaccent_trgm) nhưng
-- KHÔNG có cho internal_ref/oem_code — route GET /products search OR cả 3 cột
-- (name ILIKE OR internal_ref ILIKE OR oem_code ILIKE), thiếu 2 index này thì
-- Postgres không thể dùng index cho toàn bộ điều kiện OR → rơi về Seq Scan
-- 5.4tr dòng (~17s chỉ riêng COUNT(*), đã đo bằng EXPLAIN ANALYZE).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_prod_internal_ref_trgm
  ON catalog_products USING gin (internal_ref gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_prod_oem_code_trgm
  ON catalog_products USING gin (oem_code gin_trgm_ops);

ANALYZE catalog_products;
