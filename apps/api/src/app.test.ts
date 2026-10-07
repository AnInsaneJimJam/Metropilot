import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { readFileSync } from "node:fs";
import {
  PRESETS,
  workspaceFromStrategy,
  syntheticCatalog,
} from "@monad-hack/strategy";
import { validate } from "@monad-hack/contracts";
import { createApp } from "./app.ts";
import { ControlStore } from "./store.ts";
import { migrate } from "./db/migrate.ts";
import type { SaveStrategy, SavedAgent } from "./control.ts";
const url = process.env["DATABASE_URL"];
if (!url && process.env["REQUIRE_DB"] === "1")
  throw new Error("DATABASE_URL required for control API tests");
describe("control API / real PostgreSQL", { skip: !url }, () => {
  let admin: pg.Client,
    pool: pg.Pool,
    store: ControlStore,
    app: ReturnType<typeof createApp>;
  let alice: string, bob: string;
  const dbName = `control_test_${randomBytes(8).toString("hex")}`;
  const budget = {
    tradingUsdMicros: "1000000000",
    hostingUsdMicros: "10000000",
    dataAndAiUsdMicros: "5000000",
    monReserveAtomic: "1000000000000000000",
  };
  const body: SaveStrategy = {
    schemaVersion: "control-workspace/1",
    name: "Threshold",
    experience: "rookie",
    workspace: workspaceFromStrategy(
      PRESETS[0]!.strategy,
      syntheticCatalog,
    ) as SaveStrategy["workspace"],
    budget,
  };
  const headers = (
    key = "test-request-0001",
    version?: number,
    cookie = "alice",
  ) => ({
    cookie,
    "idempotency-key": key,
    ...(version ? { "if-match": `"${version}"` } : {}),
  });
  before(async () => {
    admin = new pg.Client({ connectionString: url! });
    await admin.connect();
    await admin.query(`create database ${dbName}`);
    const u = new URL(url!);
    u.pathname = `/${dbName}`;
    pool = new pg.Pool({ connectionString: u.toString() });
    const c = new pg.Client({ connectionString: u.toString() });
    await c.connect();
    await migrate(c);
    await c.end();
    store = new ControlStore(pool);
    alice = await store.tenant("test-alice");
    bob = await store.tenant("test-bob");
    app = createApp({
      store,
      origin: "http://127.0.0.1:5173",
      authenticate: async (cookie) =>
        cookie === "alice" ? alice : cookie === "bob" ? bob : undefined,
    });
    await app.ready();
  });
  after(async () => {
    await app?.close();
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${dbName} with (force)`);
      await admin.end();
    }
  });
  test("requires a session and rejects foreign origins", async () => {
    assert.equal((await app.inject({ url: "/v1/agents" })).statusCode, 401);
    assert.equal(
      (
        await app.inject({
          url: "/v1/agents",
          headers: { cookie: "alice", origin: "https://evil.example" },
        })
      ).statusCode,
      403,
    );
  });
  test("server validates AST, refuses tenant claims, floats and invalid bounds", async () => {
    const result = await app.inject({
      method: "POST",
      url: "/v1/strategies/validate",
      headers: { cookie: "alice" },
      payload: body,
    });
    assert.equal(result.statusCode, 200);
    assert.match(result.json().hash, /^0x[0-9a-f]{64}$/);
    for (const payload of [
      { ...body, tenantId: alice },
      { ...body, budget: { ...budget, tradingUsdMicros: 1.5 } },
      { ...body, budget: { ...budget, tradingUsdMicros: "0" } },
    ]) {
      const bad = await app.inject({
        method: "POST",
        url: "/v1/agents",
        headers: headers(),
        payload,
      });
      assert.ok([400, 422].includes(bad.statusCode));
      assert.ok(validate("error", bad.json()).ok, JSON.stringify(bad.json()));
    }
    const tooLarge = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: headers(),
      payload: { ...body, name: "x".repeat(600_000) },
    });
    assert.equal(tooLarge.statusCode, 413);
  });
  test("concurrent retries create exactly one immutable revision and replay original response", async () => {
    const [a, b] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/v1/agents",
        headers: headers(),
        payload: body,
      }),
      app.inject({
        method: "POST",
        url: "/v1/agents",
        headers: headers(),
        payload: body,
      }),
    ]);
    assert.equal(a.statusCode, 201);
    assert.deepEqual(a.json(), b.json());
    assert.ok(validate("controlAgent", a.json()).ok);
    const count = await pool.query(
      "select count(*) from strategy_revisions where tenant_id=$1",
      [alice],
    );
    assert.equal(count.rows[0].count, "1");
    const different = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: headers(),
      payload: { ...body, name: "Different" },
    });
    assert.equal(different.statusCode, 409);
    assert.equal(different.json().code, "IDEMPOTENCY_CONFLICT");
    await assert.rejects(
      pool.query(
        "update strategy_revisions set content_hash=$1 where tenant_id=$2",
        ["0x" + "ff".repeat(32), alice],
      ),
      /immutable/,
    );
  });
  test("tenant isolation, version conflicts, reload and selected-revision ownership", async () => {
    const existing = (await store.list(alice))[0]!;
    assert.equal((await store.list(bob)).length, 0);
    const endpoint = `/v1/agents/${existing.id}/strategy-revisions`;
    const hidden = await app.inject({
      method: "POST",
      url: endpoint,
      headers: headers("bob-request-001", 1, "bob"),
      payload: body,
    });
    assert.equal(hidden.statusCode, 404);
    const edit = await app.inject({
      method: "POST",
      url: endpoint,
      headers: headers("alice-edit-001", 1),
      payload: {
        ...body,
        name: "Updated",
        budget: { ...budget, tradingUsdMicros: "1500000000" },
      },
    });
    assert.equal(edit.statusCode, 200);
    const saved = edit.json<SavedAgent>();
    assert.equal(saved.version, 2);
    assert.notEqual(saved.revisionId, existing.revisionId);
    const stale = await app.inject({
      method: "POST",
      url: endpoint,
      headers: headers("alice-stale-01", 1),
      payload: body,
    });
    assert.equal(stale.statusCode, 409);
    const listing = await app.inject({
      url: "/v1/agents",
      headers: { cookie: "alice" },
    });
    assert.equal(listing.json().items[0].name, "Updated");
    assert.equal(listing.json().items[0].budget.tradingUsdMicros, "1500000000");
    const other = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: headers("bob-create-001", undefined, "bob"),
      payload: body,
    });
    assert.equal(other.statusCode, 201);
    await assert.rejects(
      pool.query(
        "update agents set revision_id=$1 where tenant_id=$2 and id=$3",
        [other.json().revisionId, alice, existing.id],
      ),
      /foreign key/,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: endpoint,
          headers: headers("missing-version"),
          payload: body,
        })
      ).statusCode,
      400,
    );
  });
  test("AI strategy needs a nonzero API limit; hard paper caps are exact", async () => {
    const ai = {
      ...body,
      workspace: workspaceFromStrategy(PRESETS[3]!.strategy, syntheticCatalog),
      budget: { ...budget, dataAndAiUsdMicros: "0" },
    };
    const reject = await app.inject({
      method: "POST",
      url: "/v1/strategies/validate",
      headers: { cookie: "alice" },
      payload: ai,
    });
    assert.equal(reject.statusCode, 422);
    for (const amount of ["10000000001", "9".repeat(78)])
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/v1/strategies/validate",
            headers: { cookie: "alice" },
            payload: {
              ...body,
              budget: { ...budget, tradingUsdMicros: amount },
            },
          })
        ).statusCode,
        422,
      );
  });
  test("concurrent distinct edits are fenced by one saved version; lists paginate without tenant leaks", async () => {
    const existing = (await store.list(alice))[0]!;
    const url = `/v1/agents/${existing.id}/strategy-revisions`;
    const results = await Promise.all(
      ["a", "b"].map((tag) =>
        app.inject({
          method: "POST",
          url,
          headers: headers(`concurrent-edit-${tag}`, existing.version),
          payload: { ...body, name: `Concurrent ${tag}` },
        }),
      ),
    );
    assert.deepEqual(
      results.map((result) => result.statusCode).sort(),
      [200, 409],
    );
    const second = await app.inject({
      method: "POST",
      url: "/v1/agents",
      headers: headers("alice-second-agent"),
      payload: body,
    });
    assert.equal(second.statusCode, 201);
    const page = (
      await app.inject({
        url: "/v1/agents?limit=1",
        headers: { cookie: "alice" },
      })
    ).json();
    assert.equal(page.items.length, 1);
    assert.ok(page.nextCursor);
    const next = (
      await app.inject({
        url: `/v1/agents?limit=1&cursor=${page.nextCursor}`,
        headers: { cookie: "alice" },
      })
    ).json();
    assert.equal(next.items.length, 1);
    assert.notEqual(next.items[0].id, page.items[0].id);
    assert.equal(next.nextCursor, null);
    assert.equal(
      (
        await app.inject({
          url: "/v1/agents?limit=0",
          headers: { cookie: "alice" },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          url: "/v1/agents?tenantId=other",
          headers: { cookie: "alice" },
        })
      ).statusCode,
      400,
    );
    await pool.query("update tenants set state='suspended' where id=$1", [bob]);
    assert.equal(
      (await app.inject({ url: "/v1/agents", headers: { cookie: "bob" } }))
        .statusCode,
      401,
    );
  });
  test("development session bootstrap rejects a rebinding host and production factory has no dev session", async () => {
    assert.equal((await app.inject({ url: "/v1/session" })).statusCode, 401);
    const local = createApp({
      store,
      origin: "http://127.0.0.1:5173",
      authenticate: async () => alice,
      localSession: async () => ({
        tenant: alice,
        cookie: "test-session; HttpOnly; SameSite=Strict",
      }),
    });
    try {
      assert.equal(
        (
          await local.inject({
            url: "/v1/session",
            headers: { host: "evil.example" },
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await local.inject({
            url: "/v1/session",
            headers: { host: "127.0.0.1:3001" },
          })
        ).statusCode,
        200,
      );
    } finally {
      await local.close();
    }
  });
});

// Request-boundary regressions run without a database; the suite above proves
// persistence and tenant isolation against real PostgreSQL.
describe("control API request boundaries", () => {
  const tenantId = "0195a000-0000-7000-8000-000000000001";

  test("internal faults are non-retryable; only connection outages are 503", async (t) => {
    const store = new ControlStore(new pg.Pool());
    t.mock.method(store, "active", async () => true);
    const failures = [
      {
        error: new TypeError("private implementation detail"),
        status: 500,
        code: "INTERNAL_ERROR",
        retryable: false,
      },
      {
        error: Object.assign(new Error("SQL detail"), { code: "42703" }),
        status: 500,
        code: "INTERNAL_ERROR",
        retryable: false,
      },
      ...[
        "ECONNREFUSED",
        "ECONNRESET",
        "ETIMEDOUT",
        "08006",
        "57P01",
        "53300",
      ].map((code) => ({
        error: Object.assign(new Error("connection detail"), { code }),
        status: 503,
        code: "PROVIDER_UNAVAILABLE",
        retryable: true,
      })),
      ...[
        "Connection terminated unexpectedly",
        "Connection terminated due to connection timeout",
        "timeout exceeded when trying to connect",
      ].map((message) => ({
        error: new Error(message),
        status: 503,
        code: "PROVIDER_UNAVAILABLE",
        retryable: true,
      })),
    ];
    let failure = failures[0]!;
    t.mock.method(store, "list", async () => {
      throw failure.error;
    });
    const app = createApp({
      store,
      origin: "http://127.0.0.1:5173",
      authenticate: async () => tenantId,
    });
    try {
      for (failure of failures) {
        const response = await app.inject({ url: "/v1/agents" });
        const body = response.json();
        assert.equal(response.statusCode, failure.status);
        assert.equal(body.code, failure.code);
        assert.equal(body.retryable, failure.retryable);
        assert.ok(validate("error", body).ok);
        assert.ok(!body.message.includes(failure.error.message));
      }
    } finally {
      await app.close();
      await store.pool.end();
    }
  });

  test("list and save each use one verified session even if a second resolution would expire", async (t) => {
    const store = new ControlStore(new pg.Pool());
    t.mock.method(store, "active", async (tenant: string) => {
      assert.equal(tenant, tenantId);
      return true;
    });
    t.mock.method(store, "list", async (tenant: string) => {
      assert.equal(tenant, tenantId);
      return [];
    });
    const saved = JSON.parse(
      readFileSync(
        new URL(
          "../../../packages/contracts/fixtures/controlAgent/valid/saved-paper-agent.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as SavedAgent;
    t.mock.method(store, "save", async (tenant: string) => {
      assert.equal(tenant, tenantId);
      return saved;
    });
    let resolutions = 0;
    const app = createApp({
      store,
      origin: "http://127.0.0.1:5173",
      authenticate: async () => (++resolutions === 1 ? tenantId : undefined),
    });
    try {
      assert.equal((await app.inject({ url: "/v1/agents" })).statusCode, 200);
      assert.equal(resolutions, 1);
      resolutions = 0;
      const payload = JSON.parse(
        readFileSync(
          new URL(
            "../../../packages/contracts/fixtures/controlSave/valid/paper-draft.json",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/v1/agents",
            headers: { "idempotency-key": "session-expiry-test" },
            payload,
          })
        ).statusCode,
        201,
      );
      assert.equal(resolutions, 1);
      assert.equal((await app.inject({ url: "/v1/agents" })).statusCode, 401);
    } finally {
      await app.close();
      await store.pool.end();
    }
  });

  test("local frontend accepts both loopback names and rejects foreign hosts and origins", async () => {
    const store = new ControlStore(new pg.Pool());
    const app = createApp({
      store,
      origin: "http://127.0.0.1:5173",
      authenticate: async () => undefined,
      localSession: async () => ({
        tenant: tenantId,
        cookie: "test-session; HttpOnly; SameSite=Strict",
      }),
    });
    try {
      for (const hostname of ["127.0.0.1", "localhost"])
        assert.equal(
          (
            await app.inject({
              url: "/v1/session",
              headers: {
                host: `${hostname}:5173`,
                origin: `http://${hostname}:5173`,
              },
            })
          ).statusCode,
          200,
        );
      for (const headers of [
        { host: "evil.example", origin: "http://localhost:5173" },
        { host: "localhost:5173", origin: "https://evil.example" },
        { host: "localhost:5173", origin: "http://localhost:9999" },
      ])
        assert.equal(
          (await app.inject({ url: "/v1/session", headers })).statusCode,
          403,
        );
    } finally {
      await app.close();
      await store.pool.end();
    }
    const hosted = createApp({
      store,
      origin: "https://studio.example",
      authenticate: async () => undefined,
    });
    try {
      assert.equal(
        (
          await hosted.inject({
            url: "/v1/session",
            headers: { origin: "http://localhost:5173" },
          })
        ).statusCode,
        403,
      );
    } finally {
      await hosted.close();
    }
  });
});
