// Pure action authorization (docs/specs/executor.md section 6). The executor assembles the complete immutable
// context and enforces the verdict; this module never reads providers, the clock or the database. Missing or
// stale required context denies. Limits from every source combine by the most restrictive value.
import type { IntentReason } from '@monad-hack/contracts';

export const ACTION_POLICY_VERSION = 'action-policy/1';

export type ReasonCode = IntentReason['code'];

export interface Denial {
  readonly code: ReasonCode;
  /** Safe, user-presentable text: no amounts from provider payloads, prompts or secrets. */
  readonly message: string;
}

/** One limit source (platform, user policy, strategy node, connector). Absent fields do not constrain. */
export interface ActionLimits {
  readonly maxSlippageBps?: number;
  readonly maxInputAtomic?: bigint;
  /** Committed plus pending actions per agent per UTC day. */
  readonly dailyActionCount?: number;
}

export interface Valuation {
  readonly observedAtMillis: number;
  readonly maxAgeSeconds: number;
}

export interface ActionContext {
  readonly mode: 'paper' | 'live';
  /** Current desired state allows a new financial effect for this generation. */
  readonly deploymentActive: boolean;
  /** Connector version is pinned, enabled for this mode and offers the action. */
  readonly connectorEnabled: boolean;
  /** Both assets resolve in the pinned catalog for this mode and network. */
  readonly assetsAllowed: boolean;
  readonly requestedSlippageBps: number;
  readonly limits: readonly ActionLimits[];
  /** Frozen atomic input after resolving the amount rule. */
  readonly resolvedInputAtomic: bigint;
  /** Available trading inventory of the input asset, excluding active holds. */
  readonly availableInputAtomic: bigint;
  /** Actions already counted in the current UTC day, pending holds included, excluding this one. */
  readonly actionsInWindow: number;
  /** Reference valuation/quote used to value or fill the action; undefined means none was found. */
  readonly valuation: Valuation | undefined;
  readonly nowMillis: number;
}

export type Verdict =
  | { readonly allow: true; readonly policyVersion: string }
  | { readonly allow: false; readonly policyVersion: string; readonly denials: readonly [Denial, ...Denial[]] };

/** Most restrictive combination; a field stays undefined only when no source sets it. */
export function combineLimits(sources: readonly ActionLimits[]): ActionLimits {
  const min = <T extends number | bigint>(values: (T | undefined)[]): T | undefined =>
    values.reduce<T | undefined>((acc, v) => (v === undefined ? acc : acc === undefined || v < acc ? v : acc), undefined);
  const combined: { -readonly [K in keyof ActionLimits]: ActionLimits[K] } = {};
  const slippage = min(sources.map((s) => s.maxSlippageBps));
  const input = min(sources.map((s) => s.maxInputAtomic));
  const daily = min(sources.map((s) => s.dailyActionCount));
  if (slippage !== undefined) combined.maxSlippageBps = slippage;
  if (input !== undefined) combined.maxInputAtomic = input;
  if (daily !== undefined) combined.dailyActionCount = daily;
  return combined;
}

export function evaluateAction(context: ActionContext): Verdict {
  const denials: Denial[] = [];
  const deny = (code: ReasonCode, message: string): void => {
    denials.push({ code, message });
  };
  const limits = combineLimits(context.limits);

  if (!context.deploymentActive) deny('EXECUTOR_DEPLOYMENT_INACTIVE', 'The deployment is paused or stopped, so no new action starts.');
  if (!context.connectorEnabled) deny('EXECUTOR_CONNECTOR_DISABLED', 'The connector or action is not enabled for this deployment.');
  if (!context.assetsAllowed) deny('EXECUTOR_ASSET_NOT_ALLOWED', 'The token pair is not approved for this deployment.');
  // A slippage limit is required: without one the minimum output is unbounded.
  if (limits.maxSlippageBps === undefined || context.requestedSlippageBps > limits.maxSlippageBps) {
    deny('EXECUTOR_SLIPPAGE_EXCEEDED', 'The requested slippage is above the approved limit.');
  }
  if (context.resolvedInputAtomic <= 0n) deny('EXECUTOR_AMOUNT_EXCEEDED', 'The resolved input amount is zero.');
  else if (limits.maxInputAtomic !== undefined && context.resolvedInputAtomic > limits.maxInputAtomic) {
    deny('EXECUTOR_AMOUNT_EXCEEDED', 'The input amount is above the approved per-action limit.');
  } else if (context.resolvedInputAtomic > context.availableInputAtomic) {
    deny('EXECUTOR_AMOUNT_EXCEEDED', 'The available balance is below the requested input.');
  }
  if (limits.dailyActionCount === undefined || context.actionsInWindow + 1 > limits.dailyActionCount) {
    deny('EXECUTOR_DAILY_LIMIT_EXCEEDED', 'The daily action limit is reached.');
  }
  const valuation = context.valuation;
  if (!valuation) deny('EXECUTOR_STALE_OBSERVATION', 'No recorded market price is available for this pair.');
  else if (valuation.observedAtMillis > context.nowMillis || context.nowMillis - valuation.observedAtMillis > valuation.maxAgeSeconds * 1000) {
    deny('EXECUTOR_STALE_OBSERVATION', 'The recorded market price is too old.');
  }

  const [first, ...rest] = denials;
  return first ? { allow: false, policyVersion: ACTION_POLICY_VERSION, denials: [first, ...rest] } : { allow: true, policyVersion: ACTION_POLICY_VERSION };
}
