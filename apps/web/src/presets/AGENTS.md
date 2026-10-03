# web presets

Preset templates and the in-app tutorial. Follow [web source AGENTS](../AGENTS.md) and the [tutorial guide](../../../../docs/guide/strategy-tutorial.md). Preset **documents** live in `@monad-hack/strategy` (`workspace/presets.ts`) so the shared core tests them; this folder only turns them into blocks with `workspaceFromStrategy` and loads them. Never hand-write preset Blockly JSON here.

- [x] Phase 6: threshold partial sale and scheduled fixed purchase as block templates; tutorial steps with live checks; evidence: preset tests in `packages/strategy/src/workspace/workspace.test.ts` under `pnpm check`, web `typecheck` and `build` green.
- [x] Phase 8: observe-and-explain and AI-gated purchase; evidence: preset round-trip test in `workspace.test.ts` (four presets) and both loaded in Chrome, compiling with no problems, 2026-10-03.
