// Verify an assignment and its immutable artifacts before any interpreter step (agent-runtime.md section 5).
import { contentHash, validate } from '@monad-hack/contracts';
import type { RuntimeAssignment } from '@monad-hack/contracts';
import { compileStrategy, LanguageError } from '@monad-hack/strategy';
import type { Catalog, CompiledStrategy } from '@monad-hack/strategy';
import type { RuntimeConfig } from './config.ts';
import { RuntimeError } from './errors.ts';
import type { Clock, ControlApi } from './ports.ts';

export interface VerifiedAssignment {
  readonly assignment: RuntimeAssignment;
  readonly program: CompiledStrategy;
}

const invalid = (message: string): never => {
  throw new RuntimeError('ASSIGNMENT_INVALID', message);
};

/** Schema, expiry, mode, image and hash checks; then compile the pinned strategy against the pinned catalog. */
export async function verifyAssignment(raw: unknown, config: RuntimeConfig, control: ControlApi, clock: Clock): Promise<VerifiedAssignment> {
  const parsed = validate('runtimeAssignment', raw);
  if (!parsed.ok) return invalid(`Assignment failed its schema at ${parsed.issues[0]?.fieldPath || '/'}.`);
  const assignment = parsed.value;
  const now = Date.parse(clock.now());
  if (Date.parse(assignment.expiresAt) <= now) invalid('Assignment has expired.');
  if (Date.parse(assignment.lease.expiresAt) <= now) invalid('Assignment lease has expired.');
  if (assignment.deployment.mode !== config.mode) invalid(`A ${config.mode} runtime cannot run a ${assignment.deployment.mode} deployment.`);
  if (assignment.deployment.runtimeImageDigest !== config.imageDigest) invalid('Assignment is for a different runtime image.');

  const catalogArtifact = await control.fetchArtifact(assignment.artifacts.catalogRef);
  let catalog: Catalog;
  try {
    catalog = JSON.parse(catalogArtifact.text) as Catalog;
  } catch {
    return invalid('Catalog artifact is not JSON.');
  }
  if ((await contentHash(catalog)) !== assignment.artifacts.catalogHash || catalogArtifact.contentHash !== assignment.artifacts.catalogHash) invalid('Catalog hash does not match the assignment.');

  const strategyArtifact = await control.fetchArtifact(assignment.artifacts.strategyRef);
  let program: CompiledStrategy;
  try {
    program = await compileStrategy(strategyArtifact.text, catalog);
  } catch (error) {
    if (error instanceof LanguageError) return invalid(`Pinned strategy does not compile (${error.code}).`);
    throw error;
  }
  if (program.hash !== assignment.artifacts.strategyHash || strategyArtifact.contentHash !== assignment.artifacts.strategyHash) invalid('Strategy hash does not match the assignment.');
  if (!program.strategy.triggers.some((trigger) => trigger.id === assignment.run.triggerId)) invalid('Assignment names a trigger the strategy does not have.');
  for (const ref of usedConnectors(program)) if (!Object.hasOwn(assignment.deployment.connectorVersions, ref)) invalid(`Manifest pins no version for connector ${ref}.`);
  return { assignment, program };
}

function usedConnectors(program: CompiledStrategy): Set<string> {
  const refs = new Set<string>();
  const visit = (body: readonly unknown[]): void => {
    for (const node of body as { type: string; connectorRef?: string; then?: unknown[]; else?: unknown[]; body?: unknown[] }[]) {
      if (node.type === 'swap.exactInput' && node.connectorRef) refs.add(node.connectorRef);
      if (node.then) visit(node.then);
      if (node.else) visit(node.else);
      if (node.body) visit(node.body);
    }
  };
  for (const trigger of program.strategy.triggers) visit(trigger.body);
  return refs;
}
