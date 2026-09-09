#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
nap_json2.py — Nạp CẢ THƯ MỤC JSON kiểu "toyodiy" vào DB (khác nap_json.py
vốn nạp 1 file 6 tầng nhiều model/xe).

Cấu trúc mỗi file (1 file = ĐÚNG 1 xe, không có brand/car_types/năm/engine):
    { "model_label": "A200A-GBLV",
      "tabs": [ { "tab_name": "Engine / Fuel",
        "diagrams": [ { "desc": "CYLINDER HEAD",
          "groups": [ { "name": "GASKET, CYLINDER HEAD COVER",
                         "code": "11213-B1031",
                         "name_vi": "..." }, ... ] } ] } ] }

    python scripts/nap_json2.py <thu_muc> --soi     # xem vài file mẫu
    python scripts/nap_json2.py <thu_muc> --thu     # chạy thử, KHÔNG ghi DB
    python scripts/nap_json2.py <thu_muc>            # nạp thật

Dùng file trong outputs_cleaned_vi/ (SAU khi chạy them_vi2.py) để có sẵn
name_vi; chạy thẳng trên outputs_cleaned/ (chưa dịch) vẫn nạp được,
name_vi để trống, cột "name" (tìm kiếm) sẽ dùng tên tiếng Anh gốc.
"""

import sys, os, json, re, argparse, glob
from collections import OrderedDict

# ╔══════════════════════════════════════════════════════════════════════╗
# ║  CẤU HÌNH                                                             ║
# ╚══════════════════════════════════════════════════════════════════════╝

MAKE = "Toyota"          # ★ hãng xe — file không có field này, gán cứng ở đây
PRODUCT_TYPE = "genuine"
BRAND_LA_HANG_XE = True   # brand phụ tùng = MAKE ở trên
IS_FOR_SALE = True

# Rác kiểu "*** STD. PART" / "*** STD. PART$1.07" — không dùng làm tên phụ tùng
RE_STD_PART = re.compile(r"^\*+\s*STD\.?\s*PART", re.IGNORECASE)

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

GOC_PROJECT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def doc_env():
    env = {}
    dd = os.path.join(GOC_PROJECT, ".env")
    if not os.path.exists(dd):
        return env
    with open(dd, "r", encoding="utf-8-sig") as f:
        for dong in f:
            dong = dong.strip()
            if not dong or dong.startswith("#") or "=" not in dong:
                continue
            k, _, v = dong.partition("=")
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def cau_hinh_db():
    env = doc_env()
    dd = os.path.join(GOC_PROJECT, ".env")
    if not env:
        print(f"✗ Không đọc được file .env tại:\n    {dd}")
        sys.exit(1)
    thieu = [k for k in ("DB_NAME", "DB_USER", "DB_PASSWORD") if not env.get(k)]
    if thieu:
        print(f"✗ File .env thiếu: {', '.join(thieu)}\n    {dd}")
        sys.exit(1)
    return {
        "host": env.get("DB_HOST", "localhost"),
        "port": int(env.get("DB_PORT", 5432)),
        "dbname": env["DB_NAME"],
        "user": env["DB_USER"],
        "password": env["DB_PASSWORD"],
    }


def chuan_hoa_ma(s):
    """PHẢI khớp đúng công thức ref_norm trong deploy/sql/02_schema.sql:
        NULLIF(upper(regexp_replace(coalesce(x,''),'[^a-zA-Z0-9]','','g')),'')"""
    if s is None:
        return None
    s = re.sub(r"[^a-zA-Z0-9]", "", str(s))
    return s.upper() or None


def rong(v):
    return v is None or str(v).strip() == ""


def cat(v, n):
    if v is None:
        return None
    v = str(v).strip()
    return v[:n] if v else None


def so_dep(n):
    return f"{n:,}".replace(",", ".")


def la_rac(ten):
    """'*** STD. PART' / '*** STD. PART$1.07' — không phải tên phụ tùng thật."""
    return bool(ten) and bool(RE_STD_PART.match(str(ten).strip()))


def doc_json_an_toan(path):
    for enc in ("utf-8", "utf-8-sig", "utf-16", "latin-1"):
        try:
            with open(path, encoding=enc) as f:
                return json.load(f)
        except Exception:
            continue
    return None


def liet_ke_file(thu_muc):
    files = sorted(glob.glob(os.path.join(thu_muc, "*.json")))
    if not files:
        print(f"✗ Không có file .json nào trong: {thu_muc}")
        sys.exit(1)
    return files


# ── SOI ────────────────────────────────────────────────────────────────

def soi(thu_muc):
    files = liet_ke_file(thu_muc)
    print(f"📂 Thư mục: {thu_muc}  ({so_dep(len(files))} file .json)\n")
    print(f"MAKE đang gán cứng: {MAKE!r}  (sửa hằng số MAKE ở đầu file nếu sai)\n")

    mau = files[: min(3, len(files))]
    for path in mau:
        data = doc_json_an_toan(path)
        print("-" * 68)
        print(os.path.basename(path))
        print("-" * 68)
        if data is None:
            print("  ✗ KHÔNG ĐỌC ĐƯỢC JSON")
            continue
        print(f"  model_label = {data.get('model_label')!r}  → model_code")
        so_tab = len(data.get("tabs") or [])
        so_diagram = sum(len(t.get("diagrams") or []) for t in data.get("tabs") or [])
        so_group = sum(len(d.get("groups") or [])
                        for t in data.get("tabs") or []
                        for d in t.get("diagrams") or [])
        print(f"  {so_dep(so_tab)} tab, {so_dep(so_diagram)} diagram, "
              f"{so_dep(so_group)} phụ tùng (groups)")
        vidu = None
        for t in data.get("tabs") or []:
            for d in t.get("diagrams") or []:
                for g in d.get("groups") or []:
                    if not la_rac(g.get("name")) and not rong(g.get("code")):
                        vidu = (t.get("tab_name"), d.get("desc"), g)
                        break
                if vidu:
                    break
            if vidu:
                break
        if vidu:
            tab_name, desc, g = vidu
            print(f"  Mẫu 1 phụ tùng: [{tab_name} / {desc}]")
            print(f"    code={g.get('code')!r}  name={g.get('name')!r}  "
                  f"name_vi={g.get('name_vi')!r}")
        print("")

    # đếm nhanh model_label trùng nhau giữa các file
    dem_ml = {}
    for path in files:
        data = doc_json_an_toan(path)
        if data is None:
            continue
        ml = data.get("model_label")
        if rong(ml):
            continue
        dem_ml.setdefault(str(ml).strip().upper(), []).append(os.path.basename(path))
    trung = {k: v for k, v in dem_ml.items() if len(v) > 1}
    print("-" * 68)
    print("KIỂM TRA model_label TRÙNG GIỮA CÁC FILE")
    print("-" * 68)
    if trung:
        print(f"  ⚠ {so_dep(len(trung))} model_code trùng giữa nhiều file "
              f"→ phụ tùng sẽ gộp vào cùng 1 xe khi nạp:")
        for k, v in list(trung.items())[:10]:
            print(f"    {k}  ×{len(v)}   {', '.join(v)}")
        if len(trung) > 10:
            print(f"    ... và {so_dep(len(trung) - 10)} mã nữa")
    else:
        print("  ✓ Không trùng — mỗi file ra đúng 1 xe riêng")
    print("")


# ── BÓC TÁCH ──────────────────────────────────────────────────────────

def boc_tach(thu_muc):
    files = liet_ke_file(thu_muc)

    xe, phu_tung = {}, {}
    cap_noi = {}   # (ref, model_code) → set() (không có ghi_chu_ban_xe ở dạng này)
    cb = {"file_loi": [], "model_thieu_ma": 0, "part_thieu_ma": 0,
          "part_chi_co_ma": 0, "tong_file": len(files)}
    gop = {}       # model_code → danh sách tên file đã dồn vào đó

    for path in files:
        data = doc_json_an_toan(path)
        if data is None:
            cb["file_loi"].append(os.path.basename(path))
            continue

        model_code = data.get("model_label")
        if rong(model_code):
            cb["model_thieu_ma"] += 1
            continue
        model_code = cat(str(model_code).strip(), 100)

        # File "toyodiy" không có năm/engine/transmission/... → biến thể
        # (variant_key) rỗng cho MỌI xe. PHẢI khớp đúng công thức cột sinh
        # variant_key trong deploy/sql/02_schema.sql: 8 trường nối bằng "|"
        # (year_from, year_to, engine, transmission, drive_type, steering,
        # gear_shift, description) — tất cả rỗng → đúng 7 dấu "|" liền nhau.
        # Sai số lượng dấu "|" là Python và DB tính ra khoá khác nhau →
        # fitment không khớp được vehicle_id (đã gặp lỗi này lúc nạp thật).
        khoa_xe = f"{MAKE}|{model_code}|" + "|" * 7

        if khoa_xe not in xe:
            xe[khoa_xe] = {
                "make": cat(MAKE, 100),
                "model_code": model_code,
                "model_name": None,
                "year_from": None, "year_to": None,
                "description": None,
                "vehicle_type": None, "engine": None, "transmission": None,
                "drive_type": None, "steering": None, "gear_shift": None,
                "specs_raw": None,
            }
        gop.setdefault(khoa_xe, []).append(os.path.basename(path))

        for tab in data.get("tabs") or []:
            danh_muc = tab.get("tab_name")
            for diagram in tab.get("diagrams") or []:
                tieu_de = diagram.get("desc")
                for g in diagram.get("groups") or []:
                    ref = chuan_hoa_ma(g.get("code"))
                    if not ref:
                        cb["part_thieu_ma"] += 1
                        continue

                    ten = g.get("name")
                    ten_vi = g.get("name_vi")
                    rac = la_rac(ten)
                    ten_that = None if rac else (None if rong(ten) else str(ten).strip())
                    ten_vi_that = None if (rac or rong(ten_vi)) else str(ten_vi).strip()

                    if ref not in phu_tung:
                        phu_tung[ref] = {
                            "internal_ref": cat(str(g.get("code")).strip(), 100),
                            "oem_code": cat(str(g.get("code")).strip(), 100),
                            "name": ten_that,          # có thể None — bù ở cuối
                            "name_vi": ten_vi_that,
                            "brand": cat(MAKE, 100) if BRAND_LA_HANG_XE else None,
                            "notes": cat(" | ".join(x for x in (danh_muc, tieu_de) if x) or None, 1000),
                        }
                    else:
                        cu = phu_tung[ref]
                        if rong(cu["name"]) and ten_that:
                            cu["name"] = ten_that
                        if rong(cu["name_vi"]) and ten_vi_that:
                            cu["name_vi"] = ten_vi_that

                    cap_noi.setdefault((ref, khoa_xe), set())

    # Phụ tùng CHỈ xuất hiện dưới dạng rác ("*** STD. PART", không có tên
    # thật ở bất kỳ chỗ nào) → vẫn nạp, lấy MÃ làm tên (giống nap_json.py).
    for ref, p in phu_tung.items():
        if rong(p["name"]):
            cb["part_chi_co_ma"] += 1
            p["name"] = p["internal_ref"]

    cb["gop"] = {k: v for k, v in gop.items() if len(v) > 1}
    return xe, phu_tung, cap_noi, cb


# ── NẠP ───────────────────────────────────────────────────────────────

def nap(thu_muc, chay_thu):
    print(f"\nĐọc thư mục {thu_muc} ...")
    xe, phu_tung, cap_noi, cb = boc_tach(thu_muc)

    print("\n" + "=" * 68)
    print(f"KẾT QUẢ: {thu_muc}")
    print("=" * 68)
    print(f"  File trong thư mục : {so_dep(cb['tong_file'])}")
    print(f"  Xe vào DB          : {so_dep(len(xe))}")
    print(f"  Phụ tùng           : {so_dep(len(phu_tung))}   (đã gộp trùng theo mã)")
    print(f"  Fitment            : {so_dep(len(cap_noi))}")

    if cb["file_loi"]:
        print(f"\n  ⚠  {so_dep(len(cb['file_loi']))} file KHÔNG đọc được (bỏ qua):")
        for n in cb["file_loi"][:10]:
            print(f"       - {n}")
        if len(cb["file_loi"]) > 10:
            print(f"       ... và {so_dep(len(cb['file_loi']) - 10)} file nữa")

    if cb["model_thieu_ma"] or cb["part_thieu_ma"] or cb["part_chi_co_ma"]:
        print("\n  -- Cảnh báo --")
        if cb["model_thieu_ma"]:
            print(f"  {so_dep(cb['model_thieu_ma'])} file thiếu model_label → BỎ QUA cả file")
        if cb["part_thieu_ma"]:
            print(f"  {so_dep(cb['part_thieu_ma'])} phụ tùng không có mã (code rỗng) → BỎ QUA")
        if cb["part_chi_co_ma"]:
            print(f"  {so_dep(cb['part_chi_co_ma'])} phụ tùng chỉ có dòng rác "
                  f"\"*** STD. PART\" → VẪN NẠP, lấy mã làm tên")

    if cb["gop"]:
        thua = sum(len(v) - 1 for v in cb["gop"].values())
        print(f"\n  ⚠  {so_dep(len(cb['gop']))} model_code TRÙNG giữa nhiều file "
              f"→ {so_dep(thua)} file dồn chung vào 1 xe:")
        for k, v in list(cb["gop"].items())[:5]:
            ma = k.split("|")[1]
            print(f"       {ma}  ×{len(v)}   {', '.join(v)}")
        if len(cb["gop"]) > 5:
            print(f"       ... và {so_dep(len(cb['gop']) - 5)} mã nữa")

    print("\n  -- Mẫu 3 xe --")
    for v in list(xe.values())[:3]:
        print(f"  {v['make']} | {v['model_code']}")
    print("\n  -- Mẫu 3 phụ tùng --")
    for p in list(phu_tung.values())[:3]:
        print(f"  {p['internal_ref']} | {p['name']} | VI: {p['name_vi']} | brand: {p['brand']}")

    if chay_thu:
        print("\n>> CHẠY THỬ — không ghi gì vào DB. Bỏ --thu để nạp thật.\n")
        return

    import psycopg2
    from psycopg2.extras import execute_values

    tt = cau_hinh_db()
    print(f"\nGhi vào DB '{tt['dbname']}' trên {tt['host']}:{tt['port']} ...")
    conn = psycopg2.connect(**tt)
    try:
        cur = conn.cursor()

        # 1) XE
        print("  [1/3] Xe")
        hang_xe = [(v["make"], v["model_code"], v["model_name"],
                    v["year_from"], v["year_to"], v["description"],
                    v["vehicle_type"], v["engine"], v["transmission"],
                    v["drive_type"], v["steering"], v["gear_shift"], v["specs_raw"])
                   for v in xe.values()]
        id_xe = {}
        for i in range(0, len(hang_xe), 400):
            rows = execute_values(cur, """
                INSERT INTO catalog_vehicles
                    (make, model_code, model_name, year_from, year_to, description,
                     vehicle_type, engine, transmission, drive_type, steering,
                     gear_shift, specs_raw)
                VALUES %s
                ON CONFLICT (make, model_code, variant_key) DO UPDATE SET
                    model_name  = COALESCE(catalog_vehicles.model_name,  EXCLUDED.model_name),
                    description = COALESCE(catalog_vehicles.description, EXCLUDED.description),
                    specs_raw   = COALESCE(catalog_vehicles.specs_raw,   EXCLUDED.specs_raw),
                    updated_at  = now()
                RETURNING id, make, model_code, variant_key
            """, hang_xe[i:i + 400], fetch=True)
            for r in rows:
                id_xe[f"{r[1]}|{r[2]}|{r[3]}"] = r[0]
            print(f"\r    {so_dep(min(i + 400, len(hang_xe)))}/{so_dep(len(hang_xe))}", end="")
        if hang_xe:
            print()

        # 2) PHỤ TÙNG
        print("  [2/3] Phụ tùng")
        hang_pt = [(p["name"], p["name_vi"], p["internal_ref"], p["oem_code"],
                    p["brand"], PRODUCT_TYPE, IS_FOR_SALE, p["notes"],
                    " ".join(dict.fromkeys(
                        x for x in (p["name"], p["name_vi"], p["internal_ref"]) if x)))
                   for p in phu_tung.values()]
        id_pt = {}
        for i in range(0, len(hang_pt), 500):
            rows = execute_values(cur, """
                INSERT INTO catalog_products
                    (name, name_vi, internal_ref, oem_code, brand,
                     product_type, is_for_sale, notes, search_text)
                VALUES %s
                ON CONFLICT (ref_norm) WHERE ref_norm IS NOT NULL DO UPDATE SET
                    name        = COALESCE(NULLIF(EXCLUDED.name,''),    catalog_products.name),
                    name_vi     = COALESCE(NULLIF(EXCLUDED.name_vi,''), catalog_products.name_vi),
                    brand       = COALESCE(EXCLUDED.brand, catalog_products.brand),
                    search_text = EXCLUDED.search_text,
                    updated_at  = now()
                RETURNING id, ref_norm
            """, hang_pt[i:i + 500], fetch=True)
            for r in rows:
                id_pt[r[1]] = r[0]
            print(f"\r    {so_dep(min(i + 500, len(hang_pt)))}/{so_dep(len(hang_pt))}", end="")
        if hang_pt:
            print()

        # 3) FITMENT
        print("  [3/3] Fitment")
        cap, hong = [], 0
        for (ref, khoa_xe), _ in cap_noi.items():
            pid, vid = id_pt.get(ref), id_xe.get(khoa_xe)
            if pid and vid:
                cap.append((pid, vid, None))
            else:
                hong += 1
        da_chen = 0
        for i in range(0, len(cap), 1000):
            rows = execute_values(cur, """
                INSERT INTO catalog_fitments (product_id, vehicle_id, notes)
                VALUES %s
                ON CONFLICT (product_id, vehicle_id) DO NOTHING
                RETURNING id
            """, cap[i:i + 1000], fetch=True)
            da_chen += len(rows)
            print(f"\r    {so_dep(min(i + 1000, len(cap)))}/{so_dep(len(cap))}", end="")
        if cap:
            print()

        conn.commit()
        print("\n" + "=" * 68)
        print("ĐÃ NẠP XONG")
        print("=" * 68)
        print(f"  Xe       : {so_dep(len(id_xe))}")
        print(f"  Phụ tùng : {so_dep(len(id_pt))}")
        print(f"  Fitment  : {so_dep(da_chen)} dòng mới  ({so_dep(len(cap) - da_chen)} đã có sẵn)")
        if hong:
            print(f"  ⚠ {so_dep(hong)} fitment bỏ qua vì không khớp được id")
        print("")
        print("  ── Việc còn lại ──")
        print("  Bấm nút “⟳ Tính lại độ phủ” trên /fitment-matrix, hoặc chạy:")
        print("      curl -X POST http://localhost:3001/api/v1/catalog/fitment-matrix/rebuild")
        print("")
    except Exception as e:
        conn.rollback()
        print(f"\n✗ LỖI — đã huỷ toàn bộ, DB giữ nguyên như trước:\n  {e}")
        sys.exit(1)
    finally:
        conn.close()


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Nạp cả thư mục JSON kiểu toyodiy vào DB")
    ap.add_argument("thu_muc", help="đường dẫn thư mục chứa các file .json")
    ap.add_argument("--soi", action="store_true", help="xem vài file mẫu + kiểm tra trùng model_label")
    ap.add_argument("--thu", action="store_true", help="chạy thử, không ghi DB")
    a = ap.parse_args()

    if a.soi:
        soi(a.thu_muc)
    else:
        nap(a.thu_muc, a.thu)
