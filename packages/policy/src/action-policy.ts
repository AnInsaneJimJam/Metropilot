// Pure action authorization (docs/specs/executor.md section 6). The executor assembles the complete immutable
// context and enforces the verdict; this module never reads providers, the clock or the database. Missing or
// stale required context denies. Limits from every source combine by the most restrictive value.
// Version 2 adds the live context blocks (POL-2..POL-4): in live mode every block is required and a missing one
// denies; in paper mode a block is checked when the executor supplies it, so paper behaviour is unchanged.
import type { IntentReason } from '@monad-hack/contracts';

export const ACTION_POLICY_VERSION = 'action-policy/2';

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
  /** Committed plus pending notional per UTC day, integer micro-USD. */
  readonly dailyNotionalUsdMicros?: bigint;
  /** Oldest acceptable executable quote. */
  readonly maxQuoteAgeSeconds?: number;
  /** Largest gap between the quote's expected output and the reference valuation. */
  readonly maxReferenceDeviationBps?: number;
  /** Largest native fee ceiling for one action, approvals included. */
  readonly maxGasAtomic?: bigint;
  /** Native balance that must remain after the fee ceiling; combines by the largest value. */
  readonly minNativeReserveAtomic?: bigint;
  /** Largest token approval; approvals are exact-amount, never unlimited. */
  readonly maxApprovalAtomic?: bigint;
  /** Approved recipients and spenders (lower-case addresses); combine by intersection. */
  readonly allowedRecipients?: readonly string[];
  readonly allowedSpenders?: readonly string[];
  /** Chains the action may run on; combine by intersection. */
  readonly allowedChainIds?: readonly number[];
}

/** Authenticated workload identity against the current deployment record (POL-2). */
export interface IdentityContext {
  readonly capabilityTenantId: string;
  readonly capabilityAgentId: string;
  readonly capabilityDeploymentId: string;
  readonly capabilityGeneration: string;
  readonly tenantId: string;
  readonly agentId: string;
  readonly deploymentId: string;
  /** Generation currently authorized by the control plane. */
  readonly currentGeneration: string;
  /** Agent that owns the wallet (live) or simulation account (paper) the action spends from. */
  readonly fundingOwnerAgentId: string;
}

export interface ChainContext {
  readonly chainId: number;
  /** Recipient the transaction pays out to; must be the agent's own wallet. */
  readonly recipient: string;
  readonly agentWallet: string;
}

export interface QuoteContext {
  readonly quotedAtMillis: number;
  readonly expiresAtMillis: number;
  readonly inputAtomic: bigint;
  readonly expectedOutputAtomic: bigint;
  readonly minOutputAtomic: bigint;
  /** Output implied by the reference valuation for the same input; undefined means none. */
  readonly referenceOutputAtomic: bigint | undefined;
}

export interface GasContext {
  readonly ceilingAtomic: bigint;
  /** Native balance available to this agent, active holds excluded. */
  readonly availableNativeAtomic: bigint;
}

export interface AllowanceContext {
  readonly required: boolean;
  readonly spender?: string;
  readonly approvalAtomic?: bigint;
  readonly unlimited?: boolean;
  /** Permit/off-chain signature approvals are not supported. */
  readonly permit?: boolean;
}

export interface NotionalContext {
  readonly notionalUsdMicros: bigint;
  /** Committed plus pending notional already in the window, excluding this action. */
  readonly windowNotionalUsdMicros: bigint;
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
  readonly identity?: IdentityContext;
  readonly chain?: ChainContext;
  readonly quote?: QuoteContext;
  readonly gas?: GasContext;
  readonly allowance?: AllowanceContext;
  readonly notional?: NotionalContext;
  /** Prerequisite/branch evidence was verified against persisted broker results (D36: required in live). */
  readonly branchEvidenceVerified?: boolean;
  /** Wallet provider and kill switches allow signing now. */
  readonly signerReady?: boolean;
  /** An unknown effect or balance discrepancy is open for this agent. */
  readonly reconciliationOpen?: boolean;
}

export type Verdict =
  | { readonly allow: true; readonly policyVersion: string }
  | { readonly allow: false; readonly policyVersion: string; readonly denials: readonly [Denial, ...Denial[]] };

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** Most restrictive combination; a field stays undefined only when no source sets it. */
export function combineLimits(sources: readonly ActionLimits[]): ActionLimits {
  const pick = <T extends number | bigint>(values: (T | undefined)[], better: (a: T, b: T) => boolean): T | undefined =>
    values.reduce<T | undefined>((acc, v) => (v === undefined ? acc : acc === undefined || better(v, acc) ? v : acc), undefined);
  const min = <T extends number | bigint>(values: (T | undefined)[]) => pick(values, (a, b) => a < b);
  const intersect = <T>(lists: (readonly T[] | undefined)[]): readonly T[] | undefined =>
    lists.reduce<readonly T[] | undefined>((acc, list) => (list === undefined ? acc : acc === undefined ? [...list] : acc.filter((x) => list.includes(x))), undefined);
  const combined: Mutable<ActionLimits> = {};
  const set = <K extends keyof ActionLimits>(key: K, value: ActionLimits[K] | undefined): void => {
    if (value !== undefined) combined[key] = value;
  };
  set('maxSlippageBps', min(sources.map((s) => s.maxSlippageBps)));
  set('maxInputAtomic', min(sources.map((s) => s.maxInputAtomic)));
  set('dailyActionCount', min(sources.map((s) => s.dailyActionCount)));
  set('dailyNotionalUsdMicros', min(sources.map((s) => s.dailyNotionalUsdMicros)));
  set('maxQuoteAgeSeconds', min(sources.map((s) => s.maxQuoteAgeSeconds)));
  set('maxReferenceDeviationBps', min(sources.map((s) => s.maxReferenceDeviationBps)));
  set('maxGasAtomic', min(sources.map((s) => s.maxGasAtomic)));
  set('maxApprovalAtomic', min(sources.map((s) => s.maxApprovalAtomic)));
  set('minNativeReserveAtomic', pick(sources.map((s) => s.minNativeReserveAtomic), (a, b) => a > b));
  set('allowedRecipients', intersect(sources.map((s) => s.allowedRecipients?.map((a) => a.toLowerCase()))));
  set('allowedSpenders', intersect(sources.map((s) => s.allowedSpenders?.map((a) => a.toLowerCase()))));
  set('allowedChainIds', intersect(sources.map((s) => s.allowedChainIds)));
  return combined;
}

/** A later phase adds context and its own denials; it never erases an earlier denial. */
export function mergeVerdicts(earlier: Verdict, later: Verdict): Verdict {
  const denials = [...(earlier.allow ? [] : earlier.denials), ...(later.allow ? [] : later.denials)];
  const unique = denials.filter((d, i) => denials.findIndex((e) => e.code === d.code && e.message === d.message) === i);
  const [first, ...rest] = unique;
  return first ? { allow: false, policyVersion: later.policyVersion, denials: [first, ...rest] } : { allow: true, policyVersion: later.policyVersion };
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

  const live = context.mode === 'live';
  if (context.reconciliationOpen) deny('EXECUTOR_RECONCILIATION_REQUIRED', 'An unresolved effect or balance difference blocks new actions.');

  // POL-2: ownership, generation and funding identity.
  const id = context.identity;
  if (!id) {
    if (live) deny('EXECUTOR_CAPABILITY_INVALID', 'The workload identity is missing.');
  } else {
    if (id.capabilityTenantId !== id.tenantId || id.capabilityAgentId !== id.agentId || id.capabilityDeploymentId !== id.deploymentId || id.fundingOwnerAgentId !== id.agentId) {
      deny('EXECUTOR_CAPABILITY_INVALID', 'The capability does not own this deployment or its funds.');
    }
    if (id.capabilityGeneration !== id.currentGeneration) deny('EXECUTOR_STALE_GENERATION', 'The deployment generation is no longer authorized.');
  }
  if (live && context.branchEvidenceVerified !== true) deny('EXECUTOR_AST_MISMATCH', 'Branch evidence for this action is not verified.');
  if (live && context.signerReady !== true) deny('EXECUTOR_PROVIDER_UNAVAILABLE', 'The wallet provider is not ready to sign.');

  // POL-2: chain and recipient. The strategy never names a recipient: the payout goes to the agent wallet.
  const chain = context.chain;
  if (!chain) {
    if (live) deny('EXECUTOR_ASSET_NOT_ALLOWED', 'The chain and recipient are not known.');
  } else {
    if (limits.allowedChainIds === undefined ? live : !limits.allowedChainIds.includes(chain.chainId)) deny('EXECUTOR_ASSET_NOT_ALLOWED', 'The chain is not approved.');
    const recipient = chain.recipient.toLowerCase();
    if (recipient !== chain.agentWallet.toLowerCase() || (limits.allowedRecipients !== undefined && !limits.allowedRecipients.includes(recipient))) {
      deny('EXECUTOR_ASSET_NOT_ALLOWED', 'The recipient is not the agent wallet.');
    }
  }

  // POL-3: quote freshness, consistency, computed slippage and reference deviation.
  const quote = context.quote;
  if (!quote) {
    if (live) deny('EXECUTOR_QUOTE_INVALID', 'No executable quote is available.');
  } else {
    const maxAge = limits.maxQuoteAgeSeconds;
    if (maxAge === undefined || quote.quotedAtMillis > context.nowMillis || context.nowMillis - quote.quotedAtMillis > maxAge * 1000 || context.nowMillis >= quote.expiresAtMillis) {
      deny('EXECUTOR_QUOTE_INVALID', 'The quote is stale or expired.');
    }
    if (quote.inputAtomic !== context.resolvedInputAtomic || quote.expectedOutputAtomic <= 0n || quote.minOutputAtomic <= 0n || quote.minOutputAtomic > quote.expectedOutputAtomic) {
      deny('EXECUTOR_QUOTE_INVALID', 'The quote does not match the frozen intent.');
    } else if (limits.maxSlippageBps !== undefined && (quote.expectedOutputAtomic - quote.minOutputAtomic) * 10_000n > BigInt(limits.maxSlippageBps) * quote.expectedOutputAtomic) {
      deny('EXECUTOR_SLIPPAGE_EXCEEDED', 'The quote minimum output allows more slippage than approved.');
    }
    const reference = quote.referenceOutputAtomic;
    const maxDev = limits.maxReferenceDeviationBps;
    if (reference === undefined || reference <= 0n || maxDev === undefined) {
      deny('EXECUTOR_QUOTE_INVALID', 'No reference valuation bounds this quote.');
    } else {
      const gap = quote.expectedOutputAtomic > reference ? quote.expectedOutputAtomic - reference : reference - quote.expectedOutputAtomic;
      if (gap * 10_000n > BigInt(maxDev) * reference) deny('EXECUTOR_QUOTE_INVALID', 'The quote deviates too far from the reference price.');
    }
  }

  // POL-3: gas ceiling and native reserve.
  const gas = context.gas;
  if (!gas) {
    if (live) deny('EXECUTOR_GAS_LIMIT_EXCEEDED', 'The fee ceiling is not known.');
  } else {
    if (gas.ceilingAtomic <= 0n || limits.maxGasAtomic === undefined || gas.ceilingAtomic > limits.maxGasAtomic) deny('EXECUTOR_GAS_LIMIT_EXCEEDED', 'The fee ceiling is above the approved limit.');
    if (gas.availableNativeAtomic - gas.ceilingAtomic < (limits.minNativeReserveAtomic ?? 0n)) deny('EXECUTOR_NATIVE_RESERVE_LOW', 'Paying this fee would break the native gas reserve.');
  }

  // POL-3: approvals are exact-amount, to an approved spender, never unlimited or permit-based.
  const allowance = context.allowance;
  if (!allowance) {
    if (live) deny('EXECUTOR_ALLOWANCE_UNSAFE', 'The approval requirement is not known.');
  } else if (allowance.required) {
    const spender = allowance.spender?.toLowerCase();
    const amount = allowance.approvalAtomic;
    if (!spender || limits.allowedSpenders === undefined || !limits.allowedSpenders.includes(spender)) deny('EXECUTOR_ALLOWANCE_UNSAFE', 'The spender is not approved.');
    if (allowance.unlimited || allowance.permit || amount === undefined || amount > context.resolvedInputAtomic || (limits.maxApprovalAtomic !== undefined && amount > limits.maxApprovalAtomic)) {
      deny('EXECUTOR_ALLOWANCE_UNSAFE', 'Only an exact-amount approval is allowed.');
    }
  }

  // POL-4: notional window, pending holds included.
  const notional = context.notional;
  if (!notional) {
    if (live) deny('EXECUTOR_DAILY_LIMIT_EXCEEDED', 'The daily notional usage is not known.');
  } else if (notional.notionalUsdMicros < 0n || (limits.dailyNotionalUsdMicros === undefined ? live : notional.windowNotionalUsdMicros + notional.notionalUsdMicros > limits.dailyNotionalUsdMicros)) {
    deny('EXECUTOR_DAILY_LIMIT_EXCEEDED', 'The daily notional limit is reached.');
  }
  if (live && limits.maxInputAtomic === undefined) deny('EXECUTOR_AMOUNT_EXCEEDED', 'A live action needs a per-action input limit.');

  const [first, ...rest] = denials;
  return first ? { allow: false, policyVersion: ACTION_POLICY_VERSION, denials: [first, ...rest] } : { allow: true, policyVersion: ACTION_POLICY_VERSION };
}
