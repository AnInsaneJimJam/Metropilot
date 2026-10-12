// The executor capability format lives in packages/contracts so the control API (issuer) and the executor
// (verifier) share one implementation (D35). Re-exported here for the executor's existing imports.
export { CAPABILITY_AUDIENCE, CapabilityError, MAX_CAPABILITY_SECONDS, signCapability, verifyCapability } from '@monad-hack/contracts/capability';
export type { Capability } from '@monad-hack/contracts/capability';
