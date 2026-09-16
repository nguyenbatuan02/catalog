/**
 * worker_jnbk.mjs — Worker cào mã chéo từ JNBK/NiBK (nibk-brakes.com).
 *
 * Chuẩn bị máy (giống worker_substitutes):
 *   npm i playwright
 *   chrome.exe --remote-debugging-port=9222 --user-data-dir=C:\chrome-cao
 *
 * Chạy:
 *   node worker_jnbk.mjs --server http://161.248.80.33:3001 --worker-id may-1
 *
 * VÌ SAO CẦN CHROME: form tìm kiếm submit bằng JavaScript. Đã thử POST thuần
 * bằng curl kèm cookie phiên + Referer — server vẫn trả đúng trang gốc
 * (55,110 byte), không ra kết quả. Trang chi tiết thì GET thẳng được, nhưng
 * URL cần cả id nội bộ lẫn mã NiBK nên không duyệt tuần tự được.
 *
 * KHÁC PartSouq: JNBK chỉ có má phanh/guốc phanh/đĩa phanh (phạm vi hẹp),
 * nhưng mỗi lần trúng cho ~53 mã chéo — gấp 100 lần PartSouq (0.51 mã/lần).
 */
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const doc = (k, m) => { const i = args.indexOf('--' + k); return i !== -1 && args[i + 1] ? args[i + 1] : m; };

const SERVER = doc('server', 'http://localhost:3001').replace(/\/$/, '');
const WORKER = doc('worker-id', `jnbk-${Math.random().toString(36).slice(2, 7)}`);
const CDP    = doc('cdp', 'http://127.0.0.1:9222');
const BATCH  = parseInt(doc('batch', '20'));
const TABS   = Math.min(Math.max(parseInt(doc('tabs', '3')), 1), 6);
const NGHI   = parseInt(doc('delay', '800'));
const API    = `${SERVER}/api/v1/catalog/crawl/jnbk`;

console.log('====================================================');
console.log(' WORKER CÀO MÃ CHÉO - JNBK / NiBK (má phanh)');
console.log('====================================================');
console.log(` Worker ID : ${WORKER}`);
console.log(` Server API: ${SERVER}`);
console.log(` Số tab    : ${TABS}\n`);

const TRINH_DUYET_CHET = /has been closed|Page crashed|ERR_INSUFFICIENT_RESOURCES/i;

/** Bóc trang chi tiết JNBK. Chạy TRONG browser. */
function bocJnbk() {
  const t = document.body.innerText;

  // Trang "không tìm thấy" vẫn có form nên dễ bị đếm nhầm là tìm thấy.
  // Phải kiểm tra TRƯỚC mọi thứ khác.
  if (/No Product found for search term/i.test(t)) return { thay: false };

  const kq = t.match(/Search Result for\s*\(([^)]+)\)[^(]*\(NiBK\s*-\s*([^)]+)\)/i);
  const maNibk = kq ? kq[2].trim() : null;
  if (!maNibk) return { thay: false };

  // Cấu trúc thật: .detail__plate > .detail__body .str > .owner + .field
  const cheo = [];
  const tieuDe = [...document.querySelectorAll('p.box-title')]
    .find((e) => /Cross Reference/i.test(e.textContent));
  const khoi = tieuDe?.closest('.detail__head')?.parentElement;
  if (khoi) {
    khoi.querySelectorAll('.str').forEach((s) => {
      const hang = s.querySelector('.owner')?.textContent.trim();
      const ma   = s.querySelector('.field')?.textContent.trim();
      if (hang && ma) cheo.push({ hang, ma });
    });
  }

  // Bảng xe tương thích: dòng có năm dạng 01.15~07.20
  const xe = [...document.querySelectorAll('table tr')]
    .map((tr) => [...tr.querySelectorAll('td')].map((c) => c.textContent.trim().replace(/\s+/g, ' ')))
    .filter((c) => c.length >= 4 && /\d{2}\.\d{2}/.test(c[0]))
    .slice(0, 200);

  return { thay: true, maNibk, cheo, soXe: xe.length };
}

const br = await chromium.connectOverCDP(CDP).catch(() => {
  console.error(`[LỖI] Không nối được Chrome tại ${CDP}.`);
  console.error('Mở bằng: chrome.exe --remote-debugging-port=9222 --user-data-dir=C:\\chrome-cao');
  process.exit(1);
});
const ctx = br.contexts()[0] || await br.newContext();
// Dọn tab sót của lần trước — không dọn thì Chrome tích tụ tab đến cạn bộ nhớ.
// Gồm cả tab cloudflare/recaptcha: worker bị giết đột ngột thì mã đóng tab
// không kịp chạy, mà tab challenge mới là loại tích tụ nhiều nhất.
const TAB_RAC = /jnbk-brakes|challenges\.cloudflare\.com|recaptcha/i;
for (const t of ctx.pages().slice(1)) if (TAB_RAC.test(t.url())) await t.close().catch(() => {});

const tabs = [];
for (let i = 0; i < TABS; i++) tabs.push(await ctx.newPage());
const dongTab = async () => { for (const t of tabs) await t.close().catch(() => {}); };
process.on('SIGINT', async () => { chay = false; await dongTab(); br.close(); process.exit(0); });
process.on('exit', () => { for (const t of tabs) t.close().catch(() => {}); });

const nop = (body) => fetch(`${API}/submit`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ worker_id: WORKER, ...body }),
}).then((r) => r.json()).catch((e) => ({ error: e.message }));

let chay = true, tongCheo = 0, tongTrung = 0;

while (chay) {
  try {
    const res = await fetch(`${API}/claim?worker_id=${encodeURIComponent(WORKER)}&limit=${BATCH}`);
    if (!res.ok) {
      console.error(`[Server ${res.status}] lỗi claim, thử lại sau 10s`);
      await new Promise((r) => setTimeout(r, 10000));
      continue;
    }
    const lo = await res.json();
    if (!lo.items?.length) {
      console.log('[Hết việc] không còn mã nào. Đợi 30s...');
      await new Promise((r) => setTimeout(r, 30000));
      continue;
    }

    console.log(`\nNhận lô mới: ${lo.items.length} mã`);
    let viTri = 0, xong = 0;

    await Promise.all(tabs.map(async (tab) => {
      while (chay) {
        const i = viTri++;
        if (i >= lo.items.length) break;
        const ma = lo.items[i].ma_goc;
        try {
          await tab.goto('https://www.jnbk-brakes.com/catalogue/cars',
            { waitUntil: 'domcontentloaded', timeout: 30000 });
          await tab.waitForTimeout(500);
          // form.submit() điều hướng NGAY -> phải đợi xong rồi mới bóc,
          // không thì evaluate mất ngữ cảnh.
          await Promise.all([
            tab.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {}),
            tab.evaluate((m) => {
              const inp = document.querySelector('input[name=txtPartNo]');
              inp.value = m;
              inp.closest('form').submit();
            }, ma).catch(() => {}),
          ]);
          await tab.waitForTimeout(1600);

          const r = await tab.evaluate(bocJnbk);
          xong++;
          if (r.thay) { tongTrung++; tongCheo += r.cheo?.length || 0; }
          console.log(`  [${xong}/${lo.items.length}] ${ma} → ` +
            (r.thay ? `${r.maNibk} | ${r.cheo.length} mã chéo | ${r.soXe} xe` : 'không có'));
          await nop({ ma_goc: ma, ma_nibk: r.maNibk || null, cheo: r.cheo || [] });
        } catch (e) {
          console.error(`  [${xong}/${lo.items.length}] ${ma} → LỖI: ${e.message.slice(0, 50)}`);
          await nop({ ma_goc: ma, error: e.message.slice(0, 200) });
          if (TRINH_DUYET_CHET.test(e.message)) {
            console.error('\n[DỪNG] trình duyệt đã đóng/sập — thoát để khởi động lại.');
            chay = false; break;
          }
        }
        await tab.waitForTimeout(NGHI);
      }
    }));
    console.log(`  (cộng dồn: ${tongTrung} mã trúng, ${tongCheo} mã chéo)`);
  } catch (e) {
    console.error('[Worker loop]', e.message);
    await new Promise((r) => setTimeout(r, 5000));
  }
}

await dongTab(); br.close();
