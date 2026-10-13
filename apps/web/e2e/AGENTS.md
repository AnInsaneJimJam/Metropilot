# Web browser tests

Playwright checks for [apps/web](../AGENTS.md), run with `pnpm --filter @monad-hack/web test:e2e` (starts `vite` itself). Name files `*.spec.ts` so the root `node --test` run never collects them. Drive the editor by keyboard only (Tab, Enter, typing): no clicks, so each test also proves keyboard reachability. Use deterministic inputs and fixtures without depending on live market prices or executing transactions; never label fixture output as a paper or live fill.

- [x] Keyboard-only native threshold preset flow: select a rule, rapid edit/revert, reject an invalid threshold, fix a focusable rookie-limit problem, restore the original hash and verify the native-oracle playback limitation ([editor.spec.ts](editor.spec.ts)). Evidence 2026-10-13: 1/1 passed locally (Chromium headless shell 1243). No synthetic scenarios or trades are run.
