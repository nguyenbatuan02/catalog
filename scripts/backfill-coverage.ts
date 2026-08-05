/**
 * backfill-coverage.ts — Tính coverage_score cho các job đã done nhưng chưa check.
 * KHÔNG auto-requeue (runCoverageCheck chỉ tính + lưu). Chạy 1 lần sau khi deploy.
 *
 * CHẠY:  npx tsx scripts/backfill-coverage.ts
 *   (dùng tsx vì import module .ts của project; `node` thường sẽ không resolve được)
 */
import 'dotenv/config';
import pg from 'pg';
import { runCoverageCheck } from '../src/modules/catalog/coverage-check.js';

const pool = new pg.Pool({
  host    : process.env.DB_HOST     || 'localhost',
  port    : Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME     || 'zalocrm',
  user    : process.env.DB_USER     || 'crmuser',
  password: process.env.DB_PASSWORD || 'devpassword',
  max     : 4,
});

const CONCURRENCY = 3;   // nhẹ nhàng với pool (chung với worker cào); mỗi query coverage khá nặng

const RESCORE_ALL = process.argv.includes('--all');   // --all = rescore MỌI job done (đổi pattern); mặc định chỉ job chưa có score

async function main() {
  const { rows: jobs } = await pool.query(`
    SELECT id, make, model_line FROM catalog_crawl_jobs
    WHERE status = 'done' AND model_line IS NOT NULL AND model_line <> ''
      ${RESCORE_ALL ? '' : 'AND coverage_score IS NULL'}
    ORDER BY parts_found DESC
    LIMIT 5000
  `);
  console.log(RESCORE_ALL ? '(--all) rescore toàn bộ job done' : '(chỉ job chưa có coverage_score)');
  console.log(`Backfill coverage cho ${jobs.length} job done...`);

  let done = 0, idx = 0;
  const runners = Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, async () => {
    while (idx < jobs.length) {
      const j = jobs[idx++];
      await runCoverageCheck(pool, j.id, j.make, j.model_line);
      done++;
      if (done % 25 === 0 || done === jobs.length) console.log(`  ${done}/${jobs.length}`);
    }
  });
  await Promise.all(runners);

  console.log('XONG backfill.');
  await pool.end();
}

main().catch(async e => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });
