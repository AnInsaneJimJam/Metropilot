import pg from "pg";
import { contentHash } from "@monad-hack/contracts";
import { ControlError, newId } from "./control.ts";
import type { SaveStrategy, SavedAgent } from "./control.ts";
import type { CompiledStrategy } from "@monad-hack/strategy";
export class ControlStore {
  readonly pool: pg.Pool;
  constructor(pool: pg.Pool) {
    this.pool = pool;
  }
  async tenant(subject: string): Promise<string> {
    const { rows } = await this.pool.query<{ id: string }>(
      `insert into tenants(id,auth_subject) values($1,$2)
      on conflict(auth_subject) do update set auth_subject=excluded.auth_subject returning id`,
      [newId(), subject],
    );
    return rows[0]!.id;
  }
  /** Health check: the database answers. */
  async ping(): Promise<void> {
    await this.pool.query('select 1');
  }
  async active(tenant: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      "select id from tenants where id=$1 and state='active'",
      [tenant],
    );
    return rows.length === 1;
  }
  async list(
    tenant: string,
    limit = 25,
    cursor?: string,
  ): Promise<SavedAgent[]> {
    const { rows } = await this.pool.query(
      `select a.*,r.workspace,r.content_hash from agents a
      join strategy_revisions r on r.tenant_id=a.tenant_id and r.id=a.revision_id
      where a.tenant_id=$1 and ($2::uuid is null or a.id < $2::uuid) order by a.id desc limit $3`,
      [tenant, cursor ?? null, limit],
    );
    return rows.map(toAgent);
  }
  async save(
    tenant: string,
    key: string,
    request: SaveStrategy,
    program: CompiledStrategy,
    id?: string,
    version?: number,
  ): Promise<SavedAgent> {
    const scope = id
      ? `POST /v1/agents/${id}/strategy-revisions`
      : "POST /v1/agents";
    const hash = await contentHash({ request, version: version ?? null });
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        "select pg_advisory_xact_lock(hashtextextended($1,0))",
        [`${tenant}:${scope}:${key}`],
      );
      const replay = await client.query(
        "select request_hash,response from control_requests where tenant_id=$1 and scope=$2 and key=$3",
        [tenant, scope, key],
      );
      if (replay.rows[0]) {
        if (replay.rows[0].request_hash !== hash)
          throw new ControlError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "This request key was already used for different content.",
          );
        await client.query("commit");
        return replay.rows[0].response as SavedAgent;
      }
      const agentId = id ?? newId();
      if (id) {
        const existing = await client.query(
          "select version from agents where tenant_id=$1 and id=$2 for update",
          [tenant, id],
        );
        if (!existing.rows[0])
          throw new ControlError(404, "NOT_FOUND", "Strategy not found.");
        if (existing.rows[0].version !== version)
          throw new ControlError(
            409,
            "REVISION_CONFLICT",
            "This strategy changed in another tab. Reopen the saved version before saving.",
          );
      } else
        await client.query(
          "insert into agents(tenant_id,id,name) values($1,$2,$3)",
          [tenant, agentId, request.name],
        );
      const revisionId = newId();
      await client.query(
        `insert into strategy_revisions(tenant_id,id,agent_id,language_version,content_hash,ast,workspace,validation)
        values($1,$2,$3,'strategy/1',$4,$5,$6,$7)`,
        [
          tenant,
          revisionId,
          agentId,
          program.hash,
          program.strategy,
          request.workspace,
          {
            bounds: program.bounds,
            experience: request.experience,
            mode: "paper",
          },
        ],
      );
      const updated = await client.query(
        `update agents set name=$3,experience=$4,paper_budget=$5,revision_id=$6,
        version=case when $7 then version+1 else version end, updated_at=clock_timestamp()
        where tenant_id=$1 and id=$2 returning *`,
        [
          tenant,
          agentId,
          request.name,
          request.experience,
          request.budget,
          revisionId,
          Boolean(id),
        ],
      );
      const response = toAgent({
        ...updated.rows[0],
        workspace: request.workspace,
        content_hash: program.hash,
      });
      await client.query(
        "insert into control_requests(tenant_id,scope,key,request_hash,response) values($1,$2,$3,$4,$5)",
        [tenant, scope, key, hash, response],
      );
      await client.query("commit");
      return response;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
}
function toAgent(row: Record<string, unknown>): SavedAgent {
  return {
    schemaVersion: "control-agent/1",
    id: String(row.id),
    name: String(row.name),
    version: Number(row.version),
    revisionId: String(row.revision_id),
    hash: String(row.content_hash),
    experience: row.experience as SavedAgent["experience"],
    mode: "paper",
    state: "draft",
    workspace: row.workspace as SavedAgent["workspace"],
    budget: row.paper_budget as SavedAgent["budget"],
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}
