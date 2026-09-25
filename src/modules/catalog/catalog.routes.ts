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
// name_vi PHAI co o day — thieu no thi moi endpoint dung PRODUCT_COLS (by-code,
// by-multi-code, by-vin, by-model, clarify...) deu tra ve KHONG co ten tieng
// Viet, frontend chi con p.name (tieng Anh) de hien thi du DB da co san ban dich.
const PRODUCT_COLS = `
  p.id, p.name, p.name_vi, p.name_vi_cho, p.internal_ref, p.oem_code, p.is_for_sale,
  p.product_type, p.brand, p.unit, p.notes, p.created_at, p.updated_at
`.trim();

// Load compatible_vehicles cho 1 product (chi dung trong detail)
// Bộ nhớ đệm cho /crawl/*/stats. Trang tiến độ tự làm mới 10s/lần, mỗi lần
// quét ~6tr dòng hàng chờ 2 lượt (song song) — trên máy 8GB đã làm Postgres
// hết RAM và tắt hẳn (2026-09-25). Số liệu tiến độ cũ 60s không sao.
const DEM_TTL_MS = 60_000;
const boDem = new Map<string, { luc: number; data: any }>();
function layDem(k: string) {
  const x = boDem.get(k);
  return x && Date.now() - x.luc < DEM_TTL_MS ? x.data : null;
}
function luuDem(k: string, data: any) {
  boDem.set(k, { luc: Date.now(), data });
  return data;
}

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

// Load MÃ thay thế (product ↔ mã) cho 1 product — khác loadAlternatives ở trên
// vốn là product ↔ product. Mã ở đây có thể CHƯA tồn tại như một sản phẩm trong
// DB (mã của hãng khác, cào từ PartSouq), nên không nối được qua catalog_alternatives.
// co_hang: mã đó có bán trong kho không → giao diện chỉ cho bấm khi có.
// la_hang_xe: mã này của HÃNG XE (Toyota, Nissan...) hay HÃNG PHỤ TÙNG
// (FEBEST, AISIN, NiBK...)? Không cần thêm cột — đối chiếu make với danh sách
// hãng trong catalog_vehicles là đủ. Khách cần biết mã nào là chính hãng,
// mã nào là hàng thay thế; chỉ in tên hãng ra thì người không trong ngành
// không phân biệt được.
async function loadOemCodes(productId: string): Promise<any[]> {
  const res = await pool.query(`
    SELECT o.oem_code, o.make, o.source,
           sp.id AS product_id, sp.name AS product_name,
           (hx.make IS NOT NULL) AS la_hang_xe
    FROM catalog_oem_codes o
    -- JOIN vào danh sách hãng distinct thay vì EXISTS tương quan: EXISTS bị
    -- planner chạy seq scan cả catalog_vehicles cho TỪNG mã (1.2s / 50 mã).
    LEFT JOIN (SELECT DISTINCT lower(make) AS make FROM catalog_vehicles) hx
           ON hx.make = lower(o.make)
    LEFT JOIN catalog_products sp
           ON sp.ref_norm = o.oem_norm AND sp.is_for_sale = TRUE
    WHERE o.product_id = $1
    ORDER BY (sp.id IS NULL), o.make NULLS LAST, o.oem_code
    LIMIT 50
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
  ['piston',          `t.txt LIKE ANY(ARRAY['%piston%'])`],
  ['sec_mang',        `t.txt LIKE ANY(ARRAY['%ring set%','%piston ring%']) OR t.txt LIKE '%séc măng%'`],
  ['bien_balie',      `t.txt LIKE ANY(ARRAY['%connecting rod%','%con rod%']) OR t.txt LIKE ANY(ARRAY['%biên%','%balie%'])`],
  ['gioang_dai_tu',   `t.txt LIKE ANY(ARRAY['%gasket kit%','%overhaul%'])`],
  ['loc_dau',         `t.txt LIKE ANY(ARRAY['%oil filter%','%filter, oil%'])`],
  ['loc_nhien_lieu',  `t.txt LIKE ANY(ARRAY['%fuel filter%','%filter, fuel%'])`],
  ['loc_gio',         `t.txt LIKE ANY(ARRAY['%air filter%','%filter, air%','%air cleaner%'])`],
  ['bom_dau',         `t.txt LIKE ANY(ARRAY['%oil pump%','%pump, oil%'])`],
  ['bom_nuoc',        `t.txt LIKE ANY(ARRAY['%water pump%','%pump, water%'])`],
  ['bugi',            `t.txt LIKE ANY(ARRAY['%spark plug%','%plug, spark%'])`],
  ['mobin',           `t.txt LIKE ANY(ARRAY['%ignition coil%','%coil, ignition%'])`],
  ['kim_phun',        `t.txt LIKE ANY(ARRAY['%injector%','%injection nozzle%'])`],
  ['bom_nhien_lieu',  `t.txt LIKE ANY(ARRAY['%fuel pump%','%pump, fuel%'])`],
  ['turbo',           `t.txt LIKE ANY(ARRAY['%turbo%','%turbocharger%'])`],
  ['curoa_cam',       `t.txt LIKE ANY(ARRAY['%timing belt%','%cam belt%','%belt, timing%'])`],
  ['curoa_tong',      `t.txt LIKE ANY(ARRAY['%v-belt%','%drive belt%']) AND LOWER(p.name) NOT ILIKE '%timing%'`],
  ['curoa_phu',       `t.txt LIKE ANY(ARRAY['%fan belt%','%accessory belt%','%alternator belt%','%a/c belt%']) AND LOWER(p.name) NOT ILIKE '%timing%'`],
  ['bi_tang_cam',     `t.txt LIKE ANY(ARRAY['%tensioner%','%idler%']) AND t.txt LIKE ANY(ARRAY['%timing%','%cam%','%belt%'])`],
  ['ket_nuoc',        `t.txt LIKE '%radiator%'`],
  ['ket_mat_dau',     `t.txt LIKE ANY(ARRAY['%oil cooler%','%cooler, oil%'])`],
  ['mo_to_quat',      `t.txt LIKE ANY(ARRAY['%fan motor%','%motor, fan%','%cooling fan%'])`],
  ['may_phat',        `t.txt LIKE ANY(ARRAY['%alternator%','%generator%'])`],
  ['may_de',          `t.txt LIKE ANY(ARRAY['%starter%','%starting motor%'])`],
  ['hop_so',          `t.txt LIKE ANY(ARRAY['%transmission%','%gearbox%','%transaxle%'])`],
  ['cay_lap',         `t.txt LIKE ANY(ARRAY['%drive shaft%','%axle shaft%','%half shaft%'])`],
  ['bi_lap_moay_o',   `t.txt LIKE ANY(ARRAY['%hub bearing%','%wheel bearing%'])`],
  ['dia_con_ban_ep',  `t.txt LIKE ANY(ARRAY['%clutch disc%','%pressure plate%','%release bearing%'])`],
  ['tong_con',        `t.txt LIKE ANY(ARRAY['%clutch master%','%master cylinder, clutch%'])`],
  ['loc_dau_hop_so',  `t.txt LIKE ANY(ARRAY['%oil filter%']) AND t.txt LIKE ANY(ARRAY['%transm%','%gear%','%atf%'])`],
  ['truc_cac_dang',   `t.txt LIKE '%propeller shaft%' OR t.txt LIKE '%prop shaft%'`],
  ['cau_sau',         `t.txt LIKE ANY(ARRAY['%differential%','%rear axle%'])`],
  ['giam_soc',        `t.txt LIKE ANY(ARRAY['%shock absorber%','%strut%','%damper%'])`],
  ['lo_xo',           `t.txt LIKE ANY(ARRAY['%coil spring%','%spring, coil%'])`],
  ['cang_a',          `t.txt LIKE ANY(ARRAY['%control arm%','%lower arm%','%upper arm%'])`],
  ['ro_tuyn_can_bang',`t.txt LIKE ANY(ARRAY['%stabilizer link%','%sway bar link%'])`],
  ['ma_phanh',        `t.txt LIKE ANY(ARRAY['%brake pad%','%pad kit%'])`],
  ['dia_phanh',       `t.txt LIKE ANY(ARRAY['%brake disc%','%brake rotor%'])`],
  ['guoc_phanh',      `t.txt LIKE ANY(ARRAY['%brake shoe%','%shoe, brake%'])`],
  ['tong_phanh',      `t.txt LIKE '%master cylinder%' AND LOWER(p.name) NOT ILIKE '%clutch%'`],
  ['abs',             `t.txt LIKE ANY(ARRAY['%abs%','%anti-lock%','%actuator, brake%']) AND LOWER(p.name) NOT ILIKE '%absorber%'`],
  ['thuoc_lai',       `t.txt LIKE ANY(ARRAY['%steering rack%','%rack assy%','%gear assy, rack%'])`],
  ['ro_tuyn_lai',     `t.txt LIKE ANY(ARRAY['%tie rod%','%tie-rod%','%rack end%'])`],
  ['bom_tro_luc',     `t.txt LIKE ANY(ARRAY['%power steering pump%','%vane pump%'])`],
  ['loc_lanh',        `t.txt LIKE '%compressor%' AND LOWER(p.name) NOT ILIKE '%ac compressor%'`],
  ['dan_nong',        `t.txt LIKE '%condenser%'`],
  ['dan_lanh',        `t.txt LIKE '%evaporator%'`],
  ['ac_quy',          `t.txt LIKE '%battery%'`],
  ['den_chieu_sang',  `t.txt LIKE ANY(ARRAY['%headlamp%','%headlight%','%tail lamp%','%fog lamp%','%bulb%'])`],
  ['cam_bien',        `t.txt LIKE ANY(ARRAY['%sensor%','%switch%'])`],
  ['tui_khi',         `t.txt LIKE ANY(ARRAY['%airbag%','%air bag%'])`],
];

// Xay SQL 1 lan luc load module (khong dung lai moi request). Chien luoc toi uu (cung ket qua,
// nhanh hon nhieu so voi "match tung dong fitment"):
//   1) CTE page: phan trang XE truoc → chi tong hop dung co trang (LIMIT), khong quet toan bo.
//   2) CTE prod: tag moi SAN PHAM DISTINCT dung 1 lan (cac bien the cung model dung chung phan lon
//      phu tung → so san pham distinct nho hon nhieu so voi so dong fitment).
//   3) BOOL_OR(prod.x) gop theo xe. total_parts = so product distinct/xe; total = tong xe khop filter.
// ĐỌC ma trận — chỉ lấy kết quả đã tính sẵn trong catalog_fitment_matrix.
// Không dò chữ gì ở đây nữa nên nhanh bất kể bao nhiêu xe.
const FITMENT_MATRIX_SQL = (() => {
  const bits = MATRIX_CATEGORIES.map(([a], i) =>
    `      (COALESCE(m.mask,0) & (1::bigint << ${i})) <> 0 AS ${a}`).join(',\n');
  return `
    WITH page AS (
      SELECT id, model_code, model_name, make, year_from, year_to
      FROM catalog_vehicles
      WHERE make = $1 AND ($2::text IS NULL OR model_name ILIKE '%' || $2 || '%')
      ORDER BY model_name, model_code, year_from, id
      LIMIT $3 OFFSET $4
    )
    SELECT
      pg.model_code, pg.model_name, pg.make, pg.year_from, pg.year_to,
      COALESCE(m.total_parts, 0) AS total_parts,
      m.updated_at AS matrix_updated_at,
      NULL::int AS coverage_score,
${bits},
      (SELECT COUNT(*) FROM catalog_vehicles v
        WHERE v.make = $1 AND ($2::text IS NULL OR v.model_name ILIKE '%' || $2 || '%')) AS total
    FROM page pg
    LEFT JOIN catalog_fitment_matrix m ON m.vehicle_id = pg.id
    ORDER BY pg.model_name, pg.model_code, pg.year_from, pg.id`;
})();

// TÍNH ma trận — chỗ DUY NHẤT còn dò 122 mẫu chữ. Chạy sau khi nạp dữ liệu.
// Gộp sẵn tên Việt + tên gốc tiếng Anh + mã rồi hạ chữ thường MỘT LẦN:
//  - cột name nay ưu tiên tiếng Việt (xem scripts/nap_json.py) nên dò riêng
//    nó là trượt hết — phụ tùng tên "bugi" bị đánh thiếu dù thực tế có;
//    bản tiếng Anh nằm trong search_text
//  - LIKE trên chuỗi đã lower() nhanh hơn ILIKE vì không phải gấp chữ lại
//    ở từng phép so
const FITMENT_MATRIX_BUILD_SQL = (() => {
  const bitExpr = MATRIX_CATEGORIES.map(([, e], i) =>
    `        CASE WHEN ${e} THEN (1::bigint << ${i}) ELSE 0 END`).join(' |\n');
  return `
    INSERT INTO catalog_fitment_matrix (vehicle_id, total_parts, mask, updated_at)
    SELECT f.vehicle_id,
           COUNT(DISTINCT f.product_id)::int,
           COALESCE(BIT_OR(
${bitExpr}
           ), 0),
           now()
    FROM catalog_fitments f
    JOIN catalog_products p ON p.id = f.product_id
    CROSS JOIN LATERAL (
      SELECT lower(COALESCE(p.search_text,'') || ' ' ||
                   COALESCE(p.name,'')        || ' ' ||
                   COALESCE(p.name_vi,'')     || ' ' ||
                   COALESCE(p.name_vi_cho,'')) AS txt
    ) t
    WHERE ($1::text IS NULL OR f.vehicle_id IN
             (SELECT id FROM catalog_vehicles WHERE make = $1))
    GROUP BY f.vehicle_id
    ON CONFLICT (vehicle_id) DO UPDATE SET
      total_parts = EXCLUDED.total_parts,
      mask        = EXCLUDED.mask,
      updated_at  = now()`;
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

  // Tim san pham thay the theo ma OE — query thang catalog_products, khong qua VIEW
  //
  // Truoc day loc "p.oem_code = ANY(oemCodes)" va LUON tra ve [] — khong phai
  // vi du lieu ban ma vi logic: file PartSouq la catalog chinh hang nen
  // oem_code = internal_ref o moi dong, ma ref_norm co UNIQUE index. Vay
  // "san pham KHAC co cung oem_code" khong ton tai duoc.
  //
  // Quan he ma-thay-the la 1-N nen no nam o bang catalog_oem_codes
  // (migrations/016). Bat cau qua do theo HAI huong, join bang oem_norm/ref_norm
  // (cung cong thuc chuan hoa) nen khop ca khi dinh dang dau gach khac nhau:
  // "13201-39225-B0" = "1320139225B0".
  //   1. Hai san pham cung tro toi mot ma OE  → la hang tuong duong cua nhau
  //   2. Ma OE tro THANG toi internal_ref cua san pham khac → hang chinh hang
  //      ung voi ma do (huong gia tri nhat: ra dung mon hang co the ban)
  async function findAlternativesByOem(results: any[]): Promise<any[]> {
    if (!results.length) return [];
    const ids = results.map((r:any) => r.id);
    // Hai nhanh phai tach bang UNION, KHONG duoc gop bang OR trong dieu kien
    // JOIN: OR chan planner dung index, no roi ve nested-loop 1.5tr vong
    // → 22 giay (da do bang EXPLAIN ANALYZE). Tach ra thi moi nhanh an
    // index rieng (idx_oem_codes_norm / uq_products_ref_norm) → vai ms.
    const res = await pool.query(`
      WITH ma AS (
        SELECT DISTINCT oem_norm FROM catalog_oem_codes
         WHERE product_id = ANY($1::uuid[]) AND oem_norm IS NOT NULL
      ), ung_vien AS (
        SELECT dst.product_id AS id FROM catalog_oem_codes dst
          JOIN ma ON ma.oem_norm = dst.oem_norm
        UNION
        SELECT p2.id FROM catalog_products p2
          JOIN ma ON ma.oem_norm = p2.ref_norm
      )
      SELECT DISTINCT ON (p.name) ${PRODUCT_COLS}
      FROM ung_vien u
      JOIN catalog_products p ON p.id = u.id
      WHERE p.id != ALL($1::uuid[])
        AND p.is_for_sale = TRUE
      ORDER BY p.name, p.internal_ref
      LIMIT 5
    `, [ids]);
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
      // Tìm cả 3 cột tên: name (gốc, thường tiếng Anh), name_vi (kỹ thuật) và
      // name_vi_cho (tên chợ). Khách gõ kiểu nào — "brake pad", "má phanh" hay
      // "bố thắng" — đều phải ra cùng một món.
      if (q) { conds.push(`(unaccent_immutable(p.name) ILIKE unaccent_immutable($${i}) OR unaccent_immutable(p.name_vi) ILIKE unaccent_immutable($${i}) OR unaccent_immutable(p.name_vi_cho) ILIKE unaccent_immutable($${i}) OR p.internal_ref ILIKE $${i} OR p.oem_code ILIKE $${i})`); vals.push(`%${q}%`); i+=1; }
      if (product_type) { conds.push(`p.product_type=$${i++}`); vals.push(product_type); }
      // So khớp CHÍNH XÁC bằng "=" — brand luôn gửi đúng tên hãng lấy từ /stats
      // (VD "Hyundai"), không cần dò gần đúng. idx_products_brand là btree thường,
      // "=" mới tận dụng được index; ILIKE (không phân biệt hoa/thường) hay
      // ILIKE '%...%' đều không dùng được index này trên 5.4tr dòng → buộc quét.
      if (brand) { conds.push(`p.brand = $${i++}`); vals.push(brand); }
      if (is_for_sale!==undefined) { conds.push(`p.is_for_sale=$${i++}`); vals.push(is_for_sale==='true'); }
      const w = conds.join(' AND ');
      // LIMIT/OFFSET NGAY trên catalog_products trước (bảng ~5.4tr dòng), rồi mới đếm
      // fitment cho ĐÚNG các dòng đã LIMIT bằng subquery tương quan — RẺ (chỉ chạy
      // trên vài chục dòng của trang hiện tại).
      // TRƯỚC: LEFT JOIN catalog_fitments (64tr dòng) + GROUP BY toàn bộ tập kết quả
      // RỒI MỚI LIMIT → Postgres phải join+sort/group HẾT trước khi cắt trang, tốn
      // temp file khổng lồ trên đĩa → "No space left on device" khi bảng đã lớn.
      // Có q (tìm theo tên/mã): ÉP lọc bằng MATERIALIZED trước rồi mới sort+limit —
      // không có nó, Postgres hay chọn "quét theo index (is_for_sale,name), lọc dần
      // từng dòng", với từ khoá hiếm phải quét oan hàng trăm nghìn dòng mới đủ LIMIT.
      // KHÔNG q (duyệt thường): NGƯỢC LẠI — dùng thẳng index (is_for_sale,name) cho
      // ORDER BY+LIMIT (đọc đúng vài chục dòng, dừng sớm). Bọc MATERIALIZED ở đây sẽ
      // ép vật liệu hoá gần hết ~5.4tr dòng is_for_sale=true trước khi LIMIT — CHẬM
      // hơn hẳn (đã đo: 0.6s → 8-9s) — nên 2 trường hợp phải tách câu SQL riêng.
      const dataSql = q ? `
          WITH matched AS MATERIALIZED (
            SELECT p.* FROM catalog_products p WHERE ${w}
          )
          SELECT m.*, (SELECT COUNT(*)::int FROM catalog_fitments f WHERE f.product_id = m.id) AS fitment_count
          FROM matched m
          ORDER BY m.name
          LIMIT $${i} OFFSET $${i+1}
        ` : `
          SELECT p.*, (SELECT COUNT(*)::int FROM catalog_fitments f WHERE f.product_id = p.id) AS fitment_count
          FROM catalog_products p
          WHERE ${w}
          ORDER BY p.name
          LIMIT $${i} OFFSET $${i+1}
        `;
      // Duyệt thường (chỉ lọc is_for_sale): COUNT(*) chính xác trên ~6tr dòng mất
      // ~2.8s MỖI lần mở trang. Dùng ước lượng của planner (reltuples, tức thì,
      // lệch <1% sau ANALYZE) — con số chỉ để hiện tổng trang, không cần đúng tuyệt đối.
      // ponytail: ước lượng cả bảng, gồm luôn SP is_for_sale=false (hiện gần như
      // không có); nếu sau này nhiều SP ngừng bán thì chuyển sang bảng đếm có trigger.
      const chiLocBan = !q && !product_type && !brand;
      const cntSql = chiLocBan
        ? `SELECT reltuples::bigint::int AS total FROM pg_class WHERE oid = 'catalog_products'::regclass`
        : `SELECT COUNT(*)::int total FROM catalog_products p WHERE ${w}`;
      const [rows, cnt] = await Promise.all([
        pool.query(dataSql, [...vals, parseInt(limit), off]),
        pool.query(cntSql, chiLocBan ? [] : vals),
      ]);
      return reply.send({ data:rows.rows, total:cnt.rows[0].total, page:parseInt(page), limit:parseInt(limit), totalPages:Math.ceil(cnt.rows[0].total/parseInt(limit)) });
    }
  );

  // GET /products/:id — DETAIL: load compatible_vehicles + alternatives rieng
  fastify.get<{ Params:{id:string}; Querystring:{customer_code?:string; no_price?:string} }>(
    '/products/:id', async (req, reply) => {
      const res = await pool.query(`SELECT * FROM catalog_products WHERE id=$1`, [req.params.id]);
      if (!res.rows.length) return reply.status(404).send({ error: 'Không tìm thấy' });
      const product = res.rows[0];
      // Load vehicles + alternatives + mã thay thế song song
      const [compatible_vehicles, alternatives, oem_codes] = await Promise.all([
        loadCompatibleVehicles(product.id),
        loadAlternatives(product.id),
        loadOemCodes(product.id),
      ]);
      const full = { ...product, compatible_vehicles, alternatives, oem_codes };
      // no_price=1: bỏ qua Bravo. Mã không có giá bên Bravo làm SQL Server chờ
      // đến hết requestTimeout (15s) → giao diện gọi bản này trước để mở ngay,
      // rồi gọi bản đầy đủ để điền giá sau.
      if (req.query.no_price === '1') return reply.send(full);
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
      ON CONFLICT (make,model_code,variant_key) DO UPDATE SET
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
        ON CONFLICT (make,model_code,variant_key) DO UPDATE SET
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
          ON CONFLICT (make,model_code,variant_key) DO UPDATE SET
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
  // Truoc day BO QUA limit, luon lay 2000 dong -> tren bang fitment lon
  // (chuc trieu dong) phai sap xep ca bang moi tra ve duoc. Giao dien goi
  // ham nay moi lan loadAll() nen moi thao tac them/xoa deu cho rat lau.
  fastify.get<{ Querystring:{ limit?:string } }>('/fitments', async (req, reply) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit || '100') || 100, 1), 2000);
    const res = await pool.query(
      `SELECT * FROM catalog_fitments ORDER BY created_at DESC LIMIT $1`, [limit]);
    return reply.send(res.rows);
  });

  fastify.get<{ Params:{id:string} }>('/vehicles/:id/fitments', async (req, reply) => {
    const res = await pool.query(`
      SELECT f.id AS fitment_id, f.notes,
             p.id, p.name, COALESCE(p.name_vi,'') as name_vi,
             COALESCE(p.name_vi_cho,'') as name_vi_cho,
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
  fastify.get<{ Querystring:{make:string; model?:string; year?:string; part:string; customer_code?:string; vehicle_id?:string} }>(
    '/search/by-model', async (req, reply) => {
      const { make, model, year, part, customer_code, vehicle_id } = req.query;
      if (!make||!part) return reply.status(400).send({ error: 'Thiếu make hoặc part' });
      const yearNum = year ? parseInt(year) : null;
      console.log(`[by-model] make=${make} model=${model} year=${yearNum} part=${part} vehicle_id=${vehicle_id||''}`);

      const allPartNames = await resolvePartName(part);
      const BASE = 6;
      // Tìm cả 3 cột tên — khách gõ tiếng Anh, tên kỹ thuật hay tên chợ đều ra.
      const partILIKE = allPartNames.map((_:string, i:number) =>
        `(unaccent_immutable(p.name) ILIKE unaccent_immutable($${BASE+i}) OR unaccent_immutable(p.name_vi) ILIKE unaccent_immutable($${BASE+i}) OR unaccent_immutable(p.name_vi_cho) ILIKE unaccent_immutable($${BASE+i}))`
      ).join(' OR ');
      const partParams = allPartNames.map((n:string) => `%${n}%`);   // chỉ %name% cho ILIKE (bỏ params của nhánh %)
      // Nếu đã biết chắc vehicle_id (VD: từ tra VIN) thì join thẳng theo id,
      // bỏ qua so khớp mờ make/model — tránh miss khi model_name/model_code
      // chưa được điền đầy đủ trong catalog_vehicles.
      const fixedParams = [`%${make}%`, model ? `%${model}%` : null, yearNum, allPartNames[0]||part, vehicle_id || null];
      const allParams   = [...fixedParams, ...partParams];

      // Query thang catalog_products — khong qua VIEW
      const rows = (await pool.query(`
        SELECT DISTINCT ON (p.id) ${PRODUCT_COLS},
          GREATEST(
            similarity(unaccent(p.name), unaccent($4)),
            similarity(unaccent(COALESCE(p.name_vi,'')), unaccent($4)),
            similarity(unaccent(COALESCE(p.name_vi_cho,'')), unaccent($4))
          ) sim,
          v.model_name AS matched_model_name, v.make AS matched_make,
          v.year_from AS matched_year_from, v.year_to AS matched_year_to
        FROM catalog_products p
        JOIN catalog_fitments f ON f.product_id = p.id
        JOIN catalog_vehicles v ON v.id = f.vehicle_id
        WHERE (
          $5::UUID IS NOT NULL AND v.id = $5::UUID
          OR $5::UUID IS NULL AND (
            v.make ILIKE $1
            AND ($2::TEXT IS NULL OR v.model_name ILIKE $2 OR v.model_name ILIKE REPLACE($2,'%','')||'%'
                 OR v.model_code ILIKE $2
                 OR similarity(unaccent(COALESCE(v.model_name,'')), unaccent(REPLACE($2,'%',''))) > 0.3
                 OR similarity(unaccent(v.model_code), unaccent(REPLACE($2,'%',''))) > 0.3)
            AND ($3::INT IS NULL OR v.year_from IS NULL OR v.year_from <= $3)
            AND ($3::INT IS NULL OR v.year_to   IS NULL OR v.year_to   >= $3)
          )
        )
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
        ON CONFLICT (make, model_code, variant_key) DO UPDATE SET
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
        ON CONFLICT (make, model_code, variant_key) DO UPDATE SET
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
          ON CONFLICT (make, model_code, variant_key) DO UPDATE SET
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
  // POST /fitment-matrix/rebuild  — tính lại độ phủ, cất vào catalog_fitment_matrix.
  //   ?make=Suzuki  → chỉ tính lại một hãng (nhanh hơn nhiều)
  //   không có make → tính lại toàn bộ
  // CHẠY SAU MỖI LẦN NẠP DỮ LIỆU. Đây là chỗ duy nhất còn dò chữ nên chậm,
  // nhưng chỉ chạy khi bạn gọi, không phải mỗi lần mở trang.
  fastify.post<{ Querystring: { make?: string } }>(
    '/fitment-matrix/rebuild', async (req, reply) => {
      const make = (req.query.make || '').trim() || null;
      const batDau = Date.now();
      const client = await pool.connect();
      try {
        // Xe không còn fitment nào thì xoá khỏi bảng, nếu không sẽ giữ số cũ mãi
        await client.query(
          `DELETE FROM catalog_fitment_matrix m
           WHERE ($1::text IS NULL OR EXISTS (
                    SELECT 1 FROM catalog_vehicles v
                    WHERE v.id = m.vehicle_id AND v.make = $1))
             AND NOT EXISTS (SELECT 1 FROM catalog_fitments f WHERE f.vehicle_id = m.vehicle_id)`,
          [make]);
        const res = await client.query(FITMENT_MATRIX_BUILD_SQL, [make]);
        const giay = Math.round((Date.now() - batDau) / 100) / 10;
        fastify.log.info(`[fitment-matrix/rebuild] make=${make ?? 'tất cả'} → ${res.rowCount} xe, ${giay}s`);
        return reply.send({ ok: true, make: make ?? 'tất cả', vehicles: res.rowCount, seconds: giay });
      } catch (e: any) {
        fastify.log.error('[fitment-matrix/rebuild] ' + e.message);
        return reply.status(500).send({ error: e.message });
      } finally {
        client.release();
      }
    }
  );

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

  // ============================================================
  // CRAWL SUBSTITUTES (Phân tán đa máy)
  // ============================================================
  // 1) Claim batch: Worker lấy 1 lô mã cần cào và khóa lại (tránh trùng)
  fastify.get<{ Querystring: { worker_id?: string; limit?: string } }>(
    '/crawl/substitutes/claim', async (req, reply) => {
      const workerId = (req.query.worker_id || 'unknown').trim();
      const limit = Math.min(Math.max(parseInt(req.query.limit || '50') || 50, 1), 200);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // CHẶN worker ôm mã: worker lỗi mà không nộp kết quả thì mã treo ở
        // 'claimed', trong khi nó vẫn xin lô mới liên tục. Đã gặp thật —
        // 1 worker giữ 50,157 mã, hàng đợi gần như đứng. Nên trước khi giao
        // lô mới, nhả hết mã cũ mà chính worker này đang giữ: nó đã sang lô
        // khác rồi, mã cũ chắc chắn không được cào nữa.
        await client.query(`
          UPDATE crawl_substitutes_queue
          SET status='pending', worker_id=NULL, claimed_at=NULL
          WHERE status='claimed' AND worker_id=$1
        `, [workerId]);

        // Chọn các mã:
        //  - status = 'pending'
        //  - HOẶC 'claimed' của worker KHÁC mà quá 5 phút (worker đó chết/rớt mạng)
        // Giữ 5 phút chứ không 15: worker chạy 4 tab cào xong lô 40 mã trong
        // ~10 giây, nên 15 phút là quá thừa.
        const qRes = await client.query(`
          WITH ung_vien AS (
            SELECT ref_norm
            FROM crawl_substitutes_queue
            WHERE status = 'pending'
               OR (status = 'claimed' AND claimed_at < NOW() - INTERVAL '5 minutes')
            ORDER BY claimed_at ASC NULLS FIRST
            LIMIT $1
            FOR UPDATE SKIP LOCKED
          )
          UPDATE crawl_substitutes_queue q
          SET status = 'claimed',
              worker_id = $2,
              claimed_at = NOW()
          FROM ung_vien u
          WHERE q.ref_norm = u.ref_norm
          RETURNING q.ref_norm, q.ma_goc
        `, [limit, workerId]);

        await client.query('COMMIT');
        return reply.send({ ok: true, worker_id: workerId, count: qRes.rows.length, items: qRes.rows });
      } catch (e: any) {
        await client.query('ROLLBACK').catch(() => {});
        fastify.log.error('[substitutes/claim] ' + e.message);
        return reply.status(500).send({ error: e.message });
      } finally {
        client.release();
      }
    }
  );

  // 2) Submit result: Worker nộp kết quả 1 mã
  fastify.post<{ Body: { worker_id?: string; ma_goc: string; substitutes: any[]; error?: string } }>(
    '/crawl/substitutes/submit', async (req, reply) => {
      const { worker_id = 'unknown', ma_goc, substitutes = [], error } = req.body || {};
      if (!ma_goc) return reply.status(400).send({ error: 'Thiếu ma_goc' });

      const normGoc = ma_goc.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        if (error) {
          // Phân biệt lỗi PHÍA MÁY WORKER với lỗi thật từ PartSouq.
          // Đóng Chrome giữa chừng / tab sập / mạng rớt thì mã CHƯA HỀ được cào
          // — phải trả về hàng đợi, không phải đánh dấu hỏng. Đã mắc lỗi này:
          // 324,966 mã bị ghi 'error' chỉ vì người dùng đóng trình duyệt, nằm
          // chết ở đó không worker nào nhận lại.
          const loiMayWorker = /has been closed|Page crashed|ERR_ABORTED|Timeout \d+ms exceeded|ERR_INSUFFICIENT_RESOURCES|ERR_NETWORK|ERR_CONNECTION|because the page is/i.test(error);
          if (loiMayWorker) {
            await client.query(`
              UPDATE crawl_substitutes_queue
              SET status='pending', worker_id=NULL, claimed_at=NULL, error_msg=$2
              WHERE ref_norm = $1
            `, [normGoc, error.slice(0, 200)]);
            await client.query('COMMIT');
            return reply.send({ ok: true, status: 'pending', ghi_chu: 'lỗi phía worker — trả về hàng đợi' });
          }
          await client.query(`
            UPDATE crawl_substitutes_queue
            SET status = 'error', error_msg = $2, completed_at = NOW()
            WHERE ref_norm = $1
          `, [normGoc, error]);
          await client.query('COMMIT');
          return reply.send({ ok: true, status: 'error' });
        }

        // Tìm product_id
        const spRes = await client.query(
          'SELECT id FROM catalog_products WHERE ref_norm = $1 LIMIT 1',
          [normGoc]
        );
        let inserted = 0;
        if (spRes.rows.length && substitutes.length) {
          const productId = spRes.rows[0].id;
          for (const sub of substitutes) {
            const subCode = (sub.so || sub.part_number || '').trim();
            const subNorm = subCode.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
            if (!subCode || !subNorm || subNorm === normGoc) continue;

            const res = await client.query(`
              INSERT INTO catalog_oem_codes (product_id, oem_code, make, source)
              VALUES ($1, $2, $3, 'partsouq:substitutes')
              ON CONFLICT (product_id, oem_code) DO NOTHING
            `, [productId, subCode, sub.make || null]);
            inserted += (res.rowCount || 0);
          }
        }

        // Đánh dấu hoàn thành trong queue
        await client.query(`
          UPDATE crawl_substitutes_queue
          SET status = 'done',
              total_found = $2,
              completed_at = NOW(),
              error_msg = NULL
          WHERE ref_norm = $1
        `, [normGoc, substitutes.length]);

        await client.query('COMMIT');
        return reply.send({ ok: true, ma_goc, substitutes_found: substitutes.length, oem_codes_inserted: inserted });
      } catch (e: any) {
        await client.query('ROLLBACK').catch(() => {});
        fastify.log.error('[substitutes/submit] ' + e.message);
        return reply.status(500).send({ error: e.message });
      } finally {
        client.release();
      }
    }
  );

  // 2b) Nạp thêm mã vào hàng đợi (bấm từ trang /tien-do-cao.html)
  //     uu_tien='fitment' (mặc định) → chỉ lấy SP đã gắn xe: mã thế tìm được
  //     dùng được NGAY trong luồng tra cứu theo xe, thay vì nằm chờ.
  //     Dùng EXISTS chứ không JOIN — chỉ cần biết CÓ fitment hay không, không cần đếm.
  fastify.post<{ Body: { so_luong?: number; uu_tien?: string } }>(
    '/crawl/substitutes/seed', async (req, reply) => {
      const soLuong = Math.min(Math.max(Number(req.body?.so_luong) || 10000, 100), 200000);
      const uuTien = req.body?.uu_tien === 'tat-ca' ? 'tat-ca' : 'fitment';
      const locFitment = uuTien === 'fitment'
        ? 'AND EXISTS (SELECT 1 FROM catalog_fitments f WHERE f.product_id = p.id)' : '';
      try {
        const t0 = Date.now();
        const r = await pool.query(`
          INSERT INTO crawl_substitutes_queue (ref_norm, ma_goc, status)
          SELECT p.ref_norm, p.internal_ref, 'pending'
          FROM catalog_products p
          WHERE p.is_for_sale = TRUE AND p.ref_norm IS NOT NULL
            AND (p.internal_ref ~ '^[0-9]{5}-[0-9A-Z]{5}'
              OR p.internal_ref ~ '^[0-9A-Z]{5}-[0-9A-Z]{5}')
            ${locFitment}
            AND NOT EXISTS (SELECT 1 FROM crawl_substitutes_queue q WHERE q.ref_norm = p.ref_norm)
          LIMIT $1
          ON CONFLICT (ref_norm) DO NOTHING
        `, [soLuong]);
        return reply.send({ ok: true, da_nap: r.rowCount || 0, uu_tien: uuTien,
                            giay: Math.round((Date.now() - t0) / 100) / 10 });
      } catch (e: any) {
        fastify.log.error('[substitutes/seed] ' + e.message);
        return reply.status(500).send({ error: e.message });
      }
    }
  );

  // 3) Queue stats: Xem tiến độ cào Substitutes
  fastify.get('/crawl/substitutes/stats', async (_req, reply) => {
    const daLuu = layDem('substitutes');
    if (daLuu) return reply.send(daLuu);
    try {
      const [stRes, wkRes] = await Promise.all([
        pool.query(`
          SELECT status, count(*)::int as count, sum(total_found)::int as total_found
          FROM crawl_substitutes_queue
          GROUP BY status
        `),
        pool.query(`
          SELECT worker_id, count(*)::int as done_count, sum(total_found)::int as total_found, max(completed_at) as last_seen
          FROM crawl_substitutes_queue
          WHERE status = 'done'
          GROUP BY worker_id
          ORDER BY done_count DESC
        `),
      ]);
      return reply.send(luuDem('substitutes', {
        summary: stRes.rows,
        workers: wkRes.rows,
      }));
    } catch (e: any) {
      fastify.log.error('[substitutes/stats] ' + e.message);
      return reply.status(500).send({ error: e.message });
    }
  });

  // ============================================================
  // CRAWL XE cho Nhóm 2 Product.xlsx (Hướng A: cào xe TRƯỚC, nạp SP sau)
  // Sản phẩm nằm ở phòng chờ product_cho_nap. Mã gốc nào PartSouq trả về xe
  // thì mới nạp sản phẩm + fitment; mã không có xe thì nằm lại, không nạp.
  // ============================================================

  // 1) Worker xin lô mã gốc cần cào xe
  fastify.get<{ Querystring: { worker_id?: string; limit?: string } }>(
    '/crawl/xe/claim', async (req, reply) => {
      const workerId = (req.query.worker_id || 'unknown').trim();
      const limit = Math.min(Math.max(parseInt(req.query.limit || '20') || 20, 1), 200);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const r = await client.query(`
          WITH ung_vien AS (
            SELECT oem_norm FROM crawl_xe_queue
            WHERE status = 'pending'
               OR (status = 'claimed' AND claimed_at < NOW() - INTERVAL '15 minutes')
            ORDER BY claimed_at ASC NULLS FIRST
            LIMIT $1
            FOR UPDATE SKIP LOCKED
          )
          UPDATE crawl_xe_queue q
          SET status='claimed', worker_id=$2, claimed_at=NOW()
          FROM ung_vien u WHERE q.oem_norm = u.oem_norm
          RETURNING q.oem_norm, q.oem_code
        `, [limit, workerId]);
        await client.query('COMMIT');
        return reply.send({ ok: true, worker_id: workerId, count: r.rows.length, items: r.rows });
      } catch (e: any) {
        await client.query('ROLLBACK').catch(() => {});
        fastify.log.error('[xe/claim] ' + e.message);
        return reply.status(500).send({ error: e.message });
      } finally { client.release(); }
    }
  );

  // 2) Worker nộp danh sách xe → upsert xe, nạp SP từ phòng chờ, tạo fitment
  fastify.post<{ Body: { worker_id?: string; oem_code: string; vehicles?: any[]; error?: string } }>(
    '/crawl/xe/submit', async (req, reply) => {
      const { worker_id = 'unknown', oem_code, vehicles = [], error } = req.body || {};
      if (!oem_code) return reply.status(400).send({ error: 'Thiếu oem_code' });
      const oemNorm = oem_code.replace(/[^A-Za-z0-9]/g, '').toUpperCase();

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        if (error) {
          await client.query(
            `UPDATE crawl_xe_queue SET status='error', error_msg=$2, completed_at=NOW() WHERE oem_norm=$1`,
            [oemNorm, error]);
          await client.query('COMMIT');
          return reply.send({ ok: true, status: 'error' });
        }

        // Không có xe → đánh dấu xong, KHÔNG nạp sản phẩm (tránh SP mồ côi)
        if (!vehicles.length) {
          await client.query(
            `UPDATE crawl_xe_queue SET status='done', so_xe=0, so_sp_nap=0, completed_at=NOW(), error_msg=NULL
             WHERE oem_norm=$1`, [oemNorm]);
          await client.query('COMMIT');
          return reply.send({ ok: true, vehicles: 0, products_loaded: 0, fitments: 0 });
        }

        // a) Upsert xe
        const vehicleIds: string[] = [];
        for (const v of vehicles) {
          const make = (v.make || '').trim();
          const code = (v.modelCode || v.model_code || '').trim();
          if (!make || !code) continue;
          const year = parseInt(v.year) || null;
          const vr = await client.query(`
            INSERT INTO catalog_vehicles
              (make, model_code, model_name, vehicle_type, year_from, year_to, engine, transmission, description, created_at, updated_at)
            VALUES ($1,$2,$3,'car',$4,$4,$5,$6,$7,NOW(),NOW())
            ON CONFLICT (make, model_code, variant_key) DO UPDATE SET
              model_name = COALESCE(catalog_vehicles.model_name, EXCLUDED.model_name),
              updated_at = NOW()
            RETURNING id
          `, [make, code, v.modelName || v.model_name || null, year,
              v.engine || null, v.trans || v.transmission || null, v.market || null]);
          vehicleIds.push(vr.rows[0].id);
        }

        // b) Nạp sản phẩm chờ có mã gốc này vào catalog_products
        const spRes = await client.query(`
          INSERT INTO catalog_products
            (id, name, name_vi, internal_ref, oem_code, is_for_sale, product_type, notes, created_at, updated_at)
          SELECT gen_random_uuid(), c.ten, c.ten, c.internal_ref, NULL, TRUE,
                 'aftermarket', 'nguon: Product.xlsx (nhom2)', NOW(), NOW()
          FROM product_cho_nap c
          WHERE c.oem_norm = $1 AND NOT c.da_nap
          ON CONFLICT (ref_norm) WHERE ref_norm IS NOT NULL DO NOTHING
          RETURNING id
        `, [oemNorm]);
        const productIds = spRes.rows.map((r: any) => r.id);

        // c) Ghi mã OE + fitment cho các sản phẩm vừa nạp
        let fitments = 0;
        if (productIds.length) {
          await client.query(`
            INSERT INTO catalog_oem_codes (product_id, oem_code, make, source)
            SELECT id, $2, NULL, 'Product.xlsx:Mã gốc'
            FROM unnest($1::uuid[]) AS t(id)
            ON CONFLICT (product_id, oem_code) DO NOTHING
          `, [productIds, oem_code]);

          if (vehicleIds.length) {
            const fr = await client.query(`
              INSERT INTO catalog_fitments (id, product_id, vehicle_id, notes, created_at)
              SELECT gen_random_uuid(), p.id, v.id, 'nguon: Product.xlsx (cao xe)', NOW()
              FROM unnest($1::uuid[]) AS p(id)
              CROSS JOIN unnest($2::uuid[]) AS v(id)
              ON CONFLICT (product_id, vehicle_id) DO NOTHING
            `, [productIds, vehicleIds]);
            fitments = fr.rowCount || 0;
          }

          await client.query(
            `UPDATE product_cho_nap SET da_nap=TRUE, nap_luc=NOW() WHERE oem_norm=$1 AND NOT da_nap`,
            [oemNorm]);
        }

        await client.query(`
          UPDATE crawl_xe_queue
          SET status='done', so_xe=$2, so_sp_nap=$3, completed_at=NOW(), error_msg=NULL
          WHERE oem_norm=$1
        `, [oemNorm, vehicleIds.length, productIds.length]);

        await client.query('COMMIT');
        return reply.send({ ok: true, oem_code, vehicles: vehicleIds.length,
                            products_loaded: productIds.length, fitments });
      } catch (e: any) {
        await client.query('ROLLBACK').catch(() => {});
        fastify.log.error('[xe/submit] ' + e.message);
        return reply.status(500).send({ error: e.message });
      } finally { client.release(); }
    }
  );

  // 3) Tiến độ
  fastify.get('/crawl/xe/stats', async (_req, reply) => {
    const daLuu = layDem('xe');
    if (daLuu) return reply.send(daLuu);
    try {
      const [q, w, c] = await Promise.all([
        pool.query(`SELECT status, count(*)::int AS count, sum(so_xe)::int AS so_xe,
                           sum(so_sp_nap)::int AS so_sp_nap
                    FROM crawl_xe_queue GROUP BY status`),
        pool.query(`SELECT worker_id, count(*)::int AS done_count, sum(so_sp_nap)::int AS so_sp_nap,
                           max(completed_at) AS last_seen
                    FROM crawl_xe_queue WHERE status='done'
                    GROUP BY worker_id ORDER BY done_count DESC`),
        pool.query(`SELECT count(*) FILTER (WHERE da_nap)::int AS da_nap,
                           count(*) FILTER (WHERE NOT da_nap)::int AS con_cho
                    FROM product_cho_nap`),
      ]);
      return reply.send(luuDem('xe', { summary: q.rows, workers: w.rows, phong_cho: c.rows[0] }));
    } catch (e: any) {
      fastify.log.error('[xe/stats] ' + e.message);
      return reply.status(500).send({ error: e.message });
    }
  });

  // ============================================================
  // CRAWL JNBK / NiBK — nguồn mã chéo má phanh (nibk-brakes.com)
  // Hàng đợi RIÊNG, không dùng chung crawl_substitutes_queue: JNBK cho ra thứ
  // khác (bảng cross-reference AKEBONO/BENDIX/FMSI/WVA), phạm vi hẹp (chỉ
  // phanh) và nhịp khác — trộn chung thì không tách được số liệu để biết
  // nguồn nào đáng cào.
  // ============================================================

  fastify.get<{ Querystring: { worker_id?: string; limit?: string } }>(
    '/crawl/jnbk/claim', async (req, reply) => {
      const workerId = (req.query.worker_id || 'unknown').trim();
      const limit = Math.min(Math.max(parseInt(req.query.limit || '20') || 20, 1), 100);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Nhả mã cũ worker này còn giữ trước khi giao lô mới — nó đã sang lô
        // khác nên mã cũ chắc chắn không được cào nữa (xem sự cố ôm 50k mã).
        await client.query(
          `UPDATE crawl_jnbk_queue SET status='pending', worker_id=NULL, claimed_at=NULL
           WHERE status='claimed' AND worker_id=$1`, [workerId]);

        const r = await client.query(`
          WITH ung_vien AS (
            SELECT ref_norm FROM crawl_jnbk_queue
            WHERE status='pending'
               OR (status='claimed' AND claimed_at < NOW() - INTERVAL '5 minutes')
            ORDER BY claimed_at ASC NULLS FIRST
            LIMIT $1 FOR UPDATE SKIP LOCKED
          )
          UPDATE crawl_jnbk_queue q
          SET status='claimed', worker_id=$2, claimed_at=NOW()
          FROM ung_vien u WHERE q.ref_norm = u.ref_norm
          RETURNING q.ref_norm, q.ma_goc
        `, [limit, workerId]);
        await client.query('COMMIT');
        return reply.send({ ok: true, worker_id: workerId, count: r.rows.length, items: r.rows });
      } catch (e: any) {
        await client.query('ROLLBACK').catch(() => {});
        fastify.log.error('[jnbk/claim] ' + e.message);
        return reply.status(500).send({ error: e.message });
      } finally { client.release(); }
    }
  );

  fastify.post<{ Body: { worker_id?: string; ma_goc: string; ma_nibk?: string; cheo?: any[]; error?: string } }>(
    '/crawl/jnbk/submit', async (req, reply) => {
      const { worker_id = 'unknown', ma_goc, ma_nibk, cheo = [], error } = req.body || {};
      if (!ma_goc) return reply.status(400).send({ error: 'Thiếu ma_goc' });
      const normGoc = ma_goc.replace(/[^A-Za-z0-9]/g, '').toUpperCase();

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        if (error) {
          // Lỗi phía máy worker (đóng Chrome, tab sập) → mã CHƯA được cào,
          // trả về hàng đợi chứ không đánh dấu hỏng.
          const loiMay = /has been closed|Page crashed|ERR_ABORTED|Timeout \d+ms|ERR_INSUFFICIENT|because the page is/i.test(error);
          await client.query(
            loiMay
              ? `UPDATE crawl_jnbk_queue SET status='pending', worker_id=NULL, claimed_at=NULL, error_msg=$2 WHERE ref_norm=$1`
              : `UPDATE crawl_jnbk_queue SET status='error', error_msg=$2, completed_at=NOW() WHERE ref_norm=$1`,
            [normGoc, error.slice(0, 200)]);
          await client.query('COMMIT');
          return reply.send({ ok: true, status: loiMay ? 'pending' : 'error' });
        }

        let inserted = 0;
        if (ma_nibk && cheo.length) {
          const sp = await client.query(
            'SELECT id FROM catalog_products WHERE ref_norm = $1 LIMIT 1', [normGoc]);
          if (sp.rows.length) {
            const productId = sp.rows[0].id;
            // Mã NiBK cũng là một mã thay thế hợp lệ → lưu luôn
            const tatCa = [{ hang: 'NiBK', ma: ma_nibk }, ...cheo];
            for (const c of tatCa) {
              const ma = (c.ma || '').trim();
              const chuan = ma.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
              if (!ma || !chuan || chuan === normGoc) continue;
              const r = await client.query(`
                INSERT INTO catalog_oem_codes (product_id, oem_code, make, source)
                VALUES ($1, $2, $3, 'jnbk:cross-reference')
                ON CONFLICT (product_id, oem_code) DO NOTHING
              `, [productId, ma, (c.hang || '').trim() || null]);
              inserted += (r.rowCount || 0);
            }
          }
        }

        await client.query(`
          UPDATE crawl_jnbk_queue
          SET status='done', ma_nibk=$2, total_found=$3, completed_at=NOW(), error_msg=NULL
          WHERE ref_norm=$1
        `, [normGoc, ma_nibk || null, cheo.length]);

        await client.query('COMMIT');
        return reply.send({ ok: true, ma_goc, ma_nibk, cheo_nhan: cheo.length, oem_codes_inserted: inserted });
      } catch (e: any) {
        await client.query('ROLLBACK').catch(() => {});
        fastify.log.error('[jnbk/submit] ' + e.message);
        return reply.status(500).send({ error: e.message });
      } finally { client.release(); }
    }
  );

  // Nạp mã phanh vào hàng đợi JNBK (JNBK CHỈ có má phanh/guốc phanh/đĩa phanh)
  fastify.post<{ Body: { so_luong?: number } }>('/crawl/jnbk/seed', async (req, reply) => {
    const soLuong = Math.min(Math.max(Number(req.body?.so_luong) || 20000, 100), 100000);
    try {
      const t0 = Date.now();
      const r = await pool.query(`
        INSERT INTO crawl_jnbk_queue (ref_norm, ma_goc, status)
        SELECT p.ref_norm, p.internal_ref, 'pending'
        FROM catalog_products p
        WHERE p.is_for_sale AND p.ref_norm IS NOT NULL
          AND lower(coalesce(p.name,'') || ' ' || coalesce(p.name_vi,'')) ~
              'brake pad|disc brake|brake shoe|má phanh|ma phanh|guốc phanh|bố thắng'
          AND NOT EXISTS (SELECT 1 FROM crawl_jnbk_queue q WHERE q.ref_norm = p.ref_norm)
        LIMIT $1
        ON CONFLICT (ref_norm) DO NOTHING
      `, [soLuong]);
      return reply.send({ ok: true, da_nap: r.rowCount || 0, giay: Math.round((Date.now() - t0) / 100) / 10 });
    } catch (e: any) {
      fastify.log.error('[jnbk/seed] ' + e.message);
      return reply.status(500).send({ error: e.message });
    }
  });

  fastify.get('/crawl/jnbk/stats', async (_req, reply) => {
    const daLuu = layDem('jnbk');
    if (daLuu) return reply.send(daLuu);
    try {
      const [q, w, o] = await Promise.all([
        pool.query(`SELECT status, count(*)::int AS count, sum(total_found)::int AS total_found
                    FROM crawl_jnbk_queue GROUP BY status`),
        pool.query(`SELECT worker_id, count(*)::int AS done_count, sum(total_found)::int AS total_found,
                           max(completed_at) AS last_seen
                    FROM crawl_jnbk_queue WHERE status='done'
                    GROUP BY worker_id ORDER BY done_count DESC`),
        pool.query(`SELECT count(*)::int AS ma_da_ghi FROM catalog_oem_codes
                    WHERE source='jnbk:cross-reference'`),
      ]);
      return reply.send(luuDem('jnbk', { summary: q.rows, workers: w.rows, ...o.rows[0] }));
    } catch (e: any) {
      fastify.log.error('[jnbk/stats] ' + e.message);
      return reply.status(500).send({ error: e.message });
    }
  });
}