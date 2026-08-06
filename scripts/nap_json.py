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
# ║   Hai khoá KHÔNG phải tên cột vì chúng ghi vào 2 cột cùng lúc:       ║
# ║     year_from_to  → year_from + year_to                              ║
# ║     ma_phu_tung   → internal_ref + oem_code                          ║
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
    #       file Lexus / Toyota  →  "model"
    #       file Suzuki          →  "model_code"
    #       file Ford            →  None   (file đó KHÔNG có mã; nó có
    #                                       trường "model" nhưng giá trị là
    #                                       "LIGHT TRUCK" = loại xe.
    #                                       Để nhầm là hỏng dữ liệu xe)
    #   Để None thì script lấy TÊN xe làm mã thay thế.
    #
    #   ĐIỀN DANH SÁCH khi một mã dùng cho nhiều bản xe khác nhau.
    #   Hay gặp ở Nissan: mã JJ10E dùng chung cho bản 2WD lẫn 4WD, bản ST
    #   lẫn TI — gộp lại thì khách hỏi xe 2WD sẽ thấy cả phụ tùng 4WD.
    #   Ghép thêm trường phân biệt để tách ra:
    #       "model_code": ["model", "grade", "gearbox"]
    #                                   →  "JJ10E-ST-M-CVT"
    #   Trường nào rỗng thì tự bỏ qua. Chạy --soi để xem file có trường gì.
    "model_code":   "model",

    # tầng 3 → cột  catalog_fitments.notes   (ghi trên từng dòng nối xe–phụ tùng)
    #   Dùng khi MỘT mã xe dùng chung cho nhiều bản (Nissan JJ10E có cả bản
    #   2WD lẫn 4WD, ST lẫn TI). Thay vì tách mã ra cho dài loằng ngoằng,
    #   giữ mã gộp "JJ10E" cho dễ tra, còn bản nào thì ghi vào đây:
    #       "ghi_chu_ban_xe": ["grade", "gearbox", "options"]
    #   → dòng fitment của cụm cầu sau mang chú thích
    #     "ST | M-CVT | ...WHEEL DRIVE:4WD..."  → nhân viên biết chỉ hợp bản 4WD.
    #   Phụ tùng dùng chung nhiều bản thì gộp hết chú thích lại.
    #   Để None nếu không cần.
    "ghi_chu_ban_xe": None,

    # tầng 3 → HAI cột  year_from  VÀ  year_to
    #   Đây là ánh xạ 1 → 2: một trường JSON, script bóc số năm ra rồi
    #   điền vào cả hai cột. DB không có cột nào tên "year".
    #   ★ TRƯỜNG HAY PHẢI SỬA:
    #       "prod_period" : "08.2009 - 06.2012"  → year_from=2009, year_to=2012
    #       "manufactured": "1996"               → year_from=1996, year_to=1996
    #       None                                 → cả hai để trống
    #   Để trống thì xe khớp MỌI năm — an toàn hơn điền sai (điền sai
    #   là xe bị loại oan, khách hỏi không ra hàng).
    "year_from_to": "prod_period",

    # ─────────────────────────────────────────────────────────────────
    #  BẢNG PHỤ TÙNG  →  catalog_products
    # ─────────────────────────────────────────────────────────────────

    # tầng 6 → HAI cột  internal_ref  VÀ  oem_code
    #   Cũng là ánh xạ 1 → 2: cùng một mã ghi vào cả hai cột.
    #     internal_ref = mã sản phẩm, KHÔNG được trùng (khoá chống trùng)
    #     oem_code     = mã hãng xe, được phép trùng (hàng tương đương)
    #   File cào chỉ có một mã nên hai cột bằng nhau — bình thường.
    #   Phụ tùng không có mã thì BỊ BỎ QUA, script đếm và báo lại.
    "ma_phu_tung":  "number",

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


# ══════════════════════════════════════════════════════════════════════
# Từ đây trở xuống KHÔNG CẦN SỬA GÌ.
#
# Thông tin kết nối DB script tự đọc từ file .env ở thư mục gốc project
# (DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD) — không khai báo ở đây.
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
    dd = os.path.join(GOC_PROJECT, ".env")
    if not env:
        print(f"✗ Không đọc được file .env tại:\n    {dd}")
        print("  Tạo file đó với DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASSWORD")
        sys.exit(1)
    thieu = [k for k in ("DB_NAME", "DB_USER", "DB_PASSWORD") if not env.get(k)]
    if thieu:
        print(f"✗ File .env thiếu: {', '.join(thieu)}\n    {dd}")
        sys.exit(1)
    return {
        "host":     env.get("DB_HOST", "localhost"),
        "port":     int(env.get("DB_PORT", 5432)),
        "dbname":   env["DB_NAME"],
        "user":     env["DB_USER"],
        "password": env["DB_PASSWORD"],
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


def lay_ma_xe(m, ten_xe):
    """Suy ra mã xe từ một model trong file. Trả về (mã, có_phải_lấy_từ_tên).

    CAU_HINH["model_code"] nhận 3 kiểu:
        "model"                        → lấy đúng trường đó
        ["model","grade","gearbox"]    → ghép các trường lại bằng dấu -
                                         (dùng khi 1 mã dùng cho nhiều bản xe)
        None                           → không có mã, lấy tên xe làm mã

    Dùng chung cho cả nap_json.py và xoa_xe.py để hai bên luôn tính ra
    cùng một mã — lệch nhau là xoá sót.
    """
    kh = CAU_HINH["model_code"]
    ma = None
    if isinstance(kh, (list, tuple)):
        phan = [str(m.get(k)).strip() for k in kh if not rong(m.get(k))]
        ma = "-".join(phan) if phan else None
    elif kh:
        ma = m.get(kh)

    if rong(ma):
        if rong(ten_xe):
            return (None, False)
        return (str(ten_xe).strip().upper(), True)
    return (str(ma).strip().upper(), False)


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
        ("make",         b0, "tầng 1"),
        ("description",  ct, "tầng 2"),
        ("model_name",   md, "tầng 3"),
        ("model_code",   md, "tầng 3"),
        ("year_from_to", md, "tầng 3"),
        ("ma_phu_tung",  pt, "tầng 6"),
        ("name_vi",      pt, "tầng 6"),
        ("name",         pt, "tầng 6"),
    ]
    loi = 0
    for cot, obj, tang in kiem:
        truong = CAU_HINH[cot]
        if isinstance(truong, (list, tuple)):
            # model_code ghép từ nhiều trường → kiểm từng trường một
            co = [k for k in obj if not isinstance(obj[k], (dict, list))]
            thieu = [k for k in truong if k not in obj]
            mau = "-".join(str(obj.get(k)).strip() for k in truong if not rong(obj.get(k)))
            if thieu:
                loi += 1
                print(f"  ✗  {cot:<12} ← ghép {'+'.join(truong)}")
                print(f"     {'':<12}   thiếu trường: {', '.join(thieu)}")
                print(f"     {'':<12}   trường có sẵn: {', '.join(co)}")
            else:
                print(f"  ✓  {cot:<12} ← ghép {'+'.join(truong):<14} {tang}  = "
                      f"{json.dumps(mau, ensure_ascii=False)[:38]}")
            continue
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

    if isinstance(CAU_HINH["model_code"], str) and CAU_HINH["model_code"] in md:
        print(f'\n  ⚠  KIỂM TRA BẰNG MẮT: model_code đang lấy từ trường '
              f'"{CAU_HINH["model_code"]}" = '
              f'{json.dumps(md.get(CAU_HINH["model_code"]), ensure_ascii=False)}')
        print('     Đó có đúng là MÃ XE không? Nếu là loại xe (kiểu "LIGHT TRUCK")')
        print('     thì phải đặt  "model_code": None')
    if not CAU_HINH["model_code"]:
        print('\n  ⚠  model_code = None → sẽ lấy TÊN xe làm mã.')
        print('     Các xe khác nhau nhưng trùng tên sẽ bị gộp làm một.')

    kiem_trung_model(ds)
    print("")


def kiem_trung_model(ds):
    """Xem file sắp nạp có mã xe nào trùng NHAU trong file, hoặc đã CÓ SẴN trong DB."""
    cfg = CAU_HINH
    dem = {}          # "MAKE|MA" → [nhãn từng dòng]
    for b in ds:
        make = b.get(cfg["make"]) if cfg["make"] else None
        if rong(make):
            continue
        make = str(make).strip()
        for c in b.get("car_types") or []:
            for m in c.get("models") or []:
                ten = m.get(cfg["model_name"]) if cfg["model_name"] else None
                ma, _ = lay_ma_xe(m, ten)
                if ma is None:
                    continue
                nhan = str(m.get(cfg["year_from_to"]) or "").strip() if cfg["year_from_to"] else ""
                dem.setdefault(f"{make}|{ma}", []).append(nhan or "(không có năm)")

    print("\n" + "-" * 68)
    print("KIỂM TRA TRÙNG MÃ XE")
    print("-" * 68)

    # 1) Trùng ngay trong file
    trung = {k: v for k, v in dem.items() if len(v) > 1}
    tong_dong = sum(len(v) for v in dem.values())
    if trung:
        thua = sum(len(v) - 1 for v in trung.values())
        print(f"  ⚠  TRONG FILE: {so_dep(len(trung))} mã lặp lại "
              f"→ {so_dep(tong_dong)} dòng chỉ ra {so_dep(len(dem))} xe "
              f"({so_dep(thua)} dòng dồn lại)")
        print("     Không mất phụ tùng — tất cả gắn vào cùng xe, khoảng năm nới rộng.")
        for k, v in list(trung.items())[:5]:
            print(f"       {k}  ×{len(v)}   {' | '.join(v[:3])}")
        if len(trung) > 5:
            print(f"       ... và {so_dep(len(trung) - 5)} mã nữa")
    else:
        print(f"  ✓ TRONG FILE: {so_dep(len(dem))} mã, không mã nào lặp lại")

    # 2) Đã có sẵn trong DB chưa
    try:
        import psycopg2
        tt = cau_hinh_db()
        conn = psycopg2.connect(**tt)
        cur = conn.cursor()
        cap = [tuple(k.split("|", 1)) for k in dem]
        cur.execute("""
            SELECT v.make, v.model_code, v.model_name, v.year_from, v.year_to
            FROM catalog_vehicles v
            JOIN (SELECT * FROM unnest(%s::text[], %s::text[]) AS t(mk, mc)) t
              ON t.mk = v.make AND t.mc = v.model_code
            ORDER BY v.model_code
        """, ([c[0] for c in cap], [c[1] for c in cap]))
        co_roi = cur.fetchall()
        conn.close()

        if co_roi:
            print(f"\n  ⚠  TRONG DB '{tt['dbname']}': {so_dep(len(co_roi))}/{so_dep(len(dem))} "
                  f"mã ĐÃ CÓ SẴN → nạp vào sẽ gộp vào dòng cũ, không tạo dòng mới")
            for r in co_roi[:5]:
                print(f"       {r[0]}|{r[1]}   đang là {r[3]}-{r[4]}   {r[2] or ''}")
            if len(co_roi) > 5:
                print(f"       ... và {so_dep(len(co_roi) - 5)} mã nữa")
        else:
            print(f"\n  ✓ TRONG DB '{tt['dbname']}': chưa có mã nào — nạp vào là {so_dep(len(dem))} xe mới")
    except SystemExit:
        raise
    except Exception as e:
        print(f"\n  ○ Không kiểm tra được DB ({type(e).__name__}: {str(e).strip()[:60]})")
        print("     Phần kiểm tra trùng trong file ở trên vẫn dùng được.")


# ── BÓC TÁCH ──────────────────────────────────────────────────────────

def boc_tach(goc):
    cfg = CAU_HINH
    ds = goc if isinstance(goc, list) else [goc]

    xe, phu_tung = {}, {}
    cap_noi = {}   # (ref, khoa_xe) → set các chú thích bản xe
    cb = {"model_thieu_ma": 0, "part_thieu_ma": 0, "part_thieu_ten": 0,
          "tong_model_trong_file": 0}
    gop = {}   # khoa_xe → danh sách các model gốc đã dồn vào đó

    for b in ds:
        make = b.get(cfg["make"]) if cfg["make"] else None
        if rong(make):
            continue
        make = str(make).strip()

        for c in b.get("car_types") or []:
            thi_truong = c.get(cfg["description"]) if cfg["description"] else None

            for m in c.get("models") or []:
                cb["tong_model_trong_file"] += 1
                ten_xe = m.get(cfg["model_name"]) if cfg["model_name"] else None

                ma_xe, dung_tam = lay_ma_xe(m, ten_xe)
                if ma_xe is None:
                    continue
                if dung_tam:
                    cb["model_thieu_ma"] += 1

                khoa_xe = f"{make}|{ma_xe}"

                # Chú thích bản xe — ghi lên dòng fitment
                ghi_chu = None
                kh_gc = cfg.get("ghi_chu_ban_xe")
                if kh_gc:
                    ghi_chu = " | ".join(str(m.get(k)).strip()
                                         for k in kh_gc if not rong(m.get(k))) or None
                nam_tu, nam_den = tach_nam(
                    m.get(cfg["year_from_to"]) if cfg["year_from_to"] else None)

                if khoa_xe not in xe:
                    xe[khoa_xe] = {
                        "make": cat(make, 100),
                        "model_code": cat(ma_xe, 100),
                        "model_name": cat(None if rong(ten_xe) else str(ten_xe).strip(), 200),
                        "year_from": nam_tu,
                        "year_to": nam_den,
                        "description": cat(None if rong(thi_truong) else str(thi_truong).strip(), 255),
                    }
                else:
                    # Đã gặp mã này rồi → NỚI RỘNG khoảng năm thay vì vứt bản sau.
                    # File hay có cùng một mã xe lặp lại theo từng đời:
                    #   KUN40L-GKMDYM  01.2005 - 02.2012
                    #   KUN40L-GKMDYM  02.2012 - 03.2016
                    # Gộp lại thành 2005 - 2016 mới đúng, giữ bản đầu là mất đời sau.
                    cu = xe[khoa_xe]
                    if nam_tu is not None:
                        cu["year_from"] = (nam_tu if cu["year_from"] is None
                                           else min(cu["year_from"], nam_tu))
                    if nam_den is not None:
                        cu["year_to"] = (nam_den if cu["year_to"] is None
                                         else max(cu["year_to"], nam_den))
                    if rong(cu["model_name"]) and not rong(ten_xe):
                        cu["model_name"] = cat(str(ten_xe).strip(), 200)

                # Ghi nhận MỌI lần gộp để báo lại — kể cả khi file có sẵn mã.
                # (trước đây chỉ báo khi model thiếu mã nên gộp diễn ra im lặng)
                gop.setdefault(khoa_xe, []).append({
                    "ten": None if rong(ten_xe) else str(ten_xe).strip(),
                    "nam": m.get(cfg["year_from_to"]) if cfg["year_from_to"] else None,
                    "tu_ten": dung_tam,
                })

                for cg in m.get("categories") or []:
                    danh_muc = cg.get("category")
                    for tt in cg.get("titles") or []:
                        tieu_de = tt.get("title")
                        for p in tt.get("parts") or []:
                            so = p.get(cfg["ma_phu_tung"]) if cfg["ma_phu_tung"] else None
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
                                # Không có tên nào cả — hay gặp với bu lông, ốc vít
                                # tiêu chuẩn (PartSouq không kèm mô tả).
                                # VẪN NẠP, lấy mã làm tên: tra theo mã vẫn cần chúng,
                                # bỏ đi là mất tới ~20% catalog.
                                cb["part_thieu_ten"] += 1
                                hien_thi = str(so).strip()
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

                            kh = (ref, khoa_xe)
                            if kh not in cap_noi:
                                cap_noi[kh] = set()
                            if ghi_chu:
                                cap_noi[kh].add(ghi_chu)

    cb["gop"] = {k: v for k, v in gop.items() if len(v) > 1}
    return xe, phu_tung, cap_noi, cb


# ── NẠP ───────────────────────────────────────────────────────────────

def nap(duong_dan, chay_thu):
    print(f"\nĐọc {duong_dan} ...")
    with open(duong_dan, "r", encoding="utf-8-sig") as f:
        goc = json.load(f)

    print("Bóc tách ...")
    xe, phu_tung, cap_noi, cb = boc_tach(goc)

    tong_file = cb["tong_model_trong_file"]
    print("\n" + "=" * 68)
    print(f"KẾT QUẢ: {os.path.basename(duong_dan)}")
    print("=" * 68)
    print(f"  Model trong file : {so_dep(tong_file)}")
    print(f"  Xe vào DB        : {so_dep(len(xe))}"
          + (f"   ({so_dep(tong_file - len(xe))} dòng gộp vào dòng khác)"
             if tong_file > len(xe) else ""))
    print(f"  Phụ tùng         : {so_dep(len(phu_tung))}   (đã gộp trùng theo mã)")
    print(f"  Fitment          : {so_dep(len(cap_noi))}")

    if cb["model_thieu_ma"] or cb["part_thieu_ma"] or cb["part_thieu_ten"]:
        print("\n  -- Cảnh báo --")
        if cb["model_thieu_ma"]:
            print(f"  {so_dep(cb['model_thieu_ma'])} xe không có mã → lấy tên xe làm mã")
        if cb["part_thieu_ma"]:
            print(f"  {so_dep(cb['part_thieu_ma'])} phụ tùng không có mã → BỎ QUA")
        if cb["part_thieu_ten"]:
            print(f"  {so_dep(cb['part_thieu_ten'])} phụ tùng không có tên → VẪN NẠP, "
                  f"lấy mã làm tên (thường là bu lông, ốc vít)")

    if cb["gop"]:
        thua = sum(len(v) - 1 for v in cb["gop"].values())
        tu_ten = any(x["tu_ten"] for v in cb["gop"].values() for x in v)
        print(f"\n  -- {so_dep(len(cb['gop']))} mã xe xuất hiện nhiều lần trong file "
              f"→ {so_dep(thua)} dòng dồn lại --")
        print("     Phụ tùng của TẤT CẢ các dòng đó đều được giữ, gắn vào cùng một xe.")
        print("     Khoảng năm được NỚI RỘNG để phủ hết các đời.")
        if tu_ten:
            print("     ⚠ Có dòng gộp do xe KHÔNG CÓ MÃ (lấy tên làm mã) — dễ gộp nhầm,")
            print("       kiểm tra lại cấu hình model_code.")
        print("")
        for k, v in list(cb["gop"].items())[:5]:
            x = xe[k]
            print(f"       {k}   {len(v)} dòng → năm {x['year_from']}-{x['year_to']}")
            for it in v[:3]:
                print(f"           {it['nam'] or '(không có năm)'}")
        if len(cb["gop"]) > 5:
            print(f"       ... và {so_dep(len(cb['gop']) - 5)} mã nữa")

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
                    -- Nới rộng khoảng năm thay vì đè. LEAST/GREATEST của Postgres
                    -- tự bỏ qua NULL nên xe chưa có năm cũng an toàn.
                    -- Nhờ vậy nạp lại file, hay nạp thêm file khác cùng mã xe,
                    -- khoảng năm chỉ rộng ra chứ không mất.
                    year_from  = LEAST(catalog_vehicles.year_from,  EXCLUDED.year_from),
                    year_to    = GREATEST(catalog_vehicles.year_to, EXCLUDED.year_to),
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
        for (ref, khoa_xe), ghi_chus in cap_noi.items():
            pid, vid = id_pt.get(ref), id_xe.get(khoa_xe)
            if pid and vid:
                # Phụ tùng dùng chung nhiều bản xe → gộp hết chú thích lại
                gc = " / ".join(sorted(ghi_chus))[:1000] if ghi_chus else None
                cap.append((pid, vid, gc))
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
