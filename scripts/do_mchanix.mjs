/**
 * do_mchanix.mjs — ĐO tỉ lệ trúng của MChanix (catalog.mchanix.com).
 *
 *   node scripts/do_mchanix.mjs --file tmp_mau.txt [--luong 6]
 *
 * ⛔ KẾT QUẢ ĐO 2026-09-15: **0/400 mã** (200 Mazda + 200 Toyota ngẫu nhiên).
 *    MChanix là hãng cao su/chân máy nhỏ, catalog rất hẹp. Tra tay 3 mã thì
 *    trúng 2 (48609-0K040, 12361-0L030) nên thoạt nhìn tưởng khả quan — nhưng
 *    mẫu lớn cho thấy tỉ lệ thật < 0.25%. KHÔNG đáng xây crawler.
 *    Script giữ lại để đo lại nếu MChanix mở rộng catalog.
 *
 * KHÁC HẲN PartSouq/JNBK: MChanix KHÔNG cần Chrome. Mã OE tương đương nằm sẵn
 * trong HTML (chỉ bị CSS ẩn đi), nên fetch thuần là đủ — chạy song song với
 * worker PartSouq mà không tranh trình duyệt.
 *
 * Hai bước:
 *   1) /en/search/1?q=<mã>        -> mã MCHANIX + lgid (mã phiên, nằm trong HTML)
 *   2) /en/part/<mã>?lgid=...     -> khối "OE / Comparable Number"
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs';

const args = process.argv.slice(2);
const doc = (k, m) => { const i = args.indexOf('--' + k); return i !== -1 && args[i + 1] ? args[i + 1] : m; };

const FILE  = doc('file', 'tmp_mau_mchanix.txt');
const RA    = doc('ra', 'tmp_mchanix_kq.csv');
const SO    = RA + '.done';
const LUONG = Math.min(Math.max(parseInt(doc('luong', '6')), 1), 16);
const NGHI  = parseInt(doc('delay', '250'));
const UA    = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

const lay = (url) => fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) })
  .then((r) => (r.ok ? r.text() : ''));

/** Bóc khối "OE / Comparable Number" từ HTML trang chi tiết. */
function bocOe(html, maGoc) {
  // Khối nằm giữa tiêu đề "OE / Comparable Number" và mục kế tiếp ("Parts List")
  const i = html.indexOf('OE / Comparable Number');
  if (i === -1) return [];
  const j = html.indexOf('Parts List', i);
  const doan = html.slice(i, j > i ? j : i + 20000);

  // Mỗi mã nằm trong một thẻ riêng; hãng là dòng in hoa đứng trước nhóm mã
  const chuoi = doan.replace(/<[^>]+>/g, '\n').split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const ra = [];
  let hang = null;
  const chuanGoc = maGoc.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  for (const s of chuoi) {
    if (/^[A-Z][A-Z .&-]{2,24}$/.test(s) && !/\d/.test(s)) { hang = s; continue; }
    // mã: có chữ số, độ dài hợp lý, không phải câu chữ
    if (/\d/.test(s) && s.length >= 5 && s.length <= 24 && !/\s{2}|[<>]/.test(s)) {
      const chuan = s.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      if (chuan && chuan !== chuanGoc) ra.push({ hang, ma: s });
    }
  }
  // khử trùng
  const thay = new Set();
  return ra.filter((x) => !thay.has(x.ma) && thay.add(x.ma));
}

async function traMa(ma) {
  const s = await lay(`https://catalog.mchanix.com/en/search/1?q=${encodeURIComponent(ma)}&numbersearchinput=1&searchtype=0&status=1`);
  if (!s) return { thay: false };
  const link = s.match(/\.\.\/part\/([A-Za-z0-9-]+)\?ctx_q=[^"]*lgid=([A-Za-z0-9_-]+)/);
  if (!link) return { thay: false };
  const [, maMc, lgid] = link;

  const d = await lay(`https://catalog.mchanix.com/en/part/${maMc}?ctx_q=${encodeURIComponent(ma)}&lgid=${lgid}&abid=L73`);
  if (!d) return { thay: true, maMc, oe: [] };
  return { thay: true, maMc, oe: bocOe(d, ma) };
}

const dsMa = readFileSync(FILE, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
const daXong = new Set();
if (existsSync(SO)) for (const l of readFileSync(SO, 'utf8').split(/\r?\n/)) if (l.trim()) daXong.add(l.trim());
if (!existsSync(RA)) writeFileSync(RA, '"ma_goc","ma_mchanix","hang","ma_oe"\n', 'utf8');

const conLai = dsMa.filter((m) => !daXong.has(m));
console.log(`Đo MChanix: ${conLai.length} mã, ${LUONG} luồng (không cần Chrome)\n`);

const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
let viTri = 0, xong = 0, thay = 0, coOe = 0, tongOe = 0, loi = 0;

await Promise.all(Array.from({ length: LUONG }, async () => {
  while (true) {
    const i = viTri++;
    if (i >= conLai.length) break;
    const ma = conLai[i];
    try {
      const r = await traMa(ma);
      xong++;
      if (r.thay) {
        thay++;
        if (r.oe?.length) { coOe++; tongOe += r.oe.length;
          appendFileSync(RA, r.oe.map((o) => [ma, r.maMc, o.hang, o.ma].map(q).join(',')).join('\n') + '\n', 'utf8');
        }
      }
      appendFileSync(SO, ma + '\n', 'utf8');
      console.log(`  [${xong}/${conLai.length}] ${ma} → ${r.thay ? `${r.maMc} | ${r.oe?.length || 0} mã OE` : 'không thấy'}`);
    } catch (e) {
      loi++;
      console.error(`  [${xong}/${conLai.length}] ${ma} → LỖI: ${e.message.slice(0, 45)}`);
    }
    await new Promise((r) => setTimeout(r, NGHI));
  }
}));

console.log(`\n=== KẾT QUẢ MCHANIX trên ${xong} mã ===`);
console.log(`Tìm thấy sản phẩm  : ${thay} (${(100 * thay / (xong || 1)).toFixed(1)}%)`);
console.log(`CÓ MÃ OE tương đương: ${coOe} (${(100 * coOe / (xong || 1)).toFixed(1)}%)`);
console.log(`Tổng mã OE thu     : ${tongOe}`);
console.log(`Trung bình khi trúng: ${coOe ? (tongOe / coOe).toFixed(1) : 0}`);
console.log(`Lỗi                : ${loi}`);
console.log(`-> ${RA}`);
