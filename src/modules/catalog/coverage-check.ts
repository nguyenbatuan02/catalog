/**
 * coverage-check.ts — Tính "độ phủ" phụ tùng cho 1 model_line sau khi job crawl xong.
 *
 * TỪ ĐIỂN: gộp từ điển chuẩn HT autoparts (4 file PPTX: động cơ/gầm/điện/thân vỏ — tên Anh kiểu
 *   PartSouq & ToyoDIY) + thuật ngữ TIẾNG VIỆT (dữ liệu Toyota nhiều khi để tên Việt ngay trong `name`).
 *
 * LƯU Ý (đọc trước khi tin số liệu):
 *   • TÍN HIỆU THAM KHẢO, không tuyệt đối. Tên phụ tùng của hãng rất lộn xộn (Toyota gọi "SPRING, COIL"
 *     thay vì "coil spring"; má phanh có khi là "BỘ ĐỆM, PHANH ĐĨA") → pattern chuỗi-con vẫn có thể sót.
 *   • Khớp trên chuỗi GỘP `name + ' ' + name_vi` → bắt được cả tên Anh LẪN tên Việt.
 *   • ĐÃ BỎ vài pattern "suy diễn" gây dương-tính-giả của bản gốc (làm category luôn = true):
 *       dia_phanh:'hub sub-assy'/'rotor, skid control'; bom_dau:'cover…timing chain'; mo_to_quat:'shroud';
 *       dan_lanh:'cooler sub-assy'(trùng két mát dầu); tong_phanh:'cylinder…front disc brake'(là caliper)/bare 'master cylinder'(trùng tổng côn).
 *   • KHÔNG auto-requeue (xem lịch sử: ~100% model bị gắn thiếu do sót pattern → bật requeue = bão cào vô ích).
 *
 * KEY vs data model: 1 job = 1 model_line (= catalog_vehicles.model_name), gồm NHIỀU model_code/xe
 *   → gộp phụ tùng của TẤT CẢ xe có model_name = model_line, KHÔNG phải 1 xe (KHÔNG dùng model_code).
 */
import type { Pool } from 'pg';

interface PartDef {
  key: string;
  label: string;        // Tên tiếng Việt chuẩn (thợ máy)
  patterns: string[];   // Keyword tiếng Anh (PartSouq/ToyoDIY) — khớp substring, lowercase
  vi: string[];         // Keyword tiếng Việt (khớp trên name/name_vi)
}

// 50 loại dashboard. "Có" = bất kỳ pattern (Anh) HOẶC vi (Việt) là chuỗi con của (name + name_vi).
const PART_DEFS: PartDef[] = [
  // ── ĐỘNG CƠ ──────────────────────────────────────────────
  { key: 'piston',         label: 'Piston',                    patterns: ['piston sub-assy', 'piston'], vi: ['pít tông', 'píttông'] },
  { key: 'sec_mang',       label: 'Séc măng',                  patterns: ['ring set, piston', 'ring set', 'piston ring'], vi: ['séc măng'] },
  { key: 'bien_balie',     label: 'Biên / Bạc biên',           patterns: ['rod sub-assy, connecting', 'bearing set, connecting rod', 'bearing set, crankshaft', 'connecting rod', 'con rod'], vi: ['thanh truyền', 'balie'] },
  { key: 'gioang_dai_tu',  label: 'Gioăng bộ đại tu',          patterns: ['gasket kit, engine overhaul', 'gasket kit', 'overhaul gasket', 'gasket set, engine'], vi: ['gioăng đại tu', 'gioăng bộ'] },
  { key: 'loc_dau',        label: 'Lọc dầu',                   patterns: ['filter sub-assy, oil', 'oil filter', 'filter, oil'], vi: ['lọc dầu'] },
  { key: 'loc_nhien_lieu', label: 'Lọc nhiên liệu',            patterns: ['filter, fuel', 'fuel filter', 'filter sub-assy, fuel'], vi: ['lọc nhiên liệu'] },
  { key: 'loc_gio',        label: 'Lọc gió',                   patterns: ['cleaner assy, air', 'air filter', 'filter, air', 'air cleaner element', 'element, air cleaner'], vi: ['lọc gió'] },
  // bom_dau: BỎ 'cover sub-assy, timing chain…' (nắp cam ≠ bơm dầu → dương-tính-giả gần như mọi xe).
  { key: 'bom_dau',        label: 'Bơm dầu',                   patterns: ['oil pump', 'pump, oil', 'pump assy, oil', 'rotor set, oil pump'], vi: ['bơm dầu'] },
  { key: 'bom_nuoc',       label: 'Bơm nước',                  patterns: ['pump assy, engine water', 'water pump', 'pump, water', 'pump assy, water'], vi: ['bơm nước'] },
  { key: 'bugi',           label: 'Bugi / Bugi sấy',           patterns: ['plug, spark', 'spark plug', 'plug, glow', 'glow plug', 'nozzle sub-assy, glow'], vi: ['bugi', 'bu-gi'] },
  { key: 'mobin',          label: 'Môbin đánh lửa',            patterns: ['coil assy, ignition', 'ignition coil', 'coil, ignition', 'coil sub-assy, ignition'], vi: ['môbin', 'mô bin', 'cuộn đánh lửa'] },
  { key: 'kim_phun',       label: 'Kim phun',                  patterns: ['injector assy, fuel', 'injector', 'injection nozzle', 'nozzle, injector'], vi: ['kim phun', 'vòi phun'] },
  { key: 'bom_nhien_lieu', label: 'Bơm nhiên liệu / Bơm xăng', patterns: ['pump, fuel', 'pump assy, fuel w/motor', 'pump assy, fuel', 'fuel pump', 'pump sub-assy, fuel'], vi: ['bơm nhiên liệu', 'bơm xăng'] },
  { key: 'turbo',          label: 'Turbo tăng áp',             patterns: ['turbocharger', 'turbo', 'turbocharger assy'], vi: ['tăng áp'] },
  { key: 'curoa_cam',      label: 'Dây curoa cam / Xích cam',  patterns: ['belt, timing', 'timing belt', 'chain sub-assy', 'timing chain', 'cam belt'], vi: ['curoa cam', 'xích cam'] },
  { key: 'curoa_tong',     label: 'Dây curoa tổng',            patterns: ['belt, v', 'drive belt', 'v-belt', 'v ribbed belt', 'belt, v-ribbed', 'fan belt'], vi: ['curoa tổng'] },
  { key: 'curoa_phu',      label: 'Dây curoa phụ',             patterns: ['belt, accessory', 'accessory belt', 'serpentine belt'], vi: ['curoa phụ'] },
  { key: 'bi_tang_cam',    label: 'Bi tăng cam',               patterns: ['tensioner assy, v-ribbed belt', 'tensioner assy, chain', 'idler sub-assy, timing belt', 'tensioner assy, timing belt', 'tensioner', 'idler pulley'], vi: ['bi tăng', 'bi tỳ'] },
  { key: 'ket_nuoc',       label: 'Két nước',                  patterns: ['radiator assy', 'radiator'], vi: ['két nước'] },
  { key: 'ket_mat_dau',    label: 'Két làm mát dầu',           patterns: ['oil cooler', 'cooler, oil', 'cooler assy, oil'], vi: ['két mát dầu', 'làm mát dầu'] },
  // mo_to_quat: BỎ 'shroud, fan' (lồng quạt ≠ mô tơ quạt).
  { key: 'mo_to_quat',     label: 'Mô tơ quạt',                patterns: ['fan motor', 'motor, fan', 'motor assy, fan', 'cooling fan motor'], vi: ['mô tơ quạt', 'motor quạt'] },
  { key: 'may_phat',       label: 'Máy phát',                  patterns: ['alternator assy', 'alternator', 'generator'], vi: ['máy phát'] },
  { key: 'may_de',         label: 'Máy đề',                    patterns: ['starter assy', 'starter', 'starting motor'], vi: ['máy đề', 'mô tơ đề'] },

  // ── TRUYỀN ĐỘNG ──────────────────────────────────────────
  { key: 'hop_so',         label: 'Hộp số',                    patterns: ['transmission', 'gearbox', 'transaxle'], vi: ['hộp số'] },
  { key: 'cay_lap',        label: 'Cây láp',                   patterns: ['shaft assy, front drive', 'shaft, rear axle', 'drive shaft', 'axle shaft', 'half shaft', 'shaft assy, rear axle'], vi: ['cây láp'] },
  { key: 'bi_lap_moay_o',  label: 'Bi láp / Bi moay ơ',        patterns: ['bearing (for front axle hub', 'bearing (for rear axle shaft', 'wheel bearing', 'hub bearing', 'hub sub-assy, front axle', 'hub sub-assy, rear axle', 'bearing, hub'], vi: ['moay ơ', 'bi láp'] },
  { key: 'dia_con_ban_ep', label: 'Đĩa côn / Bàn ép / Bi tê',  patterns: ['disc assy, clutch', 'cover assy, clutch', 'bearing assy, clutch release', 'clutch disc', 'pressure plate', 'release bearing', 'clutch cover'], vi: ['đĩa côn', 'bàn ép', 'bi tê'] },
  { key: 'tong_con',       label: 'Tổng côn / Chuột côn',      patterns: ['cylinder assy, clutch master', 'cylinder assy, clutch release', 'clutch master', 'master cylinder, clutch', 'cylinder kit, clutch release'], vi: ['tổng côn', 'chuột côn'] },
  { key: 'loc_dau_hop_so', label: 'Lọc dầu hộp số',            patterns: ['strainer assy, valve body oil', 'transmission filter', 'filter, atf', 'atf filter', 'oil strainer, transmission'], vi: ['lọc dầu hộp số'] },
  { key: 'truc_cac_dang',  label: 'Trục các đăng',             patterns: ['shaft assy, propeller, front', 'shaft assy, propeller, rear', 'shaft assy, propeller', 'propeller shaft', 'prop shaft', 'spider kit'], vi: ['các đăng'] },
  { key: 'cau_sau',        label: 'Cầu sau / Vi sai',          patterns: ['bearing (for rear drive pinion', 'bearing(for rear differential', 'differential', 'rear axle housing', 'final gear', 'carrier assy, differential'], vi: ['cầu sau', 'vi sai'] },

  // ── TREO ─────────────────────────────────────────────────
  { key: 'giam_soc',       label: 'Giảm xóc',                  patterns: ['absorber assy, shock', 'shock absorber', 'strut assy', 'damper assy'], vi: ['giảm sóc', 'giảm xóc'] },
  { key: 'lo_xo',          label: 'Lò xo / Nhíp',              patterns: ['spring, front coil', 'spring, coil', 'coil spring', 'spring, leaf', 'leaf spring', 'spring, rear coil'], vi: ['lò xo'] },
  { key: 'cang_a',         label: 'Càng A trên / dưới',        patterns: ['arm assy, front suspension, upper', 'arm sub-assy, front suspension, lower', 'arm assy, upper control', 'arm assy, lower control', 'control arm', 'lower arm', 'upper arm', 'arm sub-assy, suspension'], vi: ['càng a', 'càng chữ a'] },
  { key: 'ro_tuyn_can_bang', label: 'Rô tuyn cân bằng',        patterns: ['link assy, stabilizer', 'stabilizer link', 'sway bar link', 'bush, stabilizer bar'], vi: ['rô tuyn cân bằng', 'thanh cân bằng'] },

  // ── PHANH ────────────────────────────────────────────────
  // ma_phanh: Anh (HT autoparts) + Việt (dữ liệu Toyota: "Má phanh…", "BỘ ĐỆM/DÈN, PHANH ĐĨA"). "dèn"=lỗi OCR của "đệm".
  { key: 'ma_phanh',       label: 'Má phanh trước / sau',      patterns: ['pad kit, disc brake, front', 'pad kit, disc brake, rear', 'pad kit, disc brake', 'brake pad', 'disc pad', 'pad, disc brake', 'fitting kit, disc brake'], vi: ['má phanh', 'đệm, phanh đĩa', 'đệm phanh đĩa', 'dèn, phanh đĩa'] },
  // dia_phanh: BỎ 'hub sub-assy'(moay ơ ≠ đĩa) và 'rotor, skid control'(là rotor ABS → thuộc abs).
  { key: 'dia_phanh',      label: 'Đĩa phanh',                 patterns: ['disc, front', 'disc, rear', 'brake disc', 'brake rotor', 'disc, brake', 'disc brake'], vi: ['đĩa phanh', 'đĩa, phanh'] },
  { key: 'guoc_phanh',     label: 'Guốc phanh / Tăng bua',     patterns: ['drum sub-assy, rear brake', 'brake shoe', 'shoe, brake', 'shoe set', 'adjuster, brake shoe'], vi: ['guốc phanh', 'tang trống', 'tăng bua'] },
  // tong_phanh: BỎ 'cylinder…front disc brake'(là caliper) và bare 'master cylinder'(trùng tổng côn) — dùng bản chính xác.
  { key: 'tong_phanh',     label: 'Tổng phanh',                patterns: ['cylinder assy, brake master', 'master cylinder, brake', 'brake master'], vi: ['tổng phanh'] },
  { key: 'abs',            label: 'Cảm biến ABS',              patterns: ['sensor, speed, front', 'sensor, speed, rear', 'sensor, speed', 'wire, speed sensor', 'rotor, skid control', 'abs actuator', 'anti-lock'], vi: ['chống bó cứng', 'cảm biến abs'] },

  // ── LÁI ─────────────────────────────────────────────────
  { key: 'thuoc_lai',      label: 'Thước lái',                 patterns: ['link assy, power steering', 'steering rack', 'gear sub-assy, steering', 'gear assy, rack', 'rack assy, steering'], vi: ['thước lái'] },
  { key: 'ro_tuyn_lai',    label: 'Rô tuyn lái trong / ngoài', patterns: ['end sub-assy, steering rack', 'end sub-assy, tie rod', 'tie rod', 'rack end', 'drag link', 'link assy, tie rod'], vi: ['rô tuyn lái', 'rotuyn lái'] },
  { key: 'bom_tro_luc',    label: 'Bơm trợ lực lái',           patterns: ['pump assy, vane', 'gasket kit, power steering pump', 'power steering pump', 'vane pump'], vi: ['bơm trợ lực'] },

  // ── ĐIỀU HÒA ────────────────────────────────────────────
  { key: 'loc_lanh',       label: 'Lốc lạnh',                  patterns: ['compressor assy, cooler', 'clutch assy, magnet', 'compressor', 'compressor assy'], vi: ['lốc lạnh', 'máy nén'] },
  { key: 'dan_nong',       label: 'Dàn nóng',                  patterns: ['condenser assy, cooler', 'condenser assy', 'condenser'], vi: ['dàn nóng', 'giàn nóng'] },
  // dan_lanh: BỎ 'cooler sub-assy' (trùng "cooler sub-assy, oil" = két mát dầu).
  { key: 'dan_lanh',       label: 'Dàn lạnh',                  patterns: ['evaporator sub-assy, cooler', 'evaporator sub-assy', 'evaporator'], vi: ['dàn lạnh', 'giàn lạnh'] },

  // ── ĐIỆN / ĐIỆN TỬ ──────────────────────────────────────
  { key: 'ac_quy',         label: 'Ắc quy',                    patterns: ['battery'], vi: ['ắc quy', 'bình điện'] },
  { key: 'den_chieu_sang', label: 'Đèn chiếu sáng',            patterns: ['headlamp assy', 'headlamp', 'headlight', 'lamp unit, fog lamp', 'lamp assy, rear combination'], vi: ['đèn pha', 'đèn chiếu sáng'] },
  { key: 'cam_bien',       label: 'Cảm biến',                  patterns: ['sensor, knock control', 'sensor, air fuel ratio', 'sensor, oxygen', 'sensor, speedometer', 'sensor, cam position', 'sensor, crank position', 'switch assy, oil pressure', 'meter sub-assy, intake air flow'], vi: ['cảm biến'] },
  { key: 'tui_khi',        label: 'Túi khí',                   patterns: ['air bag assy, instrument panel', 'sensor assy, air bag', 'airbag', 'air bag'], vi: ['túi khí'] },
];

// 11 loại "bắt buộc" — CHỈ để log/tham khảo, KHÔNG dùng để auto-requeue.
const REQUIRED_KEYS = new Set([
  'loc_dau', 'loc_gio', 'bom_nuoc', 'ket_nuoc', 'may_phat', 'may_de',
  'giam_soc', 'lo_xo', 'ma_phanh', 'dia_phanh', 'ac_quy',
]);

export interface CoverageResult { score: number; missing: string[]; missingRequired: string[]; partCount: number; }

// Tính coverage cho 1 model_line (gộp phụ tùng TẤT CẢ xe có model_name = modelLine).
export async function checkCoverage(pool: Pool, make: string, modelLine: string): Promise<CoverageResult> {
  const client = await pool.connect();
  let combined: string[] = [];   // mỗi phần tử = "name name_vi" (đã LOWER)
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '25s'");   // không giữ connection (chung với worker) quá lâu
    const { rows } = await client.query(`
      SELECT DISTINCT LOWER(cp.name) AS name, LOWER(COALESCE(cp.name_vi, '')) AS name_vi
      FROM catalog_fitments cf
      JOIN catalog_vehicles cv ON cv.id = cf.vehicle_id
      JOIN catalog_products cp ON cp.id = cf.product_id
      WHERE cv.make = $1 AND cv.model_name = $2
        AND cp.name IS NOT NULL AND cp.name NOT LIKE '***%' AND LENGTH(cp.name) > 5
    `, [make, modelLine]);
    await client.query('COMMIT');
    combined = rows.map((r: any) => `${r.name} ${r.name_vi}`);
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }

  let score = 0;
  const missing: string[] = [];
  for (const def of PART_DEFS) {
    const pats = def.patterns.concat(def.vi);
    const found = pats.some(p => combined.some(n => n.includes(p)));
    if (found) score++; else missing.push(def.key);
  }
  const missingRequired = missing.filter(k => REQUIRED_KEYS.has(k));
  return { score, missing, missingRequired, partCount: combined.length };
}

// Chạy sau khi job done: tính coverage, LƯU lên chính job đó. KHÔNG auto-requeue. Fire-and-forget (nuốt lỗi).
export async function runCoverageCheck(pool: Pool, jobId: number, make: string, modelLine: string | null): Promise<void> {
  try {
    if (!make || !modelLine || !modelLine.trim()) return;   // job cả-hãng (model_line rỗng) → bỏ qua
    const { score, missing, missingRequired, partCount } = await checkCoverage(pool, make, modelLine.trim());
    await pool.query(
      `UPDATE catalog_crawl_jobs SET coverage_score = $1, missing_parts = $2, coverage_checked_at = NOW() WHERE id = $3`,
      [score, missing.join(','), jobId]
    );
    console.log(`[COVERAGE] ${make}/${modelLine}: ${score}/50 (${partCount} tên PT) | thiếu bắt buộc: ${missingRequired.length ? missingRequired.join(',') : '(không)'}`);
  } catch (e: any) {
    console.error(`[COVERAGE] Lỗi check job#${jobId} ${make}/${modelLine}:`, e.message);
  }
}
