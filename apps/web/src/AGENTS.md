# web source

Follow [apps/web/AGENTS.md](../AGENTS.md) and the [language spec](../../../docs/specs/strategy-language.md). Own browser UI only; import browser-safe exports from `@monad-hack/strategy` and `@monad-hack/contracts`, never server code, keys or provider credentials.

- [ ] Keep `pnpm --filter @monad-hack/web typecheck` and `build` green for every change.
