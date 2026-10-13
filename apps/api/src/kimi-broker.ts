import type pg from 'pg';
import type { BrokerRequest, BrokerResult } from '@monad-hack/contracts';
import { BrokerStore } from './broker-store.ts';
import type { BrokerScope, BrokerProvenance } from './broker-store.ts';
import { KimiAdapter, KIMI_MODEL, KIMI_RATES, usageCost } from './kimi-adapter.ts';
import type { TokenUsage } from './kimi-adapter.ts';
import type { AiAllowance } from './ai-allowance.ts';

/** Durable dispatch/metering around a single bounded model request. Never retries provider I/O. */
export class KimiBroker {
  readonly pool: pg.Pool;
  readonly adapter: KimiAdapter;
  readonly modelId = KIMI_MODEL;
  readonly profileVersion = '1.0.0';
  constructor(pool: pg.Pool, adapter: KimiAdapter) { this.pool = pool; this.adapter = adapter; }
  async dispatch(scope: BrokerScope, request: BrokerRequest, allowance?: AiAllowance): Promise<BrokerResult> {
    const refuse = (code: NonNullable<BrokerResult['reason']>['code'], message: string): BrokerResult => ({ schemaVersion: 'broker-result/1', operationKey: request.operationKey, disposition: 'refused', reason: { code, message } });
    if (!this.adapter.enabled) return refuse('BROKER_NOT_ALLOWED', 'Kimi is disabled until provider verification is recorded.');
    let plan;
    try { plan = this.adapter.prepare(request); }
    catch { return refuse('BROKER_BUDGET_EXHAUSTED', 'This AI request exceeds the bounded profile.'); }
    const overdue = await this.pool.query(`select 1 from ai_metering where model_id=$1 and state in ('dispatched','reconciling') and authorized_at < now()-interval '24 hours' limit 1`, [KIMI_MODEL]);
    if (overdue.rowCount) return refuse('BROKER_PROVIDER_UNAVAILABLE', 'This model profile is paused pending billing reconciliation.');
    const client = await this.pool.connect();
    let claimed: pg.QueryResult;
    try {
      await client.query('begin');
      // Both claims commit together; a crash cannot strand an unused positive hold.
      if (allowance) {
        const reservation = await allowance.reserve(scope, request.operationKey, plan.reservedUsdMicros, client);
        if (!reservation.allowed) {
          await client.query('rollback');
          return refuse('BROKER_BUDGET_EXHAUSTED', reservation.message);
        }
      }
      claimed = await client.query(`insert into ai_metering(tenant_id,operation_key,agent_id,model_id,rate_version,input_rate,cached_input_rate,output_rate,max_input_tokens,max_output_tokens,reserved_usd_micros,state)
      select b.tenant_id,b.operation_key,d.agent_id,$5,$6,$7,$8,$9,$10,$11,$12,'dispatched'
      from broker_operations b join runs r on r.tenant_id=b.tenant_id and r.run_id=b.run_id
      join deployments d on d.tenant_id=r.tenant_id and d.id=r.deployment_id
      where b.tenant_id=$1 and r.deployment_id=$2 and r.generation=$3 and r.run_id=$4 and b.operation_key=$13 and d.mode='paper'
      on conflict do nothing returning operation_key`,
      [scope.tenantId,scope.deploymentId,scope.generation,scope.runId,KIMI_MODEL,KIMI_RATES.version,KIMI_RATES.input.toString(),KIMI_RATES.cachedInput.toString(),KIMI_RATES.output.toString(),plan.maxInputTokens,plan.maxOutputTokens,plan.reservedUsdMicros.toString(),request.operationKey]);
      await client.query('commit');
    } catch (error) { await client.query('rollback'); throw error; }
    finally { client.release(); }
    if (!claimed.rowCount) {
      const row = (await this.pool.query<{ result: BrokerResult | null }>('select result from ai_metering where tenant_id=$1 and operation_key=$2', [scope.tenantId,request.operationKey])).rows[0];
      return row?.result ?? { schemaVersion: 'broker-result/1', operationKey: request.operationKey, disposition: 'unknown', reason: { code: 'BROKER_PROVIDER_UNAVAILABLE', message: 'The original dispatch requires reconciliation.' } };
    }
    const answer = await this.adapter.call(request, plan);
    if (answer.usage) {
      const settled = await this.pool.query(`update ai_metering set state='settled',usage=$3,charged_usd_micros=$4,provider_request_id=$5,result=$6,settled_at=now() where tenant_id=$1 and operation_key=$2 and state in ('dispatched','reconciling') returning operation_key`, [scope.tenantId,request.operationKey,answer.usage,usageCost(answer.usage).toString(),answer.providerRequestId,answer.result]);
      if (!settled.rowCount) {
        const frozen = (await this.pool.query<{ result: BrokerResult }>('select result from ai_metering where tenant_id=$1 and operation_key=$2', [scope.tenantId, request.operationKey])).rows[0];
        if (!frozen) throw new Error('AI dispatch record missing.');
        return frozen.result;
      }
    } else {
      await this.pool.query(`update ai_metering set state='reconciling',result=$3 where tenant_id=$1 and operation_key=$2 and state='dispatched'`, [scope.tenantId,request.operationKey,answer.result]);
    }
    return answer.result;
  }

  /** Privileged reconciliation only: independently verified usage, never model text or a runtime claim. */
  async reconcileUsage(tenantId: string, operationKey: string, providerRequestId: string, usage: TokenUsage, evidence: string): Promise<void> {
    if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(providerRequestId) || !evidence || evidence.length > 500) throw new Error('Bounded billing evidence is required.');
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const row = (await client.query<{ state: string; max_input_tokens: number; max_output_tokens: number; reserved_usd_micros: string; input_rate: string; cached_input_rate: string; output_rate: string; provider_request_id: string | null }>('select * from ai_metering where tenant_id=$1 and operation_key=$2 for update', [tenantId,operationKey])).rows[0];
      if (!row) throw new Error('AI dispatch not found.');
      if (row.state === 'settled') throw new Error('AI usage is already settled.');
      const charge = usageCost(usage, { input: BigInt(row.input_rate), cachedInput: BigInt(row.cached_input_rate), output: BigInt(row.output_rate) });
      if (usage.input > row.max_input_tokens || usage.output > row.max_output_tokens || charge > BigInt(row.reserved_usd_micros) || (row.provider_request_id && row.provider_request_id !== providerRequestId)) throw new Error('Billing exceeds the reserved bound or changes identity.');
      const result: BrokerResult = { schemaVersion: 'broker-result/1', operationKey, disposition: 'refused', reason: { code: 'BROKER_TIMEOUT', message: 'Original billing reconciled; no verified model decision was available.' } };
      await client.query(`update ai_metering set state='settled',usage=$3,charged_usd_micros=$4,provider_request_id=$5,result=$6,reconciliation_evidence=$7,settled_at=now() where tenant_id=$1 and operation_key=$2`, [tenantId,operationKey,usage,charge.toString(),providerRequestId,result,evidence]);
      await client.query('commit');
    } catch (error) { await client.query('rollback'); throw error; }
    finally { client.release(); }
  }

  /** Recover a crash after metering committed but before the broker answer did. No network calls. */
  async recover(): Promise<number> {
    await this.pool.query(`update ai_metering set state='reconciling',result=jsonb_build_object('schemaVersion','broker-result/1','operationKey',operation_key,'disposition','unknown','reason',jsonb_build_object('code','BROKER_TIMEOUT','message','Original dispatch was interrupted; its allowance remains held.')) where state='dispatched' and authorized_at < now()-interval '35 seconds'`);
    const rows = (await this.pool.query<{ tenant_id: string; deployment_id: string; generation: number; run_id: string; request: BrokerRequest; result: BrokerResult; provenance: BrokerProvenance }>(`select a.tenant_id,r.deployment_id,r.generation,r.run_id,o.request,a.result,b.provenance from ai_metering a
      join broker_operations o on o.tenant_id=a.tenant_id and o.operation_key=a.operation_key
      join broker_results b on b.tenant_id=o.tenant_id and b.id=o.latest_result_id
      join runs r on r.tenant_id=o.tenant_id and r.run_id=o.run_id
      where (a.state='settled' and b.response->>'disposition' in ('pending','unknown')) or (a.state='reconciling' and b.response->>'disposition'='pending') order by a.authorized_at limit 100`)).rows;
    const store = new BrokerStore(this.pool);
    for (const row of rows) await store.resolve({ tenantId: row.tenant_id, deploymentId: row.deployment_id, generation: String(row.generation), runId: row.run_id }, row.request, row.result, row.provenance);
    return rows.length;
  }
}
