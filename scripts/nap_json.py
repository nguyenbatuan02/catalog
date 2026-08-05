#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
nap_json.py — Nạp 1 file JSON catalog PartSouq vào DB. Mỗi lần chạy 1 file.

    python scripts/nap_json.py duong-dan.json --soi     # xem file có trường gì
    python scripts/nap_json.py duong-dan.json --thu     # chạy thử, KHÔNG ghi DB
    python scripts/nap_json.py duong-dan.json           # nạp thật

Cấu trúc file JSON luôn cố định 6 tầng:
    [ { brand,                          ← tầng 1: hãng xe
        car_types:[ { car_type,         ← tầng 2: thị trường
          models:[ { ...MODEL...,       ← tầng 3: xe    (mỗi file một kiểu tên trường)
            categories:[ { category,    ← tầng 4
              titles:[ { title,         ← tầng 5
                parts:[ { ... } ] }]}]}]}]}]   ← tầng 6: phụ tùng

Trước khi chạy mỗi file: chạy --soi rồi sửa CAU_HINH bên dưới cho khớp.
"""

import sys, os, json, re, argparse

# ╔══════════════════════════════════════════════════════════════════════╗
# ║                                                                      ║
# ║   CẤU HÌNH — SỬA Ở ĐÂY TRƯỚC KHI CHẠY MỖI FILE                       ║
# ║                                                                      ║
# ║   Bên TRÁI  = cột trong DB (đừng đổi)                                ║
# ║   Bên PHẢI  = tên trường trong file JSON  ← SỬA CÁI NÀY              ║
# ║   File không có trường đó thì để  None                               ║
# ║                                                                      ║
# ╚══════════════════════════════════════════════════════════════════════╝

CAU_HINH = {

    # ─────────────────────────────────────────────────────────────────
    #  BẢNG XE  →  catalog_vehicles
    # ─────────────────────────────────────────────────────────────────

    # tầng 1 → cột  make          hãng xe.        VD "Lexus"
    "make":         "brand",

    # tầng 2 → cột  description   thị trường.     VD "ES350"
    "description":  "car_type",

    # tầng 3 → cột  model_name    tên xe.         VD "LEXUS ES240/350"
    "model_name":   "name",

    # tầng 3 → cột  model_code    MÃ XE.          VD "ACV40L-BEAGKC"
    #   ★ TRƯỜNG HAY PHẢI SỬA NHẤT — mỗi file đặt tên một kiểu:
    #       file Suzuki  →  "model_code"
    #       file Lexus   →  "model"
    #       file Toyota  →  "model"
    #       file Ford    →  None   (file đó KHÔNG có mã;
    #                               nó có trường "model" nhưng giá trị là
    #                               "LIGHT TRUCK" = loại xe, KHÔNG phải mã.
    #                               Để nhầm là hỏng toàn bộ dữ liệu xe)
    #   Để None thì script lấy TÊN xe làm mã thay thế.
    "model_code":   "model",

    # tầng 3 → cột  year_from + year_to   năm sản xuất
    #   ★ TRƯỜNG HAY PHẢI SỬA — script tự bóc số năm ra khỏi chuỗi:
    #       "prod_period" : "08.2009 - 06.2012"  → 2009 và 2012
    #       "manufactured": "1996"               → 1996 và 1996
    #       None                                 → để trống (khớp mọi năm)
    "year":         "prod_period",

    # ─────────────────────────────────────────────────────────────────
    #  BẢNG PHỤ TÙNG  →  catalog_products
    # ─────────────────────────────────────────────────────────────────

    # tầng 6 → cột  internal_ref  VÀ  oem_code   (ghi vào cả hai)
    #   Không có mã thì phụ tùng đó BỊ BỎ QUA, script sẽ đếm và báo lại.
    "oem_code":     "number",

    # tầng 6 → cột  name_vi   tên tiếng Việt
    #   Đây là tên ĐƯỢC ƯU TIÊN làm tên chính của sản phẩm.
    "name_vi":      "name_vi",

    # tầng 6 → cột  name      tên gốc (thường tiếng Anh)
    #   CHỈ dùng làm tên chính khi name_vi rỗng.
    "name":         "name",

    # ─────────────────────────────────────────────────────────────────
    #  GIÁ TRỊ CỐ ĐỊNH (không lấy từ file)
    # ─────────────────────────────────────────────────────────────────

    # → cột  product_type
    "product_type": "genuine",

    # → cột  brand  (thương hiệu phụ tùng)
    #   True  = lấy tên hãng xe ở tầng 1 (hàng chính hãng → Lexus, Suzuki...)
    #   False = để trống
    "brand_la_hang_xe": True,

    # → cột  is_for_sale
    #   ĐỂ True. Đặt False là hàng biến mất khỏi chức năng tra theo xe.
    "is_for_sale":  True,
}


# ╔══════════════════════════════════════════════════════════════════════╗
# ║   KẾT NỐI DB — tự đọc .env ở thư mục gốc project.                    ║
# ║   Muốn ghi đè thì điền thẳng vào đây.                                ║
# ╚══════════════════════════════════════════════════════════════════════╝
DB = {
    "host":     None,   # None = lấy DB_HOST trong .env
    "port":     None,
    "dbname":   None,
    "user":     None,
    "password": None,
}


# ══════════════════════════════════════════════════════════════════════
# Từ đây trở xuống không cần sửa
# ══════════════════════════════════════════════════════════════════════

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

GOC_PROJECT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def doc_env():
    """Đọc .env đơn giản, không cần thư viện ngoài."""
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
    return {
        "host":     DB["host"]     or env.get("DB_HOST", "localhost"),
        "port":     int(DB["port"] or env.get("DB_PORT", 5432)),
        "dbname":   DB["dbname"]   or env.get("DB_NAME", "catalog"),
        "user":     DB["user"]     or env.get("DB_USER", "catalog_user"),
        "password": DB["password"] or env.get("DB_PASSWORD", ""),
    }


def chuan_hoa_ma(s):
    """Bỏ mọi ký tự không phải chữ/số rồi viết hoa.
    PHẢI khớp đúng công thức cột sinh ref_norm trong deploy/sql/02_schema.sql:
        NULLIF(upper(regexp_replace(coalesce(x,''),'[^a-zA-Z0-9]','','g')),'')
    Lệch công thức là ON CONFLICT mất tác dụng, rác lọt vào DB.
        '11192-72B10'  → '1119272B10'
        '11192 72b10'  → '1119272B10'
    """
    if s is None:
        return None
    v = re.sub(r"[^a-zA-Z0-9]", "", str(s)).upper()
    return v or None


def tach_nam(s):
    """'08.2009 - 06.2012' → (2009, 2012) ; '1996' → (1996, 1996) ; None → (None, None)"""
    if not s:
        return (None, None)
    nam = re.findall(r"\d{4}", str(s))
    if not nam:
        return (None, None)
    ok = lambda n: n if 1900 <= n <= 2100 else None
    tu = ok(int(nam[0]))
    den = ok(int(nam[-1])) if len(nam) > 1 else tu
    return (tu, den)


def rong(v):
    return v is None or str(v).strip() == ""


def cat(s, n):
    return None if s is None else str(s)[:n]


def so_dep(n):
    return f"{n:,}".replace(",", ".")


# ── SOI FILE ──────────────────────────────────────────────────────────

def soi(duong_dan):
    with open(duong_dan, "r", encoding="utf-8-sig") as f:
        goc = json.load(f)
    ds = goc if isinstance(goc, list) else [goc]

    print("\n" + "=" * 68)
    print(f"SOI CẤU TRÚC: {os.path.basename(duong_dan)}")
    print("=" * 68)

    b0 = ds[0] if ds else {}
    ct = (b0.get("car_types") or [{}])[0]
    md = (ct.get("models") or [{}])[0]
    cg = (md.get("categories") or [{}])[0]
    tt = (cg.get("titles") or [{}])[0]
    pt = (tt.get("parts") or [{}])[0]

    for nhan, obj in (("tầng 1 — hãng", b0), ("tầng 2 — car_types", ct),
                      ("tầng 3 — models  ← TẦNG HAY PHẢI SỬA", md),
                      ("tầng 6 — parts", pt)):
        print(f"\n[{nhan}]")
        for k, v in obj.items():
            if not isinstance(v, (dict, list)):
                print(f"    {k:<24} = {json.dumps(v, ensure_ascii=False)[:64]}")

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
        canh = "  ← thiếu ở nhiều model" if pc < 100 else ""
        print(f"    {k:<24} {pc:>3}%  ({so_dep(v)}/{so_dep(tong)}){canh}")

    # ── Đối chiếu CAU_HINH đang đặt với file này ──
    print("\n" + "-" * 68)
    print("CẤU HÌNH ĐANG ĐẶT CÓ KHỚP FILE NÀY KHÔNG?")
    print("-" * 68)

    kiem = [
        ("make",        b0, "tầng 1"),
        ("description", ct, "tầng 2"),
        ("model_name",  md, "tầng 3"),
        ("model_code",  md, "tầng 3"),
        ("year",        md, "tầng 3"),
        ("oem_code",    pt, "tầng 6"),
        ("name_vi",     pt, "tầng 6"),
        ("name",        pt, "tầng 6"),
    ]
    loi = 0
    for cot, obj, tang in kiem:
        truong = CAU_HINH[cot]
        if truong is None:
            print(f"  ○  {cot:<12} = None            (bỏ qua)")
        elif truong in obj:
            gt = json.dumps(obj.get(truong), ensure_ascii=False)[:38]
            print(f"  ✓  {cot:<12} ← {truong:<14} {tang}  = {gt}")
        else:
            loi += 1
            co = [k for k in obj if not isinstance(obj[k], (dict, list))]
            print(f"  ✗  {cot:<12} ← {truong:<14} {tang}  KHÔNG CÓ TRƯỜNG NÀY")
            print(f"     {'':<12}   trường có sẵn: {', '.join(co)}")

    if loi:
        print(f"\n  ⚠  {loi} chỗ chưa khớp → sửa CAU_HINH ở đầu file rồi chạy lại --soi")
    else:
        tep = os.path.basename(duong_dan)
        print("\n  ✓ Cấu hình khớp hết. Chạy tiếp:")
        print(f'      python scripts/nap_json.py "{tep}" --thu')

    if CAU_HINH["model_code"] and CAU_HINH["model_code"] in md:
        print(f'\n  ⚠  KIỂM TRA BẰNG MẮT: model_code đang lấy từ trường '
              f'"{CAU_HINH["model_code"]}" = '
              f'{json.dumps(md.get(CAU_HINH["model_code"]), ensure_ascii=False)}')
        print('     Đó có đúng là MÃ XE không? Nếu là loại xe (kiểu "LIGHT TRUCK")')
        print('     thì phải đặt  "model_code": None')
    if not CAU_HINH["model_code"]:
        print('\n  ⚠  model_code = None → sẽ lấy TÊN xe làm mã.')
        print('     Các xe khác nhau nhưng trùng tên sẽ bị gộp làm một.')
    print("")


# ── BÓC TÁCH ──────────────────────────────────────────────────────────

def boc_tach(goc):
    cfg = CAU_HINH
    ds = goc if isinstance(goc, list) else [goc]

    xe, phu_tung, cap_noi = {}, {}, set()
    cb = {"model_thieu_ma": 0, "part_thieu_ma": 0, "part_thieu_ten": 0}
    ten_theo_ma = {}

    for b in ds:
        make = b.get(cfg["make"]) if cfg["make"] else None
        if rong(make):
            continue
        make = str(make).strip()

        for c in b.get("car_types") or []:
            thi_truong = c.get(cfg["description"]) if cfg["description"] else None

            for m in c.get("models") or []:
                ten_xe = m.get(cfg["model_name"]) if cfg["model_name"] else None
                ma_xe = m.get(cfg["model_code"]) if cfg["model_code"] else None

                dung_tam = False
                if rong(ma_xe):
                    if rong(ten_xe):
                        continue
                    ma_xe = str(ten_xe).strip().upper()
                    dung_tam = True
                    cb["model_thieu_ma"] += 1

                ma_xe = str(ma_xe).strip().upper()
                khoa_xe = f"{make}|{ma_xe}"
                nam_tu, nam_den = tach_nam(m.get(cfg["year"]) if cfg["year"] else None)

                if khoa_xe not in xe:
                    xe[khoa_xe] = {
                        "make": cat(make, 100),
                        "model_code": cat(ma_xe, 100),
                        "model_name": cat(None if rong(ten_xe) else str(ten_xe).strip(), 200),
                        "year_from": nam_tu,
                        "year_to": nam_den,
                        "description": cat(None if rong(thi_truong) else str(thi_truong).strip(), 255),
                    }
                if dung_tam and not rong(ten_xe):
                    ten_theo_ma.setdefault(khoa_xe, set()).add(str(ten_xe).strip())

                for cg in m.get("categories") or []:
                    danh_muc = cg.get("category")
                    for tt in cg.get("titles") or []:
                        tieu_de = tt.get("title")
                        for p in tt.get("parts") or []:
                            so = p.get(cfg["oem_code"]) if cfg["oem_code"] else None
                            ref = chuan_hoa_ma(so)
                            if not ref:                      # không có mã → bỏ qua
                                cb["part_thieu_ma"] += 1
                                continue

                            ten = p.get(cfg["name"]) if cfg["name"] else None
                            ten_vi = p.get(cfg["name_vi"]) if cfg["name_vi"] else None

                            # TÊN CHÍNH: ưu tiên name_vi, rỗng mới dùng name.
                            # Cột `name` là cột app dùng để TÌM KIẾM, nên để tiếng
                            # Việt ở đây thì khách gõ tiếng Việt mới ra kết quả.
                            hien_thi = (str(ten_vi).strip() if not rong(ten_vi)
                                        else str(ten).strip() if not rong(ten) else None)
                            if not hien_thi:
                                cb["part_thieu_ten"] += 1
                                continue
                            ten_goc = None if rong(ten) else str(ten).strip()

                            if ref not in phu_tung:
                                ma_goc = str(so).strip()
                                phu_tung[ref] = {
                                    "internal_ref": cat(ma_goc, 100),
                                    "oem_code": cat(ma_goc, 100),
                                    "name": cat(hien_thi, 500),
                                    "name_vi": None if rong(ten_vi) else str(ten_vi).strip(),
                                    "ten_goc": ten_goc,
                                    "brand": cat(make, 100) if cfg["brand_la_hang_xe"] else None,
                                    "notes": cat(" | ".join(x for x in (danh_muc, tieu_de) if x) or None, 1000),
                                }
                            else:
                                cu = phu_tung[ref]
                                if rong(cu["name_vi"]) and not rong(ten_vi):
                                    cu["name_vi"] = str(ten_vi).strip()
                                    cu["name"] = cat(str(ten_vi).strip(), 500)
                                if rong(cu["ten_goc"]) and ten_goc:
                                    cu["ten_goc"] = ten_goc

                            cap_noi.add((ref, khoa_xe))

    cb["ma_dung_chung"] = {k: v for k, v in ten_theo_ma.items() if len(v) > 1}
    return xe, phu_tung, cap_noi, cb


# ── NẠP ───────────────────────────────────────────────────────────────

def nap(duong_dan, chay_thu):
    print(f"\nĐọc {duong_dan} ...")
    with open(duong_dan, "r", encoding="utf-8-sig") as f:
        goc = json.load(f)

    print("Bóc tách ...")
    xe, phu_tung, cap_noi, cb = boc_tach(goc)

    print("\n" + "=" * 68)
    print(f"KẾT QUẢ: {os.path.basename(duong_dan)}")
    print("=" * 68)
    print(f"  Xe        : {so_dep(len(xe))}")
    print(f"  Phụ tùng  : {so_dep(len(phu_tung))}   (đã gộp trùng theo mã)")
    print(f"  Fitment   : {so_dep(len(cap_noi))}")

    if cb["model_thieu_ma"] or cb["part_thieu_ma"] or cb["part_thieu_ten"]:
        print("\n  -- Cảnh báo --")
        if cb["model_thieu_ma"]:
            print(f"  {so_dep(cb['model_thieu_ma'])} xe không có mã → lấy tên xe làm mã")
        if cb["part_thieu_ma"]:
            print(f"  {so_dep(cb['part_thieu_ma'])} phụ tùng không có mã → BỎ QUA")
        if cb["part_thieu_ten"]:
            print(f"  {so_dep(cb['part_thieu_ten'])} phụ tùng không có tên → BỎ QUA")

    if cb["ma_dung_chung"]:
        print(f"\n  ⚠  {so_dep(len(cb['ma_dung_chung']))} mã xe bị NHIỀU XE dùng chung → sẽ gộp:")
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
        ban = bool(CAU_HINH["is_for_sale"])
        # search_text gộp cả tên Việt lẫn tên gốc + mã → tìm thứ tiếng nào cũng ra
        hang_pt = [(p["name"], p["name_vi"], p["internal_ref"], p["oem_code"],
                    p["brand"], CAU_HINH["product_type"], ban, p["notes"],
                    " ".join(dict.fromkeys(
                        x for x in (p["name"], p["name_vi"], p["ten_goc"], p["internal_ref"]) if x)))
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
        print("\n" + "=" * 68)
        print("ĐÃ NẠP XONG")
        print("=" * 68)
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
    ap = argparse.ArgumentParser(description="Nạp 1 file JSON catalog vào DB")
    ap.add_argument("file", help="đường dẫn file .json")
    ap.add_argument("--soi", action="store_true", help="xem file có trường gì + đối chiếu cấu hình")
    ap.add_argument("--thu", action="store_true", help="chạy thử, không ghi DB")
    a = ap.parse_args()

    if a.soi:
        soi(a.file)
    else:
        nap(a.file, a.thu)
