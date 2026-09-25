-- loadOemCodes() hỏi "make này có phải hãng xe không" bằng
-- EXISTS (... WHERE lower(v.make) = lower(o.make)) cho TỪNG mã thay thế.
-- Không index thì mỗi lần quét cả catalog_vehicles (~12k dòng, 25ms) —
-- sản phẩm 50 mã mất 1.2s chỉ riêng phần này.
CREATE INDEX IF NOT EXISTS idx_vehicles_make_lower ON catalog_vehicles (lower(make));
