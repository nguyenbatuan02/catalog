# -*- coding: utf-8 -*-
"""
seed_jobs_from_report.py — Nạp job cào từ báo cáo thiếu phụ tùng.

Đọc bao_cao_thieu_fitment.xlsx, lọc các dòng xe có "Số thiếu" > ngưỡng,
gộp theo (Hãng, dòng xe) rồi POST /crawl/seed để đưa vào hàng đợi catalog_crawl_jobs.

Chạy:
  python scripts/seed_jobs_from_report.py                       # ngưỡng 20, seed thật
  python scripts/seed_jobs_from_report.py --threshold 40        # chỉ xe thiếu > 40
  python scripts/seed_jobs_from_report.py --dry-run             # chỉ in, KHÔNG seed
  python scripts/seed_jobs_from_report.py --file khac.xlsx --api http://IP:3001/api/v1/catalog

Yêu cầu: pip install openpyxl  (urllib dùng thư viện chuẩn)
"""
import argparse, json, sys, urllib.request, urllib.error
import openpyxl

def find_cols(header):
    """Map tên cột -> index (0-based) theo header thực tế, chấp nhận vài biến thể."""
    idx = {}
    for i, h in enumerate(header):
        key = str(h or '').strip().lower()
        if key in ('hãng', 'hang', 'make'):           idx['make'] = i
        elif key in ('mã model', 'ma model', 'model_code'): idx['model_code'] = i
        elif key in ('tên xe', 'ten xe', 'model_name'):     idx['model_name'] = i
        elif key in ('số thiếu', 'so thieu', 'missing'):    idx['missing'] = i
    return idx

def post_seed(api_base, jobs):
    body = json.dumps({'jobs': jobs}).encode('utf-8')
    req = urllib.request.Request(api_base.rstrip('/') + '/crawl/seed', data=body,
                                 headers={'Content-Type': 'application/json'}, method='POST')
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode('utf-8'))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--file', default='bao_cao_thieu_fitment.xlsx')
    ap.add_argument('--threshold', type=int, default=20, help='Chỉ seed xe có Số thiếu > ngưỡng này')
    ap.add_argument('--api', default='http://localhost:3001/api/v1/catalog')
    ap.add_argument('--dry-run', action='store_true', help='Chỉ in danh sách, không gọi API')
    ap.add_argument('--chunk', type=int, default=500, help='Số job mỗi request POST')
    args = ap.parse_args()

    print(f"Đọc {args.file} ...")
    wb = openpyxl.load_workbook(args.file, read_only=True)
    ws = wb.active
    it = ws.iter_rows(values_only=True)
    header = next(it)
    cols = find_cols(header)
    for need in ('make', 'missing'):
        if need not in cols:
            print(f"LỖI: không tìm thấy cột '{need}' trong header: {header}", file=sys.stderr)
            sys.exit(1)

    # Gộp theo (make, model_line). model_line = Tên xe, thiếu thì dùng Mã model.
    seen = set()
    jobs = []
    total_rows = 0
    matched = 0
    for row in it:
        total_rows += 1
        make = str(row[cols['make']] or '').strip()
        if not make:
            continue
        missing = row[cols['missing']]
        try:
            missing = int(missing)
        except (TypeError, ValueError):
            continue
        if missing <= args.threshold:
            continue
        matched += 1
        model_line = ''
        if 'model_name' in cols:
            model_line = str(row[cols['model_name']] or '').strip()
        if not model_line and 'model_code' in cols:
            model_line = str(row[cols['model_code']] or '').strip()
        model_line = model_line or None
        key = (make, model_line or '')
        if key in seen:
            continue
        seen.add(key)
        jobs.append({'make': make, 'model_line': model_line})
    wb.close()

    print(f"Tổng dòng xe đọc: {total_rows}")
    print(f"Xe thiếu > {args.threshold}: {matched}  ->  job duy nhất theo (hãng, dòng xe): {len(jobs)}")

    if not jobs:
        print("Không có job nào để seed.")
        return

    # Xem trước vài job
    print("\nVí dụ job (tối đa 10):")
    for j in jobs[:10]:
        print(f"   {j['make']} / {j['model_line'] or '(cả hãng)'}")

    if args.dry_run:
        print(f"\n[DRY-RUN] Không gọi API. Sẽ seed {len(jobs)} job nếu bỏ --dry-run.")
        return

    # Seed theo chunk
    total_added, total_skipped = 0, 0
    for i in range(0, len(jobs), args.chunk):
        part = jobs[i:i+args.chunk]
        try:
            res = post_seed(args.api, part)
            total_added += res.get('added', 0)
            total_skipped += res.get('skipped', 0)
            print(f"   POST {i+1}-{i+len(part)}: +{res.get('added',0)} mới, {res.get('skipped',0)} trùng")
        except urllib.error.URLError as e:
            print(f"LỖI gọi API: {e}", file=sys.stderr)
            sys.exit(1)

    print(f"\nHOÀN THÀNH: đã thêm {total_added} job mới, bỏ qua {total_skipped} trùng.")

if __name__ == '__main__':
    main()
