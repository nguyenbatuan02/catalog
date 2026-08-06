import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { testConnection } from './shared/db.js';
import { catalogRoutes } from './modules/catalog/catalog.routes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = join(__dirname, '..', 'index.html');
const DASHBOARD_HTML = join(__dirname, '..', 'public', 'dashboard.html');
const FITMENT_MATRIX_HTML = join(__dirname, '..', 'public', 'fitment-matrix.html');

const server = Fastify({
  bodyLimit: 10 * 1024 * 1024, // 10MB — cho phép upload ảnh base64
  logger: {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
    },
  },
});

// ============================================================
// Plugins
// ============================================================
await server.register(helmet, { contentSecurityPolicy: false });
await server.register(cors, {
  origin : (origin: string | undefined, cb: Function) => {
    // Cho phep: localhost, chrome-extension, file://
    if (!origin) return cb(null, true);
    const allowed = [
      /^https?:\/\/localhost/,
      /^chrome-extension:\/\//,
      /^file:\/\//,
    ];
    if (allowed.some(r => r.test(origin))) return cb(null, true);
    // Kiem tra CORS_ORIGINS env
    const envOrigins = (process.env.CORS_ORIGINS || '').split(',').filter(Boolean);
    if (envOrigins.includes(origin)) return cb(null, true);
    cb(null, true); // Dev mode: cho phep tat ca
  },
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
});

// (Coverage endpoints /coverage-summary, /coverage-insufficient nằm trong catalogRoutes.)
// Serve file tĩnh từ thư mục public/ (dashboard HTML) — 1 server duy nhất port 3001, khỏi cần npx serve.
// Từ nay chỉ cần bỏ file .html vào public/ là truy cập được, không cần thêm route thủ công.
// index:false → KHÔNG tự phục vụ index.html ở "/" (giữ route "/" thủ công bên dưới, đọc index.html gốc động).
// Route thủ công (/, /dashboard, /fitment-matrix) là route TƯỜNG MINH nên vẫn ưu tiên hơn wildcard của static.
await server.register(fastifyStatic, {
  root         : join(__dirname, '..', 'public'),
  prefix       : '/',
  decorateReply: false,
  index        : false,
});

// ============================================================
// Giao diện web — phục vụ index.html tại "/"
// Đọc file động mỗi request để sửa index.html không cần restart
// ============================================================
server.get('/', async (_req, reply) => {
  try {
    const html = await readFile(INDEX_HTML, 'utf8');
    return reply.type('text/html; charset=utf-8').send(html);
  } catch (e: any) {
    return reply.status(500).send({ error: 'Không đọc được index.html: ' + e.message });
  }
});

// Dashboard theo dõi tiến độ cào — CHỈ ĐỌC. Đọc file động mỗi request (sửa không cần restart).
// Mở tại: http://<host>:3001/dashboard  hoặc  /dashboard.html
async function serveDashboard(_req: any, reply: any) {
  try {
    const html = await readFile(DASHBOARD_HTML, 'utf8');
    return reply.type('text/html; charset=utf-8').send(html);
  } catch (e: any) {
    return reply.status(500).send({ error: 'Không đọc được dashboard.html: ' + e.message });
  }
}
server.get('/dashboard', serveDashboard);
server.get('/dashboard.html', serveDashboard);

// Dashboard ma trận phủ sóng phụ tùng — phục vụ CÙNG origin với API (port 3001) nên fetch
// tương đối '/api/v1/catalog/fitment-matrix' không dính CORS. Đọc file động mỗi request (sửa không cần restart).
// Mở tại: http://<host>:3001/fitment-matrix  hoặc  /fitment-matrix.html
async function serveFitmentMatrix(_req: any, reply: any) {
  try {
    const html = await readFile(FITMENT_MATRIX_HTML, 'utf8');
    return reply.type('text/html; charset=utf-8').send(html);
  } catch (e: any) {
    return reply.status(500).send({ error: 'Không đọc được fitment-matrix.html: ' + e.message });
  }
}
server.get('/fitment-matrix', serveFitmentMatrix);
server.get('/fitment-matrix.html', serveFitmentMatrix);

// ============================================================
// Health check
// ============================================================
server.get('/health', async () => ({
  status : 'ok',
  service: 'catalog-api',
  version: '1.0.0',
  time   : new Date().toISOString(),
}));

// ============================================================
// Proxy OpenAI — giữ API key an toàn trên server
// ============================================================
server.post('/api/ai/chat', async (req, reply) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return reply.status(500).send({ error: 'OPENAI_API_KEY chưa cấu hình trong .env' });

  const body = req.body as any;
  const res  = await fetch('https://api.openai.com/v1/chat/completions', {
    method : 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body   : JSON.stringify(body),
  });

  const data = await res.json();
  if (!res.ok) return reply.status(res.status).send(data);
  return reply.send(data);
});

// ============================================================
// Proxy OpenAI Vision — đọc VIN từ ảnh (tránh CORS)
// POST /api/ai/vision
// Body: { image_base64: string, image_type: string, prompt?: string }
// ============================================================
server.post('/api/ai/vision', async (req, reply) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return reply.status(500).send({ error: 'OPENAI_API_KEY chưa cấu hình trong .env' });

  const { image_base64, image_type, prompt } = req.body as any;
  if (!image_base64) return reply.status(400).send({ error: 'Thiếu image_base64' });

  const vinPrompt = prompt || (
    'Đây là giấy tờ đăng kiểm xe Việt Nam. Đọc chính xác và trả về đúng định dạng sau, mỗi dòng một trường, dấu hai chấm ngăn cách nhãn và giá trị:\n' +
    'CHASSIS: [chỉ giá trị số khung, VD: RLA00V45W51000059]\n' +
    'ENGINE: [chỉ giá trị số động cơ, VD: 6G74RX6765]\n' +
    'MAKE: [chỉ tên hãng, VD: MITSUBISHI hoặc TOYOTA]\n' +
    'MODEL: [tên dòng xe nếu có, VD: PAJERO hoặc VIOS]\n' +
    'YEAR: [chỉ năm 4 chữ số, VD: 2005]\n' +
    'Lưu ý quan trọng:\n' +
    '- Chỉ lấy phần GIÁ TRỊ sau dấu hai chấm, không lấy nhãn tiếng Việt\n' +
    '- Số khung thường ở dòng "Số khung (Chassis No)"\n' +
    '- Đọc từng ký tự cẩn thận, phân biệt 0/O, 1/I, 5/S\n' +
    '- Chỉ trả về các dòng tìm được, bỏ qua dòng không có'
  );

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method : 'POST',
      headers: {
        'Content-Type' : 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model      : 'gpt-4o',
        max_tokens : 200,
        messages   : [{
          role   : 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:${image_type || 'image/jpeg'};base64,${image_base64}`, detail: 'high' } },
            { type: 'text', text: vinPrompt }
          ]
        }]
      })
    });

    const data = await res.json() as any;
    if (!res.ok) return reply.status(res.status).send(data);

    const text = data.choices?.[0]?.message?.content?.trim() || 'KHONG_TIM_THAY';
    return reply.send({ text });
  } catch(e: any) {
    return reply.status(500).send({ error: e.message });
  }
});

// ============================================================
// VIN LOOKUP — Partsouq via fetch
// ============================================================
server.get<{ Querystring: { vin: string } }>('/api/v1/catalog/vin/lookup', async (req, reply) => {
  const { vin } = req.query;
  if (!vin || vin.length < 12) return reply.status(400).send({ error: 'VIN phải có ít nhất 12 ký tự' });
  try {
    const { lookupVin } = await import('./modules/catalog/vin-lookup.js');
    return reply.send(await lookupVin(vin));
  } catch(e: any) {
    return reply.status(500).send({ error: e.message });
  }
});

// VIN cache-check — CHI doc DB, KHONG goi Partsouq (dung cho doc anh VIN)
server.get<{ Querystring: { vin: string } }>('/api/v1/catalog/vin/cache-check', async (req, reply) => {
  const { vin } = req.query;
  if (!vin || vin.length < 10) return reply.status(400).send({ error: 'VIN không hợp lệ' });
  try {
    const { pool } = await import('./shared/db.js');
    const vinClean  = vin.trim().toUpperCase();
    const vinPrefix = vinClean.slice(0, 12);
    const res = await pool.query(
      `SELECT * FROM catalog_vin_cache
       WHERE vin_full = $1 OR vin_prefix = $2
       ORDER BY (vin_full = $1) DESC LIMIT 5`,
      [vinClean, vinPrefix]
    );
    if (res.rows.length > 0) {
      return reply.send({ found: true, vehicles: res.rows });
    }
    return reply.send({ found: false, vehicles: [] });
  } catch(e: any) {
    return reply.status(500).send({ error: e.message });
  }
});

// VIN save manual — luu VIN thu cong (1 model)
server.post<{ Body: { vin:string; model_code:string; make:string; model_name:string; year?:number } }>(
  '/api/v1/catalog/vin/save-manual', async (req, reply) => {
  const { vin, model_code, make, model_name, year } = req.body;
  if (!vin || !model_code) return reply.status(400).send({ error: 'Thiếu vin hoặc model_code' });
  try {
    const { saveVinManual } = await import('./modules/catalog/vin-lookup.js');
    await saveVinManual(vin, model_code, make||'Toyota', model_name||'', year||null);
    return reply.send({ ok: true, message: `Đã lưu VIN ${vin} → ${model_code}` });
  } catch(e: any) {
    return reply.status(500).send({ error: e.message });
  }
});

// VIN status — luong VIN gio dung extension PartSouq truc tiep tu trang chat
server.get('/api/v1/catalog/vin/status', async (req, reply) => {
  return reply.send({ extension_connected: true, mode: 'partsouq-direct' });
});

// VIN save — extension PartSouq nop ket qua scrape VIN
// Body: { vin, vehicles | models: [...] }
server.post<{ Body: { vin: string; vehicles?: any[]; models?: any[] } }>(
  '/api/v1/catalog/vin/save', async (req, reply) => {
  const { vin } = req.body;
  const list = req.body.vehicles || req.body.models || [];
  if (!vin) return reply.status(400).send({ error: 'Thiếu vin' });
  if (!Array.isArray(list) || list.length === 0) {
    return reply.send({ ok: true, saved: 0, note: 'Không có xe nào' });
  }
  try {
    // Chuan hoa field — extension PartSouq co the tra modelCode/model
    const vehicles = list.map((v: any) => ({
      model_code: v.model_code || v.modelCode || '',
      make      : v.make || 'Toyota',
      model_name: v.model_name || v.model || '',
      year      : v.year || (v.prodPeriod ? parseInt(String(v.prodPeriod).match(/\d{4}/)?.[0] || '') || null : null),
      vehicle_id: null,
    }));
    const { saveVinFromExtension } = await import('./modules/catalog/vin-lookup.js');
    const matched = await saveVinFromExtension(vin, vehicles);
    return reply.send({ ok: true, saved: matched.length, vehicles: matched });
  } catch(e: any) {
    server.log.error('[vin/save] ' + e.message);
    return reply.status(500).send({ error: e.message });
  }
});

// ============================================================
// FITMENT — nhận dữ liệu model xe từ toyodiy extension
// POST /api/v1/catalog/fitments/import
// Body: { part_code, part_name, models: [{model_code, model_name, date_from, date_to, options}] }
// ============================================================
server.post('/api/v1/catalog/fitments/import', async (req, reply) => {
  const body = req.body as any;
  const { part_code, part_name, models } = body;

  if (!part_code) return reply.status(400).send({ error: 'Thiếu part_code' });
  if (!models || !Array.isArray(models) || models.length === 0) {
    return reply.status(400).send({ error: 'Không có model nào' });
  }

  try {
    const { pool } = await import('./shared/db.js');

    // Tim san pham theo internal_ref hoac oem_code
    const codeUp = part_code.trim().toUpperCase();
    let prodRes = await pool.query(
      `SELECT id, name FROM catalog_product_base
       WHERE UPPER(internal_ref) = $1 OR UPPER(oem_code) = $1
          OR REPLACE(UPPER(internal_ref),'-','') = REPLACE($1,'-','')
          OR REPLACE(UPPER(oem_code),'-','') = REPLACE($1,'-','')
       LIMIT 1`,
      [codeUp]
    );

    let productId: number;
    if (prodRes.rows.length > 0) {
      productId = prodRes.rows[0].id;
    } else {
      // Tao san pham moi neu chua co
      const ins = await pool.query(
        `INSERT INTO catalog_product_base (name, internal_ref, oem_code, is_for_sale)
         VALUES ($1, $2, $2, TRUE) RETURNING id`,
        [part_name || part_code, part_code]
      );
      productId = ins.rows[0].id;
    }

    let vehiclesCreated = 0;
    let fitmentsCreated = 0;
    let fitmentsSkipped = 0;

    for (const m of models) {
      const modelCode = (m.model_code || '').trim().toUpperCase();
      if (!modelCode) continue;

      // Parse nam tu date_from / date_to (dang MM/YYYY)
      const yearFrom = parseYear(m.date_from);
      const yearTo   = parseYear(m.date_to);

      // Tim vehicle theo model_code
      let vehRes = await pool.query(
        `SELECT id FROM catalog_vehicles WHERE UPPER(model_code) = $1 LIMIT 1`,
        [modelCode]
      );

      let vehicleId: number;
      if (vehRes.rows.length > 0) {
        vehicleId = vehRes.rows[0].id;
      } else {
        // Tao vehicle moi
        const insV = await pool.query(
          `INSERT INTO catalog_vehicles (make, model_name, model_code, year_from, year_to)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (make, model_code, variant_key) DO UPDATE SET model_name = EXCLUDED.model_name
           RETURNING id`,
          ['Toyota', m.model_name || '', modelCode, yearFrom, yearTo]
        );
        vehicleId = insV.rows[0].id;
        vehiclesCreated++;
      }

      // Tao fitment (tranh trung)
      const fitExist = await pool.query(
        `SELECT id FROM catalog_fitments WHERE product_id = $1 AND vehicle_id = $2 LIMIT 1`,
        [productId, vehicleId]
      );
      if (fitExist.rows.length === 0) {
        const insF = await pool.query(
          `INSERT INTO catalog_fitments (product_id, vehicle_id) VALUES ($1, $2)
           ON CONFLICT (product_id, vehicle_id) DO NOTHING
           RETURNING id`,
          [productId, vehicleId]
        );
        if (insF.rows.length > 0) fitmentsCreated++;
        else fitmentsSkipped++;
      } else {
        fitmentsSkipped++;
      }
    }

    server.log.info(`[Fitment] ${part_code}: +${fitmentsCreated} fitment, +${vehiclesCreated} xe moi`);

    return reply.send({
      ok: true,
      product_id: productId,
      vehicles_created: vehiclesCreated,
      fitments_created: fitmentsCreated,
      fitments_skipped: fitmentsSkipped,
    });
  } catch(e: any) {
    server.log.error('[Fitment] Lỗi:', e.message);
    return reply.status(500).send({ error: e.message });
  }
});

// Helper: parse "MM/YYYY" hoac "YYYY" → nam
function parseYear(s: string | undefined): number | null {
  if (!s) return null;
  const m = String(s).match(/(\d{4})/);
  return m ? parseInt(m[1]) : null;
}

// ============================================================
// ĐƠN HÀNG — tạo đơn chốt sale
// POST /api/v1/catalog/orders
// ============================================================
server.post('/api/v1/catalog/orders', async (req, reply) => {
  const body = req.body as any;
  const { customer_name, customer_phone, address, note, items, total } = body;

  if (!customer_name || !customer_phone) {
    return reply.status(400).send({ error: 'Thiếu tên hoặc SĐT khách hàng' });
  }
  if (!items || !Array.isArray(items) || items.length === 0) {
    return reply.status(400).send({ error: 'Đơn hàng không có sản phẩm' });
  }

  try {
    const { pool } = await import('./shared/db.js');

    // Tao ma don: DH + YYMMDD + 4 so random
    const now = new Date();
    const ymd = now.toISOString().slice(2,10).replace(/-/g,'');
    const rand = Math.floor(1000 + Math.random() * 9000);
    const orderCode = `DH${ymd}${rand}`;

    // Tao bang neu chua co
    await pool.query(`
      CREATE TABLE IF NOT EXISTS catalog_orders (
        id            SERIAL PRIMARY KEY,
        order_code    TEXT UNIQUE NOT NULL,
        customer_name TEXT NOT NULL,
        customer_phone TEXT NOT NULL,
        address       TEXT,
        note          TEXT,
        items         JSONB NOT NULL,
        total         NUMERIC(18,2),
        status        TEXT DEFAULT 'new',
        created_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      INSERT INTO catalog_orders
        (order_code, customer_name, customer_phone, address, note, items, total)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
    `, [orderCode, customer_name, customer_phone, address||'', note||'',
        JSON.stringify(items), total||0]);

    server.log.info(`[Order] Tạo đơn ${orderCode} — ${customer_name} — ${(total||0).toLocaleString('vi-VN')}đ`);

    return reply.send({
      ok: true,
      order_code: orderCode,
      message: `Đã tạo đơn hàng ${orderCode}`,
    });
  } catch(e: any) {
    server.log.error('[Order] Lỗi:', e.message);
    return reply.status(500).send({ error: e.message });
  }
});

// Danh sach don hang
server.get('/api/v1/catalog/orders', async (req, reply) => {
  try {
    const { pool } = await import('./shared/db.js');
    const res = await pool.query(`
      SELECT * FROM catalog_orders ORDER BY created_at DESC LIMIT 50
    `);
    return reply.send({ orders: res.rows });
  } catch(e: any) {
    return reply.status(500).send({ error: e.message });
  }
});

// ============================================================
// PARTS — extension PartSouq tra mã → xe tương thích
// GET  /api/v1/catalog/parts/lookup?part=XXX  → {vehicles:[...]}
// POST /api/v1/catalog/parts/save  body {partNumber, brand, vehicles}
// ============================================================
server.get<{ Querystring: { part: string } }>(
  '/api/v1/catalog/parts/lookup', async (req, reply) => {
  const part = (req.query.part || '').trim();
  if (!part) return reply.status(400).send({ error: 'Thiếu mã phụ tùng' });

  try {
    const { pool } = await import('./shared/db.js');
    const codeUp = part.toUpperCase();

    // Tìm sản phẩm
    const prod = await pool.query(
      `SELECT id FROM catalog_product_base
       WHERE UPPER(internal_ref)=$1 OR UPPER(oem_code)=$1
          OR REPLACE(UPPER(internal_ref),'-','')=REPLACE($1,'-','')
          OR REPLACE(UPPER(oem_code),'-','')=REPLACE($1,'-','')
       LIMIT 1`, [codeUp]);

    if (prod.rows.length === 0) {
      return reply.send({ vehicles: [] });
    }

    // Lấy xe tương thích
    const veh = await pool.query(
      `SELECT v.make, v.model_name AS model, v.model_code AS "modelCode",
              v.year_from, v.year_to
       FROM catalog_fitments f
       JOIN catalog_vehicles v ON v.id = f.vehicle_id
       WHERE f.product_id = $1
       ORDER BY v.model_name`, [prod.rows[0].id]);

    return reply.send({ vehicles: veh.rows });
  } catch(e: any) {
    server.log.error('[parts/lookup] ' + e.message);
    return reply.status(500).send({ error: e.message });
  }
});

server.post<{ Body: { partNumber: string; brand?: string; vehicles: any[] } }>(
  '/api/v1/catalog/parts/save', async (req, reply) => {
  const { partNumber, vehicles } = req.body;
  if (!partNumber) return reply.status(400).send({ error: 'Thiếu partNumber' });
  if (!vehicles || !Array.isArray(vehicles) || vehicles.length === 0) {
    return reply.send({ ok: true, saved: 0, note: 'Không có xe nào' });
  }

  try {
    const { pool } = await import('./shared/db.js');
    const codeUp = partNumber.trim().toUpperCase();

    // Tìm/tạo sản phẩm
    let prod = await pool.query(
      `SELECT id FROM catalog_product_base
       WHERE UPPER(internal_ref)=$1 OR UPPER(oem_code)=$1
          OR REPLACE(UPPER(internal_ref),'-','')=REPLACE($1,'-','')
          OR REPLACE(UPPER(oem_code),'-','')=REPLACE($1,'-','')
       LIMIT 1`, [codeUp]);

    let productId: any;
    if (prod.rows.length > 0) {
      productId = prod.rows[0].id;
    } else {
      const ins = await pool.query(
        `INSERT INTO catalog_product_base (name, internal_ref, oem_code, is_for_sale)
         VALUES ($1, $2, $2, TRUE) RETURNING id`,
        [partNumber, partNumber]);
      productId = ins.rows[0].id;
    }

    let fitCreated = 0, vehCreated = 0;

    for (const v of vehicles) {
      const make      = (v.make || 'Unknown').trim();
      const modelName = (v.model || '').trim();
      const modelCode = (v.modelCode || '').trim().toUpperCase();
      if (!modelCode && !modelName) continue;

      // Parse năm từ prodPeriod (vd "2015-2020" hoặc "08/2017-")
      let yearFrom: number | null = null, yearTo: number | null = null;
      if (v.prodPeriod) {
        const yrs = String(v.prodPeriod).match(/\d{4}/g);
        if (yrs && yrs.length) {
          yearFrom = parseInt(yrs[0]);
          yearTo   = yrs.length > 1 ? parseInt(yrs[1]) : parseInt(yrs[0]);
        }
      }

      // Tìm/tạo xe — dùng model_code nếu có, không thì model_name
      const codeKey = modelCode || modelName.toUpperCase();
      let veh = await pool.query(
        `SELECT id FROM catalog_vehicles WHERE UPPER(model_code)=$1 LIMIT 1`,
        [codeKey]);

      let vehicleId: any;
      if (veh.rows.length > 0) {
        vehicleId = veh.rows[0].id;
      } else {
        const insV = await pool.query(
          `INSERT INTO catalog_vehicles (make, model_name, model_code, year_from, year_to)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (make, model_code, variant_key) DO UPDATE SET model_name=EXCLUDED.model_name
           RETURNING id`,
          [make, modelName, codeKey, yearFrom, yearTo]);
        vehicleId = insV.rows[0].id;
        vehCreated++;
      }

      // Tạo fitment
      const insF = await pool.query(
        `INSERT INTO catalog_fitments (product_id, vehicle_id) VALUES ($1,$2)
         ON CONFLICT (product_id, vehicle_id) DO NOTHING RETURNING id`,
        [productId, vehicleId]);
      if (insF.rows.length > 0) fitCreated++;
    }

    server.log.info(`[parts/save] ${partNumber}: +${fitCreated} fitment, +${vehCreated} xe`);
    return reply.send({ ok: true, product_id: productId,
      fitments_created: fitCreated, vehicles_created: vehCreated });
  } catch(e: any) {
    server.log.error('[parts/save] ' + e.message);
    return reply.status(500).send({ error: e.message });
  }
});

// ============================================================
// Routes — prefix /api/v1/catalog
// ============================================================
await server.register(catalogRoutes, { prefix: '/api/v1/catalog' });

// ============================================================
// Start
// ============================================================
const PORT = Number(process.env.PORT) || 3001;
const HOST = process.env.HOST || '0.0.0.0';

try {
  await testConnection();
  await server.listen({ port: PORT, host: HOST });
  console.log(`\n🚀 Catalog API running at http://localhost:${PORT}`);
  console.log(`📖 Endpoints: http://localhost:${PORT}/api/v1/catalog/`);
  console.log(`❤️  Health:    http://localhost:${PORT}/health\n`);
} catch (err) {
  server.log.error(err);
  process.exit(1);
}