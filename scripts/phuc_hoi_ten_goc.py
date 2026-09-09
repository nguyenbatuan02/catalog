#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
phuc_hoi_ten_goc.py — TRẢ LẠI TÊN GỐC cho catalog_products.name

Trước đây nap_json.py đổ name_vi đè lên name (để tìm kiếm tiếng Việt), làm mất
tên gốc của ~682k dòng. Nay backend đã tìm cả 3 cột tên nên không cần đè nữa,
nhưng dữ liệu đã hỏng — script này lấy lại tên gốc từ chính file JSON đã cào.

    python scripts/phuc_hoi_ten_goc.py file.json --thu    # chỉ đếm, KHÔNG ghi
    python scripts/phuc_hoi_ten_goc.py file.json          # ghi thật

BƯỚC 1 trong 2. Chỉ đụng cột `name`, khớp theo number ↔ internal_ref, và chỉ
ghi khi name hiện tại đang là tiếng Việt (tức đã bị đè) — dòng còn tên gốc
Anh/Nhật để yên. Không INSERT, không DELETE, không đụng xe/fitment.

KHÔNG lấy name_vi từ JSON: bản dịch trong file này chính là thứ đã đè hỏng
cột name, và nó sai nặng (EMBLEM → "Lò xo giảm xóc").

BƯỚC 2 — name_vi và name_vi_cho lấy từ file CSV, bản dịch tay:
    node scripts/nap_ten_viet.mjs ~/Downloads/unique_names_Suzuki.csv Suzuki
"""
import sys, os, json, re, argparse
import psycopg2
from psycopg2.extras import execute_values

GOC = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Giống hệt cột sinh ref_norm trong DB (migrations): bỏ mọi ký tự không phải
# chữ/số rồi viết hoa. Hai bên phải cùng công thức thì join mới khớp.
def chuan(s):
    return re.sub(r"[^A-Za-z0-9]", "", s).upper()


def doc_env():
    env = {}
    with open(os.path.join(GOC, ".env"), encoding="utf-8") as f:
        for d in f:
            if "=" in d and not d.strip().startswith("#"):
                k, v = d.split("=", 1)
                env[k.strip()] = v.strip()
    return dict(dbname=env["DB_NAME"], user=env["DB_USER"],
                password=env["DB_PASSWORD"], host=env["DB_HOST"],
                port=env["DB_PORT"])


def gom_ten(o, ra):
    """Duyệt cây JSON, gom mọi (number → name) ở tầng parts. Bỏ qua name_vi."""
    if isinstance(o, dict):
        so, ten = o.get("number"), o.get("name")
        # tầng parts nhận ra nhờ có 'number'; tầng model cũng có 'name' nhưng không có 'number'
        if so and ten and isinstance(so, str) and isinstance(ten, str):
            ra.setdefault(so.strip(), ten.strip())
        for v in o.values():
            gom_ten(v, ra)
    elif isinstance(o, list):
        for v in o:
            gom_ten(v, ra)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("file")
    ap.add_argument("--thu", action="store_true", help="chỉ đếm, không ghi DB")
    ap.add_argument("--hang", help="giới hạn theo brand, VD Suzuki. Thiếu thì lấy 'brand' ở tầng 1 của file")
    a = ap.parse_args()

    print(f"Đọc {os.path.basename(a.file)} ...", flush=True)
    with open(a.file, encoding="utf-8") as f:
        goc = json.load(f)

    # Lọc theo brand là bắt buộc cho tốc độ: không có nó thì điều kiện
    # name <> unaccent_immutable(name) phải tính cho cả 5.9M dòng (quét ~40 phút),
    # có nó thì chỉ quét đúng phần của hãng đó.
    # file gốc có 2 dạng: dict ở ngoài cùng, hoặc list bọc 1 dict
    dau = goc[0] if isinstance(goc, list) and goc and isinstance(goc[0], dict) else goc
    hang = a.hang or (dau.get("brand") if isinstance(dau, dict) else None)
    if not hang:
        sys.exit("Không đoán được hãng — truyền thêm --hang <Brand>")
    print(f"  hãng: {hang}")

    ten = {}
    gom_ten(goc, ten)
    print(f"  {len(ten):,} mã có tên gốc trong file")
    if not ten:
        sys.exit("Không tìm thấy cặp (number, name) nào — sai định dạng file?")

    cn = psycopg2.connect(**doc_env())
    cur = cn.cursor()
    # Khớp theo MÃ ĐÃ CHUẨN HOÁ: file JSON ghi mã liền "0911133030" còn DB ghi
    # có gạch "09111-33030" — join thô trên chuỗi thì trượt gần hết. Cột
    # ref_norm của DB đã bỏ sẵn mọi ký tự không phải chữ/số nên bám theo nó.
    cur.execute("create temp table _goc(ref text primary key, ten text not null)")
    execute_values(cur, "insert into _goc(ref,ten) values %s on conflict do nothing",
                   [(chuan(k), v) for k, v in ten.items()], page_size=1000)

    dk = """
      from catalog_products p join _goc g
        on g.ref = p.ref_norm
       where p.brand = %s
         and g.ten <> p.name
    """
    cur.execute("select count(*) " + dk, (hang,))
    n = cur.fetchone()[0]
    print(f"  {n:,} dòng khớp mã và có tên gốc khác tên đang lưu")

    if a.thu:
        cur.execute("select p.internal_ref, p.name, g.ten " + dk + " limit 8", (hang,))
        print("\n  MẪU sẽ sửa (mã | đang là | trả về):")
        for r in cur.fetchall():
            print(f"    {r[0]:<18} {r[1][:34]:<34} → {r[2][:40]}")
        print("\n  [THỬ] không ghi gì.")
        cn.rollback()
        return

    cur.execute("""
      update catalog_products p
         set name = g.ten, updated_at = now()
        from _goc g
       where g.ref = p.ref_norm
         and p.brand = %s
         and g.ten <> p.name
    """, (hang,))
    print(f"  ĐÃ SỬA name: {cur.rowcount:,} dòng")
    print("  → Bước 2: node scripts/nap_ten_viet.mjs <csv> <brand>")
    cn.commit()
    cn.close()


if __name__ == "__main__":
    main()
