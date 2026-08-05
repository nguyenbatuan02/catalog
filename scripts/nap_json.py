#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
nap_json.py — Nạp 1 file JSON catalog PartSouq vào DB. Chạy từng file một.

    python scripts/nap_json.py duong-dan.json              # nạp thật
    python scripts/nap_json.py duong-dan.json --thu        # chạy thử, không ghi DB
    python scripts/nap_json.py duong-dan.json toyota       # chọn cấu hình khác
    python scripts/nap_json.py duong-dan.json --soi        # chỉ xem file có trường gì

Cấu trúc file JSON luôn cố định:
    [ { brand, car_types:[ { car_type, models:[ { ...MODEL...,
        categories:[ { category, titles:[ { title, parts:[ {...} ] } ] } ] } ] } ] } ]

Chỉ có TÊN TRƯỜNG Ở TẦNG MODEL là mỗi file một kiểu → sửa ở phần CẤU HÌNH bên dưới.
"""

import sys, os, json, re, argparse

# ╔══════════════════════════════════════════════════════════════════╗
# ║  CẤU HÌNH — SỬA Ở ĐÂY                                            ║
# ║  Bên trái = cột trong DB. Bên phải = tên trường trong file JSON.  ║
# ║  Không có trường đó trong file thì để None.                      ║
# ╚══════════════════════════════════════════════════════════════════╝

CAU_HINH = {

    # ── Dạng Suzuki: mã model ở trường "model_code", không có năm ──
    "suzuki": {
        "make":          "brand",        # → catalog_vehicles.make        (hãng xe)
        "car_type":      "car_type",     # → catalog_vehicles.description (thị trường)
        "model_name":    "name",         # → catalog_vehicles.model_name
        "model_code":    "model_code",   # → catalog_vehicles.model_code
        "year":          None,           # → year_from / year_to
        "part_number":   "number",       # → internal_ref VÀ oem_code
        "part_name":     "name",         # → catalog_products.name
        "part_name_vi":  "name_vi",      # → catalog_products.name_vi
        "product_type":  "genuine",      # giá trị cố định
        "brand_tu_make": True,           # brand phụ tùng = tên hãng xe
    },

    # ── Dạng Toyota: mã model ở trường "model", năm ở "prod_period" ──
    "toyota": {
        "make":          "brand",
        "car_type":      "car_type",
        "model_name":    "name",
        "model_code":    "model",        # "GUN142L-MDMLYV"
        "year":          "prod_period",  # "11.2015 - 07.2018"
        "part_number":   "number",
        "part_name":     "name",
        "part_name_vi":  "name_vi",
        "product_type":  "genuine",
        "brand_tu_make": True,
    },

    # ── Dạng Ford: KHÔNG có mã model ──
    #    Chú ý: file này cũng có trường "model" nhưng giá trị là "LIGHT TRUCK"
    #    (loại xe), KHÔNG phải mã → bắt buộc để None, nếu không sẽ hỏng dữ liệu.
    "ford": {
        "make":          "brand",
        "car_type":      "car_type",
        "model_name":    "name",
        "model_code":    None,           # không có → script lấy tên model làm mã
        "year":          "manufactured", # "1996"
        "part_number":   "number",
        "part_name":     "name",
        "part_name_vi":  "name_vi",
        "product_type":  "genuine",
        "brand_tu_make": True,
    },
}

# Dùng cấu hình nào khi không truyền tên ở dòng lệnh
MAC_DINH = "suzuki"

# ╔══════════════════════════════════════════════════════════════════╗
# ║  KẾT NỐI DB — tự đọc từ file .env ở thư mục gốc project.          ║
# ║  Muốn ghi đè thì sửa thẳng vào đây.                              ║
# ╚══════════════════════════════════════════════════════════════════╝
DB = {
    "host":     None,   # None = lấy DB_HOST trong .env
    "port":     None,
    "dbname":   None,
    "user":     None,
    "password": None,
}

# ════════════════════════════════════════════════════════════════════
# Từ đây trở xuống không cần sửa
# ════════════════════════════════════════════════════════════════════

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

GOC_PROJECT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def doc_env():
    """Đọc file .env đơn giản, không cần thư viện ngoài."""
    env = {}
    duong_dan = os.path.join(GOC_PROJECT, ".env")
    if not os.path.exists(duong_dan):
        return env
    with open(duong_dan, "r", encoding="utf-8-sig") as f:
        for dong in f:
            dong = dong.strip()
            if not dong or dong.startswith("#") or "=" not in dong:
                continue
            k, _, v = dong.partition("=")
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def cau_hinh_db():
    env = doc_env()
    return {
        "host":     DB["host"]     or env.get("DB_HOST", "localhost"),
        "port":     int(DB["port"] or env.get("DB_PORT", 5432)),
        "dbname":   DB["dbname"]   or env.get("DB_NAME", "catalog"),
        "user":     DB["user"]     or env.get("DB_USER", "catalog_user"),
        "password": DB["password"] or env.get("DB_PASSWORD", ""),
    }


def chuan_hoa_ma(s):
    """Bỏ mọi ký tự không phải chữ/số rồi viết hoa.
    PHẢI khớp đúng công thức cột sinh ref_norm trong 02_schema.sql:
        NULLIF(upper(regexp_replace(coalesce(x,''),'[^a-zA-Z0-9]','','g')),'')
    Lệch công thức là ON CONFLICT mất tác dụng, rác lọt vào DB.
        '11192-72B10' → '1119272B10'
        '11192 72b10' → '1119272B10'
    """
    if s is None:
        return None
    v = re.sub(r"[^a-zA-Z0-9]", "", str(s)).upper()
    return v or None


def tach_nam(s):
    """'11.2015 - 07.2018' → (2015, 2018) ; '1996' → (1996, 1996) ; None → (None, None)"""
    if not s:
        return (None, None)
    nam = re.findall(r"\d{4}", str(s))
    if not nam:
        return (None, None)
    hop_le = lambda n: n if 1900 <= n <= 2100 else None
    tu = hop_le(int(nam[0]))
    den = hop_le(int(nam[-1])) if len(nam) > 1 else tu
    return (tu, den)


def rong(v):
    return v is None or str(v).strip() == ""


def cat(s, n):
    return None if s is None else str(s)[:n]


def so_dep(n):
    return f"{n:,}".replace(",", ".")


# ── SOI FILE ────────────────────────────────────────────────────────

def soi(duong_dan):
    with open(duong_dan, "r", encoding="utf-8-sig") as f:
        goc = json.load(f)
    ds = goc if isinstance(goc, list) else [goc]

    print("\n" + "=" * 64)
    print(f"SOI CẤU TRÚC: {os.path.basename(duong_dan)}")
    print("=" * 64)

    b0 = ds[0] if ds else {}
    ct = (b0.get("car_types") or [{}])[0]
    md = (ct.get("models") or [{}])[0]
    cg = (md.get("categories") or [{}])[0]
    tt = (cg.get("titles") or [{}])[0]
    pt = (tt.get("parts") or [{}])[0]

    for ten, obj in (("hãng", b0), ("car_types", ct), ("models  ← QUAN TRỌNG", md), ("parts", pt)):
        print(f"\n[{ten}]")
        for k, v in obj.items():
            if not isinstance(v, (dict, list)):
                print(f"    {k:<24} = {json.dumps(v, ensure_ascii=False)[:70]}")

    # Độ phủ các trường ở tầng model
    tong, dem = 0, {}
    for b in ds:
        for c in b.get("car_types") or []:
            for m in c.get("models") or []:
                tong += 1
                for k, v in m.items():
                    if isinstance(v, (dict, list)):
                        continue
                    dem[k] = dem.get(k, 0) + (0 if rong(v) else 1)

    print(f"\n[Độ phủ trường ở tầng model] — tổng {so_dep(tong)} model")
    for k, v in sorted(dem.items(), key=lambda x: -x[1]):
        pc = round(v * 100 / tong) if tong else 0
        print(f"    {k:<24} {pc:>3}%  ({so_dep(v)}/{so_dep(tong)})")

    print("\n" + "-" * 64)
    if "model_code" in md:
        print('  → Nhiều khả năng dùng cấu hình "suzuki"  (model_code)')
    elif "prod_period" in md:
        print('  → Nhiều khả năng dùng cấu hình "toyota"  (model + prod_period)')
    else:
        print('  → Không thấy mã model rõ ràng. Xem cấu hình "ford" (model_code = None)')
    if "model" in md:
        print(f'  ⚠  Trường "model" ở file này = {json.dumps(md.get("model"), ensure_ascii=False)}')
        print('     Nếu đó là LOẠI XE chứ không phải mã → phải để "model_code": None')
    print("")


# ── BÓC TÁCH ────────────────────────────────────────────────────────

def boc_tach(goc, cfg):
    ds = goc if isinstance(goc, list) else [goc]

    xe = {}        # "MAKE|MA" → dict
    phu_tung = {}  # ref_norm  → dict
    cap_noi = set()
    cb = {"model_thieu_ma": 0, "part_thieu_ma": 0, "part_thieu_ten": 0}
    ten_theo_ma = {}

    for b in ds:
        make = b.get(cfg["make"]) if cfg["make"] else None
        if rong(make):
            continue
        make = str(make).strip()

        for c in b.get("car_types") or []:
            car_type = c.get(cfg["car_type"]) if cfg["car_type"] else None

            for m in c.get("models") or []:
                ten_model = m.get(cfg["model_name"]) if cfg["model_name"] else None
                ma_model = m.get(cfg["model_code"]) if cfg["model_code"] else None

                dung_tam = False
                if rong(ma_model):
                    if rong(ten_model):
                        continue
                    ma_model = str(ten_model).strip().upper()
                    dung_tam = True
                    cb["model_thieu_ma"] += 1

                ma_model = str(ma_model).strip().upper()
                khoa_xe = f"{make}|{ma_model}"
                nam_tu, nam_den = tach_nam(m.get(cfg["year"]) if cfg["year"] else None)

                if khoa_xe not in xe:
                    xe[khoa_xe] = {
                        "make": cat(make, 100),
                        "model_code": cat(ma_model, 100),
                        "model_name": cat(None if rong(ten_model) else str(ten_model).strip(), 200),
                        "year_from": nam_tu,
                        "year_to": nam_den,
                        "description": cat(None if rong(car_type) else str(car_type).strip(), 255),
                    }
                if dung_tam and not rong(ten_model):
                    ten_theo_ma.setdefault(khoa_xe, set()).add(str(ten_model).strip())

                for cg in m.get("categories") or []:
                    danh_muc = cg.get("category")
                    for tt in cg.get("titles") or []:
                        tieu_de = tt.get("title")
                        for p in tt.get("parts") or []:
                            so = p.get(cfg["part_number"]) if cfg["part_number"] else None
                            ref = chuan_hoa_ma(so)
                            if not ref:
                                cb["part_thieu_ma"] += 1
                                continue

                            ten = p.get(cfg["part_name"]) if cfg["part_name"] else None
                            ten_vi = p.get(cfg["part_name_vi"]) if cfg["part_name_vi"] else None

                            # Tên ưu tiên name_vi, trống mới dùng name
                            hien_thi = (str(ten_vi).strip() if not rong(ten_vi)
                                        else str(ten).strip() if not rong(ten) else None)
                            if not hien_thi:
                                cb["part_thieu_ten"] += 1
                                continue

                            if ref not in phu_tung:
                                ma_goc = str(so).strip()
                                phu_tung[ref] = {
                                    "internal_ref": cat(ma_goc, 100),
                                    "oem_code": cat(ma_goc, 100),
                                    "name": cat(hien_thi if rong(ten) else str(ten).strip(), 500),
                                    "name_vi": None if rong(ten_vi) else str(ten_vi).strip(),
                                    "brand": cat(make, 100) if cfg["brand_tu_make"] else None,
                                    "notes": cat(" | ".join(x for x in (danh_muc, tieu_de) if x) or None, 1000),
                                }
                            else:
                                cu = phu_tung[ref]
                                if rong(cu["name_vi"]) and not rong(ten_vi):
                                    cu["name_vi"] = str(ten_vi).strip()

                            cap_noi.add((ref, khoa_xe))

    cb["ma_dung_chung"] = {k: v for k, v in ten_theo_ma.items() if len(v) > 1}
    return xe, phu_tung, cap_noi, cb


# ── NẠP ─────────────────────────────────────────────────────────────

def nap(duong_dan, ten_cau_hinh, chay_thu):
    if ten_cau_hinh not in CAU_HINH:
        print(f"✗ Không có cấu hình '{ten_cau_hinh}'. Đang có: {', '.join(CAU_HINH)}")
        sys.exit(1)
    cfg = CAU_HINH[ten_cau_hinh]

    print(f"\nĐọc {duong_dan} ...")
    with open(duong_dan, "r", encoding="utf-8-sig") as f:
        goc = json.load(f)

    print(f"Bóc tách bằng cấu hình '{ten_cau_hinh}' ...")
    xe, phu_tung, cap_noi, cb = boc_tach(goc, cfg)

    print("\n" + "=" * 64)
    print(f"KẾT QUẢ: {os.path.basename(duong_dan)}")
    print("=" * 64)
    print(f"  Xe        : {so_dep(len(xe))}")
    print(f"  Phụ tùng  : {so_dep(len(phu_tung))}   (đã gộp trùng theo mã)")
    print(f"  Fitment   : {so_dep(len(cap_noi))}")

    if cb["model_thieu_ma"] or cb["part_thieu_ma"] or cb["part_thieu_ten"]:
        print("\n  -- Cảnh báo --")
        if cb["model_thieu_ma"]:
            print(f"  {so_dep(cb['model_thieu_ma'])} model không có mã → lấy tên model làm mã")
        if cb["part_thieu_ma"]:
            print(f"  {so_dep(cb['part_thieu_ma'])} phụ tùng không có mã → BỎ QUA")
        if cb["part_thieu_ten"]:
            print(f"  {so_dep(cb['part_thieu_ten'])} phụ tùng không có tên → BỎ QUA")

    if cb["ma_dung_chung"]:
        print(f"\n  ⚠  {so_dep(len(cb['ma_dung_chung']))} mã model bị NHIỀU XE dùng chung → sẽ bị gộp:")
        for k, v in list(cb["ma_dung_chung"].items())[:3]:
            print(f"       {k}  ←  {' / '.join(list(v)[:3])}")

    print("\n  -- Mẫu 3 xe --")
    for v in list(xe.values())[:3]:
        print(f"  {v['make']} | {v['model_code']} | {v['model_name']} | "
              f"{v['year_from']}-{v['year_to']} | {v['description']}")
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
                    v["year_from"], v["year_to"], v["description"]) for v in xe.values()]
        id_xe = {}
        for i in range(0, len(hang_xe), 500):
            rows = execute_values(cur, """
                INSERT INTO catalog_vehicles
                    (make, model_code, model_name, year_from, year_to, description)
                VALUES %s
                ON CONFLICT (make, model_code) DO UPDATE SET
                    model_name = COALESCE(EXCLUDED.model_name, catalog_vehicles.model_name),
                    year_from  = COALESCE(EXCLUDED.year_from,  catalog_vehicles.year_from),
                    year_to    = COALESCE(EXCLUDED.year_to,    catalog_vehicles.year_to),
                    updated_at = now()
                RETURNING id, make, model_code
            """, hang_xe[i:i + 500], fetch=True)
            for r in rows:
                id_xe[f"{r[1]}|{r[2]}"] = r[0]
            print(f"\r    {so_dep(min(i + 500, len(hang_xe)))}/{so_dep(len(hang_xe))}", end="")
        if hang_xe:
            print()

        # 2) PHỤ TÙNG
        print("  [2/3] Phụ tùng")
        loai = cfg["product_type"] or "genuine"
        hang_pt = [(p["name"], p["name_vi"], p["internal_ref"], p["oem_code"],
                    p["brand"], loai, p["notes"],
                    " ".join(x for x in (p["name"], p["name_vi"], p["internal_ref"]) if x))
                   for p in phu_tung.values()]
        id_pt = {}
        for i in range(0, len(hang_pt), 500):
            rows = execute_values(cur, """
                INSERT INTO catalog_products
                    (name, name_vi, internal_ref, oem_code, brand, product_type, notes, search_text)
                VALUES %s
                ON CONFLICT (ref_norm) WHERE ref_norm IS NOT NULL DO UPDATE SET
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
        cap = []
        hong = 0
        for ref, khoa_xe in cap_noi:
            pid, vid = id_pt.get(ref), id_xe.get(khoa_xe)
            if pid and vid:
                cap.append((pid, vid))
            else:
                hong += 1
        da_chen = 0
        for i in range(0, len(cap), 1000):
            rows = execute_values(cur, """
                INSERT INTO catalog_fitments (product_id, vehicle_id)
                VALUES %s
                ON CONFLICT (product_id, vehicle_id) DO NOTHING
                RETURNING id
            """, cap[i:i + 1000], fetch=True)
            da_chen += len(rows)
            print(f"\r    {so_dep(min(i + 1000, len(cap)))}/{so_dep(len(cap))}", end="")
        if cap:
            print()

        conn.commit()
        print("\n" + "=" * 64)
        print("ĐÃ NẠP XONG")
        print("=" * 64)
        print(f"  Xe       : {so_dep(len(id_xe))}")
        print(f"  Phụ tùng : {so_dep(len(id_pt))}")
        print(f"  Fitment  : {so_dep(da_chen)} dòng mới  ({so_dep(len(cap) - da_chen)} đã có sẵn)")
        if hong:
            print(f"  ⚠ {so_dep(hong)} fitment bỏ qua vì không khớp được id")
        print("")
    except Exception as e:
        conn.rollback()
        print(f"\n✗ LỖI — đã huỷ toàn bộ, DB giữ nguyên như trước:\n  {e}")
        sys.exit(1)
    finally:
        conn.close()


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Nạp file JSON catalog vào DB")
    ap.add_argument("file", help="đường dẫn file .json")
    ap.add_argument("cau_hinh", nargs="?", default=MAC_DINH,
                    help=f"tên cấu hình ({', '.join(CAU_HINH)}); mặc định: {MAC_DINH}")
    ap.add_argument("--thu", action="store_true", help="chạy thử, không ghi DB")
    ap.add_argument("--soi", action="store_true", help="chỉ xem file có trường gì")
    a = ap.parse_args()

    if a.soi:
        soi(a.file)
    else:
        nap(a.file, a.cau_hinh, a.thu)
