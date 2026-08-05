
const $=id=>document.getElementById(id);
function bg(action,data={}){return new Promise((resolve)=>{try{chrome.runtime.sendMessage({action,...data},(response)=>{if(chrome.runtime.lastError){console.error("BG error:",chrome.runtime.lastError.message);resolve(null);}else{resolve(response);}});}catch(e){console.error("BG exception:",e);resolve(null);}});}

// ── ETA engine ────────────────────────────────────────────────────────────────
let etaData = { startTime: null, startUnits: 0, unitsPerSec: 0 };

function updateETA(state) {
  const total = state.totalUnits || 0;
  const done  = state.doneUnits  || 0;
  const parts = state.partsCount || 0;

  if (!state.running || total === 0) return;

  // Tính tốc độ thực tế
  if (!etaData.startTime) {
    etaData.startTime  = Date.now();
    etaData.startUnits = done;
  }
  const elapsed = (Date.now() - etaData.startTime) / 1000;
  const processed = done - etaData.startUnits;
  if (elapsed > 5 && processed > 0) {
    etaData.unitsPerSec = processed / elapsed;
  }

  const remaining = total - done;
  const speed = etaData.unitsPerSec;

  if (speed > 0) {
    const secsLeft = remaining / speed;
    $('etaTime').textContent  = fmtTime(secsLeft);
    $('etaSpeed').textContent = `${speed.toFixed(2)} unit/s · ${parts} phụ tùng đã lưu`;
  } else {
    // Ước tính lý thuyết: 1.5s/unit
    const secsLeft = remaining * 1.5;
    $('etaTime').textContent  = fmtTime(secsLeft);
    $('etaSpeed').textContent = `Ước tính (1.5s/unit) · chờ dữ liệu thực...`;
  }
}

function fmtTime(secs) {
  if (!isFinite(secs) || secs < 0) return '--:--:--';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

// ── Apply state ───────────────────────────────────────────────────────────────
function applyState(s) {
  if (!s) return;

  $('sDong').textContent  = s.totalLines  || 0;
  $('sModel').textContent = s.totalModels || 0;
  $('sUnit').textContent  = s.totalUnits  || 0;
  $('sPart').textContent  = (s.partsCount||0).toLocaleString();

  // Progress
  const total = s.totalUnits || 1;
  const done  = s.doneUnits  || 0;
  const pct   = Math.round((done / total) * 100);
  $('progBar').style.width = pct + '%';
  $('progTxt').textContent  = `${done.toLocaleString()} / ${total.toLocaleString()} unit`;
  $('progPct').textContent  = pct + '%';

  // Steps
  const phaseMap = { locate:1, pick:2, vehicle:3, unit:4 };
  const cur = phaseMap[s.phase] || 0;
  for (let i = 1; i <= 5; i++) {
    const el = $('s'+i);
    el.className = 'step-item' + (i < cur ? ' done' : i === cur ? ' active' : '');
  }
  if (!s.running && s.partsCount > 0 && !s.error) {
    for (let i = 1; i <= 5; i++) $('s'+i).className = 'step-item done';
  }

  // Badge
  if (s.running) {
    setBadge(s.phase || 'Chạy...', 'bd-run');
    $('btnStart').disabled = true;
    $('btnStop').disabled  = false;
  } else {
    $('btnStart').disabled = false;
    $('btnStop').disabled  = true;
    if (s.error)            setBadge('Lỗi', 'bd-err');
    else if (s.partsCount)  { setBadge('Hoàn thành', 'bd-done'); $('cardExport').style.display='block'; }
    else                    setBadge('Chờ', 'bd-idle');
    etaData = { startTime: null, startUnits: 0, unitsPerSec: 0 };
  }

  // ETA
  updateETA(s);

  // Log
  if (s.log?.length) {
    const box = $('logBox');
    const atBottom = box.scrollHeight - box.scrollTop <= box.clientHeight + 20;
    box.innerHTML = '';
    s.log.slice(-50).forEach(l => _appendLog(l, box));
    if (atBottom) box.scrollTop = box.scrollHeight;
  }

  // Show cards
  if (s.running || s.totalUnits > 0) {
    $('cardProg').style.display = 'block';
    $('cardLog').style.display  = 'block';
  }
}

function setBadge(txt, cls) {
  const b = $('phBadge');
  b.textContent = txt;
  b.className   = 'badge ' + cls;
}

function _appendLog(line, box) {
  const p = document.createElement('p');
  p.textContent = line;
  const c = line.includes('❌') ? 'e' : line.includes('⚠') ? 'w' : line.includes('🚀') ? 'i' : '';
  if (c) p.className = c;
  box.appendChild(p);
}

function appendLog(line) {
  const box = $('logBox');
  $('cardLog').style.display = 'block';
  _appendLog(line, box);
  box.scrollTop = box.scrollHeight;
}

// ── Buttons ───────────────────────────────────────────────────────────────────
$('btnStart').addEventListener('click', async () => { console.log('START clicked');
  const make = $('inMake').value.trim();
  if (!make) { alert('Nhập tên hãng xe!'); return; }
  etaData = { startTime: null, startUnits: 0, unitsPerSec: 0 };
  $('btnStart').disabled = true;
  $('btnStop').disabled  = false;
  $('cardProg').style.display   = 'block';
  $('cardLog').style.display    = 'block';
  $('cardExport').style.display = 'none';
  $('logBox').innerHTML = '';
  console.log('Sending START to bg...'); const r = await bg('START', { make, modelFilter: $('inModel').value }); console.log('BG response:', r);
  if (!r?.ok) {
    appendLog('❌ ' + (r?.error || 'Lỗi khởi động'));
    $('btnStart').disabled = false;
    $('btnStop').disabled  = true;
  }
});

$('btnStop').addEventListener('click', async () => {
  await bg('STOP');
  $('btnStop').disabled  = true;
  $('btnStart').disabled = false;
  setBadge('Đã dừng', 'bd-stop');
  $('etaTime').textContent = '--:--:--';
});

$('btnModels').addEventListener('click', () => exportData('models'));
$('btnParts').addEventListener('click',  () => exportData('parts'));
$('btnExcel').addEventListener('click',  () => exportData('excel'));

$('btnClear').addEventListener('click', async () => {
  if (!confirm('Xóa toàn bộ dữ liệu?')) return;
  await bg('CLEAR');
  $('cardProg').style.display   = 'none';
  $('cardLog').style.display    = 'none';
  $('cardExport').style.display = 'none';
  $('logBox').innerHTML = '';
  $('btnStart').disabled = false;
  setBadge('Chờ','bd-idle');
});

// ── Realtime poll ─────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener(msg => {
  if (msg.action === 'LOG')    appendLog(msg.msg);
  if (msg.action === 'STATUS') applyState(msg.state);
});

document.addEventListener('DOMContentLoaded', async () => {
  // Đọc từ storage trước (hoạt động kể cả khi popup vừa mở)
  chrome.storage.local.get('scraperState', (data) => {
    if (data.scraperState) applyState(data.scraperState);
  });
  // Sau đó sync với background
  const r = await bg('GET_STATUS');
  if (r?.state) applyState(r.state);
});

// Poll storage mỗi 1.5s — hoạt động kể cả khi background bận
setInterval(() => {
  chrome.storage.local.get('scraperState', (data) => {
    if (data.scraperState) {
      applyState(data.scraperState);
      updateETA(data.scraperState);
    }
  });
}, 1500);

// ── Export ────────────────────────────────────────────────────────────────────
async function exportData(type) {
  const r = await bg('GET_DATA');
  if (!r?.ok || (!r.models?.length && !r.parts?.length)) { alert('Chưa có dữ liệu!'); return; }
  const make = r.parts[0]?.make || r.models[0]?.make || 'export';
  const ts   = new Date().toISOString().slice(0,16).replace('T','_').replace(/:/g,'-');

  if (type === 'models') {
    dlCSV(toCSV(['make','model_line','model_code','year_range','specs'],
                ['Hãng','Dòng xe','Model Code','Năm','Thông số'], r.models),
          `${make}_models_${ts}.csv`);
  } else if (type === 'parts') {
    dlCSV(toCSV(['make','model_line','model_code','unit','part_number','name','code','note','qty','range'],
                ['Hãng','Dòng xe','Model Code','Nhóm','Mã phụ tùng','Tên','Code','Ghi chú','SL','Năm SX'], r.parts),
          `${make}_parts_${ts}.csv`);
  } else {
    dlBlob(buildXLSX(r.models, r.parts), `${make}_partsouq_${ts}.xlsx`,
           'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  }
}

function toCSV(fields, hdrs, rows) {
  const e = v => `"${String(v??'').replace(/"/g,'""')}"`;
  return '\uFEFF' + [hdrs.map(e).join(','), ...rows.map(r=>fields.map(f=>e(r[f])).join(','))].join('\r\n');
}
function dlCSV(csv, fn) { dlBlob(new TextEncoder().encode(csv), fn, 'text/csv;charset=utf-8;'); }
function dlBlob(data, fn, type) {
  const url = URL.createObjectURL(new Blob([data],{type}));
  const a = Object.assign(document.createElement('a'),{href:url,download:fn});
  document.body.appendChild(a); a.click();
  setTimeout(()=>{URL.revokeObjectURL(url);a.remove()},1000);
}

function buildXLSX(models, parts) {
  const esc = v => String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const cell = (v,b) => `<c t="inlineStr"${b?' s="1"':''}><is><t>${esc(v)}</t></is></c>`;
  const sheet = (hdrs,fields,rows) => {
    let x=`<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>`;
    x+=`<row>${hdrs.map(h=>cell(h,true)).join('')}</row>`;
    rows.forEach(r=>{x+=`<row>${fields.map(f=>cell(r[f])).join('')}</row>`;});
    return x+`</sheetData></worksheet>`;
  };
  const files = {
    '[Content_Types].xml':`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    '_rels/.rels':`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml':`<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Models" sheetId="1" r:id="rId1"/><sheet name="Parts" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels':`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'xl/worksheets/sheet1.xml': sheet(['Hãng','Dòng xe','Model Code','Năm','Thông số'],['make','model_line','model_code','year_range','specs'],models),
    'xl/worksheets/sheet2.xml': sheet(['Hãng','Dòng xe','Model Code','Nhóm','Mã phụ tùng','Tên','Code','Ghi chú','SL','Năm SX'],['make','model_line','model_code','unit','part_number','name','code','note','qty','range'],parts),
    'xl/styles.xml':`<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>`
  };
  return zipIt(files);
}

function zipIt(files){
  const enc=new TextEncoder();
  const tbl=(()=>{const t=new Uint32Array(256);for(let i=0;i<256;i++){let c=i;for(let j=0;j<8;j++)c=(c&1)?(0xEDB88320^(c>>>1)):(c>>>1);t[i]=c;}return t;})();
  const crc=d=>{let c=0xFFFFFFFF;for(let i=0;i<d.length;i++)c=tbl[(c^d[i])&0xFF]^(c>>>8);return(c^0xFFFFFFFF)>>>0;};
  const u16=n=>[n&0xFF,(n>>8)&0xFF];
  const u32=n=>[n&0xFF,(n>>8)&0xFF,(n>>16)&0xFF,(n>>24)&0xFF];
  const parts=[];let offset=0;const cd=[];
  for(const[name,content]of Object.entries(files)){
    const nb=enc.encode(name),db=enc.encode(content),c=crc(db),sz=db.length;
    const lh=new Uint8Array([0x50,0x4B,0x03,0x04,20,0,0,0,0,0,0,0,0,0,...u32(c),...u32(sz),...u32(sz),...u16(nb.length),0,0,...nb]);
    cd.push({nb,c,sz,offset});offset+=lh.length+sz;parts.push(lh,db);
  }
  const cdStart=offset;
  for(const{nb,c,sz,offset:off}of cd){
    parts.push(new Uint8Array([0x50,0x4B,0x01,0x02,20,0,20,0,0,0,0,0,0,0,0,0,...u32(c),...u32(sz),...u32(sz),...u16(nb.length),0,0,0,0,0,0,0,0,0,0,...u32(off),...nb]));
  }
  let cdSz=0;for(let i=cd.length*2;i<parts.length;i++)cdSz+=parts[i].length;
  parts.push(new Uint8Array([0x50,0x4B,0x05,0x06,0,0,0,0,...u16(cd.length),...u16(cd.length),...u32(cdSz),...u32(cdStart),0,0]));
  const tot=parts.reduce((s,a)=>s+a.length,0);const buf=new Uint8Array(tot);let pos=0;
  for(const p of parts){buf.set(p,pos);pos+=p.length;}return buf;
}
