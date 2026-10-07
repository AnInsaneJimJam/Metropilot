// Runtime-facing control plane on PostgreSQL (docs/integration/control-api.md). Two roles:
//  - the routes a runtime calls (poll, artifacts, run state, wait, results, complete, timeline, heartbeat);
//  - API-worker roles the runtime never performs (deploy, fan-out, schedules, resume, pause, lease reclaim).
// Every run mutation runs in one transaction that holds the run row lock and checks the current lease and
// generation in that transaction. Network calls never happen inside a transaction here.
import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import { contentHash, validate } from '@monad-hack/contracts';
import type { AssignmentOfferV2, AssignmentPoll, RunComplete, RunResult, RunState, RunWait, RuntimeAssignment, TimelineEntry } from '@monad-hack/contracts';
import { compileStrategy, LanguageError, runIdentity, scheduleSlot, transitionPrice } from '@monad-hack/strategy';
import type { Catalog, CompiledStrategy, CrossingState, PriceObservation } from '@monad-hack/strategy';

/** error-1 codes this store raises, with their HTTP status. */
export const CONTROL_STATUS = {
  LEASE_FENCED: 409,
  GENERATION_REVOKED: 409,
  IDEMPOTENCY_CONFLICT: 409,
  SCHEMA_INVALID: 400,
  NOT_FOUND: 404,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
} as const;
export type ControlCode = keyof typeof CONTROL_STATUS;

export class RunControlError extends Error {
  readonly code: ControlCode;
  readonly status: number;
  constructor(code: ControlCode, message: string) {
    super(message);
    this.name = 'RunControlError';
    this.code = code;
    this.status = CONTROL_STATUS[code];
  }
}

type Outcome = RunResult['outcome'];
const TERMINAL = new Set<string>(['settled', 'rejected', 'failed', 'acknowledged', 'recorded', 'timeout', 'refused']);
const sha = (text: string): string => '0x' + createHash('sha256').update(text).digest('hex');
const at = (base: string, offsetMillis: number): string => new Date(Date.parse(base) + offsetMillis).toISOString();

export interface StoreOptions {
  readonly pool: pg.Pool;
  readonly now?: () => string;
  readonly leaseMillis?: number;
  readonly assignmentMillis?: number;
  readonly capabilityMillis?: number;
}

export interface DeployInput {
  readonly tenantId: string;
  readonly agentId: string;
  readonly strategyRevisionId: string;
  readonly mode: 'paper' | 'live';
  readonly catalog: Catalog;
  readonly connectorVersions: Readonly<Record<string, string>>;
  readonly runtimeImageDigest: string;
}

export interface FanOut {
  readonly deploymentId: string;
  readonly triggerId: string;
  readonly reason: string;
  readonly runId?: string;
}

/** What a bearer capability authorizes: exactly one assignment of one run. */
export interface CapabilityScope {
  readonly assignmentId: string;
  readonly runId: string;
  readonly tenantId: string;
  readonly deploymentId: string;
}

interface RunRow {
  tenant_id: string;
  run_id: string;
  deployment_id: string;
  generation: number;
  deployment_revision: string;
  trigger_id: string;
  source_event_key: string;
  trigger: RuntimeAssignment['trigger'];
  status: string;
  checkpoint: RunState['checkpoint'] | null;
  recorded: RunState['recorded'] | null;
  observation_refs: string[];
  deployment_generation: number;
  desired_state: string;
}

export class RuntimeControlStore {
  readonly #pool: pg.Pool;
  readonly #now: () => string;
  readonly #leaseMillis: number;
  readonly #assignmentMillis: number;
  readonly #capabilityMillis: number;
  /** Compiled programs are immutable per deployment, so caching them is safe. */
  readonly #programs = new Map<string, Promise<CompiledStrategy>>();

  constructor(options: StoreOptions) {
    this.#pool = options.pool;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#leaseMillis = options.leaseMillis ?? 30_000;
    this.#assignmentMillis = options.assignmentMillis ?? 60_000;
    this.#capabilityMillis = options.capabilityMillis ?? 300_000;
  }

  // ---- Worker role: deployment ------------------------------------------------------------------------------

  /** Pin a saved revision as a running paper/live deployment (minimal until the API-2 lifecycle exists). */
  async deploy(input: DeployInput): Promise<{ deploymentId: string; generation: number }> {
    return this.#tx(async (c) => {
      const revision = await c.query<{ ast: unknown; content_hash: string }>(
        'select ast, content_hash from strategy_revisions where tenant_id = $1 and agent_id = $2 and id = $3',
        [input.tenantId, input.agentId, input.strategyRevisionId],
      );
      if (!revision.rows[0]) throw new RunControlError('NOT_FOUND', 'Strategy revision not found for this agent.');
      const program = await compileStrategy(JSON.stringify(revision.rows[0].ast), input.catalog);
      if (program.hash !== revision.rows[0].content_hash) throw new RunControlError('SCHEMA_INVALID', 'Stored revision hash does not match its AST.');
      const deploymentId = uuidv7();
      const catalogHash = await contentHash(input.catalog);
      await c.query(
        `insert into deployments (tenant_id, id, agent_id, strategy_revision_id, mode, strategy_hash, catalog_hash, connector_versions, runtime_image_digest)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [input.tenantId, deploymentId, input.agentId, input.strategyRevisionId, input.mode, program.hash, catalogHash, input.connectorVersions, input.runtimeImageDigest],
      );
      await c.query(
        `insert into artifacts (ref, tenant_id, deployment_id, kind, content_hash, body) values
         ($1, $3, $4, 'strategy', $5, $6), ($2, $3, $4, 'catalog', $7, $8)`,
        [strategyRef(deploymentId), catalogRef(deploymentId), input.tenantId, deploymentId, program.hash, program.canonicalJson, catalogHash, JSON.stringify(input.catalog)],
      );
      for (const trigger of program.strategy.triggers) {
        await c.query(
          'insert into trigger_state (tenant_id, deployment_id, trigger_id, trigger_type, feed_ref, generation) values ($1, $2, $3, $4, $5, 1)',
          [input.tenantId, deploymentId, trigger.id, trigger.type, 'feedRef' in trigger ? trigger.feedRef : null],
        );
      }
      return { deploymentId, generation: 1 };
    });
  }

  /** Pause revokes authority for new operations at once; dispatched effects stay with their owners. */
  async pause(deploymentId: string): Promise<void> {
    await this.#tx(async (c) => {
      await c.query("update deployments set desired_state = 'paused', updated_at = now() where id = $1", [deploymentId]);
      await c.query('update trigger_state set active = false where deployment_id = $1', [deploymentId]);
    });
  }

  /** Resume mints a new generation. Unfinished runs of the old generation are revoked and never offered again. */
  async resume(deploymentId: string): Promise<number> {
    return this.#tx(async (c) => {
      const current = await c.query<{ generation: number }>('select generation from deployments where id = $1 for update', [deploymentId]);
      if (!current.rows[0]) throw new RunControlError('NOT_FOUND', 'Deployment not found.');
      await c.query(
        `update runs set status = 'revoked', updated_at = now()
         where deployment_id = $1 and generation = $2 and status not in ('completed', 'failed', 'revoked')`,
        [deploymentId, current.rows[0].generation],
      );
      const next = current.rows[0].generation + 1;
      await c.query("update deployments set generation = $2, desired_state = 'running', updated_at = now() where id = $1", [deploymentId, next]);
      // A new generation needs a fresh crossing baseline (strategy-language.md section 4).
      await c.query("update trigger_state set generation = $2, active = true, crossing = '{}', last_slot = null where deployment_id = $1", [deploymentId, next]);
      return next;
    });
  }

  async drainRuntime(runtimeId: string): Promise<void> {
    await this.#pool.query('insert into runtime_workers (runtime_id, drain) values ($1, true) on conflict (runtime_id) do update set drain = true', [runtimeId]);
  }

  // ---- Worker role: push-first ingestion and fan-out (decisions D32, D34) -----------------------------------

  async ingestPrice(observation: PriceObservation & { observationRef?: string }): Promise<FanOut[]> {
    const { rows } = await this.#pool.query<{ deployment_id: string; trigger_id: string }>(
      `select ts.deployment_id, ts.trigger_id from trigger_state ts
       join deployments d on d.tenant_id = ts.tenant_id and d.id = ts.deployment_id
       where ts.feed_ref = $1 and ts.active and d.desired_state = 'running' and d.generation = ts.generation
       order by ts.deployment_id, ts.trigger_id`,
      [observation.feedRef],
    );
    const results: FanOut[] = [];
    for (const row of rows) {
      results.push(await this.#tx(async (c) => {
        const state = await this.#lockTrigger(c, row.deployment_id, row.trigger_id);
        if (!state) return { deploymentId: row.deployment_id, triggerId: row.trigger_id, reason: 'inactive' };
        const trigger = (await this.#program(row.deployment_id)).strategy.triggers.find((t) => t.id === row.trigger_id);
        if (trigger?.type !== 'price.crossesAbove' && trigger?.type !== 'price.crossesBelow') return { deploymentId: row.deployment_id, triggerId: row.trigger_id, reason: 'not-a-price-trigger' };
        const now = this.#now();
        let decision;
        try {
          decision = transitionPrice(trigger, state.crossing as CrossingState, observation, now);
        } catch (error) {
          if (error instanceof LanguageError) return { deploymentId: row.deployment_id, triggerId: row.trigger_id, reason: `refused:${error.code}` };
          throw error;
        }
        await c.query('update trigger_state set crossing = $3 where deployment_id = $1 and trigger_id = $2', [row.deployment_id, row.trigger_id, decision.state]);
        if (!decision.fire) return { deploymentId: row.deployment_id, triggerId: row.trigger_id, reason: decision.reason };
        const runId = await this.#createRun(c, state, row.trigger_id, observation.sourceEventKey, {
          ...(observation.observationRef ? { observationRef: observation.observationRef } : {}), observedAt: observation.observedAt, acceptedAt: now, runCreatedAt: now,
        });
        return { deploymentId: row.deployment_id, triggerId: row.trigger_id, reason: runId ? 'crossing' : 'duplicate-run', ...(runId ? { runId } : {}) };
      }));
    }
    return results;
  }

  /** Due schedule slots: only the newest still-fresh slot; missed slots coalesce (runtime.md). */
  async tickSchedules(): Promise<FanOut[]> {
    const { rows } = await this.#pool.query<{ deployment_id: string; trigger_id: string }>(
      `select ts.deployment_id, ts.trigger_id from trigger_state ts
       join deployments d on d.tenant_id = ts.tenant_id and d.id = ts.deployment_id
       where ts.trigger_type = 'schedule' and ts.active and d.desired_state = 'running' and d.generation = ts.generation
       order by ts.deployment_id, ts.trigger_id`,
    );
    const results: FanOut[] = [];
    for (const row of rows) {
      const result = await this.#tx(async (c): Promise<FanOut | undefined> => {
        const state = await this.#lockTrigger(c, row.deployment_id, row.trigger_id);
        const trigger = state && (await this.#program(row.deployment_id)).strategy.triggers.find((t) => t.id === row.trigger_id);
        if (!state || trigger?.type !== 'schedule') return undefined;
        const now = this.#now();
        const slot = scheduleSlot(trigger, now, state.last_slot ? new Date(state.last_slot).toISOString() : undefined);
        if (!slot) return undefined;
        await c.query('update trigger_state set last_slot = $3 where deployment_id = $1 and trigger_id = $2', [row.deployment_id, row.trigger_id, slot]);
        const runId = await this.#createRun(c, state, row.trigger_id, `schedule:${slot}`, { acceptedAt: now, runCreatedAt: now });
        return { deploymentId: row.deployment_id, triggerId: row.trigger_id, reason: runId ? 'slot' : 'duplicate-run', ...(runId ? { runId } : {}) };
      });
      if (result) results.push(result);
    }
    return results;
  }

  // ---- Worker role: results of external reconciliation, and lease recovery -----------------------------------

  /** Executor reconciliation reached a definitive swap outcome: record it and schedule a resume. */
  async settleOperation(runId: string, operationKey: string, outcome: Outcome, resultRef?: string): Promise<void> {
    await this.#tx(async (c) => {
      const run = await this.#lockRun(c, runId);
      const op = await this.#operation(c, runId, operationKey);
      if (!op) throw new RunControlError('NOT_FOUND', 'Unknown operation for this run.');
      if (op.outcome && TERMINAL.has(op.outcome)) {
        if (op.outcome !== outcome) throw new RunControlError('IDEMPOTENCY_CONFLICT', 'Operation already has a different definitive outcome.');
        return;
      }
      await c.query('update run_operations set outcome = $3, result_ref = coalesce($4, result_ref), updated_at = now() where run_id = $1 and operation_key = $2', [runId, operationKey, outcome, resultRef ?? null]);
      if (run.checkpoint?.waiting) await c.query('update runs set recorded = $2, updated_at = now() where run_id = $1', [runId, { operationKey, outcome, ...(resultRef ? { resultRef } : {}) }]);
      if (run.status !== 'revoked') await this.#issueAssignment(c, run.tenant_id, runId);
    });
  }

  /**
   * The broker reconciled a pending or unknown read/AI operation. The operation stays pending; the resume makes
   * the runtime re-request under the same key, so the interpreter always receives the broker's typed record.
   */
  async resumeBrokerOperation(runId: string): Promise<void> {
    await this.#tx(async (c) => {
      const run = await this.#lockRun(c, runId);
      if (!['completed', 'failed', 'revoked'].includes(run.status)) await this.#issueAssignment(c, run.tenant_id, runId);
    });
  }

  /** Re-offer runs whose current lease expired while a runtime was executing them (process death). */
  async reclaimExpiredLeases(): Promise<string[]> {
    const { rows } = await this.#pool.query<{ run_id: string }>(
      `select ra.run_id from run_assignments ra join runs r on r.run_id = ra.run_id
       where ra.state = 'offered' and ra.lease_expires_at < $1
         and ra.fencing_token = (select max(fencing_token) from run_assignments x where x.run_id = ra.run_id)
         and r.status in ('assigned', 'waiting') and coalesce(r.recorded ->> 'outcome', '') <> 'pending'`,
      [this.#now()],
    );
    for (const { run_id } of rows) await this.reassign(run_id);
    return rows.map((r) => r.run_id);
  }

  /** Issue a newer lease for a run; the previous holder is fenced from then on. */
  async reassign(runId: string): Promise<void> {
    await this.#tx(async (c) => {
      const run = await this.#lockRun(c, runId);
      if (run.status !== 'revoked') await this.#issueAssignment(c, run.tenant_id, runId);
    });
  }

  /** What the executor's capability check derives for a run (never the request body). */
  async authorityFor(runId: string): Promise<{ deploymentId: string; generation: string; mode: 'paper' | 'live'; active: boolean } | undefined> {
    const { rows } = await this.#pool.query<{ deployment_id: string; generation: number; mode: 'paper' | 'live'; active: boolean }>(
      `select r.deployment_id, r.generation, d.mode,
              (d.desired_state = 'running' and d.generation = r.generation and r.status <> 'revoked') as active
       from runs r join deployments d on d.tenant_id = r.tenant_id and d.id = r.deployment_id where r.run_id = $1`,
      [runId],
    );
    const row = rows[0];
    return row && { deploymentId: row.deployment_id, generation: String(row.generation), mode: row.mode, active: row.active };
  }

  /** Resolve a bearer capability to the single assignment it authorizes; undefined when unknown or expired. */
  async authenticate(bearer: string): Promise<CapabilityScope | undefined> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(bearer)) return undefined;
    const { rows } = await this.#pool.query<{ assignment_id: string; run_id: string; tenant_id: string; deployment_id: string }>(
      `select ra.assignment_id, ra.run_id, ra.tenant_id, r.deployment_id from run_assignments ra join runs r on r.run_id = ra.run_id
       where ra.capability_hash = $1 and ra.capability_expires_at > $2`,
      [sha(bearer), this.#now()],
    );
    const row = rows[0];
    return row && { assignmentId: row.assignment_id, runId: row.run_id, tenantId: row.tenant_id, deploymentId: row.deployment_id };
  }

  // ---- Routes the runtime calls -------------------------------------------------------------------------------

  /** One poll attempt. The HTTP layer repeats it until an assignment appears or waitSeconds elapse. */
  async poll(request: AssignmentPoll): Promise<AssignmentOfferV2> {
    this.#valid('assignmentPoll', request);
    return this.#tx(async (c) => {
      const worker = await c.query<{ drain: boolean }>(
        `insert into runtime_workers (runtime_id) values ($1)
         on conflict (runtime_id) do update set last_poll_at = now() returning drain`,
        [request.runtimeId],
      );
      if (worker.rows[0]!.drain) return { schemaVersion: 'assignment-offer/2', disposition: 'drain' };
      const claimed = await c.query<{ assignment_id: string; run_id: string; fencing_token: string }>(
        `select ra.assignment_id, ra.run_id, ra.fencing_token from run_assignments ra join runs r on r.run_id = ra.run_id
         where ra.state = 'queued' and r.status in ('queued', 'assigned', 'waiting')
           and ra.fencing_token = (select max(fencing_token) from run_assignments x where x.run_id = ra.run_id)
         order by ra.created_at for update of ra skip locked limit 1`,
      );
      const row = claimed.rows[0];
      if (!row) return { schemaVersion: 'assignment-offer/2', disposition: 'none' };
      const now = this.#now();
      const bearer = randomBytes(32).toString('base64url');
      const capability = { bearer, expiresAt: at(now, this.#capabilityMillis) };
      await c.query(
        `update run_assignments set state = 'offered', runtime_id = $2, capability_hash = $3, capability_expires_at = $4, lease_expires_at = $5
         where assignment_id = $1`,
        [row.assignment_id, request.runtimeId, sha(bearer), capability.expiresAt, at(now, this.#leaseMillis)],
      );
      const assignment = await this.#assignmentDocument(c, row.assignment_id, row.run_id, row.fencing_token, request.runtimeId, now);
      return { schemaVersion: 'assignment-offer/2', disposition: 'assigned', assignment, capability };
    });
  }

  async fetchArtifact(ref: string): Promise<{ contentHash: string; text: string }> {
    const artifact = await this.artifact(ref);
    return { contentHash: artifact.contentHash, text: artifact.text };
  }

  /** The artifact/1 document plus the deployment that owns it (for capability scoping). */
  async artifact(ref: string): Promise<{ schemaVersion: 'artifact/1'; ref: string; kind: 'strategy' | 'catalog'; contentHash: string; text: string; deploymentId: string }> {
    const { rows } = await this.#pool.query<{ kind: 'strategy' | 'catalog'; content_hash: string; body: string; deployment_id: string }>(
      'select kind, content_hash, body, deployment_id from artifacts where ref = $1', [ref],
    );
    const row = rows[0];
    if (!row) throw new RunControlError('NOT_FOUND', 'Unknown artifact reference.');
    return { schemaVersion: 'artifact/1', ref, kind: row.kind, contentHash: row.content_hash, text: row.body, deploymentId: row.deployment_id };
  }

  async loadRun(runId: string, assignmentId: string, fencingToken: string): Promise<RunState> {
    return this.#tx(async (c) => {
      const run = await this.#fenced(c, runId, assignmentId, fencingToken);
      return {
        schemaVersion: 'run-state/1', runId,
        ...(run.checkpoint ? { checkpoint: run.checkpoint } : {}),
        ...(run.recorded && run.checkpoint ? { recorded: run.recorded } : {}),
        observationRefs: run.observation_refs,
      };
    });
  }

  async wait(body: RunWait): Promise<void> {
    this.#valid('runWait', body);
    await this.#tx(async (c) => {
      await this.#fenced(c, body.runId, body.assignmentId, body.fencingToken);
      const { operationKey, kind, nodeId, iterationPath } = body.operation;
      const existing = await this.#operation(c, body.runId, operationKey);
      if (existing && (existing.kind !== kind || existing.node_id !== nodeId || JSON.stringify(existing.iteration_path) !== JSON.stringify(iterationPath))) {
        throw new RunControlError('IDEMPOTENCY_CONFLICT', 'Operation key reused for a different operation.');
      }
      if (!existing) {
        await c.query(
          `insert into run_operations (tenant_id, run_id, operation_key, kind, node_id, iteration_path)
           select tenant_id, run_id, $2, $3, $4, $5 from runs where run_id = $1`,
          [body.runId, operationKey, kind, nodeId, JSON.stringify(iterationPath)],
        );
      }
      // A new waiting operation has no result yet; a re-wait for one that already has an outcome keeps it.
      const recorded = existing?.outcome ? { operationKey, outcome: existing.outcome, ...(existing.result_ref ? { resultRef: existing.result_ref } : {}) } : null;
      await c.query("update runs set checkpoint = $2, recorded = $3, status = 'waiting', updated_at = now() where run_id = $1", [body.runId, body.checkpoint, recorded]);
    });
  }

  async result(body: RunResult): Promise<void> {
    this.#valid('runResult', body);
    await this.#tx(async (c) => {
      await this.#fenced(c, body.runId, body.assignmentId, body.fencingToken);
      const op = await this.#operation(c, body.runId, body.operationKey);
      if (!op) throw new RunControlError('IDEMPOTENCY_CONFLICT', 'Result for an operation that was never persisted with wait.');
      if (op.outcome && TERMINAL.has(op.outcome)) {
        if (op.outcome !== body.outcome) throw new RunControlError('IDEMPOTENCY_CONFLICT', 'Operation already has a different definitive outcome.');
        return;
      }
      await c.query('update run_operations set outcome = $3, result_ref = coalesce($4, result_ref), updated_at = now() where run_id = $1 and operation_key = $2', [body.runId, body.operationKey, body.outcome, body.resultRef ?? null]);
      const recorded = { operationKey: body.operationKey, outcome: body.outcome, ...(body.resultRef ? { resultRef: body.resultRef } : {}), ...(body.result ? { result: body.result } : {}), ...(body.receivedAt ? { receivedAt: body.receivedAt } : {}) };
      const appendRef = body.outcome === 'recorded' && body.resultRef ? body.resultRef : null;
      await c.query(
        `update runs set recorded = $2, updated_at = now(),
           observation_refs = case when $3::uuid is null or $3::uuid = any(observation_refs) then observation_refs else observation_refs || $3::uuid end
         where run_id = $1`,
        [body.runId, recorded, appendRef],
      );
    });
  }

  async complete(body: RunComplete): Promise<void> {
    this.#valid('runComplete', body);
    await this.#tx(async (c) => {
      await this.#fenced(c, body.runId, body.assignmentId, body.fencingToken);
      if (body.checkpoint.status !== 'completed' && body.checkpoint.status !== 'failed') throw new RunControlError('IDEMPOTENCY_CONFLICT', 'Only terminal checkpoints complete a run.');
      await c.query('update runs set checkpoint = $2, recorded = null, status = $3, updated_at = now() where run_id = $1', [body.runId, body.checkpoint, body.checkpoint.status]);
    });
  }

  async timeline(body: TimelineEntry): Promise<void> {
    this.#valid('timelineEntry', body);
    await this.#tx(async (c) => {
      await this.#fenced(c, body.runId, body.assignmentId, body.fencingToken);
      await c.query(
        `insert into timeline_entries (tenant_id, operation_key, run_id, node_id, message, inputs)
         select tenant_id, $2, run_id, $3, $4, $5 from runs where run_id = $1 on conflict (operation_key) do nothing`,
        [body.runId, body.operationKey, body.nodeId, body.message, body.inputs],
      );
    });
  }

  async timelineCount(runId: string): Promise<number> {
    const { rows } = await this.#pool.query<{ n: string }>('select count(*) as n from timeline_entries where run_id = $1', [runId]);
    return Number(rows[0]!.n);
  }

  /**
   * Renew the lease and extend the same capability (rotation would fail requests already in flight with the
   * old bearer). LEASE_FENCED or GENERATION_REVOKED when authority is gone; it never revives a revoked run.
   */
  async heartbeat(assignmentId: string, fencingToken: string): Promise<{ leaseExpiresAt: string; capabilityExpiresAt: string }> {
    return this.#tx(async (c) => {
      const assignment = await c.query<{ run_id: string }>('select run_id from run_assignments where assignment_id = $1', [assignmentId]);
      if (!assignment.rows[0]) throw new RunControlError('LEASE_FENCED', 'Assignment is no longer current.');
      await this.#fenced(c, assignment.rows[0].run_id, assignmentId, fencingToken);
      const now = this.#now();
      const renewed = { leaseExpiresAt: at(now, this.#leaseMillis), capabilityExpiresAt: at(now, this.#capabilityMillis) };
      await c.query('update run_assignments set lease_expires_at = $2, capability_expires_at = $3 where assignment_id = $1', [assignmentId, renewed.leaseExpiresAt, renewed.capabilityExpiresAt]);
      return renewed;
    });
  }

  // ---- internals ---------------------------------------------------------------------------------------------

  async #tx<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query('begin');
      const result = await work(client);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  #valid(kind: 'assignmentPoll' | 'runWait' | 'runResult' | 'runComplete' | 'timelineEntry', body: unknown): void {
    const result = validate(kind, body);
    if (!result.ok) throw new RunControlError('SCHEMA_INVALID', `Malformed ${kind} at ${result.issues[0]?.fieldPath || '/'}.`);
  }

  #program(deploymentId: string): Promise<CompiledStrategy> {
    let program = this.#programs.get(deploymentId);
    if (!program) {
      program = (async () => {
        const strategy = await this.artifact(strategyRef(deploymentId));
        const catalog = await this.artifact(catalogRef(deploymentId));
        return compileStrategy(strategy.text, JSON.parse(catalog.text) as Catalog);
      })();
      program.catch(() => this.#programs.delete(deploymentId));
      this.#programs.set(deploymentId, program);
    }
    return program;
  }

  async #lockTrigger(c: pg.PoolClient, deploymentId: string, triggerId: string) {
    const { rows } = await c.query<{ tenant_id: string; deployment_id: string; generation: number; crossing: unknown; last_slot: Date | null }>(
      `select ts.tenant_id, ts.deployment_id, ts.generation, ts.crossing, ts.last_slot from trigger_state ts
       join deployments d on d.tenant_id = ts.tenant_id and d.id = ts.deployment_id
       where ts.deployment_id = $1 and ts.trigger_id = $2 and ts.active and d.desired_state = 'running' and d.generation = ts.generation
       for update of ts`,
      [deploymentId, triggerId],
    );
    return rows[0];
  }

  async #createRun(c: pg.PoolClient, state: { tenant_id: string; deployment_id: string; generation: number }, triggerId: string, sourceEventKey: string, trigger: RuntimeAssignment['trigger']): Promise<string | undefined> {
    const revision = `${state.deployment_id}/${state.generation}`;
    const runId = await runIdentity(revision, triggerId, sourceEventKey);
    // The unique run key makes a duplicate event harmless.
    const inserted = await c.query(
      `insert into runs (tenant_id, run_id, deployment_id, generation, deployment_revision, trigger_id, source_event_key, trigger)
       values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict (run_id) do nothing returning run_id`,
      [state.tenant_id, runId, state.deployment_id, state.generation, revision, triggerId, sourceEventKey, trigger],
    );
    if (!inserted.rows[0]) return undefined;
    await this.#issueAssignment(c, state.tenant_id, runId);
    return runId;
  }

  async #issueAssignment(c: pg.PoolClient, tenantId: string, runId: string): Promise<void> {
    await c.query(
      `insert into run_assignments (assignment_id, tenant_id, run_id, fencing_token)
       values ($1, $2, $3, coalesce((select max(fencing_token) from run_assignments where run_id = $3), 0) + 1)`,
      [uuidv7(), tenantId, runId],
    );
    await c.query("update runs set status = case when status = 'queued' then 'assigned' else status end, updated_at = now() where run_id = $1", [runId]);
  }

  async #assignmentDocument(c: pg.PoolClient, assignmentId: string, runId: string, fencingToken: string, runtimeId: string, now: string): Promise<RuntimeAssignment> {
    const { rows } = await c.query<{ deployment_id: string; generation: number; deployment_revision: string; trigger_id: string; source_event_key: string; trigger: RuntimeAssignment['trigger']; mode: 'paper' | 'live'; strategy_hash: string; catalog_hash: string; connector_versions: Record<string, string>; runtime_image_digest: string }>(
      `select r.deployment_id, r.generation, r.deployment_revision, r.trigger_id, r.source_event_key, r.trigger,
              d.mode, d.strategy_hash, d.catalog_hash, d.connector_versions, d.runtime_image_digest
       from runs r join deployments d on d.tenant_id = r.tenant_id and d.id = r.deployment_id where r.run_id = $1`,
      [runId],
    );
    const row = rows[0]!;
    // No manifest record exists yet (API-2); its hash covers the pinned inputs the runtime receives.
    const manifestHash = await contentHash({ schemaVersion: 'runtime-manifest/0', mode: row.mode, strategyHash: row.strategy_hash, catalogHash: row.catalog_hash, connectorVersions: row.connector_versions, runtimeImageDigest: row.runtime_image_digest });
    return {
      schemaVersion: 'runtime-assignment/1', assignmentId,
      lease: { owner: runtimeId, fencingToken: String(fencingToken), expiresAt: at(now, this.#leaseMillis) },
      deployment: { deploymentId: row.deployment_id, generation: String(row.generation), mode: row.mode, manifestHash, runtimeImageDigest: row.runtime_image_digest, connectorVersions: row.connector_versions },
      interpreter: { languageVersion: 'strategy/1', checkpointVersion: 'strategy-run/2' },
      run: { runId, deploymentRevision: row.deployment_revision, triggerId: row.trigger_id, sourceEventKey: row.source_event_key },
      trigger: row.trigger,
      artifacts: { strategyRef: strategyRef(row.deployment_id), strategyHash: row.strategy_hash, catalogRef: catalogRef(row.deployment_id), catalogHash: row.catalog_hash },
      capabilityRef: `capability:assignment/${assignmentId}`,
      issuedAt: now, expiresAt: at(now, this.#assignmentMillis),
    };
  }

  async #lockRun(c: pg.PoolClient, runId: string): Promise<RunRow> {
    const { rows } = await c.query<RunRow>(
      `select r.tenant_id, r.run_id, r.deployment_id, r.generation, r.deployment_revision, r.trigger_id, r.source_event_key, r.trigger,
              r.status, r.checkpoint, r.recorded, r.observation_refs::text[] as observation_refs,
              d.generation as deployment_generation, d.desired_state
       from runs r join deployments d on d.tenant_id = r.tenant_id and d.id = r.deployment_id
       where r.run_id = $1 for update of r`,
      [runId],
    );
    if (!rows[0]) throw new RunControlError('NOT_FOUND', 'Unknown run.');
    return rows[0];
  }

  /** Lock the run, then require the current generation and the current lease. */
  async #fenced(c: pg.PoolClient, runId: string, assignmentId: string, fencingToken: string): Promise<RunRow> {
    const run = await this.#lockRun(c, runId);
    if (run.status === 'revoked' || run.desired_state !== 'running' || run.deployment_generation !== run.generation) {
      throw new RunControlError('GENERATION_REVOKED', 'Deployment generation is paused or replaced.');
    }
    const lease = await c.query<{ assignment_id: string; fencing_token: string }>(
      'select assignment_id, fencing_token from run_assignments where run_id = $1 order by fencing_token desc limit 1', [runId],
    );
    const current = lease.rows[0];
    if (!current || current.assignment_id !== assignmentId || String(current.fencing_token) !== fencingToken) throw new RunControlError('LEASE_FENCED', 'A newer lease owns this run.');
    return run;
  }

  async #operation(c: pg.PoolClient, runId: string, operationKey: string) {
    const { rows } = await c.query<{ kind: string; node_id: string; iteration_path: number[]; outcome: Outcome | null; result_ref: string | null }>(
      'select kind, node_id, iteration_path, outcome, result_ref from run_operations where run_id = $1 and operation_key = $2', [runId, operationKey],
    );
    return rows[0];
  }
}

const strategyRef = (deploymentId: string): string => `artifact:deployment/${deploymentId}/strategy`;
const catalogRef = (deploymentId: string): string => `artifact:deployment/${deploymentId}/catalog`;

/** UUIDv7: 48-bit millisecond time, version and variant bits, random remainder. */
export function uuidv7(): string {
  const b = randomBytes(16);
  b.writeUIntBE(Date.now(), 0, 6);
  b[6] = 0x70 | (b[6]! & 0x0f);
  b[8] = 0x80 | (b[8]! & 0x3f);
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
