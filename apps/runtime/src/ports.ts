// The runtime's only ways out (agent-runtime.md section 7). Real implementations are small typed HTTP clients;
// src/local/ holds in-memory implementations of the same interfaces for the demo and conformance kits.
// Every body is a closed packages/contracts document. Failures throw RuntimeError with a stable code.
import type {
  ActionIntent,
  AssignmentOffer,
  AssignmentPoll,
  BrokerRequest,
  BrokerResult,
  IntentResult,
  RunComplete,
  RunResult,
  RunState,
  RunWait,
  TimelineEntry,
} from '@monad-hack/contracts';

/** An immutable artifact and the content hash the control API recorded for it. */
export interface Artifact {
  readonly contentHash: string;
  readonly text: string;
}

export interface ControlApi {
  /** Long-poll for the next assignment (assignment-poll/1 → assignment-offer/1). */
  poll(request: AssignmentPoll): Promise<AssignmentOffer>;
  /** Fetch an immutable strategy or catalog artifact by reference. */
  fetchArtifact(ref: string): Promise<Artifact>;
  /** Accepted checkpoint and the recorded result of its waiting operation; FENCED for a stale token. */
  loadRun(runId: string, assignmentId: string, fencingToken: string): Promise<RunState>;
  /** Atomically save the waiting checkpoint and operation before dispatch. */
  wait(body: RunWait): Promise<void>;
  /** Record a host result idempotently by operation key; CONFLICT for a different outcome. */
  result(body: RunResult): Promise<void>;
  /** Commit a terminal checkpoint. */
  complete(body: RunComplete): Promise<void>;
  /** Append a notify entry, idempotent by operation key. */
  timeline(body: TimelineEntry): Promise<void>;
  /** Renew the lease; REVOKED or FENCED when authority is gone. */
  heartbeat(assignmentId: string, fencingToken: string): Promise<void>;
}

export interface Broker {
  request(body: BrokerRequest): Promise<BrokerResult>;
}

export interface Executor {
  /** POST /internal/v1/intents: returns the new or previously recorded result for the logical key. */
  submit(intent: ActionIntent): Promise<IntentResult>;
}

export interface Clock {
  /** UTC RFC 3339 with milliseconds. */
  now(): string;
  /** Monotonic milliseconds for measuring active time. */
  monotonic(): number;
}

export const systemClock: Clock = { now: () => new Date().toISOString(), monotonic: () => performance.now() };
