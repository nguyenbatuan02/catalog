/**
 * cao_ma_hang.mjs — Cào mã OEM tương đương cho SP HÀNG THAY THẾ, tra bằng
 * CHÍNH MÃ CỦA HÃNG đó (JS Asakashi, MChanix).
 *
 *   node scripts/cao_ma_hang.mjs [--hang js|mchanix] [--nap]
 *
 * Không --nap: chỉ in ra, không ghi DB.
 *
 * VÌ SAO TRA BẰNG MÃ HÃNG: đo 2026-09-26, tra bằng mã OEM (Toyota/Hyundai...)
 * thì JS 9%, MChanix 0/400. Tra bằng mã của chính hãng: JS 40/40, MChanix 9/10.
 * Mỗi web chỉ có catalog của hãng mình.
 *
 * Kết quả ghi vào catalog_oem_codes của CHÍNH SP hãng đó, nên SP lọc JS /
 * cao su MChanix sẽ nối được sang mã chính hãng (và ngược lại qua oem_norm).
 * Chạy lại an toàn: ON CONFLICT DO NOTHING.
 */
import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const args = process.argv.slice(2);
const doc = (k, m) => { const i = args.indexOf('--' + k); return i !== -1 && args[i + 1] ? args[i + 1] : m; };
const CHI_HANG = doc('hang', null);
const NAP = args.includes('--nap');
const NGHI = parseInt(doc("delay", "800"));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153.0.0.0 Safari/537.36';

const pool = new pg.Pool({
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
});

const lay = (url, opt = {}) => fetch(url, { ...opt, headers: { 'User-Agent': UA, ...opt.headers },
  signal: AbortSignal.timeout(25000) }).then((r) => r.text());

// Mã trong DB có đuôi nội bộ (-CC hàng Trung Quốc, -NM không hộp...) — không phải mã hãng.
const boDuoi = (m) => m.replace(/-(CC|NM|GG|BH|JP)$/i, '');
const giaiMa = (s) => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();

// ── JS Asakashi ───────────────────────────────────────────────────────
// POST mã JS -> chuyển thẳng sang trang chi tiết; khối Cross reference có
// cấu trúc .str > .owner (hãng) + .field (mã), giống JNBK.
let cookieJs = null;
async function traJs(ma) {
  if (!cookieJs) {
    const r = await fetch('https://www.jsfilter.jp/catalogue', { headers: { 'User-Agent': UA } });
    cookieJs = (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  }
  const html = await lay('https://www.jsfilter.jp/catalogue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieJs, Referer: 'https://www.jsfilter.jp/catalogue' },
    body: new URLSearchParams({ txtPartNo: ma, btnProductSearch: 'search' }),
  });
  const i = html.indexOf('>Cross reference<');
  if (i === -1) return null;
  const het = html.indexOf('search-result-table', i);   // bảng xe ngay sau khối
  const khoi = html.slice(i, het > i ? het : i + 30000);
  return [...khoi.matchAll(/class="owner">([^<]*)<[\s\S]*?class="field">([^<]*)</g)]
    .map((m) => ({ hang: giaiMa(m[1]), ma: giaiMa(m[2]) }))
    .filter((x) => x.ma);
}

// ── MChanix ───────────────────────────────────────────────────────────
// Logic bóc dùng lại từ scripts/do_mchanix.mjs (đã kiểm với mẫu 400 mã).
// ⚠ MChanix chặn IP sau ~30 lần gọi: chuyển sang /en/verification (captcha).
// fetch tự theo redirect nên trang trả về KHÔNG có link part -> dễ tưởng nhầm
// "không có mã" (lần chạy 2026-09-26: 496/525 "không có" thực ra là bị chặn).
async function layMc(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(25000) });
  if (r.url.includes('/verification')) throw new Error('BI_CHAN');
  return r.text();
}
async function traMchanix(ma) {
  const lay = layMc;
  const s = await lay(`https://catalog.mchanix.com/en/search/1?q=${encodeURIComponent(ma)}&numbersearchinput=1&searchtype=0&status=1`);
  const link = s.match(/\.\.\/part\/([A-Za-z0-9-]+)\?ctx_q=[^"]*lgid=([A-Za-z0-9_-]+)/);
  if (!link) return null;
  const d = await lay(`https://catalog.mchanix.com/en/part/${link[1]}?ctx_q=${encodeURIComponent(ma)}&lgid=${link[2]}&abid=L73`);
  const i = d.indexOf('OE / Comparable Number');
  if (i === -1) return [];
  const j = d.indexOf('Parts List', i);
  const dong = d.slice(i, j > i ? j : i + 20000).replace(/<[^>]+>/g, '\n').split(/\n+/).map((x) => x.trim()).filter(Boolean);
  const ra = []; let hang = null;
  for (const x of dong) {
    if (/^[A-Z][A-Z .&-]{2,24}$/.test(x) && !/\d/.test(x)) { hang = x; continue; }
    // "GA2A-34-46XB BUSH" -> chỉ lấy phần mã, bỏ chữ mô tả đi kèm
    const m = x.match(/^([A-Z0-9][A-Z0-9-]{3,22})(?:\s|$)/i);
    if (m && /\d/.test(m[1])) ra.push({ hang, ma: m[1] });
  }
  return ra;
}

const NGUON = {
  js:      { brand: 'JS',      source: 'js:cross-reference', tra: traJs },
  mchanix: { brand: 'MCHANIX', source: 'mchanix:oe',         tra: traMchanix },
};

const chuan = (s) => s.replace(/[^A-Za-z0-9]/g, '').toUpperCase();

for (const [ten, n] of Object.entries(NGUON)) {
  if (CHI_HANG && CHI_HANG !== ten) continue;
  const { rows } = await pool.query(
    `SELECT id, internal_ref FROM catalog_products
     WHERE is_for_sale AND upper(brand) = $1 AND internal_ref IS NOT NULL ORDER BY internal_ref`, [n.brand]);
  console.log(`\n=== ${ten.toUpperCase()}: ${rows.length} SP ${NAP ? '(GHI DB)' : '(chạy thử, không ghi)'} ===`);

  // Nhiều SP cùng mã hãng (A1019, A1019-CC, A1019-NM) -> tra 1 lần, ghi cho cả nhóm
  const nhom = new Map();
  for (const r of rows) {
    const k = boDuoi(r.internal_ref);
    if (!nhom.has(k)) nhom.set(k, []);
    nhom.get(k).push(r);
  }

  let trung = 0, loi = 0, ghi = 0, tongMa = 0, stt = 0;
  for (const [ma, sps] of nhom) {
    stt++;
    try {
      const ds = await n.tra(ma);
      if (!ds) { console.log(`  [${stt}/${nhom.size}] ${ma} -> không có`); }
      else {
        const sach = ds.filter((x) => chuan(x.ma) && chuan(x.ma) !== chuan(ma));
        trung++; tongMa += sach.length;
        console.log(`  [${stt}/${nhom.size}] ${ma} -> ${sach.length} mã`);
        if (NAP) for (const sp of sps) for (const x of sach) {
          const r = await pool.query(
            `INSERT INTO catalog_oem_codes (product_id, oem_code, make, source) VALUES ($1,$2,$3,$4)
             ON CONFLICT (product_id, oem_code) DO NOTHING`, [sp.id, x.ma, x.hang || null, n.source]);
          ghi += r.rowCount;
        }
      }
    } catch (e) {
      loi++; console.log(`  [${stt}/${nhom.size}] ${ma} -> LỖI ${e.message.slice(0, 60)}`);
      if (e.message === 'BI_CHAN') { console.log(`  !!! ${ten} chặn IP — dừng nguồn này, chạy lại sau.`); break; }
    }
    await new Promise((r) => setTimeout(r, NGHI));
  }
  console.log(`>>> ${ten}: trúng ${trung}/${nhom.size} mã hãng (${rows.length} SP), ${tongMa} mã OEM, lỗi ${loi}` +
    (NAP ? `, đã ghi ${ghi} dòng` : ''));
}
await pool.end();
