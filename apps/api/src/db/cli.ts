// Local/CI database commands, run from the repository root via `pnpm db:preflight|db:migrate|db:seed`.
// The root scripts load .env with --env-file-if-exists; existing environment variables take precedence.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { ConfigError, databaseUrl, isLoopback, redactUrl, requireEnv } from '../config.ts';
import { migrate } from './migrate.ts';
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
