# PartSouq OEM Crawler (extension)

Tra ngược mã OEM trên PartSouq → lấy xe tương thích → import fitment vào Catalog API.
Bổ sung cho crawler-theo-model (~57k product chưa có fitment).

## Cách chạy
1. `chrome://extensions` → bật **Developer mode** → **Load unpacked** → chọn thư mục `oem-extension`.
2. Mở popup: nạp `oem_codes.csv` (đã có file mẫu 15 mã thật chưa có fitment), kiểm tra **Server API** (mặc định `http://103.214.9.97:3001/api/v1/catalog`) và **Delay** (2000ms), bấm **▶ Bắt đầu**.
3. Extension mở tab `/search?q=<mã>` (ẩn), đợi Cloudflare, scrape xe, gửi API. Tuần tự từng mã, resume được nếu Chrome kill service worker.

## Kiến trúc
- `background.js` — hàng đợi + orchestration + gọi API `POST /fitments/import-by-oem`. Gửi **mã GỐC** (khớp product trong DB), còn URL search dùng **mã đã làm sạch** (bỏ suffix `-NM/-CC/-K/-B/-GB/-WTA/STD/025...`).
- `content.js` — chạy trên `/search`, đợi Cloudflare, scrape, **push** `OEM_RESULT` về background.
- `db.js` — IndexedDB (store `oem_crawler`) lưu state + tiến độ để resume.
- `popup.html/js` — UI: nạp CSV, Start/Stop/Xóa, thống kê, log.

## Cách content.js lấy xe (cấu trúc đã xác nhận 2026-07-18)
Trang `/search` CHỈ hiện tên model rút gọn (không có model_code/năm). Danh sách xe đầy đủ lấy qua **2 tầng**:
1. Trên trang search: lấy card `.compatibility-car[data-make][data-product_id]` (chỉ **card đầu tiên** — các card sau là seller khác cùng mã, compatibility giống nhau).
2. Fetch modal: `GET /instant/compatibility?id=<product_id>` (same-origin, kèm cookie) → HTML gồm:
   - tab `ul.nav-pills li a` → model_line (FORTUNER SUV, HILUX...)
   - pane `.tab-content .tab-pane table tbody tr`, cột `td2`=Year, `td3`=**Model code** (GUN155L-STTHX...).
3. Gộp thành 1 message `OEM_RESULT` gửi background (dedup theo model_code+năm để server nới year range qua LEAST/GREATEST).

Đã test parse end-to-end bằng jsdom (đúng 3 xe, dedup + bỏ dòng thiếu năm) — xem log. Nếu PartSouq đổi layout modal, chỉnh `parseCompatibility()` trong `content.js`.

## Endpoint server (đã thêm + test)
`POST /api/v1/catalog/fitments/import-by-oem`
Body: `{ oem_code, vehicles: [{make, model_name, model_code, year_from, year_to}] }`
→ tìm product theo `oem_code` (exact), upsert vehicle (ON CONFLICT DO UPDATE nới year range), insert fitment (ON CONFLICT DO NOTHING). Trả `{imported, skipped, product_found}`. Bỏ qua vehicle thiếu make/model_code.
