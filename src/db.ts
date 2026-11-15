import pg from 'pg';

let pool: pg.Pool | undefined;

/** Builds the pool config. Neon URLs carry sslmode=require; we strip it and set ssl explicitly so certificates are verified. */
function poolConfig(url: string): pg.PoolConfig {
  const parsed = new URL(url);
  const sslmode = parsed.searchParams.get('sslmode');
  const needsSsl = (sslmode !== null && sslmode !== 'disable') || parsed.hostname.endsWith('.neon.tech');
  parsed.searchParams.delete('sslmode');
  parsed.searchParams.delete('channel_binding');
  return {
    connectionString: parsed.toString(),
    ssl: needsSsl ? { rejectUnauthorized: true } : undefined,
    max: 5,
    idleTimeoutMillis: 10_000,
  };
}

export function getPool(): pg.Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    pool = new pg.Pool(poolConfig(url));
  }
  return pool;
}

export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    const p = pool;
    pool = undefined;
    await p.end();
  }
}
