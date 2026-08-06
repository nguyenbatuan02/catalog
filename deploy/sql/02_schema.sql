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
  -- DB cũ ghi mã 2 kiểu lẫn lộn: '09111-0K180' và '091110K180'.
  -- Hai cột dưới đây tự sinh: bỏ hết gạch/space/ký tự lạ rồi viết hoa.
  -- Không cần ghi vào, Postgres tự tính lại mỗi khi cột gốc đổi.
  --   '09111-0K180'  → '091110K180'
  --   ' 42200-S04-5' → '42200S045'
  --   ''  hoặc NULL  → NULL  (NULL không bị UNIQUE chặn)

  -- Dạng chuẩn của MÃ OEM — dùng để TRA CỨU nhanh, KHÔNG unique.
  -- Nhiều dòng được phép chung một mã OEM: đó là hàng tương đương
  -- (cùng phụ tùng, khác nhà cung cấp / khác phẩm cấp, giá khác nhau).
  -- Đo trên DB cũ: 14.477 trường hợp như vậy — đặt UNIQUE ở đây là mất hàng.
  oem_norm text GENERATED ALWAYS AS (
    NULLIF(upper(regexp_replace(coalesce(oem_code, ''), '[^a-zA-Z0-9]', '', 'g')), '')
  ) STORED,

  -- Dạng chuẩn của MÃ SẢN PHẨM — đây mới là khoá chống trùng thật sự.
  -- Mỗi mã sản phẩm = một dòng duy nhất, ghi kiểu gì cũng quy về một.
  -- Đo trên DB cũ: 174.036 dòng trùng đúng nghĩa sẽ bị chặn nhờ cột này.
  ref_norm text GENERATED ALWAYS AS (
    NULLIF(upper(regexp_replace(coalesce(internal_ref, ''), '[^a-zA-Z0-9]', '', 'g')), '')
  ) STORED
);

-- Một MÃ SẢN PHẨM = một dòng. '01463-T0A-A01' và '01463T0AA01' là một.
-- Nhưng '01463-T0A-A01' và '01463-T0A-A01-A' là HAI hàng khác nhau → vẫn giữ cả hai.
-- Script import dùng ON CONFLICT (ref_norm) để gộp thay vì báo lỗi.
CREATE UNIQUE INDEX uq_products_ref_norm
  ON catalog_products (ref_norm)
  WHERE ref_norm IS NOT NULL;


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

  -- ══ KHOÁ PHÂN BIỆT CÁC BẢN XE ═══════════════════════════════
  -- Một mã model thường dùng chung cho nhiều bản xe khác nhau:
  --   Nissan  Z33   CONVERTIBLE / AT      ← 3 bản, cùng mã Z33
  --   Nissan  Z33   COUPE       / AT
  --   Nissan  Z33   COUPE       / MT
  --   Toyota  KUN40L-GKMDYM  2005-2012    ← 2 đời, cùng mã
  --   Toyota  KUN40L-GKMDYM  2012-2016
  -- Khoá chỉ gồm (make, model_code) thì chúng gộp làm một → mất dữ liệu,
  -- và tra theo năm không còn chính xác (hỏi đời 2016 lại ra đồ đời 2005).
  --
  -- Cột này tự gộp các thông số phân biệt lại. KHÔNG hiện cho người dùng,
  -- chỉ để chống trùng. COALESCE về chuỗi rỗng vì NULL <> NULL trong
  -- UNIQUE — không có nó thì xe chưa điền thông số sẽ trùng thoải mái.
  variant_key text GENERATED ALWAYS AS (
    upper(
      coalesce(year_from::text, '') || '|' ||
      coalesce(year_to::text,   '') || '|' ||
      coalesce(engine,          '') || '|' ||
      coalesce(transmission,    '') || '|' ||
      coalesce(drive_type,      '') || '|' ||
      coalesce(steering,        '') || '|' ||
      coalesce(gear_shift,      '')
    )
  ) STORED,

  -- Hai xe chỉ trùng khi CÙNG hãng, CÙNG mã VÀ cùng toàn bộ thông số.
  CONSTRAINT catalog_vehicles_key UNIQUE (make, model_code, variant_key)
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
-- KẾT QUẢ ĐỘ PHỦ TÍNH SẴN  (cho trang /fitment-matrix)
-- ─────────────────────────────────────────────────────────────
-- Trang ma trận phải dò tên từng phụ tùng với 122 mẫu chữ để biết xe có
-- những nhóm nào (bugi, lọc dầu, má phanh...). Làm việc đó mỗi lần mở
-- trang thì 100 xe đã quá 30 giây, trả về lỗi 503.
--
-- Phụ tùng của một xe gần như không đổi, nên tính MỘT LẦN rồi cất vào đây:
--   mask = 50 bit, bit thứ i bật nghĩa là xe có nhóm phụ tùng thứ i
-- Mở trang chỉ còn là đọc bảng này ra — tức thì, không còn dò chữ.
--
-- Tính lại bằng:  POST /api/v1/catalog/fitment-matrix/rebuild
-- CHẠY SAU MỖI LẦN NẠP THÊM DỮ LIỆU, không thì số liệu sẽ cũ.
CREATE TABLE catalog_fitment_matrix (
  vehicle_id  uuid PRIMARY KEY REFERENCES catalog_vehicles(id) ON DELETE CASCADE,
  total_parts integer     NOT NULL DEFAULT 0,
  mask        bigint      NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now()
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
