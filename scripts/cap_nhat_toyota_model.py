#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
cap_nhat_toyota_model.py — CHỈ UPDATE xe Toyota đã có sẵn trong DB (nạp từ
nap_json2.py, lúc đó chỉ có model_code), bổ sung description/model_name/
year_from/year_to/transmission từ file Toyota_Model.json (cấu trúc PartSouq
chuẩn, KHÁC cấu trúc "toyodiy"). KHÔNG tạo xe mới — model_code nào trong
file mà DB chưa có thì bỏ qua, chỉ báo lại số lượng.

Cấu trúc Toyota_Model.json (6 tầng như PartSouq thường, nhưng KHÔNG có
categories/parts — chỉ metadata xe):
    [ { brand, car_types: [ { car_type,       ← tên dòng xe (nameplate),
                                                 VD "4RUNNER", "AQUA"
          models: [ { name,                   ← tên xe hiển thị
                       description,           ← nhóm mã xe liên quan
                                                 (VD "GRN21#,KZN215") — KHÔNG
                                                 phải engine, KHÔNG dùng
                       model,                 ← MÃ XE — khớp với model_code
                       options,               ← chuỗi thông số hỗn hợp
                                                 (tay lái/hộp số/số ghế/
                                                 grade/engine lẫn lộn, có
                                                 khi bị cắt cụt) — lưu tạm
                                                 nguyên văn vào transmission
                       prod_period            ← "MM.YYYY - MM.YYYY" hoặc
                                                 "MM.YYYY - ..." (còn SX,
                                                 year_to để trống)
                     } ] } ] } ]

Field-name JSON  →  cột DB (chỉ bù khi cột đang NULL — COALESCE, KHÔNG
ghi đè dữ liệu đã có sẵn):
    car_type      → description
    name          → model_name
    options       → transmission (cắt 50 ký tự, xem docstring trên)
    prod_period   → year_from + year_to

Mã xe (model_code) trùng nhiều lần trong file (dùng chung cho nhiều
car_type/nameplate) → lấy bản ghi ĐẦU TIÊN gặp, bỏ qua các lần lặp sau.

Dùng:
    python scripts/cap_nhat_toyota_model.py <file.json> --soi   # xem đối chiếu
    python scripts/cap_nhat_toyota_model.py <file.json> --thu   # chạy thử
    python scripts/cap_nhat_toyota_model.py <file.json>          # update thật
"""

import sys, os, json, re, argparse

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

MAKE = "Toyota"
GOC_PROJECT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

PROD_PERIOD_RE = re.compile(r"^\s*(\d{1,2})\.(\d{4})\s*-\s*(.*)$")
END_DATE_RE = re.compile(r"^(\d{1,2})\.(\d{4})$")


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


def rong(v):
    return v is None or str(v).strip() == ""


def cat(v, n):
    if v is None:
        return None
    v = str(v).strip()
    return v[:n] if v else None


def so_dep(n):
    return f"{n:,}".replace(",", ".")


def tach_prod_period(s):
    """'04.1969 - 02.1978' → (1969, 1978)
       '09.2022 - ...'      → (2022, None)   — còn sản xuất, chưa rõ năm hết
       không khớp / rỗng    → (None, None)"""
    if rong(s):
        return None, None
    m = PROD_PERIOD_RE.match(str(s).strip())
    if not m:
        return None, None
    nam_tu = int(m.group(2))
    phan_sau = m.group(3).strip()
    m2 = END_DATE_RE.match(phan_sau)
    nam_den = int(m2.group(2)) if m2 else None
    return nam_tu, nam_den


def doc_json_an_toan(path):
    for enc in ("utf-8", "utf-8-sig", "utf-16", "latin-1"):
        try:
            with open(path, encoding=enc) as f:
                return json.load(f)
        except Exception:
            continue
    return None


def boc_tach(duong_dan):
    """Trả về dict model_code(chuẩn hoá strip) → thông tin bổ sung.
    Trùng model_code → giữ bản ĐẦU TIÊN."""
    data = doc_json_an_toan(duong_dan)
    if data is None:
        print(f"✗ Không đọc được JSON: {duong_dan}")
        sys.exit(1)

    ds = data if isinstance(data, list) else [data]
    ket_qua = {}
    trung = 0
    tong_model = 0

    for brand in ds:
        for ct in brand.get("car_types") or []:
            car_type = ct.get("car_type")
            for m in ct.get("models") or []:
                tong_model += 1
                ma = m.get("model")
                if rong(ma):
                    continue
                ma = str(ma).strip()
                if ma in ket_qua:
                    trung += 1
                    continue

                nam_tu, nam_den = tach_prod_period(m.get("prod_period"))
                ket_qua[ma] = {
                    "model_code": ma,
                    "description": cat(car_type, 255),
                    "model_name": cat(m.get("name"), 200),
                    "year_from": nam_tu,
                    "year_to": nam_den,
                    "transmission": cat(m.get("options"), 50),
                }

    return ket_qua, tong_model, trung


def soi(duong_dan):
    ket_qua, tong_model, trung = boc_tach(duong_dan)
    print(f"📂 File: {duong_dan}")
    print(f"  Tổng model trong file : {so_dep(tong_model)}")
    print(f"  Mã xe khác nhau       : {so_dep(len(ket_qua))}")
    print(f"  Mã trùng (bỏ qua)     : {so_dep(trung)}")

    print("\n  -- Mẫu 5 bản ghi --")
    for v in list(ket_qua.values())[:5]:
        print(f"  {v['model_code']:20s} | desc={v['description']!r} | "
              f"name={v['model_name']!r} | {v['year_from']}-{v['year_to']} | "
              f"transmission={v['transmission']!r}")

    print("\nĐối chiếu với DB (Toyota) ...")
    try:
        import psycopg2
        tt = cau_hinh_db()
        conn = psycopg2.connect(**tt)
        cur = conn.cursor()
        cur.execute("SELECT model_code FROM catalog_vehicles WHERE make=%s", (MAKE,))
        db_codes = set(r[0] for r in cur.fetchall())
        conn.close()

        file_codes = set(ket_qua.keys())
        khop = db_codes & file_codes
        print(f"  Xe Toyota trong DB          : {so_dep(len(db_codes))}")
        print(f"  Khớp được với file (sẽ update): {so_dep(len(khop))}")
        print(f"  Trong DB nhưng KHÔNG có trong file (giữ nguyên): "
              f"{so_dep(len(db_codes - file_codes))}")
        print(f"  Trong file nhưng KHÔNG có trong DB (bỏ qua, không tạo mới): "
              f"{so_dep(len(file_codes - db_codes))}")
    except SystemExit:
        raise
    except Exception as e:
        print(f"  ○ Không kết nối được DB để đối chiếu ({type(e).__name__}: {e})")


def cap_nhat(duong_dan, chay_thu):
    ket_qua, tong_model, trung = boc_tach(duong_dan)
    print(f"Đọc {duong_dan}: {so_dep(tong_model)} model, "
          f"{so_dep(len(ket_qua))} mã khác nhau ({so_dep(trung)} trùng bỏ qua)")

    if chay_thu:
        print("\n>> CHẠY THỬ — không ghi gì vào DB. Bỏ --thu để update thật.\n")
        return

    import psycopg2
    from psycopg2.extras import execute_values

    tt = cau_hinh_db()
    print(f"\nUpdate vào DB '{tt['dbname']}' trên {tt['host']}:{tt['port']} ...")
    conn = psycopg2.connect(**tt)
    try:
        cur = conn.cursor()
        rows = [(v["model_code"], v["description"], v["model_name"],
                  v["year_from"], v["year_to"], v["transmission"])
                for v in ket_qua.values()]

        da_khop = 0
        for i in range(0, len(rows), 1000):
            batch = rows[i:i + 1000]
            cur.execute("""
                UPDATE catalog_vehicles v SET
                    description  = COALESCE(v.description,  t.description),
                    model_name   = COALESCE(v.model_name,   t.model_name),
                    year_from    = COALESCE(v.year_from,    t.year_from),
                    year_to      = COALESCE(v.year_to,      t.year_to),
                    transmission = COALESCE(v.transmission, t.transmission),
                    updated_at   = now()
                FROM (SELECT * FROM unnest(
                        %s::text[], %s::text[], %s::text[],
                        %s::int[], %s::int[], %s::text[])
                      AS t(model_code, description, model_name,
                           year_from, year_to, transmission)) t
                WHERE v.make = %s AND v.model_code = t.model_code
            """, (
                [r[0] for r in batch], [r[1] for r in batch], [r[2] for r in batch],
                [r[3] for r in batch], [r[4] for r in batch], [r[5] for r in batch],
                MAKE,
            ))
            da_khop += cur.rowcount
            print(f"\r  {so_dep(min(i + 1000, len(rows)))}/{so_dep(len(rows))}", end="")
        if rows:
            print()

        conn.commit()
        print("\n" + "=" * 60)
        print("ĐÃ UPDATE XONG")
        print("=" * 60)
        print(f"  Số dòng khớp & update: {so_dep(da_khop)}")
        print(f"  Mã trong file nhưng KHÔNG có trong DB (bỏ qua): "
              f"{so_dep(len(rows) - da_khop)}")
    except Exception as e:
        conn.rollback()
        print(f"\n✗ LỖI — đã huỷ toàn bộ, DB giữ nguyên như trước:\n  {e}")
        sys.exit(1)
    finally:
        conn.close()


if __name__ == "__main__":
    ap = argparse.ArgumentParser(
        description="Update bổ sung description/model_name/year/transmission cho xe Toyota đã có (không tạo mới)")
    ap.add_argument("file", help="đường dẫn Toyota_Model.json")
    ap.add_argument("--soi", action="store_true", help="xem đối chiếu, không ghi DB")
    ap.add_argument("--thu", action="store_true", help="chạy thử, không ghi DB")
    a = ap.parse_args()

    if a.soi:
        soi(a.file)
    else:
        cap_nhat(a.file, a.thu)
