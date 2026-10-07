// HTTP implementation of the ControlApi port (docs/integration/runtime-http-clients.md). One method per route,
// closed documents in both directions, explicit timeouts, no redirects, bounded retries with the identical
// body, and the single error mapping in errors.ts. Capabilities live in memory only and are never logged.
import { parse, validate } from '@monad-hack/contracts';
import type { AssignmentOfferV2, AssignmentPoll, ContractKind, RunComplete, RunResult, RunState, RunWait, TimelineEntry } from '@monad-hack/contracts';
import { RuntimeError } from '../errors.ts';
import type { Artifact, ControlApi } from '../ports.ts';
import { runtimeErrorFor } from './errors.ts';
import type { CallKind } from './errors.ts';

export interface HttpControlApiOptions {
  /** Internal control API origin, e.g. https://control.internal (from closed runtime configuration). */
  readonly origin: string;
  /** Workload-authentication headers for the poll; the mechanism is selected at deployment (gate E02). */
  readonly workload: Readonly<Record<string, string>>;
  readonly writeTimeoutMillis?: number;
  readonly attempts?: number;
  readonly fetch?: typeof globalThis.fetch;
}

interface Held {
  runId: string;
  bearer: string;
}

export class HttpControlApi implements ControlApi {
  readonly origin: string;
  readonly #workload: Readonly<Record<string, string>>;
  readonly #timeout: number;
  readonly #attempts: number;
  readonly #fetch: typeof globalThis.fetch;
  /** Capability per assignment. Kept for older assignments too, so a stale writer is fenced by the server. */
  readonly #held = new Map<string, Held>();
  #current: string | undefined;

  constructor(options: HttpControlApiOptions) {
    const origin = new URL(options.origin);
    if (origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) throw new RuntimeError('ASSIGNMENT_INVALID', 'Control API origin must be a bare origin.');
    this.origin = origin.origin;
    this.#workload = { ...options.workload };
    this.#timeout = options.writeTimeoutMillis ?? 5_000;
    this.#attempts = options.attempts ?? 3;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async poll(request: AssignmentPoll): Promise<AssignmentOfferV2> {
    const offer = await this.#call('POST', '/internal/v1/runtime/assignments:poll', { body: request, requestKind: 'assignmentPoll', responseKind: 'assignmentOffer2', headers: this.#workload, timeoutMillis: request.waitSeconds * 1000 + 5_000 });
    if (offer.disposition === 'assigned' && offer.assignment && offer.capability) {
      this.#held.set(offer.assignment.assignmentId, { runId: offer.assignment.run.runId, bearer: offer.capability.bearer });
      this.#current = offer.assignment.assignmentId;
    }
    return offer;
  }

  /** Uses the capability of the assignment most recently received from poll (artifacts belong to its deployment). */
  async fetchArtifact(ref: string): Promise<Artifact> {
    if (!this.#current) throw new RuntimeError('ASSIGNMENT_INVALID', 'No assignment holds a capability for artifacts.');
    const artifact = await this.#call('GET', `/internal/v1/runtime/artifacts/${encodeURIComponent(ref)}`, { responseKind: 'artifact', headers: this.#bearer(this.#current), callKind: 'artifact' });
    if (artifact.ref !== ref) throw new RuntimeError('RESULT_INVALID', 'Artifact answer is for a different reference.');
    return { contentHash: artifact.contentHash, text: artifact.text };
  }

  async loadRun(runId: string, assignmentId: string, fencingToken: string): Promise<RunState> {
    const query = new URLSearchParams({ assignmentId, fencingToken });
    const state = await this.#call('GET', `/internal/v1/runs/${runId}?${query}`, { responseKind: 'runState', headers: this.#bearer(assignmentId) });
    if (state.runId !== runId) throw new RuntimeError('RESULT_INVALID', 'Run state is for a different run.');
    return state as RunState;
  }

  async wait(body: RunWait): Promise<void> {
    await this.#call('POST', `/internal/v1/runs/${body.runId}/wait`, { body, requestKind: 'runWait', headers: this.#bearer(body.assignmentId) });
  }

  async result(body: RunResult): Promise<void> {
    await this.#call('POST', `/internal/v1/runs/${body.runId}/results`, { body, requestKind: 'runResult', headers: this.#bearer(body.assignmentId) });
  }

  async complete(body: RunComplete): Promise<void> {
    await this.#call('POST', `/internal/v1/runs/${body.runId}/complete`, { body, requestKind: 'runComplete', headers: this.#bearer(body.assignmentId) });
  }

  async timeline(body: TimelineEntry): Promise<void> {
    await this.#call('POST', `/internal/v1/runs/${body.runId}/timeline`, { body, requestKind: 'timelineEntry', headers: this.#bearer(body.assignmentId) });
  }

  async heartbeat(assignmentId: string, fencingToken: string): Promise<void> {
    const held = this.#held.get(assignmentId);
    if (!held) throw new RuntimeError('FENCED', 'No capability is held for this assignment.');
    const lease = await this.#call('POST', '/internal/v1/runtime/heartbeat', {
      body: { schemaVersion: 'runtime-heartbeat/1', runId: held.runId, assignmentId, fencingToken }, requestKind: 'runtimeHeartbeat', responseKind: 'runtimeLease', headers: this.#bearer(assignmentId),
    });
    held.bearer = lease.capability.bearer;
  }

  #bearer(assignmentId: string): Record<string, string> {
    const held = this.#held.get(assignmentId);
    // Without a capability the request cannot be authorized; the server would answer 401 anyway.
    if (!held) throw new RuntimeError('REVOKED', 'No capability is held for this assignment.');
    return { authorization: `Bearer ${held.bearer}` };
  }

  async #call<R extends ContractKind | undefined = undefined>(
    method: 'GET' | 'POST', path: string,
    options: { body?: unknown; requestKind?: ContractKind; responseKind?: R; headers: Readonly<Record<string, string>>; timeoutMillis?: number; callKind?: CallKind },
  ): Promise<R extends ContractKind ? import('@monad-hack/contracts').ContractDocumentMap[R] : undefined> {
    if (options.requestKind && !validate(options.requestKind, options.body).ok) throw new RuntimeError('HOST_BUG', `Refusing to send a malformed ${options.requestKind}.`);
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    let last: RuntimeError | undefined;
    for (let attempt = 1; attempt <= this.#attempts; attempt++) {
      try {
        const response = await this.#fetch(this.origin + path, {
          method,
          redirect: 'error',
          signal: AbortSignal.timeout(options.timeoutMillis ?? this.#timeout),
          headers: { accept: 'application/json', 'x-request-id': crypto.randomUUID(), ...(payload ? { 'content-type': 'application/json' } : {}), ...options.headers },
          ...(payload ? { body: payload } : {}),
        });
        const text = await response.text();
        if (!response.ok) {
          let code: string | undefined;
          try { code = (JSON.parse(text) as { code?: unknown }).code as string | undefined; } catch { code = undefined; }
          const error = runtimeErrorFor(response.status, typeof code === 'string' ? code : undefined, options.callKind);
          if (error.code !== 'UNAVAILABLE') throw error;
          last = error;
        } else {
          if (!options.responseKind) return undefined as never;
          const parsed = parse(options.responseKind, text);
          if (!parsed.ok) throw new RuntimeError('RESULT_INVALID', `Control API answer failed ${options.responseKind}.`);
          return parsed.value as never;
        }
      } catch (error) {
        if (error instanceof RuntimeError) throw error;
        // Network error or timeout: the write may have happened. Retrying the identical idempotent body is safe.
        last = new RuntimeError('UNAVAILABLE', 'Control API unreachable or timed out.');
      }
      if (attempt < this.#attempts) await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt + Math.random() * 50));
    }
    throw last ?? new RuntimeError('UNAVAILABLE', 'Control API unavailable.');
  }
}
