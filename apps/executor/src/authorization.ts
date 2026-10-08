// Current-authority and approved-AST checks (docs/specs/executor.md section 5, steps 6–9).
import { canonicalize } from '@monad-hack/contracts';
import type { ActionIntent, Statement, Strategy } from '@monad-hack/contracts';

export type DesiredState = 'active' | 'paused' | 'stopping' | 'stopped';

/** What the control API's current deployment record says; never derived from the request body. */
export interface DeploymentAuthority {
  readonly tenantId: string;
  readonly agentId: string;
  readonly deploymentId: string;
  /** Current generation, positive base-10 integer string. */
  readonly generation: string;
  readonly mode: 'paper' | 'live';
  readonly desiredState: DesiredState;
  readonly strategyRevisionId: string;
  readonly policyVersion: number;
  readonly networkRef: string;
  /** Connector versions pinned by the immutable manifest. */
  readonly connectorPins: Readonly<Record<string, string>>;
  /** Paper deployments only: the simulation account (session) the deployment trades in. */
  readonly simulationAccountId?: string;
}

/**
 * Port for the control API's deployment state (G3). Implementations must read current state, not a cached
 * capability: a pause has to take effect before the capability expires. Throwing means "unavailable".
 */
export interface AuthoritySource {
  current(tenantId: string, deploymentId: string): Promise<DeploymentAuthority | undefined>;
}

export type NodeMatch =
  | { readonly ok: true; readonly node: Extract<Statement, { type: 'swap.exactInput' }>; readonly branchGated: boolean }
  | { readonly ok: false; readonly message: string };

/**
 * Resolve nodeId to exactly one approved swap node and check that the intent cannot widen it.
 * iterationPath must name one execution inside the node's enclosing repeats. Branch choice for nodes
 * under `if` is reported as branchGated; verifying it needs persisted broker results (observationRefs).
 */
export function matchApprovedNode(strategy: Strategy, intent: ActionIntent): NodeMatch {
  const found: { node: Statement; repeats: number[]; gated: boolean }[] = [];
  const walk = (statements: readonly Statement[], repeats: number[], gated: boolean): void => {
    for (const statement of statements) {
      if (statement.id === intent.nodeId) found.push({ node: statement, repeats, gated });
      if (statement.type === 'if') {
        walk(statement.then, repeats, true);
        walk(statement.else, repeats, true);
      } else if (statement.type === 'repeat') walk(statement.body, [...repeats, statement.count], gated);
    }
  };
  for (const trigger of strategy.triggers) walk(trigger.body, [], false);

  if (found.length !== 1) return { ok: false, message: 'The node is not part of the approved strategy.' };
  const { node, repeats, gated } = found[0]!;
  if (node.type !== 'swap.exactInput') return { ok: false, message: 'The node is not an approved swap action.' };
  const path = intent.iterationPath;
  if (path.length !== repeats.length || path.some((index, depth) => index >= repeats[depth]!)) {
    return { ok: false, message: 'The iteration path does not match the approved repeat structure.' };
  }
  if (node.connectorRef !== intent.connectorRef || node.tokenInRef !== intent.tokenInRef || node.tokenOutRef !== intent.tokenOutRef) {
    return { ok: false, message: 'The connector or token pair differs from the approved node.' };
  }
  if (canonicalize(node.amount) !== canonicalize(intent.amount)) return { ok: false, message: 'The amount rule differs from the approved node.' };
  // maxSlippageBps may only narrow the approved value.
  if (intent.maxSlippageBps > node.maxSlippageBps) return { ok: false, message: 'The slippage limit is wider than the approved node.' };
  return { ok: true, node, branchGated: gated };
}
