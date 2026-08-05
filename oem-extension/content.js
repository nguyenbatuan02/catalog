// content.js — chạy trên PartSouq /search?q=<mã OEM>. Đợi Cloudflare → fetch modal compatibility → PUSH 1 message.
//
// CẤU TRÚC THẬT (đã xác nhận 2026-07-18):
//   Trang /search: card .compatibility-car[data-make][data-product_id]. Danh sách xe KHÔNG ở trang search
//   mà lấy qua AJAX: GET /instant/compatibility?id=<product_id> → HTML modal:
//     tab  ul.nav-pills li a         → text = model_line (FORTUNER SUV, HILUX, LAND CRUISER...)
//     pane .tab-content .tab-pane    → table tbody tr, cột: td1=Region, td2=Year, td3=Model code, td4=Engine, td5=Trans
//   Chỉ fetch CARD ĐẦU TIÊN (nhiều card = nhiều seller cùng mã → compatibility giống nhau).

(function () {
  if (window.__oemCrawlerRan) return;          // tránh chạy 2 lần nếu bị inject lại
  window.__oemCrawlerRan = true;

  const Q = new URLSearchParams(location.search).get('q') || '';

  // ── Cloudflare ────────────────────────────────────────────────────────────
  function isCFBlocked() {
    const title = (document.title || '').toLowerCase();
    const body  = (document.body?.innerText || '').toLowerCase();
    return title.includes('just a moment') ||
           title.includes('checking your') ||
           title.includes('attention required') ||
           body.includes('enable javascript and cookies') ||
           !!document.querySelector('#challenge-form, .cf-browser-verification, #cf-wrapper, iframe[src*="challenges.cloudflare.com"]');
  }
  async function waitForCF() {
    for (let i = 0; i < 15; i++) {                 // tối đa ~30s (15 × 2s)
      if (!isCFBlocked()) return true;
      await new Promise(r => setTimeout(r, 2000));
    }
    return !isCFBlocked();
  }

  function parseYears(text) {                        // "2024" → {2024,2024}; "2013-2018" → {2013,2018}
    if (!text) return { year_from: null, year_to: null };
    const ys = []; const re = /(?:\d{1,2}[.\/])?(\d{4})/g; let m;
    while ((m = re.exec(text))) { const y = parseInt(m[1], 10); if (y >= 1950 && y <= 2100) ys.push(y); }
    if (!ys.length) return { year_from: null, year_to: null };
    return { year_from: Math.min(...ys), year_to: Math.max(...ys) };
  }
  function isNoResult() {
    const t = (document.body?.innerText || '').toLowerCase();
    return /no\s+results?|0\s+results?|not\s+found|nothing\s+found|không\s+tìm|no matches/.test(t);
  }

  // ── Parse HTML modal /instant/compatibility → mảng xe ───────────────────────
  function parseCompatibility(html, make) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const tabs  = doc.querySelectorAll('.nav-pills li a, .nav-tabs li a');
    const panes = doc.querySelectorAll('.tab-content .tab-pane');
    // map id-của-pane (từ href="#id") → tên model_line (bền hơn so-khớp theo index)
    const tabById = {};
    tabs.forEach(a => { const h = a.getAttribute('href') || ''; if (h.startsWith('#')) tabById[h.slice(1)] = a.textContent.trim(); });

    const vehicles = [], seen = new Set();
    const addRow = (tr, model_line) => {
      const tds = tr.querySelectorAll('td');
      if (tds.length < 3) return;
      const model_code = (tds[2]?.textContent || '').trim();
      if (!model_code) return;
      const { year_from, year_to } = parseYears((tds[1]?.textContent || '').trim());
      if (year_from == null) return;                 // yêu cầu có năm (bỏ dòng không năm)
      // dedup theo model_code+năm: giữ ĐỦ mọi năm để server LEAST/GREATEST nới range (không gộp mất năm)
      const key = (make + '|' + model_code + '|' + year_from + '|' + year_to).toLowerCase();
      if (seen.has(key)) return; seen.add(key);
      vehicles.push({ make, model_name: model_line || '', model_code, year_from, year_to });
    };

    if (panes.length) {
      panes.forEach((pane, i) => {
        const model_line = tabById[pane.id] || tabs[i]?.textContent?.trim() || '';
        (pane.querySelector('table') || pane).querySelectorAll('tbody tr').forEach(tr => addRow(tr, model_line));
      });
    } else {
      // fallback: modal không dùng tab-pane → quét mọi table
      doc.querySelectorAll('table').forEach((table, i) => {
        const model_line = tabs[i]?.textContent?.trim() || '';
        table.querySelectorAll('tbody tr').forEach(tr => addRow(tr, model_line));
      });
    }
    return vehicles;
  }

  function send(extra) {
    const payload = Object.assign({ type: 'OEM_RESULT', oem_code: Q, vehicles: [], no_result: false, cf_blocked: false }, extra);
    try { chrome.runtime.sendMessage(payload); } catch (e) { /* background chưa sẵn sàng — watchdog sẽ lo */ }
  }

  // ── Main ────────────────────────────────────────────────────────────────────
  async function main() {
    if (!(await waitForCF())) return send({ cf_blocked: true });
    await new Promise(r => setTimeout(r, 600));      // đợi JS render card
    if (isNoResult()) return send({ no_result: true });

    const card = document.querySelector('.compatibility-car[data-product_id]') || document.querySelector('.compatibility-car');
    if (!card) return send({ no_result: true });
    const make = (card.dataset.make || card.getAttribute('data-make') || '').trim();
    const pid  = (card.dataset.product_id || card.getAttribute('data-product_id') || '').trim();
    if (!pid) return send({ no_result: true });

    let html = '';
    try {
      const res = await fetch(`/instant/compatibility?id=${encodeURIComponent(pid)}`, { credentials: 'include' });
      if (!res.ok) return send({ error: `HTTP ${res.status} @ compatibility` });
      html = await res.text();
    } catch (e) { return send({ error: String(e && e.message || e) }); }

    let vehicles = [];
    try { vehicles = parseCompatibility(html, make); } catch (e) { return send({ error: 'parse: ' + String(e && e.message || e) }); }
    send({ vehicles, no_result: vehicles.length === 0 });
  }

  main();
})();
