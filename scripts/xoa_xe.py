#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
xoa_xe.py — Xoá xe (và fitment kèm theo) khỏi DB. Dùng để làm lại một lần nạp hỏng.

MẶC ĐỊNH CHỈ XEM, KHÔNG XOÁ. Phải thêm --xoa-that mới thực sự xoá.

    # Xoá đúng những xe mà file JSON này đã tạo ra  ← hay dùng nhất
    python scripts/xoa_xe.py --tu-file D:\\data\\Toyota.json
    python scripts/xoa_xe.py --tu-file D:\\data\\Toyota.json --xoa-that

    # Xoá theo hãng
    python scripts/xoa_xe.py --make Toyota --xoa-that

    # Xoá sạch toàn bộ xe
    python scripts/xoa_xe.py --tat-ca --xoa-that

    # Dọn luôn phụ tùng bị mồ côi (không còn gắn với xe nào)
    python scripts/xoa_xe.py --tu-file X.json --xoa-that --kem-phu-tung-mo-coi

Xoá xe thì fitment tự mất theo (ràng buộc ON DELETE CASCADE).
Phụ tùng KHÔNG bị xoá trừ khi thêm --kem-phu-tung-mo-coi.
"""

import sys, os, json, argparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from nap_json import cau_hinh_db, CAU_HINH, rong, so_dep   # dùng chung .env + cấu hình

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


def doc_cap_tu_file(duong_dan):
    """Trả về danh sách (make, model_code) mà file này sẽ tạo — cùng cách tính với nap_json.py"""
    cfg = CAU_HINH
    with open(duong_dan, "r", encoding="utf-8-sig") as f:
        goc = json.load(f)
    ds = goc if isinstance(goc, list) else [goc]

    cap = set()
    for b in ds:
        make = b.get(cfg["make"]) if cfg["make"] else None
        if rong(make):
            continue
        make = str(make).strip()
        for c in b.get("car_types") or []:
            for m in c.get("models") or []:
                ten = m.get(cfg["model_name"]) if cfg["model_name"] else None
                ma = m.get(cfg["model_code"]) if cfg["model_code"] else None
                if rong(ma):
                    if rong(ten):
                        continue
                    ma = str(ten).strip()
                cap.add((make, str(ma).strip().upper()))
    return sorted(cap)


def main():
    ap = argparse.ArgumentParser(description="Xoá xe khỏi DB (mặc định chỉ xem)")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--tu-file", metavar="FILE.JSON",
                   help="xoá đúng các xe mà file JSON này tạo ra")
    g.add_argument("--make", metavar="HANG", help="xoá toàn bộ xe của một hãng")
    g.add_argument("--tat-ca", action="store_true", help="xoá SẠCH toàn bộ xe")
    ap.add_argument("--xoa-that", action="store_true",
                    help="thực sự xoá (không có cờ này thì chỉ xem)")
    ap.add_argument("--kem-phu-tung-mo-coi", action="store_true",
                    help="xoá luôn phụ tùng không còn gắn với xe nào")
    a = ap.parse_args()

    import psycopg2
    tt = cau_hinh_db()
    conn = psycopg2.connect(**tt)
    cur = conn.cursor()

    print(f"\nDB: {tt['dbname']} @ {tt['host']}:{tt['port']}  (user {tt['user']})")

    # ── Xác định tập xe cần xoá ──────────────────────────────────────
    if a.tat_ca:
        mo_ta = "TOÀN BỘ xe trong DB"
        dieu_kien, tham_so = "TRUE", []
    elif a.make:
        mo_ta = f"xe của hãng '{a.make}'"
        dieu_kien, tham_so = "make = %s", [a.make]
    else:
        cap = doc_cap_tu_file(a.tu_file)
        if not cap:
            print("✗ Không đọc được xe nào từ file. Kiểm tra CAU_HINH trong nap_json.py.")
            sys.exit(1)
        mo_ta = f"xe khớp file {os.path.basename(a.tu_file)} ({so_dep(len(cap))} mã)"
        dieu_kien = ("(make, model_code) IN "
                     "(SELECT * FROM unnest(%s::text[], %s::text[]))")
        tham_so = [[c[0] for c in cap], [c[1] for c in cap]]

    # ── Đếm trước ────────────────────────────────────────────────────
    cur.execute(f"SELECT count(*) FROM catalog_vehicles WHERE {dieu_kien}", tham_so)
    so_xe = cur.fetchone()[0]
    cur.execute(f"""SELECT count(*) FROM catalog_fitments f
                    WHERE f.vehicle_id IN (SELECT id FROM catalog_vehicles WHERE {dieu_kien})""",
                tham_so)
    so_fit = cur.fetchone()[0]

    print(f"\nSẽ xoá: {mo_ta}")
    print(f"   Xe      : {so_dep(so_xe)}")
    print(f"   Fitment : {so_dep(so_fit)}   (tự mất theo xe)")

    if so_xe:
        cur.execute(f"""SELECT make, model_code, model_name, year_from, year_to
                        FROM catalog_vehicles WHERE {dieu_kien}
                        ORDER BY make, model_code LIMIT 5""", tham_so)
        print("\n   Ví dụ:")
        for r in cur.fetchall():
            print(f"     {r[0]} | {r[1]} | {r[2] or ''} | {r[3]}-{r[4]}")
        if so_xe > 5:
            print(f"     ... và {so_dep(so_xe - 5)} xe nữa")

    if so_xe == 0:
        print("\n✓ Không có xe nào khớp — không phải làm gì.\n")
        conn.close()
        return

    if not a.xoa_that:
        print("\n>> CHỈ XEM, chưa xoá gì cả.")
        print("   Muốn xoá thật thì chạy lại và thêm  --xoa-that\n")
        conn.close()
        return

    # ── Hỏi lại lần cuối ─────────────────────────────────────────────
    print(f"\n{'!' * 68}")
    print(f"SẮP XOÁ THẬT {so_dep(so_xe)} xe và {so_dep(so_fit)} fitment khỏi DB '{tt['dbname']}'.")
    print("Việc này KHÔNG HOÀN TÁC ĐƯỢC.")
    print("!" * 68)
    try:
        tra_loi = input("Gõ đúng chữ  XOA  rồi Enter để tiếp tục (thứ khác = huỷ): ").strip()
    except EOFError:
        tra_loi = ""
    if tra_loi != "XOA":
        print("→ Đã huỷ, không xoá gì.\n")
        conn.close()
        return

    try:
        cur.execute(f"DELETE FROM catalog_vehicles WHERE {dieu_kien}", tham_so)
        da_xoa = cur.rowcount

        mo_coi = 0
        if a.kem_phu_tung_mo_coi:
            cur.execute("""DELETE FROM catalog_products p
                           WHERE NOT EXISTS (SELECT 1 FROM catalog_fitments f
                                             WHERE f.product_id = p.id)""")
            mo_coi = cur.rowcount

        conn.commit()
        print(f"\n✓ Đã xoá {so_dep(da_xoa)} xe (kèm {so_dep(so_fit)} fitment).")
        if a.kem_phu_tung_mo_coi:
            print(f"✓ Đã xoá {so_dep(mo_coi)} phụ tùng mồ côi.")
        else:
            cur.execute("""SELECT count(*) FROM catalog_products p
                           WHERE NOT EXISTS (SELECT 1 FROM catalog_fitments f
                                             WHERE f.product_id = p.id)""")
            con = cur.fetchone()[0]
            if con:
                print(f"\n  Còn {so_dep(con)} phụ tùng không gắn với xe nào.")
                print("  Nạp lại file là chúng được gắn lại, không cần xoá.")
                print("  Muốn dọn thì chạy lại với --kem-phu-tung-mo-coi")
        print("")
    except Exception as e:
        conn.rollback()
        print(f"\n✗ LỖI — đã huỷ, DB giữ nguyên:\n  {e}\n")
        sys.exit(1)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
