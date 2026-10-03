// Forward-only SQL migrations from apps/api/migrations/NNNN_name.sql. Each file runs once in its own
// transaction; an advisory lock serializes concurrent runners; editing an applied file is an error.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';

export const migrationsDir = join(import.meta.dirname, '..', '..', 'migrations');

// Arbitrary constant shared by every runner of this repository's migrations.
const MIGRATION_LOCK = 7_204_116_001;

export interface Migration {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

export function readMigrations(dir: string = migrationsDir): Migration[] {
  const migrations = readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => {
      const match = /^(\d{4})_([a-z0-9_]+)\.sql$/.exec(file);
      if (!match) throw new Error(`migration file name must be NNNN_lower_snake.sql: ${file}`);
      const sql = readFileSync(join(dir, file), 'utf8');
      return { version: Number(match[1]), name: file, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    });
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) throw new Error(`migrations must be numbered 0001.. without gaps: ${migration.name}`);
  });
  return migrations;
}

/** Apply pending migrations; returns the file names applied by this call. */
export async function migrate(client: pg.Client, migrations: Migration[] = readMigrations()): Promise<string[]> {
  await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK]);
  try {
    await client.query(`create table if not exists schema_migrations (
      version integer primary key,
      name text not null,
      checksum text not null,
      applied_at timestamptz not null default now()
    )`);
    const { rows } = await client.query<{ version: number; name: string; checksum: string }>(
      'select version, name, checksum from schema_migrations order by version',
    );
    for (const row of rows) {
      const file = migrations[row.version - 1];
      if (!file || file.name !== row.name) throw new Error(`database has migration ${row.name} that is not in this checkout`);
      if (file.checksum !== row.checksum) throw new Error(`applied migration ${row.name} was edited (checksum mismatch); add a new migration instead`);
    }
    const applied: string[] = [];
    for (const migration of migrations.slice(rows.length)) {
      await client.query('begin');
      try {
        await client.query(migration.sql);
        await client.query('insert into schema_migrations (version, name, checksum) values ($1, $2, $3)', [
          migration.version,
          migration.name,
          migration.checksum,
        ]);
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw new Error(`migration ${migration.name} failed: ${(error as Error).message}`, { cause: error });
      }
      applied.push(migration.name);
    }
    return applied;
  } finally {
    await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK]);
  }
}
