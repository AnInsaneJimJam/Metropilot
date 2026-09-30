# Strategy language

Own domain block definitions, canonical AST compiler/validator, pure expression evaluation/interpreter core, preset definitions and editor import/export mapping. Read the complete [language specification](../../docs/specs/strategy-language.md) before changing any block, type or runtime behavior. Read [product](../../docs/specs/product.md) for presets.

Keep Blockly workspace metadata separate from executable JSON. No generated-JavaScript execution. Validate scope, units, closed node vocabulary and worst-case limits. Reads/AI/effects go through a supplied host interface; this package never signs or owns credentials. Replays preserve source/node/iteration identities.

## Checklist

- [ ] STR-1 / G2: implement custom blocks and workspace-to-AST compiler with canonical hashes.
- [ ] STR-2 / G2: implement scope/type/unit/limit/capability validation with node-mapped errors.
- [ ] STR-3 / G2: implement exact expression semantics, triggers, branches and bounded repeats.
- [ ] STR-4 / G2: define four reviewed presets and synthetic tutorial fixtures.
- [ ] STR-5 / G4,G6: integrate resumable host interface and recorded AI/effect results.
- [ ] STR-6 / G2–G6: pass roundtrip, crossing/cooldown, stale data, rounding, replay and adversarial AST checks.

Prerequisite: [contracts](../contracts/AGENTS.md). Coordinate web integration scope with [web](../../apps/web/AGENTS.md); transport/process wrapper belongs to [runtime](../../apps/runtime/AGENTS.md). Tick after behavior and runnable check evidence.
