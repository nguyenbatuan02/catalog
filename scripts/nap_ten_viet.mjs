/**
 * nap_ten_viet.mjs — NẠP TÊN TIẾNG VIỆT THEO HÃNG
 *
 *   node scripts/nap_ten_viet.mjs <file.csv> <brand>
 *   node scripts/nap_ten_viet.mjs ~/Downloads/unique_names_toyota.csv Toyota
 *
 * CSV: #,name_en,name_vi_kt,name_vi_cho   (có header, cho phép xuống dòng trong ô)
 * Ánh xạ theo catalog_products.name = name_en, chỉ trong phạm vi brand đó.
 *   name_vi_kt  → name_vi       (GHI ĐÈ — bản dịch máy cũ sai)
 *   name_vi_cho → name_vi_cho
 * Ô trống thì giữ nguyên giá trị cũ.
 *
 * --thu : chỉ đếm, không ghi.
 */
import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

const [file, brand] = process.argv.slice(2).filter(a => !a.startsWith('--'));
const thu = process.argv.includes('--thu');
if (!file || !brand) {
  console.error('Dùng: node scripts/nap_ten_viet.mjs <file.csv> <brand> [--thu]');
  process.exit(1);
}
const duongDan = resolve(file.replace(/^~/, process.env.USERPROFILE || process.env.HOME));
if (!existsSync(duongDan)) { console.error(`Không thấy file: ${duongDan}`); process.exit(1); }

// ponytail: đọc .env bằng regex thay vì thêm dotenv — file này 20 dòng, format cố định.
// Đổi sang dotenv khi cần nội suy biến hoặc multi-line value.
const env = Object.fromEntries(
  readFileSync(resolve('.env'), 'utf8')
    .split(/\r?\n/).map(l => l.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean)
    .map(m => [m[1], m[2].trim()]));

const BANG = '_nap_ten_' + brand.toLowerCase().replace(/[^a-z0-9]/g, '');
const H = brand.replace(/'/g, "''");   // brand đã thoát nháy, nhúng vào SQL
const sql = `
\\set ON_ERROR_STOP on
drop table if exists ${BANG};
create table ${BANG}(stt int, name_en text, name_vi_kt text, name_vi_cho text);
\\copy ${BANG} from '${duongDan.replace(/\\/g, '/')}' with (format csv, header true)
delete from ${BANG} where name_en is null or name_en = '';
create index on ${BANG}(name_en);
analyze ${BANG};

-- Một lần quét ra cả 3 con số. Tách thành nhiều câu count thì mỗi câu lại
-- duyệt lại toàn bộ phần sản phẩm của hãng — chậm gấp mấy lần.
select (select count(*) from ${BANG})                    as "dong_trong_file",
       count(distinct t.name_en)                         as "ten_khop_duoc",
       (select count(*) from ${BANG}) - count(distinct t.name_en)
                                                         as "ten_thua_khong_co_trong_db",
       count(*)                                          as "so_dong_se_sua"
  from catalog_products p join ${BANG} t on t.name_en = p.name
 where p.brand = '${H}';
${thu ? '' : `
update catalog_products p
   set name_vi     = coalesce(nullif(t.name_vi_kt , ''), p.name_vi),
       name_vi_cho = coalesce(nullif(t.name_vi_cho, ''), p.name_vi_cho),
       updated_at  = now()
  from ${BANG} t
 where t.name_en = p.name
   and p.brand = '${H}';
`}
drop table ${BANG};

select count(*)                       as "tong_san_pham",
       count(name_vi)                 as "co_ten_ky_thuat",
       count(name_vi_cho)             as "co_ten_cho",
       count(*) - count(name_vi_cho)  as "con_thieu_ten_cho"
  from catalog_products where brand = '${H}';
`;

console.log(`${thu ? '[THỬ] ' : ''}${brand} ← ${duongDan}`);
const r = spawnSync('psql', ['-h', env.DB_HOST, '-p', env.DB_PORT, '-U', env.DB_USER,
  '-d', env.DB_NAME, '-v', 'ON_ERROR_STOP=1', '-f', '-'],   // không -q: cần thấy dòng "UPDATE n"
  { input: sql, encoding: 'utf8', env: { ...process.env, PGPASSWORD: env.DB_PASSWORD } });
process.stdout.write(r.stdout || '');
if (r.stderr) process.stderr.write(r.stderr);
process.exit(r.status ?? 1);
