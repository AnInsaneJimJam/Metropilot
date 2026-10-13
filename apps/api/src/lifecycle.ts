// User-facing deployment lifecycle and history (API-2, API-6; docs/specs/api-and-data.md sections 3–4).
// Paper and live (D61): a launch pins a saved revision into a deployment manifest, creates the policy snapshot and the
// simulation account the executor trades in, and hands the deployment to the runtime control plane in one
// transaction. Provisioning is immediate locally (a warm runtime polls); cloud provisioning is INF-3.
import pg from 'pg';
import { contentHash, validate } from '@monad-hack/contracts';
import type { DeploymentRequest } from '@monad-hack/contracts';
import { compileStrategy, profileIssues } from '@monad-hack/strategy';
import type { Catalog, CompiledStrategy, Experience } from '@monad-hack/strategy';
import { CatalogResolver, type CatalogKind, type ResolvedCatalog } from './catalog.ts';
import { ControlError, newId } from './control.ts';
import { admitPaper, quotaDocument } from './quota.ts';
import { agentBalances } from '@monad-hack/accounting';
import type { Strategy } from '@monad-hack/contracts';
import { checkLivePairs, liveTwins, promoteStrategy } from './live-launch.ts';
import type { LiveLaunchOptions } from './live-launch.ts';
import type { AuditActor, RuntimeControlStore } from './runtime-control/store.ts';
import { RunControlError } from './runtime-control/store.ts';

// Preserve the stable broker budget reason in the existing run-error view.
const BUDGET_ERROR = `(select b.response->'reason' || jsonb_build_object('nodeId',b.node_id) from broker_results b
  where b.tenant_id=r.tenant_id and b.run_id=r.run_id and b.node_id=r.checkpoint#>>'{error,nodeId}'
  and b.response->>'disposition'='refused' and b.response#>>'{reason,code}'='BROKER_BUDGET_EXHAUSTED'
  order by b.received_at desc,b.id desc limit 1)`;

/** Virtual denomination the market presets trade from (D42): the stack and the hosted entry point both fund it. */
export const MARKET_PAPER_FUNDING_ASSET = 'paper.USDC';
const ESTIMATE_MINUTES = 15;
/** How recent the caps approval must be for a live launch to rely on it. */
const LIVE_APPROVAL_MILLIS = 60 * 60_000;
/** Paper policy defaults by experience (product.md modes); live authority is never granted here. */
const PAPER_POLICY: Record<Experience, { maxSlippageBps: number; dailyActionCount: number }> = {
  rookie: { maxSlippageBps: 50, dailyActionCount: 24 },
  advanced: { maxSlippageBps: 100, dailyActionCount: 288 },
};

export interface LifecycleOptions {
  readonly pool: pg.Pool;
  readonly runtime: RuntimeControlStore;
  /** Digest of the runtime image deployments pin; runtimes refuse assignments for any other image. */
  readonly runtimeImageDigest: string;
  /** Resolves catalogs from catalog_versions (issue #18); a default resolver when absent. */
  readonly catalog?: CatalogResolver;
  /** Explicit virtual denomination; this is not a USDC/USD market conversion. */
  readonly paperFundingAsset?: string;
  /** Live launches (D61): the custody network agents trade on. Absent: live requests are refused. */
  readonly live?: LiveLaunchOptions;
  readonly now?: () => Date;
}

type Operation = Record<string, unknown> & { id: string };

const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RUN = /^0x[0-9a-f]{64}$/;
const iso = (d: Date | string): string => (typeof d === 'string' ? new Date(d) : d).toISOString();

/** Translate a runtime-control error into the user-facing error body. */
function userError(error: unknown): never {
  if (error instanceof RunControlError) {
    const code = error.code === 'LEASE_FENCED' || error.code === 'GENERATION_REVOKED' ? 'REVISION_CONFLICT' : error.code;
    throw new ControlError(error.status, code, error.message);
  }
  throw error;
}

export class LifecycleService {
  readonly #pool: pg.Pool;
  readonly #runtime: RuntimeControlStore;
  readonly #image: string;
  readonly #catalog: CatalogResolver;
  readonly #fundingAsset: string;
  readonly #live: LiveLaunchOptions | undefined;
  readonly #now: () => Date;

  constructor(options: LifecycleOptions) {
    this.#pool = options.pool;
    this.#runtime = options.runtime;
    this.#image = options.runtimeImageDigest;
    this.#catalog = options.catalog ?? new CatalogResolver();
    this.#fundingAsset = options.paperFundingAsset ?? "paper.USD";
    this.#live = options.live;
    this.#now = options.now ?? (() => new Date());
  }

  // ---- estimates --------------------------------------------------------------------------------------------

  /**
   * A paper estimate from the strategy's cadence and worst-case bounds, plus the policy snapshot a launch needs
   * (version 1 from the agent's experience when the agent has none). Not a priced quote or reservation.
   */
  async estimate(tenantId: string, agentId: string, strategyRevisionId?: string, mode: 'paper' | 'live' = 'paper'): Promise<Record<string, unknown>> {
    return this.#tx(async (c) => {
      const agent = await this.#agent(c, tenantId, agentId);
      const revisionId = strategyRevisionId ?? agent.revision_id;
      if (!revisionId) throw new ControlError(422, 'UNKNOWN_REFERENCE', 'Save a strategy revision before estimating.');
      if (mode === 'live') return this.#estimateLive(c, tenantId, agentId, revisionId, agent);
      const { catalog } = await this.#catalog.resolve(c, { mode: 'paper' });
      const program = await this.#program(c, tenantId, agentId, revisionId, catalog);
      const policy = await c.query<{ version: number }>('select max(version) as version from policies where tenant_id = $1 and agent_id = $2', [tenantId, agentId]);
      let policyVersion = policy.rows[0]?.version ?? null;
      if (!policyVersion) {
        policyVersion = 1;
        await c.query('insert into policies (tenant_id, agent_id, version, limits) values ($1, $2, 1, $3)', [tenantId, agentId, PAPER_POLICY[agent.experience]]);
      }
      const runsPerDay = dailyRuns(program);
      const now = this.#now();
      const estimate = {
        schemaVersion: 'paper-estimate/1' as const, id: newId(), agentId, strategyRevisionId: revisionId, budgetVersion: agent.budget_version, policyVersion, mode: 'paper' as const,
        runsPerDay: Math.min(runsPerDay, 100_000), worstCaseAiCallsPerDay: Math.min(runsPerDay * program.bounds.aiCalls, 300_000),
        createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + ESTIMATE_MINUTES * 60_000).toISOString(),
      };
      await c.query(
        'insert into estimates (tenant_id, id, agent_id, strategy_revision_id, assumptions, created_at, expires_at) values ($1, $2, $3, $4, $5, $6, $7)',
        [tenantId, estimate.id, agentId, revisionId, { kind: 'paper', runsPerDay: estimate.runsPerDay, bounds: program.bounds, budget: agent.paper_budget }, estimate.createdAt, estimate.expiresAt],
      );
      return estimate;
    });
  }

  // ---- launch and control -----------------------------------------------------------------------------------

  /** POST /v1/agents/{id}/deployments: validate a deployment/1 request and launch it. Idempotent by key. */
  async launch(tenantId: string, agentId: string, body: unknown, key: string): Promise<Operation> {
    const checked = validate('deploymentRequest', body);
    if (!checked.ok) throw new ControlError(400, 'SCHEMA_INVALID', checked.issues[0]!.message, { fieldPath: checked.issues[0]!.fieldPath });
    const request = checked.value;
    if (request.agentId !== agentId) throw new ControlError(400, 'SCHEMA_INVALID', 'agentId must match the route.', { fieldPath: '/agentId' });
    return this.#idempotent(tenantId, `POST /v1/agents/${agentId}/deployments`, key, request, async (c) => {
      if (request.mode === 'live') return this.#launchLive(c, tenantId, agentId, request);
      const agent = await this.#agent(c, tenantId, agentId, true);
      const open = await c.query<{ desired_state: string }>('select desired_state from deployments where tenant_id = $1 and agent_id = $2 and desired_state <> $3', [tenantId, agentId, 'stopped']);
      if (open.rows[0]?.desired_state === 'stopping') throw new ControlError(409, 'REVISION_CONFLICT', 'This agent is still stopping while its open trades settle; launch it again once it has stopped.');
      if (open.rows[0]) throw new ControlError(409, 'REVISION_CONFLICT', 'This agent already has a deployment; pause, resume or stop it instead.');
      const estimate = await c.query<{ strategy_revision_id: string; expires_at: Date }>('select strategy_revision_id, expires_at from estimates where tenant_id = $1 and id = $2 and agent_id = $3', [tenantId, request.estimateId, agentId]);
      if (!estimate.rows[0]) throw new ControlError(422, 'UNKNOWN_REFERENCE', 'Estimate not found for this agent.', { fieldPath: '/estimateId' });
      if (estimate.rows[0].strategy_revision_id !== request.strategyRevisionId) throw new ControlError(422, 'UNKNOWN_REFERENCE', 'The estimate is for a different revision.', { fieldPath: '/estimateId' });
      if (estimate.rows[0].expires_at.getTime() <= this.#now().getTime()) throw new ControlError(409, 'ESTIMATE_EXPIRED', 'The estimate expired; request a new one.', { fieldPath: '/estimateId' });
      if (request.budgetVersion !== agent.budget_version) throw new ControlError(409, 'REVISION_CONFLICT', 'The budget changed; refresh the estimate.', { fieldPath: '/budgetVersion' });
      const policy = await c.query('select 1 from policies where tenant_id = $1 and agent_id = $2 and version = $3', [tenantId, agentId, request.policyVersion]);
      if (!policy.rows[0]) throw new ControlError(422, 'UNKNOWN_REFERENCE', 'Policy version not found.', { fieldPath: '/policyVersion' });
      if (!agent.paper_budget) throw new ControlError(422, 'FUNDING_PENDING', 'Set virtual budget limits before launching.');

      // Resolve the pinned catalog first; the revision compiles against exactly what the deployment will pin.
      const connectorVersions = pinsOf(request.connectorSelections, '/connectorSelections');
      const modelProfiles = pinsOf(request.modelProfiles, '/modelProfiles');
      const resolved = await this.#catalog.resolve(c, {
        mode: 'paper', networkRef: request.networkRef, connectors: connectorVersions, modelProfiles, resourceProfileRef: request.resourceProfileRef,
      });
      const program = await this.#program(c, tenantId, agentId, request.strategyRevisionId, resolved.catalog);
      const issue = profileIssues(program.strategy, { experience: agent.experience, mode: 'paper' })[0];
      if (issue) throw new ControlError(422, issue.code, issue.message);
      checkConnectors(request, program, resolved);
      checkModels(modelProfiles, program);
      if (resolved.catalog.assets[this.#fundingAsset]?.decimals !== 6) {
        throw new ControlError(422, 'UNSUPPORTED_CAPABILITY', `The paper funding asset ${this.#fundingAsset} is not an enabled six-decimal asset on ${request.networkRef}.`, { fieldPath: '/networkRef' });
      }
      await this.#admit(c, tenantId, undefined);

      // The simulation account: virtual trading USD and the MON reserve from the saved paper budget.
      const session = await c.query<{ next: number }>('select coalesce(max(session), 0) + 1 as next from simulation_accounts where tenant_id = $1 and agent_id = $2', [tenantId, agentId]);
      const simulationAccountId = newId();
      await c.query('insert into simulation_accounts (tenant_id, id, agent_id, session) values ($1, $2, $3, $4)', [tenantId, simulationAccountId, agentId, session.rows[0]!.next]);
      const budget = agent.paper_budget as { tradingUsdMicros: string; monReserveAtomic: string };
      for (const [asset, amount] of Object.keys(resolved.catalog.assets).map((asset) => [asset, asset === this.#fundingAsset ? budget.tradingUsdMicros : asset === 'paper.MON' ? budget.monReserveAtomic : '0'] as const)) {
        await c.query('insert into simulation_balances (tenant_id, account_id, asset_ref, available) values ($1, $2, $3, $4)', [tenantId, simulationAccountId, asset, amount]);
      }
      let deployed;
      try {
        deployed = await this.#runtime.deployIn(c, {
          tenantId, agentId, strategyRevisionId: request.strategyRevisionId, mode: 'paper', catalog: resolved.catalog, catalogPins: resolved.pins, connectorVersions, modelProfiles,
          runtimeImageDigest: this.#image, networkRef: request.networkRef, policyVersion: request.policyVersion, budgetVersion: request.budgetVersion,
          resourceProfileRef: request.resourceProfileRef, estimateId: request.estimateId, simulationAccountId, actor: { kind: 'user', id: tenantId },
        });
      } catch (error) {
        userError(error);
      }
      return this.#operation(c, tenantId, agentId, deployed.deploymentId, 'deploy');
    });
  }

  /** Pause, resume or stop the agent's open deployment. Idempotent by key; each is one recorded operation. */
  async control(tenantId: string, agentId: string, kind: 'pause' | 'resume' | 'stop', key: string): Promise<Operation> {
    return this.#idempotent(tenantId, `POST /v1/agents/${agentId}/${kind}`, key, { kind }, async (c) => {
      await this.#agent(c, tenantId, agentId);
      const open = await c.query<{ id: string }>('select id from deployments where tenant_id = $1 and agent_id = $2 and desired_state <> $3 for no key update', [tenantId, agentId, 'stopped']);
      const deploymentId = open.rows[0]?.id;
      if (!deploymentId) throw new ControlError(409, 'REVISION_CONFLICT', 'This agent has no open deployment.');
      const actor: AuditActor = { kind: 'user', id: tenantId };
      if (kind === 'resume') {
        await this.#checkPins(c, tenantId, deploymentId);
        // Paper sandbox quotas apply to paper deployments only; live agents spend their own funds within caps.
        const mode = await c.query<{ mode: string }>('select mode from deployments where id = $1', [deploymentId]);
        if (mode.rows[0]?.mode === 'paper') await this.#admit(c, tenantId, deploymentId);
      }
      try {
        if (kind === 'pause') await this.#runtime.pauseIn(c, deploymentId, actor);
        else if (kind === 'resume') await this.#runtime.resumeIn(c, deploymentId, actor);
        else await this.#runtime.stopIn(c, deploymentId, actor);
      } catch (error) {
        userError(error);
      }
      return this.#operation(c, tenantId, agentId, deploymentId, kind);
    });
  }

  /** GET /v1/quota: the tenant's paper sandbox usage and limits (issue #17). */
  async quota(tenantId: string): Promise<Record<string, unknown>> {
    return quotaDocument(this.#pool, tenantId, this.#now());
  }

  async operation(tenantId: string, id: string): Promise<Operation> {
    if (!UUID7.test(id)) throw new ControlError(404, 'NOT_FOUND', 'Operation not found.');
    const { rows } = await this.#pool.query('select * from deployment_operations where tenant_id = $1 and id = $2', [tenantId, id]);
    if (!rows[0]) throw new ControlError(404, 'NOT_FOUND', 'Operation not found.');
    return operationDoc(rows[0]);
  }

  /** The agent's open deployment, or its most recent one; 404 when it never launched. */
  async deployment(tenantId: string, agentId: string): Promise<Record<string, unknown>> {
    await this.#agent(this.#pool, tenantId, agentId);
    const { rows } = await this.#pool.query(
      `select * from deployments where tenant_id = $1 and agent_id = $2 order by (desired_state <> 'stopped') desc, created_at desc limit 1`, [tenantId, agentId],
    );
    const d = rows[0];
    if (!d) throw new ControlError(404, 'NOT_FOUND', 'This agent has not been launched.');
    return {
      schemaVersion: 'agent-deployment/1', agentId, deploymentId: d.id, generation: String(d.generation), mode: d.mode, desiredState: d.desired_state,
      strategyRevisionId: d.strategy_revision_id, manifestHash: d.manifest_hash, ...(d.simulation_account_id ? { simulationAccountId: d.simulation_account_id } : {}), updatedAt: iso(d.updated_at),
      ...(d.desired_state === 'stopping' ? { openIntents: await this.#openIntents(d.id) } : {}),
    };
  }

  // ---- history (API-6) ---------------------------------------------------------------------------------------

  async runs(tenantId: string, agentId: string, limit: number, cursor?: string): Promise<{ items: Record<string, unknown>[]; nextCursor: string | null }> {
    await this.#agent(this.#pool, tenantId, agentId);
    if (cursor !== undefined && !RUN.test(cursor)) throw new ControlError(400, 'MALFORMED_REQUEST', 'Invalid cursor.');
    const { rows } = await this.#pool.query(
      `select r.*,${BUDGET_ERROR} as broker_error from runs r join deployments d on d.tenant_id = r.tenant_id and d.id = r.deployment_id
       where r.tenant_id = $1 and d.agent_id = $2
         and ($3::text is null or (r.created_at, r.run_id) < (select created_at, run_id from runs where run_id = $3 and tenant_id = $1))
       order by r.created_at desc, r.run_id desc limit $4`,
      [tenantId, agentId, cursor ?? null, limit + 1],
    );
    const items = rows.slice(0, limit).map(runSummary);
    return { items, nextCursor: rows.length > limit ? String(rows[limit - 1].run_id) : null };
  }

  async run(tenantId: string, runId: string): Promise<Record<string, unknown>> {
    if (!RUN.test(runId)) throw new ControlError(404, 'NOT_FOUND', 'Run not found.');
    const { rows } = await this.#pool.query(`select r.*,${BUDGET_ERROR} as broker_error from runs r where r.tenant_id = $1 and r.run_id = $2`, [tenantId, runId]);
    if (!rows[0]) throw new ControlError(404, 'NOT_FOUND', 'Run not found.');
    const ops = await this.#pool.query('select * from run_operations where run_id = $1 order by created_at, operation_key limit 64', [runId]);
    const notes = await this.#pool.query('select node_id, message, created_at from timeline_entries where run_id = $1 order by created_at limit 64', [runId]);
    const trigger = rows[0].trigger as { observedAt?: string; acceptedAt: string; runCreatedAt: string };
    return {
      ...runSummary(rows[0]), schemaVersion: 'run-detail/1',
      trigger: { ...(trigger.observedAt ? { observedAt: trigger.observedAt } : {}), acceptedAt: trigger.acceptedAt, runCreatedAt: trigger.runCreatedAt },
      operations: ops.rows.map((o) => ({
        operationKey: o.operation_key, kind: o.kind, nodeId: o.node_id, iterationPath: o.iteration_path,
        ...(o.outcome ? { outcome: o.outcome } : {}), ...(o.result_ref ? { resultRef: o.result_ref } : {}), updatedAt: iso(o.updated_at),
      })),
      timeline: notes.rows.map((n) => ({ nodeId: n.node_id, message: n.message, createdAt: iso(n.created_at) })),
    };
  }

  /**
   * audit-event/2 rows for the agent after a sequence (the SSE cursor), oldest first. Cursor 0 means "from the
   * oldest kept event". A cursor below the tenant's retention floor throws CURSOR_EXPIRED with the sequence to
   * resume from (D57): events after it may have been pruned, and an empty page must not imply none occurred.
   */
  async events(tenantId: string, agentId: string, after: bigint, limit: number): Promise<Record<string, unknown>[]> {
    // One statement, one snapshot: the floor and the page cannot straddle a concurrent prune.
    const { rows } = await this.#pool.query(
      `with floor as (select coalesce((select retained_after from tenant_streams where tenant_id = $1), 0) as retained_after)
       select floor.retained_after as floor_sequence, e.* from floor
       left join lateral (
         select * from audit_events
         where tenant_id = $1 and agent_id = $2 and sequence > greatest($3::bigint, floor.retained_after)
         order by sequence limit $4
       ) e on true`,
      [tenantId, agentId, after.toString(), limit],
    );
    const floor = BigInt(rows[0].floor_sequence);
    if (after > 0n && after < floor) {
      throw new ControlError(410, 'CURSOR_EXPIRED', 'Older activity was removed by retention; reload history and resume from the oldest kept event.', { details: { resumeFrom: floor.toString() } });
    }
    return rows.filter((e) => e.sequence !== null).map((e) => ({
      schemaVersion: 'audit-event/2', sequence: String(e.sequence), tenantId: e.tenant_id,
      ...(e.agent_id ? { agentId: e.agent_id } : {}), ...(e.deployment_id ? { deploymentId: e.deployment_id } : {}),
      ...(e.run_id ? { runId: e.run_id } : {}), ...(e.intent_id ? { intentId: e.intent_id } : {}),
      actor: e.actor_id ? { kind: e.actor_kind, id: e.actor_id } : { kind: e.actor_kind }, traceId: e.trace_id, type: e.type, occurredAt: iso(e.occurred_at), payload: e.payload,
    }));
  }

  /** Latest enabled paper versions of connectors and model profiles, for building a deployment request. */
  async paperVersions(): Promise<{ connectors: Record<string, string>; modelProfiles: Record<string, string> }> {
    return this.#catalog.latestVersions(this.#pool, 'paper');
  }

  /** The enabled paper catalog drafts compile against (every paper network, newest usable versions). */
  async paperCatalog(): Promise<Catalog> {
    return (await this.#catalog.resolve(this.#pool, { mode: 'paper' })).catalog;
  }

  async assertAgent(tenantId: string, agentId: string): Promise<void> {
    await this.#agent(this.#pool, tenantId, agentId);
  }

  // ---- live (D61) -------------------------------------------------------------------------------------------

  /** The live network when live launches are enabled on this server. */
  get liveNetworkRef(): string | undefined {
    return this.#live?.networkRef;
  }

  /** Newest enabled live connector and model versions (what a live deployment request pins). */
  async liveVersions(): Promise<{ connectors: Record<string, string>; modelProfiles: Record<string, string> }> {
    return this.#catalog.latestVersions(this.#pool, 'live');
  }

  #liveOptions(): LiveLaunchOptions {
    if (!this.#live) throw new ControlError(422, 'CAPABILITY_DISABLED', 'Live trading is not enabled on this server; launch in paper mode.');
    return this.#live;
  }

  /** The newest live policy version: caps set with a step-up approval (FundsService.setLivePolicy). */
  async #livePolicy(c: pg.PoolClient, tenantId: string, agentId: string, version?: number): Promise<number | undefined> {
    const { rows } = await c.query<{ version: number }>(
      `select version from policies where tenant_id = $1 and agent_id = $2 and limits ->> 'mode' = 'live'${version === undefined ? '' : ' and version = $3'} order by version desc limit 1`,
      version === undefined ? [tenantId, agentId] : [tenantId, agentId, version]);
    return rows[0]?.version;
  }

  /** The saved revision with its paper refs mapped to live twins, compiled against the live catalog. */
  async #promoted(c: pg.PoolClient, tenantId: string, agentId: string, revisionId: string, catalog: Catalog, networkRef: string, connectorVersions?: Readonly<Record<string, string>>): Promise<{ strategy: Strategy; program: CompiledStrategy }> {
    const { rows } = await c.query<{ ast: Strategy }>('select ast from strategy_revisions where tenant_id = $1 and agent_id = $2 and id = $3', [tenantId, agentId, revisionId]);
    if (!rows[0]) throw new ControlError(422, 'UNKNOWN_REFERENCE', 'Strategy revision not found for this agent.', { fieldPath: '/strategyRevisionId' });
    const strategy = promoteStrategy(rows[0].ast, await liveTwins(c, networkRef));
    await checkLivePairs(c, strategy, connectorVersions);
    try {
      return { strategy, program: await compileStrategy(JSON.stringify(strategy), catalog) };
    } catch (error) {
      throw new ControlError(422, 'UNSUPPORTED_CAPABILITY', `This strategy cannot run live: ${(error as Error).message}`);
    }
  }

  async #estimateLive(c: pg.PoolClient, tenantId: string, agentId: string, revisionId: string, agent: { experience: Experience; budget_version: number }): Promise<Record<string, unknown>> {
    const live = this.#liveOptions();
    if (agent.experience !== 'advanced') throw new ControlError(422, 'POLICY_DENIED', 'Live trading needs the advanced experience; rookie strategies run in paper mode.');
    const policyVersion = await this.#livePolicy(c, tenantId, agentId);
    if (!policyVersion) throw new ControlError(422, 'UNKNOWN_REFERENCE', 'Set live trading limits (with a one-time code) before estimating a live launch.');
    const { catalog } = await this.#catalog.resolve(c, { mode: 'live', networkRef: live.networkRef });
    const { program } = await this.#promoted(c, tenantId, agentId, revisionId, catalog, live.networkRef);
    const now = this.#now();
    const estimate = {
      schemaVersion: 'live-estimate/1' as const, id: newId(), agentId, strategyRevisionId: revisionId, budgetVersion: agent.budget_version, policyVersion, mode: 'live' as const,
      runsPerDay: Math.min(dailyRuns(program), 100_000), worstCaseAiCallsPerDay: 0,
      createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + ESTIMATE_MINUTES * 60_000).toISOString(),
    };
    await c.query(
      'insert into estimates (tenant_id, id, agent_id, strategy_revision_id, assumptions, created_at, expires_at) values ($1, $2, $3, $4, $5, $6, $7)',
      [tenantId, estimate.id, agentId, revisionId, { kind: 'live', networkRef: live.networkRef, runsPerDay: estimate.runsPerDay, bounds: program.bounds }, estimate.createdAt, estimate.expiresAt],
    );
    return estimate;
  }

  /**
   * Live launch: the saved revision promoted to live refs and stored as a derived revision, live caps from a
   * step-up-approved policy, a funded custodial wallet on the live network, and no simulation account.
   */
  async #launchLive(c: pg.PoolClient, tenantId: string, agentId: string, request: DeploymentRequest): Promise<Operation> {
    const live = this.#liveOptions();
    if (request.networkRef !== live.networkRef) throw new ControlError(422, 'UNSUPPORTED_CAPABILITY', `Live agents trade on ${live.networkRef}.`, { fieldPath: '/networkRef' });
    const agent = await this.#agent(c, tenantId, agentId, true);
    const open = await c.query<{ desired_state: string }>('select desired_state from deployments where tenant_id = $1 and agent_id = $2 and desired_state <> $3', [tenantId, agentId, 'stopped']);
    if (open.rows[0]) throw new ControlError(409, 'REVISION_CONFLICT', 'This agent already has a deployment; pause, resume or stop it instead.');
    const estimate = await c.query<{ strategy_revision_id: string; expires_at: Date; assumptions: { kind?: string } }>('select strategy_revision_id, expires_at, assumptions from estimates where tenant_id = $1 and id = $2 and agent_id = $3', [tenantId, request.estimateId, agentId]);
    if (!estimate.rows[0] || estimate.rows[0].assumptions.kind !== 'live') throw new ControlError(422, 'UNKNOWN_REFERENCE', 'Live estimate not found for this agent.', { fieldPath: '/estimateId' });
    if (estimate.rows[0].strategy_revision_id !== request.strategyRevisionId) throw new ControlError(422, 'UNKNOWN_REFERENCE', 'The estimate is for a different revision.', { fieldPath: '/estimateId' });
    if (estimate.rows[0].expires_at.getTime() <= this.#now().getTime()) throw new ControlError(409, 'ESTIMATE_EXPIRED', 'The estimate expired; request a new one.', { fieldPath: '/estimateId' });
    if (request.budgetVersion !== agent.budget_version) throw new ControlError(409, 'REVISION_CONFLICT', 'The budget changed; refresh the estimate.', { fieldPath: '/budgetVersion' });
    if ((await this.#livePolicy(c, tenantId, agentId, request.policyVersion)) === undefined) {
      throw new ControlError(422, 'UNKNOWN_REFERENCE', 'Live launches need a live policy version (caps set with a one-time code).', { fieldPath: '/policyVersion' });
    }
    // Consent: the step-up approval that set these exact caps, verified within the last hour.
    const approval = await c.query<{ verified_at: Date | null }>(
      `select s.verified_at from step_up_challenges s join policies p on p.tenant_id = s.tenant_id and p.limits ->> 'approvedBy' = s.id::text
       where s.tenant_id = $1 and s.id = $2 and s.purpose = 'livePolicy' and s.consumed_at is not null and p.agent_id = $3 and p.version = $4`,
      [tenantId, request.stepUpApprovalId, agentId, request.policyVersion]);
    const verifiedAt = approval.rows[0]?.verified_at;
    if (!verifiedAt || this.#now().getTime() - verifiedAt.getTime() > LIVE_APPROVAL_MILLIS) {
      throw new ControlError(403, 'FORBIDDEN', 'Going live needs the one-time-code approval of these caps from the last hour; set the caps again.', { fieldPath: '/stepUpApprovalId' });
    }
    const connectorVersions = pinsOf(request.connectorSelections, '/connectorSelections');
    const modelProfiles = pinsOf(request.modelProfiles, '/modelProfiles');
    const resolved = await this.#catalog.resolve(c, { mode: 'live', networkRef: live.networkRef, connectors: connectorVersions, modelProfiles, resourceProfileRef: request.resourceProfileRef });
    const { strategy, program } = await this.#promoted(c, tenantId, agentId, request.strategyRevisionId, resolved.catalog, live.networkRef, connectorVersions);
    const issue = profileIssues(program.strategy, { experience: agent.experience, mode: 'live' })[0];
    if (issue) throw new ControlError(422, issue.code, issue.message);
    checkConnectors(request, program, resolved);
    checkModels(modelProfiles, program);
    // Funds: an active custodial wallet on the live chain holding enough trading MON for gas and the reserve.
    const wallet = await c.query('select 1 from wallets where tenant_id = $1 and agent_id = $2 and chain_id = $3 and status = $4', [tenantId, agentId, live.chainId, 'active']);
    if (!wallet.rowCount) throw new ControlError(422, 'FUNDING_PENDING', `Open this agent's wallet on ${live.networkRef} and fund it before going live.`);
    const gas = (await agentBalances(c, { mode: 'live', tenantId, agentId })).find((b) => b.kind === 'user' && b.bucket === 'trading' && b.assetRef === live.gasAssetRef);
    if (!gas || gas.available < live.minTradingGasAtomic) {
      throw new ControlError(422, 'FUNDING_PENDING', 'Allocate more MON to trading: the agent needs its gas reserve plus one trade\'s gas before it can go live.');
    }
    // The promoted strategy is its own immutable revision, linked to the saved one it came from.
    const derivedId = newId();
    await c.query(
      `insert into strategy_revisions (tenant_id, id, agent_id, language_version, content_hash, ast, validation) values ($1, $2, $3, $4, $5, $6, $7)`,
      [tenantId, derivedId, agentId, strategy.schemaVersion, program.hash, strategy, { kind: 'livePromotion', derivedFrom: request.strategyRevisionId, networkRef: live.networkRef }]);
    let deployed;
    try {
      deployed = await this.#runtime.deployIn(c, {
        tenantId, agentId, strategyRevisionId: derivedId, mode: 'live', catalog: resolved.catalog, catalogPins: resolved.pins, connectorVersions, modelProfiles,
        runtimeImageDigest: this.#image, networkRef: live.networkRef, policyVersion: request.policyVersion, budgetVersion: request.budgetVersion,
        resourceProfileRef: request.resourceProfileRef, estimateId: request.estimateId, actor: { kind: 'user', id: tenantId },
      });
    } catch (error) {
      userError(error);
    }
    return this.#operation(c, tenantId, agentId, deployed.deploymentId, 'deploy');
  }

  // ---- internals ---------------------------------------------------------------------------------------------

  async #agent(c: pg.Pool | pg.PoolClient, tenantId: string, agentId: string, lock = false) {
    if (!UUID7.test(agentId)) throw new ControlError(404, 'NOT_FOUND', 'Strategy not found.');
    const { rows } = await c.query<{ revision_id: string | null; experience: Experience; budget_version: number; paper_budget: Record<string, string> | null }>(
      `select revision_id, experience, budget_version, paper_budget from agents where tenant_id = $1 and id = $2${lock ? ' for update' : ''}`, [tenantId, agentId],
    );
    if (!rows[0]) throw new ControlError(404, 'NOT_FOUND', 'Strategy not found.');
    return rows[0];
  }

  async #program(c: pg.PoolClient, tenantId: string, agentId: string, revisionId: string, catalog: Catalog): Promise<CompiledStrategy> {
    const { rows } = await c.query<{ ast: unknown }>('select ast from strategy_revisions where tenant_id = $1 and agent_id = $2 and id = $3', [tenantId, agentId, revisionId]);
    if (!rows[0]) throw new ControlError(422, 'UNKNOWN_REFERENCE', 'Strategy revision not found for this agent.', { fieldPath: '/strategyRevisionId' });
    return compileStrategy(JSON.stringify(rows[0].ast), catalog);
  }

  async #openIntents(deploymentId: string): Promise<number> {
    const { rows } = await this.#pool.query<{ n: string }>(`select count(*) as n from intents where deployment_id = $1 and state not in ('rejected', 'settled', 'failed', 'cancelled')`, [deploymentId]);
    return Number(rows[0]!.n);
  }

  /** Paper sandbox admission (D58): per-user concurrency, session and daily time, global capacity; 429 with the reason. */
  async #admit(c: pg.PoolClient, tenantId: string, deploymentId: string | undefined): Promise<void> {
    const refused = await admitPaper(c, tenantId, deploymentId, this.#now());
    if (refused) throw new ControlError(429, 'LIMIT_EXCEEDED', refused.message, { details: { reason: refused.reason } });
  }

  /** A resume refuses when a pinned catalog row was disabled (or removed) since launch. */
  async #checkPins(c: pg.PoolClient, tenantId: string, deploymentId: string): Promise<void> {
    const { rows } = await c.query<{ mode: 'paper' | 'live'; manifest: Record<string, unknown> | null }>('select mode, manifest from deployments where tenant_id = $1 and id = $2', [tenantId, deploymentId]);
    const manifest = rows[0]?.manifest;
    if (!rows[0] || !manifest) return;
    const pins = manifest['schemaVersion'] === 'deployment-manifest/2'
      ? manifest['catalogPins'] as { kind: CatalogKind; ref: string; version: string; contentHash: string }[]
      // deployment-manifest/1 recorded only connector and model versions.
      : [
        ...Object.entries(manifest['connectorVersions'] as Record<string, string>).map(([ref, version]) => ({ kind: 'connector' as const, ref, version })),
        ...Object.entries(manifest['modelProfiles'] as Record<string, string>).map(([ref, version]) => ({ kind: 'modelProfile' as const, ref, version })),
      ];
    await this.#catalog.checkPins(c, rows[0].mode, pins);
  }

  async #operation(c: pg.PoolClient, tenantId: string, agentId: string, deploymentId: string, kind: string): Promise<Operation> {
    const { rows } = await c.query(
      `insert into deployment_operations (tenant_id, id, agent_id, deployment_id, kind, state) values ($1, $2, $3, $4, $5, 'succeeded') returning *`,
      [tenantId, newId(), agentId, deploymentId, kind],
    );
    return operationDoc(rows[0]);
  }

  /** Same scheme as revision saves: advisory lock, request hash, stored response replayed for the same key. */
  async #idempotent(tenantId: string, scope: string, key: string, request: unknown, work: (c: pg.PoolClient) => Promise<Operation>): Promise<Operation> {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(key)) throw new ControlError(400, 'MALFORMED_REQUEST', 'A valid Idempotency-Key is required.');
    const hash = await contentHash(request);
    return this.#tx(async (c) => {
      await c.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`${tenantId}:${scope}:${key}`]);
      const replay = await c.query<{ request_hash: string; response: Operation }>('select request_hash, response from control_requests where tenant_id = $1 and scope = $2 and key = $3', [tenantId, scope, key]);
      if (replay.rows[0]) {
        if (replay.rows[0].request_hash !== hash) throw new ControlError(409, 'IDEMPOTENCY_CONFLICT', 'This request key was already used for a different request.');
        return replay.rows[0].response;
      }
      const response = await work(c);
      await c.query('insert into control_requests (tenant_id, scope, key, request_hash, response) values ($1, $2, $3, $4, $5)', [tenantId, scope, key, hash, response]);
      return response;
    });
  }

  async #tx<T>(work: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await this.#pool.connect();
    try {
      await c.query('begin');
      const result = await work(c);
      await c.query('commit');
      return result;
    } catch (error) {
      await c.query('rollback');
      throw error;
    } finally {
      c.release();
    }
  }
}

function operationDoc(row: Record<string, unknown>): Operation {
  return {
    schemaVersion: 'deployment-operation/1', id: String(row['id']), agentId: String(row['agent_id']),
    ...(row['deployment_id'] ? { deploymentId: String(row['deployment_id']) } : {}), kind: row['kind'], state: row['state'],
    ...(row['error_code'] ? { error: { code: row['error_code'], message: row['error_message'] } } : {}),
    createdAt: iso(row['created_at'] as Date), updatedAt: iso(row['updated_at'] as Date),
  };
}

function runSummary(row: Record<string, unknown>): Record<string, unknown> {
  const checkpoint = row['checkpoint'] as { error?: { code: string; message: string; nodeId?: string } } | null;
  const error = (row['broker_error'] as { code: string; message: string; nodeId?: string } | null) ?? checkpoint?.error;
  return {
    schemaVersion: 'run-summary/1', runId: row['run_id'], deploymentId: row['deployment_id'], generation: String(row['generation']), triggerId: row['trigger_id'], status: row['status'],
    ...(error ? { error: { code: error.code, message: error.message, ...(error.nodeId ? { nodeId: error.nodeId } : {}) } } : {}),
    createdAt: iso(row['created_at'] as Date), updatedAt: iso(row['updated_at'] as Date),
  };
}

/** Exact {ref: version} pins from request selections; a ref selected twice is refused. */
/** Runs a day from the trigger cadence (schedule interval, or price cooldown with a one-minute floor). */
function dailyRuns(program: CompiledStrategy): number {
  return program.strategy.triggers.reduce((sum, trigger) => {
    if (trigger.type === 'schedule') return sum + Math.ceil(86_400 / trigger.intervalSeconds);
    if (trigger.type === 'price.crossesAbove' || trigger.type === 'price.crossesBelow') return sum + Math.ceil(86_400 / Math.max(trigger.cooldownSeconds, 60));
    return sum;
  }, 0);
}

function pinsOf(selections: readonly { ref: string; version: string }[], fieldPath: string): Record<string, string> {
  const pins: Record<string, string> = {};
  for (const [i, selection] of selections.entries()) {
    if (pins[selection.ref]) throw new ControlError(422, 'SCHEMA_INVALID', `${selection.ref} is selected twice.`, { fieldPath: `${fieldPath}/${i}` });
    pins[selection.ref] = selection.version;
  }
  return pins;
}

/** Every selected capability is offered; every connector and capability the strategy uses is selected. */
function checkConnectors(request: DeploymentRequest, program: CompiledStrategy, resolved: ResolvedCatalog): void {
  for (const [i, selection] of request.connectorSelections.entries()) {
    const offered = new Set(resolved.capabilities[selection.ref] ?? []);
    const missing = selection.capabilities.find((capability) => !offered.has(capability));
    if (missing) throw new ControlError(422, 'UNSUPPORTED_CAPABILITY', `${selection.ref} does not offer ${missing}.`, { fieldPath: `/connectorSelections/${i}/capabilities` });
  }
  for (const { connectorRef, capability } of usedCapabilities(program)) {
    const selection = request.connectorSelections.find((s) => s.ref === connectorRef);
    if (!selection || !selection.capabilities.includes(capability)) {
      throw new ControlError(422, 'UNSUPPORTED_CAPABILITY', `The strategy needs ${capability} on ${connectorRef}; select it.`, { fieldPath: '/connectorSelections' });
    }
  }
}

function checkModels(pins: Readonly<Record<string, string>>, program: CompiledStrategy): void {
  for (const ref of usedModels(program)) {
    if (!pins[ref]) throw new ControlError(422, 'UNSUPPORTED_CAPABILITY', `The strategy uses the model profile ${ref}; select it.`, { fieldPath: '/modelProfiles' });
  }
}

function walk(program: CompiledStrategy, visit: (node: Record<string, unknown>) => void): void {
  const go = (body: readonly unknown[]): void => {
    for (const node of body as Record<string, unknown>[]) {
      visit(node);
      for (const key of ['then', 'else', 'body']) if (Array.isArray(node[key])) go(node[key] as unknown[]);
    }
  };
  for (const trigger of program.strategy.triggers) go(trigger.body);
}

function usedCapabilities(program: CompiledStrategy): { connectorRef: string; capability: string }[] {
  const used: { connectorRef: string; capability: string }[] = [];
  walk(program, (node) => {
    if (node['type'] === 'swap.exactInput') used.push({ connectorRef: String(node['connectorRef']), capability: 'swap.exactInput' });
    if (node['type'] === 'read') used.push({ connectorRef: String(node['connectorRef']), capability: String(node['operation']) });
  });
  return used;
}

function usedModels(program: CompiledStrategy): string[] {
  const refs: string[] = [];
  walk(program, (node) => {
    if (node['type'] === 'ai.decide') refs.push(String(node['modelProfileRef']));
  });
  return refs;
}
