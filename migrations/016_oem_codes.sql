-- ============================================================
-- Migration 016 — Bảng mã OE 1-N cho sản phẩm.
-- Chạy: psql -U <user> -d <db> -f migrations/016_oem_codes.sql
-- ============================================================
-- catalog_products.oem_code hiện là bản sao nguyên văn của internal_ref ở
-- 100% dòng (nguồn: scripts/nap_json.py gán cùng một giá trị cho cả hai cột),
-- nên DB chưa có một mã OE thật nào. Ngoài ra một phụ tùng thay được NHIỀU mã
-- OE (1 cảm biến ↔ 2 mã BMW) — một cột varchar không chứa nổi.
-- catalog_alternatives không thay được: nó nối product ↔ product, còn đây là
-- product ↔ mã OE, mà mã OE có thể chưa tồn tại như một product.
CREATE TABLE IF NOT EXISTS catalog_oem_codes (
  product_id uuid NOT NULL REFERENCES catalog_products(id) ON DELETE CASCADE,
  oem_code   text NOT NULL,
  -- Cùng công thức chuẩn hóa với oem_norm/ref_norm của catalog_products để
  -- join được trực tiếp, không phải chuẩn hóa lại lúc truy vấn.
  oem_norm   text GENERATED ALWAYS AS
             (NULLIF(upper(regexp_replace(oem_code,'[^a-zA-Z0-9]','','g')),'')) STORED,
  make       text,
  source     text,           -- xuất xứ: 'dmvthh:Mã chung', 'partsouq', ...
  PRIMARY KEY (product_id, oem_code)
);

-- Tra ngược "mã OE này ứng với sản phẩm nào" — hướng tra cứu chính.
CREATE INDEX IF NOT EXISTS idx_oem_codes_norm ON catalog_oem_codes(oem_norm);
