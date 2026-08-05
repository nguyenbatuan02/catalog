# Dựng Catalog API trên VPS mới

Mục tiêu: **UI và code giữ nguyên y hệt**, chỉ dựng lại DB sạch trên máy mới.
Data phụ tùng đẩy lên sau (xem mục cuối).

---

## 0. Cần cài sẵn trên VPS

| Thứ | Bản | Ghi chú |
|---|---|---|
| Node.js | **20 LTS trở lên** | Fastify 5 yêu cầu Node 20+ |
| PostgreSQL | **16** | Bản 15 cũng chạy được |
| Git | bất kỳ | để pull code |

<details>
<summary><b>Ubuntu / Debian</b></summary>

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs postgresql-16 postgresql-contrib-16 git
```
</details>

<details>
<summary><b>Windows Server</b></summary>

Tải installer từ nodejs.org và postgresql.org.
Nhớ tick **"Add to PATH"** cho cả hai.
</details>

---

## 1. Đẩy code lên VPS

### Chỉ đẩy những thứ này

```
src/              ← toàn bộ code backend
index.html        ← giao diện Chat AI  ⚠️ BẮT BUỘC, phải nằm ở thư mục gốc
public/           ← dashboard.html, fitment-matrix.html
deploy/           ← thư mục này
package.json
package-lock.json
tsconfig.json
```

Tuỳ chọn (không ảnh hưởng chạy): `scripts/`, `migrations/`, `NOTES.md`

### ⚠️ Đừng đẩy phần còn lại

Thư mục gốc project cũ có khoảng **150 file rác** — script chạy một lần, 9 bản
backup `index.html.bak*`, file SQL dump vài trăm KB, và **`products_merged.csv`
nặng 114 MB**. Đẩy hết lên là repo phình vô ích.

Tạo file `.gitignore` ở thư mục gốc trước khi commit:

```gitignore
node_modules/
.env
dist/

# Data thô — đừng đưa vào git
*.csv
*.xlsx
*.bak
*.bak[0-9]
*.bak-*
products_merged.csv
json-files/
data/
__pycache__/

# Script chạy một lần còn sót ở thư mục gốc
/*.cjs
/*.mjs
/*.py
/*.sql

# File rác tên lỗi do gõ nhầm lệnh
"/{"
"/(1"
/node
/curl
/dir
"/timeout)"
```

Kiểm tra trước khi push — phải thấy gọn:

```bash
git add -A && git status --short
```

---

## 2. Cài thư viện

```bash
cd <thư-mục-project>
npm ci          # dùng ci thay vì install để khớp đúng package-lock.json
```

---

## 3. Tạo DB mới

Chạy bằng user `postgres`:

```bash
sudo -u postgres psql       # Linux
# Windows:  psql -U postgres
```

```sql
CREATE ROLE catalog_user LOGIN PASSWORD 'đặt-mật-khẩu-mạnh-ở-đây';
CREATE DATABASE catalog OWNER catalog_user ENCODING 'UTF8';
\q
```

> **DB do `catalog_user` sở hữu** — khác hẳn DB cũ (bảng thuộc `postgres` nên
> `crmuser` không tạo nổi index, phải lách bằng `reltuples`). Máy mới không còn vướng.

---

## 4. Chạy 3 file SQL — theo đúng thứ tự

```bash
cd deploy/sql

# 4.1 — Extension. PHẢI chạy bằng postgres (cần quyền superuser)
sudo -u postgres psql -d catalog -f 01_init.sql

# 4.2 — Bảng, khoá, view
psql -U catalog_user -d catalog -f 02_schema.sql

# 4.3 — Index tìm kiếm.
#       Chạy được ngay, NHƯNG nếu sắp đẩy data lớn thì để dành chạy SAU
#       khi import xong sẽ nhanh hơn nhiều.
psql -U catalog_user -d catalog -f 03_indexes.sql
```

Kiểm tra:

```bash
psql -U catalog_user -d catalog -c "\dt"      # phải ra 8 bảng
psql -U catalog_user -d catalog -c "\dv"      # phải có view catalog_product_base
```

`99_crawl_optional.sql` **không cần chạy** — chỉ dùng nếu về sau muốn bật lại
đội worker cào, hoặc mở `/dashboard` bị báo thiếu bảng.

---

## 5. Tạo file `.env`

```bash
cp deploy/.env.example .env
nano .env
```

Bắt buộc điền: `DB_PASSWORD`, `OPENAI_API_KEY`.
Bravo để trống cũng được — code load `mssql` kiểu lazy nên thiếu **không làm chết server**, chỉ là không có giá.

---

## 6. Chạy app

### ⚠️ Đừng dùng `npm run build`

Lệnh này **đang hỏng**, không phải lỗi VPS:
- `tsconfig.json` gom cả `scripts/**` trong khi `rootDir` là `src` → lỗi TS6059
- Bản thân `src/modules/catalog/catalog.routes.ts` còn hàng chục lỗi type (`req.body` kiểu `unknown`)

Vì vậy **không có thư mục `dist`**, và `npm start` sẽ không chạy được.
Cách đúng là chạy thẳng TypeScript bằng `tsx` (bỏ qua type-check):

```bash
node node_modules/tsx/dist/cli.mjs src/server.ts
```

Thấy dòng này là được:

```
[DB] Connected to PostgreSQL OK
🚀 Catalog API running at http://localhost:3001
```

> Dùng `tsx` **không kèm `watch`** cho production. Chế độ `watch` từng bị kẹt
> (chạy vài ngày rồi ngừng nhận thay đổi file, sửa code không ăn) — trên máy
> server không cần watch làm gì.

### Chạy nền

<details>
<summary><b>Linux — systemd</b> (khuyến nghị)</summary>

`/etc/systemd/system/catalog-api.service`:

```ini
[Unit]
Description=Catalog API
After=network.target postgresql.service

[Service]
Type=simple
User=www-data
WorkingDirectory=/đường/dẫn/tới/project
ExecStart=/usr/bin/node node_modules/tsx/dist/cli.mjs src/server.ts
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now catalog-api
sudo systemctl status catalog-api
journalctl -u catalog-api -f      # xem log
```
</details>

<details>
<summary><b>Windows Server — NSSM</b></summary>

```powershell
nssm install CatalogAPI "C:\Program Files\nodejs\node.exe" "node_modules\tsx\dist\cli.mjs src\server.ts"
nssm set CatalogAPI AppDirectory C:\đường\dẫn\project
nssm start CatalogAPI
```
</details>

---

## 7. Kiểm tra

```bash
curl http://localhost:3001/health
# {"status":"ok","service":"catalog-api",...}
```

Mở trình duyệt:

| URL | Phải thấy |
|---|---|
| `http://<ip-vps>:3001/` | Giao diện Chat AI |
| `http://<ip-vps>:3001/fitment-matrix` | Ma trận độ phủ (rỗng vì chưa có data) |
| `http://<ip-vps>:3001/health` | JSON `status: ok` |

Chưa có data nên tra cứu ra rỗng — **đúng như mong đợi** ở bước này.

---

## 8. ⚠️ Bảo mật — làm luôn, đừng lặp lại lỗi cũ

Máy cũ mở thẳng port 3001 ra Internet (`103.214.9.97`) mà **không có xác thực**.
Hậu quả: `POST /api/ai/chat` là proxy OpenAI mở → ai cũng gọi được, tiêu tiền
bằng key của bạn; các route `DELETE /products/:id`, `/vehicles/:id`… cũng gọi
thoải mái.

Ít nhất phải làm một trong hai cách:

**Cách A — chỉ mở qua Nginx (khuyến nghị)**

```bash
# .env
HOST=127.0.0.1      # app không nghe ra ngoài nữa
```

```nginx
server {
    listen 80;
    server_name ten-mien-cua-ban.com;
    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

Rồi bật HTTPS: `sudo certbot --nginx`

**Cách B — chặn bằng firewall**, chỉ cho IP văn phòng vào:

```bash
sudo ufw allow from <IP-văn-phòng> to any port 3001
sudo ufw deny 3001
```

Và nhớ: `CORS_ORIGINS` điền domain thật, đừng để mở toang.

---

## 9. Bước tiếp theo — đẩy data lên

Xong phần khung thì báo tôi, tôi viết script import. Nó sẽ tự nhận diện
**4 định dạng JSON** có trong project:

| Định dạng | File mẫu | Đẩy được gì |
|---|---|---|
| Catalog lồng nhau | `Toyota_CarType1_Model1.json`, `Ford_America_Model1_vi.json` | products + vehicles + fitments (đầy đủ nhất) |
| Part → models | `json-files/fitments-auto-*.json` | products + fitments |
| OEM → vehicles | `fitment_result_*.json` | fitments |
| Odoo export | `data/odoo-export*.json` | products |

Cách dùng dự kiến: quăng hết file JSON vào một thư mục rồi chạy một lệnh —
script tự phân loại, tự gộp trùng qua `oem_norm`, không cần chia tay.

**Cần bạn cho biết**: bộ file JSON đã cào hiện nằm ở đâu (máy này chỉ còn
bản cũ từ tháng 5), để tôi kiểm tra đúng định dạng trước khi viết.
