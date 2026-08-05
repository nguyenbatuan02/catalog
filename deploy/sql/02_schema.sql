SET client_encoding = 'UTF8';
-- ↑ PHẢI là dòng đầu tiên. psql trên Windows mặc định đọc file theo WIN1252,
--   gặp tiếng Việt trong chú thích sẽ báo:
--   "character with byte sequence 0x.. in encoding WIN1252 has no equivalent in UTF8"

-- ============================================================
-- 02_schema.sql — Bảng + ràng buộc + view
-- Chạy bằng user ứng dụng, SAU 01_init.sql
--   psql -U catalog_user -d catalog -f 02_schema.sql
-- ============================================================
-- Tên bảng và tên cột GIỮ NGUYÊN 100% như DB cũ → code và UI
-- không phải sửa một dòng nào, chỉ đổi DB_NAME trong .env.
--
-- Khác DB cũ đúng 2 điểm, đều là để CHỐNG RÁC:
--   1. Thêm cột sinh tự động `oem_norm` + UNIQUE  → xem ghi chú ở dưới
--   2. Bỏ các index trùng lặp                     → xem file 03_indexes.sql
-- ============================================================

-- ─────────────────────────────────────────────────────────────
-- SẢN PHẨM (phụ tùng)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE catalog_products (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              varchar(500) NOT NULL,          -- tên gốc (thường tiếng Anh)
  internal_ref      varchar(100),                   -- mã nội bộ
  oem_code          varchar(100),                   -- mã OEM, ghi sao cũng được
  is_for_sale       boolean      DEFAULT true,
  product_type      varchar(50)  DEFAULT 'aftermarket',
  brand             varchar(100),                   -- HÃNG XE của phụ tùng (Toyota, Kia...)
  unit              varchar(20)  DEFAULT 'cai',
  notes             text,
  odoo_id           integer,
  created_at        timestamptz  DEFAULT now(),
  updated_at        timestamptz  DEFAULT now(),
  search_text       text,                           -- gộp sẵn để tìm nhanh
  partsouq_checked  timestamptz,
  name_vi           text,                           -- tên tiếng Việt
  needs_translation boolean      DEFAULT false,

  -- ══ CHỐNG RÁC ═══════════════════════════════════════════════
  -- DB cũ để mã OEM 2 kiểu lẫn lộn: '09111-0K180' và '091110K180'
  -- → 2.915.182 dòng nhưng chỉ có 2.728.105 mã thật
  -- → ~187.000 dòng TRÙNG ẨN, tra cứu hay trượt.
  --
  -- Cột này tự sinh: bỏ hết gạch/space/ký tự lạ rồi viết hoa.
  -- Không cần ghi vào, Postgres tự tính mỗi khi oem_code đổi.
  --   '09111-0K180'  → '091110K180'
  --   ' 42200-S04-5' → '42200S045'
  --   ''  hoặc NULL  → NULL  (NULL không bị UNIQUE chặn)
  oem_norm text GENERATED ALWAYS AS (
    NULLIF(upper(regexp_replace(coalesce(oem_code, ''), '[^a-zA-Z0-9]', '', 'g')), '')
  ) STORED
);

-- Một mã OEM = một dòng. Ghi kiểu nào cũng đụng vào đây → rác cũ
-- KHÔNG thể quay lại. Script import dùng ON CONFLICT (oem_norm) để gộp.
-- Nếu về sau vướng (2 hãng trùng mã thật) thì gỡ bằng:
--     DROP INDEX uq_products_oem_norm;
CREATE UNIQUE INDEX uq_products_oem_norm
  ON catalog_products (oem_norm)
  WHERE oem_norm IS NOT NULL;

-- Mã nội bộ cũng không được trùng
CREATE UNIQUE INDEX idx_prod_ref
  ON catalog_products (internal_ref)
  WHERE internal_ref IS NOT NULL;


-- ─────────────────────────────────────────────────────────────
-- XE
-- model_code (VD 'GUN142L-MDMLYV') mới là khoá thật để tra phụ tùng,
-- model_name chỉ để hiển thị (nhiều xe khác nhau trùng model_name).
-- ─────────────────────────────────────────────────────────────
CREATE TABLE catalog_vehicles (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  make          varchar(100) NOT NULL,
  model_code    varchar(100) NOT NULL,
  model_name    varchar(200),
  vehicle_type  varchar(50)  DEFAULT 'car',
  year_from     integer,
  year_to       integer,
  odoo_ref      varchar(200),
  created_at    timestamptz  DEFAULT now(),
  updated_at    timestamptz  DEFAULT now(),
  engine        varchar(100),
  transmission  varchar(50),
  drive_type    varchar(20),
  steering      varchar(10),
  gear_shift    varchar(50),
  specs_raw     text,
  specs_fetched timestamptz,
  description   varchar(255),
  mfg_from      text,
  mfg_to        text,

  CONSTRAINT catalog_vehicles_make_model_code_key UNIQUE (make, model_code)
);


-- ─────────────────────────────────────────────────────────────
-- FITMENT — phụ tùng nào lắp được xe nào (bảng lớn nhất)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE catalog_fitments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES catalog_products(id) ON DELETE CASCADE,
  vehicle_id uuid NOT NULL REFERENCES catalog_vehicles(id) ON DELETE CASCADE,
  notes      text,
  created_at timestamptz DEFAULT now(),

  CONSTRAINT catalog_fitments_product_id_vehicle_id_key UNIQUE (product_id, vehicle_id)
);


-- ─────────────────────────────────────────────────────────────
-- SẢN PHẨM THAY THẾ
-- ─────────────────────────────────────────────────────────────
CREATE TABLE catalog_alternatives (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id     uuid NOT NULL REFERENCES catalog_products(id) ON DELETE CASCADE,
  alt_product_id uuid NOT NULL REFERENCES catalog_products(id) ON DELETE CASCADE,
  reason         varchar(200),
  created_at     timestamptz DEFAULT now(),

  CONSTRAINT catalog_alternatives_check CHECK (product_id <> alt_product_id),
  CONSTRAINT catalog_alternatives_product_id_alt_product_id_key UNIQUE (product_id, alt_product_id)
);


-- ─────────────────────────────────────────────────────────────
-- TỪ ĐỒNG NGHĨA — tên thợ / vùng miền / tiếng Anh
-- "bo thang", "má phanh", "brake pad" → cùng ra một thứ
-- product_name PHẢI khớp catalog_products.name
-- ─────────────────────────────────────────────────────────────
CREATE TABLE catalog_synonyms (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_name text NOT NULL,
  synonym      text NOT NULL,
  created_at   timestamptz DEFAULT now(),

  CONSTRAINT catalog_synonyms_product_name_synonym_key UNIQUE (product_name, synonym)
);


-- ─────────────────────────────────────────────────────────────
-- CACHE TRA VIN
-- ─────────────────────────────────────────────────────────────
CREATE TABLE catalog_vin_cache (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vin_full   text,
  vin_prefix text NOT NULL,
  model_code text,
  make       text,
  model_name text,
  year       integer,
  source     text        DEFAULT 'partsouq',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),

  CONSTRAINT catalog_vin_cache_vin_full_key            UNIQUE (vin_full),
  CONSTRAINT catalog_vin_cache_vin_full_model_code_key UNIQUE (vin_full, model_code)
);


-- ─────────────────────────────────────────────────────────────
-- ĐƠN HÀNG chốt từ trang chat
-- ─────────────────────────────────────────────────────────────
CREATE TABLE catalog_orders (
  id             serial PRIMARY KEY,
  order_code     text NOT NULL UNIQUE,
  customer_name  text NOT NULL,
  customer_phone text NOT NULL,
  address        text,
  note           text,
  items          jsonb NOT NULL,
  total          numeric(18,2),
  status         text        DEFAULT 'new',
  created_at     timestamptz DEFAULT now()
);


-- ─────────────────────────────────────────────────────────────
-- CACHE GIÁ BRAVO (SQL Server) — TTL đặt trong .env
-- ─────────────────────────────────────────────────────────────
CREATE TABLE catalog_bravo_cache (
  cache_key  varchar(200) PRIMARY KEY,
  price      numeric(15,2),
  in_stock   boolean,
  unit_bravo varchar(50),
  fetched_at timestamptz DEFAULT now()
);


-- ─────────────────────────────────────────────────────────────
-- VIEW catalog_product_base — sản phẩm kèm sẵn danh sách xe
-- tương thích + hàng thay thế dạng JSON. Code query view này rất nhiều.
-- ─────────────────────────────────────────────────────────────
CREATE VIEW catalog_product_base AS
SELECT
  p.id,
  p.name,
  p.internal_ref,
  p.oem_code,
  p.is_for_sale,
  p.product_type,
  p.brand,
  p.unit,
  p.notes,
  COALESCE((
    SELECT json_agg(json_build_object(
             'make',       v.make,
             'model_code', v.model_code,
             'model_name', v.model_name,
             'year_from',  v.year_from,
             'year_to',    v.year_to))
    FROM catalog_fitments f
    JOIN catalog_vehicles v ON v.id = f.vehicle_id
    WHERE f.product_id = p.id
  ), '[]'::json) AS compatible_vehicles,
  COALESCE((
    SELECT json_agg(json_build_object(
             'id',           alt.id,
             'name',         alt.name,
             'internal_ref', alt.internal_ref,
             'oem_code',     alt.oem_code,
             'product_type', alt.product_type,
             'reason',       ca.reason))
    FROM catalog_alternatives ca
    JOIN catalog_products alt ON alt.id = ca.alt_product_id
    WHERE ca.product_id = p.id
  ), '[]'::json) AS alternatives
FROM catalog_products p;
