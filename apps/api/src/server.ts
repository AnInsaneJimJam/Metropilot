import { randomBytes } from "node:crypto";
import pg from "pg";
import { databaseUrl } from "./config.ts";
import { createApp } from "./app.ts";
import { ControlStore } from "./store.ts";

// Explicitly local-only until the production identity adapter and HTTPS deployment are supplied.
if (
  process.env["LOCAL_WORKSPACE"] !== "1" ||
  process.env["NODE_ENV"] === "production"
)
  throw new Error(
    "This entry point is local development only. Set LOCAL_WORKSPACE=1; hosted servers require a verified identity adapter.",
  );
const pool = new pg.Pool({
  connectionString: databaseUrl(process.env).toString(),
  max: 10,
  connectionTimeoutMillis: 3000,
});
const store = new ControlStore(pool);
const tenant = await store.tenant("local-control-workspace");
const sessions = new Map<string, number>();
const app = createApp({
  store,
  origin: "http://127.0.0.1:5173",
  authenticate: async (cookie) => {
    const token = cookie
      ?.split(";")
      .map((value) => value.trim())
      .find((value) => value.startsWith("monad_session="))
      ?.slice("monad_session=".length);
    if (!token) return undefined;
    const expires = sessions.get(token);
    return expires && expires > Date.now() ? tenant : undefined;
  },
  localSession: async () => {
    const now = Date.now();
    for (const [key, expires] of sessions)
      if (expires <= now) sessions.delete(key);
    if (sessions.size >= 1000) sessions.delete(sessions.keys().next().value!);
    const token = randomBytes(32).toString("hex");
    sessions.set(token, now + 8 * 60 * 60 * 1000);
    return {
      tenant,
      cookie: `monad_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`,
    };
  },
});
const close = async () => {
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());
await app.listen({ host: "127.0.0.1", port: 3001 });
console.log("Local control API listening at http://127.0.0.1:3001");
