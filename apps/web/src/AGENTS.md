# web source

Follow [apps/web/AGENTS.md](../AGENTS.md) and the [language spec](../../../docs/specs/strategy-language.md). Own browser UI only; import browser-safe exports from `@monad-hack/strategy` and `@monad-hack/contracts`, never server code, keys or provider credentials.

Live validation lives in `validation.ts` and `useLiveValidation.ts`; the side panel is `StrategyPanel.tsx`; presets and the tutorial are in [presets](presets/).

- [ ] Keep `pnpm --filter @monad-hack/web typecheck` and `build` green for every change.
