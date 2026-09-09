-- ============================================================
-- Migration 014 — Index trigram cho name_vi + route /products tìm được
-- cả tiếng Việt (trước giờ chỉ tìm "name" tiếng Anh + mã, name_vi bị bỏ sót
-- hoàn toàn dù cột này đã có sẵn từ trước).
-- Chạy: psql -U <user> -d <db> -f migrations/014_name_vi_trgm_index.sql
-- ============================================================
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_prod_name_vi_unaccent_trgm
  ON catalog_products USING gin (unaccent_immutable(name_vi) gin_trgm_ops);

ANALYZE catalog_products;
