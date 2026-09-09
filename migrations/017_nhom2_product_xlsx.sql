-- Hướng A cho Nhóm 2 của Product.xlsx: CÀO XE TRƯỚC, NẠP SẢN PHẨM SAU.
--
-- Vì sao cần 2 bảng chứ không nạp thẳng vào catalog_products:
--   ~77k mã này không có dữ liệu xe. Nạp trước = sản phẩm mồ côi, khách tra
--   theo xe không thấy. Nên giữ ở phòng chờ, mã nào PartSouq trả về xe thì mới
--   nạp kèm fitment; mã không có xe thì nằm lại, không làm phình catalog.

-- Phòng chờ: sản phẩm đọc từ Product.xlsx, CHƯA vào catalog_products.
CREATE TABLE IF NOT EXISTS product_cho_nap (
  ref_norm     text PRIMARY KEY,
  internal_ref text NOT NULL,
  ten          text NOT NULL,
  ma_goc       text NOT NULL,
  oem_norm     text NOT NULL,
  da_nap       boolean NOT NULL DEFAULT FALSE,
  nap_luc      timestamptz
);
CREATE INDEX IF NOT EXISTS idx_pcn_oem ON product_cho_nap(oem_norm) WHERE NOT da_nap;

-- Hàng đợi cào xe. Khoá theo oem_norm: nhiều sản phẩm chờ có thể dùng chung
-- một mã gốc, chỉ cần cào PartSouq ĐÚNG MỘT LẦN cho mỗi mã.
CREATE TABLE IF NOT EXISTS crawl_xe_queue (
  oem_norm     text PRIMARY KEY,
  oem_code     text NOT NULL,
  status       text NOT NULL DEFAULT 'pending',   -- pending | claimed | done | error
  worker_id    text,
  claimed_at   timestamptz,
  completed_at timestamptz,
  so_xe        integer DEFAULT 0,
  so_sp_nap    integer DEFAULT 0,
  error_msg    text
);
CREATE INDEX IF NOT EXISTS idx_cxq_status ON crawl_xe_queue(status, claimed_at);
