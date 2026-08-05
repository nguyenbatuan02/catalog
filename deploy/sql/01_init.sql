-- ============================================================
-- 01_init.sql — Extension + hàm phụ trợ
-- Chạy MỘT LẦN, với quyền SUPERUSER (user postgres), trên DB MỚI
--   psql -U postgres -d catalog -f 01_init.sql
-- ============================================================
-- Vì sao phải là postgres: CREATE EXTENSION cần quyền superuser.
-- Các file 02/03 thì chạy bằng user thường (catalog_user) được.

-- Tìm gần đúng theo tên (ILIKE + similarity) — bắt buộc, code search dùng
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Bỏ dấu tiếng Việt — cho phép gõ "ma phanh" ra "má phanh"
CREATE EXTENSION IF NOT EXISTS unaccent;

-- unaccent() gốc là STABLE nên KHÔNG dùng trực tiếp trong index được.
-- Bọc lại thành IMMUTABLE để đánh index GIN. Index idx_prod_name_unaccent_trgm
-- ở file 03 phụ thuộc hàm này → phải tạo trước.
CREATE OR REPLACE FUNCTION public.unaccent_immutable(text)
RETURNS text
LANGUAGE sql
IMMUTABLE PARALLEL SAFE
AS $$
  SELECT public.unaccent($1)
$$;

-- Cấp quyền cho user ứng dụng (đổi tên nếu bạn đặt user khác)
GRANT USAGE ON SCHEMA public TO catalog_user;
GRANT CREATE ON SCHEMA public TO catalog_user;
