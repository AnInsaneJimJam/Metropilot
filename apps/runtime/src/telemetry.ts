// Structured, redacted runtime telemetry (agent-runtime.md section 14) and per-stage latency (decision D34).
// Events carry identities and stable codes only: never capability refs, prompts, model text or provider bodies.

export interface TelemetryEvent {
  readonly at: string;
  readonly event: string;
  readonly runId?: string;
  readonly nodeId?: string;
  readonly operationKey?: string;
  readonly kind?: string;
  readonly outcome?: string;
  readonly code?: string;
  readonly millis?: number;
}

export interface StageTimings {
  /** Trigger stages recorded by the control plane, then this runtime's own stages, in milliseconds. */
  readonly observedToAccepted?: number;
  readonly acceptedToRunCreated: number;
  readonly runCreatedToAssignmentReceived: number;
  readonly assignmentReceivedToVerified: number;
  readonly verifiedToFirstDispatch?: number;
}

export interface Sink {
  write(event: TelemetryEvent): void;
}

const ALLOWED = new Set(['at', 'event', 'runId', 'nodeId', 'operationKey', 'kind', 'outcome', 'code', 'millis']);

export class Telemetry {
  readonly events: TelemetryEvent[] = [];
  readonly #sink: Sink | undefined;
  constructor(sink?: Sink) {
    this.#sink = sink;
  }
  emit(event: TelemetryEvent): void {
    // Drop anything outside the closed field set, so a careless caller cannot leak a payload.
    const clean = Object.fromEntries(Object.entries(event).filter(([key, value]) => ALLOWED.has(key) && value !== undefined)) as unknown as TelemetryEvent;
    this.events.push(clean);
    this.#sink?.write(clean);
  }
}

const ms = (from: string, to: string): number => Date.parse(to) - Date.parse(from);

export function stageTimings(trigger: { observedAt?: string; acceptedAt: string; runCreatedAt: string }, received: string, verified: string, firstDispatch?: string): StageTimings {
  return {
    ...(trigger.observedAt ? { observedToAccepted: ms(trigger.observedAt, trigger.acceptedAt) } : {}),
    acceptedToRunCreated: ms(trigger.acceptedAt, trigger.runCreatedAt),
    runCreatedToAssignmentReceived: ms(trigger.runCreatedAt, received),
    assignmentReceivedToVerified: ms(received, verified),
    ...(firstDispatch ? { verifiedToFirstDispatch: ms(verified, firstDispatch) } : {}),
  };
}
