# Web browser tests

Playwright checks for [apps/web](../AGENTS.md), run with `pnpm --filter @monad-hack/web test:e2e` (starts `vite` itself). Name files `*.spec.ts` so the root `node --test` run never collects them. Drive the editor by keyboard only (Tab, Enter, typing): no clicks, so each test also proves keyboard reachability. Use synthetic data only; label nothing as a paper or live fill.

- [x] Keyboard-only threshold preset flow: load, edit a refused and a valid threshold, fix a focusable rookie-limit problem, same hash on return, rehearse fires once on 2499 → 2501 → 2502 ([editor.spec.ts](editor.spec.ts)). Evidence 2026-10-04: 1/1 passed locally (Chromium headless shell 1243).
