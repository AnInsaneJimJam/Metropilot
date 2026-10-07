// In-memory control plane for local runs: the control API the runtime talks to, plus the API-worker roles the
// runtime never performs (deployment, push-first price ingestion with trigger_state fan-out, schedules, run
// creation, resume after pending effects, pause). It models the documented semantics, not their durability:
// a real implementation does each mutation below in one PostgreSQL transaction (docs/integration/control-api.md).
import { contentHash, validate } from '@monad-hack/contracts';
import type { AssignmentOffer, AssignmentPoll, RunCheckpoint, RunComplete, RunResult, RunState, RunWait, RuntimeAssignment, TimelineEntry } from '@monad-hack/contracts';
import { compileStrategy, scheduleSlot, transitionPrice } from '@monad-hack/strategy';
import type { Catalog, CompiledStrategy, CrossingState, PriceObservation } from '@monad-hack/strategy';
import { RuntimeError } from '../errors.ts';
import type { Artifact, Clock, ControlApi } from '../ports.ts';
import { Ids, runIdFor } from './support.ts';

type Outcome = RunResult['outcome'];
type Recorded = NonNullable<RunState['recorded']>;
const TERMINAL_OUTCOMES = new Set<Outcome>(['settled', 'rejected', 'failed', 'acknowledged', 'recorded', 'timeout', 'refused']);

export interface Deployment {
  readonly deploymentId: string;
  generation: number;
  readonly mode: 'paper' | 'live';
  active: boolean;
  readonly program: CompiledStrategy;
  readonly strategyRef: string;
  readonly catalogRef: string;
  readonly catalogHash: string;
  readonly connectorVersions: Readonly<Record<string, string>>;
}

/** One trigger_state row: unique per (deployment, trigger); feed_ref is copied out of the AST at deploy time. */
interface TriggerState {
  readonly deploymentId: string;
  readonly triggerId: string;
  readonly type: string;
  readonly feedRef?: string;
  generation: number;
  active: boolean;
  crossing: CrossingState;
  lastSlot?: string;
}

interface Operation {
  readonly kind: string;
  readonly nodeId: string;
  readonly iterationPath: string;
  outcome?: Outcome;
  resultRef?: string;
}

export interface Run {
  readonly runId: string;
  readonly deploymentId: string;
  readonly generation: number;
  readonly triggerId: string;
  readonly sourceEventKey: string;
  readonly trigger: RuntimeAssignment['trigger'];
  checkpoint?: RunCheckpoint;
  recorded?: Recorded;
  observationRefs: string[];
  operations: Map<string, Operation>;
  assignment?: { assignmentId: string; fencingToken: string };
  fencingCounter: number;
  status: 'queued' | 'assigned' | 'waiting' | 'completed' | 'failed';
}

export interface TimelineRow {
  readonly runId: string;
  readonly operationKey: string;
  readonly nodeId: string;
  readonly message: string;
  readonly inputs: TimelineEntry['inputs'];
}

export interface FanOut {
  readonly deploymentId: string;
  readonly triggerId: string;
  readonly reason: string;
  readonly runId?: string;
}

export class LocalControlPlane implements ControlApi {
  readonly deployments = new Map<string, Deployment>();
  readonly runs = new Map<string, Run>();
  readonly timelineRows: TimelineRow[] = [];
  readonly #triggerState: TriggerState[] = [];
  readonly #artifacts = new Map<string, Artifact>();
  readonly #queue: RuntimeAssignment[] = [];
  readonly #clock: Clock;
  readonly #ids: Ids;
  readonly #imageDigest: string;
  #draining = false;

  constructor(options: { clock: Clock; imageDigest: string }) {
    this.#clock = options.clock;
    this.#ids = new Ids(options.clock);
    this.#imageDigest = options.imageDigest;
  }

  // ---- Worker role: deployment ------------------------------------------------------------------------------

  async deploy(input: { strategy: unknown; catalog: Catalog; mode: 'paper' | 'live'; connectorVersions: Record<string, string> }): Promise<Deployment> {
    const program = await compileStrategy(JSON.stringify(input.strategy), input.catalog);
    const deploymentId = this.#ids.next();
    const catalogHash = await contentHash(input.catalog);
    const strategyRef = `artifact:deployment/${deploymentId}/strategy`;
    const catalogRef = `artifact:catalog/${catalogHash.slice(2, 18)}`;
    this.#artifacts.set(strategyRef, { contentHash: program.hash, text: program.canonicalJson });
    this.#artifacts.set(catalogRef, { contentHash: catalogHash, text: JSON.stringify(input.catalog) });
    const deployment: Deployment = { deploymentId, generation: 1, mode: input.mode, active: true, program, strategyRef, catalogRef, catalogHash, connectorVersions: { ...input.connectorVersions } };
    this.deployments.set(deploymentId, deployment);
    for (const trigger of program.strategy.triggers) {
      this.#triggerState.push({ deploymentId, triggerId: trigger.id, type: trigger.type, ...('feedRef' in trigger ? { feedRef: trigger.feedRef } : {}), generation: 1, active: true, crossing: {} });
    }
    return deployment;
  }

  /** Pause revokes authority for new operations at once; external effects stay with their owners to reconcile. */
  pause(deploymentId: string): void {
    const deployment = this.#deployment(deploymentId);
    deployment.active = false;
    for (const row of this.#triggerState) if (row.deploymentId === deploymentId) row.active = false;
  }

  /** Resume or redeploy mints a new generation; the old generation's runtimes can never act again. */
  resume(deploymentId: string): void {
    const deployment = this.#deployment(deploymentId);
    deployment.generation += 1;
    deployment.active = true;
    for (const row of this.#triggerState) if (row.deploymentId === deploymentId) Object.assign(row, { generation: deployment.generation, active: true, crossing: {} });
  }

  /** Tell polling runtimes to drain (offer disposition `drain`). */
  drainRuntimes(): void {
    this.#draining = true;
  }

  // ---- Worker role: push-first ingestion and fan-out (decision D32) ------------------------------------------

  /**
   * One finalized observation for a feed. SQL equivalent:
   *   SELECT … FROM trigger_state ts JOIN deployments d … WHERE ts.feed_ref = $1 AND ts.active AND d.generation = ts.generation
   * then per row: SELECT … FOR UPDATE; transitionPrice(); UPDATE trigger_state; INSERT run + job if it fires; COMMIT.
   */
  async ingestPrice(observation: PriceObservation & { observationRef?: string }): Promise<FanOut[]> {
    const results: FanOut[] = [];
    for (const row of this.#triggerState.filter((r) => r.active && r.feedRef === observation.feedRef)) {
      const deployment = this.#deployment(row.deploymentId);
      if (!deployment.active || deployment.generation !== row.generation) continue;
      const trigger = deployment.program.strategy.triggers.find((t) => t.id === row.triggerId);
      if (trigger?.type !== 'price.crossesAbove' && trigger?.type !== 'price.crossesBelow') continue;
      const now = this.#clock.now();
      const decision = transitionPrice(trigger, row.crossing, observation, now);
      row.crossing = decision.state;
      if (!decision.fire) { results.push({ deploymentId: row.deploymentId, triggerId: row.triggerId, reason: decision.reason }); continue; }
      const runId = await this.#createRun(deployment, row.triggerId, observation.sourceEventKey, {
        ...(observation.observationRef ? { observationRef: observation.observationRef } : {}), observedAt: observation.observedAt, acceptedAt: now, runCreatedAt: now,
      });
      results.push({ deploymentId: row.deploymentId, triggerId: row.triggerId, reason: runId ? 'crossing' : 'duplicate-run', ...(runId ? { runId } : {}) });
    }
    return results;
  }

  /** Schedule rows due now: the newest still-fresh slot only; missed slots coalesce (runtime.md). */
  async tickSchedules(): Promise<FanOut[]> {
    const results: FanOut[] = [];
    for (const row of this.#triggerState.filter((r) => r.active && r.type === 'schedule')) {
      const deployment = this.#deployment(row.deploymentId);
      const trigger = deployment.program.strategy.triggers.find((t) => t.id === row.triggerId);
      if (!deployment.active || trigger?.type !== 'schedule') continue;
      const now = this.#clock.now();
      const slot = scheduleSlot(trigger, now, row.lastSlot);
      if (!slot) continue;
      row.lastSlot = slot;
      const runId = await this.#createRun(deployment, row.triggerId, `schedule:${slot}`, { acceptedAt: now, runCreatedAt: now });
      results.push({ deploymentId: row.deploymentId, triggerId: row.triggerId, reason: runId ? 'slot' : 'duplicate-run', ...(runId ? { runId } : {}) });
    }
    return results;
  }

  /** Executor/broker reconciliation recorded a definitive result for a pending operation: record it, then resume. */
  async settleOperation(runId: string, operationKey: string, outcome: Outcome, resultRef?: string): Promise<void> {
    const run = this.#run(runId);
    const operation = run.operations.get(operationKey);
    if (!operation) throw new RuntimeError('CONFLICT', 'Unknown operation for this run.');
    if (operation.outcome && TERMINAL_OUTCOMES.has(operation.outcome)) {
      if (operation.outcome !== outcome) throw new RuntimeError('CONFLICT', 'Operation already has a different definitive outcome.');
      return;
    }
    operation.outcome = outcome;
    if (resultRef) operation.resultRef = resultRef;
    if (run.checkpoint?.waiting) run.recorded = { operationKey, outcome, ...(resultRef ? { resultRef } : {}) };
    this.#issueAssignment(run);
  }

  /**
   * The broker reconciled a pending or unknown read/AI operation. The operation stays `pending` here; the resume
   * makes the runtime re-request under the same key and the broker answers with the reconciled record, so the
   * interpreter always receives the typed record from the broker, never a bare reference.
   */
  resumeBrokerOperation(runId: string): void {
    this.#issueAssignment(this.#run(runId));
  }

  /** Re-offer a run whose lease was lost (process crash): a new fencing token supersedes the old owner. */
  reassign(runId: string): void {
    this.#issueAssignment(this.#run(runId));
  }

  // ---- ControlApi: what the runtime calls --------------------------------------------------------------------

  async poll(request: AssignmentPoll): Promise<AssignmentOffer> {
    if (!validate('assignmentPoll', request).ok) throw new RuntimeError('RESULT_INVALID', 'Malformed poll.');
    if (this.#draining) return { schemaVersion: 'assignment-offer/1', disposition: 'drain' };
    const assignment = this.#queue.shift();
    return assignment ? { schemaVersion: 'assignment-offer/1', disposition: 'assigned', assignment } : { schemaVersion: 'assignment-offer/1', disposition: 'none' };
  }

  async fetchArtifact(ref: string): Promise<Artifact> {
    const artifact = this.#artifacts.get(ref);
    if (!artifact) throw new RuntimeError('ASSIGNMENT_INVALID', 'Unknown artifact reference.');
    return artifact;
  }

  async loadRun(runId: string, assignmentId: string, fencingToken: string): Promise<RunState> {
    const run = this.#fenced(runId, assignmentId, fencingToken);
    return { schemaVersion: 'run-state/1', runId, ...(run.checkpoint ? { checkpoint: structuredClone(run.checkpoint) } : {}), ...(run.recorded ? { recorded: structuredClone(run.recorded) } : {}), observationRefs: [...run.observationRefs] };
  }

  async wait(body: RunWait): Promise<void> {
    this.#valid('runWait', body);
    const run = this.#fenced(body.runId, body.assignmentId, body.fencingToken);
    const { operationKey, kind, nodeId, iterationPath } = body.operation;
    const existing = run.operations.get(operationKey);
    const path = JSON.stringify(iterationPath);
    if (existing && (existing.kind !== kind || existing.nodeId !== nodeId || existing.iterationPath !== path)) throw new RuntimeError('CONFLICT', 'Operation key reused for a different operation.');
    if (!existing) run.operations.set(operationKey, { kind, nodeId, iterationPath: path });
    run.checkpoint = structuredClone(body.checkpoint);
    // A new waiting operation has no result yet; a re-wait for an operation that already has one keeps it.
    const known = run.operations.get(operationKey)!;
    if (known.outcome) run.recorded = { operationKey, outcome: known.outcome, ...(known.resultRef ? { resultRef: known.resultRef } : {}) };
    else delete run.recorded;
    run.status = 'waiting';
  }

  async result(body: RunResult): Promise<void> {
    this.#valid('runResult', body);
    const run = this.#fenced(body.runId, body.assignmentId, body.fencingToken);
    const operation = run.operations.get(body.operationKey);
    if (!operation) throw new RuntimeError('CONFLICT', 'Result for an operation that was never persisted with wait.');
    if (operation.outcome && TERMINAL_OUTCOMES.has(operation.outcome)) {
      if (operation.outcome !== body.outcome) throw new RuntimeError('CONFLICT', 'Operation already has a different definitive outcome.');
      return;
    }
    operation.outcome = body.outcome;
    if (body.resultRef) operation.resultRef = body.resultRef;
    if (body.outcome === 'recorded' && body.resultRef && !run.observationRefs.includes(body.resultRef)) run.observationRefs.push(body.resultRef);
    run.recorded = { operationKey: body.operationKey, outcome: body.outcome, ...(body.resultRef ? { resultRef: body.resultRef } : {}), ...(body.result ? { result: body.result } : {}), ...(body.receivedAt ? { receivedAt: body.receivedAt } : {}) };
  }

  async complete(body: RunComplete): Promise<void> {
    this.#valid('runComplete', body);
    const run = this.#fenced(body.runId, body.assignmentId, body.fencingToken);
    if (body.checkpoint.status !== 'completed' && body.checkpoint.status !== 'failed') throw new RuntimeError('CONFLICT', 'Only terminal checkpoints complete a run.');
    run.checkpoint = structuredClone(body.checkpoint);
    delete run.recorded;
    run.status = body.checkpoint.status;
  }

  async timeline(body: TimelineEntry): Promise<void> {
    this.#valid('timelineEntry', body);
    this.#fenced(body.runId, body.assignmentId, body.fencingToken);
    if (this.timelineRows.some((row) => row.operationKey === body.operationKey)) return;
    this.timelineRows.push({ runId: body.runId, operationKey: body.operationKey, nodeId: body.nodeId, message: body.message, inputs: structuredClone(body.inputs) });
  }

  async heartbeat(assignmentId: string, fencingToken: string): Promise<void> {
    const run = [...this.runs.values()].find((r) => r.assignment?.assignmentId === assignmentId);
    if (!run) throw new RuntimeError('FENCED', 'Assignment is no longer current.');
    this.#fenced(run.runId, assignmentId, fencingToken);
  }

  // ---- Executor-facing authority (the capability check, derived from server state, not the request body) ----

  authorityFor(runId: string): { deploymentId: string; generation: string; mode: 'paper' | 'live'; active: boolean } | undefined {
    const run = this.runs.get(runId);
    if (!run) return undefined;
    const deployment = this.#deployment(run.deploymentId);
    return { deploymentId: deployment.deploymentId, generation: String(run.generation), mode: deployment.mode, active: deployment.active && deployment.generation === run.generation };
  }

  // ---- internals ---------------------------------------------------------------------------------------------

  async #createRun(deployment: Deployment, triggerId: string, sourceEventKey: string, trigger: RuntimeAssignment['trigger']): Promise<string | undefined> {
    const runId = await runIdFor(revisionOf(deployment), triggerId, sourceEventKey);
    if (this.runs.has(runId)) return undefined; // unique run key: a duplicate event cannot create a second run
    const run: Run = { runId, deploymentId: deployment.deploymentId, generation: deployment.generation, triggerId, sourceEventKey, trigger, observationRefs: [], operations: new Map(), fencingCounter: 0, status: 'queued' };
    this.runs.set(runId, run);
    this.#issueAssignment(run);
    return runId;
  }

  #issueAssignment(run: Run): void {
    const deployment = this.#deployment(run.deploymentId);
    const now = Date.parse(this.#clock.now());
    const assignmentId = this.#ids.next();
    run.fencingCounter += 1;
    run.assignment = { assignmentId, fencingToken: String(run.fencingCounter) };
    run.status = 'assigned';
    const at = (offset: number): string => new Date(now + offset).toISOString();
    this.#queue.push({
      schemaVersion: 'runtime-assignment/1', assignmentId,
      lease: { owner: `local-worker`, fencingToken: run.assignment.fencingToken, expiresAt: at(30_000) },
      deployment: { deploymentId: deployment.deploymentId, generation: String(run.generation), mode: deployment.mode, manifestHash: deployment.catalogHash, runtimeImageDigest: this.#imageDigest, connectorVersions: { ...deployment.connectorVersions } },
      interpreter: { languageVersion: 'strategy/1', checkpointVersion: 'strategy-run/2' },
      run: { runId: run.runId, deploymentRevision: `${deployment.deploymentId}/${run.generation}`, triggerId: run.triggerId, sourceEventKey: run.sourceEventKey },
      trigger: structuredClone(run.trigger),
      artifacts: { strategyRef: deployment.strategyRef, strategyHash: deployment.program.hash, catalogRef: deployment.catalogRef, catalogHash: deployment.catalogHash },
      capabilityRef: `capability:local/${assignmentId}`,
      issuedAt: at(0), expiresAt: at(60_000),
    });
  }

  #fenced(runId: string, assignmentId: string, fencingToken: string): Run {
    const run = this.#run(runId);
    const deployment = this.#deployment(run.deploymentId);
    if (!deployment.active || deployment.generation !== run.generation) throw new RuntimeError('REVOKED', 'Deployment generation is paused or replaced.');
    if (run.assignment?.assignmentId !== assignmentId || run.assignment.fencingToken !== fencingToken) throw new RuntimeError('FENCED', 'A newer lease owns this run.');
    return run;
  }

  #valid(kind: 'runWait' | 'runResult' | 'runComplete' | 'timelineEntry', body: unknown): void {
    const result = validate(kind, body);
    if (!result.ok) throw new RuntimeError('RESULT_INVALID', `Malformed ${kind} at ${result.issues[0]?.fieldPath || '/'}.`);
  }

  #run(runId: string): Run {
    const run = this.runs.get(runId);
    if (!run) throw new RuntimeError('CONFLICT', 'Unknown run.');
    return run;
  }

  #deployment(id: string): Deployment {
    const deployment = this.deployments.get(id);
    if (!deployment) throw new RuntimeError('CONFLICT', 'Unknown deployment.');
    return deployment;
  }
}

/** Opaque deploymentRevision used as interpreter run identity input: one per deployment generation. */
export const revisionOf = (deployment: Deployment): string => `${deployment.deploymentId}/${deployment.generation}`;
