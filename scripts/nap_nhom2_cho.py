# -*- coding: utf-8 -*-
"""
nap_nhom2_cho.py — Đưa Nhóm 2 của Product.xlsx vào PHÒNG CHỜ (product_cho_nap)
và dựng hàng đợi cào xe (crawl_xe_queue).

Nhóm 2 = mã CHƯA có trong catalog_products, Mã gốc có chữ số, nhưng Mã gốc đó
KHÔNG khớp sản phẩm nào trong DB (nếu khớp thì đã thuộc Nhóm 1, nạp xong rồi).

    python scripts/nap_nhom2_cho.py
"""
import openpyxl, psycopg2, re, sys, io, uuid
sys.stdout.reconfigure(encoding='utf-8')

import os
# Đọc .env bằng tay — không cài python-dotenv, và KHÔNG viết cứng mật khẩu vào file.
def doc_env(duong_dan='.env'):
    if os.path.exists(duong_dan):
        for dong in open(duong_dan, encoding='utf-8'):
            dong = dong.strip()
            if dong and not dong.startswith('#') and '=' in dong:
                k, v = dong.split('=', 1)
                os.environ.setdefault(k.strip(), v.strip())
doc_env()

conn = psycopg2.connect(
    dbname   = os.environ.get('DB_NAME', 'catalog'),
    user     = os.environ.get('DB_USER', 'catalog_user'),
    password = os.environ['DB_PASSWORD'],
    host     = os.environ.get('DB_HOST', 'localhost'),
    port     = int(os.environ.get('DB_PORT', 5432)),
)
cur = conn.cursor()

def norm(s):
    return re.sub(r'[^A-Za-z0-9]', '', str(s or '')).upper()

print('1. Nạp ref_norm hiện có trong DB...')
cur.execute('SELECT ref_norm FROM catalog_products WHERE ref_norm IS NOT NULL')
db_refs = set(r[0] for r in cur.fetchall())
print(f'   -> {len(db_refs)} sản phẩm')

print('2. Quét Product.xlsx, lọc Nhóm 2...')
wb = openpyxl.load_workbook('data/Product.xlsx', read_only=True)
ws = wb.active
it = ws.iter_rows(values_only=True)
next(it)

ung_vien = {}
bo_rac = 0
for r in it:
    ref  = str(r[0] or '').strip()
    ten  = str(r[1] or '').strip()
    mg   = str(r[2] or '').strip()
    if not ref or not mg:
        continue

    n_ref, n_mg = norm(ref), norm(mg)
    if not n_ref or not n_mg:
        continue
    if n_ref in db_refs:           # đã có trong DB
        continue
    if n_ref == n_mg:              # mã gốc tự trỏ, không dùng để cào được
        continue
    if not re.search(r'[0-9]', mg):   # mã gốc rác (chữ marketing/tên hàng)
        bo_rac += 1
        continue
    if n_mg in db_refs:            # Nhóm 1 — đã nạp ở bước trước
        continue

    # Trùng mã: giữ bản ghi có tên dài hơn (thường đầy đủ hơn)
    cu = ung_vien.get(n_ref)
    if cu is None or len(ten) > len(cu[2]):
        ung_vien[n_ref] = (n_ref, ref, ten, mg, n_mg)

items = list(ung_vien.values())
print(f'   -> Nhóm 2: {len(items)} sản phẩm ({bo_rac} dòng mã gốc rác đã loại)')

print('3. Ghi vào phòng chờ product_cho_nap...')
buf = io.StringIO()
for n_ref, ref, ten, mg, n_mg in items:
    sach = lambda s: re.sub(r'[\r\n\t]+', ' ', s).replace('\\', '/').strip()
    buf.write(f'{n_ref}\t{sach(ref)}\t{sach(ten)}\t{sach(mg)}\t{n_mg}\n')
buf.seek(0)

cur.execute('CREATE TEMP TABLE tmp_cho (LIKE product_cho_nap INCLUDING DEFAULTS)')
cur.copy_from(buf, 'tmp_cho',
              columns=('ref_norm', 'internal_ref', 'ten', 'ma_goc', 'oem_norm'))
cur.execute("""
    INSERT INTO product_cho_nap (ref_norm, internal_ref, ten, ma_goc, oem_norm)
    SELECT ref_norm, internal_ref, ten, ma_goc, oem_norm FROM tmp_cho
    ON CONFLICT (ref_norm) DO NOTHING
""")
print(f'   -> {cur.rowcount} sản phẩm vào phòng chờ')

print('4. Dựng hàng đợi cào xe (gom theo mã gốc)...')
# Lọc tỉ lệ chữ số >= 60%. Chỉ "có chứa chữ số" là KHÔNG đủ: mã nội bộ kiểu
# ROTUYN41KR / GIACAIBA92EON / TUYOXANG01LAP (tiếng Việt viết tắt + số đuôi)
# vẫn lọt, mà PartSouq không bao giờ có. Đo thực tế: 20,921/23,835 mã là loại
# này — cào hết mất ~12h thì ~10.5h đổ vào mã chắc chắn không có kết quả.
# Sản phẩm của chúng vẫn nằm trong product_cho_nap, muốn cào lại lúc nào cũng được.
cur.execute("""
    INSERT INTO crawl_xe_queue (oem_norm, oem_code)
    SELECT DISTINCT ON (oem_norm) oem_norm, ma_goc
    FROM product_cho_nap
    WHERE NOT da_nap
      AND length(regexp_replace(ma_goc,'[^0-9]','','g'))::float
        / NULLIF(length(regexp_replace(ma_goc,'[^A-Za-z0-9]','','g')),0) >= 0.6
    ORDER BY oem_norm, ma_goc
    ON CONFLICT (oem_norm) DO NOTHING
""")
print(f'   -> {cur.rowcount} mã gốc cần cào PartSouq')

conn.commit()

cur.execute('SELECT count(*) FROM product_cho_nap')
sp = cur.fetchone()[0]
cur.execute("SELECT status, count(*) FROM crawl_xe_queue GROUP BY status")
print(f'\nTổng phòng chờ: {sp} sản phẩm')
for st, c in cur.fetchall():
    print(f'  hàng đợi {st}: {c}')

cur.close()
conn.close()
