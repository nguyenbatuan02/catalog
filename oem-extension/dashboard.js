// dashboard.js — tách khỏi dashboard.html (MV3 CSP: KHÔNG cho <script> inline).
// Đọc state từ background (storage.local + GET_STATUS) và cập nhật UI dashboard.

let startTime = null;

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// Render log THẬT từ background (ST.log — mảng chuỗi đã có sẵn [HH:MM:SS]).
function renderLog(logArr) {
  if (!Array.isArray(logArr) || !logArr.length) return;
  const box = document.getElementById('log_box');
  box.innerHTML = logArr.slice(-50).reverse().map(line => {
    const cls = /❌|⚠️|🛑|⏱/.test(line) ? 'err'
              : /✅|🏁/.test(line) ? 'ok'
              : /🔎|▶|↻|📋|🚀/.test(line) ? 'info' : '';
    return `<div class="log-line ${cls}">${escapeHtml(line)}</div>`;
  }).join('');
}

function updateUI(s) {
  if (!s) return;
  if (!startTime && s.running) startTime = Date.now();

  // đã xử lý = TỔNG 4 rổ (có xe + không có + lỗi + CF) — khớp background
  const processed = (s.done || 0) + (s.no_result || 0) + (s.errors || 0) + (s.cf_blocked || 0);
  const total = s.total || 0;
  const pct = total > 0 ? Math.round(processed / total * 100) : 0;

  document.getElementById('total').textContent = total.toLocaleString();
  document.getElementById('done').textContent = (s.done || 0).toLocaleString();
  document.getElementById('no_result').textContent = (s.no_result || 0).toLocaleString();
  document.getElementById('errors').textContent = (s.errors || 0).toLocaleString();
  document.getElementById('fitments').textContent = (s.found || 0).toLocaleString();   // found = tổng fitment
  document.getElementById('cf_blocked').textContent = (s.cf_blocked || 0).toLocaleString();
  document.getElementById('pct').textContent = pct + '%';
  document.getElementById('bar').style.width = pct + '%';
  document.getElementById('progress_text').textContent = `${processed.toLocaleString()} / ${total.toLocaleString()}`;
  document.getElementById('current_oem').textContent = s.current_oem || '--';
  document.getElementById('idx').textContent = (s.current_index || 0).toLocaleString();
  document.getElementById('total2').textContent = total.toLocaleString();

  // Tốc độ & ETA
  if (startTime && processed > 0) {
    const hrs = (Date.now() - startTime) / 3600000;
    const speed = hrs > 0 ? Math.round(processed / hrs) : 0;
    document.getElementById('speed').textContent = speed.toLocaleString();
    const remain = total - processed;
    if (speed > 0 && remain > 0) {
      const etaH = remain / speed;
      document.getElementById('eta').textContent = etaH < 1
        ? Math.round(etaH * 60) + ' phút'
        : etaH.toFixed(1) + ' giờ';
    } else if (remain <= 0) {
      document.getElementById('eta').textContent = '0';
    }
  }

  // Trạng thái
  const dot = document.getElementById('dot');
  const txt = document.getElementById('status_text');
  if (s.running) {
    dot.className = 'dot dot-run'; txt.textContent = '● Đang chạy'; txt.style.color = '#38bdf8';
  } else if (total > 0 && processed >= total) {
    dot.className = 'dot dot-stop'; txt.textContent = '✓ Hoàn thành'; txt.style.color = '#4ade80';
  } else {
    dot.className = 'dot dot-off'; txt.textContent = '⏸ Đã dừng'; txt.style.color = '#94a3b8';
  }

  renderLog(s.log);
}

// Nguồn state: storage.local (nhanh, có kể cả khi SW ngủ) + fallback hỏi background (đánh thức SW).
async function pollStats() {
  try {
    const d = await chrome.storage.local.get('oem_state');
    if (d && d.oem_state) {
      updateUI(d.oem_state);
    } else {
      const resp = await chrome.runtime.sendMessage({ action: 'GET_STATUS' }).catch(() => null);
      if (resp && resp.state) updateUI(resp.state);
      else {
        document.getElementById('status_text').textContent = '⚠ Chưa có dữ liệu — nạp CSV & Start trong popup';
      }
    }
  } catch (e) {
    document.getElementById('status_text').textContent = '⚠ Không kết nối được background';
    document.getElementById('dot').className = 'dot dot-off';
  }
  setTimeout(pollStats, 3000);
}

// Realtime: background broadcast { action: 'STATUS', state }
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.action === 'STATUS') updateUI(msg.state);
});

document.getElementById('btnRefresh').addEventListener('click', pollStats);
pollStats();
