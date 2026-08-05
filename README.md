# Catalog API

Service API độc lập quản lý catalog phụ tùng ô tô.  
ZaloCRM gọi vào đây để tra cứu sản phẩm + lấy giá từ Bravo.

---

## Cài đặt và chạy

```bash
# 1. Cài dependencies
npm install

# 2. Tạo file .env
cp .env.example .env
# Điền DB_HOST, DB_PASSWORD, JWT_SECRET, BRAVO_API_URL, BRAVO_API_KEY

# 3. Chạy schema SQL trong pgAdmin (cùng DB với ZaloCRM)
# File: prisma/catalog-schema.sql

# 4. Import dữ liệu từ Odoo
npm run import -- --file ./data/odoo-export.json

# 5. Chạy dev
npm run dev

# 6. Build production
npm run build && npm start
```

---

## Endpoints

| Method | Path | Mô tả |
|--------|------|-------|
| GET | `/health` | Health check |
| GET | `/api/v1/catalog/stats` | Thống kê tổng quan |
| GET | `/api/v1/catalog/products` | Danh sách sản phẩm (có filter + phân trang) |
| GET | `/api/v1/catalog/products/:id` | Chi tiết sản phẩm + giá Bravo |
| POST | `/api/v1/catalog/products` | Tạo sản phẩm mới |
| PATCH | `/api/v1/catalog/products/:id` | Cập nhật sản phẩm |
| DELETE | `/api/v1/catalog/products/:id` | Xóa sản phẩm |
| GET | `/api/v1/catalog/vehicles` | Danh sách model xe |
| POST | `/api/v1/catalog/vehicles` | Thêm model xe |
| PATCH | `/api/v1/catalog/vehicles/:id` | Sửa model xe |
| DELETE | `/api/v1/catalog/vehicles/:id` | Xóa model xe |
| GET | `/api/v1/catalog/fitments` | Toàn bộ fitments |
| POST | `/api/v1/catalog/products/:id/fitments` | Gắn xe vào sản phẩm |
| DELETE | `/api/v1/catalog/fitments/:id` | Xóa fitment |
| POST | `/api/v1/catalog/products/:id/alternatives` | Thêm sản phẩm thay thế |
| DELETE | `/api/v1/catalog/alternatives/:id` | Xóa thay thế |
| GET | `/api/v1/catalog/search/by-code` | **AI** Tra theo mã |
| GET | `/api/v1/catalog/search/by-vin` | **AI** Tra theo VIN |
| GET | `/api/v1/catalog/search/by-model` | **AI** Tra theo dòng xe |

---

## Kết nối từ ZaloCRM

Trong file `.env` của ZaloCRM:
```env
CATALOG_API_URL=http://localhost:3001/api/v1/catalog
```

ZaloCRM gọi sang:
```typescript
const res = await fetch(`${process.env.CATALOG_API_URL}/search/by-code?code=04371-0K060&customer_code=KH-001`);
const data = await res.json();
```

---

## Cấu trúc project

```
catalog-api/
├── src/
│   ├── server.ts                    ← Entry point
│   ├── shared/
│   │   ├── db.ts                    ← PostgreSQL pool
│   │   └── bravo.ts                 ← Bravo API + cache
│   └── modules/catalog/
│       └── catalog.routes.ts        ← Toàn bộ routes
├── scripts/
│   └── import-catalog.ts            ← Import JSON từ Odoo
├── prisma/
│   └── catalog-schema.sql           ← Chạy 1 lần trong pgAdmin
├── .env.example
├── package.json
└── tsconfig.json
```
