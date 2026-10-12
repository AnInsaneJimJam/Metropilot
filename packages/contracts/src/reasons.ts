// User-facing failure-reason vocabulary (API-6, issue #19). Every code a user can meet on a blocked action,
// a failed or revoked run, a denied paper trade or a refused request maps to readable text here. The key set is
// the error-1 codes plus the intent-result-1 reason codes plus control-plane codes that are not errors, so a
// new schema code without an entry fails typechecking. Wording is product copy, reviewed with the PR; it never
// includes amounts, prompts or provider text, which stay in the event's own redacted fields.
import type { ErrorCode, IntentReason } from './generated-contracts.ts';

/** Codes emitted only as reasons, never as error-1 codes. */
export type ControlReasonCode = 'TRIGGER_COOLDOWN';
export type UserReasonCode = ErrorCode | IntentReason['code'] | ControlReasonCode;

export interface ReasonText {
  /** A short label, a few words. */
  readonly title: string;
  /** What happened, in one sentence. */
  readonly explanation: string;
  /** What the user can do about it, in one sentence. */
  readonly userAction: string;
}

const RETRY = 'Try again; if it keeps happening, the platform is having trouble.';
const EDIT = 'Change the strategy in the editor, save it and launch the new revision.';
const NONE = 'Nothing to do; the next trigger starts a new run.';

export const reasons: Readonly<Record<UserReasonCode, ReasonText>> = {
  // error-1 codes
  UNAUTHENTICATED: { title: 'Signed out', explanation: 'Your session has ended or was never started.', userAction: 'Sign in again.' },
  FORBIDDEN: { title: 'Not allowed', explanation: 'This request is not allowed from here.', userAction: 'Reload the page from the app address and try again.' },
  NOT_FOUND: { title: 'Not found', explanation: 'The item does not exist or belongs to another account.', userAction: 'Reload the page; it may have been removed.' },
  MALFORMED_REQUEST: { title: 'Bad request', explanation: 'The request was not in the expected format.', userAction: 'Reload the page and try again.' },
  REVISION_CONFLICT: { title: 'Edited elsewhere', explanation: 'A newer revision was saved since you opened this one.', userAction: 'Reload the strategy, then reapply your change.' },
  IDEMPOTENCY_CONFLICT: { title: 'Request reused', explanation: 'A retried request did not match the original, so it was refused.', userAction: 'Start the action again.' },
  SCHEMA_INVALID: { title: 'Invalid strategy', explanation: 'The strategy or request does not match the required format.', userAction: EDIT },
  CAPABILITY_DISABLED: { title: 'Feature turned off', explanation: 'This feature is turned off on this server.', userAction: 'Use paper mode, or wait until the feature is enabled.' },
  ESTIMATE_EXPIRED: { title: 'Estimate expired', explanation: 'The cost estimate is too old to launch with.', userAction: 'Launch again; a fresh estimate is made.' },
  FUNDING_PENDING: { title: 'Funding pending', explanation: 'The budget is not funded yet.', userAction: 'Wait for the deposit to confirm, then launch.' },
  INSUFFICIENT_BUDGET: { title: 'Budget too small', explanation: 'The budget does not cover this action.', userAction: 'Raise the budget or lower the trade amount.' },
  POLICY_DENIED: { title: 'Blocked by a rule', explanation: 'A safety rule or a refused step stopped this action.', userAction: 'Check the limits in your policy and the strategy step named here.' },
  STALE_OBSERVATION: { title: 'Price too old', explanation: 'The market price was too old to act on.', userAction: NONE },
  RATE_LIMITED: { title: 'Too many requests', explanation: 'Too many requests were sent in a short time.', userAction: 'Wait a minute and try again.' },
  PROVIDER_UNAVAILABLE: { title: 'Service unavailable', explanation: 'A service this action depends on did not respond.', userAction: RETRY },
  INTERNAL_ERROR: { title: 'Platform error', explanation: 'Something went wrong on the platform.', userAction: RETRY },
  RECONCILIATION_REQUIRED: { title: 'Checking the outcome', explanation: 'The result of an earlier action is still being confirmed.', userAction: 'Wait; the agent continues once the outcome is known.' },
  UNKNOWN_BLOCK: { title: 'Unknown block', explanation: 'The strategy uses a block this server does not know.', userAction: EDIT },
  TYPE_MISMATCH: { title: 'Values do not fit', explanation: 'Two values in the strategy cannot be combined or compared.', userAction: EDIT },
  UNKNOWN_REFERENCE: { title: 'Unknown reference', explanation: 'The strategy names something that is not in the catalog.', userAction: EDIT },
  UNSUPPORTED_CAPABILITY: { title: 'Not supported', explanation: 'The connector, model or version is not available for this mode.', userAction: 'Pick a supported option in the editor, or wait until it is enabled again.' },
  LIMIT_EXCEEDED: { title: 'Limit reached', explanation: 'A size, step, time or call limit was reached.', userAction: 'Simplify the strategy or lower its limits.' },
  STALE_DATA: { title: 'Data too old', explanation: 'The data was too old or missing, so the step did not act on it.', userAction: NONE },
  INVALID_AMOUNT: { title: 'Invalid amount', explanation: 'A trade amount was zero, negative or too large.', userAction: EDIT },
  MODEL_OUTPUT_INVALID: { title: 'Unusable AI answer', explanation: 'The AI answer did not match the expected format, so it was ignored.', userAction: NONE },
  MODEL_UNAVAILABLE: { title: 'AI unavailable', explanation: 'The AI model did not answer in time.', userAction: NONE },
  BUDGET_EXHAUSTED: { title: 'Budget used up', explanation: 'The budget for this kind of spending is used up.', userAction: 'Add budget or wait for the next period.' },
  EFFECT_PENDING: { title: 'Result pending', explanation: 'An earlier action has not finished yet.', userAction: 'Wait; the run continues when it finishes.' },
  LEASE_FENCED: { title: 'Taken over', explanation: 'Another worker took over this run, so this attempt stopped.', userAction: 'Nothing to do; the run continues on the other worker.' },
  GENERATION_REVOKED: { title: 'Agent paused or stopped', explanation: 'The agent was paused, stopped or relaunched before this finished.', userAction: 'Resume or launch the agent to continue.' },
  CURSOR_EXPIRED: { title: 'Older activity removed', explanation: 'Activity older than the retention period was removed.', userAction: 'Nothing to do; activity is shown from the oldest kept event.' },
  // intent-result-1 reason codes (the executor)
  EXECUTOR_CAPABILITY_INVALID: { title: 'Trade not authorized', explanation: 'The trade request did not carry a valid authorization.', userAction: NONE },
  EXECUTOR_STALE_GENERATION: { title: 'Agent changed', explanation: 'The agent was paused, resumed or relaunched since this trade was asked for.', userAction: NONE },
  EXECUTOR_DEPLOYMENT_INACTIVE: { title: 'Agent not running', explanation: 'The agent is paused or stopped, so no new trade starts.', userAction: 'Resume the agent to trade again.' },
  EXECUTOR_INTENT_CONFLICT: { title: 'Duplicate trade', explanation: 'A different trade was already recorded for this step.', userAction: NONE },
  EXECUTOR_AST_MISMATCH: { title: 'Trade not in strategy', explanation: 'The trade does not match the launched strategy.', userAction: 'Launch the strategy again.' },
  EXECUTOR_CONNECTOR_DISABLED: { title: 'Venue turned off', explanation: 'The connector or action is not enabled for this agent.', userAction: 'Pick an enabled connector and launch again.' },
  EXECUTOR_ASSET_NOT_ALLOWED: { title: 'Token not allowed', explanation: 'The token pair is not approved for this agent.', userAction: 'Pick an approved token pair.' },
  EXECUTOR_AMOUNT_EXCEEDED: { title: 'Amount not allowed', explanation: 'The amount was zero, above your per-trade limit or above the balance.', userAction: 'Lower the trade amount or raise the limit.' },
  EXECUTOR_DAILY_LIMIT_EXCEEDED: { title: 'Daily trade limit', explanation: 'The daily number of trades is reached.', userAction: 'Wait until tomorrow (UTC) or raise the daily limit.' },
  EXECUTOR_NATIVE_RESERVE_LOW: { title: 'Gas reserve low', explanation: 'Too little native MON is left to pay for gas.', userAction: 'Add MON to the reserve.' },
  EXECUTOR_STALE_OBSERVATION: { title: 'No recent price', explanation: 'No recent market price was available to value the trade.', userAction: NONE },
  EXECUTOR_QUOTE_INVALID: { title: 'Bad quote', explanation: 'The trade quote could not be used.', userAction: NONE },
  EXECUTOR_SLIPPAGE_EXCEEDED: { title: 'Slippage too high', explanation: 'The requested slippage is above the approved limit.', userAction: 'Lower the slippage in the strategy or raise the policy limit.' },
  EXECUTOR_GAS_LIMIT_EXCEEDED: { title: 'Gas too high', explanation: 'The trade would cost more gas than allowed.', userAction: NONE },
  EXECUTOR_ALLOWANCE_UNSAFE: { title: 'Unsafe approval', explanation: 'The token approval needed for this trade is not safe.', userAction: NONE },
  EXECUTOR_SIMULATION_FAILED: { title: 'Trade would fail', explanation: 'A test run of the trade failed, so it was not sent.', userAction: NONE },
  EXECUTOR_INSUFFICIENT_BUDGET: { title: 'Budget too small', explanation: 'The trading budget does not cover this trade.', userAction: 'Add budget or lower the trade amount.' },
  EXECUTOR_RECONCILIATION_REQUIRED: { title: 'Checking the outcome', explanation: 'The trade result is still being confirmed.', userAction: 'Wait; no new trade starts until it is known.' },
  EXECUTOR_PROVIDER_UNAVAILABLE: { title: 'Trading unavailable', explanation: 'The trading service did not respond.', userAction: NONE },
  // control-plane reasons
  TRIGGER_COOLDOWN: { title: 'Cooling down', explanation: 'The price crossed again during the trigger cooldown, so no run started.', userAction: 'Shorten the cooldown if you want more frequent runs.' },
};

export interface DescribedReason extends ReasonText {
  readonly code: string;
  /** False for a code outside the vocabulary (an older or newer server); the generic text is used. */
  readonly known: boolean;
}

/** Readable text for any reason code; an unknown code still gets a sentence and keeps its code. */
export function describeReason(code: string): DescribedReason {
  if (Object.hasOwn(reasons, code)) return { code, known: true, ...reasons[code as UserReasonCode] };
  return { code, known: false, title: 'Stopped', explanation: 'This step was stopped for a reason this page does not recognise.', userAction: 'Reload the page; if it persists, report the code shown.' };
}
