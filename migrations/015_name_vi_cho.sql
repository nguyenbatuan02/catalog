-- 015: tách tên chợ khỏi tên kỹ thuật
--
--   name         = tên gốc hãng (tiếng Anh/Nhật)      "COVER, SEAT CUSHION RH"
--   name_vi      = tên KỸ THUẬT tiếng Việt (đã có)     "Nắp đệm ghế phải"
--   name_vi_cho  = tên CHỢ, cách thợ/khách gọi         "ốp ghế phụ"
--
-- Chatbot tra cả 3 cột nên khách hỏi kiểu nào cũng ra.
-- Một tên chợ / sản phẩm; nếu sau này cần nhiều biến thể thì chuyển sang
-- catalog_synonyms (bảng đã có sẵn, đang rỗng).

ALTER TABLE catalog_products ADD COLUMN IF NOT EXISTS name_vi_cho text;

COMMENT ON COLUMN catalog_products.name_vi     IS 'Tên tiếng Việt kỹ thuật (chuẩn kỹ thuật)';
COMMENT ON COLUMN catalog_products.name_vi_cho IS 'Tên chợ — cách thợ/khách gọi thường ngày';

CREATE INDEX IF NOT EXISTS idx_prod_name_vi_cho_trgm
  ON catalog_products USING gin (unaccent_immutable(name_vi_cho) gin_trgm_ops);
