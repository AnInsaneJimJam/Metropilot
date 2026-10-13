import { SOURCES, rayToApr, checkedObservation } from '@monad-hack/connectors';
import type { BrokerRequest, BrokerResult } from '@monad-hack/contracts';
// Runtime-facing control plane on PostgreSQL (docs/integration/control-api.md). Two roles:
//  - the routes a runtime calls (poll, artifacts, run state, wait, results, complete, timeline, heartbeat);
//  - API-worker roles the runtime never performs (deploy, fan-out, schedules, resume, pause, lease reclaim).
// Every run mutation runs in one transaction that holds the run row lock and checks the current lease and
// generation in that transaction. Network calls never happen inside a transaction here.
import { AccountingError, chargeHostingSlice, currentRateCard, sliceIndexAt } from '@monad-hack/accounting';
import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import { contentHash, validate } from '@monad-hack/contracts';
import type { AssignmentOfferV2, AssignmentPoll, AudienceCapability, ContractDocumentMap, RunComplete, RunResult, RunState, RunWait, RuntimeAssignment, TimelineEntry, UserReasonCode } from '@monad-hack/contracts';
import { MAX_CAPABILITY_SECONDS, signCapability } from '@monad-hack/contracts/capability';
import { compileStrategy, LanguageError, runIdentity, scheduleSlot, transitionPrice } from '@monad-hack/strategy';
import type { Catalog, CompiledStrategy, CrossingState, PriceObservation } from '@monad-hack/strategy';
import type { CatalogPin } from '../catalog.ts';
import { runAllowed, sessionSeconds, dailySeconds, paperLimits } from '../quota.ts';
import type { QuotaReason } from '../quota.ts';

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
  /** HS256 secret shared with the executor (D35); without it executor capabilities cannot be issued. */
  readonly executorCapabilitySecret?: Uint8Array;
  readonly brokerCapabilitySecret?: Uint8Array;
}

export interface DeployInput {
  readonly tenantId: string;
  readonly agentId: string;
  readonly strategyRevisionId: string;
  readonly mode: 'paper' | 'live';
  readonly catalog: Catalog;
  /** The catalog_versions rows `catalog` was resolved from (CatalogResolver); recorded in the manifest. */
  readonly catalogPins: readonly CatalogPin[];
  readonly connectorVersions: Readonly<Record<string, string>>;
  readonly runtimeImageDigest: string;
  readonly networkRef: string;
  readonly policyVersion: number;
  readonly budgetVersion: number;
  readonly resourceProfileRef: string;
  /** Pinned model profile versions; empty when the strategy has no AI node. */
  readonly modelProfiles: Readonly<Record<string, string>>;
  readonly estimateId: string;
  /** Required for paper, forbidden for live (the deployment trades in this simulation account). */
  readonly simulationAccountId?: string;
  readonly actor?: AuditActor;
}

/** Who caused an audit event: a user (the tenant's account) or a process role. */
export type AuditActor = { readonly kind: 'user' | 'operator'; readonly id: string } | { readonly kind: 'controlPlane' | 'runtime' | 'executor' | 'system' };

interface AuditInput {
  readonly tenantId: string;
  readonly agentId?: string;
  readonly deploymentId?: string;
  readonly runId?: string;
  readonly intentId?: string;
  readonly actor: AuditActor;
  readonly type: string;
  readonly payload: Record<string, unknown>;
  /** Idempotency source: publishing the same source twice records one event. */
  readonly source: string;
  readonly occurredAt?: string;
}

/** Interpreter outcome for a definitive executor state: the same mapping as apps/runtime/src/host.ts. */
export const INTENT_OUTCOME: Readonly<Record<string, Outcome>> = { settled: 'settled', rejected: 'rejected', cancelled: 'rejected', failed: 'failed' };

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
  agent_id: string;
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
  readonly #brokerSecret: Uint8Array | undefined;
  readonly #executorSecret: Uint8Array | undefined;
  /** Compiled programs are immutable per deployment, so caching them is safe. */
  readonly #programs = new Map<string, Promise<CompiledStrategy>>();

  constructor(options: StoreOptions) {
    this.#pool = options.pool;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#leaseMillis = options.leaseMillis ?? 30_000;
    this.#assignmentMillis = options.assignmentMillis ?? 60_000;
    this.#capabilityMillis = options.capabilityMillis ?? 300_000;
    this.#executorSecret = options.executorCapabilitySecret;
    this.#brokerSecret = options.brokerCapabilitySecret;
  }

  // ---- Worker role: deployment ------------------------------------------------------------------------------

  /** Pin a saved revision as an active deployment with its manifest, artifacts and trigger rows. */
  async deploy(input: DeployInput): Promise<{ deploymentId: string; generation: number; manifestHash: string }> {
    return this.#tx((c) => this.deployIn(c, input));
  }

  /** deploy() inside a caller's transaction, so the lifecycle can create its records atomically with it. */
  async deployIn(c: pg.PoolClient, input: DeployInput): Promise<{ deploymentId: string; generation: number; manifestHash: string }> {
    const revision = await c.query<{ ast: unknown; content_hash: string }>(
      'select ast, content_hash from strategy_revisions where tenant_id = $1 and agent_id = $2 and id = $3',
      [input.tenantId, input.agentId, input.strategyRevisionId],
    );
    if (!revision.rows[0]) throw new RunControlError('NOT_FOUND', 'Strategy revision not found for this agent.');
    const program = await compileStrategy(JSON.stringify(revision.rows[0].ast), input.catalog);
    if (program.hash !== revision.rows[0].content_hash) throw new RunControlError('SCHEMA_INVALID', 'Stored revision hash does not match its AST.');
    if ((input.mode === 'paper') !== Boolean(input.simulationAccountId)) throw new RunControlError('SCHEMA_INVALID', 'Paper deployments need a simulation account; live deployments must not have one.');
    const deploymentId = uuidv7();
    const catalogHash = await contentHash(input.catalog);
    const [firstPin, ...otherPins] = input.catalogPins;
    if (!firstPin) throw new RunControlError('SCHEMA_INVALID', 'A deployment pins at least one catalog entry.');
    if (new Set(input.catalogPins.map((p) => `${p.kind}:${p.ref}`)).size !== input.catalogPins.length) throw new RunControlError('SCHEMA_INVALID', 'A catalog entry is pinned twice.');
    const manifest: ContractDocumentMap['deploymentManifest2'] = {
      schemaVersion: 'deployment-manifest/2', deploymentId, agentId: input.agentId, mode: input.mode, networkRef: input.networkRef,
      strategyRevisionId: input.strategyRevisionId, strategyHash: program.hash, catalogHash, catalogPins: [{ ...firstPin }, ...otherPins.map((p) => ({ ...p }))],
      connectorVersions: { ...input.connectorVersions }, modelProfiles: { ...input.modelProfiles }, resourceProfileRef: input.resourceProfileRef,
      runtimeImageDigest: input.runtimeImageDigest, budgetVersion: input.budgetVersion, policyVersion: input.policyVersion, estimateId: input.estimateId,
      ...(input.simulationAccountId ? { simulationAccountId: input.simulationAccountId } : {}),
    };
    if (!validate('deploymentManifest2', manifest).ok) throw new RunControlError('SCHEMA_INVALID', 'The deployment manifest is invalid.');
    const manifestHash = await contentHash(manifest);
    await c.query(
      `insert into deployments (tenant_id, id, agent_id, strategy_revision_id, mode, strategy_hash, catalog_hash, connector_versions, runtime_image_digest,
                                network_ref, policy_version, budget_version, resource_profile_ref, model_profiles, estimate_id, simulation_account_id, manifest, manifest_hash)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
      [input.tenantId, deploymentId, input.agentId, input.strategyRevisionId, input.mode, program.hash, catalogHash, input.connectorVersions, input.runtimeImageDigest,
        input.networkRef, input.policyVersion, input.budgetVersion, input.resourceProfileRef, input.modelProfiles, input.estimateId, input.simulationAccountId ?? null, manifest, manifestHash],
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
    if (input.mode === 'paper') await this.#openInterval(c, input.tenantId, deploymentId, 1);
    await this.#audit(c, { tenantId: input.tenantId, agentId: input.agentId, deploymentId, actor: input.actor ?? { kind: 'controlPlane' }, type: 'deployment.stateChanged', payload: { from: 'none', to: 'active', generation: 1, manifestHash }, source: `deployment:${deploymentId}:1:active` });
    return { deploymentId, generation: 1, manifestHash };
  }

  /** Pause revokes authority for new operations at once; dispatched effects stay with their owners. */
  async pause(deploymentId: string, actor: AuditActor = { kind: 'controlPlane' }, reasonCode?: QuotaReason): Promise<void> {
    await this.#tx((c) => this.pauseIn(c, deploymentId, actor, reasonCode));
  }

  /** reasonCode explains a pause the platform made (a quota, an unpaid hosting slice), so the user sees why the agent stopped running. */
  async pauseIn(c: pg.PoolClient, deploymentId: string, actor: AuditActor = { kind: 'controlPlane' }, reasonCode?: QuotaReason | 'HOSTING_BUDGET_EXHAUSTED'): Promise<void> {
    {
      const d = await this.#lockDeployment(c, deploymentId);
      if (d.desired_state === 'paused') return;
      if (d.desired_state === 'stopping') throw new RunControlError('IDEMPOTENCY_CONFLICT', 'The agent is stopping; it cannot be paused.');
      if (d.desired_state !== 'active') throw new RunControlError('IDEMPOTENCY_CONFLICT', `A ${d.desired_state} deployment cannot be paused.`);
      await c.query("update deployments set desired_state = 'paused', updated_at = now() where id = $1", [deploymentId]);
      await c.query('update trigger_state set active = false where deployment_id = $1', [deploymentId]);
      await this.#closeInterval(c, deploymentId);
      await this.#audit(c, { tenantId: d.tenant_id, agentId: d.agent_id, deploymentId, actor, type: 'deployment.stateChanged', payload: { from: 'active', to: 'paused', generation: d.generation, ...(reasonCode ? { reasonCode } : {}) }, source: `deployment:${deploymentId}:${d.generation}:paused` });
    }
  }

  /**
   * Hosting metering (ACC-4; funds-and-budgets.md section 5): every active deployment whose resource profile has a
   * published hosting rate card pays for its current and next slice from the hosting bucket before its compute is
   * extended. A bucket that cannot pay pauses the deployment with a visible reason; other buckets are never used.
   * Deployments without a rate card (paper sessions today) are not billed.
   */
  async meterHosting(): Promise<{ charged: number; paused: string[] }> {
    const now = new Date(this.#now());
    type Active = { id: string; tenant_id: string; agent_id: string; mode: 'paper' | 'live'; resource_profile_ref: string };
    // Bounded pages over the whole active set (keyset on id), so later deployments are metered too.
    const active: Active[] = [];
    for (let after = '00000000-0000-0000-0000-000000000000'; ;) {
      const page = await this.#pool.query<Active>(
        `select id, tenant_id, agent_id, mode, resource_profile_ref from deployments where desired_state = 'active' and id > $1 order by id limit 500`, [after]);
      active.push(...page.rows);
      if (page.rows.length < 500) break;
      after = page.rows.at(-1)!.id;
    }
    let charged = 0;
    const paused: string[] = [];
    for (const d of active) {
      const card = await currentRateCard(this.#pool, 'hosting', d.mode, d.resource_profile_ref, now);
      if (!card?.sliceSeconds) continue;
      const scope = { mode: d.mode, tenantId: d.tenant_id, agentId: d.agent_id };
      const slice = sliceIndexAt(now, card.sliceSeconds);
      await this.#tx(async (c) => {
        // A pause or stop that landed after the list was read wins: lock and recheck before authorizing charges.
        const current = await c.query<{ desired_state: string }>('select desired_state from deployments where id = $1 for update', [d.id]);
        if (current.rows[0]?.desired_state !== 'active') return;
        // Each slice is its own savepoint: a paid slice stays paid even when the next one cannot be.
        for (const index of [slice, slice + 1n]) {
          await c.query('savepoint hosting_slice');
          try {
            const outcome = await chargeHostingSlice(c, { scope, deploymentId: d.id, card, sliceIndex: index, now });
            if (outcome.status === 'charged') charged++;
            await c.query('release savepoint hosting_slice');
          } catch (error) {
            if (!(error instanceof AccountingError) || (error.code !== 'INSUFFICIENT_BUDGET' && error.code !== 'RECONCILIATION_REQUIRED')) throw error;
            await c.query('rollback to savepoint hosting_slice');
            const reason = 'The hosting budget is exhausted. Add hosting funds, then resume.';
            await c.query('update deployments set pause_reason = $2 where id = $1', [d.id, reason]);
            await this.pauseIn(c, d.id, { kind: 'system' }, 'HOSTING_BUDGET_EXHAUSTED');
            paused.push(d.id);
            return;
          }
        }
      });
    }
    return { charged, paused };
  }

  /** Resume mints a new generation. Unfinished runs of the old generation are revoked and never offered again. */
  async resume(deploymentId: string, actor: AuditActor = { kind: 'controlPlane' }): Promise<number> {
    return this.#tx((c) => this.resumeIn(c, deploymentId, actor));
  }

  async resumeIn(c: pg.PoolClient, deploymentId: string, actor: AuditActor = { kind: 'controlPlane' }): Promise<number> {
    {
      const d = await this.#lockDeployment(c, deploymentId);
      if (d.desired_state === 'stopping') throw new RunControlError('IDEMPOTENCY_CONFLICT', 'The agent is stopping; once it has stopped, launch it again.');
      if (d.desired_state === 'stopped') throw new RunControlError('IDEMPOTENCY_CONFLICT', 'A stopped deployment cannot be resumed; launch a new deployment.');
      await this.#revokeOpenRuns(c, d, actor);
      const next = d.generation + 1;
      await c.query("update deployments set generation = $2, desired_state = 'active', pause_reason = null, updated_at = now() where id = $1", [deploymentId, next]);
      // A new generation needs a fresh crossing baseline (strategy-language.md section 4), but keeps the last
      // accepted schedule slot: a resume must not re-run a slot the previous generation already ran.
      await c.query("update trigger_state set generation = $2, active = true, crossing = '{}' where deployment_id = $1", [deploymentId, next]);
      await this.#closeInterval(c, deploymentId);
      if (d.mode === 'paper') await this.#openInterval(c, d.tenant_id, deploymentId, next);
      await this.#audit(c, { tenantId: d.tenant_id, agentId: d.agent_id, deploymentId, actor, type: 'deployment.stateChanged', payload: { from: d.desired_state, to: 'active', generation: next }, source: `deployment:${deploymentId}:${next}:active` });
      return next;
    }
  }

  /**
   * Stop ends the deployment for good (D37, issue #20): it moves to `stopping` at once (no new runs; the executor
   * refuses new intents and cancels reserved ones), and to `stopped` only when no intent is open. Effects already
   * dispatched keep reconciling; a timeout is not proof of no effect, so `stopped` is never forced over an open intent.
   */
  async stop(deploymentId: string, actor: AuditActor = { kind: 'controlPlane' }): Promise<void> {
    await this.#tx((c) => this.stopIn(c, deploymentId, actor));
  }

  async stopIn(c: pg.PoolClient, deploymentId: string, actor: AuditActor = { kind: 'controlPlane' }): Promise<void> {
    {
      const d = await this.#lockDeployment(c, deploymentId);
      if (d.desired_state === 'stopped' || d.desired_state === 'stopping') return;
      await this.#revokeOpenRuns(c, d, actor);
      await c.query("update deployments set desired_state = 'stopping', updated_at = now() where id = $1", [deploymentId]);
      await c.query('update trigger_state set active = false where deployment_id = $1', [deploymentId]);
      await this.#closeInterval(c, deploymentId);
      const open = await this.#openIntents(c, deploymentId);
      await this.#audit(c, { tenantId: d.tenant_id, agentId: d.agent_id, deploymentId, actor, type: 'deployment.stateChanged', payload: { from: d.desired_state, to: 'stopping', generation: d.generation, openIntents: open, ...(open > 0 ? { reasonCode: 'STOP_DRAINING' } : {}) }, source: `deployment:${deploymentId}:${d.generation}:stopping` });
      await this.#finaliseIn(c, d);
    }
  }

  /** Worker role: finish every `stopping` deployment whose intents have all settled, cancelled or failed. */
  async finaliseStopping(): Promise<string[]> {
    const { rows } = await this.#pool.query<{ id: string }>(`select id from deployments where desired_state = 'stopping' order by id`);
    const stopped: string[] = [];
    for (const { id } of rows) {
      const done = await this.#tx(async (c) => {
        const d = await this.#lockDeployment(c, id);
        return d.desired_state === 'stopping' && (await this.#finaliseIn(c, d));
      });
      if (done) stopped.push(id);
    }
    return stopped;
  }

  /**
   * `stopping` → `stopped` when no intent of the deployment is open. Takes the simulation account lock the executor's
   * admission transaction holds, so an admission already inside that transaction is either visible here or waits.
   */
  async #finaliseIn(c: pg.PoolClient, d: { id: string; tenant_id: string; agent_id: string; generation: number }): Promise<boolean> {
    await c.query('select 1 from simulation_accounts s join deployments d on d.tenant_id = s.tenant_id and d.simulation_account_id = s.id where d.id = $1 for update of s', [d.id]);
    if ((await this.#openIntents(c, d.id)) > 0) return false;
    await c.query("update deployments set desired_state = 'stopped', updated_at = now() where id = $1", [d.id]);
    await this.#audit(c, { tenantId: d.tenant_id, agentId: d.agent_id, deploymentId: d.id, actor: { kind: 'controlPlane' }, type: 'deployment.stateChanged', payload: { from: 'stopping', to: 'stopped', generation: d.generation }, source: `deployment:${d.id}:${d.generation}:stopped` });
    return true;
  }

  async #openIntents(c: pg.PoolClient, deploymentId: string): Promise<number> {
    const { rows } = await c.query<{ n: string }>(`select count(*) as n from intents where deployment_id = $1 and state not in ('rejected', 'settled', 'failed', 'cancelled')`, [deploymentId]);
    return Number(rows[0]!.n);
  }

  /**
   * Worker role (issue #17): pause every active paper deployment whose session or tenant's UTC-day time is used up,
   * with the quota as the reason. Pause, not stop: history stays and the agent can resume in a new day or session.
   */
  async enforcePaperQuotas(): Promise<{ deploymentId: string; reason: QuotaReason }[]> {
    const limits = await paperLimits(this.#pool);
    const exhausted = async (db: pg.Pool | pg.PoolClient, d: { id: string; tenant_id: string }, now: Date): Promise<QuotaReason | undefined> =>
      (await sessionSeconds(db, d.id, now)) >= limits.sessionSeconds ? 'QUOTA_SESSION'
        : (await dailySeconds(db, d.tenant_id, now)) >= limits.dailySeconds ? 'QUOTA_DAILY' : undefined;
    const scannedAt = new Date(this.#now());
    const { rows } = await this.#pool.query<{ id: string; tenant_id: string }>(`select id, tenant_id from deployments where mode = 'paper' and desired_state = 'active' order by id`);
    const paused: { deploymentId: string; reason: QuotaReason }[] = [];
    for (const d of rows) {
      if (!(await exhausted(this.#pool, d, scannedAt))) continue;
      // Decide again under the deployment lock with a fresh clock: a sweep (or a lock wait) that crosses UTC
      // midnight must not pause an agent for yesterday's allowance, and a pause or stop since the scan wins.
      const reason = await this.#tx(async (c) => {
        const current = await this.#lockDeployment(c, d.id);
        if (current.desired_state !== 'active') return undefined;
        const confirmed = await exhausted(c, d, new Date(this.#now()));
        if (confirmed) await this.pauseIn(c, d.id, { kind: 'system' }, confirmed);
        return confirmed;
      });
      if (reason) paused.push({ deploymentId: d.id, reason });
    }
    return paused;
  }

  async drainRuntime(runtimeId: string): Promise<void> {
    await this.#pool.query('insert into runtime_workers (runtime_id, drain) values ($1, true) on conflict (runtime_id) do update set drain = true', [runtimeId]);
  }

  // ---- Worker role: push-first ingestion and fan-out (decisions D32, D34) -----------------------------------

  async ingestPrice(observation: PriceObservation & { observationRef?: string }): Promise<FanOut[]> {
    // The recorded market the paper executor fills against; a re-delivered event is stored once.
    await this.#pool.query(
      `insert into market_observations (feed_ref, source_event_key, base_asset_ref, quote_unit, price, observed_at, received_at)
       values ($1, $2, $3, $4, $5, $6, $7) on conflict (feed_ref, source_event_key) do nothing`,
      [observation.feedRef, observation.sourceEventKey, observation.price.baseAssetRef, observation.price.quoteUnit, observation.price.decimal, observation.observedAt, observation.receivedAt],
    );
    const { rows } = await this.#pool.query<{ deployment_id: string; trigger_id: string }>(
      `select ts.deployment_id, ts.trigger_id from trigger_state ts
       join deployments d on d.tenant_id = ts.tenant_id and d.id = ts.deployment_id
       where ts.feed_ref = $1 and ts.active and d.desired_state = 'active' and d.generation = ts.generation
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
          if (!(error instanceof LanguageError)) throw error;
          // Language error codes are error-1 codes; reasons.test.ts checks every one the language core raises.
          await this.#skipped(c, state, row.trigger_id, observation.sourceEventKey, error.code as UserReasonCode);
          return { deploymentId: row.deployment_id, triggerId: row.trigger_id, reason: `refused:${error.code}` };
        }
        await c.query('update trigger_state set crossing = $3 where deployment_id = $1 and trigger_id = $2', [row.deployment_id, row.trigger_id, decision.state]);
        // A crossing held back by the cooldown, or a price too old to act on, is a blocked run the user should see;
        // baseline, no-crossing and out-of-order observations are routine and stay out of the stream.
        if (decision.reason === 'cooldown' || decision.reason === 'stale') {
          await this.#skipped(c, state, row.trigger_id, observation.sourceEventKey, decision.reason === 'cooldown' ? 'TRIGGER_COOLDOWN' : 'STALE_DATA');
        }
        if (!decision.fire) return { deploymentId: row.deployment_id, triggerId: row.trigger_id, reason: decision.reason };
        const over = await this.#overQuota(c, state, row.trigger_id, observation.sourceEventKey);
        if (over) return { deploymentId: row.deployment_id, triggerId: row.trigger_id, reason: over };
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
       where ts.trigger_type = 'schedule' and ts.active and d.desired_state = 'active' and d.generation = ts.generation
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
        // A slot refused by the quota is consumed, like a coalesced one; it is not run later.
        const over = await this.#overQuota(c, state, row.trigger_id, `schedule:${slot}`);
        if (over) return { deploymentId: row.deployment_id, triggerId: row.trigger_id, reason: over };
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
    await this.#tx((c) => this.#settle(c, runId, operationKey, outcome, resultRef));
  }

  async #settle(c: pg.PoolClient, runId: string, operationKey: string, outcome: Outcome, resultRef?: string): Promise<'recorded' | 'already' | 'unknown'> {
    const found = await c.query('select 1 from runs where run_id = $1', [runId]);
    if (!found.rows[0]) return 'unknown';
    const run = await this.#lockRun(c, runId);
    const op = await this.#operation(c, runId, operationKey);
    if (!op) return 'unknown';
    if (op.outcome && TERMINAL.has(op.outcome)) {
      if (op.outcome !== outcome) throw new RunControlError('IDEMPOTENCY_CONFLICT', 'Operation already has a different definitive outcome.');
      return 'already';
    }
    await c.query('update run_operations set outcome = $3, result_ref = coalesce($4, result_ref), updated_at = now() where run_id = $1 and operation_key = $2', [runId, operationKey, outcome, resultRef ?? null]);
    if (run.checkpoint?.waiting) await c.query('update runs set recorded = $2, updated_at = now() where run_id = $1', [runId, { operationKey, outcome, ...(resultRef ? { resultRef } : {}) }]);
    await this.#audit(c, { tenantId: run.tenant_id, agentId: run.agent_id, deploymentId: run.deployment_id, runId, actor: { kind: 'controlPlane' }, type: 'run.step', payload: { operationKey, kind: op.kind, nodeId: op.node_id, outcome, reconciled: true }, source: `op:${runId}:${operationKey}:${outcome}` });
    if (run.status !== 'revoked') await this.#issueAssignment(c, run.tenant_id, runId);
    return 'recorded';
  }

  /**
   * API-worker role: publish executor outbox rows in order. Each row becomes one audit event; a definitive
   * transaction.stateChanged also records the swap outcome and resumes the run (inline-settled intents are
   * already recorded by the runtime, so that is a no-op). Returns how many rows were published.
   */
  async consumeExecutorOutbox(limit = 100): Promise<number> {
    let published = 0;
    for (; published < limit; published++) {
      const done = await this.#tx(async (c) => {
        const { rows } = await c.query<{ id: string; tenant_id: string; agent_id: string; intent_id: string; run_id: string; logical_key: string; type: string; payload: Record<string, unknown>; occurred_at: Date }>(
          'select * from executor_outbox where published_at is null order by id for update skip locked limit 1',
        );
        const row = rows[0];
        if (!row) return true;
        const run = await c.query<{ deployment_id: string }>('select deployment_id from runs where run_id = $1', [row.run_id]);
        const state = typeof row.payload['state'] === 'string' ? row.payload['state'] : undefined;
        // A row that cannot be applied (a conflicting outcome) is published with the conflict noted, never
        // retried forever: retrying would block every later outbox row for every tenant.
        let conflict: string | undefined;
        if (row.type === 'transaction.stateChanged' && state && INTENT_OUTCOME[state]) {
          await c.query('savepoint settle_row');
          try {
            await this.#settle(c, row.run_id, row.logical_key, INTENT_OUTCOME[state], row.intent_id);
            await c.query('release savepoint settle_row');
          } catch (error) {
            if (!(error instanceof RunControlError)) throw error;
            await c.query('rollback to savepoint settle_row');
            conflict = error.code;
          }
        }
        await this.#audit(c, {
          tenantId: row.tenant_id, agentId: row.agent_id, ...(run.rows[0] ? { deploymentId: run.rows[0].deployment_id, runId: row.run_id } : {}), intentId: row.intent_id,
          actor: { kind: 'executor' }, type: row.type, payload: { ...row.payload, logicalKey: row.logical_key, ...(conflict ? { conflict } : {}) }, source: `executor_outbox:${row.id}`, occurredAt: row.occurred_at.toISOString(),
        });
        await c.query('update executor_outbox set published_at = now() where id = $1', [row.id]);
        return false;
      });
      if (done) break;
    }
    return published;
  }

  /**
   * Exchange a runtime's control capability for an executor-audience capability (D35, D38): only for the
   * current lease of an active generation, scoped to that run, never longer than the control capability.
   */
  async issueExecutorCapability(scope: CapabilityScope): Promise<AudienceCapability> {
    return this.issueAudienceCapability(scope, 'executor');
  }

  async issueAudienceCapability(scope: CapabilityScope, audience: 'executor' | 'broker'): Promise<AudienceCapability> {
    const secret = audience === 'executor' ? this.#executorSecret : this.#brokerSecret;
    if (!secret) throw new RunControlError('NOT_FOUND', 'Executor capabilities are not configured on this control plane.');
    return this.#tx(async (c) => {
      const lease = await c.query<{ fencing_token: string; capability_expires_at: Date }>('select fencing_token, capability_expires_at from run_assignments where assignment_id = $1', [scope.assignmentId]);
      if (!lease.rows[0]) throw new RunControlError('LEASE_FENCED', 'Assignment is no longer current.');
      const run = await this.#fenced(c, scope.runId, scope.assignmentId, String(lease.rows[0].fencing_token));
      const d = await c.query<{ mode: 'paper' | 'live'; connector_versions: Record<string, string> }>('select mode, connector_versions from deployments where id = $1', [run.deployment_id]);
      const iat = Math.floor(Date.parse(this.#now()) / 1000);
      const exp = Math.min(iat + MAX_CAPABILITY_SECONDS, Math.floor(lease.rows[0].capability_expires_at.getTime() / 1000));
      if (exp <= iat) throw new RunControlError('UNAUTHENTICATED', 'The control capability has expired.');
      const token = signCapability({
        aud: audience, tenantId: run.tenant_id, agentId: run.agent_id, deploymentId: run.deployment_id, generation: String(run.generation), mode: d.rows[0]!.mode,
        actions: audience === 'executor' ? ['swap.exactInput'] : ['read', 'ai.decide'], connectors: d.rows[0]!.connector_versions, runId: run.run_id, iat, exp, jti: audience === 'broker' ? scope.assignmentId : uuidv7(),
      }, secret);
      return { schemaVersion: 'audience-capability/1', audience, token, expiresAt: new Date(exp * 1000).toISOString() };
    });
  }

  /**
   * The broker reconciled a pending or unknown read/AI operation. The operation stays pending; the resume makes
   * the runtime re-request under the same key, so the interpreter always receives the broker's typed record.
   */
  /** Recover terminal broker answers even if the reconciler died before enqueueing a resume. */
  async consumeBrokerResults(): Promise<void> {
    const pending = await this.#pool.query<{ run_id: string }>(
      `select distinct r.run_id from runs r join run_operations ro on ro.tenant_id=r.tenant_id and ro.run_id=r.run_id
       join broker_operations bo on bo.tenant_id=ro.tenant_id and bo.operation_key=ro.operation_key
       join broker_results b on b.tenant_id=bo.tenant_id and b.id=bo.latest_result_id
       where r.status='waiting' and ro.outcome='pending' and b.response->>'disposition' in ('completed','refused')`);
    for (const row of pending.rows) await this.#tx(async c => {
      const run = await this.#lockRun(c, row.run_id);
      if (run.status !== 'waiting' || run.desired_state !== 'active' || run.generation !== run.deployment_generation) return;
      const live = await c.query(`select 1 from run_assignments where run_id=$1 and (state='queued' or lease_expires_at>$2)`, [row.run_id, this.#now()]);
      if (!live.rows[0]) await this.#issueAssignment(c, run.tenant_id, row.run_id);
    });
  }

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
              (d.desired_state = 'active' and d.generation = r.generation and r.status <> 'revoked') as active
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
           join deployments d on d.tenant_id = r.tenant_id and d.id = r.deployment_id
         where ra.state = 'queued' and r.status in ('queued', 'assigned', 'waiting')
           and ra.fencing_token = (select max(fencing_token) from run_assignments x where x.run_id = ra.run_id)
           -- A worker only claims runs it can execute: its mode and the image the deployment pinned.
           and ($1::text is null or d.mode = $1) and ($2::text is null or d.runtime_image_digest = $2)
         order by ra.created_at for update of ra skip locked limit 1`,
        [request.mode ?? null, request.imageDigest ?? null],
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

  /** A capability-scoped price.read, pinned durably before returning. No RPC/provider access in the runtime. */
  async marketRead(scope: CapabilityScope, request: BrokerRequest): Promise<BrokerResult> {
    this.#valid('brokerRequest', request);
    if (scope.runId !== request.runId) throw new RunControlError('FORBIDDEN', 'Broker request is outside the capability run.');
    return this.#tx(async (c) => {
      const lease = await c.query<{ fencing_token: string }>('select fencing_token from run_assignments where assignment_id = $1', [scope.assignmentId]);
      if (!lease.rows[0]) throw new RunControlError('LEASE_FENCED', 'Assignment is no longer available.');
      const run = await this.#fenced(c, request.runId, scope.assignmentId, String(lease.rows[0].fencing_token));
      const op = await this.#operation(c, request.runId, request.operationKey);
      if (!op || op.kind !== request.kind || op.node_id !== request.nodeId || JSON.stringify(op.iteration_path) !== JSON.stringify(request.iterationPath)) throw new RunControlError('FORBIDDEN', 'Persist the matching waiting operation before broker dispatch.');
      const requestHash = await contentHash(request);
      const prior = (await c.query<{ request_hash: string; document: BrokerResult }>('select request_hash, document from market_read_results where run_id = $1 and operation_key = $2', [request.runId, request.operationKey])).rows[0];
      if (prior) {
        if (prior.request_hash !== requestHash) throw new RunControlError('IDEMPOTENCY_CONFLICT', 'Broker operation body changed.');
        return prior.document;
      }
      const program = await this.#program(run.deployment_id);
      const find = (value: unknown): Record<string, unknown> | undefined => {
        if (!value || typeof value !== 'object') return undefined;
        const record = value as Record<string, unknown>;
        if (record['id'] === request.nodeId) return record;
        for (const child of Object.values(record)) { const found = find(child); if (found) return found; }
        return undefined;
      };
      const node = find(program.strategy);
      const market = SOURCES.find((m) => m.connectorRef === request.connectorRef && (m.protocol !== 'aave-v3' || m.base === (request.operation?.startsWith('ausd.') ? 'AUSD' : 'USDC')));
      const allowedOperation = market?.protocol === 'aave-v3' ? ['price.read','reserve.read','ausd.price.read','ausd.reserve.read'].includes(request.operation ?? '') : request.operation === 'price.read';
      const base = { schemaVersion: 'broker-result/1' as const, operationKey: request.operationKey };
      let result: BrokerResult;
      if (request.kind !== 'read' || !allowedOperation || !market || Object.keys(request.arguments ?? {}).length || node?.['type'] !== 'read' || node['connectorRef'] !== request.connectorRef || node['operation'] !== request.operation) {
        result = { ...base, disposition: 'refused', reason: { code: 'BROKER_NOT_ALLOWED', message: 'Only approved native price and reserve reads are available.' } };
      } else {
        const row = (await c.query<{ document: unknown }>(`select document from finalized_market_observations where feed_ref = $1 order by (document->>'observedAt') desc limit 1`, [market.feedRef])).rows[0];
        const observation = row ? checkedObservation(row.document) : undefined;
        const now = this.#now();
        if (!observation || Date.parse(now) - Date.parse(observation.observedAt) > 30_000) {
          result = { ...base, disposition: 'refused', reason: { code: 'BROKER_STALE_DATA', message: 'No fresh finalized native oracle observation is available.' } };
        } else {
          result = { ...base, disposition: 'completed', resultId: uuidv7(), value: request.operation?.endsWith('reserve.read') && observation.reserve ? {supplyApr:rayToApr(observation.reserve.supplyRateRay),variableBorrowApr:rayToApr(observation.reserve.variableBorrowRateRay),observedAt:observation.observedAt} : { price: observation.price, observedAt: observation.observedAt }, observedAt: observation.observedAt, receivedAt: now };
        }
      }
      await c.query('insert into market_read_results (run_id, operation_key, request_hash, document, tenant_id) values ($1,$2,$3,$4,$5)', [request.runId, request.operationKey, requestHash, result, run.tenant_id]);
      return result;
    });
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
      const run = await this.#fenced(c, body.runId, body.assignmentId, body.fencingToken);
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
      await this.#audit(c, { tenantId: run.tenant_id, agentId: run.agent_id, deploymentId: run.deployment_id, runId: body.runId, actor: { kind: 'runtime' }, type: 'run.step', payload: { operationKey, kind, nodeId, iterationPath, stage: 'dispatching' }, source: `op:${body.runId}:${operationKey}:dispatching` });
    });
  }

  async result(body: RunResult): Promise<void> {
    this.#valid('runResult', body);
    await this.#tx(async (c) => {
      const run = await this.#fenced(c, body.runId, body.assignmentId, body.fencingToken);
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
      await this.#audit(c, { tenantId: run.tenant_id, agentId: run.agent_id, deploymentId: run.deployment_id, runId: body.runId, actor: { kind: 'runtime' }, type: 'run.step', payload: { operationKey: body.operationKey, kind: op.kind, nodeId: op.node_id, outcome: body.outcome }, source: `op:${body.runId}:${body.operationKey}:${body.outcome}` });
    });
  }

  async complete(body: RunComplete): Promise<void> {
    this.#valid('runComplete', body);
    await this.#tx(async (c) => {
      const run = await this.#fenced(c, body.runId, body.assignmentId, body.fencingToken);
      if (body.checkpoint.status !== 'completed' && body.checkpoint.status !== 'failed') throw new RunControlError('IDEMPOTENCY_CONFLICT', 'Only terminal checkpoints complete a run.');
      await c.query('update runs set checkpoint = $2, recorded = null, status = $3, updated_at = now() where run_id = $1', [body.runId, body.checkpoint, body.checkpoint.status]);
      const error = body.checkpoint.error;
      await this.#audit(c, { tenantId: run.tenant_id, agentId: run.agent_id, deploymentId: run.deployment_id, runId: body.runId, actor: { kind: 'runtime' }, type: 'run.stateChanged', payload: { from: run.status, to: body.checkpoint.status, steps: body.checkpoint.steps, ...(error ? { errorCode: error.code, errorNodeId: error.nodeId ?? null } : {}) }, source: `run:${body.runId}:${body.checkpoint.status}` });
    });
  }

  async timeline(body: TimelineEntry): Promise<void> {
    this.#valid('timelineEntry', body);
    await this.#tx(async (c) => {
      const run = await this.#fenced(c, body.runId, body.assignmentId, body.fencingToken);
      await this.#audit(c, { tenantId: run.tenant_id, agentId: run.agent_id, deploymentId: run.deployment_id, runId: body.runId, actor: { kind: 'runtime' }, type: 'timeline.entry', payload: { nodeId: body.nodeId, message: body.message }, source: `timeline:${body.operationKey}` });
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

  #valid(kind: 'brokerRequest' | 'assignmentPoll' | 'runWait' | 'runResult' | 'runComplete' | 'timelineEntry', body: unknown): void {
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
       where ts.deployment_id = $1 and ts.trigger_id = $2 and ts.active and d.desired_state = 'active' and d.generation = ts.generation
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
    const agent = await c.query<{ agent_id: string }>('select agent_id from deployments where id = $1', [state.deployment_id]);
    await this.#audit(c, { tenantId: state.tenant_id, agentId: agent.rows[0]!.agent_id, deploymentId: state.deployment_id, runId, actor: { kind: 'controlPlane' }, type: 'run.stateChanged', payload: { to: 'queued', triggerId, sourceEventKey, ...trigger }, source: `run:${runId}:queued` });
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
    const { rows } = await c.query<{ deployment_id: string; generation: number; deployment_revision: string; trigger_id: string; source_event_key: string; trigger: RuntimeAssignment['trigger']; mode: 'paper' | 'live'; strategy_hash: string; catalog_hash: string; connector_versions: Record<string, string>; runtime_image_digest: string; manifest_hash: string | null }>(
      `select r.deployment_id, r.generation, r.deployment_revision, r.trigger_id, r.source_event_key, r.trigger,
              d.mode, d.strategy_hash, d.catalog_hash, d.connector_versions, d.runtime_image_digest, d.manifest_hash
       from runs r join deployments d on d.tenant_id = r.tenant_id and d.id = r.deployment_id where r.run_id = $1`,
      [runId],
    );
    const row = rows[0]!;
    // The deployment-manifest/1 or /2 hash; deployments made before migration 0005 have none and are not offered work.
    if (!row.manifest_hash) throw new RunControlError('NOT_FOUND', 'Deployment has no manifest.');
    const manifestHash = row.manifest_hash;
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

  async #lockDeployment(c: pg.PoolClient, deploymentId: string) {
    const { rows } = await c.query<{ id: string; tenant_id: string; agent_id: string; generation: number; desired_state: string; mode: 'paper' | 'live' }>(
      // No-key lock: enough to serialize state changes, and it does not block the executor's intent inserts (their
      // foreign key takes a key-share lock here while holding the account lock that #finaliseIn then waits for).
      'select id, tenant_id, agent_id, generation, desired_state, mode from deployments where id = $1 for no key update', [deploymentId],
    );
    if (!rows[0]) throw new RunControlError('NOT_FOUND', 'Deployment not found.');
    return rows[0];
  }

  /** Revoke the unfinished runs of the deployment's current generation; each gets a run.stateChanged event. */
  async #revokeOpenRuns(c: pg.PoolClient, d: { id: string; tenant_id: string; agent_id: string; generation: number }, actor: AuditActor): Promise<void> {
    const open = await c.query<{ run_id: string; status: string }>(
      `update runs r set status = 'revoked', updated_at = now()
       from runs prev
       where prev.run_id = r.run_id and r.deployment_id = $1 and r.generation = $2 and r.status not in ('completed', 'failed', 'revoked')
       returning r.run_id, prev.status`,
      [d.id, d.generation],
    );
    for (const run of open.rows) {
      await this.#audit(c, { tenantId: d.tenant_id, agentId: d.agent_id, deploymentId: d.id, runId: run.run_id, actor, type: 'run.stateChanged', payload: { from: run.status, to: 'revoked', reasonCode: 'GENERATION_REVOKED' }, source: `run:${run.run_id}:revoked` });
    }
  }

  /** Paper session or daily time used up: record the skipped run and return the reason; the sweep pauses the deployment. */
  async #overQuota(c: pg.PoolClient, state: { tenant_id: string; deployment_id: string; generation: number }, triggerId: string, sourceEventKey: string): Promise<QuotaReason | undefined> {
    const mode = await c.query<{ mode: string }>('select mode from deployments where id = $1', [state.deployment_id]);
    if (mode.rows[0]?.mode !== 'paper') return undefined;
    const reason = await runAllowed(c, state.tenant_id, state.deployment_id, new Date(this.#now()));
    if (reason) await this.#skipped(c, state, triggerId, sourceEventKey, reason);
    return reason;
  }

  async #openInterval(c: pg.PoolClient, tenantId: string, deploymentId: string, generation: number): Promise<void> {
    await c.query('insert into paper_active_intervals (tenant_id, deployment_id, generation, started_at) values ($1, $2, $3, $4) on conflict do nothing', [tenantId, deploymentId, generation, this.#now()]);
  }

  async #closeInterval(c: pg.PoolClient, deploymentId: string): Promise<void> {
    await c.query('update paper_active_intervals set ended_at = greatest(started_at, $2::timestamptz) where deployment_id = $1 and ended_at is null', [deploymentId, this.#now()]);
  }

  /** An observation.skipped event for a trigger observation that did not start a run, with a vocabulary reason (#19). */
  async #skipped(c: pg.PoolClient, state: { tenant_id: string; deployment_id: string; generation: number }, triggerId: string, sourceEventKey: string, reasonCode: UserReasonCode): Promise<void> {
    const agent = await c.query<{ agent_id: string }>('select agent_id from deployments where tenant_id = $1 and id = $2', [state.tenant_id, state.deployment_id]);
    const key = sha(`${state.deployment_id}\n${state.generation}\n${triggerId}\n${sourceEventKey}`);
    await this.#audit(c, { tenantId: state.tenant_id, agentId: agent.rows[0]!.agent_id, deploymentId: state.deployment_id, actor: { kind: 'controlPlane' }, type: 'observation.skipped', payload: { triggerId, generation: state.generation, reasonCode }, source: `skip:${key}` });
  }

  /** Append one audit-event/2 row with the next per-tenant sequence; a repeated source is a no-op. */
  async #audit(c: pg.PoolClient, e: AuditInput): Promise<void> {
    const seen = await c.query('select 1 from audit_events where source = $1', [e.source]);
    if (seen.rows[0]) return;
    const seq = await c.query<{ last_sequence: string }>(
      `insert into tenant_streams (tenant_id, last_sequence) values ($1, 1)
       on conflict (tenant_id) do update set last_sequence = tenant_streams.last_sequence + 1 returning last_sequence`,
      [e.tenantId],
    );
    await c.query(
      `insert into audit_events (tenant_id, sequence, agent_id, deployment_id, run_id, intent_id, actor_kind, actor_id, trace_id, type, payload, occurred_at, source)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [e.tenantId, seq.rows[0]!.last_sequence, e.agentId ?? null, e.deploymentId ?? null, e.runId ?? null, e.intentId ?? null, e.actor.kind, 'id' in e.actor ? e.actor.id : null,
        randomBytes(16).toString('hex'), e.type, e.payload, e.occurredAt ?? this.#now(), e.source],
    );
  }

  async #lockRun(c: pg.PoolClient, runId: string): Promise<RunRow> {
    const { rows } = await c.query<RunRow>(
      `select r.tenant_id, r.run_id, r.deployment_id, r.generation, r.deployment_revision, r.trigger_id, r.source_event_key, r.trigger,
              r.status, r.checkpoint, r.recorded, r.observation_refs::text[] as observation_refs,
              d.agent_id, d.generation as deployment_generation, d.desired_state
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
    if (run.status === 'revoked' || run.desired_state !== 'active' || run.deployment_generation !== run.generation) {
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
