// Option 1 key mapping: the interpreter keeps its internal JSON-tuple key; the runtime derives the canonical
// contract keys from the assignment and sends only those outward. The interpreter is answered with its own key.
import { intentKey, operationKey } from '@monad-hack/contracts';
import type { ActionIntent, RuntimeAssignment } from '@monad-hack/contracts';
import type { HostCommand, SwapCommand } from '@monad-hack/strategy';
import { RuntimeError } from './errors.ts';

const identityOf = (assignment: RuntimeAssignment, command: HostCommand) => ({
  deploymentId: assignment.deployment.deploymentId,
  generation: assignment.deployment.generation,
  runId: command.runId,
  nodeId: command.nodeId,
  iterationPath: command.iterationPath,
});

/** operation-key/1 for this command (the intent-key/1 logical key for a swap). */
export function keyFor(assignment: RuntimeAssignment, command: HostCommand): Promise<string> {
  if (command.runId !== assignment.run.runId) throw new RuntimeError('HOST_BUG', 'Command belongs to another run.');
  return operationKey(command.kind, identityOf(assignment, command));
}

/** Map the interpreter's swap command to the closed ActionIntent proposal. */
export async function actionIntentFor(assignment: RuntimeAssignment, command: SwapCommand, observationRefs: readonly string[]): Promise<ActionIntent> {
  const pins = assignment.deployment.connectorVersions as Record<string, string>;
  const connectorVersion = Object.hasOwn(pins, command.connectorRef) ? pins[command.connectorRef] : undefined;
  if (!connectorVersion) throw new RuntimeError('ASSIGNMENT_INVALID', 'The manifest pins no version for this connector.');
  return {
    schemaVersion: 'action-intent/1',
    logicalKey: await intentKey(identityOf(assignment, command)),
    runId: command.runId,
    nodeId: command.nodeId,
    iterationPath: [...command.iterationPath],
    connectorRef: command.connectorRef,
    connectorVersion,
    action: 'swap.exactInput',
    tokenInRef: command.tokenInRef,
    tokenOutRef: command.tokenOutRef,
    amount: structuredClone(command.amount),
    maxSlippageBps: command.maxSlippageBps,
    observationRefs: [...observationRefs],
  };
}
