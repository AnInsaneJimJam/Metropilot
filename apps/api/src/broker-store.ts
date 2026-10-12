import type pg from "pg";
import { contentHash, operationKey, parse } from "@monad-hack/contracts";
import type {
  BrokerRequest,
  BrokerResult,
  PersistedBrokerResult,
} from "@monad-hack/contracts";
import { ControlError, newId } from "./control.ts";

export interface BrokerScope {
  tenantId: string;
  deploymentId: string;
  generation: string;
  runId: string;
}
export type BrokerProvenance = PersistedBrokerResult["provenance"];

/** Owns durable dispatch identity; a provider never runs while a DB transaction is held. */
export class BrokerStore {
  readonly pool: pg.Pool;
  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  async read(
    scope: BrokerScope,
    resultId: string,
  ): Promise<PersistedBrokerResult> {
    const { rows } = await this.pool.query<{ document: PersistedBrokerResult }>(
      `select jsonb_build_object('schemaVersion','persisted-broker-result/1','id',b.id,
       'operationKey',b.operation_key,'runId',b.run_id,'nodeId',b.node_id,'kind',b.kind,
       'response',b.response,'provenance',b.provenance) as document
       from broker_results b join runs r on r.tenant_id=b.tenant_id and r.run_id=b.run_id
       where b.tenant_id=$1 and b.id=$2 and r.deployment_id=$3 and r.generation=$4 and r.run_id=$5`,
      [
        scope.tenantId,
        resultId,
        scope.deploymentId,
        scope.generation,
        scope.runId,
      ],
    );
    if (!rows[0])
      throw new ControlError(404, "NOT_FOUND", "Broker result not found.");
    return rows[0].document;
  }

  /** Identical replays return the current immutable answer, including an unresolved dispatch. */
  async execute(
    scope: BrokerScope,
    request: BrokerRequest,
    provenance: BrokerProvenance,
    dispatch: () => Promise<BrokerResult>,
  ): Promise<BrokerResult> {
    if (!parse("brokerRequest", JSON.stringify(request)).ok)
      throw new ControlError(400, "SCHEMA_INVALID", "Invalid broker request.");
    const expected = await operationKey(request.kind, {
      deploymentId: scope.deploymentId,
      generation: scope.generation,
      runId: request.runId,
      nodeId: request.nodeId,
      iterationPath: request.iterationPath,
    });
    if (scope.runId !== request.runId || expected !== request.operationKey)
      throw new ControlError(
        403,
        "FORBIDDEN",
        "Broker operation does not match this run.",
      );
    const hash = await contentHash(request);
    const claim = await this.tx(async (c) => {
      // Locking the run serializes admission with pause/revocation and runtime writes.
      const { rows } = await c.query<{
        status: string;
        outcome: string | null;
        kind: string;
        node_id: string;
        iteration_path: number[];
      }>(
        `select r.status,o.outcome,o.kind,o.node_id,o.iteration_path from runs r
         join deployments d on d.tenant_id=r.tenant_id and d.id=r.deployment_id
         join run_operations o on o.tenant_id=r.tenant_id and o.run_id=r.run_id
         where r.tenant_id=$1 and r.run_id=$2 and r.deployment_id=$3 and r.generation=$4
         and d.generation=r.generation and d.desired_state='active' and r.status<>'revoked'
         and o.operation_key=$5 for update of r,d`,
        [
          scope.tenantId,
          scope.runId,
          scope.deploymentId,
          scope.generation,
          request.operationKey,
        ],
      );
      const op = rows[0];
      if (
        !op ||
        op.kind !== request.kind ||
        op.node_id !== request.nodeId ||
        JSON.stringify(op.iteration_path) !==
          JSON.stringify(request.iterationPath)
      )
        throw new ControlError(
          403,
          "FORBIDDEN",
          "An active, persisted waiting operation is required.",
        );
      const previous = await c.query<{
        request_hash: string;
        response: BrokerResult;
      }>(
        `select o.request_hash,b.response from broker_operations o join broker_results b
         on b.tenant_id=o.tenant_id and b.id=o.latest_result_id where o.tenant_id=$1 and o.operation_key=$2`,
        [scope.tenantId, request.operationKey],
      );
      if (previous.rows[0]) {
        if (previous.rows[0].request_hash !== hash)
          throw new ControlError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "Broker operation was already used for different input.",
          );
        return previous.rows[0].response;
      }
      if (!['assigned', 'waiting', 'queued'].includes(op.status) || (op.outcome !== null && op.outcome !== 'pending'))
        throw new ControlError(409, 'REVISION_CONFLICT', 'Finished work cannot start a new broker dispatch.');
      await c.query(
        "insert into broker_operations(tenant_id,operation_key,run_id,request_hash,request) values($1,$2,$3,$4,$5)",
        [scope.tenantId, request.operationKey, scope.runId, hash, request],
      );
      await this.append(
        c,
        scope,
        request,
        {
          schemaVersion: "broker-result/1",
          operationKey: request.operationKey,
          disposition: "pending",
        },
        provenance,
      );
      return undefined;
    });
    if (claim) return claim;
    let response: BrokerResult;
    try {
      response = await dispatch();
    } catch {
      response = {
        schemaVersion: "broker-result/1",
        operationKey: request.operationKey,
        disposition: "unknown",
        reason: {
          code: "BROKER_PROVIDER_UNAVAILABLE",
          message: "Dispatch outcome requires reconciliation.",
        },
      };
    }
    return this.resolve(scope, request, response, provenance);
  }

  /** Reconciliation appends a result; it never calls the provider or changes an earlier record. */
  async resolve(
    scope: BrokerScope,
    request: BrokerRequest,
    response: BrokerResult,
    provenance: BrokerProvenance,
  ): Promise<BrokerResult> {
    return this.tx(async (c) => {
      const { rows } = await c.query<{
        request_hash: string;
        latest_result_id: string;
      }>(
        `select o.request_hash,o.latest_result_id from broker_operations o
         join runs r on r.tenant_id=o.tenant_id and r.run_id=o.run_id
         where o.tenant_id=$1 and o.run_id=$2 and o.operation_key=$3 and r.deployment_id=$4 and r.generation=$5 for update of o`,
        [scope.tenantId,scope.runId,request.operationKey,scope.deploymentId,scope.generation],
      );
      const prior = rows[0];
      if (!prior) throw new ControlError(404, 'NOT_FOUND', 'Broker operation not found.');
      // Read after acquiring the operation lock, with a fresh statement snapshot.
      const current = (await c.query<{ response: BrokerResult }>('select response from broker_results where tenant_id=$1 and id=$2', [scope.tenantId, prior.latest_result_id])).rows[0];
      if (!current) throw new ControlError(404, 'NOT_FOUND', 'Broker answer not found.');
      if (prior.request_hash !== (await contentHash(request)))
        throw new ControlError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "Broker request differs from the stored dispatch.",
        );
      if (["completed", "refused"].includes(current.response.disposition))
        return current.response;
      return this.append(c, scope, request, response, provenance);
    });
  }

  private async append(
    c: pg.PoolClient,
    scope: BrokerScope,
    request: BrokerRequest,
    response: BrokerResult,
    provenance: BrokerProvenance,
  ): Promise<BrokerResult> {
    const id = newId();
    const answer = {
      ...response,
      ...(response.disposition === "completed" ? { resultId: id } : {}),
    };
    const record: PersistedBrokerResult = {
      schemaVersion: "persisted-broker-result/1",
      id,
      operationKey: request.operationKey,
      runId: request.runId,
      nodeId: request.nodeId,
      kind: request.kind,
      response: answer,
      provenance,
    };
    if (
      answer.operationKey !== request.operationKey ||
      !parse("brokerResult", JSON.stringify(answer)).ok ||
      !parse("persistedBrokerResult", JSON.stringify(record)).ok
    )
      throw new ControlError(
        422,
        "SCHEMA_INVALID",
        "Invalid broker result or provenance.",
      );
    await c.query(
      `insert into broker_results(tenant_id,id,operation_key,run_id,node_id,kind,response,value,observed_at,received_at,provenance)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        scope.tenantId,
        id,
        request.operationKey,
        request.runId,
        request.nodeId,
        request.kind,
        answer,
        answer.value ?? null,
        answer.observedAt ?? null,
        answer.receivedAt ?? new Date().toISOString(),
        provenance,
      ],
    );
    await c.query(
      "update broker_operations set latest_result_id=$3 where tenant_id=$1 and operation_key=$2",
      [scope.tenantId, request.operationKey, id],
    );
    return answer;
  }

  private async tx<T>(call: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("begin");
      const result = await call(c);
      await c.query("commit");
      return result;
    } catch (error) {
      await c.query("rollback");
      throw error;
    } finally {
      c.release();
    }
  }
}
