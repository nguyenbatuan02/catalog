/**
 * worker_xe.mjs — Worker cào XE TƯƠNG THÍCH theo mã OEM (Nhóm 2 Product.xlsx).
 *
 * Khác worker_substitutes.mjs: cái kia đọc khối "Substitutions", cái này bấm
 * nút "What cars it fits?" rồi đọc bảng xe trong modal.
 *
 * Chuẩn bị máy (giống worker_substitutes):
 *   npm i playwright
 *   chrome.exe --remote-debugging-port=9222     (vào partsouq.com 1 lần cho qua Cloudflare)
 *
 * Chạy:
 *   node worker_xe.mjs --server http://161.248.80.33:3001 --worker-id may-1
 */

import { chromium } from 'playwright';

const args = process.argv.slice(2);
const getArg = (k, d) => {
  const i = args.indexOf('--' + k);
  return i !== -1 && args[i + 1] ? args[i + 1] : d;
};

const SERVER   = getArg('server', 'http://localhost:3001').replace(/\/$/, '');
const WORKER   = getArg('worker-id', `xe-${Math.random().toString(36).slice(2, 7)}`);
const CDP      = getArg('cdp', 'http://localhost:9222');
const BATCH    = parseInt(getArg('batch', '20'));
const DELAY    = parseInt(getArg('delay', '1800'));
const API      = `${SERVER}/api/v1/catalog/crawl/xe`;

console.log('====================================================');
console.log(' WORKER CÀO XE TƯƠNG THÍCH THEO MÃ OEM - PARTSOUQ');
console.log('====================================================');
console.log(` Worker ID : ${WORKER}`);
console.log(` Server API: ${SERVER}`);
console.log(` Chrome CDP: ${CDP}`);
console.log(` Lô claim  : ${BATCH} mã/lần\n`);

const br = await chromium.connectOverCDP(CDP).catch(() => {
  console.error(`[LỖI] Không nối được Chrome tại ${CDP}.`);
  console.error('Mở Chrome bằng: chrome.exe --remote-debugging-port=9222');
  process.exit(1);
});
const ctx = br.contexts()[0] || await br.newContext();
const page = await ctx.newPage();

const BI_CHAN = /just a moment|attention required|checking your browser|verify you are human|cf-challenge|captcha/i;

/** Bóc bảng xe trong modal compatibility. Chạy TRONG browser. */
function bocModal() {
  const m = document.querySelector('.modal-content');
  if (!m) return [];
  const tieuDe = m.querySelector('h4, .modal-title')?.textContent || '';
  const make = tieuDe.match(/Toyota|Lexus|Nissan|Mitsubishi|Mazda|Hyundai|Kia|Honda|Suzuki|Isuzu|Ford/i)?.[0] || null;

  const tenTab = [...m.querySelectorAll('ul.nav-tabs li a, ul.nav-pills li a')]
    .map((t) => t.textContent.trim());

  const ra = [];
  [...m.querySelectorAll('.tab-pane')].forEach((pane, i) => {
    const modelName = tenTab[i] || '';
    pane.querySelectorAll('table tbody tr').forEach((tr) => {
      const td = [...tr.querySelectorAll('td')].map((x) => x.textContent.trim());
      if (td.length >= 3) {
        ra.push({ make, modelName, market: td[0], year: td[1],
                  modelCode: td[2], engine: td[3] || null, trans: td[4] || null });
      }
    });
  });
  return ra;
}

async function caoXe(ma) {
  // Bỏ hậu tố nội bộ (-NM, -CC, -K...) để tìm đúng mã gốc trên PartSouq
  const maTim = ma.replace(/-[A-Z0-9]{1,4}$/i, '');
  await page.goto(`https://partsouq.com/en/search/all?q=${encodeURIComponent(maTim)}`,
    { waitUntil: 'domcontentloaded', timeout: 30000 });

  for (let i = 0; i < 15; i++) {
    if (!BI_CHAN.test(await page.title())) break;
    await page.waitForTimeout(1500);
  }
  if (BI_CHAN.test(await page.title())) throw new Error('CAPTCHA_BLOCKED');

  await page.waitForTimeout(1000);

  const coNut = await page.evaluate(() => {
    const el = document.querySelector('a.compatibility-car');
    if (!el) return false;
    el.click();
    return true;
  });
  if (!coNut) return [];

  await page.waitForTimeout(2500);
  return page.evaluate(bocModal);
}

const nop = (body) => fetch(`${API}/submit`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ worker_id: WORKER, ...body }),
}).then((r) => r.json()).catch((e) => ({ error: e.message }));

let chay = true;
process.on('SIGINT', async () => {
  chay = false;
  await page.close().catch(() => {});
  br.close();
  process.exit(0);
});

let tongXe = 0, tongSp = 0;

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
    for (let i = 0; i < lo.items.length && chay; i++) {
      const ma = lo.items[i].oem_code;
      try {
        const xe = await caoXe(ma);
        const kq = await nop({ oem_code: ma, vehicles: xe });
        tongXe += kq.vehicles || 0;
        tongSp += kq.products_loaded || 0;
        console.log(`  [${i + 1}/${lo.items.length}] ${ma} -> ${xe.length} xe` +
          (kq.products_loaded ? ` | nạp ${kq.products_loaded} SP, ${kq.fitments} fitment` : ''));
      } catch (e) {
        console.error(`  [${i + 1}/${lo.items.length}] ${ma} -> LỖI: ${e.message}`);
        if (e.message === 'CAPTCHA_BLOCKED') {
          console.warn('\n[CẢNH BÁO] Dính CAPTCHA — vào cửa sổ Chrome giải giúp.');
          await nop({ oem_code: ma, error: 'CAPTCHA_BLOCKED' });
          await new Promise((r) => setTimeout(r, 15000));
        }
      }
      await page.waitForTimeout(DELAY);
    }
    console.log(`  (cộng dồn: ${tongSp} sản phẩm đã nạp, ${tongXe} xe)`);
  } catch (e) {
    console.error('[Worker loop]', e.message);
    await new Promise((r) => setTimeout(r, 5000));
  }
}
