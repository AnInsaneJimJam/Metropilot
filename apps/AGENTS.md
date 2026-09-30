# Application roots

Scope: independently started processes and website builds. Read [architecture](../architecture.md) before introducing another app. Children inherit root instructions and own their process-specific work.

`web` owns user interaction; `api` owns control/lifecycle and provider brokers; `runtime` interprets restricted strategies; `executor` owns financial effects; `docs` builds public user docs. API workers are roles within the API app, not new app directories. No app imports another app's source; share a real contract/package instead.

## Checklist

- [ ] APPS-1 / G1: define distinct start/build/test entries only when implementation begins.
- [ ] APPS-2 / G4: prove process credentials/network access match architecture.
- [ ] APPS-3 / G7–G8: verify the end-to-end contracts across apps without private source imports.

Prerequisites: [contracts](../packages/contracts/AGENTS.md) before app integration. Tick after passing checks and link evidence; individual features remain in child checklists.
