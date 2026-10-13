// G1 database checks against a real Postgres: migrations, paper seed data for the spec examples,
// tenant-scoped references and immutability. Each run uses a throwaway database.
// Skips when DATABASE_URL is unset or unreachable, unless REQUIRE_DB=1 (CI and `pnpm bootstrap`).
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import pg from 'pg';
import { contentHash, validate } from '@monad-hack/contracts';
import { migrate, readMigrations } from './migrate.ts';
import { liveCatalog, seedLiveCatalog } from './live-catalog.ts';
import { paperSeed, seedPaper, seedTenantId } from './seed.ts';

const required = process.env['REQUIRE_DB'] === '1';
let skip: string | false = false;
let admin: pg.Client | undefined;
if (!process.env['DATABASE_URL']) skip = 'DATABASE_URL is not set';
else {
  admin = new pg.Client({ connectionString: process.env['DATABASE_URL'], connectionTimeoutMillis: 3000 });
  try {
    await admin.connect();
  } catch (error) {
    if (required) throw error;
    skip = `database unreachable (${(error as Error).message})`;
    admin = undefined;
  }
}
if (skip && required) throw new Error(`REQUIRE_DB=1 but ${skip}`);

const scratchDatabases: string[] = [];
async function scratchClient(): Promise<pg.Client> {
  const name = `g1_test_${randomBytes(6).toString('hex')}`;
  await admin!.query(`create database ${name}`);
  scratchDatabases.push(name);
  const url = new URL(process.env['DATABASE_URL']!);
  url.pathname = `/${name}`;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  return client;
}
const clients: pg.Client[] = [];
async function freshClient(): Promise<pg.Client> {
  const client = await scratchClient();
  clients.push(client);
  return client;
}

async function rejects(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: { code?: string }) => {
    assert.equal(error.code, code);
    return true;
  });
}

async function marketReadFixture(client: pg.Client): Promise<{runId:string;operationKey:string}> {
  await seedPaper(client);
  const {agentId,strategyRevisionId}=paperSeed().request;
  const account='019a0000-0000-7000-8000-0000000002f1',deployment='019a0000-0000-7000-8000-0000000002f2';
  const hash='0x'+'d1'.repeat(32),runId='0x'+'d2'.repeat(32),operationKey='0x'+'d3'.repeat(32);
  await client.query('insert into simulation_accounts (tenant_id,id,agent_id,session) values ($1,$2,$3,21)',[seedTenantId,account,agentId]);
  await client.query(`insert into deployments (tenant_id,id,agent_id,strategy_revision_id,mode,strategy_hash,catalog_hash,connector_versions,runtime_image_digest,network_ref,policy_version,budget_version,resource_profile_ref,simulation_account_id,desired_state)
    values ($1,$2,$3,$4,'paper',$5,$5,'{}',$5,'paper-monad',1,1,'paper-small-v1',$6,'stopped')`,[seedTenantId,deployment,agentId,strategyRevisionId,hash,account]);
  await client.query(`insert into runs (tenant_id,run_id,deployment_id,generation,deployment_revision,trigger_id,source_event_key,trigger)
    values ($1,$2,$3,1,'revision/1','crossing','fixture:market-read','{}')`,[seedTenantId,runId,deployment]);
  await client.query(`insert into run_operations (tenant_id,run_id,operation_key,kind,node_id,iteration_path) values ($1,$2,$3,'read','read_market','[]')`,[seedTenantId,runId,operationKey]);
  return {runId,operationKey};
}

describe('database', { skip }, () => {
  let db: pg.Client;
  before(async () => {
    db = await freshClient();
  });
  after(async () => {
    for (const client of clients) await client.end();
    for (const name of scratchDatabases) await admin!.query(`drop database if exists ${name} with (force)`);
    await admin!.end();
  });

  test('migrations apply once and re-running applies nothing', async () => {
    assert.deepEqual(await migrate(db), readMigrations().map((m) => m.name));
    assert.deepEqual(await migrate(db), []);
  });

  test('an edited applied migration is refused', async () => {
    const edited = readMigrations().map((m) => ({ ...m, checksum: m.checksum.replace(/^./, (c) => (c === '0' ? '1' : '0')) }));
    await assert.rejects(migrate(db, edited), /was edited/);
  });

  test('concurrent runners apply each migration exactly once', async () => {
    const [a, b] = [await freshClient(), await freshClient()];
    // Same database for both runners.
    const { rows } = await a.query<{ db: string }>('select current_database() as db');
    const url = new URL(process.env['DATABASE_URL']!);
    url.pathname = `/${rows[0]!.db}`;
    await b.end();
    const second = new pg.Client({ connectionString: url.toString() });
    await second.connect();
    clients.push(second);
    const results = await Promise.all([migrate(a), migrate(second)]);
    assert.deepEqual(results.flat(), readMigrations().map((m) => m.name));
  });

  test('migration files are numbered without gaps', () => {
    const dir = mkdtempSync(join(tmpdir(), 'migrations-'));
    writeFileSync(join(dir, '0001_a.sql'), 'select 1;');
    writeFileSync(join(dir, '0003_c.sql'), 'select 1;');
    assert.throws(() => readMigrations(dir), /without gaps/);
  });

  test('paper seed is idempotent', async () => {
    await seedPaper(db);
    await seedPaper(db);
    const { rows } = await db.query<{ count: string }>('select count(*) from catalog_versions');
    assert.equal(rows[0]!.count, String(paperSeed().catalog.length));
  });

  test('every row and catalog entry the deployment/1 example references exists for one tenant', async () => {
    const { request } = paperSeed();
    const one = async (sql: string, params: unknown[]) => (await db.query(sql, params)).rowCount;
    assert.equal(await one('select 1 from agents where tenant_id = $1 and id = $2 and budget_version = $3', [seedTenantId, request.agentId, request.budgetVersion]), 1);
    assert.equal(await one('select 1 from strategy_revisions where tenant_id = $1 and agent_id = $2 and id = $3', [seedTenantId, request.agentId, request.strategyRevisionId]), 1);
    assert.equal(await one('select 1 from estimates where tenant_id = $1 and agent_id = $2 and id = $3 and strategy_revision_id = $4', [seedTenantId, request.agentId, request.estimateId, request.strategyRevisionId]), 1);
    assert.equal(await one('select 1 from policies where tenant_id = $1 and agent_id = $2 and version = $3', [seedTenantId, request.agentId, request.policyVersion]), 1);
    assert.equal(await one(`select distinct ref from catalog_versions where kind = 'network' and ref = $1 and $2 = any(modes)`, [request.networkRef, request.mode]), 1);
    assert.equal(await one(`select distinct ref from catalog_versions where kind = 'resourceProfile' and ref = $1 and $2 = any(modes)`, [request.resourceProfileRef, request.mode]), 1);
    for (const selection of request.connectorSelections) {
      const { rows } = await db.query<{ definition: { capabilities: string[] } }>(
        `select definition from catalog_versions where kind = 'connector' and ref = $1 and version = $2`,
        [selection.ref, selection.version],
      );
      for (const capability of selection.capabilities) assert.ok(rows[0]?.definition.capabilities.includes(capability), capability);
    }
  });

  test('every catalog ref in the strategy/1 example resolves', async () => {
    const { strategy } = paperSeed();
    const refs = new Set<string>();
    for (const trigger of strategy.triggers) {
      if ('feedRef' in trigger) refs.add(trigger.feedRef).add(trigger.threshold.baseAssetRef);
      for (const statement of trigger.body) {
        if (statement.type === 'swap.exactInput') refs.add(statement.connectorRef).add(statement.tokenInRef).add(statement.tokenOutRef);
      }
    }
    const { rows } = await db.query<{ ref: string }>('select distinct ref from catalog_versions where ref = any($1)', [[...refs]]);
    assert.deepEqual(rows.map((row) => row.ref).sort(), [...refs].sort());
  });

  test('stored revision AST is schema-valid and its hash is the JCS SHA-256', async () => {
    const { rows } = await db.query<{ ast: unknown; content_hash: string }>('select ast, content_hash from strategy_revisions');
    assert.equal(rows.length, 1);
    assert.ok(validate('strategy', rows[0]!.ast).ok);
    assert.equal(rows[0]!.content_hash, await contentHash(rows[0]!.ast));
  });

  test('paper asset identities are valid contract shapes', async () => {
    const { rows } = await db.query<{ definition: { identity: unknown } }>(`select definition from catalog_versions where kind = 'asset'`);
    for (const row of rows) assert.ok(validate('assetIdentity', row.definition.identity).ok);
  });

  test('live catalog: idempotent, valid on-chain identities, and found by the executor catalog query', async () => {
    const live = await freshClient();
    await migrate(live);
    await seedLiveCatalog(live);
    await seedLiveCatalog(live);
    const { rows } = await live.query<{ ref: string; definition: { identity: unknown } }>(`select ref, definition from catalog_versions where kind = 'asset' and 'live' = any(modes) order by ref`);
    assert.deepEqual(rows.map((r) => r.ref), ['mainnet.MON', 'mainnet.USDC', 'mainnet.WMON', 'testnet.MON', 'testnet.USDC', 'testnet.WMON']);
    for (const row of rows) assert.ok(validate('assetIdentity', row.definition.identity).ok, row.ref);
    // Same predicate as the executor store's catalogAllows for live assets.
    const allowed = await live.query(
      `select distinct ref from catalog_versions where kind = 'asset' and ref = any($1) and 'live' = any(modes) and disabled_reason is null
         and definition -> 'identity' ->> 'kind' = any($2) and definition -> 'identity' ->> 'networkRef' = 'monad-mainnet'`,
      [['mainnet.MON', 'mainnet.WMON', 'mainnet.USDC', 'testnet.MON'], ['erc20', 'native']]);
    assert.equal(allowed.rowCount, 3, 'a testnet asset never resolves on mainnet');
    const connector = await live.query(
      `select 1 from catalog_versions where kind = 'connector' and ref = 'mainnet.uniswap-v3' and version = '1.0.0' and 'live' = any(modes)
         and disabled_reason is null and definition ->> 'networkRef' = 'monad-mainnet' and definition -> 'capabilities' ? 'swap.exactInput'`);
    assert.equal(connector.rowCount, 1);
    assert.equal((await live.query('select count(*)::int as n from catalog_versions')).rows[0].n, liveCatalog().length);
  });

  describe('tenant-scoped references', () => {
    const otherTenant = '019a0000-0000-7000-8000-0000000000aa';
    const otherAgent = '019a0000-0000-7000-8000-0000000000ab';
    before(async () => {
      await db.query(`insert into tenants (id, auth_subject) values ($1, 'synthetic|other')`, [otherTenant]);
      await db.query(`insert into agents (tenant_id, id, name) values ($1, $2, 'Other agent')`, [otherTenant, otherAgent]);
    });

    test('a revision cannot attach to another tenant’s agent', async () => {
      const { request, strategy } = paperSeed();
      await rejects(
        db.query(
          `insert into strategy_revisions (tenant_id, id, agent_id, language_version, content_hash, ast, validation)
           values ($1, '019a0000-0000-7000-8000-0000000000ac', $2, 'strategy/1', $3, $4, '{}')`,
          [otherTenant, request.agentId, '0x' + 'ab'.repeat(32), strategy],
        ),
        '23503',
      );
    });

    test('an estimate cannot reference a revision of a different agent', async () => {
      const { request } = paperSeed();
      await db.query(`insert into agents (tenant_id, id, name) values ($1, '019a0000-0000-7000-8000-0000000000ad', 'Second agent')`, [seedTenantId]);
      await rejects(
        db.query(
          `insert into estimates (tenant_id, id, agent_id, strategy_revision_id, assumptions, created_at, expires_at)
           values ($1, '019a0000-0000-7000-8000-0000000000ae', '019a0000-0000-7000-8000-0000000000ad', $2, '{}', now(), now() + interval '5 minutes')`,
          [seedTenantId, request.strategyRevisionId],
        ),
        '23503',
      );
    });

    test('a policy cannot be created for another tenant’s agent', async () => {
      await rejects(db.query(`insert into policies (tenant_id, agent_id, version, limits) values ($1, $2, 1, '{}')`, [seedTenantId, otherAgent]), '23503');
    });

    test('a simulation account cannot attach to another tenant’s agent', async () => {
      await rejects(db.query(`insert into simulation_accounts (tenant_id, id, agent_id, session) values ($1, '019a0000-0000-7000-8000-0000000000af', $2, 1)`, [seedTenantId, otherAgent]), '23503');
    });

    test('identities (0007): one tenant per provider subject; a session cannot name another tenant', async () => {
      await db.query(`insert into identities (provider, subject, tenant_id) values ('privy', 'did:privy:cm0dbcheck00001', $1)`, [otherTenant]);
      await rejects(db.query(`insert into identities (provider, subject, tenant_id) values ('privy', 'did:privy:cm0dbcheck00001', $1)`, [seedTenantId]), '23505');
      const session = (tenant: string, hash = randomBytes(32), expires = "now() + interval '1 hour'") =>
        db.query(`insert into sessions (token_hash, tenant_id, provider, subject, expires_at) values ($1, $2, 'privy', 'did:privy:cm0dbcheck00001', ${expires})`, [hash, tenant]);
      await rejects(session(seedTenantId), '23503');
      await rejects(session(otherTenant, randomBytes(16)), '23514');
      await rejects(session(otherTenant, randomBytes(32), 'now()'), '23514');
      await session(otherTenant);
    });

    test('IDs must be UUIDv7', async () => {
      await rejects(db.query(`insert into tenants (id, auth_subject) values ('3f2b8c1e-9d4a-4f6b-8e2c-1a2b3c4d5e6f', 'synthetic|v4')`), '23514');
    });
  });

  describe('runtime control (0003, 0005)', () => {
    const H = (b: string) => '0x' + b.repeat(32);
    const deployment = '019a0000-0000-7000-8000-0000000002d1';
    const account = '019a0000-0000-7000-8000-0000000002d9';
    const runId = H('7a');
    before(async () => {
      await seedPaper(db);
      const { agentId, strategyRevisionId } = paperSeed().request;
      await db.query('insert into simulation_accounts (tenant_id, id, agent_id, session) values ($1, $2, $3, 9)', [seedTenantId, account, agentId]);
      await db.query(
        `insert into deployments (tenant_id, id, agent_id, strategy_revision_id, mode, strategy_hash, catalog_hash, connector_versions, runtime_image_digest, network_ref, policy_version, budget_version, resource_profile_ref, simulation_account_id)
         values ($1, $2, $3, $4, 'paper', $5, $5, '{}', $5, 'paper-monad', 1, 1, 'paper-small-v1', $6)`,
        [seedTenantId, deployment, agentId, strategyRevisionId, H('aa'), account],
      );
      await db.query(
        `insert into runs (tenant_id, run_id, deployment_id, generation, deployment_revision, trigger_id, source_event_key, trigger)
         values ($1, $2, $3, 1, 'rev/1', 'crossing', 'e1', '{}')`,
        [seedTenantId, runId, deployment],
      );
    });

    test('a deployment cannot pin another agent\'s revision or another tenant\'s', async () => {
      const { strategyRevisionId } = paperSeed().request;
      await rejects(
        db.query(
          `insert into deployments (tenant_id, id, agent_id, strategy_revision_id, mode, strategy_hash, catalog_hash, connector_versions, runtime_image_digest, network_ref, policy_version, budget_version, resource_profile_ref, simulation_account_id)
           values ($1, '019a0000-0000-7000-8000-0000000002d2', '019a0000-0000-7000-8000-0000000002d3', $2, 'paper', $3, $3, '{}', $3, 'paper-monad', 1, 1, 'paper-small-v1', $4)`,
          [seedTenantId, strategyRevisionId, H('aa'), account],
        ),
        '23503',
      );
    });

    test('catalog pins (0006): a deployment-manifest/2 must carry its catalog pins; /1 stays valid', async () => {
      const set = (manifest: unknown) => db.query('update deployments set manifest = $2 where id = $1', [deployment, manifest]);
      await rejects(set({}), '23514');
      await rejects(set({ schemaVersion: 'deployment-manifest/2' }), '23514');
      await rejects(set({ schemaVersion: 'deployment-manifest/2', catalogPins: [] }), '23514');
      await rejects(set({ schemaVersion: 'deployment-manifest/3', catalogPins: [{}] }), '23514');
      await set({ schemaVersion: 'deployment-manifest/2', catalogPins: [{ kind: 'network', ref: 'paper-monad', version: '1.1.0', contentHash: H('ab') }] });
      await set({ schemaVersion: 'deployment-manifest/1' });
      await set(null);
    });

    test('run identities are 0x SHA-256 and unique; fencing tokens are unique per run', async () => {
      await rejects(db.query(`insert into runs (tenant_id, run_id, deployment_id, generation, deployment_revision, trigger_id, source_event_key, trigger) values ($1, 'run-1', $2, 1, 'r', 't', 'e', '{}')`, [seedTenantId, deployment]), '23514');
      await rejects(db.query(`insert into runs (tenant_id, run_id, deployment_id, generation, deployment_revision, trigger_id, source_event_key, trigger) values ($1, $2, $3, 1, 'r', 't', 'e', '{}')`, [seedTenantId, runId, deployment]), '23505');
      await db.query(`insert into run_assignments (assignment_id, tenant_id, run_id, fencing_token) values ('019a0000-0000-7000-8000-0000000002e1', $1, $2, 1)`, [seedTenantId, runId]);
      await rejects(db.query(`insert into run_assignments (assignment_id, tenant_id, run_id, fencing_token) values ('019a0000-0000-7000-8000-0000000002e2', $1, $2, 1)`, [seedTenantId, runId]), '23505');
    });

    test('lifecycle (0005): one open deployment per agent, paper needs its account, audit events are immutable', async () => {
      const { agentId, strategyRevisionId } = paperSeed().request;
      await rejects(
        db.query(
          `insert into deployments (tenant_id, id, agent_id, strategy_revision_id, mode, strategy_hash, catalog_hash, connector_versions, runtime_image_digest, network_ref, policy_version, budget_version, resource_profile_ref, simulation_account_id)
           values ($1, '019a0000-0000-7000-8000-0000000002d4', $2, $3, 'paper', $4, $4, '{}', $4, 'paper-monad', 1, 1, 'paper-small-v1', $5)`,
          [seedTenantId, agentId, strategyRevisionId, H('aa'), account],
        ),
        '23505',
      );
      await rejects(db.query(`update deployments set simulation_account_id = null where id = $1`, [deployment]), '23514');
      await rejects(db.query(`update deployments set desired_state = 'running' where id = $1`, [deployment]), '23514');
      await db.query(
        `insert into audit_events (tenant_id, sequence, agent_id, actor_kind, trace_id, type, payload, occurred_at, source)
         values ($1, 1, $2, 'controlPlane', $3, 'run.stateChanged', '{}', now(), 'test:1')`,
        [seedTenantId, agentId, 'ab'.repeat(16)],
      );
      await rejects(db.query(`delete from audit_events where source = 'test:1'`), 'P0001');
      await rejects(db.query(`insert into audit_events (tenant_id, sequence, actor_kind, trace_id, type, payload, occurred_at, source) values ($1, 2, 'user', $2, 'run.step', '{}', now(), 'test:2')`, [seedTenantId, 'ab'.repeat(16)]), '23514');
    });

    test('broker dispatch claims (0012) require a waiting operation owned by the same tenant', async () => {
      const key = H('9b');
      await rejects(db.query("insert into broker_operations(tenant_id,operation_key,run_id,request_hash,request) values($1,$2,$3,$4,'{}')", [seedTenantId, key, runId, H('aa')]), '23503');
      await db.query("insert into run_operations(tenant_id,run_id,operation_key,kind,node_id,iteration_path) values($1,$2,$3,'read','price','[]')", [seedTenantId, runId, key]);
      await rejects(db.query("insert into broker_operations(tenant_id,operation_key,run_id,request_hash,request) values($1,$2,$3,$4,'{}')", ['019a0000-0000-7000-8000-000000000099', key, runId, H('aa')]), '23503');
      await db.query("insert into broker_operations(tenant_id,operation_key,run_id,request_hash,request) values($1,$2,$3,$4,'{}')", [seedTenantId, key, runId, H('aa')]);
      await rejects(db.query('update broker_operations set latest_result_id=$3 where tenant_id=$1 and operation_key=$2', [seedTenantId, key, '019a0000-0000-7000-8000-000000000098']), '23503');
      // Migration 0016 allows JSONB formatting overhead, but storage stays bounded.
      await rejects(db.query('update broker_operations set request=$3 where tenant_id=$1 and operation_key=$2', [seedTenantId, key, JSON.stringify({ padding: 'x'.repeat(65536) })]), '23514');
      const bounds = await db.query("select pg_get_constraintdef(oid) as definition from pg_constraint where conname='broker_results_response_check'");
      assert.match(bounds.rows[0].definition, /131072/);
    });

    test('AI metering (0013) preserves operation ownership, exact holds and immutable rate identity', async () => {
      const key = H('9b'), agent = paperSeed().request.agentId;
      const insert = (tenant: string, amount: string) => db.query(`insert into ai_metering(tenant_id,operation_key,agent_id,model_id,rate_version,input_rate,cached_input_rate,output_rate,max_input_tokens,max_output_tokens,reserved_usd_micros,state) values($1,$2,$3,'synthetic-test','test/1',950000,160000,4000000,100,20,$4,'dispatched')`, [tenant,key,agent,amount]);
      await rejects(insert(seedTenantId, '-1'), '23514');
      await rejects(insert('019a0000-0000-7000-8000-000000000099', '175'), '23503');
      await insert(seedTenantId, '175');
      await rejects(insert(seedTenantId, '175'), '23505');
      await rejects(db.query('update ai_metering set input_rate=0'), 'P0001');
      await rejects(db.query('delete from ai_metering'), 'P0001');
    });

    test('AI allowance (0014) keeps tenant ownership, UTC window and charge ceilings immutable', async () => {
      const key=H('9b'),agent=paperSeed().request.agentId;
      const insert=(tenant:string,amount:string)=>db.query(`insert into ai_allowance_reservations(tenant_id,operation_key,agent_id,authorized_at,authorized_day,reserved_usd_micros,state) values($1,$2,$3,now(),(now() at time zone 'UTC')::date,$4,'held')`,[tenant,key,agent,amount]);
      await rejects(insert(seedTenantId,'100001'),'23514');
      await rejects(insert('019a0000-0000-7000-8000-000000000099','100'),'23503');
      await insert(seedTenantId,'100');
      await rejects(insert(seedTenantId,'100'),'23505');
      await rejects(db.query('update ai_allowance_reservations set reserved_usd_micros=0'),'P0001');
      await rejects(db.query('delete from ai_allowance_reservations'),'P0001');
      await rejects(db.query("update ai_allowance_reservations set state='settled',charged_usd_micros=101,settled_at=now()"),'23514');
      await db.query("update ai_allowance_reservations set state='settled',charged_usd_micros=50,settled_at=now()");
      await rejects(db.query('update ai_allowance_reservations set charged_usd_micros=0'),'P0001');
      assert.equal((await db.query('select counts_call from ai_allowance_reservations where operation_key=$1', [key])).rows[0].counts_call, true);
      await rejects(db.query('update ai_allowance_reservations set counts_call=false'), 'P0001');
    });

    test('allowance backfill (0015) preserves an earlier unknown hold exactly once', async () => {
      const migration = await readFile(new URL('../../migrations/0015_ai_allowance_backfill.sql',import.meta.url),'utf8');
      const key=H('9c'),agent=paperSeed().request.agentId;
      await db.query("insert into run_operations(tenant_id,run_id,operation_key,kind,node_id,iteration_path) values($1,$2,$3,'ai.decide','legacy_ai','[]')",[seedTenantId,runId,key]);
      await db.query("insert into broker_operations(tenant_id,operation_key,run_id,request_hash,request) values($1,$2,$3,$4,'{\"kind\":\"ai.decide\"}')",[seedTenantId,key,runId,H('aa')]);
      await db.query(`insert into ai_metering(tenant_id,operation_key,agent_id,model_id,rate_version,input_rate,cached_input_rate,output_rate,max_input_tokens,max_output_tokens,reserved_usd_micros,state,authorized_at) values($1,$2,$3,'synthetic-test','test/1',950000,160000,4000000,100,20,175,'reconciling','2026-10-12T23:59:59Z')`,[seedTenantId,key,agent]);
      await db.query(migration); await db.query(migration);
      const result=await db.query("select state,reserved_usd_micros,to_char(authorized_day,'YYYY-MM-DD') as day from ai_allowance_reservations where operation_key=$1",[key]);
      assert.deepEqual(result.rows,[{ state:'held',reserved_usd_micros:'175',day:'2026-10-12' }]);
    });

    test('artifacts and timeline entries are immutable', async () => {
      await db.query(`insert into artifacts (ref, tenant_id, deployment_id, kind, content_hash, body) values ('artifact:test', $1, $2, 'strategy', $3, '{}')`, [seedTenantId, deployment, H('bb')]);
      await rejects(db.query(`update artifacts set body = '[]'`), 'P0001');
      await db.query(`insert into timeline_entries (tenant_id, operation_key, run_id, node_id, message, inputs) values ($1, $2, $3, 'note', 'hello', '{}')`, [seedTenantId, H('cc'), runId]);
      await rejects(db.query(`delete from timeline_entries`), 'P0001');
    });
  });

  describe('market persistence (0006, 0007)',()=>{
    test('cursor constraints and canonical observation/log identity, finality and immutability',async()=>{
      const hash='0x'+'e1'.repeat(32),feed='db.market-check';
      await rejects(db.query('insert into market_cursors (feed_ref,block_number,block_hash) values ($1,-1,$2)',[feed,hash]),'23514');
      await rejects(db.query('insert into market_cursors (feed_ref,block_number,block_hash) values ($1,1,$2)',[feed,'invalid']),'23514');
      await db.query('insert into market_cursors (feed_ref,block_number,block_hash) values ($1,1,$2)',[feed,hash]);
      await rejects(db.query('insert into market_cursors (feed_ref,block_number,block_hash) values ($1,2,$2)',[feed,hash]),'23505');
      const observation={schemaVersion:'price-observation/1',finality:'finalized'};
      const insertObservation=(doc:unknown)=>db.query('insert into finalized_market_observations values ($1,$2,$3)',[feed,'canonical:key',doc]);
      await rejects(insertObservation({...observation,finality:'proposed'}),'23514');
      await rejects(insertObservation({...observation,schemaVersion:'price-observation/2'}),'23514');
      await rejects(insertObservation(null),'23502');
      await insertObservation(observation);
      await rejects(insertObservation(observation),'23505');
      await rejects(db.query('update finalized_market_observations set document=$1 where feed_ref=$2',[observation,feed]),'P0001');
      await rejects(db.query('delete from finalized_market_observations where feed_ref=$1',[feed]),'P0001');
      await rejects(db.query('insert into finalized_market_logs values ($1,$2,-1,$3)',[feed,hash,{}]),'23514');
      await rejects(db.query('insert into finalized_market_logs values ($1,$2,0,null)',[feed,hash]),'23502');
      await db.query('insert into finalized_market_logs values ($1,$2,0,$3)',[feed,hash,{}]);
      await rejects(db.query('insert into finalized_market_logs values ($1,$2,0,$3)',[feed,hash,{}]),'23505');
      await rejects(db.query('update finalized_market_logs set document=$1 where feed_ref=$2',[{},feed]),'P0001');
      await rejects(db.query('delete from finalized_market_logs where feed_ref=$1',[feed]),'P0001');
    });
    test('cached reads require an existing operation and its tenant, are unique and immutable',async()=>{
      const {runId,operationKey}=await marketReadFixture(db),hash='0x'+'e2'.repeat(32);
      const insert=(key:string,tenant:string|null,document:unknown={})=>db.query('insert into market_read_results (run_id,operation_key,request_hash,document,tenant_id) values ($1,$2,$3,$4,$5)',[runId,key,hash,document,tenant]);
      await rejects(insert(hash,seedTenantId),'23503');
      await rejects(insert(operationKey,null),'23502');
      const otherTenant='019a0000-0000-7000-8000-0000000002f3';
      await db.query("insert into tenants (id,auth_subject) values ($1,'synthetic|market-other')",[otherTenant]);
      await rejects(insert(operationKey,otherTenant),'23503');
      await rejects(insert(operationKey,seedTenantId,null),'23502');
      await insert(operationKey,seedTenantId);
      await rejects(insert(operationKey,seedTenantId),'23505');
      await rejects(db.query('update market_read_results set document=$1 where run_id=$2',[{},runId]),'P0001');
      await rejects(db.query('delete from market_read_results where run_id=$1',[runId]),'P0001');
    });
    test('0007 upgrades existing read ownership, restores immutability and installs the latest-feed index',async()=>{
      const upgrade=await freshClient(),migrations=readMigrations();
      await migrate(upgrade,migrations.filter(m=>m.version<=6));
      const {runId,operationKey}=await marketReadFixture(upgrade);
      const document={schemaVersion:'broker-result/1',operationKey,disposition:'refused',reason:{code:'BROKER_STALE_DATA',message:'Fixture'}};
      await upgrade.query('insert into market_read_results (run_id,operation_key,request_hash,document) values ($1,$2,$3,$4)',[runId,operationKey,'0x'+'e3'.repeat(32),document]);
      assert.deepEqual(await migrate(upgrade,migrations.filter(m=>m.version<=7)),[migrations[6]!.name]);
      const row=(await upgrade.query('select tenant_id,document from market_read_results where run_id=$1',[runId])).rows[0];
      assert.equal(row.tenant_id,seedTenantId);assert.deepEqual(row.document,document);
      await rejects(upgrade.query('update market_read_results set document=$1 where run_id=$2',[{},runId]),'P0001');
      await rejects(upgrade.query('delete from market_read_results where run_id=$1',[runId]),'P0001');
      const index=(await upgrade.query("select indexdef from pg_indexes where indexname='finalized_market_observations_latest'")).rows[0].indexdef;
      assert.match(index,/feed_ref/);assert.match(index,/observedAt/);assert.match(index,/DESC/);
      assert.deepEqual(await migrate(upgrade,migrations.filter(m=>m.version<=7)),[]);
    });
  });

  describe('immutability', () => {
    test('strategy revisions cannot be updated or deleted', async () => {
      await rejects(db.query(`update strategy_revisions set validation = '{}'`), 'P0001');
      await rejects(db.query('delete from strategy_revisions'), 'P0001');
    });

    test('policies and estimates cannot be updated', async () => {
      await rejects(db.query(`update policies set limits = '{}'`), 'P0001');
      await rejects(db.query(`update estimates set expires_at = expires_at + interval '1 day'`), 'P0001');
    });

    test('catalog versions are immutable except for being disabled', async () => {
      await rejects(db.query(`update catalog_versions set definition = '{}' where ref = 'paper.uniswap'`), 'P0001');
      await rejects(db.query(`delete from catalog_versions where ref = 'paper.uniswap'`), 'P0001');
      const { rowCount } = await db.query(`update catalog_versions set disabled_reason = 'test withdrawal' where ref = 'paper.USD' and version = '1.0.0'`);
      assert.equal(rowCount, 1);
    });

    test('executor paper records keep their invariants (0004)', async () => {
      const { request } = paperSeed();
      const account = '019a0000-0000-7000-8000-0000000000b0';
      await db.query('insert into simulation_accounts (tenant_id, id, agent_id, session) values ($1, $2, $3, 1)', [seedTenantId, account, request.agentId]);
      await rejects(db.query(`insert into simulation_balances (tenant_id, account_id, asset_ref, available) values ($1, $2, 'paper.WETH', -1)`, [seedTenantId, account]), '23514');
      // Intents belong to a real deployment (0005); a stopped one does not collide with the agent's open deployment.
      await db.query(
        `insert into deployments (tenant_id, id, agent_id, strategy_revision_id, mode, strategy_hash, catalog_hash, connector_versions, runtime_image_digest, network_ref, policy_version, budget_version, resource_profile_ref, simulation_account_id, desired_state)
         values ($1, '019a0000-0000-7000-8000-0000000000b1', $2, $3, 'paper', $4, $4, '{}', $4, 'paper-monad', 1, 1, 'paper-small-v1', $5, 'stopped')`,
        [seedTenantId, request.agentId, request.strategyRevisionId, '0x' + 'aa'.repeat(32), account],
      );
      const intent = (id: string, mode: string, state: string, key = '0x' + id.slice(-2).repeat(32)) => db.query(
        `insert into intents (tenant_id, id, agent_id, deployment_id, generation, mode, simulation_account_id, run_id, node_id, iteration_path,
           logical_key, request_hash, request, action, input_atomic, state, created_at, updated_at)
         values ($1, $2, $3, '019a0000-0000-7000-8000-0000000000b1', 1, $4, $5, $6, 'sell', '[]', $7, $6, '{}', '{}', 1, $8, now(), now())`,
        [seedTenantId, id, request.agentId, mode, account, '0x' + 'ab'.repeat(32), key, state],
      );
      // Live intents need wallets and transaction attempts (later migration); a settled row needs its fill.
      await rejects(intent('019a0000-0000-7000-8000-0000000000b2', 'live', 'reserved'), '23514');
      await rejects(intent('019a0000-0000-7000-8000-0000000000b3', 'paper', 'settled'), '23514');
      await rejects(intent('019a0000-0000-7000-8000-0000000000b4', 'paper', 'rejected'), '23514');
      await intent('019a0000-0000-7000-8000-0000000000b5', 'paper', 'reserved');
      // One logical effect: a second intent with the same logical key is refused.
      await rejects(intent('019a0000-0000-7000-8000-0000000000b6', 'paper', 'reserved', '0x' + 'b5'.repeat(32)), '23505');
    });

    test('audit retention (0008): only prune_audit_events deletes, only an old prefix, never money rows', async () => {
      const tenant = '019a0000-0000-7000-8000-0000000000e1';
      await db.query(`insert into tenants (id, auth_subject) values ($1, 'retention-check')`, [tenant]);
      const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
      const recent = new Date().toISOString();
      const intent = '019a0000-0000-7000-8000-0000000000e2';
      // 1–2 old; 3 old money row (intent-linked); 4 recent; 5 old but published after 4 (out of time order); 6 old.
      const rows: [number, string, string, string | null][] = [
        [1, 'run.step', old, null], [2, 'policy.denied', old, null], [3, 'transaction.stateChanged', old, intent],
        [4, 'run.step', recent, null], [5, 'run.step', old, null], [6, 'run.step', old, null],
      ];
      await db.query('insert into tenant_streams (tenant_id, last_sequence) values ($1, 6)', [tenant]);
      for (const [sequence, type, at, intentId] of rows) {
        await db.query(
          `insert into audit_events (tenant_id, sequence, intent_id, actor_kind, trace_id, type, payload, occurred_at, source) values ($1, $2, $3, 'system', $4, $5, '{}', $6, $7)`,
          [tenant, sequence, intentId, 'ab'.repeat(16), type, at, `retention-check:${sequence}`],
        );
      }
      await rejects(db.query(`update audit_events set payload = '{"x":1}' where tenant_id = $1`, [tenant]), 'P0001');
      await rejects(db.query('delete from audit_events where tenant_id = $1 and sequence = 1', [tenant]), 'P0001');
      await rejects(db.query(`select prune_audit_events($1, now())`, [tenant]), 'P0001');
      // Even with the prune flag set by hand, a money row is never deleted.
      await db.query('begin');
      await db.query(`select set_config('app.audit_prune', 'on', true)`);
      await rejects(db.query('delete from audit_events where tenant_id = $1 and sequence = 3', [tenant]), 'P0001');
      await db.query('rollback');

      const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
      const pruned = await db.query<{ removed: string }>('select prune_audit_events($1, $2) as removed', [tenant, cutoff]);
      // Only the prefix before the first recent event (4) is eligible. 1 goes; 2 (a policy denial) and 3 (intent-linked)
      // are money records and stay; 5 and 6 follow a newer event and stay.
      assert.equal(pruned.rows[0]!.removed, '1');
      const left = await db.query<{ sequence: string }>('select sequence from audit_events where tenant_id = $1 order by sequence', [tenant]);
      assert.deepEqual(left.rows.map((r) => Number(r.sequence)), [2, 3, 4, 5, 6]);
      const stream = await db.query<{ retained_after: string }>('select retained_after from tenant_streams where tenant_id = $1', [tenant]);
      assert.equal(stream.rows[0]!.retained_after, '1');
      // Repeating is a no-op; the floor never moves back, and appends still work afterwards.
      assert.equal((await db.query<{ removed: string }>('select prune_audit_events($1, $2) as removed', [tenant, cutoff])).rows[0]!.removed, '0');
      assert.equal((await db.query('select retained_after from tenant_streams where tenant_id = $1', [tenant])).rows[0]!.retained_after, '1');
      await rejects(db.query('update tenant_streams set retained_after = 7 where tenant_id = $1', [tenant]), '23514');
    });

    test('paper usage (0009): one open interval per deployment, ordered times, one limits row', async () => {
      // The stopped deployment created by the executor records test above.
      const deployment = '019a0000-0000-7000-8000-0000000000b1';
      const interval = (generation: number, start: string, end: string | null) => db.query(
        'insert into paper_active_intervals (tenant_id, deployment_id, generation, started_at, ended_at) values ($1, $2, $3, $4, $5)', [seedTenantId, deployment, generation, start, end]);
      await interval(1, '2026-01-01T00:00:00Z', '2026-01-01T00:10:00Z');
      await interval(2, '2026-01-01T00:20:00Z', null);
      await rejects(interval(3, '2026-01-01T00:30:00Z', null), '23505');
      await rejects(interval(4, '2026-01-01T00:30:00Z', '2026-01-01T00:29:00Z'), '23514');
      // An interval cannot name another tenant's deployment.
      await rejects(db.query(`insert into paper_active_intervals (tenant_id, deployment_id, generation, started_at, ended_at) values ($1, $2, 5, now(), now())`, ['019a0000-0000-7000-8000-0000000000e1', deployment]), '23503');
      const limits = await db.query('select paper_concurrent_per_user, paper_session_minutes, paper_daily_minutes, paper_active_global from platform_limits');
      assert.deepEqual(limits.rows, [{ paper_concurrent_per_user: 1, paper_session_minutes: 60, paper_daily_minutes: 120, paper_active_global: 10 }]);
      await rejects(db.query('insert into platform_limits (singleton, paper_concurrent_per_user, paper_session_minutes, paper_daily_minutes, paper_active_global) values (true, 1, 1, 1, 1)'), '23505');
      await rejects(db.query('update platform_limits set paper_daily_minutes = -1'), '23514');
    });

    test('catalog modes are limited to paper and live', async () => {
      await rejects(
        db.query(`insert into catalog_versions (kind, ref, version, modes, content_hash, definition) values ('network', 'x', '1.0.0', '{mainnet}', $1, '{}')`, ['0x' + 'ab'.repeat(32)]),
        '23514',
      );
    });
  });
});
