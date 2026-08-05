#!/usr/bin/env node
/**
 * import-json.mjs — Nạp file JSON catalog PartSouq vào DB
 *
 * Cấu trúc lồng nhau của file luôn cố định:
 *   [ { brand, car_types:[ { car_type, models:[ { ...model...,
 *       categories:[ { category, titles:[ { title, parts:[ {...} ] } ] } ] } ] } ] } ]
 *
 * NHƯNG tên trường ở tầng model thì mỗi file một kiểu:
 *   Suzuki → model_code: "CN21S"
 *   Toyota → model:      "GUN142L-MDMLYV"   + prod_period: "11.2015 - 07.2018"
 *   Ford   → không có mã + manufactured: "1996"
 *            (và có trường "model" nhưng giá trị là "LIGHT TRUCK" — KHÔNG phải mã!)
 *
 * Vì vậy KHÔNG đoán tự động. Mỗi file phải có file config chỉ rõ trường nào ứng với cột nào.
 *
 * CÁCH DÙNG
 *   1) Soi cấu trúc file để biết viết config:
 *        node scripts/import-json.mjs detect duong-dan.json
 *
 *   2) Chạy thử, KHÔNG ghi DB — xem trước sẽ nạp cái gì:
 *        node scripts/import-json.mjs import duong-dan.json --config cfg.json --dry-run
 *
 *   3) Nạp thật:
 *        node scripts/import-json.mjs import duong-dan.json --config cfg.json
 *
 * File to (>500MB) thi tang bo nho cho Node:
 *        node --max-old-space-size=8192 scripts/import-json.mjs import ...
 */

import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

// ════════════════════════════════════════════════════════════
// Tiện ích
// ════════════════════════════════════════════════════════════

/** Chuẩn hoá mã: bỏ hết ký tự không phải chữ/số, viết hoa.
 *  PHẢI khớp đúng công thức cột sinh ref_norm/oem_norm trong 02_schema.sql,
 *  nếu lệch thì ON CONFLICT sẽ không bắt được trùng. */
function chuanHoaMa(s) {
  if (s == null) return null;
  const v = String(s).replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  return v === '' ? null : v;
}

/** "11.2015 - 07.2018" → [2015, 2018] ; "1996" → [1996, 1996] ; rỗng → [null, null] */
function tachNam(s) {
  if (!s) return [null, null];
  const nam = String(s).match(/\d{4}/g);
  if (!nam || !nam.length) return [null, null];
  const tu = parseInt(nam[0]);
  const den = nam.length > 1 ? parseInt(nam[nam.length - 1]) : tu;
  const hopLe = (n) => (n >= 1900 && n <= 2100 ? n : null);
  return [hopLe(tu), hopLe(den)];
}

const rong = (v) => v == null || String(v).trim() === '';
const cat = (s, n) => (s == null ? null : String(s).slice(0, n));

function soDep(n) {
  return n.toLocaleString('vi-VN');
}

// ════════════════════════════════════════════════════════════
// Chế độ DETECT — soi cấu trúc file
// ════════════════════════════════════════════════════════════

async function detect(duongDan) {
  console.log(`\nĐang đọc ${duongDan} ...`);
  const goc = JSON.parse(await readFile(duongDan, 'utf8'));
  const ds = Array.isArray(goc) ? goc : [goc];

  console.log(`\n${'═'.repeat(62)}`);
  console.log(`SOI CẤU TRÚC: ${duongDan}`);
  console.log('═'.repeat(62));

  const b0 = ds[0] || {};
  console.log(`\n[Tầng 1 — hãng]  ${ds.length} mục`);
  console.log(`  Các trường: ${Object.keys(b0).join(', ')}`);
  for (const k of Object.keys(b0)) {
    if (typeof b0[k] !== 'object') console.log(`    ${k} = ${JSON.stringify(b0[k])}`);
  }

  const ct = (b0.car_types || [])[0] || {};
  console.log(`\n[Tầng 2 — car_types]  ${(b0.car_types || []).length} mục`);
  console.log(`  Các trường: ${Object.keys(ct).join(', ')}`);
  for (const k of Object.keys(ct)) {
    if (typeof ct[k] !== 'object') console.log(`    ${k} = ${JSON.stringify(ct[k])}`);
  }

  const md = (ct.models || [])[0] || {};
  console.log(`\n[Tầng 3 — models]  ${(ct.models || []).length} mục  ← TẦNG QUAN TRỌNG NHẤT`);
  console.log(`  Các trường: ${Object.keys(md).join(', ')}`);
  for (const k of Object.keys(md)) {
    if (typeof md[k] !== 'object') console.log(`    ${k} = ${JSON.stringify(md[k])}`);
  }

  const cg = (md.categories || [])[0] || {};
  const tt = (cg.titles || [])[0] || {};
  const pt = (tt.parts || [])[0] || {};
  console.log(`\n[Tầng 6 — parts]`);
  console.log(`  Các trường: ${Object.keys(pt).join(', ')}`);
  for (const k of Object.keys(pt)) console.log(`    ${k} = ${JSON.stringify(pt[k])}`);

  // Thống kê nhanh: bao nhiêu model có mã, bao nhiêu không
  let tongModel = 0;
  const coGiaTri = {};
  for (const b of ds)
    for (const c of b.car_types || [])
      for (const m of c.models || []) {
        tongModel++;
        for (const k of Object.keys(m)) {
          if (typeof m[k] === 'object') continue;
          coGiaTri[k] = (coGiaTri[k] || 0) + (rong(m[k]) ? 0 : 1);
        }
      }

  console.log(`\n[Độ phủ các trường ở tầng model]  tổng ${soDep(tongModel)} model`);
  for (const [k, v] of Object.entries(coGiaTri).sort((a, b) => b[1] - a[1])) {
    const pc = tongModel ? Math.round((v / tongModel) * 100) : 0;
    console.log(`  ${k.padEnd(24)} ${String(pc).padStart(3)}%  (${soDep(v)}/${soDep(tongModel)})`);
  }

  console.log(`\n${'─'.repeat(62)}`);
  console.log('GỢI Ý CONFIG — sửa lại cho khớp rồi lưu thành file .json:');
  console.log('─'.repeat(62));
  const doanMa = md.model_code !== undefined ? 'model_code'
               : md.model !== undefined ? 'model  ← KIỂM TRA KỸ: giá trị có đúng là mã model không?'
               : null;
  const doanNam = md.prod_period !== undefined ? 'prod_period'
                : md.manufactured !== undefined ? 'manufactured'
                : null;
  console.log(JSON.stringify({
    make: 'brand',
    car_type: 'car_type',
    model_name: 'name',
    model_code: doanMa ? doanMa.split(' ')[0] : null,
    year: doanNam,
    part_number: 'number',
    part_name: 'name',
    part_name_vi: 'name_vi',
    product_type: 'genuine',
    brand_tu_make: true,
  }, null, 2));
  if (doanMa && doanMa.includes('KIỂM TRA')) {
    console.log(`\n⚠  Trường "model" của file này = ${JSON.stringify(md.model)}`);
    console.log('   Nếu đó là LOẠI XE chứ không phải mã model thì đặt "model_code": null');
  }
  if (!doanMa) {
    console.log('\n⚠  File này KHÔNG có mã model → đặt "model_code": null');
    console.log('   Script sẽ tự lấy tên model làm mã thay thế (xem cảnh báo lúc chạy).');
  }
  console.log('');
}

// ════════════════════════════════════════════════════════════
// Chế độ IMPORT
// ════════════════════════════════════════════════════════════

/** Đọc file + config → gom thành 3 tập: xe, phụ tùng, fitment */
function bocTach(goc, cfg, duongDan) {
  const ds = Array.isArray(goc) ? goc : [goc];

  const xe = new Map();        // "MAKE|MODEL_CODE" → {make, model_code, model_name, year_from, year_to, description}
  const phuTung = new Map();   // ref_norm → {internal_ref, oem_code, name, name_vi, brand, notes}
  const capNoi = new Set();    // "ref_norm|MAKE|MODEL_CODE"

  const canhBao = {
    model_thieu_ma: 0,
    part_thieu_ma: 0,
    part_thieu_ten: 0,
    model_trung_ma: new Map(),
  };

  for (const b of ds) {
    const make = cfg.make ? b[cfg.make] : null;
    if (rong(make)) continue;
    const makeSach = String(make).trim();

    for (const c of b.car_types || []) {
      const carType = cfg.car_type ? c[cfg.car_type] : null;

      for (const m of c.models || []) {
        const tenModel = cfg.model_name ? m[cfg.model_name] : null;
        let maModel = cfg.model_code ? m[cfg.model_code] : null;

        // Không có mã → lấy tên làm mã. Ghi nhận để cảnh báo.
        let dungTam = false;
        if (rong(maModel)) {
          if (rong(tenModel)) continue;            // không có gì để định danh → bỏ
          maModel = String(tenModel).trim().toUpperCase();
          dungTam = true;
          canhBao.model_thieu_ma++;
        }
        const maSach = String(maModel).trim().toUpperCase();
        const khoaXe = `${makeSach}|${maSach}`;

        const [namTu, namDen] = tachNam(cfg.year ? m[cfg.year] : null);

        if (!xe.has(khoaXe)) {
          xe.set(khoaXe, {
            make: cat(makeSach, 100),
            model_code: cat(maSach, 100),
            model_name: cat(rong(tenModel) ? null : String(tenModel).trim(), 200),
            year_from: namTu,
            year_to: namDen,
            description: cat(rong(carType) ? null : String(carType).trim(), 255),
          });
        }
        // Cùng mã nhưng khác tên → dấu hiệu mã bị dùng chung, cần báo
        if (dungTam) {
          const cu = canhBao.model_trung_ma.get(khoaXe) || new Set();
          cu.add(String(tenModel).trim());
          canhBao.model_trung_ma.set(khoaXe, cu);
        }

        for (const cg of m.categories || []) {
          const danhMuc = cg.category ?? null;
          for (const tt of cg.titles || []) {
            const tieuDe = tt.title ?? null;
            for (const p of tt.parts || []) {
              const so = cfg.part_number ? p[cfg.part_number] : null;
              if (rong(so)) { canhBao.part_thieu_ma++; continue; }

              const ref = chuanHoaMa(so);
              if (!ref) { canhBao.part_thieu_ma++; continue; }

              const ten = cfg.part_name ? p[cfg.part_name] : null;
              const tenVi = cfg.part_name_vi ? p[cfg.part_name_vi] : null;

              // Tên ưu tiên name_vi, trống mới dùng name (theo yêu cầu)
              const tenHienThi = !rong(tenVi) ? String(tenVi).trim()
                               : !rong(ten) ? String(ten).trim()
                               : null;
              if (!tenHienThi) { canhBao.part_thieu_ten++; continue; }

              if (!phuTung.has(ref)) {
                const maGoc = String(so).trim();
                phuTung.set(ref, {
                  internal_ref: cat(maGoc, 100),
                  oem_code: cat(maGoc, 100),
                  name: cat(rong(ten) ? tenHienThi : String(ten).trim(), 500),
                  name_vi: rong(tenVi) ? null : String(tenVi).trim(),
                  brand: cfg.brand_tu_make ? cat(makeSach, 100) : null,
                  notes: cat([danhMuc, tieuDe].filter(Boolean).join(' | ') || null, 1000),
                });
              } else {
                // Đã có: bổ sung tên tiếng Việt nếu lần trước còn trống
                const cu = phuTung.get(ref);
                if (rong(cu.name_vi) && !rong(tenVi)) cu.name_vi = String(tenVi).trim();
              }

              capNoi.add(`${ref}\u0000${khoaXe}`);
            }
          }
        }
      }
    }
  }

  return { xe, phuTung, capNoi, canhBao, duongDan };
}

/** Chèn theo lô, trả về Map khoá → id */
async function chenTheoLo(client, sql, hang, soCot, layKhoa, kichThuocLo) {
  const ketQua = new Map();
  for (let i = 0; i < hang.length; i += kichThuocLo) {
    const lo = hang.slice(i, i + kichThuocLo);
    const cho = lo.map((_, j) =>
      `(${Array.from({ length: soCot }, (_, k) => `$${j * soCot + k + 1}`).join(',')})`
    ).join(',');
    const thamSo = lo.flat();
    const res = await client.query(sql.replace('__VALUES__', cho), thamSo);
    for (const r of res.rows) ketQua.set(layKhoa(r), r.id);
    process.stdout.write(`\r    ${soDep(Math.min(i + kichThuocLo, hang.length))}/${soDep(hang.length)}`);
  }
  if (hang.length) process.stdout.write('\n');
  return ketQua;
}

async function nhapDuLieu(duongDan, duongDanCfg, chayThu, gioiHan) {
  const cfg = JSON.parse(await readFile(duongDanCfg, 'utf8'));

  console.log(`\nĐang đọc ${duongDan} ...`);
  const goc = JSON.parse(await readFile(duongDan, 'utf8'));

  console.log('Đang bóc tách ...');
  const { xe, phuTung, capNoi, canhBao } = bocTach(goc, cfg, duongDan);

  console.log(`\n${'═'.repeat(62)}`);
  console.log(`KẾT QUẢ BÓC TÁCH: ${duongDan}`);
  console.log('═'.repeat(62));
  console.log(`  Xe        : ${soDep(xe.size)}`);
  console.log(`  Phụ tùng  : ${soDep(phuTung.size)}  (đã gộp trùng theo mã)`);
  console.log(`  Fitment   : ${soDep(capNoi.size)}`);

  if (canhBao.model_thieu_ma || canhBao.part_thieu_ma || canhBao.part_thieu_ten) {
    console.log(`\n  ── Cảnh báo ──`);
    if (canhBao.model_thieu_ma)
      console.log(`  ${soDep(canhBao.model_thieu_ma)} model KHÔNG có mã → đã lấy tên model làm mã`);
    if (canhBao.part_thieu_ma)
      console.log(`  ${soDep(canhBao.part_thieu_ma)} phụ tùng KHÔNG có mã → ĐÃ BỎ QUA`);
    if (canhBao.part_thieu_ten)
      console.log(`  ${soDep(canhBao.part_thieu_ten)} phụ tùng không có tên → ĐÃ BỎ QUA`);
  }

  const gopNham = [...canhBao.model_trung_ma.entries()].filter(([, v]) => v.size > 1);
  if (gopNham.length) {
    console.log(`\n  ⚠  ${soDep(gopNham.length)} mã model bị DÙNG CHUNG bởi nhiều xe khác nhau.`);
    console.log(`     Chúng sẽ bị gộp làm một → phụ tùng có thể gắn nhầm xe.`);
    for (const [k, v] of gopNham.slice(0, 3))
      console.log(`       ${k}  ←  ${[...v].slice(0, 3).join(' / ')}`);
  }

  console.log(`\n  ── Mẫu 3 xe ──`);
  for (const v of [...xe.values()].slice(0, 3))
    console.log(`  ${v.make} | ${v.model_code} | ${v.model_name ?? '—'} | ${v.year_from ?? '—'}-${v.year_to ?? '—'} | ${v.description ?? '—'}`);

  console.log(`\n  ── Mẫu 3 phụ tùng ──`);
  for (const p of [...phuTung.values()].slice(0, 3))
    console.log(`  ${p.internal_ref} | ${p.name} | VI: ${p.name_vi ?? '—'} | brand: ${p.brand ?? '—'}`);

  if (chayThu) {
    console.log(`\n>> CHẠY THỬ — không ghi gì vào DB.`);
    console.log(`   Thấy đúng rồi thì bỏ --dry-run để nạp thật.\n`);
    return;
  }

  // ── Ghi DB ────────────────────────────────────────────────
  const pool = new pg.Pool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME || 'catalog',
    user: process.env.DB_USER || 'catalog_user',
    password: process.env.DB_PASSWORD,
    max: 4,
  });
  const client = await pool.connect();

  try {
    console.log(`\nGhi vào DB "${process.env.DB_NAME}" ...`);
    await client.query('BEGIN');

    // 1) XE
    console.log('  [1/3] Xe');
    const hangXe = [...xe.values()].map(v =>
      [v.make, v.model_code, v.model_name, v.year_from, v.year_to, v.description]);
    const idXe = await chenTheoLo(client, `
      INSERT INTO catalog_vehicles (make, model_code, model_name, year_from, year_to, description)
      VALUES __VALUES__
      ON CONFLICT (make, model_code) DO UPDATE SET
        model_name = COALESCE(EXCLUDED.model_name, catalog_vehicles.model_name),
        year_from  = COALESCE(EXCLUDED.year_from,  catalog_vehicles.year_from),
        year_to    = COALESCE(EXCLUDED.year_to,    catalog_vehicles.year_to),
        updated_at = now()
      RETURNING id, make, model_code
    `, hangXe, 6, r => `${r.make}|${r.model_code}`, 300);

    // 2) PHỤ TÙNG
    console.log('  [2/3] Phụ tùng');
    const loaiHang = cfg.product_type || 'genuine';
    const hangPt = [...phuTung.values()].map(p =>
      [p.name, p.name_vi, p.internal_ref, p.oem_code, p.brand, loaiHang, p.notes,
       [p.name, p.name_vi, p.internal_ref].filter(Boolean).join(' ')]);
    const idPt = await chenTheoLo(client, `
      INSERT INTO catalog_products
        (name, name_vi, internal_ref, oem_code, brand, product_type, notes, search_text)
      VALUES __VALUES__
      ON CONFLICT (ref_norm) WHERE ref_norm IS NOT NULL DO UPDATE SET
        name_vi     = COALESCE(NULLIF(EXCLUDED.name_vi,''), catalog_products.name_vi),
        brand       = COALESCE(EXCLUDED.brand, catalog_products.brand),
        search_text = EXCLUDED.search_text,
        updated_at  = now()
      RETURNING id, ref_norm
    `, hangPt, 8, r => r.ref_norm, 400);

    // 3) FITMENT
    console.log('  [3/3] Fitment');
    const capHopLe = [];
    let hong = 0;
    for (const cap of capNoi) {
      const [ref, khoaXe] = cap.split('\u0000');
      const pid = idPt.get(ref), vid = idXe.get(khoaXe);
      if (pid && vid) capHopLe.push([pid, vid]); else hong++;
    }
    let daChen = 0;
    for (let i = 0; i < capHopLe.length; i += 800) {
      const lo = capHopLe.slice(i, i + 800);
      const cho = lo.map((_, j) => `($${j * 2 + 1},$${j * 2 + 2})`).join(',');
      const res = await client.query(
        `INSERT INTO catalog_fitments (product_id, vehicle_id) VALUES ${cho}
         ON CONFLICT (product_id, vehicle_id) DO NOTHING RETURNING id`,
        lo.flat());
      daChen += res.rowCount;
      process.stdout.write(`\r    ${soDep(Math.min(i + 800, capHopLe.length))}/${soDep(capHopLe.length)}`);
    }
    if (capHopLe.length) process.stdout.write('\n');

    await client.query('COMMIT');

    console.log(`\n${'═'.repeat(62)}`);
    console.log('ĐÃ NẠP XONG');
    console.log('═'.repeat(62));
    console.log(`  Xe       : ${soDep(idXe.size)}`);
    console.log(`  Phụ tùng : ${soDep(idPt.size)}`);
    console.log(`  Fitment  : ${soDep(daChen)} dòng mới  (${soDep(capHopLe.length - daChen)} đã có sẵn)`);
    if (hong) console.log(`  ⚠ ${soDep(hong)} fitment bỏ qua do không khớp được id`);
    console.log('');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(`\n✗ LỖI — đã huỷ toàn bộ, DB giữ nguyên như trước:\n  ${e.message}`);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

// ════════════════════════════════════════════════════════════
// Vào chương trình
// ════════════════════════════════════════════════════════════

const tt = process.argv.slice(2);
const lenh = tt[0];
const tep = tt[1];
const cfg = tt[tt.indexOf('--config') + 1];
const chayThu = tt.includes('--dry-run');

if (lenh === 'detect' && tep) {
  await detect(tep);
} else if (lenh === 'import' && tep && tt.includes('--config')) {
  await nhapDuLieu(tep, cfg, chayThu);
} else {
  console.log(`
Nạp file JSON catalog PartSouq vào DB

  Soi cấu trúc file (chạy cái này TRƯỚC để biết viết config):
    node scripts/import-json.mjs detect <file.json>

  Chạy thử, không ghi DB:
    node scripts/import-json.mjs import <file.json> --config <cfg.json> --dry-run

  Nạp thật:
    node scripts/import-json.mjs import <file.json> --config <cfg.json>

File to thi tang bo nho:
    node --max-old-space-size=8192 scripts/import-json.mjs import ...
`);
}
