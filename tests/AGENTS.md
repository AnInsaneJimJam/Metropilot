# Cross-module verification

Own integration/acceptance, crash/recovery, isolation and demo scenarios. Unit tests live with their owning module. Read [verification matrix](../docs/specs/verification.md) and the affected normative spec before creating tests.

Use minimal meaningful runnable checks. Money/concurrency needs real Postgres; mocked responses cannot prove locking or signing-provider restrictions. Label paper/fork/testnet/mainnet results distinctly. Paid-provider or real-fund tests require their applicable authorization and explicit environment; ordinary CI uses synthetic fixtures.

## Checklist

- [ ] TEST-1 / G1: validate schemas/examples, documentation links and secret-free fixture conventions.
- [ ] TEST-2 / G2–G4: implement language roundtrip, tenant isolation and durable paper-run recovery scenarios.
- [ ] TEST-3 / G5–G6: implement concurrent budget, unknown bill and prompt-injection rejection scenarios.
- [ ] TEST-4 / G7: implement one keyboard-accessible onboarding-to-pause browser scenario.
- [ ] TEST-5 / G8: implement signing/nonce/finality/crash and ledger settlement failure injection.
- [ ] TEST-6 / G9–G10: capture reproducible demo, backup/revocation and release evidence.

Prerequisites depend on the scenario in [plan](../plan.md); do not block pure checks on cloud access. Tick with exact observed command/result links. Never mark a check passed if only its plan exists.
