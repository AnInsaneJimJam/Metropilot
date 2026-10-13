// Posting builders for the financial operations in funds-and-budgets.md section 2 (ACC-5). Pure: they return
// balanced postings for postJournal or settle, and never decide whether an effect happened.
import { platformExpense, revenue, treasury, user, wallet } from './accounts.ts';
import type { AgentScope, Mode, RevenueLine } from './accounts.ts';
import { invalid } from './errors.ts';
import type { PostingInput } from './ledger.ts';

const positive = (amount: bigint, what: string): void => {
  if (amount <= 0n) invalid(`${what} must be positive.`);
};

/** Finalized deposit: wallet asset up, user unallocated liability up. */
export function depositPostings(scope: AgentScope, assetRef: string, amount: bigint): PostingInput[] {
  positive(amount, 'Deposit');
  return [
    { account: wallet(scope, assetRef), side: 'debit', amount },
    { account: user(scope, 'unallocated', assetRef), side: 'credit', amount },
  ];
}

export interface SwapEffect {
  readonly assetIn: string;
  readonly amountIn: bigint;
  readonly assetOut: string;
  /** Actual observed output; zero for a reverted swap. */
  readonly amountOut: bigint;
  /** Native gas actually consumed, charged even when the swap reverted. */
  readonly gasAsset: string;
  readonly gasUsed: bigint;
}

/** A finalized swap posts observed asset changes per asset; a revert posts gas only. */
export function swapPostings(scope: AgentScope, effect: SwapEffect): PostingInput[] {
  const postings: PostingInput[] = [];
  if (effect.amountIn > 0n) {
    postings.push(
      { account: user(scope, 'trading', effect.assetIn), side: 'debit', amount: effect.amountIn },
      { account: wallet(scope, effect.assetIn), side: 'credit', amount: effect.amountIn },
    );
  }
  if (effect.amountOut > 0n) {
    postings.push(
      { account: wallet(scope, effect.assetOut), side: 'debit', amount: effect.amountOut },
      { account: user(scope, 'trading', effect.assetOut), side: 'credit', amount: effect.amountOut },
    );
  }
  postings.push(...gasPostings(scope, effect.gasAsset, effect.gasUsed));
  if (postings.length < 2) invalid('A swap settlement needs at least one effect.');
  return postings;
}

/** Actual native gas: trading MON liability down, wallet MON down. Zero gas posts nothing. */
export function gasPostings(scope: AgentScope, gasAsset: string, gasUsed: bigint): PostingInput[] {
  if (gasUsed < 0n) invalid('Gas is non-negative.');
  if (gasUsed === 0n) return [];
  return [
    { account: user(scope, 'trading', gasAsset), side: 'debit', amount: gasUsed },
    { account: wallet(scope, gasAsset), side: 'credit', amount: gasUsed },
  ];
}

/** Earned service charge from the hosting or API bucket. The funds stay in the agent wallet until a sweep. */
export function serviceChargePostings(scope: AgentScope, line: RevenueLine, assetRef: string, amount: bigint): PostingInput[] {
  positive(amount, 'Charge');
  return [
    { account: user(scope, line, assetRef), side: 'debit', amount },
    { account: revenue(scope, line, assetRef), side: 'credit', amount },
  ];
}

/** Move earned revenue to the treasury. Customer liabilities and holds are untouched. */
export function sweepPostings(scope: AgentScope, assetRef: string, amount: bigint): PostingInput[] {
  positive(amount, 'Sweep');
  return [
    { account: treasury(scope.mode, assetRef), side: 'debit', amount },
    { account: wallet(scope, assetRef), side: 'credit', amount },
  ];
}

/** Finalized withdrawal of free trading funds, plus gas consumed. */
export function withdrawalPostings(scope: AgentScope, assetRef: string, amount: bigint, gasAsset: string, gasUsed: bigint): PostingInput[] {
  positive(amount, 'Withdrawal');
  return [
    { account: user(scope, 'trading', assetRef), side: 'debit', amount },
    { account: wallet(scope, assetRef), side: 'credit', amount },
    ...gasPostings(scope, gasAsset, gasUsed),
  ];
}

/** Refund a posted service charge to the bucket it came from (an explicit credit, never a deletion). */
export function refundPostings(scope: AgentScope, line: RevenueLine, assetRef: string, amount: bigint): PostingInput[] {
  positive(amount, 'Refund');
  return [
    { account: revenue(scope, line, assetRef), side: 'debit', amount },
    { account: user(scope, line, assetRef), side: 'credit', amount },
  ];
}

/** Platform absorbs a cost it cannot bill (unrecoverable model charge, teardown tail): expense against treasury. */
export function platformAbsorbPostings(mode: Mode, assetRef: string, amount: bigint): PostingInput[] {
  positive(amount, 'Absorbed cost');
  return [
    { account: platformExpense(mode, assetRef), side: 'debit', amount },
    { account: treasury(mode, assetRef), side: 'credit', amount },
  ];
}
