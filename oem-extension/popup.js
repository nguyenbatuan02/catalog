const $ = id => document.getElementById(id);
function bg(action, data = {}) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ action, ...data }, (r) => {
        if (chrome.runtime.lastError) { console.warn('BG:', chrome.runtime.lastError.message); resolve(null); }
        else resolve(r);
      });
    } catch (e) { resolve(null); }
  });
}

// ── Nạp CSV: lấy cột đầu mỗi dòng, bỏ header nếu có ─────────────────────────────
function parseCsv(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const codes = [];
  lines.forEach((line, i) => {
    const first = line.split(/[,;\t]/)[0].trim().replace(/^["']|["']$/g, '');
    if (!first) return;
    // bỏ header: dòng đầu không chứa chữ số và trông như tiêu đề (oem/code/mã)
    if (i === 0 && !/\d/.test(first) && /oem|code|m[aã]|part/i.test(first)) return;
    codes.push(first);
  });
  return codes;
}

$('csvFile').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    const codes = parseCsv(String(reader.result || ''));
    if (!codes.length) { $('csvHint').textContent = '⚠ Không đọc được mã nào trong file.'; return; }
    const api_base = $('inApi').value.trim() || 'http://103.214.9.97:3001/api/v1/catalog';
    const delay    = parseInt($('inDelay').value) || 2000;
    await bg('LOAD_CSV', { oem_list: codes, api_base, delay });
    $('csvHint').textContent = `✓ Đã nạp ${codes.length} mã từ "${file.name}".`;
    $('csvLabel').textContent = `📂 ${file.name} (${codes.length} mã)`;
    refresh();
  };
  reader.readAsText(file);
});

$('btnStart').addEventListener('click', async () => {
  // lưu cấu hình hiện tại (phòng khi đổi API/delay mà chưa nạp lại CSV)
  const api_base = $('inApi').value.trim();
  const delay    = parseInt($('inDelay').value) || 2000;
  chrome.storage.local.set({ oem_api: api_base, oem_delay: delay });
  await bg('LOAD_CFG_ONLY', { api_base, delay });   // no-op nếu bg không hỗ trợ (đã set qua LOAD_CSV)
  const r = await bg('START');
  if (r && !r.ok) appendLog('❌ ' + (r.error || 'Không bắt đầu được'), 'e');
  refresh();
});
$('btnStop').addEventListener('click', async () => { await bg('STOP'); refresh(); });
$('btnDashboard').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
});
$('btnClear').addEventListener('click', async () => {
  if (!confirm('Xóa toàn bộ queue + tiến độ đã lưu?')) return;
  await bg('CLEAR_ALL');
  $('csvLabel').textContent = '📂 Nạp file CSV (oem_codes.csv)';
  $('csvHint').textContent = 'Mỗi dòng 1 mã OEM (cột đầu). Có/không header đều được.';
  refresh();
});

// ── Render ─────────────────────────────────────────────────────────────────────
function applyState(s) {
  if (!s) return;
  $('sTotal').textContent = s.total || 0;
  $('sDone').textContent  = s.done  || 0;
  $('sErr').textContent   = s.errors || 0;
  $('sFound').textContent = s.found || 0;
  $('curOem').textContent = s.current_oem || '—';
  $('curFound').textContent = s.current_found || 0;
  // đã xử lý = TỔNG 4 rổ (có xe + không có + lỗi + CF) — để progress không thiếu no_result/cf
  const processed = (s.done || 0) + (s.no_result || 0) + (s.errors || 0) + (s.cf_blocked || 0);
  const pct = s.total ? Math.round((processed / s.total) * 100) : 0;
  $('progBar').style.width = pct + '%';

  const badge = $('badge');
  if (s.running) { badge.textContent = 'Đang chạy…'; badge.className = 'badge bd-run'; $('btnStart').disabled = true; $('btnStop').disabled = false; }
  else {
    $('btnStart').disabled = false; $('btnStop').disabled = true;
    if (s.total && processed >= s.total) { badge.textContent = 'Xong'; badge.className = 'badge bd-done'; }
    else { badge.textContent = 'Chờ'; badge.className = 'badge bd-idle'; }
  }

  if (s.log?.length) {
    const box = $('logBox');
    const atBottom = box.scrollHeight - box.scrollTop <= box.clientHeight + 20;
    box.innerHTML = '';
    s.log.slice(-10).forEach(l => appendLog(l, cls(l), box));   // 10 dòng gần nhất
    if (atBottom) box.scrollTop = box.scrollHeight;
  }
}
function cls(l) { return /❌|⚠️|🛑|⏱/.test(l) ? 'e' : /✅|🏁/.test(l) ? 'ok' : /○|⏭/.test(l) ? 'w' : ''; }
function appendLog(line, c, box) {
  box = box || $('logBox');
  const p = document.createElement('p'); p.textContent = line; if (c) p.className = c;
  box.appendChild(p); box.scrollTop = box.scrollHeight;
}

async function refresh() {
  const r = await bg('GET_STATUS');
  if (r?.state) applyState(r.state);
}

chrome.runtime.onMessage.addListener(msg => {
  if (msg.action === 'STATUS') applyState(msg.state);
  if (msg.action === 'LOG')    appendLog(msg.msg, cls(msg.msg));
});

document.addEventListener('DOMContentLoaded', () => {
  chrome.storage.local.get(['oem_api', 'oem_delay', 'oem_state'], (d) => {
    $('inApi').value   = d.oem_api   || 'http://103.214.9.97:3001/api/v1/catalog';
    $('inDelay').value = d.oem_delay || 2000;
    if (d.oem_state) applyState(d.oem_state);
  });
  refresh();
});

// Poll storage mỗi 1.5s (hiển thị kể cả khi service worker bận / popup vừa mở)
setInterval(() => {
  chrome.storage.local.get('oem_state', (d) => { if (d.oem_state) applyState(d.oem_state); });
}, 1500);
