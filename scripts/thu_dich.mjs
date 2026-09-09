/**
 * thu_dich.mjs — CHẠY THỬ dịch offline trên danh sách tên riêng biệt. KHÔNG ghi DB.
 *
 *   node scripts/thu_dich.mjs tmp_names.csv
 *
 * In tỉ lệ phủ + ghi 2 file: tmp_dich_duoc.csv (name,name_vi), tmp_khong_dich.csv
 */
import { readFileSync, writeFileSync } from 'fs';
import { translateOffline, _stats } from './lib/translate_offline.mjs';

const file = process.argv[2] || 'tmp_names.csv';

// CSV 1 cột do psql \copy sinh ra: có thể bọc "..." và nhân đôi dấu nháy bên trong
function parseLine(l) {
  if (!l.startsWith('"')) return l;
  return l.slice(1, -1).replace(/""/g, '"');
}

const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
const ok = [], bad = [];
for (const l of lines) {
  const name = parseLine(l);
  const vi = translateOffline(name, null);
  (vi ? ok : bad).push(vi ? [name, vi] : [name]);
}

const q = s => `"${String(s).replace(/"/g, '""')}"`;
writeFileSync('tmp_dich_duoc.csv', ok.map(r => `${q(r[0])},${q(r[1])}`).join('\n'), 'utf8');
writeFileSync('tmp_khong_dich.csv', bad.map(r => q(r[0])).join('\n'), 'utf8');

const pct = n => (n / lines.length * 100).toFixed(1);
console.log(`Từ điển: exact=${_stats.exactSize} oem=${_stats.codeMapSize} rule=${_stats.kwRules}`);
console.log(`Tổng tên riêng biệt : ${lines.length}`);
console.log(`Dịch được           : ${ok.length}  (${pct(ok.length)}%)`);
console.log(`KHÔNG dịch được     : ${bad.length}  (${pct(bad.length)}%)`);
console.log('\nMẫu dịch được:');
for (const r of ok.slice(0, 8)) console.log(`  ${r[0]}  →  ${r[1]}`);
console.log('\nMẫu KHÔNG dịch được:');
for (const r of bad.slice(0, 12)) console.log(`  ${r[0]}`);
