# web blocks

Blockly block definitions, toolbox and editor-wide setup for the strategy editor. Follow [web source AGENTS](../AGENTS.md) and the [language spec](../../../../docs/specs/strategy-language.md) §9 editor decisions. Block types, field and input names come from `@monad-hack/strategy` (`workspace/vocabulary.ts`) because the converter walks the saved JSON by those names; never hard-code them here. Dropdowns come from the catalog adapter in [catalog.ts](../catalog.ts). Connection checks and local warnings guide the user only; the converter and compiler are authoritative.

- [x] Phase 3: root/trigger/statement/value blocks, locked read/AI blocks, catalog dropdowns, legal block IDs, no disabling; evidence: `pnpm --filter @monad-hack/web typecheck` and `build` green.
- [ ] Phase 5: map compiler errors onto blocks; rookie limits.
