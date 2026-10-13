// Process lifecycle (agent-runtime.md section 4): starting → ready → executing ⇄ waiting → idle → draining → stopped.
// A warm task long-polls for its next assignment (decision D33); exactly one run advances at a time.
import { validate } from '@monad-hack/contracts';
import { verifyAssignment } from './assignment.ts';
import type { RuntimeConfig } from './config.ts';
import { LOSES_AUTHORITY, RuntimeError } from './errors.ts';
import { Authority, runAssignment } from './host.ts';
import type { HostDeps, RunOutcome } from './host.ts';
import type { Broker, Clock, ControlApi, Executor } from './ports.ts';
import { stageTimings, Telemetry } from './telemetry.ts';
import type { StageTimings } from './telemetry.ts';

export type ProcessState = 'starting' | 'ready' | 'executing' | 'idle' | 'draining' | 'stopped' | 'failed';

export interface SupervisorDeps {
  readonly config: RuntimeConfig;
  readonly control: ControlApi;
  readonly broker: Broker;
  readonly executor: Executor;
  readonly clock?: Clock;
  readonly telemetry?: Telemetry;
  readonly crashAt?: HostDeps['crashAt'];
}

export interface CycleReport {
  readonly disposition: 'assigned' | 'none' | 'drain';
  readonly assignmentId?: string;
  readonly outcome?: RunOutcome['status'] | 'refused' | 'lost-authority';
  readonly code?: string;
  readonly timings?: StageTimings;
}

export class Supervisor {
  state: ProcessState = 'starting';
  readonly telemetry: Telemetry;
  readonly #deps: SupervisorDeps;
  readonly #clock: Clock;
  #lastAssignmentId: string | undefined;
  #drainRequested = false;
  #current: Authority | undefined;

  constructor(deps: SupervisorDeps) {
    this.#deps = deps;
    this.#clock = deps.clock ?? { now: () => new Date().toISOString(), monotonic: () => performance.now() };
    this.telemetry = deps.telemetry ?? new Telemetry();
    this.state = 'ready';
  }

  /** Stop taking work. An executing run sees revoked authority before its next step or dispatch. */
  drain(): void {
    this.#drainRequested = true;
    this.#current?.revoke(new RuntimeError('DRAINING', 'Runtime is draining.'));
    if (this.state !== 'executing') this.state = 'draining';
  }

  /** Serve until drained: the warm-task loop. */
  async serve(): Promise<void> {
    while (!this.#drainRequested && this.state !== 'failed') await this.cycle();
    this.state = 'stopped';
    this.telemetry.emit({ at: this.#clock.now(), event: 'runtime.stopped' });
  }

  /** One poll and at most one assignment. Exposed for tests and the demo. */
  async cycle(): Promise<CycleReport> {
    const { config, control } = this.#deps;
    const poll = { schemaVersion: 'assignment-poll/1' as const, runtimeId: config.runtimeId, mode: config.mode, imageDigest: config.imageDigest, state: this.state === 'idle' ? 'idle' as const : 'ready' as const, waitSeconds: config.pollWaitSeconds, ...(this.#lastAssignmentId ? { lastAssignmentId: this.#lastAssignmentId } : {}) };
    const offer = await control.poll(poll);
    if (!validate('assignmentOffer2', offer).ok) throw new RuntimeError('RESULT_INVALID', 'Assignment offer failed its schema.');
    if (offer.disposition === 'drain') { this.drain(); return { disposition: 'drain' }; }
    if (offer.disposition === 'none' || !offer.assignment) return { disposition: 'none' };
    return this.execute(offer.assignment);
  }

  /** Verify and drive one assignment, with heartbeats for its duration. */
  async execute(raw: unknown): Promise<CycleReport> {
    const received = this.#clock.now();
    this.state = 'executing';
    const authority = new Authority();
    this.#current = authority;
    if (this.#drainRequested) authority.revoke(new RuntimeError('DRAINING', 'Runtime is draining.'));
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const assignmentId = (raw as { assignmentId?: string } | null)?.assignmentId;
    try {
      const verified = await verifyAssignment(raw, this.#deps.config, this.#deps.control, this.#clock);
      const verifiedAt = this.#clock.now();
      const { assignment } = verified;
      this.#lastAssignmentId = assignment.assignmentId;
      heartbeat = setInterval(() => {
        this.#deps.control.heartbeat(assignment.assignmentId, assignment.lease.fencingToken).catch((error: unknown) => {
          authority.revoke(error instanceof RuntimeError ? error : new RuntimeError('UNAVAILABLE', 'Heartbeat failed.'));
        });
      }, this.#deps.config.heartbeatMillis);
      heartbeat.unref?.();
      let firstDispatch: string | undefined;
      const outcome = await runAssignment(verified, {
        control: this.#deps.control, broker: this.#deps.broker, executor: this.#deps.executor, clock: this.#clock,
        telemetry: { emit: (event) => { if (event.event === 'operation.dispatch') firstDispatch ??= event.at; this.telemetry.emit(event); } } as Telemetry,
        authority, ...(this.#deps.crashAt ? { crashAt: this.#deps.crashAt } : {}),
      });
      const timings = stageTimings(assignment.trigger, received, verifiedAt, firstDispatch);
      for (const [stage, millis] of Object.entries(timings)) {
        this.telemetry.emit({ at: this.#clock.now(), event: 'run.stage', runId: assignment.run.runId, kind: stage, millis });
      }
      this.telemetry.emit({ at: this.#clock.now(), event: 'run.released', runId: assignment.run.runId, outcome: outcome.status, millis: Date.parse(this.#clock.now()) - Date.parse(received) });
      return { disposition: 'assigned', assignmentId: assignment.assignmentId, outcome: outcome.status, timings };
    } catch (error) {
      if (!(error instanceof RuntimeError)) throw error;
      this.telemetry.emit({ at: this.#clock.now(), event: 'assignment.stopped', code: error.code });
      if (error.code === 'HOST_BUG') this.state = 'failed';
      return { disposition: 'assigned', ...(assignmentId ? { assignmentId } : {}), outcome: LOSES_AUTHORITY.has(error.code) ? 'lost-authority' : 'refused', code: error.code };
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      this.#current = undefined;
      if (this.state === 'executing') this.state = this.#drainRequested ? 'draining' : 'idle';
    }
  }
}
