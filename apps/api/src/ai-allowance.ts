import type pg from 'pg';
import type { BrokerScope } from './broker-store.ts';

export const PAPER_AI_CALLS_PER_DAY = 20;
export const PAPER_AI_USD_MICROS_PER_DAY = 100000n;
export type Allowance = { allowed: true } | { allowed: false; message: string };

/** Virtual paper API allowance only. Serialize claims across deployments/runs on the agent row. */
export class AiAllowance {
  readonly pool: pg.Pool;
  readonly now: () => Date;
  constructor(pool: pg.Pool, now: () => Date = () => new Date()) { this.pool = pool; this.now = now; }
  async reserve(scope: BrokerScope, operationKey: string, ceiling: bigint, transaction?: pg.PoolClient): Promise<Allowance> {
    if (ceiling < 0n || ceiling > PAPER_AI_USD_MICROS_PER_DAY) return { allowed: false, message: 'This AI call exceeds the daily API allowance.' };
    const client = transaction ?? await this.pool.connect();
    try {
      if (!transaction) await client.query('begin');
      const agent = (await client.query<{ id: string; paper_budget: { dataAndAiUsdMicros?: string } | null }>(`select a.id,a.paper_budget from agents a
        join deployments d on d.tenant_id=a.tenant_id and d.agent_id=a.id
        join runs r on r.tenant_id=d.tenant_id and r.deployment_id=d.id
        join broker_operations b on b.tenant_id=r.tenant_id and b.run_id=r.run_id
        where a.tenant_id=$1 and d.id=$2 and r.generation=$3 and r.run_id=$4 and b.operation_key=$5 and d.mode='paper'
        and b.request->>'kind'='ai.decide' for update of a`, [scope.tenantId,scope.deploymentId,scope.generation,scope.runId,operationKey])).rows[0];
      if (!agent) throw new Error('A paper AI dispatch claim is required.');
      const existing = (await client.query<{ reserved_usd_micros: string }>('select reserved_usd_micros from ai_allowance_reservations where tenant_id=$1 and operation_key=$2', [scope.tenantId,operationKey])).rows[0];
      if (existing) {
        if (BigInt(existing.reserved_usd_micros) !== ceiling) throw new Error('The AI reservation ceiling cannot change.');
        if (!transaction) await client.query('commit'); return { allowed: true };
      }
      const now = this.now(), day = now.toISOString().slice(0,10);
      const totals = (await client.query<{ calls: string; daily: string; allocated: string }>(`select count(*) filter(where authorized_day=$3 and counts_call)::text as calls,
        coalesce(sum(case when state='held' then reserved_usd_micros else charged_usd_micros end) filter(where authorized_day=$3),0)::text as daily,
        coalesce(sum(case when state='held' then reserved_usd_micros else charged_usd_micros end),0)::text as allocated
        from ai_allowance_reservations where tenant_id=$1 and agent_id=$2`, [scope.tenantId,agent.id,day])).rows[0]!;
      const allocation = agent.paper_budget?.dataAndAiUsdMicros;
      const reason = BigInt(totals.calls) >= BigInt(PAPER_AI_CALLS_PER_DAY) ? 'The sandbox AI allowance of 20 calls for today is used up.'
        : BigInt(totals.daily) + ceiling > PAPER_AI_USD_MICROS_PER_DAY ? 'The sandbox AI allowance of USD 0.10 for today is used up.'
        : !allocation || !/^(0|[1-9][0-9]{0,77})$/.test(allocation) || BigInt(totals.allocated) + ceiling > BigInt(allocation) ? 'The agent API allocation is insufficient for this AI call.' : undefined;
      if (reason) { if (!transaction) await client.query('commit'); return { allowed: false, message: reason }; }
      await client.query(`insert into ai_allowance_reservations(tenant_id,operation_key,agent_id,authorized_at,authorized_day,reserved_usd_micros,state) values($1,$2,$3,$4,$5,$6,'held')`, [scope.tenantId,operationKey,agent.id,now,day,ceiling.toString()]);
      if (!transaction) await client.query('commit'); return { allowed: true };
    } catch (error) { if (!transaction) await client.query('rollback'); throw error; }
    finally { if (!transaction) client.release(); }
  }

  /** Known Kimi usage comes from immutable metering; synthetic calls settle at zero. */
  async settleKnown(): Promise<number> {
    const result = await this.pool.query(`update ai_allowance_reservations a set state='settled',charged_usd_micros=case when m.state='settled' then m.charged_usd_micros else 0 end,settled_at=now()
      from broker_operations o join broker_results b on b.tenant_id=o.tenant_id and b.id=o.latest_result_id
      left join ai_metering m on m.tenant_id=o.tenant_id and m.operation_key=o.operation_key
      where a.tenant_id=o.tenant_id and a.operation_key=o.operation_key and a.state='held'
      and ((m.state='settled' and m.charged_usd_micros<=a.reserved_usd_micros)
        or (m.operation_key is null and b.response->>'disposition'='refused')
        or (m.operation_key is null and a.reserved_usd_micros=0 and b.response->>'disposition'='completed'))`);
    return result.rowCount ?? 0;
  }
}
