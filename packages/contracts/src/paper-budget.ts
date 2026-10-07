import type { GeneratedContractMap } from "./generated-contracts.ts";
/** Configuration checks for the local paper workspace; never a ledger reservation or price quote. */
export function paperBudgetIssue(
  budget: GeneratedContractMap["controlSave"]["budget"],
  usesAi: boolean,
): string | undefined {
  const trading = BigInt(budget.tradingUsdMicros),
    hosting = BigInt(budget.hostingUsdMicros),
    data = BigInt(budget.dataAndAiUsdMicros),
    reserve = BigInt(budget.monReserveAtomic);
  if (trading <= 0n || hosting <= 0n)
    return "Trading and hosting limits must be greater than zero.";
  if (trading + hosting + data > 10_000_000_000n)
    return "The paper total cannot exceed 10,000 virtual USD.";
  if (reserve <= 0n || reserve > 100n * 10n ** 18n)
    return "Keep a MON reserve greater than zero and at most 100 virtual MON.";
  if (usesAi && data === 0n)
    return "This strategy uses AI. Give its data & AI budget a positive limit.";
  return undefined;
}
