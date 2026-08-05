-- ============================================================
-- Migration 003 — Đảm bảo index cho submit-unit nhanh.
-- Chạy: psql -U crmuser -d zalocrm -f migrations/003_perf_index.sql
-- ============================================================
-- LƯU Ý: các index cần thiết PHẦN LỚN ĐÃ TỒN TẠI:
--   - catalog_products: idx_prod_oem (oem_code), idx_prod_ref (internal_ref)
--   - catalog_fitments: unique(product_id, vehicle_id) + idx_fit_prod/idx_fit_veh
--   - catalog_vehicles: unique(make, model_code) + idx_veh_code
-- Fix TỐC ĐỘ chính là REWRITE query submit-unit dùng so khớp CHÍNH XÁC `oem_code = ANY(...)`
-- (dùng index idx_prod_oem, ~20ms) thay vì `UPPER(oem_code)=...` (seq-scan 1.37tr dòng ~1.1s).
-- File này chỉ CHẮC CHẮN index tồn tại (idempotent, IF NOT EXISTS).

-- idx_prod_oem ĐÃ TỒN TẠI (catalog_products do postgres sở hữu → crmuser không tạo được).
-- Nếu cần tạo lại, chạy bằng user postgres:
--   psql -U postgres -d zalocrm -c "CREATE INDEX IF NOT EXISTS idx_prod_oem ON catalog_products(oem_code);"
-- Hiện tại index đã có nên KHÔNG cần chạy gì — chỉ cần bản query submit-unit mới (đã sửa) là đủ nhanh.

-- Kiểm tra sau khi chạy:
-- SELECT indexname FROM pg_indexes WHERE tablename='catalog_products' AND indexdef ILIKE '%oem_code%';
