import pg from 'pg';

export const pool = new pg.Pool({
  host    : process.env.DB_HOST     || 'localhost',
  port    : Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME     || 'zalocrm',
  user    : process.env.DB_USER     || 'crmuser',
  password: process.env.DB_PASSWORD || 'devpassword',
  max     : Number(process.env.DB_MAX_CONNECTIONS) || 20,   // đủ cho nhiều VPS submit đồng thời
  idleTimeoutMillis      : 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  console.error('[DB] Pool error:', err.message);
});

export async function testConnection(): Promise<void> {
  const client = await pool.connect();
  await client.query('SELECT 1');
  client.release();
  console.log('[DB] Connected to PostgreSQL OK');
}