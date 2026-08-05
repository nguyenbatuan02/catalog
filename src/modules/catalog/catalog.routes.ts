/**
 * catalog.routes.ts — OPTIMIZED
 * Thay the query qua VIEW bang query thang catalog_products
 * - Bo correlated subquery compatible_vehicles / alternatives khoi search
 * - Chi load compatible_vehicles khi GET /products/:id (detail)
 * - Them index hint cho by-model
 */

import { FastifyInstance } from 'fastify';
import { pool } from '../../shared/db.js';
import { runCoverageCheck } from './coverage-check.js';
import { getBravoPricing, mergeWithPricing } from '../../shared/bravo.js';

// ============================================================
// HELPERS dung chung
// ============================================================

// Cac cot can thiet cho search — KHONG include compatible_vehicles / alternatives
// De tranh 2 correlated subquery cua VIEW chay cho moi san pham
const PRODUCT_COLS = `
  p.id, p.name, p.internal_ref, p.oem_code, p.is_for_sale,
  p.product_type, p.brand, p.unit, p.notes, p.created_at, p.updated_at
`.trim();

// Load compatible_vehicles cho 1 product (chi dung trong detail)
async function loadCompatibleVehicles(productId: string): Promise<any[]> {
  const res = await pool.query(`
    SELECT v.make, v.model_code, v.model_name, v.year_from, v.year_to
    FROM catalog_fitments f
    JOIN catalog_vehicles v ON v.id = f.vehicle_id
    WHERE f.product_id = $1
    ORDER BY v.make, v.model_code
  `, [productId]);
  return res.rows;
}

// Load alternatives cho 1 product
async function loadAlternatives(productId: string): Promise<any[]> {
  const res = await pool.query(`
    SELECT alt.id, alt.name, alt.internal_ref, alt.oem_code,
           alt.product_type, ca.reason
    FROM catalog_alternatives ca
    JOIN catalog_products alt ON alt.id = ca.alt_product_id
    WHERE ca.product_id = $1
  `, [productId]);
  return res.rows;
}

// ============================================================
// FITMENT MATRIX — ma tran phu song phu tung theo model xe (cho dashboard)
// ============================================================
// [alias tra ve, bieu thuc boolean khop tren catalog_products p]. Thu tu = thu tu field
// trong response. Sinh SQL tu 1 mang nay de danh sach tag (CTE prod) va danh sach BOOL_OR
// KHONG bao gio lech nhau khi them/bot danh muc.
// LUU Y ve pattern (co the chinh lai theo nghiep vu):
//   - 'abs': da them "AND NOT ILIKE '%absorber%'" de KHONG dinh nham "shock absorber" (giam_soc).
//   - 'curoa_phu' KHONG co trong spec goc → dung heuristic (day curoa phu: quat/alternator/A-C/accessory).
//   - 'cam_bien' rat rong ('%sensor%','%switch%') → gan nhu xe nao cung true; 'loc_lanh' map sang compressor.
const MATRIX_CATEGORIES: [string, string][] = [
  ['piston',          `LOWER(p.name) ILIKE ANY(ARRAY['%piston%'])`],
  ['sec_mang',        `LOWER(p.name) ILIKE ANY(ARRAY['%ring set%','%piston ring%']) OR LOWER(COALESCE(p.name_vi,'')) ILIKE '%séc măng%'`],
  ['bien_balie',      `LOWER(p.name) ILIKE ANY(ARRAY['%connecting rod%','%con rod%']) OR LOWER(COALESCE(p.name_vi,'')) ILIKE ANY(ARRAY['%biên%','%balie%'])`],
  ['gioang_dai_tu',   `LOWER(p.name) ILIKE ANY(ARRAY['%gasket kit%','%overhaul%'])`],
  ['loc_dau',         `LOWER(p.name) ILIKE ANY(ARRAY['%oil filter%','%filter, oil%'])`],
  ['loc_nhien_lieu',  `LOWER(p.name) ILIKE ANY(ARRAY['%fuel filter%','%filter, fuel%'])`],
  ['loc_gio',         `LOWER(p.name) ILIKE ANY(ARRAY['%air filter%','%filter, air%','%air cleaner%'])`],
  ['bom_dau',         `LOWER(p.name) ILIKE ANY(ARRAY['%oil pump%','%pump, oil%'])`],
  ['bom_nuoc',        `LOWER(p.name) ILIKE ANY(ARRAY['%water pump%','%pump, water%'])`],
  ['bugi',            `LOWER(p.name) ILIKE ANY(ARRAY['%spark plug%','%plug, spark%'])`],
  ['mobin',           `LOWER(p.name) ILIKE ANY(ARRAY['%ignition coil%','%coil, ignition%'])`],
  ['kim_phun',        `LOWER(p.name) ILIKE ANY(ARRAY['%injector%','%injection nozzle%'])`],
  ['bom_nhien_lieu',  `LOWER(p.name) ILIKE ANY(ARRAY['%fuel pump%','%pump, fuel%'])`],
  ['turbo',           `LOWER(p.name) ILIKE ANY(ARRAY['%turbo%','%turbocharger%'])`],
  ['curoa_cam',       `LOWER(p.name) ILIKE ANY(ARRAY['%timing belt%','%cam belt%','%belt, timing%'])`],
  ['curoa_tong',      `LOWER(p.name) ILIKE ANY(ARRAY['%v-belt%','%drive belt%']) AND LOWER(p.name) NOT ILIKE '%timing%'`],
  ['curoa_phu',       `LOWER(p.name) ILIKE ANY(ARRAY['%fan belt%','%accessory belt%','%alternator belt%','%a/c belt%']) AND LOWER(p.name) NOT ILIKE '%timing%'`],
  ['bi_tang_cam',     `LOWER(p.name) ILIKE ANY(ARRAY['%tensioner%','%idler%']) AND LOWER(p.name) ILIKE ANY(ARRAY['%timing%','%cam%','%belt%'])`],
  ['ket_nuoc',        `LOWER(p.name) ILIKE '%radiator%'`],
  ['ket_mat_dau',     `LOWER(p.name) ILIKE ANY(ARRAY['%oil cooler%','%cooler, oil%'])`],
  ['mo_to_quat',      `LOWER(p.name) ILIKE ANY(ARRAY['%fan motor%','%motor, fan%','%cooling fan%'])`],
  ['may_phat',        `LOWER(p.name) ILIKE ANY(ARRAY['%alternator%','%generator%'])`],
  ['may_de',          `LOWER(p.name) ILIKE ANY(ARRAY['%starter%','%starting motor%'])`],
  ['hop_so',          `LOWER(p.name) ILIKE ANY(ARRAY['%transmission%','%gearbox%','%transaxle%'])`],
  ['cay_lap',         `LOWER(p.name) ILIKE ANY(ARRAY['%drive shaft%','%axle shaft%','%half shaft%'])`],
  ['bi_lap_moay_o',   `LOWER(p.name) ILIKE ANY(ARRAY['%hub bearing%','%wheel bearing%'])`],
  ['dia_con_ban_ep',  `LOWER(p.name) ILIKE ANY(ARRAY['%clutch disc%','%pressure plate%','%release bearing%'])`],
  ['tong_con',        `LOWER(p.name) ILIKE ANY(ARRAY['%clutch master%','%master cylinder, clutch%'])`],
  ['loc_dau_hop_so',  `LOWER(p.name) ILIKE ANY(ARRAY['%oil filter%']) AND LOWER(p.name) ILIKE ANY(ARRAY['%transm%','%gear%','%atf%'])`],
  ['truc_cac_dang',   `LOWER(p.name) ILIKE '%propeller shaft%' OR LOWER(p.name) ILIKE '%prop shaft%'`],
  ['cau_sau',         `LOWER(p.name) ILIKE ANY(ARRAY['%differential%','%rear axle%'])`],
  ['giam_soc',        `LOWER(p.name) ILIKE ANY(ARRAY['%shock absorber%','%strut%','%damper%'])`],
  ['lo_xo',           `LOWER(p.name) ILIKE ANY(ARRAY['%coil spring%','%spring, coil%'])`],
  ['cang_a',          `LOWER(p.name) ILIKE ANY(ARRAY['%control arm%','%lower arm%','%upper arm%'])`],
  ['ro_tuyn_can_bang',`LOWER(p.name) ILIKE ANY(ARRAY['%stabilizer link%','%sway bar link%'])`],
  ['ma_phanh',        `LOWER(p.name) ILIKE ANY(ARRAY['%brake pad%','%pad kit%'])`],
  ['dia_phanh',       `LOWER(p.name) ILIKE ANY(ARRAY['%brake disc%','%brake rotor%'])`],
  ['guoc_phanh',      `LOWER(p.name) ILIKE ANY(ARRAY['%brake shoe%','%shoe, brake%'])`],
  ['tong_phanh',      `LOWER(p.name) ILIKE '%master cylinder%' AND LOWER(p.name) NOT ILIKE '%clutch%'`],
  ['abs',             `LOWER(p.name) ILIKE ANY(ARRAY['%abs%','%anti-lock%','%actuator, brake%']) AND LOWER(p.name) NOT ILIKE '%absorber%'`],
  ['thuoc_lai',       `LOWER(p.name) ILIKE ANY(ARRAY['%steering rack%','%rack assy%','%gear assy, rack%'])`],
  ['ro_tuyn_lai',     `LOWER(p.name) ILIKE ANY(ARRAY['%tie rod%','%tie-rod%','%rack end%'])`],
  ['bom_tro_luc',     `LOWER(p.name) ILIKE ANY(ARRAY['%power steering pump%','%vane pump%'])`],
  ['loc_lanh',        `LOWER(p.name) ILIKE '%compressor%' AND LOWER(p.name) NOT ILIKE '%ac compressor%'`],
  ['dan_nong',        `LOWER(p.name) ILIKE '%condenser%'`],
  ['dan_lanh',        `LOWER(p.name) ILIKE '%evaporator%'`],
  ['ac_quy',          `LOWER(p.name) ILIKE '%battery%'`],
  ['den_chieu_sang',  `LOWER(p.name) ILIKE ANY(ARRAY['%headlamp%','%headlight%','%tail lamp%','%fog lamp%','%bulb%'])`],
  ['cam_bien',        `LOWER(p.name) ILIKE ANY(ARRAY['%sensor%','%switch%'])`],
  ['tui_khi',         `LOWER(p.name) ILIKE ANY(ARRAY['%airbag%','%air bag%'])`],
];

// Xay SQL 1 lan luc load module (khong dung lai moi request). Chien luoc toi uu (cung ket qua,
// nhanh hon nhieu so voi "match tung dong fitment"):
//   1) CTE page: phan trang XE truoc → chi tong hop dung co trang (LIMIT), khong quet toan bo.
//   2) CTE prod: tag moi SAN PHAM DISTINCT dung 1 lan (cac bien the cung model dung chung phan lon
//      phu tung → so san pham distinct nho hon nhieu so voi so dong fitment).
//   3) BOOL_OR(prod.x) gop theo xe. total_parts = so product distinct/xe; total = tong xe khop filter.
const FITMENT_MATRIX_SQL = (() => {
  const prodTags = MATRIX_CATEGORIES.map(([a, e]) => `      (${e}) AS ${a}`).join(',\n');
  const boolAgg  = MATRIX_CATEGORIES.map(([a]) => `    BOOL_OR(prod.${a}) AS ${a}`).join(',\n');
  return `
    WITH page AS (
      SELECT id, model_code, model_name, make, year_from, year_to
      FROM catalog_vehicles
      WHERE make = $1 AND ($2::text IS NULL OR model_name ILIKE '%' || $2 || '%')
      ORDER BY model_name, model_code, year_from, id
      LIMIT $3 OFFSET $4
    ),
    pf AS (
      SELECT DISTINCT vehicle_id, product_id
      FROM catalog_fitments
      WHERE vehicle_id IN (SELECT id FROM page)
    ),
    prod AS (
      SELECT p.id,
${prodTags}
      FROM catalog_products p
      WHERE p.id IN (SELECT product_id FROM pf)
    )
    SELECT
      pg.model_code, pg.model_name, pg.make, pg.year_from, pg.year_to,
      COUNT(pf.product_id)::int AS total_parts,
      -- coverage_score của model_line (crawl job). JOIN theo model_name (= crawl_jobs.model_line), KHÔNG phải model_code.
      (SELECT cj.coverage_score FROM catalog_crawl_jobs cj
        WHERE cj.make = pg.make AND cj.model_line = pg.model_name AND cj.status = 'done'
        ORDER BY cj.coverage_checked_at DESC NULLS LAST LIMIT 1) AS coverage_score,
${boolAgg},
      (SELECT COUNT(*) FROM catalog_vehicles v
        WHERE v.make = $1 AND ($2::text IS NULL OR v.model_name ILIKE '%' || $2 || '%')) AS total
    FROM page pg
    LEFT JOIN pf   ON pf.vehicle_id = pg.id
    LEFT JOIN prod ON prod.id = pf.product_id
    GROUP BY pg.id, pg.model_code, pg.model_name, pg.make, pg.year_from, pg.year_to
    ORDER BY pg.model_name, pg.model_code, pg.year_from, pg.id`;
})();

export async function catalogRoutes(fastify: FastifyInstance) {

  function getAllRefs(rows: any[]): string[] {
    const refs = new Set<string>();
    for (const r of rows) {
      if (r.internal_ref) refs.add(r.internal_ref);
      if (r.oem_code && r.oem_code !== r.internal_ref) refs.add(r.oem_code);
      for (const alt of (r.alternatives || [])) {
        if (alt.internal_ref) refs.add(alt.internal_ref);
        if (alt.oem_code && alt.oem_code !== alt.internal_ref) refs.add(alt.oem_code);
      }
    }
    return [...refs];
  }

  function chuanHoaChinhTa(s: string): string {
    let t = s.toLowerCase();
    const cap: [string, string][] = [
      ['giảm xóc', 'giảm sóc'],
      ['giam xoc', 'giam soc'],
      ['bố thắng', 'má phanh'],
      ['bo thang', 'ma phanh'],
      ['thắng', 'phanh'],
      ['sin ', 'phớt '],
    ];
    for (const [from, to] of cap) t = t.split(from).join(to);
    return t.trim();
  }

  async function resolvePartName(partNameRaw: string): Promise<string[]> {
    const partName = chuanHoaChinhTa(partNameRaw);
    const res = await pool.query(`
      SELECT DISTINCT product_name FROM catalog_synonyms
      WHERE lower(synonym) = lower($1) OR lower(synonym) ILIKE $2 LIMIT 10
    `, [partName, `%${partName}%`]);
    const names = res.rows.map((r:any) => r.product_name);
    const res2 = await pool.query(`
      SELECT DISTINCT synonym FROM catalog_synonyms
      WHERE lower(product_name) = lower($1) OR lower(product_name) ILIKE $2 LIMIT 10
    `, [partName, `%${partName}%`]);
    const syns = res2.rows.map((r:any) => r.synonym);
    return [...new Set([partName, ...names, ...syns])];
  }

  // Tim san pham thay the theo oem — query thang catalog_products, khong qua VIEW
  async function findAlternativesByOem(results: any[]): Promise<any[]> {
    if (!results.length) return [];
    const oemCodes = [...new Set(results.map((r:any) => r.oem_code).filter(Boolean))];
    if (!oemCodes.length) return [];
    const existingIds = results.map((r:any) => r.id);
    const res = await pool.query(`
      SELECT DISTINCT ON (name) ${PRODUCT_COLS}
      FROM catalog_products p
      WHERE p.oem_code = ANY($1::text[])
        AND p.id != ALL($2::uuid[])
        AND p.is_for_sale = TRUE
      ORDER BY name, internal_ref
      LIMIT 5
    `, [oemCodes, existingIds]);
    return res.rows;
  }

  async function fallbackByName(partName: string, customerCode?: string) {
    const allNames = await resolvePartName(partName);
    const nameConditions = allNames.map((_:string, i:number) => `unaccent_immutable(p.name) ILIKE unaccent_immutable($${i+2})`).join(' OR ');
    const params = [partName, ...allNames.map(n => `%${n}%`)];   // $1=partName (cho sim ORDER BY), $2..=%name% (ILIKE)
    const rows = (await pool.query(`
      SELECT ${PRODUCT_COLS},
             similarity(unaccent(p.name), unaccent($1)) AS sim
      FROM catalog_products p
      WHERE p.is_for_sale = TRUE AND (${nameConditions})
      ORDER BY sim DESC LIMIT 5
    `, params)).rows;
    if (!rows.length) return { found: false, results: [], alternatives: [], message: `Không tìm thấy "${partName}"` };
    const pricing    = await getBravoPricing(getAllRefs(rows), customerCode);
    const alts       = await findAlternativesByOem(rows);
    const altPricing = await getBravoPricing(getAllRefs(alts), customerCode);
    return { found: true, note: 'Không xác định được model xe', results: mergeWithPricing(rows, pricing), alternatives: mergeWithPricing(alts, altPricing) };
  }

  // ============================================================
  // STATS
  // ============================================================
  fastify.get('/stats', async (_, reply) => {
    const [p, v, f, b] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE is_for_sale)::int for_sale, COUNT(*) FILTER (WHERE product_type='oem')::int oem, COUNT(*) FILTER (WHERE product_type='aftermarket')::int aftermarket FROM catalog_products`),
      pool.query(`SELECT COUNT(*)::int total, COUNT(DISTINCT make)::int makes FROM catalog_vehicles`),
      pool.query(`SELECT COUNT(*)::int total FROM catalog_fitments`),
      pool.query(`SELECT brand, COUNT(*)::int count FROM catalog_products WHERE brand IS NOT NULL GROUP BY brand ORDER BY count DESC LIMIT 10`),
    ]);
    return reply.send({ products: p.rows[0], vehicles: v.rows[0], fitments: f.rows[0], top_brands: b.rows });
  });

  // ============================================================
  // PRODUCTS — CRUD
  // ============================================================
  fastify.get<{ Querystring: { q?:string; page?:string; limit?:string; product_type?:string; brand?:string; is_for_sale?:string } }>(
    '/products', async (req, reply) => {
      const { q, page='1', limit='20', product_type, brand, is_for_sale } = req.query;
      const off = (parseInt(page)-1) * parseInt(limit);
      const conds = ['1=1']; const vals: any[] = []; let i = 1;
      if (q) { conds.push(`(unaccent_immutable(p.name) ILIKE unaccent_immutable($${i}) OR p.internal_ref ILIKE $${i} OR p.oem_code ILIKE $${i})`); vals.push(`%${q}%`); i+=1; }
      if (product_type) { conds.push(`p.product_type=$${i++}`); vals.push(product_type); }
      if (brand) { conds.push(`p.brand ILIKE $${i++}`); vals.push(`%${brand}%`); }
      if (is_for_sale!==undefined) { conds.push(`p.is_for_sale=$${i++}`); vals.push(is_for_sale==='true'); }
      const w = conds.join(' AND ');
      const [rows, cnt] = await Promise.all([
        pool.query(`SELECT p.*, COUNT(f.id)::int fitment_count FROM catalog_products p LEFT JOIN catalog_fitments f ON f.product_id=p.id WHERE ${w} GROUP BY p.id ORDER BY p.name LIMIT $${i} OFFSET $${i+1}`, [...vals, parseInt(limit), off]),
        pool.query(`SELECT COUNT(*)::int total FROM catalog_products p WHERE ${w}`, vals),
      ]);
      return reply.send({ data:rows.rows, total:cnt.rows[0].total, page:parseInt(page), limit:parseInt(limit), totalPages:Math.ceil(cnt.rows[0].total/parseInt(limit)) });
    }
  );

  // GET /products/:id — DETAIL: load compatible_vehicles + alternatives rieng
  fastify.get<{ Params:{id:string}; Querystring:{customer_code?:string} }>(
    '/products/:id', async (req, reply) => {
      const res = await pool.query(`SELECT * FROM catalog_products WHERE id=$1`, [req.params.id]);
      if (!res.rows.length) return reply.status(404).send({ error: 'Không tìm thấy' });
      const product = res.rows[0];
      // Load vehicles + alternatives song song
      const [compatible_vehicles, alternatives] = await Promise.all([
        loadCompatibleVehicles(product.id),
        loadAlternatives(product.id),
      ]);
      const full = { ...product, compatible_vehicles, alternatives };
      const pricing = await getBravoPricing(getAllRefs([full]), req.query.customer_code);
      return reply.send(mergeWithPricing([full], pricing)[0]);
    }
  );

  fastify.post<{ Body:{ name:string; internal_ref?:string; oem_code?:string; is_for_sale?:boolean; product_type?:string; brand?:string; unit?:string; notes?:string } }>(
    '/products', async (req, reply) => {
      const { name, internal_ref, oem_code, is_for_sale=true, product_type='aftermarket', brand, unit='cái', notes } = req.body;
      if (!name?.trim()) return reply.status(400).send({ error: 'Thiếu tên sản phẩm' });
      const res = await pool.query(
        `INSERT INTO catalog_products (name,internal_ref,oem_code,is_for_sale,product_type,brand,unit,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [name.trim(), internal_ref?.trim()||null, oem_code?.trim()||null, is_for_sale, product_type, brand?.trim()||null, unit, notes||null]
      );
      return reply.status(201).send(res.rows[0]);
    }
  );

  fastify.patch<{ Params:{id:string}; Body:any }>(
    '/products/:id', async (req, reply) => {
      const allowed = ['name','internal_ref','oem_code','is_for_sale','product_type','brand','unit','notes'];
      const updates: string[] = []; const vals: any[] = []; let i = 1;
      for (const k of allowed) if (req.body[k]!==undefined) { updates.push(`${k}=$${i++}`); vals.push(req.body[k]); }
      if (!updates.length) return reply.status(400).send({ error: 'Không có field nào' });
      updates.push('updated_at=NOW()'); vals.push(req.params.id);
      const res = await pool.query(`UPDATE catalog_products SET ${updates.join(',')} WHERE id=$${i} RETURNING *`, vals);
      if (!res.rows.length) return reply.status(404).send({ error: 'Không tìm thấy' });
      return reply.send(res.rows[0]);
    }
  );

  fastify.delete<{ Params:{id:string} }>('/products/:id', async (req, reply) => {
    await pool.query(`DELETE FROM catalog_products WHERE id=$1`, [req.params.id]);
    return reply.send({ success: true });
  });

  // ============================================================
  // VEHICLES — CRUD (giu nguyen)
  // ============================================================
  fastify.get<{ Querystring: { make?:string; model?:string; year?:string; limit?:string } }>(
    '/vehicles/by-query', async (req, reply) => {
      const { make, model, year, limit='50' } = req.query;
      const conds: string[] = ['1=1'];
      const vals: any[] = [];
      if (make) { conds.push(`make ILIKE $${vals.length + 1}`); vals.push(`%${make}%`); }
      if (model) {
        conds.push(`(model_name ILIKE $${vals.length + 1} OR model_code ILIKE $${vals.length + 2})`);
        vals.push(`%${model}%`, `%${model}%`);
      }
      if (year) {
        const y = parseInt(year);
        conds.push(`(year_from IS NULL OR year_from <= $${vals.length + 1})`); vals.push(y);
        conds.push(`(year_to IS NULL OR year_to >= $${vals.length + 1})`); vals.push(y);
      }
      const res = await pool.query(
        `SELECT id, make, model_code, model_name, year_from, year_to, vehicle_type,
                engine, transmission, drive_type, steering, gear_shift, description, specs_fetched
         FROM catalog_vehicles
         WHERE ${conds.join(' AND ')}
         ORDER BY (specs_fetched IS NOT NULL) DESC, (engine IS NOT NULL) DESC,
                  make, model_name, model_code
         LIMIT ${parseInt(limit)}`,
        vals
      );
      return reply.send({ vehicles: res.rows, total: res.rows.length });
    }
  );

  fastify.get('/vehicles/makes', async (_, reply) => {
    const res = await pool.query(`SELECT make, COUNT(*)::int as count FROM catalog_vehicles GROUP BY make ORDER BY make`);
    return reply.send({ makes: res.rows.map(r => r.make), counts: res.rows });
  });

  fastify.get<{ Querystring:{q?:string; make?:string; page?:string; limit?:string} }>(
    '/vehicles', async (req, reply) => {
      const { q, make, page='1', limit='20' } = req.query;
      const off = (parseInt(page)-1)*parseInt(limit);
      const conds=['1=1']; const vals:any[]=[]; let i=1;
      if (q) { conds.push(`(make ILIKE $${i} OR model_code ILIKE $${i} OR model_name ILIKE $${i})`); vals.push(`%${q}%`); i++; }
      if (make) { conds.push(`make ILIKE $${i++}`); vals.push(`%${make}%`); }
      const w = conds.join(' AND ');
      const [rows, cnt] = await Promise.all([
        pool.query(`SELECT * FROM catalog_vehicles WHERE ${w} ORDER BY make,model_code LIMIT $${i} OFFSET $${i+1}`, [...vals,parseInt(limit),off]),
        pool.query(`SELECT COUNT(*)::int total FROM catalog_vehicles WHERE ${w}`, vals),
      ]);
      return reply.send({ data:rows.rows, total:cnt.rows[0].total, page:parseInt(page), limit:parseInt(limit), totalPages:Math.ceil(cnt.rows[0].total/parseInt(limit)) });
    }
  );

  fastify.post<{ Body:any }>('/vehicles', async (req, reply) => {
    const { make, model_code, model_name, vehicle_type='car', year_from, year_to, odoo_ref } = req.body;
    if (!make||!model_code) return reply.status(400).send({ error: 'Thiếu make hoặc model_code' });
    const res = await pool.query(`
      INSERT INTO catalog_vehicles (make,model_code,model_name,vehicle_type,year_from,year_to,odoo_ref)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (make,model_code) DO UPDATE SET
        model_name=COALESCE(EXCLUDED.model_name,catalog_vehicles.model_name),
        year_from=COALESCE(EXCLUDED.year_from,catalog_vehicles.year_from),
        year_to=COALESCE(EXCLUDED.year_to,catalog_vehicles.year_to),
        updated_at=NOW()
      RETURNING *
    `, [make,model_code,model_name||null,vehicle_type,year_from||null,year_to||null,odoo_ref||null]);
    return reply.status(201).send(res.rows[0]);
  });

  fastify.get<{ Params:{id:string} }>('/vehicles/:id', async (req, reply) => {
    const res = await pool.query(`SELECT * FROM catalog_vehicles WHERE id=$1`, [req.params.id]);
    if (!res.rows.length) return reply.status(404).send({ error: 'Không tìm thấy' });
    return reply.send(res.rows[0]);
  });

  fastify.get('/products/no-fitment-oems', async (_req, reply) => {
    const res = await pool.query(`
      SELECT DISTINCT p.oem_code FROM catalog_products p
      WHERE p.is_for_sale = TRUE
        AND p.oem_code IS NOT NULL AND p.oem_code != ''
        AND NOT EXISTS (SELECT 1 FROM catalog_fitments f WHERE f.product_id = p.id)
      ORDER BY p.oem_code
    `);
    return reply.send({ ok: true, count: res.rows.length, oems: res.rows.map((r:any) => r.oem_code) });
  });

  fastify.post<{ Body:{ oem_code:string; vehicles:any[] } }>('/fitments/enrich', async (req, reply) => {
    const { oem_code, vehicles } = req.body;
    if (!oem_code || !Array.isArray(vehicles)) return reply.status(400).send({ error: 'Thieu oem_code hoac vehicles' });
    const prodRes = await pool.query('SELECT id FROM catalog_products WHERE oem_code = $1', [oem_code]);
    const productIds = prodRes.rows.map((r:any) => r.id);
    if (!productIds.length) return reply.send({ ok:true, oem_code, vehicles_created:0, fitments_added:0, note:'Khong co product voi oem nay' });
    let vehiclesCreated = 0, fitmentsAdded = 0;
    for (const v of vehicles) {
      const make = (v.make||'').trim(); const modelCode = (v.modelCode||v.model_code||'').trim();
      if (!make||!modelCode) continue;
      const upRes = await pool.query(`
        INSERT INTO catalog_vehicles (make,model_code,model_name,vehicle_type,year_from,year_to,created_at,updated_at)
        VALUES ($1,$2,$3,'car',$4,$5,NOW(),NOW())
        ON CONFLICT (make,model_code) DO UPDATE SET
          year_from=COALESCE(catalog_vehicles.year_from,EXCLUDED.year_from),
          year_to=COALESCE(catalog_vehicles.year_to,EXCLUDED.year_to), updated_at=NOW()
        RETURNING id, (xmax=0) AS inserted
      `, [make,modelCode,v.modelName||v.model_name||null,v.yearFrom||v.year_from||null,v.yearTo||v.year_to||null]);
      const vehicleId = upRes.rows[0].id;
      if (upRes.rows[0].inserted) vehiclesCreated++;
      for (const pid of productIds) {
        const fitRes = await pool.query(`
          INSERT INTO catalog_fitments (product_id,vehicle_id,notes,created_at)
          VALUES ($1,$2,'enrich-oem',NOW()) ON CONFLICT (product_id,vehicle_id) DO NOTHING RETURNING id
        `, [pid,vehicleId]);
        if (fitRes.rows.length) fitmentsAdded++;
      }
    }
    return reply.send({ ok:true, oem_code, products:productIds.length, vehicles_created:vehiclesCreated, fitments_added:fitmentsAdded });
  });

  fastify.post<{ Body:{ vehicles:any[] } }>('/vehicles/bulk-upsert', async (req, reply) => {
    const list = req.body.vehicles || [];
    if (!list.length) return reply.send({ ok: true, saved: 0 });
    let saved = 0;
    for (const v of list) {
      if (!v.make||!v.model_code) continue;
      try {
        await pool.query(`
          INSERT INTO catalog_vehicles (make,model_code,model_name,vehicle_type,year_from,year_to,engine,transmission,steering,gear_shift,drive_type,specs_raw,description,specs_fetched)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
          ON CONFLICT (make,model_code) DO UPDATE SET
            model_name=COALESCE(EXCLUDED.model_name,catalog_vehicles.model_name), year_from=EXCLUDED.year_from, year_to=EXCLUDED.year_to,
            engine=COALESCE(EXCLUDED.engine,catalog_vehicles.engine), transmission=COALESCE(EXCLUDED.transmission,catalog_vehicles.transmission),
            steering=COALESCE(EXCLUDED.steering,catalog_vehicles.steering), gear_shift=COALESCE(EXCLUDED.gear_shift,catalog_vehicles.gear_shift),
            drive_type=COALESCE(EXCLUDED.drive_type,catalog_vehicles.drive_type), specs_raw=COALESCE(EXCLUDED.specs_raw,catalog_vehicles.specs_raw),
            description=COALESCE(EXCLUDED.description,catalog_vehicles.description), specs_fetched=NOW(), updated_at=NOW()
        `, [v.make,v.model_code,v.model_name||null,v.vehicle_type||'car',v.year_from||null,v.year_to||null,v.engine||null,v.transmission||null,v.steering||null,v.gear_shift||null,v.drive_type||null,v.specs_raw||null,v.description||null]);
        saved++;
      } catch(e:any) { console.error('[bulk-upsert]', v.model_code, e.message); }
    }
    return reply.send({ ok:true, saved, total:list.length });
  });

  fastify.patch<{ Params:{id:string}; Body:any }>('/vehicles/:id/specs', async (req, reply) => {
    const { engine, transmission, drive_type, steering, gear_shift, specs_raw } = req.body;
    await pool.query(
      `UPDATE catalog_vehicles SET engine=COALESCE($1,engine), transmission=COALESCE($2,transmission),
       drive_type=COALESCE($3,drive_type), steering=COALESCE($4,steering),
       gear_shift=COALESCE($5,gear_shift), specs_raw=COALESCE($6,specs_raw), specs_fetched=NOW() WHERE id=$7`,
      [engine,transmission,drive_type,steering,gear_shift,specs_raw,req.params.id]
    );
    return reply.send({ ok: true });
  });

  fastify.patch<{ Params:{id:string}; Body:any }>('/vehicles/:id', async (req, reply) => {
    const allowed=['make','model_code','model_name','vehicle_type','year_from','year_to','odoo_ref'];
    const updates:string[]=[]; const vals:any[]=[]; let i=1;
    for (const k of allowed) if (req.body[k]!==undefined) { updates.push(`${k}=$${i++}`); vals.push(req.body[k]); }
    if (!updates.length) return reply.status(400).send({ error: 'Không có field nào' });
    updates.push('updated_at=NOW()'); vals.push(req.params.id);
    const res = await pool.query(`UPDATE catalog_vehicles SET ${updates.join(',')} WHERE id=$${i} RETURNING *`, vals);
    if (!res.rows.length) return reply.status(404).send({ error: 'Không tìm thấy' });
    return reply.send(res.rows[0]);
  });

  fastify.delete<{ Params:{id:string} }>('/vehicles/:id', async (req, reply) => {
    await pool.query(`DELETE FROM catalog_vehicles WHERE id=$1`, [req.params.id]);
    return reply.send({ success: true });
  });

  // ============================================================
  // FITMENTS (giu nguyen)
  // ============================================================
  fastify.get('/fitments', async (_, reply) => {
    const res = await pool.query(`SELECT * FROM catalog_fitments ORDER BY created_at DESC LIMIT 2000`);
    return reply.send(res.rows);
  });

  fastify.get<{ Params:{id:string} }>('/vehicles/:id/fitments', async (req, reply) => {
    const res = await pool.query(`
      SELECT f.id AS fitment_id, f.notes,
             p.id, p.name, COALESCE(p.name_vi,'') as name_vi,
             p.internal_ref, p.oem_code, p.product_type, p.brand, p.unit, p.is_for_sale
      FROM catalog_fitments f JOIN catalog_products p ON p.id=f.product_id
      WHERE f.vehicle_id=$1 ORDER BY p.name
    `, [req.params.id]);
    return reply.send(res.rows);
  });

  fastify.get<{ Params:{id:string} }>('/products/:id/fitments', async (req, reply) => {
    const res = await pool.query(`
      SELECT f.id, f.notes, f.created_at, v.*
      FROM catalog_fitments f JOIN catalog_vehicles v ON v.id=f.vehicle_id
      WHERE f.product_id=$1 ORDER BY v.make, v.model_code
    `, [req.params.id]);
    return reply.send(res.rows);
  });

  fastify.post<{ Params:{id:string}; Body:{vehicle_id:string; notes?:string} }>(
    '/products/:id/fitments', async (req, reply) => {
      const { vehicle_id, notes } = req.body;
      const res = await pool.query(
        `INSERT INTO catalog_fitments (product_id,vehicle_id,notes) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING *`,
        [req.params.id, vehicle_id, notes||null]
      );
      return reply.status(201).send(res.rows[0] || { message: 'Đã tồn tại' });
    }
  );

  fastify.delete<{ Params:{id:string} }>('/fitments/:id', async (req, reply) => {
    await pool.query(`DELETE FROM catalog_fitments WHERE id=$1`, [req.params.id]);
    return reply.send({ success: true });
  });

  // ============================================================
  // ALTERNATIVES (giu nguyen)
  // ============================================================
  fastify.get<{ Params:{id:string} }>('/products/:id/alternatives', async (req, reply) => {
    const res = await pool.query(`
      SELECT a.id, a.reason, a.created_at, p.*
      FROM catalog_alternatives a JOIN catalog_products p ON p.id=a.alt_product_id
      WHERE a.product_id=$1
    `, [req.params.id]);
    return reply.send(res.rows);
  });

  fastify.post<{ Params:{id:string}; Body:{alt_product_id:string; reason?:string; bidirectional?:boolean} }>(
    '/products/:id/alternatives', async (req, reply) => {
      const { alt_product_id, reason, bidirectional=false } = req.body;
      await pool.query(`INSERT INTO catalog_alternatives (product_id,alt_product_id,reason) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [req.params.id, alt_product_id, reason||null]);
      if (bidirectional) await pool.query(`INSERT INTO catalog_alternatives (product_id,alt_product_id,reason) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [alt_product_id, req.params.id, reason||null]);
      return reply.status(201).send({ success: true });
    }
  );

  fastify.delete<{ Params:{id:string} }>('/alternatives/:id', async (req, reply) => {
    await pool.query(`DELETE FROM catalog_alternatives WHERE id=$1`, [req.params.id]);
    return reply.send({ success: true });
  });

  // ============================================================
  // SEARCH CLARIFY (giu nguyen)
  // ============================================================
  fastify.get<{ Querystring:{ part:string; make?:string; model?:string; year?:string } }>(
    '/search/clarify', async (req, reply) => {
      const { part, make, model, year } = req.query;
      if (!part) return reply.status(400).send({ error: 'Thiếu part' });
      const yearNum = year ? parseInt(year) : null;
      const vehicleFilter = make ? `
        AND EXISTS (
          SELECT 1 FROM catalog_fitments f2
          JOIN catalog_vehicles v ON v.id = f2.vehicle_id
          WHERE f2.product_id = p.id AND v.make ILIKE $2
            ${model ? `AND v.model_name ILIKE $3` : ''}
            ${yearNum ? `AND (v.year_from IS NULL OR v.year_from <= ${yearNum}) AND (v.year_to IS NULL OR v.year_to >= ${yearNum})` : ''}
        )` : '';
      const params: any[] = [`%${part}%`];
      if (make) params.push(`%${make}%`);
      if (model) params.push(`%${model}%`);
      const res = await pool.query(`
        SELECT name, COUNT(*) AS cnt,
          trim(regexp_replace(regexp_replace(name, '\\s+(LH|RH|LH\\/RH|RH\\/LH)\\s*$', '', 'i'),
          '\\s+(trước|sau|No\\.\\d+|\\(.*\\))\\s*$', '', 'i')) AS base_name
        FROM catalog_products p
        WHERE unaccent_immutable(name) ILIKE unaccent_immutable($1) AND is_for_sale = TRUE ${vehicleFilter}
        GROUP BY name ORDER BY cnt DESC LIMIT 100
      `, params);
      if (!res.rows.length) return reply.send({ needs_clarify: false, groups: [] });
      const groupMap = new Map<string, number>();
      for (const row of res.rows) {
        const base = row.base_name || row.name;
        groupMap.set(base, (groupMap.get(base) || 0) + parseInt(row.cnt));
      }
      const groups = Array.from(groupMap.entries()).sort((a,b) => b[1]-a[1]).map(([name,count]) => ({name,count}));
      return reply.send({ needs_clarify: groups.length > 1, groups, total_products: res.rows.length });
    }
  );

  // ============================================================
  // SEARCH BY CODE — query thang catalog_products
  // ============================================================
  fastify.get<{ Querystring:{code:string; customer_code?:string} }>(
    '/search/by-code', async (req, reply) => {
      const { code, customer_code } = req.query;
      if (!code?.trim()) return reply.status(400).send({ error: 'Thiếu code' });
      const c = code.trim().toUpperCase();

      // Query thang catalog_products — khong qua VIEW
      let rows = (await pool.query(`
        SELECT ${PRODUCT_COLS} FROM catalog_products p
        WHERE p.internal_ref=$1 OR p.oem_code=$1 LIMIT 1
      `, [c])).rows;

      if (!rows.length) rows = (await pool.query(`
        SELECT ${PRODUCT_COLS} FROM catalog_products p
        WHERE REPLACE(p.internal_ref,'-','')=REPLACE($1,'-','')
           OR REPLACE(p.oem_code,'-','')=REPLACE($1,'-','') LIMIT 1
      `, [c])).rows;

      if (!rows.length) return reply.send({ found:false, results:[], alternatives:[] });

      // Load fitment_count + alternatives rieng
      const productId = rows[0].id;
      const [fitRes, altsRes, equivRes] = await Promise.all([
        pool.query(`SELECT COUNT(*)::int cnt FROM catalog_fitments WHERE product_id=$1`, [productId]),
        loadAlternatives(productId),
        rows[0].oem_code ? pool.query(`
          SELECT ${PRODUCT_COLS} FROM catalog_products p
          WHERE p.oem_code=$1 AND p.id<>$2 ORDER BY p.internal_ref
        `, [rows[0].oem_code, productId]) : Promise.resolve({ rows: [] }),
      ]);

      const enriched = [{ ...rows[0], fitment_count: fitRes.rows[0].cnt, alternatives: altsRes }];
      const equivalents = equivRes.rows;
      const allRows = [...enriched, ...equivalents];
      const pricing = await getBravoPricing(getAllRefs(allRows), customer_code);

      return reply.send({
        found: true,
        results: mergeWithPricing(enriched, pricing),
        equivalents: mergeWithPricing(equivalents, pricing),
        alternatives: mergeWithPricing(altsRes, pricing),
      });
    }
  );

  // ============================================================
  // SEARCH BY MULTI CODE — query thang catalog_products
  // ============================================================
  fastify.get<{ Querystring:{ codes:string; customer_code?:string } }>(
    '/search/by-multi-code', async (req, reply) => {
      const { codes, customer_code } = req.query;
      if (!codes?.trim()) return reply.status(400).send({ error: 'Thiếu codes' });
      const codeList = codes.split(',').map((c:string) => c.trim().toUpperCase()).filter(Boolean);
      if (!codeList.length) return reply.status(400).send({ error: 'Danh sách mã trống' });

      // Query thang catalog_products — khong qua VIEW
      const res = await pool.query(`
        SELECT ${PRODUCT_COLS},
               COALESCE(p.internal_ref, p.oem_code) AS matched_code,
               (SELECT COUNT(*)::int FROM catalog_fitments f WHERE f.product_id = p.id) AS fitment_count
        FROM catalog_products p
        WHERE p.internal_ref = ANY($1::text[]) OR p.oem_code = ANY($1::text[])
           OR REPLACE(p.internal_ref,'-','') = ANY(SELECT REPLACE(c,'-','') FROM unnest($1::text[]) c)
           OR REPLACE(p.oem_code,'-','') = ANY(SELECT REPLACE(c,'-','') FROM unnest($1::text[]) c)
      `, [codeList]);

      const foundMap = new Map<string, any>();
      for (const row of res.rows) {
        const ref = row.internal_ref?.toUpperCase();
        const oem = row.oem_code?.toUpperCase();
        for (const code of codeList) {
          const clean = code.replace(/-/g,'');
          if (ref===code||oem===code||ref?.replace(/-/g,'')===clean||oem?.replace(/-/g,'')===clean) {
            if (!foundMap.has(code)) foundMap.set(code, row);
          }
        }
      }
      const allFound = res.rows;
      const pricing  = await getBravoPricing(getAllRefs(allFound), customer_code);
      const merged   = mergeWithPricing(allFound, pricing);
      const results  = codeList.map((code:string) => {
        const product = foundMap.get(code) || null;
        const mergedProduct = product ? merged.find((p:any) => p.id === product.id) : null;
        if (mergedProduct) console.log(`[multi-code] ${code} → price=${mergedProduct.price} in_stock=${mergedProduct.in_stock}`);
        return { code, found: !!product, product: mergedProduct };
      });
      return reply.send({ total:codeList.length, found:results.filter((r:any)=>r.found).length, missing:results.filter((r:any)=>!r.found).length, results });
    }
  );

  // ============================================================
  // SEARCH BY VIN — query thang catalog_products
  // ============================================================
  fastify.get<{ Querystring:{vin:string; part:string; customer_code?:string} }>(
    '/search/by-vin', async (req, reply) => {
      const { vin, part, customer_code } = req.query;
      if (!vin||!part) return reply.status(400).send({ error: 'Thiếu vin hoặc part' });
      const rows = (await pool.query(`
        SELECT ${PRODUCT_COLS},
               similarity(unaccent(p.name), unaccent($1)) sim
        FROM catalog_products p
        JOIN catalog_fitments f ON f.product_id = p.id
        WHERE p.is_for_sale = TRUE
          AND unaccent_immutable(p.name) ILIKE unaccent_immutable($2)
        ORDER BY sim DESC LIMIT 5
      `, [part.trim(), `%${part.trim()}%`])).rows;

      if (!rows.length) return reply.send(await fallbackByName(part, customer_code));
      const pricing = await getBravoPricing(getAllRefs(rows), customer_code);
      return reply.send({ found:true, results:mergeWithPricing(rows,pricing), alternatives:[] });
    }
  );

  // ============================================================
  // SEARCH BY MODEL — query thang catalog_products, bo VIEW
  // ============================================================
  fastify.get<{ Querystring:{make:string; model?:string; year?:string; part:string; customer_code?:string} }>(
    '/search/by-model', async (req, reply) => {
      const { make, model, year, part, customer_code } = req.query;
      if (!make||!part) return reply.status(400).send({ error: 'Thiếu make hoặc part' });
      const yearNum = year ? parseInt(year) : null;
      console.log(`[by-model] make=${make} model=${model} year=${yearNum} part=${part}`);

      const allPartNames = await resolvePartName(part);
      const BASE = 5;
      const partILIKE = allPartNames.map((_:string, i:number) => `unaccent_immutable(p.name) ILIKE unaccent_immutable($${BASE+i})`).join(' OR ');
      const partParams = allPartNames.map((n:string) => `%${n}%`);   // chỉ %name% cho ILIKE (bỏ params của nhánh %)
      const fixedParams = [`%${make}%`, model ? `%${model}%` : null, yearNum, allPartNames[0]||part];
      const allParams   = [...fixedParams, ...partParams];

      // Query thang catalog_products — khong qua VIEW
      const rows = (await pool.query(`
        SELECT DISTINCT ON (p.id) ${PRODUCT_COLS},
          similarity(unaccent(p.name), unaccent($4)) sim,
          v.model_name AS matched_model_name, v.make AS matched_make,
          v.year_from AS matched_year_from, v.year_to AS matched_year_to
        FROM catalog_products p
        JOIN catalog_fitments f ON f.product_id = p.id
        JOIN catalog_vehicles v ON v.id = f.vehicle_id
        WHERE v.make ILIKE $1
          AND ($2::TEXT IS NULL OR v.model_name ILIKE $2 OR v.model_name ILIKE REPLACE($2,'%','')||'%'
               OR v.model_code ILIKE $2
               OR similarity(unaccent(COALESCE(v.model_name,'')), unaccent(REPLACE($2,'%',''))) > 0.3
               OR similarity(unaccent(v.model_code), unaccent(REPLACE($2,'%',''))) > 0.3)
          AND ($3::INT IS NULL OR v.year_from IS NULL OR v.year_from <= $3)
          AND ($3::INT IS NULL OR v.year_to   IS NULL OR v.year_to   >= $3)
          AND p.is_for_sale = TRUE
          AND (${partILIKE})
        ORDER BY p.id, sim DESC LIMIT 50
      `, allParams)).rows;

      if (!rows.length) {
        if (make?.trim()) return reply.send({ found:false, results:[], alternatives:[], message:`Không tìm thấy "${part}" phù hợp với xe ${make}${model?' '+model:''}${yearNum?' '+yearNum:''}. Shop chưa có dữ liệu cho dòng xe này.` });
        return reply.send(await fallbackByName(part, customer_code));
      }

      const MIN_SIM = 0.3;
      const relevant = rows.filter((r:any) => parseFloat(r.sim) >= MIN_SIM);
      if (!relevant.length) {
        if (make?.trim()) return reply.send({ found:false, results:[], alternatives:[], message:`Không tìm thấy "${part}" phù hợp với xe ${make}${model?' '+model:''}. Shop chưa có dữ liệu cho dòng xe này.` });
        return reply.send(await fallbackByName(part, customer_code));
      }

      const grouped = new Map<string, any>();
      for (const row of relevant) {
        const baseName = row.name
          .replace(/\s*\(.*?\)\s*/g,' ')
          .replace(/-(CC|NM|BH|GG|A0|B0|C0|TEST)\s*$/i,'')
          .replace(/\s+/g,' ').trim().toLowerCase();
        if (!grouped.has(baseName)) grouped.set(baseName, { ...row, variants:[row] });
        else grouped.get(baseName)!.variants.push(row);
      }
      const finalResults: any[] = [];
      for (const group of grouped.values()) {
        if (group.variants.length===1) finalResults.push(group);
        else for (const v of group.variants) finalResults.push(v);
      }
      const groupedList = finalResults.sort((a:any,b:any) => parseFloat(b.sim)-parseFloat(a.sim)).slice(0,8);
      const pricing    = await getBravoPricing(getAllRefs(groupedList), customer_code);
      const alts       = await findAlternativesByOem(groupedList);
      const altPricing = await getBravoPricing(getAllRefs(alts), customer_code);
      return reply.send({
        found: true,
        vehicle_matched: { make:groupedList[0]?.matched_make||make, model:groupedList[0]?.matched_model_name||model, year:yearNum },
        results     : mergeWithPricing(groupedList, pricing),
        alternatives: mergeWithPricing(alts, altPricing),
      });
    }
  );

  // ============================================================
  // CRAWL ORCHESTRATION — hàng đợi cào PartSouq phân tán
  // ============================================================

  // Parse "MM.YYYY - MM.YYYY" (hoặc "YYYY - YYYY", "01.2006") → year_from/year_to + mfg_from/mfg_to
  function parseYearRange(range?: string): { yearFrom:number|null; yearTo:number|null; mfgFrom:string|null; mfgTo:string|null } {
    if (!range) return { yearFrom:null, yearTo:null, mfgFrom:null, mfgTo:null };
    const parts = String(range).split('-').map(s => s.trim());
    const grabYear = (s?:string) => { const m = s?.match(/(\d{4})/); return m ? parseInt(m[1]) : null; };
    const grabMfg  = (s?:string) => { const m = s?.match(/(\d{1,2}[./]\d{4}|\d{4})/); return m ? m[1] : null; };
    return { yearFrom:grabYear(parts[0]), yearTo:grabYear(parts[1] ?? parts[0]), mfgFrom:grabMfg(parts[0]), mfgTo:grabMfg(parts[1] ?? parts[0]) };
  }

  // a) POST /crawl/seed — nạp job vào hàng đợi
  fastify.post<{ Body: { jobs?: {make:string; model_line?:string}[]; makes?: string[] } }>(
    '/crawl/seed', async (req, reply) => {
      try {
        const list: {make:string; model_line:string|null}[] = [];
        if (Array.isArray(req.body?.jobs))  for (const j of req.body.jobs)  if (j?.make?.trim()) list.push({ make:j.make.trim(), model_line:j.model_line?.trim() || null });
        if (Array.isArray(req.body?.makes)) for (const m of req.body.makes) if (m?.trim())        list.push({ make:m.trim(), model_line:null });
        if (!list.length) return reply.status(400).send({ error: 'Thiếu jobs hoặc makes' });
        let added = 0;
        for (const j of list) {
          const r = await pool.query(
            `INSERT INTO catalog_crawl_jobs (make, model_line) VALUES ($1,$2)
             ON CONFLICT (make, COALESCE(model_line,'')) DO NOTHING RETURNING id`,
            [j.make, j.model_line]
          );
          if (r.rows.length) added++;
        }
        return reply.send({ ok:true, requested:list.length, added, skipped:list.length-added });
      } catch(e:any) { fastify.log.error('[crawl/seed] '+e.message); return reply.status(500).send({ error:e.message }); }
    }
  );

  // b) POST /crawl/claim-job — VPS xin 1 job (FOR UPDATE SKIP LOCKED chống lấy trùng)
  fastify.post<{ Body: { worker_id:string } }>('/crawl/claim-job', async (req, reply) => {
    try {
      const workerId = (req.body?.worker_id || '').trim();
      if (!workerId) return reply.status(400).send({ error: 'Thiếu worker_id' });
      const r = await pool.query(`
        UPDATE catalog_crawl_jobs SET status='running', claimed_by=$1, claimed_at=NOW(), attempts=attempts+1
        WHERE id = (
          SELECT id FROM catalog_crawl_jobs
          WHERE status='pending' OR (status='running' AND claimed_at < NOW() - INTERVAL '30 minutes')
          ORDER BY created_at LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        RETURNING *
      `, [workerId]);
      return reply.send({ job: r.rows[0] || null });
    } catch(e:any) { fastify.log.error('[crawl/claim-job] '+e.message); return reply.status(500).send({ error:e.message }); }
  });

  // b2) POST /crawl/claim-model — VPS xin ĐỘC QUYỀN cào 1 model thật (khóa cấp model)
  //     Chống 2 VPS cùng cào 1 model dù claim job khác nhau (nhiều job → cùng 1 model).
  //     ATOMIC nhờ INSERT ... ON CONFLICT DO UPDATE ... WHERE (an toàn với INSERT đồng thời).
  //     granted = có row trả về (INSERT mới, HOẶC UPDATE khi WHERE khớp).
  fastify.post<{ Body: { worker_id:string; make:string; model_key:string } }>(
    '/crawl/claim-model', async (req, reply) => {
      try {
        const workerId = (req.body?.worker_id || '').trim();
        const make     = (req.body?.make || '').trim();
        const modelKey = (req.body?.model_key || '').trim();
        if (!workerId || !make || !modelKey) return reply.status(400).send({ error: 'Thiếu worker_id/make/model_key' });

        // WHERE cho DO UPDATE — chỉ giành được khi model:
        //   • đang 'crawling' bởi CHÍNH worker này (idempotent resume), HOẶC
        //   • đang 'crawling' nhưng VPS giữ đã CHẾT (claimed_at quá 15 phút → timeout).
        // Row 'done' → status != 'crawling' → WHERE sai → 0 row → NOT granted (không cào lại).
        // Row 'crawling' của VPS khác còn sống → WHERE sai → 0 row → NOT granted (bỏ qua).
        const r = await pool.query(`
          INSERT INTO catalog_model_claim (make, model_key, status, claimed_by, claimed_at)
          VALUES ($1, $2, 'crawling', $3, NOW())
          ON CONFLICT (make, model_key) DO UPDATE
            SET status='crawling', claimed_by=EXCLUDED.claimed_by, claimed_at=NOW(), finished_at=NULL
            WHERE catalog_model_claim.status = 'crawling'
              AND ( catalog_model_claim.claimed_by = EXCLUDED.claimed_by
                    OR catalog_model_claim.claimed_at < NOW() - INTERVAL '15 minutes' )
          RETURNING claimed_by, status
        `, [make, modelKey, workerId]);

        if (r.rows.length) {
          // INSERT hoặc UPDATE thành công → claimed_by luôn = workerId → granted
          return reply.send({ granted: true });
        }
        // Không giành được → SELECT xem ai đang giữ (chỉ để worker log cho dễ hiểu)
        const held = await pool.query(
          `SELECT status, claimed_by FROM catalog_model_claim WHERE make=$1 AND model_key=$2`,
          [make, modelKey]
        );
        const h = held.rows[0] || {};
        return reply.send({ granted: false, status: h.status || 'crawling', claimed_by: h.claimed_by || null });
      } catch(e:any) { fastify.log.error('[crawl/claim-model] '+e.message); return reply.status(500).send({ error:e.message }); }
    }
  );

  // b3) POST /crawl/finish-model — VPS báo đã cào XONG 1 model → nhả khóa (status='done')
  fastify.post<{ Body: { worker_id?:string; make:string; model_key:string; units_done?:number } }>(
    '/crawl/finish-model', async (req, reply) => {
      try {
        const make     = (req.body?.make || '').trim();
        const modelKey = (req.body?.model_key || '').trim();
        const unitsDone = Number(req.body?.units_done) || 0;
        if (!make || !modelKey) return reply.status(400).send({ error: 'Thiếu make hoặc model_key' });
        await pool.query(`
          UPDATE catalog_model_claim
          SET status='done', finished_at=NOW(), units_done=$3, claimed_at=NOW()
          WHERE make=$1 AND model_key=$2
        `, [make, modelKey, unitsDone]);
        return reply.send({ ok:true });
      } catch(e:any) { fastify.log.error('[crawl/finish-model] '+e.message); return reply.status(500).send({ error:e.message }); }
    }
  );

  // c) GET /crawl/should-scrape?make=X&model_code=Y — hỏi trước khi cào 1 model
  fastify.get<{ Querystring: { make:string; model_code:string; source?:string } }>(
    '/crawl/should-scrape', async (req, reply) => {
      try {
        const { make, model_code, source='partsouq' } = req.query;
        if (!make || !model_code) return reply.status(400).send({ error: 'Thiếu make hoặc model_code' });
        const r = await pool.query(
          `SELECT 1 FROM catalog_crawl_log WHERE make=$1 AND model_code=$2 AND source=$3 LIMIT 1`,
          [make, model_code, source]
        );
        return reply.send({ should_scrape: r.rows.length === 0 });
      } catch(e:any) { fastify.log.error('[crawl/should-scrape] '+e.message); return reply.status(500).send({ error:e.message }); }
    }
  );

  // d) POST /crawl/submit — nhận kết quả cào 1 model_code (1 transaction)
  fastify.post<{ Body:any }>('/crawl/submit', async (req, reply) => {
    const b = req.body || {};
    const { make, model_code, model_line, year_range } = b;
    if (!make || !model_code) return reply.status(400).send({ error: 'Thiếu make hoặc model_code' });
    const partList: any[] = Array.isArray(b.parts) ? b.parts : [];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { yearFrom, yearTo, mfgFrom, mfgTo } = parseYearRange(year_range);

      // 1) Upsert vehicle
      const vRes = await client.query(`
        INSERT INTO catalog_vehicles (make, model_code, model_name, vehicle_type, year_from, year_to, mfg_from, mfg_to, created_at, updated_at)
        VALUES ($1,$2,$3,'car',$4,$5,$6,$7,NOW(),NOW())
        ON CONFLICT (make, model_code) DO UPDATE SET
          model_name = COALESCE(catalog_vehicles.model_name, EXCLUDED.model_name),
          year_from  = COALESCE(catalog_vehicles.year_from,  EXCLUDED.year_from),
          year_to    = COALESCE(catalog_vehicles.year_to,    EXCLUDED.year_to),
          mfg_from   = COALESCE(catalog_vehicles.mfg_from,   EXCLUDED.mfg_from),
          mfg_to     = COALESCE(catalog_vehicles.mfg_to,     EXCLUDED.mfg_to),
          updated_at = NOW()
        RETURNING id
      `, [make, model_code, model_line || null, yearFrom, yearTo, mfgFrom, mfgTo]);
      const vehicleId = vRes.rows[0].id;

      // 2+3) Với mỗi part: upsert product (check-then-insert vì oem_code KHÔNG unique) + fitment
      let partsInserted = 0, fitmentsCreated = 0;
      for (const p of partList) {
        const code = (p.part_number || p.partNumber || '').trim();
        if (!code) continue;
        const name = (p.name || p.unit || code).trim();
        const codeUp = code.toUpperCase();
        const found = await client.query(`
          SELECT id FROM catalog_products
          WHERE UPPER(internal_ref)=$1 OR UPPER(oem_code)=$1
             OR REPLACE(UPPER(internal_ref),'-','')=REPLACE($1,'-','')
             OR REPLACE(UPPER(oem_code),'-','')=REPLACE($1,'-','')
          LIMIT 1
        `, [codeUp]);
        let productId: any;
        if (found.rows.length) {
          productId = found.rows[0].id;
        } else {
          const ins = await client.query(`
            INSERT INTO catalog_products (name, internal_ref, oem_code, is_for_sale, product_type, needs_translation)
            VALUES ($1,$2,$2,FALSE,'oem',TRUE) RETURNING id
          `, [name, code]);
          productId = ins.rows[0].id;
          partsInserted++;
        }
        const fit = await client.query(`
          INSERT INTO catalog_fitments (product_id, vehicle_id, notes)
          VALUES ($1,$2,'partsouq-crawl') ON CONFLICT (product_id, vehicle_id) DO NOTHING RETURNING id
        `, [productId, vehicleId]);
        if (fit.rows.length) fitmentsCreated++;
      }

      // 4) Đánh dấu đã cào
      await client.query(`
        INSERT INTO catalog_crawl_log (make, model_code, model_line, parts_count, source)
        VALUES ($1,$2,$3,$4,'partsouq')
        ON CONFLICT (make, model_code, source) DO UPDATE SET parts_count=EXCLUDED.parts_count, scraped_at=NOW()
      `, [make, model_code, model_line || null, partList.length]);

      await client.query('COMMIT');
      return reply.send({ ok:true, vehicle_id:vehicleId, parts_received:partList.length, parts_inserted:partsInserted, fitments_created:fitmentsCreated });
    } catch(e:any) {
      await client.query('ROLLBACK');
      fastify.log.error('[crawl/submit] '+e.message);
      return reply.status(500).send({ error:e.message });
    } finally {
      client.release();
    }
  });

  // c2) GET /crawl/should-scrape-unit — hỏi trước khi cào 1 UNIT (resume unit-level)
  fastify.get<{ Querystring: { make:string; model_code:string; unit_key:string; source?:string } }>(
    '/crawl/should-scrape-unit', async (req, reply) => {
      try {
        const { make, model_code, unit_key, source='partsouq' } = req.query;
        if (!make || !model_code || !unit_key) return reply.status(400).send({ error: 'Thiếu make/model_code/unit_key' });
        const r = await pool.query(
          `SELECT 1 FROM catalog_crawl_unit_log WHERE make=$1 AND model_code=$2 AND unit_key=$3 AND source=$4 LIMIT 1`,
          [make, model_code, unit_key, source]
        );
        return reply.send({ should_scrape: r.rows.length === 0 });
      } catch(e:any) { fastify.log.error('[crawl/should-scrape-unit] '+e.message); return reply.status(500).send({ error:e.message }); }
    }
  );

  // c3) POST /crawl/mark-unit-retry — unit bị Cloudflare checkbox chặn → ĐÁNH DẤU CẦN CÀO LẠI.
  //     KHÔNG ghi catalog_crawl_unit_log (nên should-scrape-unit vẫn trả true → lần sau cào lại).
  //     Bảng catalog_unit_retry CHỈ để đếm số lần thử → worker biết khi nào nên bỏ cuộc (tránh kẹt).
  //     Trả về { attempts } để worker quyết định (>= ngưỡng thì thôi retry).
  fastify.post<{ Body: { make:string; model_key:string; unit_key:string } }>(
    '/crawl/mark-unit-retry', async (req, reply) => {
      try {
        const make     = (req.body?.make || '').trim();
        const modelKey = (req.body?.model_key || '').trim();
        const unitKey  = (req.body?.unit_key || '').trim();
        if (!make || !modelKey || !unitKey) return reply.status(400).send({ error: 'Thiếu make/model_key/unit_key' });
        const r = await pool.query(`
          INSERT INTO catalog_unit_retry (make, model_key, unit_key, attempts, last_blocked_at)
          VALUES ($1,$2,$3,1,NOW())
          ON CONFLICT (make, model_key, unit_key) DO UPDATE
            SET attempts = catalog_unit_retry.attempts + 1, last_blocked_at = NOW()
          RETURNING attempts
        `, [make, modelKey, unitKey]);
        return reply.send({ ok:true, attempts: r.rows[0].attempts });
      } catch(e:any) { fastify.log.error('[crawl/mark-unit-retry] '+e.message); return reply.status(500).send({ error:e.message }); }
    }
  );

  // d2) POST /crawl/submit-unit — submit parts của 1 UNIT (1 transaction, KIỂM TRA tồn tại trước khi lưu)
  fastify.post<{ Body:any }>('/crawl/submit-unit', async (req, reply) => {
    const _t0 = Date.now();   // đo thời gian (B5)
    const b = req.body || {};
    // Làm sạch input: bỏ ký tự NUL (\u0000 — PG text KHÔNG lưu được) + CẮT theo giới hạn cột varchar
    //   để KHÔNG bị "value too long" (SQLSTATE 22001) → 500. Dữ liệu vẫn lưu (cắt bớt) thay vì mất cả unit.
    const clean = (v:any, max?:number) => {
      if (v == null) return v;
      let s = String(v).replace(/\u0000/g, '');
      if (max && s.length > max) s = s.slice(0, max);
      return s;
    };
    const make       = clean(b.make, 100);         // catalog_vehicles.make varchar(100)
    const model_code = clean(b.model_code, 100);   // catalog_vehicles.model_code varchar(100)
    const model_line = clean(b.model_line, 200);   // → catalog_vehicles.model_name varchar(200)
    const year_range = b.year_range;
    const unit_key   = clean(b.unit_key);          // text (không giới hạn) — chỉ bỏ NUL, KHÔNG cắt (giữ khớp should-scrape-unit)
    const workerId = (b.worker_id || '').trim() || null;   // VPS nào gửi unit này (để thống kê theo VPS)
    if (!make || !model_code || !unit_key) return reply.status(400).send({ error: 'Thiếu make/model_code/unit_key' });
    const partList: any[] = Array.isArray(b.parts) ? b.parts : [];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { yearFrom, yearTo, mfgFrom, mfgTo } = parseYearRange(year_range);

      // 1) Upsert vehicle (idempotent — không tạo trùng)
      const vRes = await client.query(`
        INSERT INTO catalog_vehicles (make, model_code, model_name, vehicle_type, year_from, year_to, mfg_from, mfg_to, created_at, updated_at)
        VALUES ($1,$2,$3,'car',$4,$5,$6,$7,NOW(),NOW())
        ON CONFLICT (make, model_code) DO UPDATE SET
          model_name = COALESCE(catalog_vehicles.model_name, EXCLUDED.model_name),
          year_from  = COALESCE(catalog_vehicles.year_from,  EXCLUDED.year_from),
          year_to    = COALESCE(catalog_vehicles.year_to,    EXCLUDED.year_to),
          mfg_from   = COALESCE(catalog_vehicles.mfg_from,   EXCLUDED.mfg_from),
          mfg_to     = COALESCE(catalog_vehicles.mfg_to,     EXCLUDED.mfg_to),
          updated_at = NOW()
        RETURNING id
      `, [make, model_code, model_line || null, yearFrom, yearTo, mfgFrom, mfgTo]);
      const vehicleId = vRes.rows[0].id;

      // 2+3) BATCH (nhanh): 1 query tìm part đã có (so khớp CHÍNH XÁC oem_code → dùng index idx_prod_oem ~20ms),
      //      1 batch INSERT part mới, 1 batch INSERT fitment — thay cho 2N query/seq-scan (trước 1-3 phút/unit).
      const byCode = new Map<string, { code:string; name:string }>();
      for (const p of partList) {
        // oem_code & internal_ref varchar(100), name varchar(500) — cắt + bỏ NUL để KHÔNG bị 500 (22001)
        const code = clean(String(p.part_number || p.partNumber || '').trim(), 100);
        if (!code) continue;
        if (!byCode.has(code)) byCode.set(code, { code, name: clean(String(p.name || p.unit || code).trim(), 500) });
      }
      const codes = [...byCode.keys()];
      let partsInserted = 0, partsExisted = 0, fitmentsCreated = 0;
      const idByCode = new Map<string, any>();

      if (codes.length) {
        // (a) tìm part đã tồn tại theo oem_code HOẶC internal_ref.
        //   Vì insert đặt internal_ref = code và có UNIQUE partial index idx_prod_ref(internal_ref).
        //   Nếu chỉ tra oem_code sẽ BỎ SÓT product có internal_ref=code nhưng oem_code khác → insert đụng
        //   idx_prod_ref → 23505 → 500 (đây LÀ lỗi làm kẹt worker). Tra cả 2 cột để khỏi insert trùng.
        const er = await client.query(
          `SELECT id, oem_code, internal_ref FROM catalog_products
           WHERE oem_code = ANY($1::text[]) OR internal_ref = ANY($1::text[])`,
          [codes]
        );
        for (const row of er.rows) {
          if (row.oem_code     && byCode.has(row.oem_code)     && !idByCode.has(row.oem_code))     idByCode.set(row.oem_code, row.id);
          if (row.internal_ref && byCode.has(row.internal_ref) && !idByCode.has(row.internal_ref)) idByCode.set(row.internal_ref, row.id);
        }
        partsExisted = idByCode.size;

        // (b) batch INSERT các part chưa có. ON CONFLICT trên idx_prod_ref (partial unique internal_ref)
        //     → chống RACE 2 VPS insert cùng lúc (không ném 23505). Code bị bỏ (DO NOTHING) tra lại ở dưới.
        const newCodes = codes.filter(c => !idByCode.has(c));
        if (newCodes.length) {
          const names = newCodes.map(c => byCode.get(c)!.name);
          const ins = await client.query(
            `INSERT INTO catalog_products (name, internal_ref, oem_code, is_for_sale, product_type, needs_translation)
             SELECT n, c, c, FALSE, 'oem', TRUE FROM unnest($1::text[], $2::text[]) AS t(n, c)
             ON CONFLICT (internal_ref) WHERE internal_ref IS NOT NULL DO NOTHING
             RETURNING id, oem_code, internal_ref`,
            [names, newCodes]
          );
          for (const row of ins.rows) idByCode.set(row.oem_code || row.internal_ref, row.id);
          partsInserted = ins.rows.length;
          // Code bị ON CONFLICT DO NOTHING (VPS khác vừa chèn) → tra lại theo internal_ref để lấy id.
          const stillMissing = newCodes.filter(c => !idByCode.has(c));
          if (stillMissing.length) {
            const mr = await client.query(
              `SELECT id, internal_ref FROM catalog_products WHERE internal_ref = ANY($1::text[])`,
              [stillMissing]
            );
            for (const row of mr.rows) idByCode.set(row.internal_ref, row.id);
          }
        }

        // (c) batch INSERT fitment (unnest) — ON CONFLICT DO NOTHING (idempotent, không trùng)
        const productIds = codes.map(c => idByCode.get(c)).filter(Boolean);
        if (productIds.length) {
          const fr = await client.query(
            `INSERT INTO catalog_fitments (product_id, vehicle_id, notes)
             SELECT pid, $2, 'partsouq-crawl' FROM unnest($1::uuid[]) AS t(pid)
             ON CONFLICT (product_id, vehicle_id) DO NOTHING RETURNING id`,
            [productIds, vehicleId]
          );
          fitmentsCreated = fr.rows.length;
        }
      }

      // 4) Đánh dấu UNIT đã cào (idempotent) — kể cả 0 part vẫn ghi để không cào lại.
      //    Ghi kèm worker_id + 3 số đóng góp. DO NOTHING = giữ VPS ghi ĐẦU (đúng VPS đã cào thật).
      //    parts_total = số part unique cào được (gồm trùng DB); parts_new = INSERT mới; fitments_new = fitment mới.
      const partsTotal = codes.length;
      await client.query(`
        INSERT INTO catalog_crawl_unit_log
          (make, model_code, unit_key, parts_count, source, worker_id, parts_total, parts_new, fitments_new)
        VALUES ($1,$2,$3,$4,'partsouq',$5,$6,$7,$8)
        ON CONFLICT (make, model_code, unit_key, source) DO NOTHING
      `, [make, model_code, unit_key, partList.length, workerId, partsTotal, partsInserted, fitmentsCreated]);

      await client.query('COMMIT');

      // Heartbeat khóa model: mỗi unit submit thành công → làm mới claimed_at của model đang cào,
      // để model dài (nhiều unit) KHÔNG bị VPS khác coi là timeout (15 phút) và giành mất.
      // Best-effort — model_code ở đây chính là model_key (effCode). Lỗi cũng không ảnh hưởng submit.
      pool.query(
        `UPDATE catalog_model_claim SET claimed_at=NOW()
         WHERE make=$1 AND model_key=$2 AND status='crawling'`,
        [make, model_code]
      ).catch(()=>{});

      const _ms = Date.now() - _t0;
      if (_ms > 2000) fastify.log.warn(`[submit-unit] CHẬM ${_ms}ms — unit=${unit_key} (${partList.length} part)`);
      return reply.send({ ok:true, vehicle_id:vehicleId,
        parts_received:partList.length,
        // 3 số đóng góp (mới):
        parts_total:partsTotal, parts_new:partsInserted, parts_existed:partsExisted, fitments_new:fitmentsCreated,
        // tên cũ giữ để tương thích:
        parts_inserted:partsInserted, fitments_created:fitmentsCreated,
        ms:_ms });
    } catch(e:any) {
      await client.query('ROLLBACK');
      const sqlstate: string = e?.code || '';
      // Log CHI TIẾT để debug: SQLSTATE + message + unit gây lỗi
      console.error('[submit-unit] LỖI:', sqlstate || '(no-code)', '-', e?.message,
                    '| make=', make, '| model=', model_code, '| unit=', unit_key);
      fastify.log.error(`[crawl/submit-unit] ${sqlstate ? '['+sqlstate+'] ' : ''}${e?.message}`);
      // Phân loại lỗi: SQLSTATE class 22 (data exception — vd 22001 "value too long", 22021 "invalid byte")
      //   = payload HỎNG VĨNH VIỄN → trả 400 (permanent) để worker BỎ bản ghi, KHÔNG kẹt queue mãi.
      //   Lỗi khác (mất kết nối 08, deadlock 40, bug server 42, ...) → 500 để worker gửi lại sau.
      const isBadData = sqlstate.startsWith('22');
      return reply.status(isBadData ? 400 : 500)
                  .send({ error: e?.message, code: sqlstate || null, permanent: isBadData });
    } finally {
      client.release();
    }
  });

  // d2b) POST /fitments/import-by-oem — TRA NGƯỢC theo mã OEM: 1 mã → nhiều xe tương thích → tạo fitment.
  //   Dùng cho OEM-extension (cào trang /search PartSouq cho các mã CHƯA có fitment).
  //   Idempotent: vehicle ON CONFLICT DO UPDATE (nới year range), fitment ON CONFLICT DO NOTHING.
  //   LƯU Ý: oem_code phải là MÃ GỐC trong DB (không phải mã đã làm sạch để search) để khớp product.
  fastify.post<{ Body:any }>('/fitments/import-by-oem', async (req, reply) => {
    const b = req.body || {};
    // Làm sạch: bỏ NUL + cắt theo giới hạn varchar (giống submit-unit) — tránh 500 do dữ liệu quá dài.
    const clean = (v:any, max?:number) => {
      if (v == null) return v;
      let s = String(v).replace(/\u0000/g, '').trim();
      if (max && s.length > max) s = s.slice(0, max);
      return s;
    };
    const toInt = (v:any) => { const n = parseInt(String(v ?? '').replace(/[^\d]/g, ''), 10); return Number.isFinite(n) && n > 0 ? n : null; };
    const oem_code = clean(b.oem_code, 100);
    if (!oem_code) return reply.status(400).send({ error: 'Thiếu oem_code' });
    const vehicles: any[] = Array.isArray(b.vehicles) ? b.vehicles : [];

    const client = await pool.connect();
    try {
      // 1) Tìm product theo oem_code (exact). catalog_products KHÔNG unique oem_code (chỉ PK id) → LIMIT 1.
      const pr = await client.query(
        `SELECT id FROM catalog_products WHERE oem_code = $1 ORDER BY id LIMIT 1`, [oem_code]
      );
      if (!pr.rows[0]) {
        return reply.send({ ok:true, oem_code, product_found:false, imported:0,
          vehicles_received:vehicles.length, skipped:vehicles.length,
          message:'Không tìm thấy sản phẩm theo oem_code' });
      }
      const product_id = pr.rows[0].id;

      await client.query('BEGIN');
      let imported = 0, skipped = 0;
      for (const raw of vehicles) {
        const make       = clean(raw?.make, 100);
        const model_code = clean(raw?.model_code, 100);
        const model_name = clean(raw?.model_name, 200);
        // catalog_vehicles: make & model_code là NOT NULL → thiếu 1 trong 2 thì KHÔNG chèn được → bỏ qua.
        if (!make || !model_code) { skipped++; continue; }
        const yf = toInt(raw?.year_from), yt = toInt(raw?.year_to);
        const veh = await client.query(`
          INSERT INTO catalog_vehicles (make, model_name, model_code, year_from, year_to, vehicle_type, created_at, updated_at)
          VALUES ($1,$2,$3,$4,$5,'car',NOW(),NOW())
          ON CONFLICT (make, model_code) DO UPDATE SET
            model_name = COALESCE(catalog_vehicles.model_name, EXCLUDED.model_name),
            year_from  = LEAST(catalog_vehicles.year_from,  EXCLUDED.year_from),
            year_to    = GREATEST(catalog_vehicles.year_to, EXCLUDED.year_to),
            updated_at = NOW()
          RETURNING id
        `, [make, model_name || null, model_code, yf, yt]);
        const vehicle_id = veh.rows[0].id;
        // fitment idempotent (UNIQUE product_id, vehicle_id). RETURNING id → đếm ĐÚNG fitment MỚI tạo.
        const fr = await client.query(
          `INSERT INTO catalog_fitments (product_id, vehicle_id, notes)
           VALUES ($1,$2,'partsouq-oem') ON CONFLICT (product_id, vehicle_id) DO NOTHING RETURNING id`,
          [product_id, vehicle_id]
        );
        if (fr.rows.length) imported++;
      }
      await client.query('COMMIT');
      return reply.send({ ok:true, oem_code, product_found:true, product_id,
        imported, vehicles_received:vehicles.length, skipped });
    } catch(e:any) {
      await client.query('ROLLBACK').catch(()=>{});
      const sqlstate: string = e?.code || '';
      console.error('[import-by-oem] LỖI:', sqlstate || '(no-code)', '-', e?.message, '| oem=', oem_code);
      fastify.log.error(`[fitments/import-by-oem] ${sqlstate ? '['+sqlstate+'] ' : ''}${e?.message}`);
      const isBadData = sqlstate.startsWith('22');   // lỗi dữ liệu (vĩnh viễn) → 400; còn lại → 500
      return reply.status(isBadData ? 400 : 500).send({ error: e?.message, code: sqlstate || null, permanent: isBadData });
    } finally {
      client.release();
    }
  });

  // d3) POST /crawl/mark-model — đánh dấu model đã cào xong (mọi unit) vào catalog_crawl_log
  fastify.post<{ Body:any }>('/crawl/mark-model', async (req, reply) => {
    try {
      const { make, model_code, model_line, parts_count=0 } = req.body || {};
      if (!make || !model_code) return reply.status(400).send({ error: 'Thiếu make hoặc model_code' });
      await pool.query(`
        INSERT INTO catalog_crawl_log (make, model_code, model_line, parts_count, source)
        VALUES ($1,$2,$3,$4,'partsouq')
        ON CONFLICT (make, model_code, source) DO UPDATE SET parts_count=EXCLUDED.parts_count, scraped_at=NOW()
      `, [make, model_code, model_line || null, parts_count]);
      return reply.send({ ok:true });
    } catch(e:any) { fastify.log.error('[crawl/mark-model] '+e.message); return reply.status(500).send({ error:e.message }); }
  });

  // e) POST /crawl/finish-job — báo job xong
  fastify.post<{ Body: { job_id:number; status:string; parts_found?:number; models_found?:number; error?:string } }>(
    '/crawl/finish-job', async (req, reply) => {
      try {
        const { job_id, status, parts_found=0, models_found=0, error } = req.body || {};
        if (!job_id || !status) return reply.status(400).send({ error: 'Thiếu job_id hoặc status' });

        // status='retry' (Cloudflare chặn) → trả job về PENDING để cào lại; nếu đã >=5 lần → mới failed
        if (status === 'retry') {
          const r = await pool.query(`
            UPDATE catalog_crawl_jobs
            SET status      = CASE WHEN attempts >= 5 THEN 'failed' ELSE 'pending' END,
                claimed_by  = NULL,
                claimed_at  = NULL,
                attempts    = attempts + 1,
                finished_at = CASE WHEN attempts >= 5 THEN NOW() ELSE NULL END,
                error       = $2
            WHERE id = $1 RETURNING id, status, attempts
          `, [job_id, error || null]);
          if (!r.rows.length) return reply.status(404).send({ error: 'Không thấy job' });
          const jr = r.rows[0];
          return reply.send({ ok:true, job:jr, retried: jr.status === 'pending',
            note: jr.status === 'failed' ? 'failed sau >=5 lần Cloudflare chặn' : 'trả về pending cào lại' });
        }

        const st = (status === 'done' || status === 'failed') ? status : 'done';
        const r = await pool.query(`
          UPDATE catalog_crawl_jobs SET status=$2, finished_at=NOW(), parts_found=$3, models_found=$4, error=$5
          WHERE id=$1 RETURNING *
        `, [job_id, st, parts_found, models_found, error || null]);
        if (!r.rows.length) return reply.status(404).send({ error: 'Không thấy job' });
        // Job done → tính coverage phụ tùng cho model_line (async, KHÔNG block response, KHÔNG auto-requeue).
        if (st === 'done') {
          const jr = r.rows[0];
          runCoverageCheck(pool, jr.id, jr.make, jr.model_line).catch(() => {});
        }
        return reply.send({ ok:true, job:r.rows[0] });
      } catch(e:any) { fastify.log.error('[crawl/finish-job] '+e.message); return reply.status(500).send({ error:e.message }); }
    }
  );

  // ── Heartbeat + điều khiển VPS worker (poll-based, KHÔNG cần SSH) ──────────────
  // g1) POST /crawl/heartbeat — VPS báo còn sống (mỗi ~60s), server trả về `command` hiện tại.
  fastify.post<{ Body:any }>('/crawl/heartbeat', async (req, reply) => {
    try {
      const b = req.body || {};
      const worker_id = String(b.worker_id || '').trim();
      if (!worker_id) return reply.status(400).send({ error: 'worker_id required' });
      const status      = String(b.status || 'idle').slice(0, 40);
      const current_job = String(b.current_job || '').slice(0, 500);
      const parts_hour  = Number.isFinite(+b.parts_hour) ? Math.max(0, Math.trunc(+b.parts_hour)) : 0;
      // Upsert heartbeat + LẤY LẠI command trong CÙNG 1 query (RETURNING) — tránh race đọc-sau-ghi.
      const r = await pool.query(`
        INSERT INTO catalog_worker_heartbeat (worker_id, status, current_job, parts_hour, last_seen)
        VALUES ($1,$2,$3,$4,NOW())
        ON CONFLICT (worker_id) DO UPDATE SET
          status      = EXCLUDED.status,
          current_job = EXCLUDED.current_job,
          parts_hour  = EXCLUDED.parts_hour,
          last_seen   = NOW()
        RETURNING command
      `, [worker_id, status, current_job, parts_hour]);
      return reply.send({ ok: true, command: r.rows[0]?.command || 'continue' });
    } catch (e:any) { fastify.log.error('[crawl/heartbeat] '+e.message); return reply.status(500).send({ error: e.message }); }
  });

  // g2) GET /crawl/workers — danh sách VPS (cho dashboard), kèm seconds_ago để tính online/offline.
  fastify.get('/crawl/workers', async (_req, reply) => {
    try {
      const r = await pool.query(`
        SELECT worker_id, status, current_job, parts_hour, command, last_seen,
               EXTRACT(EPOCH FROM (NOW() - last_seen))::int AS seconds_ago
        FROM catalog_worker_heartbeat
        ORDER BY last_seen DESC
      `);
      return reply.send(r.rows);
    } catch (e:any) { fastify.log.error('[crawl/workers] '+e.message); return reply.status(500).send({ error: e.message }); }
  });

  // g3) POST /crawl/worker-command — admin ra lệnh cho 1 VPS (continue|restart|idle|stop).
  fastify.post<{ Body:any }>('/crawl/worker-command', async (req, reply) => {
    try {
      const b = req.body || {};
      const worker_id = String(b.worker_id || '').trim();
      const command   = String(b.command || '').trim();
      if (!worker_id || !command) return reply.status(400).send({ error: 'worker_id + command required' });
      if (!['continue','restart','idle','stop'].includes(command)) return reply.status(400).send({ error: 'command không hợp lệ' });
      const r = await pool.query(
        `UPDATE catalog_worker_heartbeat SET command = $1 WHERE worker_id = $2 RETURNING worker_id`,
        [command, worker_id]
      );
      if (!r.rows.length) return reply.status(404).send({ error: 'worker_id chưa từng heartbeat' });
      return reply.send({ ok: true, worker_id, command });
    } catch (e:any) { fastify.log.error('[crawl/worker-command] '+e.message); return reply.status(500).send({ error: e.message }); }
  });

  // f) GET /crawl/stats — dashboard theo dõi
  fastify.get('/crawl/stats', async (_req, reply) => {
    try {
      const [jobs, crawled, workers] = await Promise.all([
        pool.query(`SELECT status, COUNT(*)::int cnt, COALESCE(SUM(parts_found),0)::int parts FROM catalog_crawl_jobs GROUP BY status`),
        pool.query(`SELECT COUNT(*)::int models, COALESCE(SUM(parts_count),0)::int parts FROM catalog_crawl_log`),
        pool.query(`SELECT claimed_by, COUNT(*)::int running, MAX(claimed_at) last_at FROM catalog_crawl_jobs WHERE status='running' GROUP BY claimed_by ORDER BY running DESC`),
      ]);
      const byStatus:any = { pending:0, running:0, done:0, failed:0 };
      let total = 0, partsFound = 0;
      for (const r of jobs.rows) { byStatus[r.status] = r.cnt; total += r.cnt; partsFound += r.parts; }
      return reply.send({
        jobs: { total, ...byStatus, parts_found: partsFound },
        crawled: { models: crawled.rows[0].models, parts: crawled.rows[0].parts },
        workers: workers.rows,
      });
    } catch(e:any) { fastify.log.error('[crawl/stats] '+e.message); return reply.status(500).send({ error:e.message }); }
  });

  // g) GET /crawl/dashboard — số liệu tổng hợp cho trang theo dõi tiến độ (CHỈ ĐỌC).
  //    Tối ưu để KHÔNG làm chậm việc cào:
  //     • Tổng products/fitments (bảng 1.3tr / 22tr) dùng reltuples (ước lượng tức thì) —
  //       KHÔNG COUNT full (mà crmuser cũng không sở hữu 2 bảng này để đánh index created_at).
  //     • Tốc độ (theo giờ/10 phút) lấy từ catalog_crawl_unit_log (đã đánh index scraped_at)
  //       + catalog_model_claim (index finished_at) — bảng nhỏ, crmuser sở hữu → nhanh, có index.
  //     • Cache toàn bộ kết quả 5s: nhiều tab mở cùng lúc chỉ query DB 1 lần / 5s.
  let dashCache: { at:number; data:any } = { at: 0, data: null };
  const DASH_TTL_MS = 5000;
  fastify.get('/crawl/dashboard', async (_req, reply) => {
    try {
      const now = Date.now();
      if (dashCache.data && (now - dashCache.at) < DASH_TTL_MS) {
        return reply.send({ ...dashCache.data, cached: true });
      }
      const t0 = now;
      const [jobsQ, byMakeQ, workersQ, crawledQ, estQ, speedQ, modelsDoneQ, recentQ, workerPartsQ, unassignedQ] = await Promise.all([
        // jobs theo status
        pool.query(`SELECT status, COUNT(*)::int cnt FROM catalog_crawl_jobs GROUP BY status`),
        // jobs theo hãng
        pool.query(`
          SELECT make,
            COUNT(*) FILTER (WHERE status='pending')::int pending,
            COUNT(*) FILTER (WHERE status='running')::int running,
            COUNT(*) FILTER (WHERE status='done')::int    done,
            COUNT(*) FILTER (WHERE status='failed')::int  failed,
            COUNT(*)::int total
          FROM catalog_crawl_jobs GROUP BY make
          ORDER BY pending DESC, make ASC LIMIT 100`),
        // workers từ khóa model
        pool.query(`
          SELECT claimed_by AS worker_id,
            COUNT(*) FILTER (WHERE status='crawling')::int crawling,
            COUNT(*) FILTER (WHERE status='done')::int     done_models,
            MAX(claimed_at) AS last_seen
          FROM catalog_model_claim WHERE claimed_by IS NOT NULL
          GROUP BY claimed_by ORDER BY crawling DESC, done_models DESC`),
        // sản phẩm cào về (chưa bán) — dùng index idx_products_sale, nhanh
        pool.query(`SELECT COUNT(*)::int c FROM catalog_products WHERE is_for_sale=false`),
        // ước lượng tổng bảng lớn (tức thì, không scan)
        pool.query(`
          SELECT relname, GREATEST(reltuples,0)::bigint AS est
          FROM pg_class
          WHERE relnamespace='public'::regnamespace
            AND relname IN ('catalog_products','catalog_fitments','catalog_vehicles')`),
        // tốc độ: part submit theo unit (index scraped_at)
        pool.query(`
          SELECT
            COALESCE(SUM(parts_count) FILTER (WHERE scraped_at > NOW()-INTERVAL '1 hour'),0)::int    parts_last_hour,
            COALESCE(SUM(parts_count) FILTER (WHERE scraped_at > NOW()-INTERVAL '10 minutes'),0)::int parts_last_10min,
            COUNT(*) FILTER (WHERE scraped_at > NOW()-INTERVAL '1 hour')::int    units_last_hour,
            COUNT(*) FILTER (WHERE scraped_at > NOW()-INTERVAL '10 minutes')::int units_last_10min
          FROM catalog_crawl_unit_log
          WHERE scraped_at > NOW()-INTERVAL '1 hour'`),
        // model xong / giờ (index finished_at)
        pool.query(`SELECT COUNT(*)::int c FROM catalog_model_claim WHERE finished_at > NOW()-INTERVAL '1 hour'`),
        // 20 model gần đây (đang cào / vừa xong)
        pool.query(`
          SELECT make, model_key, claimed_by, status, finished_at, claimed_at
          FROM catalog_model_claim
          ORDER BY COALESCE(finished_at, claimed_at) DESC LIMIT 20`),
        // part/unit theo TỪNG VPS (từ unit_log.worker_id) — 3 số: cào được / mới thật / fitment mới
        pool.query(`
          SELECT worker_id,
            COUNT(*)::int                        units_total,
            COALESCE(SUM(parts_total),0)::int    parts_total,
            COALESCE(SUM(parts_new),0)::int      parts_new,
            COALESCE(SUM(fitments_new),0)::int   fitments_new,
            COUNT(*) FILTER (WHERE scraped_at > NOW()-INTERVAL '1 hour')::int                        units_last_hour,
            COALESCE(SUM(parts_total)  FILTER (WHERE scraped_at > NOW()-INTERVAL '1 hour'),0)::int   parts_total_last_hour,
            COALESCE(SUM(fitments_new) FILTER (WHERE scraped_at > NOW()-INTERVAL '1 hour'),0)::int   fitments_new_last_hour
          FROM catalog_crawl_unit_log
          WHERE worker_id IS NOT NULL
          GROUP BY worker_id`),
        // unit/part CHƯA gán VPS (dữ liệu cũ trước khi có cột worker_id)
        pool.query(`
          SELECT COUNT(*)::int units, COALESCE(SUM(parts_total),0)::int parts, COALESCE(SUM(fitments_new),0)::int fitments
          FROM catalog_crawl_unit_log WHERE worker_id IS NULL`),
      ]);

      const jobs:any = { pending:0, running:0, done:0, failed:0, total:0 };
      for (const r of jobsQ.rows) { jobs[r.status] = r.cnt; jobs.total += r.cnt; }

      const est:any = {};
      for (const r of estQ.rows) est[r.relname] = Number(r.est);

      const sp = speedQ.rows[0] || {};

      // Gộp 2 nguồn worker: model_claim (crawling/done_models/last_seen) + unit_log (part/unit theo VPS).
      // Một VPS có thể chỉ có ở 1 nguồn → union theo worker_id. Sắp theo PART ĐÃ GỬI giảm dần.
      const wmap = new Map<string, any>();
      const blankW = (id:string) => ({ worker_id:id, crawling:0, done_models:0, last_seen:null,
        parts_total:0, parts_new:0, fitments_new:0, units_total:0,
        parts_total_last_hour:0, fitments_new_last_hour:0, units_last_hour:0 });
      for (const r of workersQ.rows) {
        const w = wmap.get(r.worker_id) || blankW(r.worker_id);
        w.crawling = r.crawling; w.done_models = r.done_models; w.last_seen = r.last_seen;
        wmap.set(r.worker_id, w);
      }
      for (const r of workerPartsQ.rows) {
        const w = wmap.get(r.worker_id) || blankW(r.worker_id);
        w.parts_total = r.parts_total; w.parts_new = r.parts_new; w.fitments_new = r.fitments_new;
        w.units_total = r.units_total; w.units_last_hour = r.units_last_hour;
        w.parts_total_last_hour = r.parts_total_last_hour; w.fitments_new_last_hour = r.fitments_new_last_hour;
        wmap.set(r.worker_id, w);
      }
      const workers = [...wmap.values()].sort((a,b) =>
        (b.parts_total - a.parts_total) || (b.fitments_new - a.fitments_new) || (b.crawling - a.crawling));
      const un = unassignedQ.rows[0] || { units:0, parts:0, fitments:0 };

      const data = {
        jobs,
        jobs_by_make: byMakeQ.rows,
        workers,
        workers_unassigned: { units: un.units, parts: un.parts, fitments: un.fitments },   // dữ liệu cũ chưa gán VPS
        totals: {
          products_total : est['catalog_products'] || 0,
          products_crawled: crawledQ.rows[0].c,
          fitments_total : est['catalog_fitments'] || 0,
          vehicles_total : est['catalog_vehicles'] || 0,
        },
        speed: {
          // Nguồn = catalog_crawl_unit_log.parts_count (số part submit) ≈ fitment tạo ra.
          // (Không COUNT catalog_fitments 22tr vì không có index created_at + crmuser không sở hữu bảng.)
          fitments_last_hour : sp.parts_last_hour  || 0,
          fitments_last_10min: sp.parts_last_10min || 0,
          units_last_hour    : sp.units_last_hour  || 0,
          units_last_10min   : sp.units_last_10min || 0,
          models_done_last_hour: modelsDoneQ.rows[0].c,
        },
        speed_note: 'fitments_last_* = số part submit theo unit (catalog_crawl_unit_log), xấp xỉ số fitment tạo ra; tổng products/fitments là ước lượng reltuples.',
        recent_models: recentQ.rows,
        generated_at: new Date().toISOString(),
        build_ms: Date.now() - t0,
        cached: false,
      };
      dashCache = { at: now, data };
      return reply.send(data);
    } catch(e:any) { fastify.log.error('[crawl/dashboard] '+e.message); return reply.status(500).send({ error:e.message }); }
  });

  // ============================================================
  // GET /fitment-matrix — ma tran phu song phu tung theo model xe
  //   ?make=Toyota (bat buoc) &model_name=INNOVA (optional, ILIKE) &page=1 &limit=100 (max 500)
  //   Tra { data:[{model_code,model_name,make,year_from,year_to,total_parts, <50 bool danh muc>}], total,page,limit,totalPages }
  // ============================================================
  fastify.get<{ Querystring: { make?:string; model_name?:string; page?:string; limit?:string } }>(
    '/fitment-matrix', async (req, reply) => {
      const { make, model_name, page='1', limit='100' } = req.query;
      if (!make) return reply.status(400).send({ error: 'make is required' });

      const pageNum     = Math.max(1, parseInt(page)  || 1);
      const limitNum    = Math.min(500, Math.max(1, parseInt(limit) || 100));
      const offset      = (pageNum - 1) * limitNum;
      const modelFilter = (model_name && model_name.trim()) ? model_name.trim() : null;

      // Query nang (BOOL_OR ~50 danh muc ILIKE). Chay trong transaction co statement_timeout de
      // KHONG giu connection cua pool (dung chung voi worker cao) qua lau khi gap model day / limit lon.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL statement_timeout = '30s'");
        const result = await client.query(FITMENT_MATRIX_SQL, [make, modelFilter, limitNum, offset]);
        await client.query('COMMIT');

        // total = COUNT(*) xe khop filter (cot 'total' gan tren moi dong) → bo khoi tung dong truoc khi tra.
        const total = result.rows.length > 0 ? parseInt(result.rows[0].total) : 0;
        const data  = result.rows.map((r:any) => { delete r.total; return r; });

        return reply.send({
          data,
          total,
          page : pageNum,
          limit: limitNum,
          totalPages: Math.ceil(total / limitNum),
        });
      } catch (e:any) {
        try { await client.query('ROLLBACK'); } catch {}
        if (e.code === '57014') {   // statement_timeout → query bi huy
          fastify.log.warn(`[fitment-matrix] timeout make=${make} model=${modelFilter} limit=${limitNum}`);
          return reply.status(503).send({
            error: 'Query qua lau (model qua nhieu fitment). Hay loc model_name cu the hon hoac giam limit.',
          });
        }
        fastify.log.error('[fitment-matrix] ' + e.message);
        return reply.status(500).send({ error: e.message });
      } finally {
        client.release();
      }
    }
  );

  // ============================================================
  // COVERAGE — độ phủ phụ tùng theo model_line (TÍN HIỆU THAM KHẢO, xem coverage-check.ts)
  // ============================================================
  // GET /coverage-summary?make=Toyota — tổng quan theo hãng (chỉ job status=done)
  fastify.get<{ Querystring: { make?: string } }>('/coverage-summary', async (req, reply) => {
    try {
      const { make } = req.query;
      const sql = `
        SELECT make,
          COUNT(*)::int                                                        AS total_done,
          COUNT(coverage_score)::int                                           AS checked,
          ROUND(AVG(coverage_score), 1)                                        AS avg_score,
          COUNT(*) FILTER (WHERE coverage_score >= 30)::int                    AS sufficient,
          COUNT(*) FILTER (WHERE coverage_score < 30 AND coverage_score IS NOT NULL)::int AS insufficient,
          COUNT(*) FILTER (WHERE coverage_score IS NULL)::int                  AS not_checked
        FROM catalog_crawl_jobs
        WHERE status = 'done' ${make ? 'AND make = $1' : ''}
        GROUP BY make ORDER BY total_done DESC`;
      const r = make ? await pool.query(sql, [make]) : await pool.query(sql);
      return reply.send({ data: r.rows });
    } catch (e:any) { fastify.log.error('[coverage-summary] ' + e.message); return reply.status(500).send({ error: e.message }); }
  });

  // GET /coverage-insufficient?make=Toyota&limit=100&page=1 — job done nhưng coverage thấp (<30/50)
  fastify.get<{ Querystring: { make?: string; limit?: string; page?: string } }>('/coverage-insufficient', async (req, reply) => {
    try {
      const { make, limit = '100', page = '1' } = req.query;
      const lim    = Math.min(500, Math.max(1, parseInt(limit) || 100));
      const offset = (Math.max(1, parseInt(page) || 1) - 1) * lim;
      const params: any[] = make ? [make, lim, offset] : [lim, offset];
      const sql = `
        SELECT make, model_line, coverage_score, missing_parts, parts_found, attempts, coverage_checked_at
        FROM catalog_crawl_jobs
        WHERE status = 'done' AND coverage_score < 30 ${make ? 'AND make = $1' : ''}
        ORDER BY coverage_score ASC, parts_found ASC
        LIMIT $${make ? 2 : 1} OFFSET $${make ? 3 : 2}`;
      const r = await pool.query(sql, params);
      return reply.send({ data: r.rows });
    } catch (e:any) { fastify.log.error('[coverage-insufficient] ' + e.message); return reply.status(500).send({ error: e.message }); }
  });
}