import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, test } from "node:test";
import pg from "pg";
import { contentHash, operationKey, parse, validate } from "@monad-hack/contracts";
import type { BrokerRequest, BrokerResult } from "@monad-hack/contracts";
import { BrokerStore } from "./broker-store.ts";
import type { BrokerScope } from "./broker-store.ts";
import { newId } from "./control.ts";
import { migrate } from "./db/migrate.ts";
import { paperSeed, seedPaper, seedTenantId } from "./db/seed.ts";

const url = process.env["DATABASE_URL"];
if (!url && process.env["REQUIRE_DB"] === "1")
  throw new Error("DATABASE_URL required for broker persistence checks");
describe("broker result persistence / PostgreSQL", { skip: !url }, () => {
  let admin: pg.Client, pool: pg.Pool, store: BrokerStore, scope: BrokerScope;
  const disconnected: Promise<void>[] = [];
  const db = `broker_${randomBytes(6).toString("hex")}`;
  const provenance = {
    sourceRef: "paper.weth-usd",
    contentHash: "0x" + "bb".repeat(32),
  };
  before(async () => {
    admin = new pg.Client({ connectionString: url! });
    await admin.connect();
    await admin.query(`create database ${db}`);
    const u = new URL(url!);
    u.pathname = `/${db}`;
    const c = new pg.Client({ connectionString: u.toString() });
    await c.connect();
    await migrate(c);
    await seedPaper(c);
    await c.end();
    pool = new pg.Pool({ connectionString: u.toString() });
    // Scratch database teardown may terminate sockets after pool.end() resolves.
    pool.on("connect", client => client.on("error", () => {}));
    pool.on("error", () => {});
    pool.on('connect', client => disconnected.push(new Promise(resolve => client.once('end', resolve))));
    store = new BrokerStore(pool);
    const seed = paperSeed();
    const deploymentId = newId();
    const accountId = newId();
    const hash = "0x" + "aa".repeat(32);
    await pool.query(
      "insert into simulation_accounts(tenant_id,id,agent_id,session) values($1,$2,$3,1)",
      [seedTenantId, accountId, seed.request.agentId],
    );
    await pool.query(
      `insert into deployments(tenant_id,id,agent_id,strategy_revision_id,mode,strategy_hash,catalog_hash,connector_versions,runtime_image_digest,
      network_ref,policy_version,budget_version,resource_profile_ref,estimate_id,simulation_account_id)
      values($1,$2,$3,$4,'paper',$5,$5,'{}',$5,'paper-monad',1,1,'paper-small-v1',$6,$7)`,
      [
        seedTenantId,
        deploymentId,
        seed.request.agentId,
        seed.request.strategyRevisionId,
        hash,
        seed.request.estimateId,
        accountId,
      ],
    );
    const runId = await contentHash({
      test: "broker-persistence",
      deploymentId,
    });
    await pool.query(
      `insert into runs(tenant_id,run_id,deployment_id,generation,deployment_revision,trigger_id,source_event_key,trigger)
      values($1,$2,$3,1,'revision/1','trigger','test:broker','{}')`,
      [seedTenantId, runId, deploymentId],
    );
    scope = { tenantId: seedTenantId, deploymentId, generation: "1", runId };
  });
  after(async () => {
    await pool?.end();
    await Promise.all(disconnected);
    await admin?.query(`drop database if exists ${db} with (force)`);
    await admin?.end();
  });
  async function request(nodeId: string): Promise<BrokerRequest> {
    const key = await operationKey("read", {
      ...scope,
      nodeId,
      iterationPath: [],
    });
    await pool.query(
      `insert into run_operations(tenant_id,run_id,operation_key,kind,node_id,iteration_path) values($1,$2,$3,'read',$4,'[]')`,
      [scope.tenantId, scope.runId, key, nodeId],
    );
    return {
      schemaVersion: "broker-request/1",
      operationKey: key,
      runId: scope.runId,
      nodeId,
      iterationPath: [],
      kind: "read",
      connectorRef: "paper.uniswap",
      operation: "price.read",
      arguments: {},
    };
  }
  const answer = (r: BrokerRequest): BrokerResult => ({
    schemaVersion: "broker-result/1",
    operationKey: r.operationKey,
    disposition: "completed",
    resultId: newId(),
    value: {
      price: { decimal: "2500", baseAssetRef: "paper.WETH", quoteUnit: "USD" },
      observedAt: "2026-10-13T00:00:00.000Z",
    },
    observedAt: "2026-10-13T00:00:00.000Z",
    receivedAt: "2026-10-13T00:00:01.000Z",
  });

  test("concurrent dispatch, restart and resume reuse immutable answers without another provider call", async () => {
    const r = await request("read_price");
    let calls = 0;
    let finish!: (value: BrokerResult) => void;
    const dispatched = new Promise<BrokerResult>((resolve) => {
      finish = resolve;
    });
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const first = store.execute(scope, r, provenance, async () => {
      calls++;
      started();
      return dispatched;
    });
    await ready;
    const duplicate = await new BrokerStore(pool).execute(
      scope,
      r,
      provenance,
      async () => {
        calls++;
        return answer(r);
      },
    );
    assert.equal(duplicate.disposition, "pending");
    finish(answer(r));
    const completed = await first;
    assert.equal(completed.disposition, "completed");
    assert.equal(calls, 1);
    const replay = await new BrokerStore(pool).execute(
      scope,
      r,
      provenance,
      async () => {
        throw new Error("Replay dispatched a provider");
      },
    );
    assert.deepEqual(replay, completed);
    const saved = await store.read(scope, completed.resultId!);
    assert.ok(validate("persistedBrokerResult", saved).ok);
    assert.deepEqual(saved.response, completed);
    assert.deepEqual(saved.provenance, provenance);
    assert.equal(saved.nodeId, r.nodeId);
    const row = (
      await pool.query(
        "select value,observed_at,received_at from broker_results where id=$1",
        [saved.id],
      )
    ).rows[0];
    assert.deepEqual(row.value, completed.value);
    assert.equal(row.observed_at.toISOString(), completed.observedAt);
    assert.equal(row.received_at.toISOString(), completed.receivedAt);
    await assert.rejects(
      pool.query("update broker_results set kind='ai.decide' where id=$1", [
        saved.id,
      ]),
      /immutable/,
    );
    await assert.rejects(
      pool.query("delete from broker_results where id=$1", [saved.id]),
      /immutable/,
    );
    await assert.rejects(
      store.read({ ...scope, tenantId: newId() }, saved.id),
      /not found/,
    );
    await assert.rejects(
      store.read({ ...scope, generation: "2" }, saved.id),
      /not found/,
    );
    await assert.rejects(
      store.execute(
        scope,
        {
          ...r,
          arguments: {
            changed: { kind: "literal", valueType: "Boolean", value: true },
          },
        },
        provenance,
        async () => answer(r),
      ),
      /different input/,
    );
  });

  test('compact wire-limit answers persist despite JSONB formatting overhead', async () => {
    const r = await request('wire_boundary');
    const response = answer(r);
    response.value = { padding: '', ...Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`field${i}`, 0])) };
    response.value['padding'] = 'x'.repeat(65536 - Buffer.byteLength(JSON.stringify(response)));
    assert.equal(Buffer.byteLength(JSON.stringify(response)), 65536);
    assert.ok(parse('brokerResult', JSON.stringify(response)).ok);
    assert.ok(!parse('brokerResult', JSON.stringify({ ...response, value: { ...response.value, extra: true } })).ok);
    const saved = await store.execute(scope, r, provenance, async () => response);
    assert.deepEqual(saved.value, response.value);
    const stored = await pool.query('select octet_length(response::text) as bytes from broker_results where id=$1', [saved.resultId]);
    assert.ok(stored.rows[0].bytes > 65536);
    assert.deepEqual((await store.read(scope, saved.resultId!)).response, saved);
  });

  test('finished runs and terminal waiting operations cannot start a delayed first dispatch', async () => {
    const known = await request('known_before_finish');
    const saved = await store.execute(scope,known,provenance,async()=>answer(known));
    const delayed = await request('late_first_request');
    let calls=0;
    await pool.query("update runs set status='completed' where run_id=$1",[scope.runId]);
    try {
      await assert.rejects(store.execute(scope,delayed,provenance,async()=>{ calls++; return answer(delayed); }),/Finished work/);
      assert.deepEqual(await store.execute(scope,known,provenance,async()=>{ calls++; return answer(known); }),saved);
    } finally { await pool.query("update runs set status='queued' where run_id=$1",[scope.runId]); }
    const expired=await request('already_timed_out');
    await pool.query("update run_operations set outcome='timeout' where operation_key=$1",[expired.operationKey]);
    await assert.rejects(store.execute(scope,expired,provenance,async()=>{ calls++; return answer(expired); }),/Finished work/);
    assert.equal(calls,0);
  });

  test('concurrent reconciliation and a late provider result keep one winning terminal answer', async () => {
    const r=await request('resolution_race');
    await store.execute(scope,r,provenance,async()=>{ throw new Error('lost provider response'); });
    const competing={ ...answer(r),value:{ price:{ decimal:'2600',baseAssetRef:'paper.WETH',quoteUnit:'USD' },observedAt:'2026-10-13T00:00:00.000Z' } };
    const results=await Promise.all([store.resolve(scope,r,answer(r),provenance),new BrokerStore(pool).resolve(scope,r,competing,provenance)]);
    assert.deepEqual(results[0],results[1]);
    assert.deepEqual(await store.resolve(scope,r,{ schemaVersion:'broker-result/1',operationKey:r.operationKey,disposition:'unknown' },provenance),results[0]);
    assert.equal((await pool.query('select 1 from broker_results where operation_key=$1',[r.operationKey])).rowCount,3);
  });

  test("a lost dispatch stays unknown; reconciliation appends a result without changing history", async () => {
    const r = await request("unknown_read");
    let calls = 0;
    const lost = await store.execute(scope, r, provenance, async () => {
      calls++;
      throw new Error("private provider details");
    });
    assert.equal(lost.disposition, "unknown");
    assert.ok(!JSON.stringify(lost).includes("private"));
    assert.deepEqual(
      await new BrokerStore(pool).execute(scope, r, provenance, async () => {
        calls++;
        return answer(r);
      }),
      lost,
    );
    const old = (
      await pool.query(
        "select id from broker_results where operation_key=$1 order by received_at",
        [r.operationKey],
      )
    ).rows;
    const result = await store.resolve(scope, r, answer(r), provenance);
    assert.equal(result.disposition, "completed");
    assert.equal(calls, 1);
    assert.equal(
      (await store.read(scope, old[1].id)).response.disposition,
      "unknown",
    );
    assert.deepEqual(
      await store.execute(scope, r, provenance, async () => {
        throw new Error("must not dispatch");
      }),
      result,
    );
  });

  test("unpersisted, cross-run, mismatched and paused operations never dispatch", async () => {
    const r = await request("admission_read");
    let calls = 0;
    const dispatch = async () => {
      calls++;
      return answer(r);
    };
    await assert.rejects(
      store.execute(
        { ...scope, runId: "0x" + "ff".repeat(32) },
        r,
        provenance,
        dispatch,
      ),
      /does not match/,
    );
    await assert.rejects(
      store.execute(
        scope,
        { ...r, nodeId: "another_node" },
        provenance,
        dispatch,
      ),
      /does not match/,
    );
    await pool.query(
      "update deployments set desired_state='paused' where id=$1",
      [scope.deploymentId],
    );
    await assert.rejects(
      store.execute(scope, r, provenance, dispatch),
      /active, persisted/,
    );
    assert.equal(calls, 0);
  });
});
