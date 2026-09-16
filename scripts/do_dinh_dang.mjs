/**
 * do_dinh_dang.mjs — ĐO tỉ lệ trúng của một tập mã, chạy nhiều tab.
 *
 * Dùng khi cần biết "định dạng mã này có đáng cào không" TRƯỚC khi nạp hàng
 * trăm nghìn mã vào hàng đợi. cao_thay_the.mjs chỉ chạy 1 tab nên đo 400 mã
 * mất ~15 phút; bản này 4 tab còn ~4 phút.
 *
 *   node scripts/do_dinh_dang.mjs --file tmp_mau400.txt [--tabs 4] [--ra kq.csv]
 *
 * Sổ .done ghi MỌI mã đã đo (kể cả 0 kết quả) nên dừng giữa chừng chạy lại được.
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs';

const args = process.argv.slice(2);
const doc = (k, m) => { const i = args.indexOf('--' + k); return i !== -1 && args[i + 1] ? args[i + 1] : m; };

const FILE  = doc('file', 'tmp_mau400.txt');
const RA    = doc('ra', FILE.replace(/\.[^.]+$/, '') + '_kq.csv');
const SO    = RA + '.done';
const CDP   = doc('cdp', 'http://127.0.0.1:9222');
const TABS  = Math.min(Math.max(parseInt(doc('tabs', '4')), 1), 8);
const NGHI  = parseInt(doc('delay', '700'));

const BI_CHAN = /just a moment|attention required|checking your browser|verify you are human|cf-challenge|captcha/i;
const CHET    = /has been closed|Page crashed|ERR_INSUFFICIENT_RESOURCES/i;

/** Bóc khối Substitutions. Chạy TRONG browser. */
function boc() {
  const g = (c, nhan) => {
    const l = [...c.querySelectorAll('.search-product-card-info-label')]
      .find((x) => new RegExp(nhan, 'i').test(x.textContent));
    return l?.parentElement.querySelector('.search-product-card-info-value')?.textContent.trim() || null;
  };
  const h3 = [...document.querySelectorAll('h3')].find((h) => /substitution/i.test(h.textContent));
  const tatCa = [...document.querySelectorAll('.search-product-card')];
  const sau = h3 ? tatCa.filter((c) => h3.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING) : [];
  return {
    khongThay: /nothing found/i.test(document.body.innerText),
    soCard: tatCa.length,
    the: sau.map((c) => ({ so: g(c, 'part number'), make: g(c, 'make'), ten: c.querySelector('.part-col-list-h4')?.textContent.trim() || null })),
  };
}

const dsMa = readFileSync(FILE, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
const daXong = new Set();
if (existsSync(SO)) {
  for (const l of readFileSync(SO, 'utf8').split(/\r?\n/)) if (l.trim()) daXong.add(l.trim());
  console.log(`tiếp tục: đã đo ${daXong.size} mã trước đó`);
}
if (!existsSync(RA)) writeFileSync(RA, '"ma_goc","ma_the","make","ten"\n', 'utf8');

const conLai = dsMa.filter((m) => !daXong.has(m));
console.log(`Đo ${conLai.length} mã, ${TABS} tab, nghỉ ${NGHI}ms\n`);

const br = await chromium.connectOverCDP(CDP).catch(() => {
  console.error(`Không nối được Chrome tại ${CDP}. Mở bằng: chrome.exe --remote-debugging-port=9222`);
  process.exit(1);
});
const ctx = br.contexts()[0] || await br.newContext();
// Dọn tab sót của lần trước, nếu không Chrome tích tụ tab đến cạn bộ nhớ.
for (const t of ctx.pages().slice(1)) if (/partsouq\.com/i.test(t.url())) await t.close().catch(() => {});

const tabs = [];
for (let i = 0; i < TABS; i++) tabs.push(await ctx.newPage());
const dongTab = async () => { for (const t of tabs) await t.close().catch(() => {}); };
process.on('SIGINT', async () => { await dongTab(); br.close(); process.exit(0); });

const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
let viTri = 0, xong = 0, coHang = 0, trong = 0, coThe = 0, tongThe = 0, loi = 0, dung = false;

await Promise.all(tabs.map(async (tab) => {
  while (!dung) {
    const i = viTri++;
    if (i >= conLai.length) break;
    const ma = conLai[i];
    try {
      await tab.goto(`https://partsouq.com/en/search/all?q=${encodeURIComponent(ma)}`,
        { waitUntil: 'domcontentloaded', timeout: 30000 });
      for (let k = 0; k < 12 && BI_CHAN.test(await tab.title()); k++) await tab.waitForTimeout(1500);
      if (BI_CHAN.test(await tab.title())) throw new Error('CAPTCHA_BLOCKED');
      await tab.waitForTimeout(900);

      const r = await tab.evaluate(boc);
      xong++;
      if (r.khongThay) trong++; else coHang++;
      if (r.the.length) { coThe++; tongThe += r.the.length; }
      appendFileSync(SO, ma + '\n', 'utf8');
      if (r.the.length) {
        appendFileSync(RA, r.the.map((x) => [ma, x.so, x.make, x.ten].map(q).join(',')).join('\n') + '\n', 'utf8');
      }
      console.log(`  [${xong}/${conLai.length}] ${ma} → ${r.khongThay ? 'không thấy' : r.soCard + ' card'} | ${r.the.length} mã thế`);
    } catch (e) {
      loi++;
      console.error(`  [${xong}/${conLai.length}] ${ma} → LỖI: ${e.message.slice(0, 50)}`);
      if (CHET.test(e.message)) { console.error('\n[DỪNG] trình duyệt đã đóng/sập'); dung = true; break; }
    }
    await tab.waitForTimeout(NGHI);
  }
}));

await dongTab();
br.close();

const daDo = xong + daXong.size;
console.log(`\n=== KẾT QUẢ trên ${xong} mã đo lần này (tổng đã đo ${daDo}) ===`);
console.log(`Có hàng trên PartSouq : ${coHang} (${(100 * coHang / (xong || 1)).toFixed(1)}%)`);
console.log(`Không tìm thấy        : ${trong}`);
console.log(`CÓ MÃ THAY THẾ        : ${coThe} (${(100 * coThe / (xong || 1)).toFixed(1)}%)`);
console.log(`Tổng mã thế thu được  : ${tongThe}`);
console.log(`Lỗi                   : ${loi}`);
console.log(`-> ${RA}`);
