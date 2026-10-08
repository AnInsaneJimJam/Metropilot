// Intent orchestration (docs/specs/executor.md sections 3–8 and 13): admission in the specified order,
// paper dispatch and restart recovery. Answers are closed intent-result/1 documents or error-1 failures
// mapped as in docs/integration/runtime-http-clients.md section 3.
import { contentHash, intentKey, parse } from '@monad-hack/contracts';
import type { ErrorCode, IntentResult } from '@monad-hack/contracts';
import { evaluateAction } from '@monad-hack/policy';
import type { ActionContext, ActionLimits, ReasonCode, Verdict } from '@monad-hack/policy';
import { matchApprovedNode } from './authorization.ts';
import type { AuthoritySource, DeploymentAuthority } from './authorization.ts';
import { CapabilityError, verifyCapability } from './capability.ts';
import type { Capability } from './capability.ts';
import { uuidv7, UUIDV7 } from './ids.ts';
import { computeFill, PAPER_ADAPTER_VERSION, PAPER_ASSUMPTIONS, paperFillId } from './paper.ts';
import type { MarketData, RecordedQuote } from './paper.ts';
import { TERMINAL_STATES } from './store.ts';
import type { ExecutorStore, FrozenAction, IntentRow } from './store.ts';

export interface Failure {
  readonly status: 400 | 401 | 403 | 404 | 409 | 422 | 503;
  readonly code: ErrorCode;
  readonly message: string;
  /** Stable executor reason carried in error-1 details.reason. */
  readonly reason?: ReasonCode;
  readonly fieldPath?: string;
}

export type Reply = { readonly status: 200 | 201 | 202; readonly result: IntentResult } | { readonly failure: Failure };

export interface ExecutorOptions {
  readonly store: ExecutorStore;
  readonly authority: AuthoritySource;
  readonly market: MarketData;
  readonly capabilitySecret: Uint8Array;
  /** Platform limits; combined with user policy and the strategy node by the most restrictive value. */
  readonly platformLimits: ActionLimits;
  /** Maximum age of a recorded quote used to admit or fill. */
  readonly maxQuoteAgeSeconds: number;
  /** Fill paper intents during the admitting request (true) or only through reconcile() (false). */
  readonly dispatchInline?: boolean;
  readonly now?: () => Date;
}

const SUPPORTED_ACTION = 'swap.exactInput';

const fail = (status: Failure['status'], code: ErrorCode, message: string, reason?: ReasonCode): { failure: Failure } => ({
  failure: reason ? { status, code, message, reason } : { status, code, message },
});

/** JSON-safe policy context for hashing (bigints as decimal strings). */
const jsonSafe = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)));

/** Read the approved policy snapshot's limits; unknown fields are ignored, malformed known fields are dropped (and so deny). */
function policyLimits(limits: Record<string, unknown> | undefined, tokenInRef: string): ActionLimits {
  if (!limits) return {};
  const out: { -readonly [K in keyof ActionLimits]: ActionLimits[K] } = {};
  const int = (v: unknown, max: number): number | undefined => (Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= max ? (v as number) : undefined);
  const slippage = int(limits['maxSlippageBps'], 10_000);
  const daily = int(limits['dailyActionCount'], 1_000_000);
  if (slippage !== undefined) out.maxSlippageBps = slippage;
  if (daily !== undefined) out.dailyActionCount = daily;
  const perAsset = limits['maxInputAtomic'];
  if (typeof perAsset === 'object' && perAsset !== null) {
    const raw = (perAsset as Record<string, unknown>)[tokenInRef];
    if (typeof raw === 'string' && /^[0-9]{1,78}$/.test(raw)) out.maxInputAtomic = BigInt(raw);
  }
  return out;
}

export function toResult(row: IntentRow): IntentResult {
  const action: IntentResult['action'] = { ...row.action };
  if (row.inputAtomic !== undefined) action.resolvedInputAtomic = row.inputAtomic.toString();
  const result: IntentResult = {
    schemaVersion: 'intent-result/1',
    intentId: row.id,
    logicalKey: row.logicalKey,
    mode: 'paper',
    state: row.state,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    action,
  };
  if (row.reason) result.reason = { code: row.reason.code, message: row.reason.message };
  if (row.paperFillId) result.paperFillId = row.paperFillId;
  if (row.state === 'settled') result.settlement = { inputAtomic: row.settledInputAtomic!.toString(), outputAtomic: row.settledOutputAtomic!.toString() };
  return result;
}

export class ExecutorService {
  readonly #o: ExecutorOptions;
  readonly #now: () => Date;

  constructor(options: ExecutorOptions) {
    this.#o = options;
    this.#now = options.now ?? (() => new Date());
  }

  #authenticate(authorization: string | undefined): Capability | { failure: Failure } {
    const token = /^Bearer ([A-Za-z0-9_.-]{1,4096})$/.exec(authorization ?? '')?.[1];
    if (!token) return fail(401, 'UNAUTHENTICATED', 'A bearer capability is required.', 'EXECUTOR_CAPABILITY_INVALID');
    try {
      return verifyCapability(token, this.#o.capabilitySecret, Math.floor(this.#now().getTime() / 1000));
    } catch (error) {
      if (error instanceof CapabilityError) return fail(401, 'UNAUTHENTICATED', 'The capability is invalid or expired.', 'EXECUTOR_CAPABILITY_INVALID');
      throw error;
    }
  }

  /** POST /internal/v1/intents. `body` is the raw JSON text (size and content type already enforced). */
  async submit(request: { authorization: string | undefined; idempotencyKey: string | undefined; body: string }): Promise<Reply> {
    // 1. Closed versioned schema.
    const parsed = parse('actionIntent', request.body);
    if (!parsed.ok) {
      const issue = parsed.issues[0]!;
      return { failure: { status: 400, code: issue.code, message: `The intent is not a valid action-intent/1 document (${issue.keyword}).`, fieldPath: issue.fieldPath } };
    }
    const intent = parsed.value;
    // 2–3. Capability: identity comes from here, never from the body.
    const capability = this.#authenticate(request.authorization);
    if ('failure' in capability) return capability;
    if (capability.mode !== 'paper') return fail(403, 'CAPABILITY_DISABLED', 'Live execution is not enabled on this executor.', 'EXECUTOR_PROVIDER_UNAVAILABLE');
    if (!capability.actions.includes(intent.action) || capability.connectors[intent.connectorRef] !== intent.connectorVersion || (capability.runId !== undefined && capability.runId !== intent.runId)) {
      return fail(403, 'FORBIDDEN', 'The capability does not cover this action, connector or run.', 'EXECUTOR_CAPABILITY_INVALID');
    }
    if (request.idempotencyKey !== intent.logicalKey) return fail(400, 'MALFORMED_REQUEST', 'Idempotency-Key must equal the body logicalKey.');
    // 4. Recompute the logical key from authenticated identity.
    const expectedKey = await intentKey({ deploymentId: capability.deploymentId, generation: capability.generation, runId: intent.runId, nodeId: intent.nodeId, iterationPath: intent.iterationPath });
    if (expectedKey !== intent.logicalKey) return fail(409, 'IDEMPOTENCY_CONFLICT', 'The logical key does not match the authenticated identity.', 'EXECUTOR_INTENT_CONFLICT');
    const requestHash = await contentHash(intent);
    // 5. Known logical key: same canonical body returns its current result even if the generation was revoked since.
    const existing = await this.#o.store.findByKey(intent.logicalKey);
    if (existing) return this.#duplicate(existing, requestHash);

    // 6. Current deployment authority.
    let authority: DeploymentAuthority | undefined;
    try {
      authority = await this.#o.authority.current(capability.tenantId, capability.deploymentId);
    } catch {
      return fail(503, 'PROVIDER_UNAVAILABLE', 'Deployment authority is unavailable; nothing was dispatched.', 'EXECUTOR_PROVIDER_UNAVAILABLE');
    }
    if (!authority || authority.tenantId !== capability.tenantId || authority.agentId !== capability.agentId) {
      return fail(403, 'FORBIDDEN', 'The capability does not match a deployment.', 'EXECUTOR_CAPABILITY_INVALID');
    }
    if (authority.mode !== capability.mode) return fail(403, 'FORBIDDEN', 'The capability mode does not match the deployment.', 'EXECUTOR_CAPABILITY_INVALID');
    if (authority.generation !== capability.generation || authority.desiredState === 'stopping' || authority.desiredState === 'stopped') {
      return fail(409, 'GENERATION_REVOKED', 'This deployment generation is no longer authorized.', 'EXECUTOR_STALE_GENERATION');
    }
    if (authority.desiredState !== 'active') return fail(409, 'GENERATION_REVOKED', 'The deployment is paused; no new action starts.', 'EXECUTOR_DEPLOYMENT_INACTIVE');
    if (!authority.simulationAccountId) return fail(503, 'PROVIDER_UNAVAILABLE', 'The paper deployment has no simulation account.', 'EXECUTOR_PROVIDER_UNAVAILABLE');

    // 7–9. Approved immutable strategy: the intent must be one approved swap execution and cannot widen it.
    let strategy;
    try {
      strategy = await this.#o.store.loadStrategy(authority.tenantId, authority.strategyRevisionId);
    } catch {
      return fail(503, 'PROVIDER_UNAVAILABLE', 'The approved strategy is unavailable; nothing was dispatched.', 'EXECUTOR_PROVIDER_UNAVAILABLE');
    }
    if (!strategy) return fail(503, 'PROVIDER_UNAVAILABLE', 'The approved strategy revision is missing.', 'EXECUTOR_PROVIDER_UNAVAILABLE');
    const match = matchApprovedNode(strategy, intent);
    if (!match.ok) return fail(422, 'UNSUPPORTED_CAPABILITY', match.message, 'EXECUTOR_AST_MISMATCH');
    if (authority.connectorPins[intent.connectorRef] !== intent.connectorVersion || intent.tokenInRef === intent.tokenOutRef) {
      return fail(422, 'UNSUPPORTED_CAPABILITY', 'The connector version is not pinned by the deployment.', 'EXECUTOR_CONNECTOR_DISABLED');
    }

    // 10. Fresh context, read outside any transaction.
    let catalog: { connector: boolean; assets: boolean };
    let limits: Record<string, unknown> | undefined;
    let quote: RecordedQuote | undefined;
    try {
      catalog = await this.#o.store.catalogAllows(intent.connectorRef, intent.connectorVersion, intent.action, authority.networkRef, [intent.tokenInRef, intent.tokenOutRef]);
      limits = await this.#o.store.loadPolicyLimits(authority.tenantId, authority.agentId, authority.policyVersion);
      quote = await this.#o.market.quote(intent.tokenInRef, intent.tokenOutRef);
    } catch {
      return fail(503, 'PROVIDER_UNAVAILABLE', 'Required market or policy context is unavailable; nothing was dispatched.', 'EXECUTOR_PROVIDER_UNAVAILABLE');
    }
    const limitSources: ActionLimits[] = [this.#o.platformLimits, policyLimits(limits, intent.tokenInRef), { maxSlippageBps: match.node.maxSlippageBps }];
    const action: FrozenAction = { connectorRef: intent.connectorRef, connectorVersion: intent.connectorVersion, tokenInRef: intent.tokenInRef, tokenOutRef: intent.tokenOutRef, maxSlippageBps: intent.maxSlippageBps };
    const now = this.#now();

    // 11–13. Pure policy and atomic admission under the account lock, committed before any dispatch.
    const outcome = await this.#o.store.admit(
      {
        intentId: uuidv7(now.getTime()), tenantId: authority.tenantId, agentId: authority.agentId, deploymentId: authority.deploymentId,
        generation: authority.generation, simulationAccountId: authority.simulationAccountId, runId: intent.runId, nodeId: intent.nodeId,
        iterationPath: intent.iterationPath, logicalKey: intent.logicalKey, requestHash, request: intent, action,
        maxIntentsPerRun: strategy.limits.maxIntentsPerRun, now,
      },
      async (snapshot) => {
        // positionBps resolves once against available inventory and is frozen.
        const resolved = intent.amount.kind === 'fixed' ? BigInt(intent.amount.atomic) : (snapshot.availableInputAtomic * BigInt(intent.amount.bps)) / 10_000n;
        const context: ActionContext = {
          mode: 'paper', deploymentActive: true, connectorEnabled: catalog.connector, assetsAllowed: catalog.assets,
          requestedSlippageBps: intent.maxSlippageBps, limits: limitSources, resolvedInputAtomic: resolved,
          availableInputAtomic: snapshot.availableInputAtomic, actionsInWindow: snapshot.actionsInWindow,
          valuation: quote && { observedAtMillis: Date.parse(quote.observedAt), maxAgeSeconds: this.#o.maxQuoteAgeSeconds }, nowMillis: now.getTime(),
        };
        const verdict = evaluateAction(context);
        const contextHash = await contentHash(jsonSafe({ phase: 'admission', logicalKey: intent.logicalKey, generation: authority.generation, branchGated: match.branchGated, quote, context }));
        return { resolvedInputAtomic: resolved, verdict, contextHash };
      },
    );
    if (outcome.kind === 'noAccount') return fail(503, 'PROVIDER_UNAVAILABLE', 'The simulation account does not belong to this agent.', 'EXECUTOR_PROVIDER_UNAVAILABLE');
    if (outcome.kind === 'runLimit') return fail(422, 'UNSUPPORTED_CAPABILITY', 'The run already holds its maximum number of intents.', 'EXECUTOR_AST_MISMATCH');
    if (outcome.kind === 'existing') return this.#duplicate(outcome.row, requestHash);

    // 14. Paper dispatch. A failure here leaves the intent reserved for reconcile(); the admission stands.
    let row = outcome.row;
    if (row.state === 'reserved' && (this.#o.dispatchInline ?? true)) {
      try {
        row = await this.dispatch(row.id);
      } catch {
        row = (await this.#o.store.findById(row.id)) ?? row;
      }
    }
    return { status: 201, result: toResult(row) };
  }

  #duplicate(row: IntentRow, requestHash: string): Reply {
    if (row.requestHash !== requestHash) return fail(409, 'IDEMPOTENCY_CONFLICT', 'The same logical key was presented with a different body.', 'EXECUTOR_INTENT_CONFLICT');
    return { status: TERMINAL_STATES.has(row.state) ? 200 : 202, result: toResult(row) };
  }

  /** GET /internal/v1/intents/{intentId}: same tenant, agent, deployment generation and (if scoped) run only. */
  async status(authorization: string | undefined, intentId: string): Promise<Reply> {
    const capability = this.#authenticate(authorization);
    if ('failure' in capability) return capability;
    const notFound = fail(404, 'NOT_FOUND', 'No such intent for this capability.');
    if (!UUIDV7.test(intentId)) return notFound;
    const row = await this.#o.store.findById(intentId);
    if (!row || row.tenantId !== capability.tenantId || row.agentId !== capability.agentId || row.deploymentId !== capability.deploymentId
      || row.generation !== capability.generation || (capability.runId !== undefined && row.runId !== capability.runId)) return notFound;
    return { status: 200, result: toResult(row) };
  }

  /**
   * Fill one reserved paper intent. Rechecks revocable authority first; a pause or redeploy before the fill
   * cancels and releases the hold. Unavailable authority or market data leaves it reserved for a later attempt.
   */
  async dispatch(intentId: string): Promise<IntentRow> {
    const row = await this.#o.store.findById(intentId);
    if (!row) throw new Error('intent not found');
    if (row.state !== 'reserved') return row;
    let authority: DeploymentAuthority | undefined;
    try {
      authority = await this.#o.authority.current(row.tenantId, row.deploymentId);
    } catch {
      return row;
    }
    if (!authority || authority.generation !== row.generation || authority.desiredState === 'stopping' || authority.desiredState === 'stopped') {
      return this.#o.store.release(row.id, 'cancelled', { code: 'EXECUTOR_STALE_GENERATION', message: 'The deployment generation changed before the fill.' }, undefined, undefined, this.#now());
    }
    if (authority.desiredState !== 'active') {
      return this.#o.store.release(row.id, 'cancelled', { code: 'EXECUTOR_DEPLOYMENT_INACTIVE', message: 'The deployment was paused before the fill.' }, undefined, undefined, this.#now());
    }
    let quote: RecordedQuote | undefined;
    let catalog: { connector: boolean; assets: boolean };
    let limits: Record<string, unknown> | undefined;
    try {
      quote = await this.#o.market.quote(row.action.tokenInRef, row.action.tokenOutRef);
      catalog = await this.#o.store.catalogAllows(row.action.connectorRef, row.action.connectorVersion, SUPPORTED_ACTION, authority.networkRef, [row.action.tokenInRef, row.action.tokenOutRef]);
      limits = await this.#o.store.loadPolicyLimits(authority.tenantId, authority.agentId, authority.policyVersion);
    } catch {
      return row;
    }
    // Read the clock after the quote: a quote observed after `now` would count as future-dated.
    const now = this.#now();
    const input = row.inputAtomic!;
    // The hold already covers the input and already counts in the daily window.
    const verdict: Verdict = evaluateAction({
      mode: 'paper', deploymentActive: true, connectorEnabled: catalog.connector, assetsAllowed: catalog.assets,
      requestedSlippageBps: row.action.maxSlippageBps, limits: [this.#o.platformLimits, policyLimits(limits, row.action.tokenInRef)],
      resolvedInputAtomic: input, availableInputAtomic: input, actionsInWindow: 0,
      valuation: quote && { observedAtMillis: Date.parse(quote.observedAt), maxAgeSeconds: this.#o.maxQuoteAgeSeconds }, nowMillis: now.getTime(),
    });
    const contextHash = await contentHash(jsonSafe({ phase: 'dispatch', logicalKey: row.logicalKey, generation: authority.generation, quote, verdict }));
    if (!verdict.allow) return this.#o.store.release(row.id, 'cancelled', verdict.denials[0], verdict, contextHash, now);
    const fill = computeFill(input, quote!, row.action.maxSlippageBps);
    if (!fill.ok) return this.#o.store.release(row.id, 'failed', { code: fill.code, message: fill.message }, verdict, contextHash, now);
    return this.#o.store.settle(row.id, {
      paperFillId: await paperFillId(row.logicalKey), adapterVersion: PAPER_ADAPTER_VERSION, outputAtomic: fill.outputAtomic, verdict, contextHash, now,
      basis: jsonSafe({ quote, assumptions: PAPER_ASSUMPTIONS, minimumOutputAtomic: fill.minimumOutputAtomic }),
    });
  }

  /** Restart/periodic recovery: finish every reserved paper intent. Returns how many reached a terminal state. */
  async reconcile(): Promise<number> {
    let finished = 0;
    for (const row of await this.#o.store.reservedIntents()) {
      if (TERMINAL_STATES.has((await this.dispatch(row.id)).state)) finished += 1;
    }
    return finished;
  }
}
