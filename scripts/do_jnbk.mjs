/**
 * do_jnbk.mjs — ĐO tỉ lệ trúng của JNBK (nibk-brakes.com) trước khi xây crawler.
 *
 *   node scripts/do_jnbk.mjs --file tmp_mau_phanh.txt [--tabs 3]
 *
 * ⚠ KẾT QUẢ ĐO 2026-09-15 trên 119 mã phanh: **3 mã có dữ liệu thật (2.5%)**
 *    nhưng thu được 159 mã chéo — trung bình **53 mã/lần trúng**, gấp 100 lần
 *    PartSouq (0.51). DB có 16,139 SP nhóm phanh → ước ~21,000 mã chéo, ~2 giờ.
 *    ĐÁNG LÀM nhưng phạm vi hẹp (chỉ má phanh/đĩa phanh) và cần Chrome nên
 *    giành tài nguyên với worker PartSouq — làm SAU khi PartSouq xong.
 *
 * ⚠ BỘ BÓC CÒN LỖI: trang "No Product found" vẫn bị đếm là tìm thấy (script
 *    báo 8/119, thật ra 3). Phải sửa hàm bocJnbk trước khi dùng số liệu.
 *
 * JNBK KHÁC PartSouq ở chỗ cho ra nhiều hơn hẳn: 1 lần tra trả về cả danh sách
 * "Cross Reference" (mã OEM của nhiều hãng + BENDIX/FMSI/KASHIYAMA/WVA) kèm
 * thông số kích thước và bảng xe tương thích.
 *
 * Phải dùng Chrome: form submit bằng JavaScript, POST thuần bằng curl không qua
 * (đã thử, trả về đúng trang gốc 55110 byte).
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs';

const args = process.argv.slice(2);
const doc = (k, m) => { const i = args.indexOf('--' + k); return i !== -1 && args[i + 1] ? args[i + 1] : m; };

const FILE = doc('file', 'tmp_mau_phanh.txt');
const RA   = doc('ra', 'tmp_jnbk_kq.csv');
const SO   = RA + '.done';
const CDP  = doc('cdp', 'http://127.0.0.1:9222');
const TABS = Math.min(Math.max(parseInt(doc('tabs', '3')), 1), 6);
const NGHI = parseInt(doc('delay', '800'));

/** Bóc trang chi tiết JNBK. Chạy TRONG browser. */
function bocJnbk() {
  const chu = (el) => el?.textContent.trim().replace(/\s+/g, ' ') || '';
  const t = document.body.innerText;

  // "Search Result for (TOYOTA - 04465-0K380) Returns ... (NiBK - PN1803)"
  const kq = t.match(/Search Result for\s*\(([^)]+)\)[^(]*\(NiBK\s*-\s*([^)]+)\)/i);
  const maNibk = kq ? kq[2].trim() : null;

  // Khối Cross Reference: các cặp (hãng, mã) nằm kề nhau
  const cheo = [];
  const kh = [...document.querySelectorAll('*')]
    .find((e) => /^Cross Reference$/i.test(e.textContent.trim()) && e.children.length === 0);
  if (kh) {
    let n = kh.parentElement;
    for (let i = 0; i < 4 && n; i++, n = n.parentElement) {
      const o = [...n.querySelectorAll('td, li, span, div')].map(chu).filter(Boolean);
      for (let j = 0; j < o.length - 1; j++) {
        // hãng = chữ in hoa/khoảng trắng; mã = có chữ số
        if (/^[A-Z][A-Z .&-]{1,24}$/.test(o[j]) && /\d/.test(o[j + 1]) && o[j + 1].length <= 24) {
          cheo.push({ hang: o[j], ma: o[j + 1] });
        }
      }
      if (cheo.length) break;
    }
  }

  // Bảng xe tương thích: dòng có năm dạng 01.15~07.20
  const xe = [...document.querySelectorAll('table tr')]
    .map((tr) => [...tr.querySelectorAll('td')].map(chu))
    .filter((c) => c.length >= 4 && /\d{2}\.\d{2}/.test(c[0]));

  return {
    maNibk,
    soCheo: cheo.length,
    cheo: cheo.slice(0, 40),
    soXe: xe.length,
    khongThay: /no\s*(result|record)|not\s*found/i.test(t) && !maNibk,
  };
}

const dsMa = readFileSync(FILE, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
const daXong = new Set();
if (existsSync(SO)) for (const l of readFileSync(SO, 'utf8').split(/\r?\n/)) if (l.trim()) daXong.add(l.trim());
if (!existsSync(RA)) writeFileSync(RA, '"ma_goc","ma_nibk","hang_cheo","ma_cheo"\n', 'utf8');

const conLai = dsMa.filter((m) => !daXong.has(m));
console.log(`Đo JNBK: ${conLai.length} mã, ${TABS} tab\n`);

const br = await chromium.connectOverCDP(CDP).catch(() => {
  console.error(`Không nối được Chrome ${CDP}`); process.exit(1);
});
const ctx = br.contexts()[0] || await br.newContext();
for (const t of ctx.pages().slice(1)) if (/jnbk-brakes/i.test(t.url())) await t.close().catch(() => {});

const tabs = [];
for (let i = 0; i < TABS; i++) tabs.push(await ctx.newPage());
const dongTab = async () => { for (const t of tabs) await t.close().catch(() => {}); };
process.on('SIGINT', async () => { await dongTab(); br.close(); process.exit(0); });

const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
let viTri = 0, xong = 0, thay = 0, tongCheo = 0, tongXe = 0, loi = 0, dung = false;

await Promise.all(tabs.map(async (tab) => {
  while (!dung) {
    const i = viTri++;
    if (i >= conLai.length) break;
    const ma = conLai[i];
    try {
      await tab.goto('https://www.jnbk-brakes.com/catalogue/cars',
        { waitUntil: 'domcontentloaded', timeout: 30000 });
      await tab.waitForTimeout(600);
      // form.submit() điều hướng NGAY -> evaluate đang chạy sẽ mất ngữ cảnh.
      // Phải đợi điều hướng xong rồi mới bóc trang.
      await Promise.all([
        tab.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {}),
        tab.evaluate((m) => {
          const inp = document.querySelector('input[name=txtPartNo]');
          inp.value = m;
          inp.closest('form').submit();
        }, ma).catch(() => {}),
      ]);
      await tab.waitForTimeout(1800);

      const r = await tab.evaluate(bocJnbk);
      xong++;
      if (r.maNibk) {
        thay++; tongCheo += r.soCheo; tongXe += r.soXe;
        if (r.cheo.length) {
          appendFileSync(RA, r.cheo.map((c) => [ma, r.maNibk, c.hang, c.ma].map(q).join(',')).join('\n') + '\n', 'utf8');
        }
      }
      appendFileSync(SO, ma + '\n', 'utf8');
      console.log(`  [${xong}/${conLai.length}] ${ma} → ${r.maNibk ? `${r.maNibk} | ${r.soCheo} mã chéo | ${r.soXe} xe` : 'không thấy'}`);
    } catch (e) {
      loi++;
      console.error(`  [${xong}/${conLai.length}] ${ma} → LỖI: ${e.message.slice(0, 50)}`);
      if (/has been closed|Page crashed|ERR_INSUFFICIENT/i.test(e.message)) { dung = true; break; }
    }
    await tab.waitForTimeout(NGHI);
  }
}));

await dongTab(); br.close();
console.log(`\n=== KẾT QUẢ JNBK trên ${xong} mã ===`);
console.log(`Tìm thấy sản phẩm   : ${thay} (${(100 * thay / (xong || 1)).toFixed(1)}%)`);
console.log(`Tổng mã chéo thu    : ${tongCheo}`);
console.log(`Trung bình mã/lần   : ${thay ? (tongCheo / thay).toFixed(1) : 0}`);
console.log(`Tổng dòng xe        : ${tongXe}`);
console.log(`Lỗi                 : ${loi}`);
console.log(`-> ${RA}`);
