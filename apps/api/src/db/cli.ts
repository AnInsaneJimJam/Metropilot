// Database commands, run from the repository root via `pnpm db:preflight|db:migrate|db:seed|db:seed:live|db:prune`.
// prune is the scheduled audit retention job (D44); it also runs against hosted databases.
// The root scripts load .env with --env-file-if-exists; existing environment variables take precedence.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { ConfigError, databaseUrl, isLoopback, redactUrl, requireEnv } from '../config.ts';
import { migrate } from './migrate.ts';
import { seedLiveCatalog } from './live-catalog.ts';
import { seedPaper } from './seed.ts';

const repoRoot = join(import.meta.dirname, '..', '..', '..', '..');
const examplePassword = 'change-me-local-only';

/** Checks for the documented startup path; returns problems without printing any secret. */
export function preflight(env: NodeJS.ProcessEnv, root: string = repoRoot): string[] {
  const problems: string[] = [];
  const pinned = readFileSync(join(root, '.node-version'), 'utf8').trim();
  if (process.versions.node !== pinned) problems.push(`Node ${process.versions.node} is running; this repo pins ${pinned} (.node-version)`);
  if (!existsSync(join(root, '.env'))) problems.push('.env is missing; run `cp .env.example .env` and set POSTGRES_PASSWORD');
  try {
    const password = requireEnv(env, 'POSTGRES_PASSWORD');
    if (password === examplePassword) problems.push('POSTGRES_PASSWORD still has the example value; change it in .env');
    const url = databaseUrl(env);
    if (!isLoopback(url)) problems.push('DATABASE_URL must point at the local database (localhost/127.0.0.1)');
    if (decodeURIComponent(url.password) !== password) problems.push('DATABASE_URL password does not match POSTGRES_PASSWORD');
    if (decodeURIComponent(url.username) !== (env['POSTGRES_USER'] ?? 'monad')) problems.push('DATABASE_URL user does not match POSTGRES_USER');
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    problems.push(error.message);
  }
  return problems;
}

async function withClient(run: (client: pg.Client, url: URL) => Promise<void>): Promise<void> {
  const url = databaseUrl(process.env);
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    await run(client, url);
  } finally {
    await client.end();
  }
}

/** Audit retention in days from AUDIT_RETENTION_DAYS; security.md keeps paper run summaries 30 days. */
export function retentionDays(env: NodeJS.ProcessEnv): number {
  const raw = env['AUDIT_RETENTION_DAYS'] ?? '30';
  if (!/^[1-9][0-9]{0,3}$/.test(raw)) throw new ConfigError('AUDIT_RETENTION_DAYS must be a whole number of days from 1 to 9999');
  return Number(raw);
}

/** Prune each tenant's audit stream in its own transaction, so appends for other tenants never wait on it. */
export async function pruneAudit(client: pg.Client | pg.Pool, days: number, now: Date = new Date()): Promise<{ tenants: number; removed: number }> {
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  const { rows } = await client.query<{ tenant_id: string }>('select tenant_id from tenant_streams where last_sequence > retained_after order by tenant_id');
  let removed = 0;
  for (const row of rows) {
    const result = await client.query<{ removed: string }>('select prune_audit_events($1, $2) as removed', [row.tenant_id, cutoff]);
    removed += Number(result.rows[0]!.removed);
  }
  return { tenants: rows.length, removed };
}

const commands: Record<string, () => Promise<void>> = {
  async preflight() {
    const problems = preflight(process.env);
    if (problems.length > 0) throw new ConfigError(`preflight failed:\n- ${problems.join('\n- ')}`);
    console.log('preflight ok');
  },
  migrate: () =>
    withClient(async (client, url) => {
      const applied = await migrate(client);
      console.log(`${redactUrl(url)}: ${applied.length === 0 ? 'already up to date' : `applied ${applied.join(', ')}`}`);
    }),
  seed: () =>
    withClient(async (client, url) => {
      // Synthetic paper data must never land in a shared or hosted database.
      if (!isLoopback(url)) throw new ConfigError('refusing to seed a non-local database');
      await seedPaper(client);
      console.log(`${redactUrl(url)}: paper seed data present`);
    }),
  'seed-live': () =>
    withClient(async (client, url) => {
      // Real Monad testnet and mainnet network, asset and route entries (verified addresses); no accounts or secrets.
      await seedLiveCatalog(client);
      console.log(`${redactUrl(url)}: Monad testnet and mainnet live catalogs present`);
    }),
  prune: () =>
    withClient(async (client, url) => {
      const days = retentionDays(process.env);
      const { tenants, removed } = await pruneAudit(client, days);
      console.log(`${redactUrl(url)}: removed ${removed} audit events older than ${days} days across ${tenants} tenant streams`);
    }),
};

if (import.meta.main) {
  const command = commands[process.argv[2] ?? ''];
  if (!command) {
    console.error(`usage: cli.ts ${Object.keys(commands).join('|')}`);
    process.exit(2);
  }
  try {
    await command();
  } catch (error) {
    // pg connection errors can include the host but never the password; config errors never include values.
    console.error(error instanceof Error ? error.message : 'command failed');
    process.exit(1);
  }
}
