/**
 * scripts/cao_xe_tu_oem.mjs
 * Tra mã phụ tùng trên PartSouq qua CDP Chrome, bấm "What cars it fits?" (modal)
 * để lấy danh sách biến thể xe tương thích, nạp thẳng vào catalog_vehicles và catalog_fitments.
 *
 * Dùng:
 *   node scripts/cao_xe_tu_oem.mjs --file tmp_oem_can_xe.txt
 */

import { chromium } from 'playwright';
import { readFileSync, appendFileSync, existsSync } from 'fs';
import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const CDP = process.env.CDP || 'http://localhost:9222';
const CHO = 1500;

const pool = new pg.Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'catalog',
  user: process.env.DB_USER || 'catalog_user',
  password: process.env.DB_PASSWORD,
});

const args = process.argv.slice(2);
const fi = args.indexOf('--file');
const fileIn = fi !== -1 ? args[fi + 1] : 'tmp_oem_can_xe.txt';
const dsMa = readFileSync(fileIn, 'utf8')
  .split(/\r?\n/)
  .map(l => l.trim())
  .filter(Boolean);

console.log(`Bắt đầu cào xe cho ${dsMa.length} mã OEM từ PartSouq...`);

const br = await chromium.connectOverCDP(CDP).catch(() => {
  console.error(`Không nối được Chrome CDP ${CDP}.`);
  process.exit(1);
});
const ctx = br.contexts()[0] || await br.newContext();
const pgTab = await ctx.newPage();

let tongXeMoi = 0;
let tongFitment = 0;

for (let i = 0; i < dsMa.length; i++) {
  const maGoc = dsMa[i];
  // Làm sạch mã để search: bỏ hậu tố -POS, -K, -WTA, -BH...
  const maTim = maGoc.replace(/-[A-Z0-9]+$/, '');

  try {
    await pgTab.goto(`https://partsouq.com/en/search/all?q=${encodeURIComponent(maTim)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await pgTab.waitForTimeout(1800);

    // Bấm a.compatibility-car
    const hasBtn = await pgTab.evaluate(() => {
      const el = document.querySelector('a.compatibility-car');
      if (el) { el.click(); return true; }
      return false;
    });

    if (!hasBtn) {
      console.log(`[${i+1}/${dsMa.length}] ${maGoc} -> Không có nút compatibility`);
      continue;
    }

    await pgTab.waitForTimeout(2500);

    // Lấy dữ liệu modal
    const data = await pgTab.evaluate(() => {
      const m = document.querySelector('.modal-content');
      if (!m) return null;
      const makeEl = m.querySelector('h4, .modal-title');
      const make = makeEl ? (makeEl.textContent.match(/Toyota|Lexus|Nissan|Mitsubishi|Mazda|Hyundai|Kia/i)?.[0] || 'Toyota') : 'Toyota';

      const tabs = [...m.querySelectorAll('ul.nav-tabs li a, ul.nav-pills li a')];
      const tabNames = tabs.map(t => t.textContent.trim());

      const results = [];
      const panes = [...m.querySelectorAll('.tab-pane')];
      panes.forEach((pane, idx) => {
        const modelName = tabNames[idx] || '';
        pane.querySelectorAll('table tbody tr').forEach(tr => {
          const tds = [...tr.querySelectorAll('td')].map(td => td.textContent.trim());
          if (tds.length >= 3) {
            results.push({
              make,
              modelName,
              market: tds[0],
              year: tds[1],
              modelCode: tds[2],
              engine: tds[3] || null,
              trans: tds[4] || null,
            });
          }
        });
      });
      return results;
    });

    if (!data || !data.length) {
      console.log(`[${i+1}/${dsMa.length}] ${maGoc} -> Modal không có dòng xe nào`);
      continue;
    }

    // Nạp xe vào catalog_vehicles
    let xeMoi = 0;
    for (const v of data) {
      const year = parseInt(v.year) || null;
      const upRes = await pool.query(`
        INSERT INTO catalog_vehicles (
          make, model_code, model_name, vehicle_type, year_from, year_to, engine, transmission, description, created_at, updated_at
        ) VALUES ($1, $2, $3, 'car', $4, $4, $5, $6, $7, NOW(), NOW())
        ON CONFLICT (make, model_code, variant_key) DO UPDATE SET
          model_name = COALESCE(catalog_vehicles.model_name, EXCLUDED.model_name),
          updated_at = NOW()
        RETURNING id, (xmax = 0) AS inserted
      `, [
        v.make,
        v.modelCode,
        v.modelName || null,
        year,
        v.engine,
        v.trans,
        v.market || null,
      ]);
      if (upRes.rows[0]?.inserted) xeMoi++;
    }
    tongXeMoi += xeMoi;
    console.log(`[${i+1}/${dsMa.length}] ${maGoc} -> Thu được ${data.length} biến thể xe (+${xeMoi} xe mới vào DB)`);

    await pgTab.waitForTimeout(CHO);
  } catch (err) {
    console.error(`[${i+1}/${dsMa.length}] ${maGoc} -> Lỗi:`, err.message);
  }
}

await pgTab.close();
br.close();
await pool.end();
console.log(`\nHoàn thành cào xe: Tổng cộng thêm ${tongXeMoi} xe mới vào catalog_vehicles.`);
