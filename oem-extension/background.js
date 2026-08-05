// background.js — Service Worker "PartSouq OEM Crawler"
// Luồng: CSV mã OEM → mở tab /search?q=<mã đã làm sạch> (ẩn) → content.js scrape xe → gửi API import-by-oem.
// Xử lý 1 mã / lần (tuần tự, có delay) để tránh Cloudflare. RESUME được: state + tiến độ lưu IndexedDB.

importScripts('db.js');   // openOemDB / oemDbGet / oemDbSet / oemDbDelete / oemDbClear

// ── Hằng số ───────────────────────────────────────────────────────────────────
const DEFAULT_API   = 'http://103.214.9.97:3001/api/v1/catalog';
const DEFAULT_DELAY = 2000;
const KEEPALIVE_ALARM = 'oem_keepalive';
const WATCHDOG_ALARM  = 'oem_watchdog';
const KEEPALIVE_MIN = 0.4;     // ~24s: giữ SW sống + là bộ RESUME chính
const WATCHDOG_MIN  = 1.5;     // 90s: 1 mã chờ tối đa (CF ~30s + scrape + đệm). DÙNG ALARM (sống sót khi SW bị kill,
                               //      KHÔNG dùng setTimeout — setTimeout mất khi SW chết → gây double-fire).

// ── Trạng thái (in-memory, mirror sang chrome.storage.local + IndexedDB) ───────
let ST = {
  running: false, api_base: DEFAULT_API, delay: DEFAULT_DELAY,
  total: 0, current_index: 0,
  done: 0, no_result: 0, cf_blocked: 0, errors: 0,   // 4 rổ kết quả (tách riêng cho dashboard)
  found: 0,                                          // found = tổng fitment đã import
  current_oem: '', current_clean: '', current_found: 0,
  log: [],
};
let OEM_LIST = [];        // danh sách mã (nạp từ CSV) — cache để không đọc IndexedDB mỗi bước
// currentTabId = "đang xử lý 1 mã" (tab mở, chờ content.js / watchdog). Đây là CỜ IN-FLIGHT DUY NHẤT
//   để không mở 2 tab. OPENING chặn double trong lúc CHỜ chrome.tabs.create (giữa các await).
let currentTabId = null;
let OPENING = false;
let createFailStreak = 0;        // số lần tabs.create lỗi liên tiếp (SW bị kill) — cap để không kẹt 1 mã
const MAX_CREATE_FAIL = 5;       // >= ngưỡng này → coi là lỗi thật, bỏ mã, đi tiếp

// ── Tiện ích log + broadcast ──────────────────────────────────────────────────
function log(msg) {
  const line = `[${clock()}] ${msg}`;
  ST.log.push(line);
  if (ST.log.length > 200) ST.log = ST.log.slice(-200);
  try { chrome.runtime.sendMessage({ action: 'LOG', msg: line }); } catch {}
}
function clock() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
// Payload PHẲNG cho dashboard (GET_STATS / STATS_UPDATE). ST của mình phẳng (KHÔNG lồng state.stats),
// nên map trực tiếp; fitments = found (tổng fitment đã import).
function statsPayload() {
  return {
    type: 'STATS_UPDATE',
    total: ST.total || 0,
    current_index: ST.current_index || 0,
    done: ST.done || 0,
    no_result: ST.no_result || 0,
    cf_blocked: ST.cf_blocked || 0,
    errors: ST.errors || 0,
    fitments: ST.found || 0,
    current_oem: ST.current_oem || '',
    running: ST.running || false,
  };
}
function broadcast() {
  // .catch: khi KHÔNG có popup/dashboard mở, sendMessage reject "no receiving end" (bất đồng bộ) → nuốt cho sạch.
  try { chrome.runtime.sendMessage({ action: 'STATUS', state: { ...ST } }).catch(() => {}); } catch {}  // bản GET_STATUS
  try { chrome.runtime.sendMessage(statsPayload()).catch(() => {}); } catch {}                            // bản STATS_UPDATE
  try { chrome.storage.local.set({ oem_state: { ...ST } }); } catch {}
}
async function saveState() {
  ST.updated_at = Date.now();
  try { await oemDbSet('state', { ...ST, log: ST.log.slice(-50) }); } catch {}
  broadcast();
}

// ── Làm sạch mã OEM: bỏ suffix nội bộ (-NM, -CC, -K, -B, -GB, -WTA, /STD, /025...) ─────
// Chỉ dùng để TẠO URL search; MÃ GỐC vẫn được gửi lên API (khớp product trong DB).
const INTERNAL_SUFFIX = /[-\/\s](NM|CC|TEST|KG|HD|GB|STD|PD|WTA|PBK|BLK|K|B|025)$/i;
function cleanOem(raw) {
  let s = String(raw || '').trim().toUpperCase();
  for (let i = 0; i < 3; i++) {                 // lột tối đa 3 lớp suffix
    const m = s.match(INTERNAL_SUFFIX);
    if (!m) break;
    const cand = s.slice(0, m.index).replace(/[-\/\s]+$/, '');
    // Giữ an toàn: phần còn lại phải vẫn giống 1 mã OEM (có chữ số, đủ dài) mới cắt.
    if (cand.length >= 6 && /\d/.test(cand)) s = cand; else break;
  }
  return s.trim();
}

// ── Gọi API import-by-oem (gửi MÃ GỐC + danh sách xe) ─────────────────────────
async function sendFitment(oem_code, vehicles) {
  const res = await fetch(`${ST.api_base}/fitments/import-by-oem`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ oem_code, vehicles }),
  });
  if (!res.ok) {
    let d = ''; try { d = (await res.json())?.error || ''; } catch {}
    throw new Error(`HTTP ${res.status}${d ? ' — ' + d : ''}`);
  }
  return res.json();
}

// ── Vòng xử lý (in-flight = currentTabId; watchdog + resume = chrome.alarms) ────
async function processCurrent() {
  if (!ST.running) return;
  if (currentTabId != null || OPENING) return;        // đã có tab in-flight / đang mở → KHÔNG mở thêm
  if (ST.current_index >= OEM_LIST.length) return finishAll();

  const rawItem = OEM_LIST[ST.current_index];
  // Chấp nhận CẢ string lẫn object {oem|oem_code} (phòng CSV/queue chứa object).
  const original = (typeof rawItem === 'string' ? rawItem : (rawItem?.oem || rawItem?.oem_code || '')).trim();
  if (!original) {                                     // mã RỖNG → bỏ qua (tránh q rỗng)
    console.warn('[OEM] Mã RỖNG tại index', ST.current_index, '(item=', JSON.stringify(rawItem), ') → bỏ qua');
    log(`⚠️ Mã rỗng tại #${ST.current_index + 1} — bỏ qua`);
    return advance();
  }
  let clean = cleanOem(original);
  if (!clean) clean = original;                        // GUARD: không bao giờ search với q rỗng
  ST.current_oem = original; ST.current_clean = clean; ST.current_found = 0;

  // Đã xử lý rồi (resume / chạy lại) → bỏ qua, sang mã kế.
  const results = (await oemDbGet('results')) || { map: {} };
  if (results.map[original]) return advance();
  // sau await: một resume khác có thể đã mở tab → re-check để không double.
  if (!ST.running || currentTabId != null || OPENING) return;

  const url = `https://www.partsouq.com/en/search/all?q=${encodeURIComponent(clean)}`;
  console.log(`[OEM] [${ST.current_index + 1}/${OEM_LIST.length}] raw=${JSON.stringify(original)} clean=${JSON.stringify(clean)} → ${url}`);
  log(`🔎 [${ST.current_index + 1}/${ST.total}] ${original}` + (clean !== original ? ` (search: ${clean})` : ''));
  broadcast();

  OPENING = true;                                      // chặn double trong lúc chờ tabs.create
  try {
    const tab = await chrome.tabs.create({ url, active: false });
    currentTabId = tab.id;
    createFailStreak = 0;               // mở tab OK → reset đếm lỗi
  } catch (e) {
    // Chrome vừa KILL service worker → tabs.create ném "No SW". KHÔNG advance/retry (sẽ churn cả queue).
    // Dừng IM LẶNG; keepAlive alarm / resumeIfNeeded chạy lại CHÍNH MÃ NÀY (current_index KHÔNG đổi).
    OPENING = false; currentTabId = null;
    console.warn('[OEM] chrome.tabs.create lỗi (SW bị kill?):', e.message, '→ dừng, chờ alarm resume');
    createFailStreak++;
    if (createFailStreak >= MAX_CREATE_FAIL) {         // lỗi DAI DẲNG (không phải SW death) → bỏ mã, đi tiếp
      console.error('[OEM] tabs.create lỗi', createFailStreak, 'lần liên tiếp → bỏ mã', ST.current_oem);
      createFailStreak = 0;
      return recordResult({ error: true });
    }
    await saveState();
    return;
  }
  OPENING = false;
  await armWatchdog();                    // chỉ chạy khi mở tab OK
}

function advance() {
  // bỏ qua mã đã xử lý/rỗng — chỉ tiến index (không tính done/errors)
  ST.current_index++;
  saveState();
  if (ST.current_index >= OEM_LIST.length) return finishAll();
  setTimeout(processCurrent, 0);          // keepAlive backstop nếu bị mất
}

// Watchdog = ALARM (SỐNG SÓT khi SW bị kill; setTimeout thì KHÔNG → gây double-fire). Đặt lại mỗi mã.
async function armWatchdog() {
  try { await chrome.alarms.create(WATCHDOG_ALARM, { delayInMinutes: WATCHDOG_MIN }); } catch {}
}
async function clearWatchdog() {
  try { await chrome.alarms.clear(WATCHDOG_ALARM); } catch {}
}

// Kết thúc 1 mã (từ content.js result HOẶC watchdog). IDEMPOTENT qua currentTabId:
//   đường nào chạy trước đóng tab (currentTabId=null); đường sau thấy null → thoát, KHÔNG advance 2 lần.
async function onOemDone(outcome) {
  if (currentTabId == null) return;       // đã finalize bởi đường khác → bỏ
  await clearWatchdog();
  try { await chrome.tabs.remove(currentTabId); } catch {}
  currentTabId = null;
  return recordResult(outcome);
}

// Ghi kết quả + cập nhật số + tiến index + hẹn mã kế. (createFail gọi thẳng — không có tab để đóng.)
async function recordResult({ imported = 0, vehicles = 0, error = false, cf = false, no_result = false }) {
  const results = (await oemDbGet('results')) || { map: {} };
  results.map[ST.current_oem] = { imported, vehicles, error, cf, no_result, ts: Date.now() };
  try { await oemDbSet('results', results); } catch {}
  // 4 rổ TÁCH RIÊNG: lỗi / CF chặn / không có xe / có xe (+cộng fitment). processed = tổng cả 4.
  if (error) ST.errors++;
  else if (cf) ST.cf_blocked++;
  else if (no_result || vehicles === 0) ST.no_result++;
  else { ST.done++; ST.found += imported; }
  ST.current_index++;
  await saveState();
  if (!ST.running) return;
  if (ST.current_index >= OEM_LIST.length) return finishAll();
  setTimeout(processCurrent, Math.max(0, ST.delay | 0));   // DELAY giữa các mã (keepAlive backstop nếu mất)
}

function finishAll() {
  ST.running = false;
  clearWatchdog();
  stopKeepAlive();
  log(`🏁 XONG — ${ST.done} có xe · ${ST.no_result} không · ${ST.errors} lỗi · ${ST.cf_blocked} CF · ${ST.found} fitment`);
  saveState();
}

// ── Nhận kết quả từ content.js (push khi scrape xong / CF / no result) ─────────
async function handleResult(msg, senderTabId) {
  // chỉ chấp nhận từ đúng tab đang xử lý (chống nhiễu tab khác)
  if (senderTabId !== currentTabId) return;
  if (msg.cf_blocked) { log(`🛑 Cloudflare chặn ${ST.current_oem}`); return onOemDone({ cf: true }); }
  if (msg.error)      { log(`⚠️ ${ST.current_oem} scrape lỗi: ${msg.error}`); return onOemDone({ error: true }); }

  const vehicles = Array.isArray(msg.vehicles) ? msg.vehicles : [];
  if (msg.no_result || vehicles.length === 0) { log(`○ ${ST.current_oem}: không thấy xe`); return onOemDone({ no_result: true }); }

  ST.current_found = vehicles.length; broadcast();
  try {
    const r = await sendFitment(ST.current_oem, vehicles);   // GỬI MÃ GỐC
    const note = r.product_found === false ? ' (⚠ chưa có product trong DB)' : '';
    log(`✅ ${ST.current_oem}: ${vehicles.length} xe → +${r.imported || 0} fitment${note}`);
    onOemDone({ imported: r.imported || 0, vehicles: vehicles.length });
  } catch (e) {
    log(`⚠️ ${ST.current_oem} gửi API lỗi: ${e.message}`);
    onOemDone({ error: true });
  }
}

// ── Điều khiển: nạp CSV / start / stop / clear ────────────────────────────────
async function loadCsv(oem_list, api_base, delay) {
  const rawCount = (oem_list || []).length;
  // Chuẩn hóa: chấp nhận string HOẶC object {oem|oem_code}, bỏ BOM, trim, bỏ rỗng, dedup giữ thứ tự.
  OEM_LIST = (oem_list || [])
    .map(x => (typeof x === 'string' ? x : (x?.oem || x?.oem_code || '')))
    .map(s => String(s || '').replace(/^﻿/, '').trim())
    .filter(Boolean);
  const seen = new Set(); OEM_LIST = OEM_LIST.filter(x => (seen.has(x) ? false : seen.add(x)));
  if (api_base) ST.api_base = api_base.trim();
  if (delay != null) ST.delay = Math.max(0, parseInt(delay) || DEFAULT_DELAY);
  ST.total = OEM_LIST.length; ST.current_index = 0;
  ST.done = 0; ST.no_result = 0; ST.cf_blocked = 0; ST.errors = 0; ST.found = 0;
  ST.current_oem = ''; ST.current_found = 0;
  await oemDbSet('oem_list', { list: OEM_LIST });
  await oemDbSet('results', { map: {} });
  await saveState();
  console.log(`[OEM] loadCsv: nhận ${rawCount} → hợp lệ ${OEM_LIST.length}. 3 mã đầu:`, OEM_LIST.slice(0, 3));
  log(`📋 Nạp ${OEM_LIST.length} mã OEM${rawCount !== OEM_LIST.length ? ` (bỏ ${rawCount - OEM_LIST.length} dòng rỗng/trùng)` : ''}`);
}

async function startRun() {
  if (!OEM_LIST.length) { const s = await oemDbGet('oem_list'); OEM_LIST = s?.list || []; ST.total = OEM_LIST.length; }
  console.log(`[OEM] startRun: OEM_LIST=${OEM_LIST.length} mã, current_index=${ST.current_index}, mã kế=${JSON.stringify(OEM_LIST[ST.current_index])}`);
  if (!OEM_LIST.length) { log('❌ Chưa nạp mã OEM (CSV)'); return { ok: false, error: 'Chưa nạp CSV' }; }
  if (ST.current_index >= OEM_LIST.length) { log('ℹ️ Đã xong hết — bấm "Xóa" để chạy lại từ đầu'); return { ok: false, error: 'Đã xong' }; }
  ST.running = true;
  startKeepAlive();
  await saveState();
  log(`▶ Bắt đầu từ mã #${ST.current_index + 1} · delay ${ST.delay}ms`);
  if (currentTabId == null && !OPENING) processCurrent();
  return { ok: true };
}

async function stopRun() {
  ST.running = false;
  OPENING = false;
  await clearWatchdog();
  if (currentTabId != null) { try { await chrome.tabs.remove(currentTabId); } catch {} currentTabId = null; }
  stopKeepAlive();
  await saveState();
  log('⏹ Đã dừng');
}

async function clearAll() {
  await stopRun();
  OEM_LIST = [];
  ST = { running: false, api_base: ST.api_base, delay: ST.delay, total: 0, current_index: 0,
         done: 0, no_result: 0, cf_blocked: 0, errors: 0, found: 0,
         current_oem: '', current_clean: '', current_found: 0, log: [] };
  await oemDbClear();
  await saveState();
  log('🗑️ Đã xóa toàn bộ queue + tiến độ');
}

// ── Alarms: keepAlive (RESUME) + watchdog (timeout mã treo). Cả 2 SỐNG SÓT khi SW bị kill. ──
function startKeepAlive() { chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_MIN }); }
function stopKeepAlive()  { chrome.alarms.clear(KEEPALIVE_ALARM); }

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name === WATCHDOG_ALARM) {
    // Mã hiện tại treo (content.js không phản hồi). Nếu KHÔNG còn tab in-flight (đã xong, hoặc SW vừa
    // respawn reset currentTabId=null) → BỎ QUA, không advance sai. Chỉ timeout khi tab thật sự còn mở.
    if (!ST.running || currentTabId == null) return;
    console.log('[OEM] ⏱ watchdog timeout:', ST.current_oem);
    log(`⏱ Timeout ${ST.current_oem} — bỏ qua`);
    return onOemDone({ error: true });        // idempotent (qua currentTabId)
  }
  if (a.name === KEEPALIVE_ALARM) {
    try { chrome.storage.local.set({ _oem_ping: Date.now() }); } catch {}   // chạm chrome API → giữ SW sống thêm 1 nhịp
    // RESUME: đang chạy mà KHÔNG có tab in-flight (setTimeout mất do SW chết, hoặc đã dừng sau tabs.create fail) → chạy tiếp.
    if (ST.running && currentTabId == null && !OPENING) {
      if (!OEM_LIST.length) { const s = await oemDbGet('oem_list'); OEM_LIST = s?.list || []; ST.total = OEM_LIST.length || ST.total; }
      if (ST.running && currentTabId == null && !OPENING && ST.current_index < OEM_LIST.length) {
        console.log('[OEM] keepAlive → resume mã #' + (ST.current_index + 1));
        processCurrent();
      }
    }
  }
});

// Khôi phục state khi SW khởi động (startup / cài lại / hồi sinh). currentTabId & OPENING tự reset (biến module).
async function resumeIfNeeded() {
  try {
    const saved = await oemDbGet('state');
    if (saved) { ST = { ...ST, ...saved, log: saved.log || [] }; }
    const s = await oemDbGet('oem_list'); OEM_LIST = s?.list || [];
    ST.total = OEM_LIST.length || ST.total;
    if (ST.running) {
      startKeepAlive();
      console.log('[OEM] SW restart → resume từ mã #' + (ST.current_index + 1));
      if (currentTabId == null && !OPENING) processCurrent();
    }
  } catch (e) { /* lần đầu chưa có DB */ }
}
resumeIfNeeded();

// ── Router message từ popup + content.js ──────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'OEM_RESULT') { handleResult(msg, sender.tab?.id); sendResponse({ ok: true }); return true; }

  if (msg?.action === 'LOAD_CSV')   { loadCsv(msg.oem_list, msg.api_base, msg.delay).then(() => sendResponse({ ok: true })); return true; }
  if (msg?.action === 'LOAD_CFG_ONLY') {
    if (msg.api_base) ST.api_base = String(msg.api_base).trim();
    if (msg.delay != null) ST.delay = Math.max(0, parseInt(msg.delay) || DEFAULT_DELAY);
    saveState().then(() => sendResponse({ ok: true })); return true;
  }
  if (msg?.action === 'START')      { startRun().then(r => sendResponse(r)); return true; }
  if (msg?.action === 'STOP')       { stopRun().then(() => sendResponse({ ok: true })); return true; }
  if (msg?.action === 'CLEAR_ALL')  { clearAll().then(() => sendResponse({ ok: true })); return true; }
  if (msg?.action === 'GET_STATUS') { sendResponse({ state: { ...ST } }); return true; }
  if (msg?.type === 'GET_STATS')    { sendResponse(statsPayload()); return true; }   // dashboard bản cũ
  return false;
});
