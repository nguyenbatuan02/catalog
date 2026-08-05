-- ============================================================
-- Migration 010 — SỬA spam "function unaccent(text) does not exist" trong PG log
-- ⚠️ PHẢI CHẠY BẰNG SUPERUSER (postgres) — function do postgres sở hữu, crmuser KHÔNG replace được.
--   psql -U postgres -d zalocrm -f migrations/010_fix_unaccent_immutable.sql
-- ============================================================
-- NGUYÊN NHÂN (đã xác nhận qua PG log + reproduce):
--   Lỗi KHÔNG phải từ endpoint VIN/search. Nó đến từ AUTO-ANALYZE (autovacuum) của bảng
--   catalog_products khi tính thống kê cho INDEX biểu thức:
--       idx_prod_name_unaccent_trgm = gin( unaccent_immutable((name)::text) gin_trgm_ops )
--   PG log:  QUERY: SELECT unaccent($1)
--            CONTEXT: SQL function "unaccent_immutable" during inlining
--                     automatic analyze of table "zalocrm.public.catalog_products"
--   Body của unaccent_immutable là `SELECT unaccent($1)` — GỌI unaccent KHÔNG schema-qualify.
--   Worker autovacuum chạy với search_path HẠN CHẾ (không có 'public') → không tìm thấy
--   public.unaccent → lỗi mỗi ~60s (crawler ghi liên tục → auto-analyze chạy thường xuyên).
--   Endpoint (pool) vẫn OK vì search_path của pool có 'public'.
--
-- FIX: schema-qualify -> public.unaccent($1). Vẫn IMMUTABLE + inline được; kết quả GIỐNG HỆT nên
--   INDEX đã build KHÔNG cần REINDEX (giá trị không đổi). Sau khi chạy, auto-analyze hết lỗi.
-- ============================================================

CREATE OR REPLACE FUNCTION public.unaccent_immutable(text)
RETURNS text
LANGUAGE sql
IMMUTABLE PARALLEL SAFE
AS $$ SELECT public.unaccent($1) $$;

-- Kiểm tra: phải trả 'Giam soc truoc' và KHÔNG lỗi kể cả khi search_path chỉ có pg_catalog.
-- SET search_path TO pg_catalog;
-- SELECT public.unaccent_immutable('Giảm sóc trước');
-- RESET search_path;
