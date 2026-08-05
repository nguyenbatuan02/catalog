const DB_NAME = 'partsouq_v3';
const DB_VER  = 1;

function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('parts')) {
        const s = db.createObjectStore('parts', { keyPath: 'key' });
        s.createIndex('make_model', ['make', 'model_name'], { unique: false });
      }
      if (!db.objectStoreNames.contains('models')) {
        db.createObjectStore('models', { keyPath: 'key' });
      }
    };
    r.onsuccess = e => res(e.target.result);
    r.onerror   = e => rej(e.target.error);
  });
}

async function dbPut(store, obj) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(obj);
    tx.oncomplete = () => res(true);
    tx.onerror    = e  => rej(e.target.error);
  });
}

async function dbGetAll(store) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const r = db.transaction(store, 'readonly').objectStore(store).getAll();
    r.onsuccess = e => res(e.target.result);
    r.onerror   = e => rej(e.target.error);
  });
}

async function dbCount(store) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const r = db.transaction(store, 'readonly').objectStore(store).count();
    r.onsuccess = e => res(e.target.result);
    r.onerror   = e => rej(e.target.error);
  });
}

async function dbClear(store) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).clear();
    tx.oncomplete = () => res(true);
    tx.onerror    = e  => rej(e.target.error);
  });
}
// background.js — Service Worker PartSouq Scraper v3
// Luồng thực tế: locate → pick → vehicle (3 tabs) → unit → scrape parts


// ── State ─────────────────────────────────────────────────────────────────────
let ST = {
  running: false,
  make: '', modelFilter: '',
  phase: '',        // locate | pick | vehicle | unit
  totalModels: 0,   // tổng model code
  doneModels: 0,    // đã xong
  totalUnits: 0,    // tổng unit cần scrape
  doneUnits: 0,
  partsCount: 0,
  log: [],
  error: ''
};

function log(msg) {
  const t = new Date().toLocaleTimeString('vi-VN');
  const line = `[${t}] ${msg}`;
  ST.log.push(line);
  if (ST.log.length > 300) ST.log.shift();
  chrome.runtime.sendMessage({ action: 'LOG', msg: line }).catch(() => {});
}

function broadcast() {
  chrome.runtime.sendMessage({ action: 'STATUS', state: { ...ST } }).catch(() => {});
  // Lưu vào storage để popup đọc kể cả khi vừa mở
  chrome.storage.local.set({ scraperState: { ...ST, log: ST.log.slice(-50) } }).catch(() => {});
}

// ── Messages từ popup ─────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'START')      { startCrawl(msg).then(r => sendResponse(r)); return true; }
  if (msg.action === 'STOP')       { ST.running = false; log('⏹ Dừng'); broadcast(); sendResponse({ ok: true }); return true; }
  if (msg.action === 'GET_STATUS') { sendResponse({ state: { ...ST } }); return true; }
  if (msg.action === 'GET_DATA')   { getData().then(r => sendResponse(r)); return true; }
  if (msg.action === 'CLEAR')      { clearAll().then(() => sendResponse({ ok: true })); return true; }
});

// ── Luồng chính ───────────────────────────────────────────────────────────────
async function startCrawl({ make, modelFilter }) {
  if (ST.running) return { ok: false, error: 'Đang chạy' };

  ST = {
    running: true, make, modelFilter: (modelFilter || '').toLowerCase().trim(),
    phase: 'locate', totalLines: 0, totalModels: 0, doneModels: 0,
    totalUnits: 0, doneUnits: 0, partsCount: 0,
    log: [], error: ''
  };

  log(`🚀 Bắt đầu: ${make}${ST.modelFilter ? ' · lọc: ' + ST.modelFilter : ''}`);
  broadcast();

  try {
    // ── BƯỚC 1: Lấy danh sách dòng xe từ trang locate ─────────────────────────
    ST.phase = 'locate';
    const locateUrl = `https://partsouq.com/en/catalog/genuine/locate?c=${encodeURIComponent(make)}`;
    log(`📂 Locate: ${locateUrl}`);
    const locateLinks = await openAndScrape(locateUrl, 'SCRAPE_LOCATE', 'links');

    if (!locateLinks.length) throw new Error('Không tìm thấy dòng xe nào. Kiểm tra tên hãng.');
    log(`✅ Tìm được ${locateLinks.length} dòng xe`);

    // Lọc theo modelFilter — so sánh linh hoạt: bỏ ký tự đặc biệt, space
    const filtered = ST.modelFilter
      ? locateLinks.filter(l => {
          const name = l.model_name.toLowerCase().replace(/[^a-z0-9]/g, '');
          const filter = ST.modelFilter.replace(/[^a-z0-9]/g, '');
          return name.includes(filter) || filter.includes(name.substring(0, filter.length));
        })
      : locateLinks;

    ST.totalLines = filtered.length;
    log(`🔍 Sẽ tra: ${filtered.length} dòng xe`);
    if (!filtered.length) throw new Error('Không có dòng xe nào khớp với filter "' + ST.modelFilter + '"');

    // ── BƯỚC 2: Từng dòng xe → lấy model codes từ trang pick ──────────────────
    ST.phase = 'pick';
    let allModelCodes = [];

    for (let i = 0; i < filtered.length; i++) {
      if (!ST.running) break;
      const line = filtered[i];
      log(`[${i+1}/${filtered.length}] 🚗 Pick: ${line.model_name}`);

      const codes = await openAndScrape(line.href, 'SCRAPE_PICK', 'models');
      codes.forEach(c => { c.model_line = line.model_name; });
      allModelCodes.push(...codes);

      // Lưu model vào DB
      for (const c of codes) {
        await dbPut('models', {
          key: `${make}_${line.model_name}_${c.model_code || c.href}`,
          make, model_line: line.model_name,
          model_code: c.model_code,
          year_range: c.year_range,
          specs: c.specs,
          href: c.href
        });
      }

      log(`   → ${codes.length} model code`);
      await sleepRandom(1800);
    }

    ST.totalModels = allModelCodes.length;
    log(`📊 Tổng: ${allModelCodes.length} model codes`);
    broadcast();

    if (!allModelCodes.length) throw new Error('Không lấy được model code nào từ trang pick');

    // ── BƯỚC 3: Từng model code → vehicle page → lấy tất cả unit links ────────
    ST.phase = 'vehicle';
    let allUnitJobs = []; // [{unit_href, unit_text, make, model_line, model_code}]

    for (let i = 0; i < allModelCodes.length; i++) {
      if (!ST.running) break;
      ST.doneModels = i;
      const mc = allModelCodes[i];
      log(`[${i+1}/${allModelCodes.length}] 🔧 Vehicle: ${mc.model_code || mc.model_line}`);
      broadcast();

      // Lấy tabs + units của tab đầu (Power Train/Chassis mặc định)
      const v = await openAndScrapeRaw(mc.href, 'SCRAPE_VEHICLE');
      const { tabs = [], units = [] } = v;

      if (units.length === 0 && tabs.length === 0) {
        // Kiểm tra xem có phải Cloudflare chặn không
        const cfBlocked = v._cf_blocked || false;
        const pageTitle = v._page_title || '';
        if (cfBlocked) {
          log(`   ⛔ CLOUDFLARE CHẶN: ${mc.model_code}`);
        } else if (pageTitle.toLowerCase().includes('just a moment') || pageTitle.toLowerCase().includes('checking')) {
          log(`   ⛔ CLOUDFLARE VERIFY: ${mc.model_code} - "${pageTitle}"`);
        } else {
          log(`   ⚠️ 0 units - title: "${pageTitle}" - có thể trang trống hoặc bị chặn`);
        }
      } else {
        log(`   ✅ ${tabs.length} tabs, ${units.length} units`);
      }

      // Thêm units của tab hiện tại
      for (const u of units) {
        allUnitJobs.push({ ...u, make, model_line: mc.model_line, model_code: mc.model_code });
      }

      // Duyệt qua tab 2 và 3 (Body/Interior, Electrical) để lấy thêm units
      for (const tab of tabs.slice(1)) {
        if (!ST.running) break;
        const vt = await openAndScrapeRaw(tab.href, 'SCRAPE_VEHICLE');
        for (const u of (vt.units || [])) {
          allUnitJobs.push({ ...u, make, model_line: mc.model_line, model_code: mc.model_code });
        }
        await sleepRandom(1200);
      }

      await sleepRandom(1800);
    }

    // Dedup unit jobs theo href
    const seenUnits = new Set();
    allUnitJobs = allUnitJobs.filter(j => {
      if (seenUnits.has(j.href)) return false;
      seenUnits.add(j.href); return true;
    });

    ST.totalUnits = allUnitJobs.length;
    log(`📦 Tổng unit cần scrape: ${allUnitJobs.length}`);
    broadcast();

    // ── BƯỚC 4: Từng unit → scrape part numbers ────────────────────────────────
    ST.phase = 'unit';

    for (let i = 0; i < allUnitJobs.length; i++) {
      if (!ST.running) break;
      ST.doneUnits = i;
      const job = allUnitJobs[i];

      if (i % 10 === 0) log(`[${i+1}/${allUnitJobs.length}] 🔩 ${job.text}`);
      broadcast();

      const r = await openAndScrapeRaw(job.href, 'SCRAPE_UNIT');
      const { parts = [], unit_title = '' } = r;

      for (const p of parts) {
        await dbPut('parts', {
          key: `${job.make}_${job.model_code || job.model_line}_${p.part_number}_${job.text}`,
          make: job.make,
          model_line: job.model_line,
          model_code: job.model_code || '',
          unit: job.text || unit_title,
          part_number: p.part_number,
          name: p.name,
          code: p.code,
          note: p.note,
          qty: p.qty,
          range: p.range
        });
        ST.partsCount++;
      }

      await sleepRandom(1200);
    }

    ST.doneModels = allModelCodes.length;
    ST.doneUnits  = allUnitJobs.length;
    ST.running    = false;
    log(`🏁 XONG! ${ST.partsCount} phụ tùng từ ${allUnitJobs.length} unit`);
    broadcast();
    return { ok: true };

  } catch (err) {
    ST.running = false;
    ST.error   = err.message;
    log(`❌ ${err.message}`);
    broadcast();
    return { ok: false, error: err.message };
  }
}

// ── Mở tab, scrape, đóng tab — trả về 1 field cụ thể ─────────────────────────
async function openAndScrape(url, action, field, retries = 2) {
  const r = await openAndScrapeRaw(url, action, retries);
  return r[field] || [];
}

let scrapeWindowId = null;

async function getScrapeWindow() {
  // Tạo hoặc tái dùng window nhỏ góc màn hình để scrape
  if (scrapeWindowId) {
    try {
      await chrome.windows.get(scrapeWindowId);
      return scrapeWindowId;
    } catch { scrapeWindowId = null; }
  }
  const win = await chrome.windows.create({
    url: 'about:blank',
    width: 800, height: 600,
    left: 0, top: 0,
    focused: false,
    type: 'normal'
  });
  scrapeWindowId = win.id;
  return scrapeWindowId;
}

async function openAndScrapeRaw(url, action, retries = 3) {
  let tab;
  try {
    const windowId = await getScrapeWindow();
    tab = await chrome.tabs.create({ url, active: true, windowId });
    await waitTabLoad(tab.id, 30000);
    await sleepRandom(1800);
    await ensureContentScript(tab.id);

    // Poll từ background mỗi 1s cho đến khi content script trả về data
    // Tránh timeout message channel khi content script đang poll lâu
    const result = await pollForResult(tab.id, action);
    await chrome.tabs.remove(tab.id).catch(() => {});
    if (!result?.ok) throw new Error(result?.error || `${action} failed`);
    return result;

  } catch (err) {
    if (tab) await chrome.tabs.remove(tab.id).catch(() => {});
    if (retries > 0) {
      log(`   ↩️ Retry: ${url.split('?')[0]}`);
      await sleepRandom(2500);
      return openAndScrapeRaw(url, action, retries - 1);
    }
    throw err;
  }
}

// Poll gửi message đến content script cho đến khi nhận được kết quả có data
async function pollForResult(tabId, action) {
  let lastTitle = '';

  while (true) {
    try {
      const result = await sendMessageWithTimeout(tabId, { action }, 5000);

      if (result?.ok) {
        const title = result._page_title || '';
        const cf    = result._cf_blocked || false;

        // Bị Cloudflare chặn → đợi vô thời hạn cho đến khi qua
        if (cf) {
          if (title !== lastTitle) {
            log(`   ☁️ Cloudflare chặn — đợi tự động qua...`);
            lastTitle = title;
          }
          await sleep(2000);
          continue; // poll lại liên tục không giới hạn
        }

        // Qua CF rồi — kiểm tra có data không
        if (title !== lastTitle && title) {
          log(`   ✔️ Qua Cloudflare: "${title.substring(0,50)}"`);
          lastTitle = title;
        }

        const hasData =
          (action === 'SCRAPE_LOCATE' && result.links?.length > 0) ||
          (action === 'SCRAPE_PICK'   && result.models?.length > 0) ||
          (action === 'SCRAPE_VEHICLE' && result.units?.length > 0) ||
          (action === 'SCRAPE_UNIT'   && result.parts?.length > 0);

        if (hasData) return result;

        // Trang load xong, có title PartSouq nhưng không có data → thực sự trống
        if (title.toLowerCase().includes('partsouq') || title.toLowerCase().includes('toyota')) {
          return result;
        }
      }
    } catch { /* tab chưa sẵn sàng, thử lại */ }
    await sleep(1000);
  }

  // Không bao giờ tới đây vì loop vô thời hạn khi CF chặn
  // Chỉ thoát khi có data hoặc trang trống xác nhận
  try { return await sendMessageWithTimeout(tabId, { action }, 3000); }
  catch { return { ok: true, links: [], models: [], tabs: [], units: [], parts: [] }; }
}

// sendMessage với timeout cụ thể
function sendMessageWithTimeout(tabId, msg, timeout) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Message timeout')), timeout);
    chrome.tabs.sendMessage(tabId, msg, (response) => {
      clearTimeout(t);
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });
}

function waitTabLoad(tabId, timeout = 25000) {
  return new Promise(resolve => {
    const t = setTimeout(resolve, timeout);
    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(t);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function ensureContentScript(tabId) {
  for (let i = 0; i < 3; i++) {
    try {
      await chrome.tabs.sendMessage(tabId, { action: 'PING' });
      return;
    } catch {
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      } catch { /* ignore */ }
      await sleepRandom(800);
    }
  }
}

async function getData() {
  const models = await dbGetAll('models');
  const parts  = await dbGetAll('parts');
  return { ok: true, models, parts };
}

async function clearAll() {
  await dbClear('models');
  await dbClear('parts');
  ST.partsCount = 0;
  ST.totalModels = 0;
  ST.doneModels = 0;
  ST.totalUnits = 0;
  ST.doneUnits = 0;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Random delay giống người dùng thật: base ± 30%
function sleepRandom(baseMs) {
  const jitter = baseMs * 0.3;
  const ms = baseMs + (Math.random() * jitter * 2 - jitter);
  return sleep(Math.round(ms));
}
