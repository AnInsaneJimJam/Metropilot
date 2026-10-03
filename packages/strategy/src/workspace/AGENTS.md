# strategy workspace

Blockly workspace ↔ strategy conversion shared by the web editor, API and runtime. Follow [strategy AGENTS](../../AGENTS.md) and the [language spec](../../../../docs/specs/strategy-language.md) §9 editor decisions (D14–D31). Owned by the editor contributor inside the strategy package; keep it pure (no Blockly, DOM or Node-only APIs) and reuse the package's `LanguageError`, `sha256`, `decimal` and `atomic` instead of adding parallel implementations.

- [x] Phase 3: exact human-unit conversion (`units.ts`) and the shared block/field vocabulary (`vocabulary.ts`); evidence: `workspace.test.ts` under `pnpm check`.
- [x] Phase 4: `compileWorkspace` / `compileWorkspaceProgram` / `workspaceFromStrategy` with source map (`convert.ts`); evidence: round-trip hash, ordering, loose/disabled/unknown block, MON, empty-body and 1 MiB tests in `workspace.test.ts`, plus a real-Blockly load → save → same-hash browser check on 2026-10-03.
