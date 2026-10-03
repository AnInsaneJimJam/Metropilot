# Database migrations

Forward-only PostgreSQL migrations applied by [migrate.ts](../src/db/migrate.ts) (`pnpm db:migrate`). Read [API/data section 7](../../../docs/specs/api-and-data.md) and [security](../../../docs/specs/security.md) before adding tables. One active writer at a time; claim the next number in [plan.md](../../../plan.md).

Rules: files are `NNNN_lower_snake.sql`, numbered without gaps, and never edited after they have been applied anywhere (the runner refuses a changed checksum); fix forward with a new file. Tenant-owned tables carry `tenant_id` and use composite `(tenant_id, id)` keys for owned references. Server IDs are checked as UUIDv7. Money columns are `numeric(78,0)`, never floating point. Immutable records get a mutation-forbidding trigger. Seed data lives in [seed.ts](../src/db/seed.ts), is synthetic, and is loaded only into local databases.

## Checklist

- [ ] MIG-1 / G1+: for each new migration, add its database checks to `src/db/db.test.ts` and run `REQUIRE_DB=1 pnpm check` against a real Postgres before ticking the owning task.
