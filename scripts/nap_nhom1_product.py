import openpyxl, psycopg2, re, sys, io, time
from collections import defaultdict
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
    if not s: return ''
    return re.sub(r'[^A-Za-z0-9]', '', str(s)).upper()

print('1. Nap san pham goc tu DB...')
cur.execute('SELECT id, ref_norm FROM catalog_products WHERE ref_norm IS NOT NULL')
prod_map = dict((r[1], r[0]) for r in cur.fetchall())
print(f'   -> DB co {len(prod_map)} san pham')

print('2. Loc san pham hop le tu Product.xlsx...')
wb = openpyxl.load_workbook('data/Product.xlsx', read_only=True)
ws = wb.active
it = ws.iter_rows(values_only=True)
next(it)

candidates = {}
for r in it:
    ref = str(r[0] or '').strip()
    name = str(r[1] or '').strip()
    mg = str(r[2] or '').strip()
    if not ref or not mg: continue

    n_ref = norm(ref)
    n_mg = norm(mg)
    if not n_ref or not n_mg: continue
    if n_ref in prod_map or n_ref == n_mg: continue
    if not re.search(r'[0-9]', mg): continue

    if n_mg in prod_map:
        if n_ref not in candidates or len(name) > len(candidates[n_ref]['name']):
            candidates[n_ref] = {
                'ref': ref,
                'name': name,
                'ma_goc': mg,
                'parent_id': prod_map[n_mg]
            }

items = list(candidates.values())
print(f'   -> Tong cong {len(items)} san pham moi can nap')

print('3. Tao bang staging va INSERT vao catalog_products...')
cur.execute('''
    CREATE TEMP TABLE tmp_new_products (
        new_id uuid,
        internal_ref text,
        name text,
        ma_goc text,
        parent_id uuid
    );
''')

import uuid
output = io.StringIO()
for x in items:
    u = str(uuid.uuid4())
    x['new_id'] = u
    clean_name = re.sub(r'[\r\n\t]+', ' ', x['name']).replace('\\', '/').strip()
    clean_ref = str(x['ref']).replace('\t', ' ').replace('\\', '/').strip()
    clean_mg = str(x['ma_goc']).replace('\t', ' ').replace('\\', '/').strip()
    output.write(f"{u}\t{clean_ref}\t{clean_name}\t{clean_mg}\t{x['parent_id']}\n")

output.seek(0)
cur.copy_from(output, 'tmp_new_products', columns=('new_id', 'internal_ref', 'name', 'ma_goc', 'parent_id'))

t0 = time.time()
cur.execute('''
    INSERT INTO catalog_products (
        id, name, name_vi, internal_ref, oem_code, is_for_sale, product_type, notes, created_at, updated_at
    )
    SELECT
        new_id,
        name,
        name,
        internal_ref,
        NULL,
        TRUE,
        'aftermarket',
        'nguon: Product.xlsx',
        now(),
        now()
    FROM tmp_new_products
    ON CONFLICT (ref_norm) WHERE ref_norm IS NOT NULL DO NOTHING
''')
ins_prod = cur.rowcount
print(f'   -> Da them {ins_prod} san pham moi vao catalog_products (mat {time.time() - t0:.2f}s)')

print('4. INSERT quan he OEM vao catalog_oem_codes...')
t1 = time.time()
cur.execute('''
    INSERT INTO catalog_oem_codes (product_id, oem_code, make, source)
    SELECT new_id, ma_goc, NULL, 'Product.xlsx:Mã gốc'
    FROM tmp_new_products
    ON CONFLICT (product_id, oem_code) DO NOTHING
''')
ins_oem = cur.rowcount
print(f'   -> Da them {ins_oem} ban ghi vao catalog_oem_codes (mat {time.time() - t1:.2f}s)')

print('5. Ke thua Fitment tu san pham goc...')
t2 = time.time()
cur.execute('''
    INSERT INTO catalog_fitments (id, product_id, vehicle_id, notes, created_at)
    SELECT
        gen_random_uuid(),
        t.new_id,
        f.vehicle_id,
        'nguon: Product.xlsx (ke thua fitment)',
        now()
    FROM tmp_new_products t
    JOIN catalog_fitments f ON f.product_id = t.parent_id
    ON CONFLICT (product_id, vehicle_id) DO NOTHING
''')
ins_fit = cur.rowcount
print(f'   -> Da tao thanh cong {ins_fit} cap fitment ke thua (mat {time.time() - t2:.2f}s)')

conn.commit()

print('6. Kiem tra ket qua sau ghi:')
cur.execute('''
    SELECT
        (SELECT count(*) FROM catalog_products) as total_products,
        (SELECT count(*) FROM catalog_oem_codes WHERE source = 'Product.xlsx:Mã gốc') as oem_codes,
        (SELECT count(*) FROM catalog_fitments WHERE notes = 'nguon: Product.xlsx (ke thua fitment)') as fitments
''')
tot_p, tot_o, tot_f = cur.fetchone()
print(f'   - Tong catalog_products: {tot_p}')
print(f'   - catalog_oem_codes moi: {tot_o}')
print(f'   - catalog_fitments moi : {tot_f}')

cur.close()
conn.close()
