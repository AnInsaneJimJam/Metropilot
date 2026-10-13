import Fastify, { type FastifyRequest } from "fastify";
import { validate } from "@monad-hack/contracts";
import { LanguageError, syntheticCatalog } from "@monad-hack/strategy";
import { ControlError, newId, validateDraft } from "./control.ts";
import type { ControlStore } from "./store.ts";
import type { LifecycleService } from "./lifecycle.ts";

declare module "fastify" {
  interface FastifyRequest {
    tenantId: string | null;
  }
}

// Only recognized transport/availability failures are retryable. SQL mistakes and
// unexpected application exceptions are internal faults, not database outages.
function databaseUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: string }).code;
  return (
    (typeof code === "string" &&
      (/^08[0-9A-Z]{3}$/.test(code) ||
        [
          "57P01",
          "57P02",
          "57P03",
          "53300",
          "ECONNREFUSED",
          "ECONNRESET",
          "ETIMEDOUT",
          "EPIPE",
          "ENOTFOUND",
          "EHOSTUNREACH",
        ].includes(code))) ||
    [
      "Connection terminated unexpectedly",
      "Connection terminated due to connection timeout",
      "timeout exceeded when trying to connect",
    ].includes(error.message)
  );
}

function requestTenant(request: FastifyRequest): string {
  if (!request.tenantId)
    throw new ControlError(401, "UNAUTHENTICATED", "Reconnect your workspace.");
  return request.tenantId;
}

export interface ApiOptions {
  store: ControlStore;
  catalog?: import("@monad-hack/strategy").Catalog;
  /** Production callers must supply a verified session resolver. Never accept a tenant from the body. */
  authenticate: (cookie: string | undefined) => Promise<string | undefined>;
  origin: string;
  localSession?: () => Promise<{ cookie: string; tenant: string }>;
  /** Deployment lifecycle and history (API-2, API-6); absent means launch is unavailable. */
  lifecycle?: LifecycleService;
  /** How often an open event stream checks for new audit events. */
  streamPollMillis?: number;
}

const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function createApp(options: ApiOptions) {
  const app = Fastify({
    bodyLimit: 512 * 1024,
    genReqId: newId,
    requestIdHeader: false,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
    logger: false,
  });
  app.decorateRequest("tenantId", null);
  const rates = new Map<string, { time: number; count: number }>();
  app.addHook("onRequest", async (request, reply) => {
    reply
      .header("Cache-Control", "no-store")
      .header("X-Content-Type-Options", "nosniff")
      .header("X-Request-Id", request.id);
    if (
      options.localSession &&
      ![
        "127.0.0.1:3001",
        "localhost:3001",
        "127.0.0.1:5173",
        "localhost:5173",
      ].includes(request.headers.host ?? "")
    )
      throw new ControlError(
        403,
        "FORBIDDEN",
        "Local workspace requests require the loopback host.",
      );
    const allowedOrigins = options.localSession
      ? ["http://127.0.0.1:5173", "http://localhost:5173"]
      : [options.origin];
    if (
      request.headers.origin &&
      !allowedOrigins.includes(request.headers.origin)
    )
      throw new ControlError(
        403,
        "FORBIDDEN",
        "This request origin is not allowed.",
      );
    const now = Date.now();
    if (rates.size >= 1000)
      for (const [ip, rate] of rates)
        if (now - rate.time > 60_000) rates.delete(ip);
    const rate = rates.get(request.ip);
    if (!rate && rates.size >= 1000)
      throw new ControlError(429, "RATE_LIMITED", "Try again in a minute.");
    if (!rate || now - rate.time >= 60_000)
      rates.set(request.ip, { time: now, count: 1 });
    else if (++rate.count > 120)
      throw new ControlError(
        429,
        "RATE_LIMITED",
        "Too many requests. Try again in a minute.",
      );
  });
  app.setErrorHandler((error, request, reply) => {
    const known = error instanceof ControlError;
    const language = error instanceof LanguageError;
    const fastify = error as { statusCode?: number; validation?: unknown };
    const unavailable = databaseUnavailable(error);
    const status = known
      ? error.status
      : language
        ? 422
        : fastify.statusCode && fastify.statusCode < 500
          ? fastify.statusCode
          : unavailable
            ? 503
            : 500;
    reply.code(status).send({
      code:
        known || language
          ? error.code
          : fastify.validation
            ? "SCHEMA_INVALID"
            : status < 500
              ? "MALFORMED_REQUEST"
              : unavailable
                ? "PROVIDER_UNAVAILABLE"
                : "INTERNAL_ERROR",
      message:
        known || language
          ? error.message
          : status < 500
            ? "The request does not match the required format."
            : unavailable
              ? "The workspace database is unavailable. Your browser draft is still open."
              : "An internal error occurred. Your browser draft is still open.",
      requestId: request.id,
      retryable: status === 503,
      ...(known
        ? error.details
        : language
          ? { nodeId: error.nodeId, fieldPath: error.fieldPath }
          : {}),
    });
  });
  app.get("/v1/session", async (_, reply) => {
    if (!options.localSession)
      throw new ControlError(
        401,
        "UNAUTHENTICATED",
        "Sign in through the configured authentication provider.",
      );
    const session = await options.localSession();
    reply.header("Set-Cookie", session.cookie);
    return {
      mode: "local",
      label: "Local development workspace",
      tenant: session.tenant,
    };
  });
  app.register(async (routes) => {
    routes.addHook("preHandler", async (request) => {
      const tenant = await options.authenticate(request.headers.cookie);
      if (!tenant || !(await options.store.active(tenant)))
        throw new ControlError(
          401,
          "UNAUTHENTICATED",
          "Your session has expired. Reconnect your workspace.",
        );
      request.tenantId = tenant;
    });
    routes.get("/v1/catalog", async () => ({
      mode: "paper",
      synthetic: options.catalog === undefined,
      catalog: options.catalog ?? syntheticCatalog,
      capabilities: { save: true, deploy: Boolean(options.lifecycle), cloudExecution: false, live: false },
      ...(options.lifecycle ? { paperVersions: await options.lifecycle.paperVersions() } : {}),
    }));
    routes.get(
      "/v1/agents",
      {
        schema: {
          querystring: {
            type: "object",
            additionalProperties: false,
            properties: {
              limit: { type: "string", pattern: "^([1-9]|[1-9][0-9]|100)$" },
              cursor: {
                type: "string",
                pattern:
                  "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
              },
            },
          },
        },
      },
      async (request) => {
        const query = request.query as { limit?: string; cursor?: string };
        const limit = Number(query.limit ?? 25);
        const rows = await options.store.list(
          requestTenant(request),
          limit + 1,
          query.cursor,
        );
        return {
          items: rows.slice(0, limit),
          nextCursor: rows.length > limit ? rows[limit - 1]!.id : null,
        };
      },
    );
    routes.post("/v1/strategies/validate", async (request) => {
      const checked = validate("controlSave", request.body);
      if (!checked.ok)
        throw new ControlError(
          400,
          "SCHEMA_INVALID",
          checked.issues[0]!.message,
          { fieldPath: checked.issues[0]!.fieldPath },
        );
      const p = await validateDraft(checked.value, options.catalog);
      return {
        valid: true,
        hash: p.hash,
        bounds: p.bounds,
        mode: "paper",
        executionReady: false,
      };
    });
    const save = async (request: FastifyRequest, isRevision: boolean) => {
      const checked = validate("controlSave", request.body);
      if (!checked.ok)
        throw new ControlError(
          400,
          "SCHEMA_INVALID",
          checked.issues[0]!.message,
          { fieldPath: checked.issues[0]!.fieldPath },
        );
      const key = request.headers["idempotency-key"];
      if (typeof key !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(key))
        throw new ControlError(
          400,
          "MALFORMED_REQUEST",
          "A valid Idempotency-Key is required.",
        );
      const id = isRevision ? (request.params as { id: string }).id : undefined;
      if (
        id &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
          id,
        )
      )
        throw new ControlError(404, "NOT_FOUND", "Strategy not found.");
      const match = request.headers["if-match"];
      if (
        isRevision &&
        (typeof match !== "string" || !/^"[1-9][0-9]{0,8}"$/.test(match))
      )
        throw new ControlError(
          400,
          "MALFORMED_REQUEST",
          "If-Match must contain the saved version.",
        );
      const program = await validateDraft(checked.value, options.catalog);
      return options.store.save(
        requestTenant(request),
        key,
        checked.value,
        program,
        id,
        isRevision ? Number(String(match).replaceAll('"', "")) : undefined,
      );
    };
    routes.post("/v1/agents", async (request, reply) => {
      const result = await save(request, false);
      reply.code(201).header("ETag", `"${result.version}"`);
      return result;
    });
    routes.post("/v1/agents/:id/strategy-revisions", async (request, reply) => {
      const result = await save(request, true);
      reply.header("ETag", `"${result.version}"`);
      return result;
    });
    const lifecycle = () => {
      if (!options.lifecycle)
        throw new ControlError(503, "PROVIDER_UNAVAILABLE", "Launching is not available on this server.");
      return options.lifecycle;
    };
    const agentId = (request: FastifyRequest) => {
      const id = (request.params as { id: string }).id;
      if (!UUIDV7.test(id)) throw new ControlError(404, "NOT_FOUND", "Strategy not found.");
      return id;
    };
    const idempotencyKey = (request: FastifyRequest) => {
      const key = request.headers["idempotency-key"];
      if (typeof key !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(key))
        throw new ControlError(400, "MALFORMED_REQUEST", "A valid Idempotency-Key is required.");
      return key;
    };
    const page = (request: FastifyRequest) => {
      const q = request.query as { limit?: string };
      if (q.limit !== undefined && !/^([1-9]|[1-9][0-9]|100)$/.test(q.limit))
        throw new ControlError(400, "MALFORMED_REQUEST", "limit must be 1–100.");
      return Number(q.limit ?? 25);
    };
    routes.post("/v1/agents/:id/estimates", async (request) => {
      const body = (request.body ?? {}) as { strategyRevisionId?: unknown };
      if (typeof body !== "object" || Object.keys(body).some((k) => k !== "strategyRevisionId") || (body.strategyRevisionId !== undefined && (typeof body.strategyRevisionId !== "string" || !UUIDV7.test(body.strategyRevisionId))))
        throw new ControlError(400, "SCHEMA_INVALID", "Send {} or {strategyRevisionId}.");
      return lifecycle().estimate(requestTenant(request), agentId(request), body.strategyRevisionId as string | undefined);
    });
    routes.post("/v1/agents/:id/deployments", async (request, reply) => {
      const operation = await lifecycle().launch(requestTenant(request), agentId(request), request.body, idempotencyKey(request));
      reply.code(202).header("Location", `/v1/operations/${operation.id}`);
      return operation;
    });
    for (const kind of ["pause", "resume", "stop"] as const) {
      routes.post(`/v1/agents/:id/${kind}`, async (request, reply) => {
        const operation = await lifecycle().control(requestTenant(request), agentId(request), kind, idempotencyKey(request));
        reply.code(202).header("Location", `/v1/operations/${operation.id}`);
        return operation;
      });
    }
    routes.get("/v1/operations/:id", async (request) =>
      lifecycle().operation(requestTenant(request), (request.params as { id: string }).id));
    routes.get("/v1/agents/:id/deployment", async (request) =>
      lifecycle().deployment(requestTenant(request), agentId(request)));
    routes.get("/v1/agents/:id/runs", async (request) => {
      const cursor = (request.query as { cursor?: string }).cursor;
      return lifecycle().runs(requestTenant(request), agentId(request), page(request), cursor);
    });
    routes.get("/v1/runs/:runId", async (request) =>
      lifecycle().run(requestTenant(request), (request.params as { runId: string }).runId));
    const cursorOf = (request: FastifyRequest): bigint => {
      const header = request.headers["last-event-id"];
      const raw = typeof header === "string" ? header : (request.query as { after?: string }).after ?? "0";
      if (!/^(0|[1-9][0-9]{0,19})$/.test(raw)) throw new ControlError(400, "MALFORMED_REQUEST", "Invalid event cursor.");
      return BigInt(raw);
    };
    routes.get("/v1/agents/:id/events", async (request) => {
      const tenant = requestTenant(request);
      const id = agentId(request);
      await lifecycle().assertAgent(tenant, id);
      const items = await lifecycle().events(tenant, id, cursorOf(request), page(request));
      return { items, nextCursor: items.length ? String(items.at(-1)!.sequence) : null };
    });
    // Server-sent events from the durable audit stream; Last-Event-ID resumes. Delivery never controls execution.
    routes.get("/v1/agents/:id/stream", async (request, reply) => {
      const tenant = requestTenant(request);
      const id = agentId(request);
      const service = lifecycle();
      await service.assertAgent(tenant, id);
      let cursor = cursorOf(request);
      reply.hijack();
      const out = reply.raw;
      out.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        connection: "keep-alive",
      });
      out.write(": stream open\n\n");
      let open = true;
      request.raw.on("close", () => {
        open = false;
      });
      let idle = 0;
      while (open) {
        try {
          for (const event of await service.events(tenant, id, cursor, 100)) {
            out.write(`id: ${String(event.sequence)}\nevent: audit\ndata: ${JSON.stringify(event)}\n\n`);
            cursor = BigInt(String(event.sequence));
            idle = 0;
          }
        } catch {
          out.write("event: unavailable\ndata: {}\n\n");
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, options.streamPollMillis ?? 500));
        if (++idle % 30 === 0) out.write(": keep-alive\n\n");
      }
      out.end();
    });
  });
  return app;
}
