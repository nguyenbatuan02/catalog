SET client_encoding = 'UTF8';
-- ↑ PHẢI là dòng đầu tiên. psql trên Windows mặc định đọc file theo WIN1252,
--   gặp tiếng Việt trong chú thích sẽ báo:
--   "character with byte sequence 0x.. in encoding WIN1252 has no equivalent in UTF8"

-- ============================================================
-- 03_indexes.sql — Index tìm kiếm
-- CHẠY SAU KHI ĐÃ ĐẨY DATA XONG (nhanh hơn nhiều so với tạo trước)
--   psql -U catalog_user -d catalog -f 03_indexes.sql
-- ============================================================
-- Các index UNIQUE (chống trùng) đã nằm ở 02_schema.sql vì phải có
-- sẵn lúc import thì ON CONFLICT mới hoạt động. File này chỉ chứa
-- index phục vụ TÌM KIẾM — không có nó vẫn chạy đúng, chỉ chậm.
--
-- DB cũ có 6 cặp index TRÙNG NHAU y hệt (idx_prod_oem + idx_products_oem,
-- idx_fit_prod + idx_fitments_product, ...) — tốn dung lượng và làm chậm
-- ghi mà không được gì. Bản này đã bỏ, giữ mỗi thứ đúng một cái.
-- ============================================================

-- ─── SẢN PHẨM ────────────────────────────────────────────────
-- Tìm không dấu: unaccent(name) ILIKE '%ma phanh%'
CREATE INDEX IF NOT EXISTS idx_prod_name_unaccent_trgm
  ON catalog_products USING gin (unaccent_immutable(name) gin_trgm_ops);

-- Tìm gần đúng trên tên gốc
CREATE INDEX IF NOT EXISTS idx_prod_trgm
  ON catalog_products USING gin (name gin_trgm_ops);

-- Tìm gần đúng trên cột gộp sẵn
CREATE INDEX IF NOT EXISTS idx_products_search_trgm
  ON catalog_products USING gin (search_text gin_trgm_ops);

-- Tra đúng mã OEM như người dùng gõ (có gạch)
CREATE INDEX IF NOT EXISTS idx_prod_oem
  ON catalog_products (oem_code) WHERE oem_code IS NOT NULL;

-- Tra mã OEM bất kể cách ghi. KHÔNG unique — nhiều hàng tương đương
-- được phép chung một mã OEM. Index này thay cho việc app phải chạy
-- REPLACE(oem_code,'-','') lúc truy vấn (rất chậm vì không dùng được index).
CREATE INDEX IF NOT EXISTS idx_prod_oem_norm
  ON catalog_products (oem_norm) WHERE oem_norm IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_products_brand ON catalog_products (brand);
CREATE INDEX IF NOT EXISTS idx_products_type  ON catalog_products (product_type);
CREATE INDEX IF NOT EXISTS idx_products_sale  ON catalog_products (is_for_sale);

-- Lọc phần chưa dịch sang tiếng Việt
CREATE INDEX IF NOT EXISTS idx_products_chua_dich
  ON catalog_products (id) WHERE name_vi IS NULL OR name_vi = '';


-- ─── XE ──────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_veh_code     ON catalog_vehicles (model_code);
CREATE INDEX IF NOT EXISTS idx_veh_make     ON catalog_vehicles (make);
CREATE INDEX IF NOT EXISTS idx_vehicles_year ON catalog_vehicles (year_from, year_to);


-- ─── FITMENT ─────────────────────────────────────────────────
-- CHỈ cần index theo vehicle_id.
-- Chiều product_id đã được UNIQUE (product_id, vehicle_id) ở 02 lo rồi
-- (Postgres dùng được index tổ hợp khi lọc theo cột đầu) → thêm nữa là thừa.
-- Trên bảng ~29 triệu dòng, bỏ 1 index thừa tiết kiệm cỡ 1 GB.
CREATE INDEX IF NOT EXISTS idx_fit_veh ON catalog_fitments (vehicle_id);

-- Giao diện gọi GET /fitments (sắp xếp theo created_at giảm dần) mỗi lần
-- làm mới. Không có index này thì Postgres phải quét và sắp xếp CẢ BẢNG
-- chỉ để lấy 100 dòng mới nhất — trên bảng chục triệu dòng là treo giao diện.
CREATE INDEX IF NOT EXISTS idx_fit_created ON catalog_fitments (created_at DESC);


-- ─── TỪ ĐỒNG NGHĨA ───────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_synonyms_name    ON catalog_synonyms (lower(product_name));
CREATE INDEX IF NOT EXISTS idx_synonyms_synonym ON catalog_synonyms (lower(synonym));


-- ─── VIN / BRAVO ─────────────────────────────────────────────
-- vin_full đã có UNIQUE nên không cần index riêng
CREATE INDEX IF NOT EXISTS idx_vin_prefix ON catalog_vin_cache (vin_prefix);
CREATE INDEX IF NOT EXISTS idx_bravo_time ON catalog_bravo_cache (fetched_at DESC);


-- ─── Cập nhật thống kê để Postgres chọn đúng kế hoạch truy vấn ──
-- Bỏ qua bước này là nguyên nhân phổ biến nhất khiến "DB mới chạy chậm hơn DB cũ"
ANALYZE catalog_products;
ANALYZE catalog_vehicles;
ANALYZE catalog_fitments;
ANALYZE catalog_synonyms;
ANALYZE catalog_vin_cache;
