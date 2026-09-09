#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
phuc_hoi_ten_goc_nhieu.py — như phuc_hoi_ten_goc.py nhưng nhận NHIỀU file JSON

    python scripts/phuc_hoi_ten_goc_nhieu.py "duong/dan/*.json" --hang Mazda

Gom tên gốc của tất cả file vào một bảng tạm rồi UPDATE một lần. Hãng có hàng
trăm file (Mazda 171 file) mà chạy từng file thì mỗi file lại mở kết nối và
quét lại toàn bộ phần sản phẩm của hãng — gộp lại nhanh hơn hẳn.
"""
import sys, os, json, re, glob, argparse
import psycopg2
from psycopg2.extras import execute_values

GOC = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def chuan(s):
    """Giống cột sinh ref_norm trong DB: bỏ ký tự không phải chữ/số, viết hoa."""
    return re.sub(r"[^A-Za-z0-9]", "", s).upper()


def doc_env():
    env = {}
    with open(os.path.join(GOC, ".env"), encoding="utf-8") as f:
        for d in f:
            if "=" in d and not d.strip().startswith("#"):
                k, v = d.split("=", 1)
                env[k.strip()] = v.strip()
    return dict(dbname=env["DB_NAME"], user=env["DB_USER"],
                password=env["DB_PASSWORD"], host=env["DB_HOST"], port=env["DB_PORT"])


def gom_ten(o, ra):
    if isinstance(o, dict):
        so, ten = o.get("number"), o.get("name")
        if so and ten and isinstance(so, str) and isinstance(ten, str):
            ra.setdefault(chuan(so), ten.strip())
        for v in o.values():
            gom_ten(v, ra)
    elif isinstance(o, list):
        for v in o:
            gom_ten(v, ra)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mau", help="đường dẫn hoặc mẫu glob, VD 'thu_muc/Mazda_*.json'")
    ap.add_argument("--hang", required=True)
    ap.add_argument("--thu", action="store_true")
    a = ap.parse_args()

    tep = sorted(glob.glob(a.mau))
    if not tep:
        sys.exit(f"Không khớp file nào: {a.mau}")
    print(f"{len(tep)} file, hãng {a.hang}")

    ten = {}
    for i, f in enumerate(tep, 1):
        with open(f, encoding="utf-8") as fh:
            gom_ten(json.load(fh), ten)
        print(f"\r  đọc {i}/{len(tep)} — {len(ten):,} mã", end="", flush=True)
    print()
    if not ten:
        sys.exit("Không tìm thấy cặp (number, name) nào")

    cn = psycopg2.connect(**doc_env())
    cur = cn.cursor()
    cur.execute("create temp table _goc(ref text primary key, ten text not null)")
    execute_values(cur, "insert into _goc(ref,ten) values %s on conflict do nothing",
                   list(ten.items()), page_size=2000)
    cur.execute("analyze _goc")

    dk = """
      from catalog_products p join _goc g on g.ref = p.ref_norm
     where p.brand = %s and g.ten <> p.name
    """
    cur.execute("select count(*) " + dk, (a.hang,))
    print(f"  {cur.fetchone()[0]:,} dòng sẽ sửa")

    if a.thu:
        cur.execute("select p.internal_ref, p.name, g.ten " + dk + " limit 8", (a.hang,))
        print("\n  MẪU (mã | đang là | trả về):")
        for r in cur.fetchall():
            print(f"    {r[0]:<18} {r[1][:32]:<32} → {r[2][:38]}")
        print("\n  [THỬ] không ghi gì.")
        cn.rollback()
        return

    cur.execute("""
      update catalog_products p set name = g.ten, updated_at = now()
        from _goc g
       where g.ref = p.ref_norm and p.brand = %s and g.ten <> p.name
    """, (a.hang,))
    print(f"  ĐÃ SỬA name: {cur.rowcount:,} dòng")
    cn.commit()
    cn.close()


if __name__ == "__main__":
    main()
