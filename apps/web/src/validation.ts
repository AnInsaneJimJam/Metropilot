import { compileStrategy, compileWorkspace, locateBlock, profileIssues, FIELD, LanguageError } from '@monad-hack/strategy';
import type { CompiledStrategy, DeploymentProfile, WorkspaceEnvelope } from '@monad-hack/strategy';
import type { Strategy } from '@monad-hack/contracts';
import { editorCatalog } from './catalog.ts';

// Browser-side validation: the same converter, compiler and profile checks the server reruns (D14, D17).
// It guides the user; the backend stays authoritative.

export interface Problem {
  readonly code: string; readonly message: string; readonly blockId: string | undefined;
  /** The block field to focus, when the error names one the editor shows as a field. */
  readonly field: string | undefined;
}
export interface Validation {
  readonly problems: readonly Problem[];
  /** The converted document, when the blocks convert at all (shown even if it does not compile). */
  readonly strategy: Strategy | undefined;
  /** The hashed program, when it compiles. Profile problems can still block deployment. */
  readonly program: CompiledStrategy | undefined;
}

/** Plain-language names for the schema's field names, used when a schema message starts with "must …". */
const FIELD_LABEL: Readonly<Record<string, string>> = {
  name: 'Strategy name', intervalSeconds: 'Schedule interval (seconds)', anchorAt: 'Schedule start',
  maxAgeSeconds: 'Price age limit (seconds)', cooldownSeconds: 'Cooldown (seconds)', count: 'Repeat count',
  maxSlippageBps: 'Max slippage (bps)', bps: 'Percentage', atomic: 'Amount', message: 'Message', reason: 'Stop reason',
  maxStepsPerRun: 'Max steps per run', maxAiCallsPerRun: 'AI calls per run', maxIntentsPerRun: 'Trades per run', maxActiveSecondsPerRun: 'Active seconds per run',
  body: 'This trigger', then: 'This branch', triggers: 'The strategy',
};
function plain(error: LanguageError): string {
  if (!error.message.startsWith('must ')) return error.message;
  const segments = error.fieldPath.split('/').filter(s => !/^[0-9]+$/.test(s));
  const label = FIELD_LABEL[segments.at(-1) ?? ''] ?? 'This value';
  return `${label} ${error.message.replace('>=', 'at least').replace('<=', 'at most')}.`;
}
/** Strategy document keys → the block field that edits them, so a problem link can focus the right input. */
const FIELD_OF_KEY: Readonly<Record<string, string>> = {
  name: FIELD.name, maxStepsPerRun: FIELD.maxSteps, maxAiCallsPerRun: FIELD.maxAiCalls, maxIntentsPerRun: FIELD.maxIntents, maxActiveSecondsPerRun: FIELD.maxActiveSeconds,
  intervalSeconds: FIELD.interval, anchorAt: FIELD.anchor, feedRef: FIELD.feed, threshold: FIELD.threshold, decimal: FIELD.threshold,
  maxAgeSeconds: FIELD.maxAge, cooldownSeconds: FIELD.cooldown, count: FIELD.count, connectorRef: FIELD.connector,
  tokenInRef: FIELD.tokenIn, tokenOutRef: FIELD.tokenOut, amount: FIELD.amount, atomic: FIELD.amount, bps: FIELD.amount,
  maxSlippageBps: FIELD.slippage, message: FIELD.message, reason: FIELD.reason,
};
const fieldOf = (fieldPath: string): string | undefined =>
  fieldPath.split('/').reverse().map(key => Object.hasOwn(FIELD_OF_KEY, key) ? FIELD_OF_KEY[key] : undefined).find(Boolean);
const problem = (error: unknown, blockId: string | undefined): Problem => error instanceof LanguageError
  ? { code: error.code, message: plain(error), blockId, field: fieldOf(error.fieldPath) }
  : { code: 'INTERNAL', message: `Validation failed unexpectedly: ${String(error)}`, blockId, field: undefined };

export async function validateWorkspace(envelope: WorkspaceEnvelope, profile: DeploymentProfile): Promise<Validation> {
  let converted;
  try { converted = compileWorkspace(envelope, editorCatalog); } catch (error) {
    // Converter errors already name the offending block.
    return { problems: [problem(error, error instanceof LanguageError ? error.nodeId : undefined)], strategy: undefined, program: undefined };
  }
  const { strategy, sourceMap } = converted;
  const problems: Problem[] = profileIssues(strategy, profile).map(issue => problem(issue, locateBlock(issue, sourceMap)));
  let program: CompiledStrategy | undefined;
  try { program = await compileStrategy(JSON.stringify(strategy), editorCatalog); } catch (error) {
    problems.unshift(problem(error, error instanceof LanguageError ? locateBlock(error, sourceMap) : sourceMap['']));
  }
  return { problems, strategy, program };
}
