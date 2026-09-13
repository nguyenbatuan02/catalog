/**
 * worker_substitutes.mjs
 * Client chạy trên các máy khác nhau để cào mã thay thế (Substitutes) từ PartSouq.
 *
 * Yêu cầu máy chạy:
 *   1. Node.js >= 18
 *   2. Cài playwright: npm i playwright
 *   3. Mở Chrome với remote debugging:
 *      chrome.exe --remote-debugging-port=9222
 *      (Đã vào partsouq.com 1 lần cho qua Cloudflare)
 *
 * Chạy worker:
 *   node worker_substitutes.mjs --server http://103.214.9.97:3001 --worker-id may-van-phong-1
 */

import { chromium } from 'playwright';

const args = process.argv.slice(2);
function getArg(key, def) {
  const i = args.indexOf('--' + key);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
}

const SERVER_URL = getArg('server', 'http://localhost:3001').replace(/\/$/, '');
const WORKER_ID  = getArg('worker-id', `worker-${Math.random().toString(36).substring(2, 7)}`);
const CDP_URL    = getArg('cdp', 'http://localhost:9222');
const BATCH_SIZE = parseInt(getArg('batch', '20'));
const DELAY_MS   = parseInt(getArg('delay', '600'));
// Nhiều tab cùng cào. Phần lớn thời gian mỗi mã là NGỒI CHỜ MẠNG, lúc đó máy
// rảnh — mở thêm tab gần như không tốn gì. Đo thật: 1 tab 2435ms/mã,
// 4 tab 851ms/mã (nhanh 2.9 lần), không dính captcha.
const SO_TAB     = Math.min(Math.max(parseInt(getArg('tabs', '4')), 1), 8);

console.log(`====================================================`);
console.log(` WORKER CÀO MÃ THAY THẾ (SUBSTITUTES) - PARTSOUQ`);
console.log(`====================================================`);
console.log(` Worker ID : ${WORKER_ID}`);
console.log(` Server API: ${SERVER_URL}`);
console.log(` Chrome CDP: ${CDP_URL}`);
console.log(` Lô claim  : ${BATCH_SIZE} mã/lần`);
console.log(` Số tab    : ${SO_TAB} (chạy song song)`);
console.log(` Nghỉ/mã   : ${DELAY_MS} ms\n`);

// 1. Nối Chrome CDP
const br = await chromium.connectOverCDP(CDP_URL).catch(() => {
  console.error(`[LỖI] Không thể nối tới Chrome tại ${CDP_URL}.`);
  console.error(`Hãy mở Chrome bằng lệnh:`);
  console.error(`  chrome.exe --remote-debugging-port=9222`);
  process.exit(1);
});

const ctx = br.contexts()[0] || await br.newContext();

// Dọn tab PartSouq còn sót của lần chạy trước. Worker chết đột ngột thì không
// kịp đóng tab; chạy lại vài vòng là tích tụ hàng chục tab, Chrome cạn bộ nhớ
// và ném ERR_INSUFFICIENT_RESOURCES. Giữ lại tab đầu (thường là trang người
// dùng đang mở), chỉ đóng tab partsouq.
for (const t of ctx.pages().slice(1)) {
  if (/partsouq\.com/i.test(t.url())) await t.close().catch(() => {});
}

const cacTab = [];
for (let i = 0; i < SO_TAB; i++) cacTab.push(await ctx.newPage());

// Đóng tab khi thoát — kể cả thoát vì lỗi, không chỉ Ctrl+C.
const dongTab = async () => {
  for (const t of cacTab) await t.close().catch(() => {});
};
process.on('exit', () => { for (const t of cacTab) t.close().catch(() => {}); });
process.on('uncaughtException', async (e) => {
  console.error('[Lỗi không bắt được]', e.message);
  await dongTab();
  process.exit(1);
});

// Hàm bóc DOM trên PartSouq
function parseSubstitutesDOM() {
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

  const h3 = [...document.querySelectorAll('h3')].find(h => /substitution/i.test(h.textContent));
  const tatCa = [...document.querySelectorAll('.search-product-card')];
  const sau = h3 ? tatCa.filter(c => h3.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING) : [];
  return sau.map(doc);
}

const BI_CHAN = /just a moment|attention required|checking your browser|verify you are human|cf-challenge|captcha/i;

// Trình duyệt đã chết — mọi mã sau đó đều lỗi theo, phải dừng lô ngay.
const TRINH_DUYET_CHET = /has been closed|Page crashed|ERR_INSUFFICIENT_RESOURCES/i;

async function scrapeOne(page, ma) {
  await page.goto(`https://partsouq.com/en/search/all?q=${encodeURIComponent(ma)}`, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });

  // Đợi Cloudflare nếu có
  for (let i = 0; i < 15; i++) {
    const title = await page.title();
    if (!BI_CHAN.test(title)) break;
    await page.waitForTimeout(1500);
  }

  if (BI_CHAN.test(await page.title())) {
    throw new Error('CAPTCHA_BLOCKED');
  }

  await page.waitForTimeout(1000);
  if (/nothing found/i.test(await page.content())) {
    return [];
  }

  return page.evaluate(parseSubstitutesDOM);
}

// Vòng lặp chính của Worker
let running = true;
process.on('SIGINT', async () => {
  console.log('\nĐang dừng worker...');
  running = false;
  await dongTab();
  br.close();
  process.exit(0);
});

const nopKetQua = (body) => fetch(`${SERVER_URL}/api/v1/catalog/crawl/substitutes/submit`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ worker_id: WORKER_ID, ...body }),
}).catch(() => {});

while (running) {
  try {
    // 1. Xin việc từ Server
    const claimRes = await fetch(`${SERVER_URL}/api/v1/catalog/crawl/substitutes/claim?worker_id=${encodeURIComponent(WORKER_ID)}&limit=${BATCH_SIZE}`);
    if (!claimRes.ok) {
      console.error(`[Server ${claimRes.status}] Lỗi claim việc, thử lại sau 10s...`);
      await new Promise(r => setTimeout(r, 10000));
      continue;
    }

    const batch = await claimRes.json();
    if (!batch.items || batch.items.length === 0) {
      console.log(`[Hết việc] Server hiện không còn mã nào cần cào. Đợi 30s kiểm tra lại...`);
      await new Promise(r => setTimeout(r, 30000));
      continue;
    }

    console.log(`\nNhận lô mới: ${batch.items.length} mã từ Server`);

    // 2. Chia lô cho các tab, mỗi tab tự rút mã tiếp theo khi làm xong.
    //    Rút từ hàng đợi chung (chứ không chia đều trước) để tab nào gặp mã
    //    nhanh thì làm được nhiều hơn, không phải ngồi chờ tab chậm.
    let viTri = 0, xong = 0;
    await Promise.all(cacTab.map(async (tab) => {
      while (running) {
        const i = viTri++;
        if (i >= batch.items.length) break;
        const ma = batch.items[i].ma_goc;

        try {
          const subs = await scrapeOne(tab, ma);
          xong++;
          console.log(`  [${xong}/${batch.items.length}] ${ma} -> ${subs.length} mã thay thế`);
          await nopKetQua({ ma_goc: ma, substitutes: subs });
        } catch (err) {
          console.error(`  [${xong}/${batch.items.length}] ${ma} -> LỖI: ${err.message}`);
          // PHẢI báo server MỌI lỗi, không riêng captcha. Bỏ qua im lặng thì mã
          // đó treo ở 'claimed' mãi: worker vẫn xin lô mới liên tục nên tích tụ
          // rất nhanh (đã gặp: 1 worker giữ 50,157 mã, hàng đợi gần như đứng).
          // Server tự phân biệt lỗi phía worker (trả lại hàng đợi) với lỗi thật.
          await nopKetQua({ ma_goc: ma, error: err.message.slice(0, 200) });
          if (err.message === 'CAPTCHA_BLOCKED') {
            console.warn(`\n[CẢNH BÁO] Trình duyệt đang bị dính CAPTCHA! Hãy vào cửa sổ Chrome giải captcha.`);
            await new Promise((r) => setTimeout(r, 15000));
          }
          // Trình duyệt chết thì mọi mã sau đều lỗi theo — dừng lô, để vòng
          // ngoài khởi động lại, khỏi đốt cả lô 40 mã trong vài giây.
          if (TRINH_DUYET_CHET.test(err.message)) {
            console.error('\n[DỪNG] Trình duyệt đã đóng/sập — thoát để khởi động lại.');
            running = false;
            break;
          }
        }

        await tab.waitForTimeout(DELAY_MS);
      }
    }));

  } catch (loopErr) {
    console.error(`[Worker loop] Lỗi ngoại lệ:`, loopErr.message);
    await new Promise(r => setTimeout(r, 5000));
  }
}
