/**
 * cao_thay_the.mjs — Cào mã THAY THẾ (Substitutions) từ PartSouq.
 *
 *   node scripts/cao_thay_the.mjs --ma 90915-YZZE1          # soi 1 mã, in ra
 *   node scripts/cao_thay_the.mjs --file ma.csv --ra kq.csv # cào hàng loạt
 *   node scripts/cao_thay_the.mjs --file ma.csv --ra kq.csv --nap  # + ghi DB
 *
 * Vì sao cần: crawler cũ (nap_json.py, 2 extension) chỉ lấy phần compatibility
 * (xe tương thích) — chưa hề đọc khối Substitutions. Đó là nguồn DUY NHẤT cho
 * quan hệ phụ tùng ↔ phụ tùng tương đương giữa các hãng khác nhau.
 *
 * Cấu trúc trang (xác nhận 2026-09-04, mã 90915-YZZE1):
 *   Tìm /search/all?q=<mã> → nếu mã có seller thì redirect thẳng sang trang part.
 *   Các .search-product-card TRƯỚC  <h3>Substitutions</h3> = chính mã đó (nhiều seller)
 *   Các .search-product-card SAU    <h3>Substitutions</h3> = mã THAY THẾ
 *   Trong mỗi card:
 *     .part-col-list-h4                tên phụ tùng
 *     .search-product-card-info-label  nhãn ("Part number"/"Make"/"Made in"),
 *        giá trị ở .search-product-card-info-value cùng cha
 *
 * Trang có Cloudflare. WebFetch/curl trả 403; Playwright tự mở Chrome cũng bị
 * captcha (cờ --enable-automation + navigator.webdriver). Nên script NỐI vào
 * Chrome mở tay. Trước khi chạy: đóng hết Chrome rồi mở lại bằng
 *   & "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
 * vào partsouq.com một lần cho qua Cloudflare, để nguyên cửa sổ đó.
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs';
import pgDriver from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const CHO = 1800;   // nghỉ giữa 2 mã, tránh bị chặn
const CDP = process.env.CDP || 'http://localhost:9222';

function docThamSo(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      a[k] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
    }
  }
  return a;
}

/** Bóc 1 trang part đã tải xong. Chạy TRONG browser. */
function bocTrang() {
  const doc = (c) => {
    const nhan = {};
    c.querySelectorAll('.search-product-card-info-label').forEach((l) => {
      const v = l.parentElement.querySelector('.search-product-card-info-value');
      if (v) nhan[l.textContent.trim().toLowerCase()] = v.textContent.trim();
    });
    return {
      ten: c.querySelector('.part-col-list-h4')?.textContent.trim() || null,
      so: nhan['part number'] || null,
      make: nhan['make'] || null,
      madein: nhan['made in'] || null,
      gia: c.querySelector('.search-product-price')?.textContent.trim() || null,
    };
  };
  const h3 = [...document.querySelectorAll('h3')]
    .find((h) => /substitution/i.test(h.textContent));
  const tatCa = [...document.querySelectorAll('.search-product-card')];
  // Card nằm SAU h3 trong luồng tài liệu = hàng thay thế
  const sau = h3
    ? tatCa.filter((c) => h3.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING)
    : [];
  const truoc = tatCa.filter((c) => !sau.includes(c));
  return { coKhoi: !!h3, chinh: truoc.map(doc), thayThe: sau.map(doc) };
}

const BI_CHAN = /just a moment|attention required|checking your browser|verify you are human|cf-challenge|captcha/i;

/** Trang còn đang bị Cloudflare chặn? Xét cả tiêu đề lẫn nội dung. */
async function dangBiChan(page) {
  if (BI_CHAN.test(await page.title())) return true;
  const t = await page.evaluate(() => document.body?.innerText?.slice(0, 3000) || '');
  return BI_CHAN.test(t);
}

async function soi(page, ma) {
  await page.goto(`https://partsouq.com/en/search/all?q=${encodeURIComponent(ma)}`,
    { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Đợi Cloudflare tự qua (thường vài giây)
  for (let i = 0; i < 20; i++) {
    if (!await dangBiChan(page)) break;
    await page.waitForTimeout(1500);
  }

  // Vẫn chặn = captcha cần người bấm. TUYỆT ĐỐI không được trả mảng rỗng ở đây:
  // "bị chặn" và "không có hàng thay thế" cho ra cùng một kết quả rỗng, ghi
  // xuống là hỏng luôn số liệu độ phủ. Ném lỗi để vòng ngoài dừng/đợi người.
  if (await dangBiChan(page)) {
    const e = new Error('CAPTCHA');
    e.captcha = true;
    throw e;
  }

  await page.waitForTimeout(1200);
  if (/nothing found/i.test(await page.content())) return { coKhoi: false, chinh: [], thayThe: [] };
  return page.evaluate(bocTrang);
}

const chuan = (s) => (s ? s.replace(/[^A-Za-z0-9]/g, '').toUpperCase() || null : null);
const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;

/**
 * Nạp trực tiếp danh sách mã thế vào catalog_oem_codes.
 * Nối qua catalog_products.ref_norm = chuan(maGoc).
 * ON CONFLICT DO NOTHING để an toàn khi chạy lại.
 */
async function napVaoDb(pool, maGoc, dsThayThe) {
  const normGoc = chuan(maGoc);
  if (!normGoc || !dsThayThe.length) return 0;

  const sp = await pool.query(
    'SELECT id FROM catalog_products WHERE ref_norm = $1 LIMIT 1',
    [normGoc]
  );
  if (!sp.rows.length) return 0;
  const productId = sp.rows[0].id;

  let dem = 0;
  for (const x of dsThayThe) {
    if (!x.so || chuan(x.so) === normGoc) continue;
    const res = await pool.query(`
      INSERT INTO catalog_oem_codes (product_id, oem_code, make, source)
      VALUES ($1, $2, $3, 'partsouq:substitutes')
      ON CONFLICT (product_id, oem_code) DO NOTHING
    `, [productId, x.so, x.make || null]);
    dem += res.rowCount;
  }
  return dem;
}

// ── self-check: bóc đúng chưa, không cần mạng ────────────────────────
if (process.argv.includes('--tu-kiem')) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM(`<body>
    <div class="search-product-card"><h1 class="part-col-list-h4">FILTER OIL</h1>
      <span class="search-product-card-info-label">Part number</span>
      <div class="search-product-card-info-value">90915YZZE1</div></div>
    <h3>Substitutions</h3>
    <div class="search-product-card"><h1 class="part-col-list-h4">OIL FILTER</h1>
      <span class="search-product-card-info-label">Part number</span>
      <div class="search-product-card-info-value">OC1188</div></div>
  </body>`);
  global.document = dom.window.document; global.Node = dom.window.Node;
  const r = bocTrang();
  const assert = (await import('assert')).default;
  assert.strictEqual(r.coKhoi, true, 'phai thay h3 Substitutions');
  assert.strictEqual(r.chinh.length, 1, 'card truoc h3 = ma chinh');
  assert.strictEqual(r.thayThe.length, 1, 'card sau h3 = ma thay the');
  assert.strictEqual(r.thayThe[0].so, 'OC1188');
  assert.strictEqual(r.chinh[0].so, '90915YZZE1');
  assert.strictEqual(chuan('13201-39225-B0'), '1320139225B0');
  console.log('tu-kiem: OK');
  process.exit(0);
}

// ── chạy ─────────────────────────────────────────────────────────────
const ts = docThamSo(process.argv.slice(2));
const dsMa = ts.ma ? [ts.ma]
  : readFileSync(ts.file, 'utf8').split(/\r?\n/).map((l) => l.replace(/^"|"$/g, '').trim()).filter(Boolean);

const raFile = ts.ra || null;
const coNapDb = Boolean(ts.nap);
let pool = null;
if (coNapDb) {
  pool = new pgDriver.Pool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME || 'catalog',
    user: process.env.DB_USER || 'catalog_user',
    password: process.env.DB_PASSWORD,
  });
}
// Ghi dần từng mã: cào hàng loạt hay đứt giữa chừng, mất hết thì phí công.
// Sổ .done ghi MỌI mã đã cào xong — kể cả mã 0 kết quả. Nếu chỉ dựa vào file
// kết quả thì mã "không có hàng thay thế" sẽ bị cào lại mãi, mà đó lại là phần
// đông. Mã dính captcha KHÔNG vào sổ nên lần chạy sau tự cào lại.
const soFile = raFile ? raFile + '.done' : null;
const daXong = new Set();
if (soFile && existsSync(soFile)) {
  for (const l of readFileSync(soFile, 'utf8').split(/\r?\n/)) if (l.trim()) daXong.add(l.trim());
  console.log(`tiep tuc: da cao ${daXong.size} ma truoc do`);
}
if (raFile && !existsSync(raFile)) {
  writeFileSync(raFile, '"ma_goc","ma_the","ten","make","made_in","gia"\n', 'utf8');
}

// Nối vào Chrome người dùng tự mở (chrome --remote-debugging-port=9222).
// Playwright tự khởi động Chrome sẽ kèm cờ --enable-automation và
// navigator.webdriver=true — Cloudflare đọc được, nên captcha lại mỗi lần.
// Chrome mở tay thì không có dấu vết đó, lại sẵn cookie/lịch sử thật.
const br = await chromium.connectOverCDP(CDP).catch(() => {
  console.error(`Khong noi duoc ${CDP}. Dong het Chrome, roi mo lai bang:\n` +
    `  & "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222`);
  process.exit(1);
});
const ctx = br.contexts()[0] || await br.newContext();
const pg = await ctx.newPage();

let n = 0, tong = 0, rong = 0, loi = 0, tongNap = 0;
for (const ma of dsMa) {
  if (daXong.has(ma)) continue;
  n++;
  let r = null;
  // Gặp captcha thì đợi người bấm xong ở cửa sổ đang mở, rồi thử lại chính mã đó.
  for (let lan = 1; lan <= 3 && !r; lan++) {
    try {
      r = await soi(pg, ma);
    } catch (e) {
      if (!e.captcha) {
        console.log(`  [${n}/${dsMa.length}] ${ma} — LOI: ${e.message.slice(0, 60)}`);
        loi++;
        break;
      }
      console.log(`  [${n}/${dsMa.length}] ${ma} — CAPTCHA (lan ${lan}/3): giai o cua so trinh duyet, se tu chay tiep`);
      // Đợi tối đa 3 phút cho người giải
      let qua = false;
      for (let i = 0; i < 60; i++) {
        await pg.waitForTimeout(3000);
        if (!await dangBiChan(pg)) { qua = true; break; }
      }
      if (!qua && lan === 3) { loi++; console.log('     bo qua ma nay'); }
    }
  }
  if (!r) continue;
  if (soFile) appendFileSync(soFile, ma + '\n', 'utf8');   // vào sổ: cào xong, kể cả 0 kết quả
  if (!r.thayThe.length) rong++;
  tong += r.thayThe.length;
  console.log(`  [${n}/${dsMa.length}] ${ma} → ${r.thayThe.length} ma the`);
  if (raFile) {
    const d = r.thayThe
      .filter((x) => x.so && chuan(x.so) !== chuan(ma))   // bỏ chính nó
      .map((x) => [ma, x.so, x.ten, x.make, x.madein, x.gia].map(q).join(',')).join('\n');
    if (d) appendFileSync(raFile, d + '\n', 'utf8');
  } else {
    for (const x of r.thayThe) console.log(`       ${x.so}  ${x.make}  ${x.ten}  ${x.gia}`);
  }
  if (coNapDb && r.thayThe.length) {
    const daGhi = await napVaoDb(pool, ma, r.thayThe);
    tongNap += daGhi;
    if (daGhi) console.log(`       -> DB +${daGhi} ma the`);
  }
  if (n < dsMa.length) await pg.waitForTimeout(CHO);
}
await pg.close();   // chỉ đóng tab của mình — Chrome là của người dùng, để nguyên
br.close();
if (pool) await pool.end();
const chay = n - loi;
console.log(`\nxong ${chay}/${n} ma | ${tong} ma the | ${rong} ma khong co thay the | ${loi} loi/captcha`);
if (coNapDb) console.log(`DB: da ghi ${tongNap} ban ghi vao catalog_oem_codes`);
if (chay) console.log(`do phu: ${(100 * (chay - rong) / chay).toFixed(1)}% ma co hang thay the`);
if (raFile) console.log(`-> ${raFile}`);
