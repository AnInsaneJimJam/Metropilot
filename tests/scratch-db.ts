// Test support: a scratch PostgreSQL database with every migration and the paper seed, dropped afterwards.
// Synthetic data only. Skips through databaseSkip() when no database is configured, unless REQUIRE_DB=1.
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { migrate } from '../apps/api/src/db/migrate.ts';
import { seedPaper } from '../apps/api/src/db/seed.ts';

export { databaseSkip } from '../apps/executor/src/testing.ts';
export const SEED_TENANT = '019a0000-0000-7000-8000-000000000000';

export interface ScratchDb {
  readonly pool: pg.Pool;
  readonly url: string;
  /** Run fn in one transaction on its own connection; rolls back on throw. */
  tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T>;
  drop(): Promise<void>;
}

export async function scratchDb(prefix: string, max = 12): Promise<ScratchDb> {
  const adminUrl = process.env['DATABASE_URL']!;
  const name = `${prefix}_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database ${name}`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  await migrate(client);
  await seedPaper(client);
  await client.end();
  const pool = new pg.Pool({ connectionString: url.toString(), max });
  pool.on('connect', (c) => c.on('error', () => undefined));
  pool.on('error', () => undefined);
  return {
    pool, url: url.toString(),
    async tx(fn) {
      const c = await pool.connect();
      try {
        await c.query('begin');
        const result = await fn(c);
        await c.query('commit');
        return result;
      } catch (error) {
        await c.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        c.release();
      }
    },
    async drop() {
      await pool.end();
      await admin.query(`drop database if exists ${name} with (force)`);
      await admin.end();
    },
  };
}
