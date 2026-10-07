// Canonical logical keys for host operations (docs/specs/executor.md section 4, agent-runtime.md section 8).
// Both are 0x SHA-256 hashes of a JCS document, so every producer and consumer computes identical bytes.
import { contentHash } from './canonical.ts';

/** One effect-producing execution of an approved AST node in one deployment generation. */
export interface OperationIdentity {
  deploymentId: string;
  generation: string;
  runId: string;
  nodeId: string;
  iterationPath: readonly number[];
}

const identity = (id: OperationIdentity) => {
  if (!/^[1-9][0-9]{0,18}$/.test(id.generation)) throw new TypeError('generation must be a positive base-10 integer string');
  if (!id.iterationPath.every((i) => Number.isSafeInteger(i) && i >= 0)) throw new TypeError('iterationPath must hold non-negative integers');
  return { deploymentId: id.deploymentId, generation: id.generation, runId: id.runId, nodeId: id.nodeId, iterationPath: [...id.iterationPath] };
};

/** intent-key/1: the executor's logical key for one financial action. Excludes quote, nonce and provider data. */
export async function intentKey(id: OperationIdentity): Promise<string> {
  return contentHash({ schemaVersion: 'intent-key/1', ...identity(id) });
}

/**
 * operation-key/1: the control API's key for any host operation. A swap uses its intent key, so one financial
 * action has one key everywhere; reads, AI calls and notifications are namespaced by kind.
 */
export async function operationKey(kind: 'read' | 'ai.decide' | 'swap.exactInput' | 'notify', id: OperationIdentity): Promise<string> {
  if (kind === 'swap.exactInput') return intentKey(id);
  return contentHash({ schemaVersion: 'operation-key/1', kind, ...identity(id) });
}
