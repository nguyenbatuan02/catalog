/**
 * bravo.ts
 * Kết nối thẳng SQL Server Bravo để lấy giá bán + tồn kho
 * Stored proc: usp_Vcd_GiaBan_BaoCaoTonKho_api
 */

import { pool as pgPool } from './db.js';

// mssql duoc load dong de khong lam crash server khi chua cai
let sql: any = null;
async function getMssql() {
  if (sql) return sql;
  try {
    const mod = await import('mssql');
    sql = mod.default ?? mod;
    return sql;
  } catch(e: any) {
    console.error('[Bravo] mssql chưa được cài — chạy: npm install mssql');
    return null;
  }
}

// ─── SQL Server config (từ .env) ─────────────────────────────
const SS_CONFIG = {
  server  : process.env.BRAVO_SS_HOST     || '125.212.231.232',
  port    : parseInt(process.env.BRAVO_SS_PORT || '1992'),
  database: process.env.BRAVO_SS_DB       || 'B8_HTAuto_VN',
  user    : process.env.BRAVO_SS_USER     || 'htauto',
  password: process.env.BRAVO_SS_PASSWORD || '',
  options : {
    encrypt        : false,
    trustServerCertificate: true,
    connectTimeout : 10000,
    requestTimeout : 15000,
  },
  pool: {
    max: 5, min: 0, idleTimeoutMillis: 30000,
  },
};

const CACHE_TTL_MIN  = Number(process.env.BRAVO_CACHE_TTL_MIN) || 10;
const DEFAULT_KH     = process.env.BRAVO_DEFAULT_KH || 'KHACHLE-HN-TM';
const DEFAULT_BRANCH = process.env.BRAVO_BRANCH     || 'A01';

// Lazy SQL Server pool
let ssPool: any = null;
async function getSsPool(): Promise<any> {
  const mssql = await getMssql();
  if (!mssql) return null;
  if (ssPool && ssPool.connected) return ssPool;
  try {
    ssPool = await new mssql.ConnectionPool(SS_CONFIG).connect();
    ssPool.on('error', (err: any) => {
      console.error('[Bravo SS] Pool error:', err.message);
      ssPool = null;
    });
    console.log('[Bravo SS] Connected to SQL Server');
    return ssPool;
  } catch(e: any) {
    console.error('[Bravo SS] Không kết nối được SQL Server:', e.message);
    return null;
  }
}

// ─── Types ───────────────────────────────────────────────────
export interface BravoPricing {
  internal_ref  : string;
  price         : number | null;
  in_stock      : boolean | null;
  stock_qty     : number | null;
  unit_bravo    : string | null;
  customer_code : string | null;
  from_cache    : boolean;
}

// ─── Main export ─────────────────────────────────────────────
export async function getBravoPricing(
  internalRefs : string[],
  customerCode?: string | null
): Promise<Record<string, BravoPricing>> {

  if (!internalRefs.length) return {};

  const custKey = customerCode || DEFAULT_KH;
  const result  : Record<string, BravoPricing> = {};
  const needFetch: string[] = [];

  // 1. Check PostgreSQL cache
  const cacheKeys = internalRefs.map(r => `${r}:${custKey}`);
  try {
    const cached = await pgPool.query(`
      SELECT cache_key, price, in_stock, unit_bravo,
             (fetched_at > NOW() - ($2 || ' minutes')::INTERVAL) AS fresh
      FROM catalog_bravo_cache
      WHERE cache_key = ANY($1)
    `, [cacheKeys, CACHE_TTL_MIN]);

    for (const row of cached.rows) {
      if (row.fresh) {
        const ref = row.cache_key.replace(`:${custKey}`, '');
        result[ref] = {
          internal_ref  : ref,
          price         : row.price != null ? Number(row.price) : null,
          in_stock      : row.in_stock,
          stock_qty     : null,
          unit_bravo    : row.unit_bravo,
          customer_code : customerCode || null,
          from_cache    : true,
        };
      }
    }
  } catch(e: any) {
    console.warn('[Bravo] Cache read error:', e.message);
  }

  for (const ref of internalRefs) {
    if (!result[ref]) needFetch.push(ref);
  }

  // 2. Goi SQL Server cho ma chua co cache
  if (needFetch.length > 0) {
    const fetched = await fetchFromSqlServer(needFetch, custKey);
    for (const item of fetched) {
      result[item.internal_ref] = item;

      // Luu cache vao PostgreSQL
      const key = `${item.internal_ref}:${custKey}`;
      try {
        await pgPool.query(`
          INSERT INTO catalog_bravo_cache (cache_key, price, in_stock, unit_bravo, fetched_at)
          VALUES ($1,$2,$3,$4,NOW())
          ON CONFLICT (cache_key) DO UPDATE SET
            price=EXCLUDED.price, in_stock=EXCLUDED.in_stock,
            unit_bravo=EXCLUDED.unit_bravo, fetched_at=NOW()
        `, [key, item.price, item.in_stock, item.unit_bravo]);
      } catch(e: any) {
        console.warn('[Bravo] Cache write error:', e.message);
      }
    }
  }

  // 3. Ma khong tim thay → null
  for (const ref of internalRefs) {
    if (!result[ref]) {
      result[ref] = {
        internal_ref: ref, price: null, in_stock: null,
        stock_qty: null, unit_bravo: null,
        customer_code: customerCode || null, from_cache: false,
      };
    }
  }

  return result;
}

// ─── Goi SQL Server ──────────────────────────────────────────
async function fetchFromSqlServer(
  refs       : string[],
  customerCode: string
): Promise<BravoPricing[]> {

  const results: BravoPricing[] = [];
  const mssql = await getMssql();
  if (!mssql) return results; // mssql chua cai → bo qua, khong crash

  const conn = await getSsPool();
  if (!conn) return results; // khong ket noi duoc → bo qua

  const today = new Date().toISOString().slice(0, 10);

  await Promise.all(refs.map(async (ref) => {
    const refClean = ref.replace(/-(CC|NM|TEST|BH)\s*$/i, '').trim();
    try {
      const req = conn.request();
      req.input('_DocDate2',      mssql.Date,         today);
      req.input('_WarehouseCode', mssql.NVarChar(256), '');
      req.input('_ItemCode',      mssql.NVarChar(256), refClean);
      req.input('_CustomerCode',  mssql.NVarChar(24),  customerCode);
      req.input('_BranchCode',    mssql.VarChar(3),    DEFAULT_BRANCH);
      req.input('_nUserId',       mssql.Int,           0);

      const res  = await req.execute('usp_Vcd_GiaBan_BaoCaoTonKho_api');
      const rows = res.recordset || [];
      // LOG DE DEBUG - xem cot va gia tri tra ve
      if (rows.length > 0) {
        console.log(`[Bravo SS] ref=${ref} → ${rows.length} rows, cols:`, Object.keys(rows[0]));
        console.log(`[Bravo SS] row[0]:`, JSON.stringify(rows[0]).slice(0, 300));
      } else {
        console.log(`[Bravo SS] ref=${ref} → KHONG CO DATA`);
      }
      const row  = rows.find((r: any) =>
        r.ItemCode?.toUpperCase() === refClean.toUpperCase()
      ) || rows[0];

      if (row) {
        const qty   = Number(row.CloseInventory ?? 0);
        const price = Number(row.UnitPrice ?? row.UnitPriceDC ?? row.UnitPrice_t ?? 0);
        results.push({
          internal_ref  : ref,
          price         : price > 0 ? price : null,
          in_stock      : qty > 0,
          stock_qty     : qty,
          unit_bravo    : row.Unit ?? null,
          customer_code : customerCode,
          from_cache    : false,
        });
      }
    } catch(e: any) {
      console.error(`[Bravo SS] Loi ref ${ref}:`, e.message);
    }
  }));

  return results;
}

// ─── Merge pricing vao product list ──────────────────────────
export function mergeWithPricing(
  products: any[],
  pricing : Record<string, BravoPricing>
): any[] {
  return products.map(p => {
    // Uu tien internal_ref, fallback sang oem_code neu khong co gia
    // VD: SE-3991R khong co trong Bravo → fallback sang 45460-09040 (oem_code)
    const prByRef = pricing[p.internal_ref];
    const prByOem = pricing[p.oem_code];
    let pr: any = {};
    if (prByRef && (prByRef.price != null || prByRef.in_stock != null)) {
      pr = prByRef;
    } else if (prByOem && (prByOem.price != null || prByOem.in_stock != null)) {
      pr = prByOem;
    } else {
      pr = prByRef || prByOem || {};
    }
    return {
      ...p,
      price      : pr.price      ?? null,
      in_stock   : pr.in_stock   ?? null,
      stock_qty  : (pr as any).stock_qty ?? null,
      unit_bravo : pr.unit_bravo ?? p.unit,
    };
  });
}

// ─── Helper: lay bravo customer code theo zalo uid ───────────
export async function getBravoCustomerCode(
  zaloUid: string,
  orgId  : string
): Promise<string | null> {
  const res = await pgPool.query(
    `SELECT bravo_customer_code FROM contacts WHERE zalo_uid=$1 AND org_id=$2 LIMIT 1`,
    [zaloUid, orgId]
  );
  return res.rows[0]?.bravo_customer_code || null;
}