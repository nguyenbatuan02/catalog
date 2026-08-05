-- ============================================================
-- Migration 006 — Điền cột brand = HÃNG SẢN XUẤT PHỤ TÙNG
-- Chạy: PGCLIENTENCODING=UTF8 psql -U crmuser -d zalocrm -f migrations/006_fill_brand.sql
-- ============================================================
-- KẾT QUẢ THỰC TẾ (đã chạy 2026-07-15): brand điền được 95,1% (1.336.109/1.404.297).
--
-- Chiến lược đã chốt = "kết hợp", nhưng THỰC TẾ chỉ phần NỀN có giá trị:
--   NỀN (áp dụng): brand = hãng xe (Toyota/Mazda/Hyundai…) suy từ fitment → vehicle.make,
--                  hãng ÁP ĐẢO (MODE) nếu SP fit nhiều hãng. Nghĩa = phụ tùng CHÍNH HÃNG của hãng xe đó.
--   OVERRIDE tên (ĐÃ THỬ & GỠ BỎ): parse Denso/Bosch/Aisin/KYB/555 từ name chỉ khớp
--                  271+19 dòng, KIỂM TRA ra 100% là HÀNG QUẢNG CÁO/POS (áo, bút, cờ phướn,
--                  kệ sắt, bảng giá, brochure…), KHÔNG phải phụ tùng. Phụ tùng thật đặt tên
--                  theo CÔNG DỤNG ("Bơm nước", "Má phanh") nên KHÔNG chứa tên hãng SX.
--                  → Đã revert phần override. Hãng SX tier-1 (Denso/Bosch của HÀNG GENUINE)
--                  KHÔNG có trong dữ liệu ở đâu cả (Bravo chỉ giá/tồn, Odoo rỗng, CSV không có cột).
--
-- Chỉ điền chỗ brand ĐANG RỖNG — GIỮ NGUYÊN 3.856 dòng brand='Ford' (Ford chính hãng) có sẵn.
-- ============================================================

-- ---- BƯỚC A: bảng mapping product_id → hãng xe áp đảo (đọc 22tr fitments 1 lần) ----
DROP TABLE IF EXISTS catalog_brand_src;
CREATE TABLE catalog_brand_src AS
  SELECT f.product_id,
         MODE() WITHIN GROUP (ORDER BY NULLIF(TRIM(v.make),'')) AS make
  FROM catalog_fitments f
  JOIN catalog_vehicles v ON v.id = f.vehicle_id
  GROUP BY f.product_id;
ALTER TABLE catalog_brand_src ADD COLUMN rn bigserial;          -- số thứ tự để chia LÔ
CREATE UNIQUE INDEX idx_brand_src_pid ON catalog_brand_src(product_id);
CREATE INDEX idx_brand_src_rn ON catalog_brand_src(rn);

-- ---- BƯỚC B (NỀN): điền brand = hãng xe, CHỈ nơi brand đang rỗng ----
-- LƯU Ý VẬN HÀNH: catalog_products ~1,4tr dòng và ĐANG bị crawl ghi liên tục.
-- UPDATE 1-cục cả 1,33tr dòng làm PHÌNH WAL + nghẽn I/O (đã thử: chạy 1 tiếng chưa xong).
-- => Chạy THEO LÔ 100k, commit từng lô (xem scripts vòng lặp bên dưới), KHÔNG chạy 1 câu.
--
-- Bản 1-câu (chỉ dùng khi DB rảnh, không có crawl):
--   UPDATE catalog_products p SET brand = s.make
--   FROM catalog_brand_src s
--   WHERE p.id = s.product_id AND s.make IS NOT NULL AND s.make <> ''
--     AND (p.brand IS NULL OR p.brand = '');
--
-- Bản THEO LÔ (đã dùng) — chạy bằng bash, mỗi lô là 1 transaction tự commit:
--   STEP=100000; MAX=$(psql ... -c "SELECT MAX(rn) FROM catalog_brand_src")
--   for A in $(seq 0 $STEP $MAX); do
--     psql ... -c "UPDATE catalog_products p SET brand=s.make
--                  FROM catalog_brand_src s
--                  WHERE p.id=s.product_id AND s.rn>$A AND s.rn<=$((A+STEP))
--                    AND s.make IS NOT NULL AND s.make<>''
--                    AND (p.brand IS NULL OR p.brand='');"
--     sleep 2
--   done

-- ---- BƯỚC C (OVERRIDE tên): ĐÃ GỠ BỎ — chỉ khớp merchandise, không phải phụ tùng. KHÔNG chạy. ----

-- ============================================================
-- REVERT phần NỀN (nếu cần), chạy tay:
--   UPDATE catalog_products p SET brand='' FROM catalog_brand_src s
--     WHERE p.id=s.product_id AND p.brand = s.make;
-- Dọn bảng nguồn khi chắc chắn: DROP TABLE catalog_brand_src;
-- ============================================================
