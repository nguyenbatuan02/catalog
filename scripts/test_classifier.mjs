// Test bộ phân loại chat AI — dùng ĐÚNG classifierPrompt đang ship trong index.html.
// Chạy khi server đang bật (port 3001) và OPENAI_API_KEY trong .env còn hiệu lực:
//   node scripts/test_classifier.mjs
// Mỗi câu test in ra type + make/model/year/part và ✅/❌ so với kỳ vọng.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = await readFile(join(__dirname, '..', 'index.html'), 'utf8');
const m = html.match(/const classifierPrompt=`([\s\S]*?)`;/);
if (!m) { console.error('Không tìm thấy classifierPrompt trong index.html'); process.exit(1); }
const classifierPrompt = m[1];

const API = process.env.API_BASE || 'http://localhost:3001';
const tests = [
  ['Toyota Vios 2019 cần má phanh', 'by_model'],
  ['Innova 2020 lọc dầu',           'by_model'],
  ['Honda City giảm sóc trước',     'by_model'],
  ['má phanh cho camry 2015',       'by_model'],
  ['tôi cần mua phụ tùng',          'need_info'],
  ['xe tôi hỏng rồi',               'need_info'],
];

async function classify(msg) {
  const body = { model:'gpt-4o-mini', max_tokens:200, temperature:0,
    messages:[{role:'system',content:classifierPrompt},{role:'user',content:msg}] };
  const r = await fetch(`${API}/api/ai/chat`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
  const d = await r.json();
  if (!r.ok) throw new Error((d.error && d.error.message) || `HTTP ${r.status}`);
  return JSON.parse(d.choices[0].message.content.replace(/```json|```/g,'').trim());
}

let pass = 0;
for (const [msg, want] of tests) {
  try {
    const cl = await classify(msg);
    const ok = cl.type === want;
    if (ok) pass++;
    console.log(`${ok?'✅':'❌'} "${msg}"`);
    console.log(`     type=${cl.type} make=${cl.make||''} model=${cl.model||''} year=${cl.year||''} part=${JSON.stringify(cl.part_names||[])}${ok?'':`  (MONG ${want})`}`);
  } catch (e) { console.log(`❌ "${msg}" → LỖI: ${e.message}`); }
}
console.log(`\n${pass}/${tests.length} đúng`);
