// content.js v3.3 — trả về page title và CF status để background biết bị chặn không

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'PING')          { sendResponse({ ok: true }); return true; }
  if (msg.action === 'SCRAPE_LOCATE') { sendResponse(doLocate());   return true; }
  if (msg.action === 'SCRAPE_PICK')   { sendResponse(doPick());     return true; }
  if (msg.action === 'SCRAPE_VEHICLE'){ sendResponse(doVehicle());  return true; }
  if (msg.action === 'SCRAPE_UNIT')   { sendResponse(doUnit());     return true; }
});

// Kiểm tra Cloudflare chặn
function isCFBlocked() {
  const title = document.title.toLowerCase();
  const body  = document.body?.innerText?.toLowerCase() || '';
  return title.includes('just a moment') ||
         title.includes('checking your') ||
         title.includes('attention required') ||
         body.includes('enable javascript') ||
         body.includes('ray id') ||
         !!document.querySelector('#challenge-form, .cf-browser-verification, #cf-wrapper');
}

function pageTitle() { return document.title || ''; }

// ── 1. Locate ─────────────────────────────────────────────────────────────────
function doLocate() {
  const cf = isCFBlocked();
  const seen = new Set();
  const links = [];
  document.querySelectorAll('a[href*="/catalog/genuine/pick"]').forEach(a => {
    const href = a.getAttribute('href');
    const text = a.textContent.trim();
    if (!href || !text) return;
    const model = new URLSearchParams(href.split('?')[1] || '').get('model') || text;
    if (seen.has(model)) return;
    seen.add(model);
    links.push({ model_name: model, href: 'https://partsouq.com' + href });
  });
  return { ok: true, links, _cf_blocked: cf, _page_title: pageTitle() };
}

// ── 2. Pick ───────────────────────────────────────────────────────────────────
function doPick() {
  const cf = isCFBlocked();
  const MODEL_CODE_RE = /^[A-Z]{2,6}\d{2,3}[A-Z0-9]{1,4}-[A-Z0-9]{4,10}$/;
  const seen = new Set();
  const models = [];
  document.querySelectorAll('a[href*="/catalog/genuine/vehicle"]').forEach(a => {
    const href = a.getAttribute('href');
    if (!href) return;
    const ssd = new URLSearchParams(href.split('?')[1] || '').get('ssd') || href;
    if (seen.has(ssd)) return;
    seen.add(ssd);
    let modelCode = '', yearRange = '', specs = '';
    const row = a.closest('tr');
    if (row) {
      row.querySelectorAll('td').forEach(td => {
        const t = td.textContent.trim();
        if (MODEL_CODE_RE.test(t)) modelCode = t;
        else if (/\d{2}\.\d{4}\s*-/.test(t)) yearRange = t;
        else if (!specs && t.length > 5 && /^[A-Z]/.test(t)) specs = t.substring(0, 60);
      });
    }
    models.push({ model_code: modelCode, year_range: yearRange, specs,
                  href: 'https://partsouq.com' + href });
  });
  return { ok: true, models, _cf_blocked: cf, _page_title: pageTitle() };
}

// ── 3. Vehicle ────────────────────────────────────────────────────────────────
function doVehicle() {
  const cf = isCFBlocked();
  const SKIP = new Set(['categories', 'search', 'groups']);
  const tabs = [], seenTabs = new Set();
  document.querySelectorAll('a[href*="/catalog/genuine/vehicle"]').forEach(a => {
    const href = a.getAttribute('href');
    const text = a.textContent.trim();
    if (!href || !text || SKIP.has(text.toLowerCase()) || seenTabs.has(href)) return;
    seenTabs.add(href);
    tabs.push({ text, href: 'https://partsouq.com' + href });
  });

  const units = [], seenUnits = new Set();
  document.querySelectorAll('a[href*="/catalog/genuine/unit"]').forEach(a => {
    const href = a.getAttribute('href');
    let text = a.textContent.trim()
      || a.querySelector('img')?.alt
      || a.nextElementSibling?.textContent?.trim()
      || '';
    if (!href || seenUnits.has(href)) return;
    seenUnits.add(href);
    units.push({ text, href: 'https://partsouq.com' + href });
  });

  return { ok: true, tabs, units, _cf_blocked: cf, _page_title: pageTitle() };
}

// ── 4. Unit ───────────────────────────────────────────────────────────────────
function doUnit() {
  const cf = isCFBlocked();
  const PART_RE = /^\d{5}[A-Z0-9\-]{3,}$/;
  const parts = [];
  document.querySelectorAll('table tr').forEach((tr, idx) => {
    if (idx === 0) return;
    const cells = tr.querySelectorAll('td');
    if (cells.length < 2) return;
    const c = Array.from(cells).map(td => td.textContent.trim());
    if (!PART_RE.test(c[0])) return;
    parts.push({
      part_number: c[0], name: c[1] || '',
      code: c[2] || '', note: c[3] || '',
      qty:  c[4] || '1', range: c[5] || ''
    });
  });
  return { ok: true, parts, _cf_blocked: cf, _page_title: pageTitle(),
           unit_title: document.title.split('|')[0].trim() };
}
