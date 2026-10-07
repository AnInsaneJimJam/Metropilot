# Integration guides

Scope: how another service owner integrates with an implemented component. A guide is a how-to that links to the normative [specifications](../specs/) and [contracts](../../packages/contracts/schemas/) for rules; it does not restate limits or redefine a contract. When a guide and a spec disagree, the spec and schema win; fix the guide in the same change.

Every guide names the conformance kit that proves an integration and keeps its examples equal to contract fixtures or tested vectors.

## Checklist

- [ ] INT-1 / G4: control API owner passes the [control API conformance kit](../../apps/runtime/src/conformance/control-api.ts) against the real service through the runtime HTTP client.
- [ ] INT-2 / G4: executor owner passes the [executor conformance kit](../../apps/runtime/src/conformance/executor.ts) against the paper executor through the runtime HTTP client.

Tick only with a linked passing run against the real service; the local stand-ins passing their own kits is not integration evidence.
