import { KimiBroker } from '../apps/api/src/kimi-broker.ts';
import { KIMI_MODEL } from '../apps/api/src/kimi-adapter.ts';
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after } from "node:test";
import pg from "pg";
import { operationKey, validate } from "../packages/contracts/src/index.ts";
import type {
  BrokerRequest,
  BrokerResult,
  RunCheckpoint,
  RuntimeAssignment,
} from "../packages/contracts/src/index.ts";
import {
  verifyCapability,
} from "../packages/contracts/src/capability.ts";
import {
  advanceRun,
  startRun,
  runIdentity,
  compileStrategy,
  PRESETS,
  syntheticCatalog,
} from "../packages/strategy/src/index.ts";
import { migrate } from "../apps/api/src/db/migrate.ts";
import {
  RuntimeControlStore,
  uuidv7,
} from "../apps/api/src/runtime-control/store.ts";
import { createInternalApp } from "../apps/api/src/runtime-control/app.ts";
import { PaperBrokerService } from "../apps/api/src/broker-service.ts";
import type { Broker } from "../apps/runtime/src/ports.ts";
import { runtimeErrorFor } from "../apps/runtime/src/dispatch/errors.ts";

const url = process.env["DATABASE_URL"];
if (!url && process.env["REQUIRE_DB"] === "1")
  throw new Error("DATABASE_URL required for broker service tests");
const pools: pg.Pool[] = [];
const databases: string[] = [];
const apps: ReturnType<typeof createInternalApp>[] = [];
let admin: pg.Client | undefined;
let template: string | undefined;
after(async () => {
  for (const app of apps) await app.close();
  for (const pool of pools) await pool.end();
  for (const db of databases.reverse())
    await admin?.query(`drop database if exists ${db} with (force)`);
  await admin?.end();
});

/** A fresh database per scenario; the public control-plane creates actual immutable artifacts and waits. */
export async function brokerHarness(
  options: { decide?: (r: BrokerRequest) => Promise<BrokerResult>; kimiAdapter?: import('../apps/api/src/kimi-adapter.ts').KimiAdapter } = {},
) {
  if (!admin) {
    admin = new pg.Client({ connectionString: url! });
    await admin.connect();
  }
  if (!template) {
    template = `broker_svc_tpl_${randomBytes(5).toString("hex")}`;
    databases.push(template);
    await admin.query(`create database ${template}`);
    const u = new URL(url!);
    u.pathname = `/${template}`;
    const c = new pg.Client({ connectionString: u.toString() });
    await c.connect();
    await migrate(c);
    await c.end();
  }
  const db = `broker_svc_${randomBytes(6).toString("hex")}`;
  databases.push(db);
  await admin.query(`create database ${db} template ${template}`);
  const u = new URL(url!);
  u.pathname = `/${db}`;
  const pool = new pg.Pool({ connectionString: u.toString() });
  pools.push(pool);
  pool.on("error", () => {});
  const secret = randomBytes(32);
  const runtime = new RuntimeControlStore({
    pool,
    brokerCapabilitySecret: secret,
    executorCapabilitySecret: randomBytes(32),
  });
  const kimi = options.kimiAdapter ? new KimiBroker(pool, options.kimiAdapter) : undefined;
  const service = new PaperBrokerService({ pool, secret, ...(options.decide ? { decide: options.decide } : {}), ...(kimi ? { kimi } : {}) });
  const app = createInternalApp({
    store: runtime,
    broker: service,
    authenticateWorkload: () => "broker-test",
  });
  apps.push(app);
  const tokens = new Map<string, string>();
  const assignments = new Map<string, RuntimeAssignment>();
  const raw = async (r: BrokerRequest, token = tokens.get(r.runId)) =>
    app.inject({
      method: "POST",
      url: "/internal/v1/broker/requests",
      headers: { authorization: `Bearer ${token ?? ""}` },
      payload: r,
    });
  const broker: Broker = {
    request: async (r) => {
      const response = await raw(r);
      if (response.statusCode >= 400)
        throw runtimeErrorFor(response.statusCode, response.json().code);
      return response.json<BrokerResult>();
    },
  };
  const catalog = options.kimiAdapter ? { ...syntheticCatalog, modelProfiles: { 'paper.kimi': { ...syntheticCatalog.modelProfiles['paper.kimi']!, provider: 'kimi', modelId: KIMI_MODEL } } } : syntheticCatalog;
  const program = await compileStrategy(
    JSON.stringify(PRESETS.find((p) => p.id === "ai_gated_purchase")!.strategy),
    catalog,
  );
  async function waiting(
    assignment: RuntimeAssignment,
    checkpoint: RunCheckpoint,
  ): Promise<BrokerRequest> {
    const step = await advanceRun(program, checkpoint);
    const command = step.command!;
    if (command.kind !== "read" && command.kind !== "ai.decide")
      throw new Error("Expected a broker command");
    const key = await operationKey(command.kind, {
      deploymentId: assignment.deployment.deploymentId,
      generation: assignment.deployment.generation,
      runId: command.runId,
      nodeId: command.nodeId,
      iterationPath: command.iterationPath,
    });
    await runtime.wait({
      schemaVersion: "run-wait/1",
      assignmentId: assignment.assignmentId,
      fencingToken: assignment.lease.fencingToken,
      runId: command.runId,
      checkpoint: step.checkpoint,
      operation: {
        operationKey: key,
        kind: command.kind,
        nodeId: command.nodeId,
        iterationPath: command.iterationPath,
      },
    });
    const { key: _key, ...fields } = command;
    const checked = validate("brokerRequest", {
      schemaVersion: "broker-request/1",
      operationKey: key,
      ...fields,
    });
    assert.ok(checked.ok);
    return checked.value;
  }
  const arrange = async (
    kind: "read" | "ai.decide",
  ): Promise<BrokerRequest> => {
    const tenantId = uuidv7(),
      agentId = uuidv7(),
      revisionId = uuidv7(),
      estimateId = uuidv7(),
      accountId = uuidv7();
    await pool.query("insert into tenants(id,auth_subject) values($1,$2)", [
      tenantId,
      tenantId,
    ]);
    await pool.query(
      "insert into agents(tenant_id,id,name,paper_budget) values($1,$2,'Broker test',$3)",
      [tenantId, agentId, { dataAndAiUsdMicros: '1000000', tradingUsdMicros: '1000000000', hostingUsdMicros: '10000000', monReserveAtomic: '1000000000000000000' }],
    );
    await pool.query(
      "insert into strategy_revisions(tenant_id,id,agent_id,language_version,content_hash,ast,validation) values($1,$2,$3,'strategy/1',$4,$5,'{}')",
      [tenantId, revisionId, agentId, program.hash, program.strategy],
    );
    await pool.query(
      "insert into policies(tenant_id,agent_id,version,limits) values($1,$2,1,'{}')",
      [tenantId, agentId],
    );
    await pool.query(
      "insert into estimates(tenant_id,id,agent_id,strategy_revision_id,assumptions,created_at,expires_at) values($1,$2,$3,$4,'{}',now(),now()+interval '1 hour')",
      [tenantId, estimateId, agentId, revisionId],
    );
    await pool.query(
      "insert into simulation_accounts(tenant_id,id,agent_id,session) values($1,$2,$3,1)",
      [tenantId, accountId, agentId],
    );
    await runtime.deploy({
      tenantId,
      agentId,
      strategyRevisionId: revisionId,
      mode: "paper",
      catalog,
      connectorVersions: { "paper.uniswap": "1.0.0" },
      runtimeImageDigest: "0x" + "aa".repeat(32),
      networkRef: "paper-monad",
      policyVersion: 1,
      budgetVersion: 1,
      resourceProfileRef: "paper-small-v1",
      modelProfiles: { "paper.kimi": "1.0.0" },
      estimateId,
      simulationAccountId: accountId,
    });
    await runtime.tickSchedules();
    return prepareRun(kind);
  };
  const prepareRun = async (kind: 'read' | 'ai.decide'): Promise<BrokerRequest> => {
    const offer = await runtime.poll({
      schemaVersion: "assignment-poll/1",
      runtimeId: "broker-test",
      state: "ready",
      waitSeconds: 0,
    });
    if (offer.disposition !== "assigned")
      throw new Error("Expected an assignment");
    const assignment = offer.assignment!;
    assignments.set(assignment.run.runId, assignment);
    const exchange = await app.inject({
      method: "POST",
      url: "/internal/v1/runtime/capabilities:exchange",
      headers: { authorization: `Bearer ${offer.capability!.bearer}` },
      payload: { audience: "broker" },
    });
    assert.equal(exchange.statusCode, 200);
    assert.ok(validate("audienceCapability", exchange.json()).ok);
    tokens.set(assignment.run.runId, exchange.json().token);
    const now = new Date().toISOString();
    await runtime.ingestPrice({
      feedRef: "paper.weth-usd",
      sourceEventKey: `test:${assignment.run.runId}`,
      price: {
        baseAssetRef: "paper.WETH",
        quoteUnit: "USD",
        decimal: "2678.5",
      },
      observedAt: now,
      receivedAt: now,
    });
    const checkpoint = (
      await runtime.loadRun(
        assignment.run.runId,
        assignment.assignmentId,
        assignment.lease.fencingToken,
      )
    ).checkpoint;
    const start =
      checkpoint ??
      (await startRun(program, {
        deploymentRevision: assignment.run.deploymentRevision,
        triggerId: assignment.run.triggerId,
        sourceEventKey: assignment.run.sourceEventKey,
      }));
    assert.ok(start);
    const read = await waiting(assignment, start);
    if (kind === "read") return read;
    const value = await broker.request(read);
    const persisted = (
      await runtime.loadRun(
        assignment.run.runId,
        assignment.assignmentId,
        assignment.lease.fencingToken,
      )
    ).checkpoint!;
    const next = await advanceRun(program, persisted, {
      key: persisted.waiting!.key,
      outcome: "recorded",
      result: value.value,
      receivedAt: value.receivedAt!,
    });
    return waiting(assignment, next.checkpoint);
  };
  const runAgain = async (originalRunId: string): Promise<BrokerRequest> => {
    const original = (await pool.query<{ deployment_revision: string; trigger_id: string }>('select deployment_revision,trigger_id from runs where run_id=$1', [originalRunId])).rows[0]!;
    const sourceEventKey = `synthetic-next:${randomBytes(8).toString('hex')}`;
    const runId = await runIdentity(original.deployment_revision, original.trigger_id, sourceEventKey);
    await pool.query(`insert into runs(tenant_id,run_id,deployment_id,generation,deployment_revision,trigger_id,source_event_key,trigger) select tenant_id,$2,deployment_id,generation,deployment_revision,trigger_id,$3,trigger from runs where run_id=$1`, [originalRunId, runId, sourceEventKey]);
    await runtime.reassign(runId);
    return prepareRun('ai.decide');
  };
  return {
    broker,
    program,
    runAgain,
    kimi,
    app,
    service,
    pool,
    runtime,
    secret,
    raw,
    tokens,
    assignments,
    arrange,
    revoke: async (runId: string) => {
      const a = assignments.get(runId)!;
      await runtime.pause(a.deployment.deploymentId);
    },
  };
}
