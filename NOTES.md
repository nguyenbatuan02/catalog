# CATALOG API PROJECT — NOTES (cập nhật 04/06/2026)

## QUAN TRỌNG — ĐỌC TRƯỚC KHI LÀM

### sendChat trong index.html
- Hàm `sendChat` ở pos ~76152 là **PLACEHOLDER chưa implement** — KHÔNG tự ý sửa
- Logic chat thật do user đang xây dở ở pos ~82393 (`sendChatWithImage`)
- Thông báo "Vui lòng cấu hình API AI..." là hardcode chưa implement — user biết, đang xây
- Luồng chat: Classifier GPT-4o-mini → type → tra DB → Formatter GPT-4o viết câu intro → JS render bảng
- **KHÔNG dùng GPT tự bịa mã phụ tùng** — phải tra DB thật qua `catalog.routes.ts`

### OpenAI API
- Key đã có trong `.env`: `OPENAI_API_KEY=sk-proj-...`
- Proxy endpoint: `POST /api/ai/chat` (trong server.ts, nhận GET → 404)
- Vision endpoint: `POST /api/ai/vision` dùng GPT-4o đọc VIN từ ảnh
- Test: `curl -X POST http://localhost:3001/api/ai/chat -H "Content-Type: application/json" -d "{\"model\":\"gpt-4o-mini\",\"messages\":[{\"role\":\"user\",\"content\":\"test\"}],\"max_tokens\":50}"`

---

## catalog_synonyms — Bảng synonym tên thợ/vùng miền

### Mục đích
Cho phép search bằng tên thợ, tên vùng miền, tiếng Anh đều ra kết quả.
Ví dụ: `má phanh`, `bo thang`, `brake pad` → đều ra phụ tùng đúng.

### Cấu trúc
- `product_name` = tên khớp với `name` trong `catalog_product_base` (PHẢI khớp)
- `synonym` = cách gọi khác (tên thợ, vùng miền, tiếng Anh)

### Logic resolvePartName (catalog.routes.ts)
```
1. Chuẩn hóa chính tả input
2. Tìm trong catalog_synonyms.synonym → ra product_name
3. Tìm trong catalog_synonyms.product_name → ra thêm synonyms
4. Trả về mảng [input, ...product_names, ...synonyms]
5. fallbackByName dùng mảng đó để ILIKE + similarity search trong catalog_products
```

### Đã insert ~250 synonym (file: insert_synonyms_full.sql)
Bao gồm: piston/séc măng/biên/balie, gioăng đại tu, lọc dầu/gió/nhiên liệu,
bơm dầu/nước, bugi/môbin/kim phun, turbo, curoa/xích, két nước, máy phát/đề,
hộp số, cây láp, bi tê/đĩa côn/bàn ép, trục các đăng, giảm xóc/phuộc,
càng A/rô tuyn, thước lái, má phanh/guốc phanh/đĩa phanh, ắc quy, cảm biến,
điều hòa (lốc lạnh/dàn nóng/dàn lạnh), cản xe, gạt mưa...

### LƯU Ý QUAN TRỌNG
- Innova GUN142L dùng phanh tang trống sau → KHÔNG có má phanh sau, chỉ có GUỐC phanh sau
- `má phanh sau` → synonym → `Bộ guốc sau phanh` (tên trong DB)

---

## Dịch tên phụ tùng tiếng Anh → tiếng Việt

### Tiến độ hiện tại (04/06/2026)
- Tổng: 1,368,785 sản phẩm
- Đã dịch: 585,737 (42.8%)
- Còn tiếng Anh: 783,048 (57.2%)

### Phân bố theo hãng (còn tiếng Anh)
- Toyota: 379,010
- Hyundai: 95,797
- Mazda: 94,022
- Infiniti: 93,016
- Kia: 55,950
- Jeep: 48,341
- Peugeot: 38,557
- Dodge: 29,435
- Lexus: 13,670

### Các file SQL đã tạo (trong CHATAI\)
- `update_vi_names_innova_v4.sql` — dịch tên OEM Innova GUN142L (2,679 mã)
- `update_vi_names_innova_final.sql` — file dịch từ Excel Innova
- `update_innova_v5.sql`, `v6.sql`, `v6b.sql` — fix tên còn tiếng Anh Innova
- `update_all_english_v2.sql` — dịch toàn DB (350+ lệnh regexp_replace)
- `fix_uppercase_v3.sql` — dịch FRONT/REAR/BACK/SIDE... toàn DB
- `insert_synonyms_full.sql` — 250 synonym tên thợ/vùng miền
- `insert_synonyms.sql` — synonym Toyota Innova cụ thể

### Model đã dịch tốt
- **GUN142L-MDMLYV** (Toyota Innova 2015-2018) — dịch ~90%, còn vài từ lẻ

### Chiến lược dịch
- Toyota có file Excel phụ tùng → dịch chính xác từ cột "Tên phụ tùng (VI)"
- Hãng khác (Hyundai/Kia/Mazda) → dùng regexp_replace toàn DB
- Không cần dịch 100% — dùng `catalog_synonyms` để search tiếng Việt

### Format oem_code trong DB
- DB lưu: `09111-0K180` (5 ký tự + dấu - + 5 ký tự)
- File Excel 10 ký tự: `091110K180` → thêm dấu - sau 5 ký tự
- File Excel 12 ký tự: `131010E01001` → bỏ 2 ký tự cuối rồi thêm dấu -

---

## Tình trạng AI chat

### Vấn đề chưa giải quyết
- `sendChat` placeholder chưa implement — user đang xây
- Cần cài `unaccent` extension để search không dấu hoạt động:
  ```sql
  -- Chạy với user postgres:
  CREATE EXTENSION IF NOT EXISTS unaccent;
  ```
- Sau khi cài unaccent, search trong code dùng: `unaccent(name) ILIKE unaccent('%...')`

### Đã hoạt động
- `/api/ai/chat` POST → proxy OpenAI GPT-4o-mini ✅
- `/api/ai/vision` POST → GPT-4o đọc VIN từ ảnh ✅
- `catalog_synonyms` đã có 5,000+ synonym ✅

---

## Lệnh hay dùng

```cmd
# Vào psql với encoding đúng
chcp 65001 && "C:\Program Files\PostgreSQL\16\bin\psql" -U crmuser -d zalocrm

# Chạy file SQL lớn
set PGCLIENTENCODING=UTF8 && "C:\Program Files\PostgreSQL\16\bin\psql" -U crmuser -d zalocrm -f "C:\Users\Administrator\Desktop\CHATAI\file.sql"

# Kiểm tra tiến độ dịch
SELECT COUNT(*) as tong, COUNT(*) FILTER (WHERE name ~ '[A-Z]{3,}') as con_tieng_anh,
ROUND(COUNT(*) FILTER (WHERE name !~ '[A-Z]{3,}') * 100.0 / COUNT(*), 1) as phan_tram
FROM catalog_product_base;

# Test synonym
SELECT * FROM catalog_synonyms WHERE unaccent(lower(synonym)) ILIKE '%piston%' LIMIT 5;

# Tìm phụ tùng theo xe + tên
SELECT p.oem_code, p.name FROM catalog_product_base p
JOIN catalog_fitments f ON p.id = f.product_id
JOIN catalog_vehicles v ON f.vehicle_id = v.id
WHERE v.model_code = 'GUN142L-MDMLYV'
AND p.name ILIKE '%piston%' LIMIT 10;
```

---

## File Excel phụ tùng Toyota
- `Toyota_INNOVA_GUN142L_PhuTung_V2.xlsx` — 4,245 phụ tùng Innova
- Format: cột A=Danh mục, B=Nhóm, C=Mã OEM (10/12 ký tự), D=Tên EN, E=Tên VI
- Header ở row 2 (row 1 là tiêu đề lớn)
- Nếu có file Excel model khác → dùng cùng script để dịch
