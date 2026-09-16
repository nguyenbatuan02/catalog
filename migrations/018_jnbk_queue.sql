-- Hàng đợi cào JNBK (nibk-brakes.com) — hãng má phanh Nhật.
--
-- Vì sao tách bảng riêng thay vì dùng chung crawl_substitutes_queue:
--   JNBK cho ra thứ KHÁC PartSouq. Một lần tra trả về cả bảng cross-reference
--   (AKEBONO/BENDIX/FMSI/WVA/KASHIYAMA) + thông số kích thước + bảng xe.
--   Trộn chung hàng đợi thì không tách được số liệu để biết nguồn nào đáng cào,
--   và không chạy song song hai nguồn ở nhịp khác nhau được.
--
-- Phạm vi hẹp: JNBK CHỈ có má phanh / guốc phanh / đĩa phanh.
-- Đo 2026-09-15: 3/119 mã có dữ liệu (2.5%) nhưng trung bình 53 mã chéo/lần.

CREATE TABLE IF NOT EXISTS crawl_jnbk_queue (
  ref_norm     text PRIMARY KEY,
  ma_goc       text NOT NULL,
  status       text NOT NULL DEFAULT 'pending',   -- pending | claimed | done | error
  worker_id    text,
  claimed_at   timestamptz,
  completed_at timestamptz,
  ma_nibk      text,          -- mã NiBK tìm được (PN1803, FN3351...)
  total_found  integer DEFAULT 0,
  error_msg    text
);
CREATE INDEX IF NOT EXISTS idx_jnbk_status ON crawl_jnbk_queue(status, claimed_at);
