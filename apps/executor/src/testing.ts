// Test support: a scratch PostgreSQL database with all migrations, a real executor HTTP server on loopback,
// an in-memory deployment AuthoritySource and a recorded market. Synthetic paper data only; never imported
// by the service. Migrations and seed come from the caller so this module does not import another app.
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { contentHash } from '@monad-hack/contracts';
import type { Strategy } from '@monad-hack/contracts';
import type { AuthoritySource, DeploymentAuthority } from './authorization.ts';
import { signCapability } from './capability.ts';
import type { Capability } from './capability.ts';
import { uuidv7 } from './ids.ts';
import { createExecutor } from './index.ts';
import type { ExecutorWiring } from './index.ts';
import type { MarketData, RecordedQuote } from './paper.ts';
import type { ExecutorService } from './service.ts';

export const PAPER_NETWORK = 'paper-monad';
export const SEED_TENANT = '019a0000-0000-7000-8000-000000000000';

/** Skip reason when no database is configured, unless REQUIRE_DB=1 (CI). */
export async function databaseSkip(): Promise<string | false> {
  const url = process.env['DATABASE_URL'];
  const required = process.env['REQUIRE_DB'] === '1';
  if (!url) {
    if (required) throw new Error('REQUIRE_DB=1 but DATABASE_URL is not set');
    return 'DATABASE_URL is not set';
  }
  const probe = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  try {
    await probe.connect();
    return false;
  } catch (error) {
    if (required) throw error;
    return `database unreachable (${(error as Error).message})`;
  } finally {
    await probe.end().catch(() => undefined);
  }
}

export class InMemoryAuthority implements AuthoritySource {
  readonly deployments = new Map<string, DeploymentAuthority>();
  unavailable = false;
  async current(tenantId: string, deploymentId: string): Promise<DeploymentAuthority | undefined> {
    if (this.unavailable) throw new Error('authority unavailable');
    const found = this.deployments.get(deploymentId);
    return found?.tenantId === tenantId ? found : undefined;
  }
  set(deploymentId: string, change: Partial<DeploymentAuthority>): void {
    this.deployments.set(deploymentId, { ...this.deployments.get(deploymentId)!, ...change });
  }
}

/** Recorded WETH/USD market: `price` USD per WETH as an integer, 18 and 6 decimals. */
export class RecordedMarket implements MarketData {
  price = 2500n;
  observedAt: (() => string) | undefined = () => new Date().toISOString();
  unavailable = false;
  async quote(tokenInRef: string, tokenOutRef: string): Promise<RecordedQuote | undefined> {
    if (this.unavailable) throw new Error('market unavailable');
    const at = this.observedAt?.();
    if (!at) return undefined;
    const base = { source: 'recorded:test-market', tokenInRef, tokenOutRef, observedAt: at };
    if (tokenInRef === 'paper.WETH' && tokenOutRef === 'paper.USD') return { ...base, rateNumerator: this.price * 10n ** 6n, rateDenominator: 10n ** 18n };
    if (tokenInRef === 'paper.USD' && tokenOutRef === 'paper.WETH') return { ...base, rateNumerator: 10n ** 18n, rateDenominator: this.price * 10n ** 6n };
    return undefined;
  }
}

export interface ArrangeOptions {
  readonly strategy: Strategy;
  readonly policyLimits?: Record<string, unknown>;
  readonly balances?: Readonly<Record<string, bigint>>;
}

export interface Arranged {
  readonly tenantId: string;
  readonly agentId: string;
  readonly deploymentId: string;
  readonly generation: string;
  readonly runId: string;
  readonly simulationAccountId: string;
  /** Mint an executor capability for this deployment; overrides narrow or corrupt it for negative tests. */
  capability(overrides?: Partial<Capability>): string;
}

export interface HarnessSetup {
  /** Apply every migration to the client's database. */
  readonly migrate: (client: pg.Client) => Promise<unknown>;
  /** Load the synthetic paper seed (catalog, seed tenant). */
  readonly seed: (client: pg.Client) => Promise<unknown>;
  readonly wiring?: Partial<Pick<ExecutorWiring, 'dispatchInline' | 'now' | 'platformLimits' | 'maxQuoteAgeSeconds'>>;
}

interface HarnessParts {
  readonly authority: InMemoryAuthority;
  readonly market: RecordedMarket;
  readonly secret: Buffer;
  readonly pool: pg.Pool;
  readonly service: ExecutorService;
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}

export class ExecutorTestHarness {
  readonly authority: InMemoryAuthority;
  readonly market: RecordedMarket;
  readonly secret: Buffer;
  readonly pool: pg.Pool;
  readonly service: ExecutorService;
  readonly baseUrl: string;
  readonly #close: () => Promise<void>;

  private constructor(parts: HarnessParts) {
    this.authority = parts.authority;
    this.market = parts.market;
    this.secret = parts.secret;
    this.pool = parts.pool;
    this.service = parts.service;
    this.baseUrl = parts.baseUrl;
    this.#close = parts.close;
  }

  static async start(setup: HarnessSetup): Promise<ExecutorTestHarness> {
    const adminUrl = process.env['DATABASE_URL']!;
    const name = `executor_test_${randomBytes(6).toString('hex')}`;
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`create database ${name}`);
    const url = new URL(adminUrl);
    url.pathname = `/${name}`;
    const client = new pg.Client({ connectionString: url.toString() });
    await client.connect();
    await setup.migrate(client);
    await setup.seed(client);
    await client.end();
    const pool = new pg.Pool({ connectionString: url.toString(), max: 8 });

    const authority = new InMemoryAuthority();
    const market = new RecordedMarket();
    const secret = randomBytes(32);
    const { service, server } = createExecutor({
      pool, authority, market, capabilitySecret: secret,
      platformLimits: { maxSlippageBps: 300, dailyActionCount: 1000 }, maxQuoteAgeSeconds: 60, ...setup.wiring,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const close = async (): Promise<void> => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.end();
      await admin.query(`drop database if exists ${name} with (force)`);
      await admin.end();
    };
    return new ExecutorTestHarness({ authority, market, secret, pool, service, baseUrl: `http://127.0.0.1:${port}`, close });
  }

  async stop(): Promise<void> {
    await this.#close();
  }

  /** A fresh agent, approved revision, policy, simulation account and active paper deployment with one run. */
  async arrange(options: ArrangeOptions): Promise<Arranged> {
    const agentId = uuidv7();
    const revisionId = uuidv7();
    const deploymentId = uuidv7();
    const simulationAccountId = uuidv7();
    const tenantId = SEED_TENANT;
    await this.pool.query(`insert into agents (tenant_id, id, name) values ($1, $2, 'executor test agent')`, [tenantId, agentId]);
    await this.pool.query(
      `insert into strategy_revisions (tenant_id, id, agent_id, language_version, content_hash, ast, validation)
       values ($1, $2, $3, 'strategy/1', $4, $5, '{"schema":"valid"}')`,
      [tenantId, revisionId, agentId, await contentHash(options.strategy), options.strategy],
    );
    await this.pool.query('insert into policies (tenant_id, agent_id, version, limits) values ($1, $2, 1, $3)', [
      tenantId, agentId, options.policyLimits ?? { maxSlippageBps: 50, dailyActionCount: 24 },
    ]);
    await this.pool.query('insert into simulation_accounts (tenant_id, id, agent_id, session) values ($1, $2, $3, 1)', [tenantId, simulationAccountId, agentId]);
    const balances = options.balances ?? { 'paper.WETH': 2n * 10n ** 18n, 'paper.USD': 10_000n * 10n ** 6n };
    for (const [asset, amount] of Object.entries(balances)) {
      await this.pool.query('insert into simulation_balances (tenant_id, account_id, asset_ref, available) values ($1, $2, $3, $4)', [tenantId, simulationAccountId, asset, amount.toString()]);
    }
    this.authority.deployments.set(deploymentId, {
      tenantId, agentId, deploymentId, generation: '1', mode: 'paper', desiredState: 'active', strategyRevisionId: revisionId,
      policyVersion: 1, networkRef: PAPER_NETWORK, connectorPins: { 'paper.uniswap': '1.0.0' }, simulationAccountId,
    });
    const runId = '0x' + randomBytes(32).toString('hex');
    const capability = (overrides: Partial<Capability> = {}): string => {
      const iat = Math.floor(Date.now() / 1000);
      return signCapability({
        aud: 'executor', tenantId, agentId, deploymentId, generation: this.authority.deployments.get(deploymentId)!.generation, mode: 'paper',
        actions: ['swap.exactInput'], connectors: { 'paper.uniswap': '1.0.0' }, runId, iat, exp: iat + 300, jti: uuidv7(), ...overrides,
      }, this.secret);
    };
    return { tenantId, agentId, deploymentId, generation: '1', runId, simulationAccountId, capability };
  }

  async balance(accountId: string, asset: string): Promise<{ available: bigint; held: bigint }> {
    const { rows } = await this.pool.query<{ available: string; held: string }>('select available, held from simulation_balances where account_id = $1 and asset_ref = $2', [accountId, asset]);
    return { available: BigInt(rows[0]?.available ?? '0'), held: BigInt(rows[0]?.held ?? '0') };
  }

  /** Raw HTTP POST of an intent with the capability; returns status and parsed JSON. */
  async post(body: unknown, capability: string | undefined, headers: Record<string, string> = {}): Promise<{ status: number; json: Record<string, unknown> }> {
    const key = (body as { logicalKey?: string }).logicalKey ?? '';
    const response = await fetch(`${this.baseUrl}/internal/v1/intents`, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'content-type': 'application/json', 'x-request-id': uuidv7(), 'idempotency-key': key,
        ...(capability ? { authorization: `Bearer ${capability}` } : {}), ...headers,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  async get(intentId: string, capability: string): Promise<{ status: number; json: Record<string, unknown> }> {
    const response = await fetch(`${this.baseUrl}/internal/v1/intents/${intentId}`, { headers: { authorization: `Bearer ${capability}` }, redirect: 'error' });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }
}
