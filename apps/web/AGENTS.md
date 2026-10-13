# Web application

Own landing page, sign-in, mode/connector wizard, strategy editor integration, budget review, agent status and controls. Read [product](../../docs/specs/product.md), [language](../../docs/specs/strategy-language.md) for editor changes, and [API/data](../../docs/specs/api-and-data.md) for network changes. Repository policy is [design.md](../../design.md).

Use React/Vite. Browser validation helps the user; backend validation remains authoritative. Import only browser-safe contracts/strategy code. Keys, wallet signing, database access and provider credentials stay server-side. Provide keyboard/form alternatives to drag/drop, labeled inputs, focus/error handling, and readable status. Paper/live and pending/finalized states must be unmistakable.

Coordinate editor file ownership with the strategy contributor through [plan](../../plan.md). Do not independently invent AST or billing shapes.

## Checklist

- [ ] WEB-1 / G3: implement authenticated draft creation, save/reload and revision conflicts.
- [x] WEB-2 / G2,G7: integrate Blockly domain blocks, tutorial, preset editing and server-mapped validation errors. Errors come from the same converter/compiler the server reruns and map to blocks; the save endpoint itself is WEB-1/G3. A keyboard outline edits every field; the [keyboard-only browser test](e2e/editor.spec.ts) loads the native threshold preset, sees and fixes errors and verifies the unavailable-playback explanation. Evidence 2026-10-13: Playwright 1/1 and `REQUIRE_DB=1 pnpm check` 550/550; earlier production build green.
- [ ] WEB-3 / G7: implement capability selection and supported AI profile controls.
- [ ] WEB-4 / G7: show budget allocations, MON reserve, rate assumptions, expiring estimate and live consent.
- [ ] WEB-5 / G7: launch and show lifecycle, history, costs, policy denials, pause/stop and pending effects.
  - Progress 2026-10-12: [Operate stage](src/OperatePanel.tsx): capability review before launch, paper estimate and launch, pause/resume/stop, runs with expandable detail and a live activity timeline over the event stream. Typecheck and production build green. Manually verified in Chrome on 2026-10-12 against `pnpm stack:dev` (all real processes): save AI-gated preset → launch → scheduled run read/decided/bought via the paper executor → run detail and live events → pause → resume (generation 2) → stop; not yet covered by an automated browser test. Remaining: costs and policy-denial presentation review, keyboard-only Playwright scenario (WEB-7).
  - Progress 2026-10-13 (branch `feat/g3-control-plane-hardening`, issues #17, #19, #20): Operate renders run failures, revoked runs, blocked trades and skipped crossings through the shared reason vocabulary, notes when retention reset the activity stream, shows paper time today and in the session from `GET /v1/quota`, and shows `stopping` with the number of open trades. Evidence: [operate.spec.ts](e2e/operate.spec.ts) (Playwright, mocked control API) and the existing editor check pass (2/2); typecheck and production build green.
- [ ] WEB-6 / G8: add gated finalized funding/withdrawal flow with step-up and truthful transaction links.
- [ ] WEB-7 / G7–G8: pass keyboard-accessible paper onboarding and relevant live-flow browser checks.

Dependencies: [strategy](../../packages/strategy/AGENTS.md), [API](../api/AGENTS.md), [contracts](../../packages/contracts/AGENTS.md). Tick only after working behavior and linked check evidence; do not tick UI mocks as backend completion.

Progress 2026-10-08 (`codex/user-app-control-api`): Build/Rehearse/Review workspace integrated with the local control API, immutable save/reopen, conflict-safe versions, virtual-budget review and responsive/keyboard editing. Browser verification and limits are recorded in [plan](../../plan.md#local-control-workspace--2026-10-08). Hosted sign-in, deployments and wallet controls remain pending.

Visual workbench revision 2026-10-08: graphite/citron design tokens, coordinated Blockly/price-chart palette, parameter-first inspector, compiled strategy scope and phone-first rule forms. Browser/type/build evidence is in the same plan section; language and API behavior are unchanged.
