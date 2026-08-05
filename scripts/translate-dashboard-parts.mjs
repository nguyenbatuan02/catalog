/**
 * translate-dashboard-parts.mjs — Dịch tên phụ tùng (50 loại dashboard) sang tiếng Việt bằng GPT-4o-mini.
 *
 * Lấy các sản phẩm thuộc 50 loại dashboard đang THIẾU name_vi, dịch (ưu tiên từ điển cố định,
 * phần còn lại nhờ GPT-4o-mini), rồi UPDATE catalog_products.name_vi.
 *
 * AN TOÀN & ĐÚNG:
 *   • Mặc định DRY-RUN (KHÔNG ghi DB) — phải thêm --commit mới thực sự UPDATE.
 *   • Lấy TOÀN BỘ worklist 1 lần vào RAM rồi xử lý → mỗi dòng xử lý ĐÚNG 1 lần
 *     (KHÔNG dùng OFFSET trên bộ lọc name_vi IS NULL — sẽ NHẢY dòng khi vừa update vừa phân trang).
 *   • Quét bảng 1.37tr dòng CHỈ 1 lần (1 câu SELECT), thay vì ~1700 lần như phân trang OFFSET.
 *   • API key CHỈ đọc từ process.env.OPENAI_API_KEY (.env) — KHÔNG hard-code trong file.
 *
 * CHẠY:
 *   node scripts/translate-dashboard-parts.mjs                 # DRY-RUN toàn bộ (không ghi) — xem trước
 *   node scripts/translate-dashboard-parts.mjs --limit 200     # DRY-RUN 200 dòng đầu (test nhanh)
 *   node scripts/translate-dashboard-parts.mjs --commit        # GHI THẬT toàn bộ
 *   node scripts/translate-dashboard-parts.mjs --commit --limit 500
 *
 * FLAG: --commit (ghi DB) | --limit N (giới hạn số dòng) | --sample N (số ví dụ in ở dry-run, mặc định 40)
 *       --concurrency K (mặc định 5) | --batch B (mặc định 50)
 */
import 'dotenv/config';
import pg from 'pg';

// ── CLI ─────────────────────────────────────────────────────────────────────
const ARGV = process.argv.slice(2);
const flag = (name) => ARGV.includes(name);
const opt  = (name, def) => { const i = ARGV.indexOf(name); return i >= 0 && ARGV[i + 1] ? ARGV[i + 1] : def; };

const COMMIT      = flag('--commit');
const NO_FIXED    = flag('--no-fixed');   // bỏ từ điển cố định, để GPT dịch HẾT (chính xác hơn với tên ghép)
const LIMIT       = parseInt(opt('--limit', '0')) || 0;      // 0 = tất cả
const SAMPLE      = parseInt(opt('--sample', '40')) || 40;
const CONCURRENCY = parseInt(opt('--concurrency', '5')) || 5;
const BATCH_SIZE  = parseInt(opt('--batch', '50')) || 50;
const MODEL       = 'gpt-4o-mini';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error('❌ Thiếu OPENAI_API_KEY trong .env — dừng.');
  process.exit(1);
}

const pool = new pg.Pool({
  host    : process.env.DB_HOST     || 'localhost',
  port    : Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME     || 'zalocrm',
  user    : process.env.DB_USER     || 'crmuser',
  password: process.env.DB_PASSWORD || 'devpassword',
  max     : Math.max(4, CONCURRENCY + 1),
});

// ── Bộ lọc 50 loại dashboard (định nghĩa 1 lần, dùng cho SELECT worklist) ─────
// LƯU Ý: '%abs%' cũng khớp "absorber" (giảm sóc) → kéo thêm nhiều dòng giảm sóc vào phạm vi dịch;
//        không sai về mặt dịch nhưng làm phạm vi rộng hơn "chỉ ABS".
const FILTER_SQL = `(
  name ILIKE '%piston%' OR name ILIKE '%ring set%' OR name ILIKE '%connecting rod%' OR name ILIKE '%gasket kit%' OR
  name ILIKE '%oil filter%' OR name ILIKE '%fuel filter%' OR name ILIKE '%air filter%' OR name ILIKE '%air cleaner%' OR
  name ILIKE '%oil pump%' OR name ILIKE '%water pump%' OR name ILIKE '%spark plug%' OR name ILIKE '%glow plug%' OR
  name ILIKE '%ignition coil%' OR name ILIKE '%injector%' OR name ILIKE '%fuel pump%' OR name ILIKE '%turbo%' OR
  name ILIKE '%timing belt%' OR name ILIKE '%timing chain%' OR name ILIKE '%v-belt%' OR name ILIKE '%drive belt%' OR
  name ILIKE '%tensioner%' OR name ILIKE '%idler%' OR name ILIKE '%radiator%' OR name ILIKE '%oil cooler%' OR
  name ILIKE '%fan motor%' OR name ILIKE '%cooling fan%' OR name ILIKE '%alternator%' OR name ILIKE '%starter%' OR
  name ILIKE '%transmission%' OR name ILIKE '%gearbox%' OR name ILIKE '%drive shaft%' OR name ILIKE '%axle shaft%' OR
  name ILIKE '%wheel bearing%' OR name ILIKE '%hub bearing%' OR name ILIKE '%clutch disc%' OR name ILIKE '%pressure plate%' OR
  name ILIKE '%release bearing%' OR name ILIKE '%clutch master%' OR name ILIKE '%propeller shaft%' OR name ILIKE '%differential%' OR
  name ILIKE '%shock absorber%' OR name ILIKE '%strut%' OR name ILIKE '%coil spring%' OR name ILIKE '%control arm%' OR
  name ILIKE '%lower arm%' OR name ILIKE '%upper arm%' OR name ILIKE '%stabilizer link%' OR
  name ILIKE '%brake pad%' OR name ILIKE '%pad kit%' OR name ILIKE '%brake disc%' OR name ILIKE '%brake rotor%' OR
  name ILIKE '%brake shoe%' OR name ILIKE '%master cylinder%' OR name ILIKE '%abs%' OR
  name ILIKE '%steering rack%' OR name ILIKE '%tie rod%' OR name ILIKE '%power steering pump%' OR
  name ILIKE '%compressor%' OR name ILIKE '%condenser%' OR name ILIKE '%evaporator%' OR name ILIKE '%battery%' OR
  name ILIKE '%headlamp%' OR name ILIKE '%headlight%' OR name ILIKE '%airbag%'
)`;

// ── Từ điển cố định (khớp cụm chính xác, ưu tiên cụm DÀI trước để tránh false-positive) ──
// LƯU Ý: khớp theo chuỗi con trên CẢ tên → "COMPRESSOR BRACKET" vẫn ra "Lốc lạnh điều hòa" (thực ra là giá bắt).
//        Đã sắp CỤM DÀI trước (vd 'timing belt' trước 'v-belt') để giảm nhầm; phần tinh chỉnh còn lại để GPT lo.
const FIXED_TRANSLATIONS = {
  'power steering pump': 'Bơm trợ lực lái',
  'stabilizer link': 'Rô tuyn cân bằng',
  'propeller shaft': 'Trục các đăng',
  'pressure plate': 'Bàn ép côn',
  'release bearing': 'Bi tê côn',
  'shock absorber': 'Giảm sóc',
  'strut assembly': 'Giảm sóc (cụm)',
  'overhaul gasket': 'Gioăng bộ đại tu',
  'connecting rod': 'Thanh truyền (biên)',
  'ignition coil': 'Môbin đánh lửa',
  'starting motor': 'Máy đề',
  'wheel bearing': 'Bi moay ơ',
  'hub bearing': 'Bi moay ơ',
  'clutch master': 'Tổng côn',
  'clutch disc': 'Đĩa côn',
  'master cylinder': 'Tổng phanh',
  'abs actuator': 'Cụm ABS',
  'steering rack': 'Thước lái',
  'control arm': 'Càng A',
  'lower arm': 'Càng A dưới',
  'upper arm': 'Càng A trên',
  'coil spring': 'Lò xo',
  'timing belt': 'Dây curoa cam',
  'cam belt': 'Dây curoa cam',
  'timing chain': 'Xích cam',
  'drive belt': 'Dây curoa tổng',
  'tie rod': 'Rô tuyn lái',
  'brake pad': 'Má phanh trước',
  'pad kit': 'Bộ má phanh',
  'brake disc': 'Đĩa phanh',
  'brake rotor': 'Đĩa phanh',
  'brake shoe': 'Guốc phanh sau',
  'oil filter': 'Lọc dầu',
  'fuel filter': 'Lọc nhiên liệu',
  'air filter': 'Lọc gió',
  'air cleaner': 'Lọc gió',
  'oil pump': 'Bơm dầu',
  'water pump': 'Bơm nước',
  'fuel pump': 'Bơm nhiên liệu',
  'oil cooler': 'Két làm mát dầu',
  'fan motor': 'Mô tơ quạt',
  'cooling fan': 'Quạt làm mát',
  'spark plug': 'Bugi',
  'glow plug': 'Bugi sấy',
  'ring set': 'Bộ séc măng',
  'piston ring': 'Séc măng piston',
  'gasket kit': 'Bộ gioăng đại tu',
  'drive shaft': 'Cây láp',
  'axle shaft': 'Cây láp',
  'v-belt': 'Dây curoa',
  'tensioner': 'Bi tăng',
  'idler': 'Bi tỳ',
  'radiator': 'Két nước',
  'alternator': 'Máy phát điện',
  'starter': 'Máy đề',
  'transmission': 'Hộp số',
  'gearbox': 'Hộp số',
  'differential': 'Cầu sau',
  'turbocharger': 'Turbo tăng áp',
  'injector': 'Kim phun',
  'compressor': 'Lốc lạnh điều hòa',
  'condenser': 'Dàn nóng điều hòa',
  'evaporator': 'Dàn lạnh điều hòa',
  'battery': 'Ắc quy',
  'headlamp': 'Đèn chiếu sáng',
  'headlight': 'Đèn pha',
  'airbag': 'Túi khí',
  'piston': 'Piston',
};
const FIXED_ENTRIES = Object.entries(FIXED_TRANSLATIONS); // giữ thứ tự: cụm dài → ngắn

function checkFixed(name) {
  const lower = name.toLowerCase();
  for (const [key, val] of FIXED_ENTRIES) if (lower.includes(key)) return val;
  return null;
}

// ── Gọi GPT-4o-mini qua fetch (KHÔNG cần SDK 'openai', giống pattern server.ts) ──
// Glossary = chính các thuật ngữ thợ máy trong FIXED_TRANSLATIONS, nhưng đưa vào prompt làm
// "từ chuẩn nên dùng" để GPT áp dụng THÔNG MINH (chỉ khi bộ phận ĐÚNG là thứ đó), tránh vừa
// giữ thuật ngữ chuẩn vừa không nhầm phụ kiện (bulông/giá đỡ/ống...) thành bộ phận chính.
const GLOSSARY_TEXT = FIXED_ENTRIES.map(([en, vi]) => `  ${en} = ${vi}`).join('\n');
const SYSTEM_PROMPT = `Bạn là chuyên gia phụ tùng ô tô Việt Nam. Dịch tên phụ tùng Anh→Việt theo thuật ngữ thợ máy VN.

ĐỊNH DẠNG:
- Viết Title Case (Hoa chữ đầu mỗi từ), KHÔNG VIẾT HOA TOÀN BỘ, không dịch word-by-word cứng nhắc.
- Ngắn gọn, đúng thuật ngữ thợ máy. Giữ nguyên: NO.1, NO.2, LH, RH, SUB-ASSY, mã số, năm.

DỊCH THEO BỘ PHẬN CHÍNH (danh từ đầu tên) — QUAN TRỌNG NHẤT:
- Nếu tên bắt đầu bằng PHỤ KIỆN thì dịch ĐÚNG phụ kiện đó + bộ phận nó thuộc về, TUYỆT ĐỐI KHÔNG
  dịch thành tên bộ phận chính: SCREW=vít, BOLT=bulông, NUT=đai ốc, BRACKET/BRACE=giá đỡ, HOSE=ống,
  PIPE=ống, COVER=nắp, CAP=nắp, SEAL=phớt, GASKET=gioăng, CABLE/WIRING/CORD=dây/bó dây điện,
  GRILLE=lưới, INSULATOR/INSULATION=cách nhiệt/đệm, PAD(không brake)=đệm, MOUNTING/MEMBER=chân/giá bắt,
  RESERVOIR/TANK=bình, HOUSING=vỏ, SUPPORT=đỡ, SENSOR=cảm biến, SWITCH=công tắc, UNIT/CONTROL=bộ điều khiển.
  VD: "SCREW,OIL PUMP COVER"="Vít Nắp Bơm Dầu" (KHÔNG phải "Bơm dầu").
  VD: "GRILLE, RADIATOR"="Lưới Két Nước" (KHÔNG phải "Két nước").
  VD: "INSULATION PAD - BATTERY"="Tấm Cách Nhiệt Ắc Quy" (KHÔNG phải "Ắc quy").

THUẬT NGỮ CHUẨN (dùng đúng từ bên phải khi gặp bộ phận tương ứng):
${GLOSSARY_TEXT}

QUY TẮC KHÁC:
- PAD (không brake) = đệm/tấm lót; chỉ BRAKE PAD / PAD KIT ...BRAKE mới là "Má phanh".
- BEARING=bi/vòng bi, PUMP=bơm, FILTER=lọc, BELT=dây curoa, SPRING=lò xo, SHOCK/DAMPER/STRUT=giảm sóc,
  CONDENSER=dàn nóng điều hòa, ALTERNATOR/GENERATOR=máy phát điện, TENSIONER=bi tăng.

Trả về JSON: {"1":"tên tiếng Việt","2":"..."}`;

async function callGPT(names, tries = 4) {
  const nameList = names.map((n, i) => `${i + 1}. ${n}`).join('\n');
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method : 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
        body   : JSON.stringify({
          model: MODEL,
          temperature: 0,
          response_format: { type: 'json_object' },  // ép JSON hợp lệ, không cần bóc ```json
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user',   content: nameList },
          ],
        }),
      });
      if (resp.status === 429 || resp.status >= 500) {   // rate-limit / lỗi tạm → backoff rồi thử lại
        const wait = 1500 * attempt;
        console.error(`   ⏳ GPT ${resp.status} — chờ ${wait}ms rồi thử lại (${attempt}/${tries})`);
        await sleep(wait);
        continue;
      }
      if (!resp.ok) throw new Error(`GPT HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
      const data = await resp.json();
      const text = (data.choices?.[0]?.message?.content || '').trim();
      return JSON.parse(text);   // { "1": "...", ... }
    } catch (e) {
      if (attempt === tries) { console.error(`   ❌ GPT lỗi (bỏ qua batch): ${e.message}`); return {}; }
      await sleep(1000 * attempt);
    }
  }
  return {};
}

// ── Dịch 1 batch: fixed trước, phần còn lại gọi GPT ──────────────────────────
async function translateBatch(items) {
  const results = {};   // id -> name_vi
  let nFixed = 0, nAI = 0;
  const needAI = [];
  for (const it of items) {
    const fixed = NO_FIXED ? null : checkFixed(it.name);
    if (fixed) { results[it.id] = fixed; nFixed++; }
    else needAI.push(it);
  }
  if (needAI.length) {
    const translated = await callGPT(needAI.map(it => it.name));
    needAI.forEach((it, i) => {
      const vi = translated[String(i + 1)];
      if (vi && typeof vi === 'string' && vi.trim()) { results[it.id] = vi.trim(); nAI++; }
    });
  }
  return { results, nFixed, nAI, nFail: items.length - Object.keys(results).length };
}

// ── Ghi 1 batch (chỉ khi --commit) — mirror translate_worker.mjs ─────────────
async function updateBatch(results) {
  const entries = Object.entries(results);
  if (!entries.length) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [id, nameVi] of entries) {
      await client.query(
        `UPDATE catalog_products SET name_vi = $1, needs_translation = FALSE, updated_at = NOW() WHERE id = $2`,
        [nameVi, id]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }
}

// ── Worker-pool: chạy tối đa CONCURRENCY batch song song ─────────────────────
async function runPool(batches, worker) {
  let idx = 0;
  const runners = Array.from({ length: Math.min(CONCURRENCY, batches.length) }, async () => {
    while (idx < batches.length) {
      const i = idx++;
      await worker(batches[i], i);
    }
  });
  await Promise.all(runners);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log(`  MODE: ${COMMIT ? '🔴 COMMIT (GHI DB THẬT)' : '🟢 DRY-RUN (không ghi DB)'}`
    + `  | limit=${LIMIT || 'tất cả'} | batch=${BATCH_SIZE} | concurrency=${CONCURRENCY} | model=${MODEL}`);
  console.log('╚══════════════════════════════════════════════════════════════╝');

  // 1) Lấy TOÀN BỘ worklist 1 lần (1 lần quét bảng). Mỗi dòng xử lý đúng 1 lần → không nhảy/lặp.
  console.log('⏳ Đang lấy danh sách cần dịch (quét bảng 1 lần, có thể ~30-60s)...');
  const t0 = Date.now();
  const sql = `SELECT id, name FROM catalog_products
               WHERE name_vi IS NULL AND ${FILTER_SQL}
               ORDER BY id ${LIMIT ? `LIMIT ${LIMIT}` : ''}`;
  const { rows: worklist } = await pool.query(sql);
  console.log(`✅ Worklist: ${worklist.length.toLocaleString()} dòng (lấy trong ${((Date.now()-t0)/1000).toFixed(1)}s)`);
  if (!worklist.length) { console.log('Không có gì để dịch.'); await pool.end(); return; }

  // 2) Chia batch
  const batches = [];
  for (let i = 0; i < worklist.length; i += BATCH_SIZE) batches.push(worklist.slice(i, i + BATCH_SIZE));

  // 3) Xử lý (song song). Ở DRY-RUN: dịch + gom mẫu, KHÔNG ghi DB.
  let done = 0, fixedTot = 0, aiTot = 0, failTot = 0, batchesDone = 0;
  const samples = [];
  await runPool(batches, async (batch) => {
    const { results, nFixed, nAI, nFail } = await translateBatch(batch);
    if (COMMIT) await updateBatch(results);
    fixedTot += nFixed; aiTot += nAI; failTot += nFail;
    done += Object.keys(results).length;
    batchesDone++;
    if (samples.length < SAMPLE) {
      for (const it of batch) {
        if (samples.length >= SAMPLE) break;
        if (results[it.id]) samples.push({ name: it.name, vi: results[it.id], src: (!NO_FIXED && checkFixed(it.name)) ? 'FIX' : 'AI ' });
      }
    }
    const pct = Math.round(batchesDone / batches.length * 100);
    if (batchesDone % 5 === 0 || batchesDone === batches.length) {
      console.log(`[${pct}%] batch ${batchesDone}/${batches.length} | dịch ${done.toLocaleString()} (fix ${fixedTot}, AI ${aiTot}, lỗi ${failTot})`);
    }
  });

  // 4) Tổng kết + mẫu
  console.log('\n──────── MẪU DỊCH (kiểm tra chất lượng) ────────');
  for (const s of samples) console.log(`  [${s.src}] ${s.name}  →  ${s.vi}`);
  console.log('────────────────────────────────────────────────');
  console.log(`Tổng: ${worklist.length.toLocaleString()} | dịch được ${done.toLocaleString()} `
    + `(từ điển ${fixedTot.toLocaleString()}, GPT ${aiTot.toLocaleString()}) | không dịch được ${failTot.toLocaleString()}`);
  console.log(COMMIT ? '🔴 ĐÃ GHI name_vi vào catalog_products.' : '🟢 DRY-RUN — chưa ghi gì. Thêm --commit để ghi thật.');
  await pool.end();
}

main().catch(async e => { console.error('LỖI:', e); try { await pool.end(); } catch {} process.exit(1); });
