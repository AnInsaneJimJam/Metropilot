import type pg from 'pg';
import { canonicalize, contentHash, intentKey, operationKey, validate } from '@monad-hack/contracts';
import type { ActionIntent, BrokerRequest, BrokerResult } from '@monad-hack/contracts';
import { advanceRun, compileStrategy, startRun, LanguageError } from '@monad-hack/strategy';
import type { Catalog, HostResponse } from '@monad-hack/strategy';
import type { DeploymentAuthority } from './authorization.ts';

/** Replays only stored effects; the interpreter rebuilds lexical bindings and evaluates every branch. */
export async function verifyBranchEvidence(pool: pg.Pool, authority: DeploymentAuthority, intent: ActionIntent, now = new Date()): Promise<boolean> {
  const scope = [authority.tenantId, authority.deploymentId, authority.generation, intent.runId];
  const run = (await pool.query<{
    deployment_revision: string; trigger_id: string; source_event_key: string;
    strategy: string; catalog: string; strategy_hash: string; catalog_hash: string;
  }>(`select r.deployment_revision,r.trigger_id,r.source_event_key,s.body as strategy,c.body as catalog,d.strategy_hash,d.catalog_hash
    from runs r join deployments d on d.tenant_id=r.tenant_id and d.id=r.deployment_id
    join artifacts s on s.tenant_id=d.tenant_id and s.deployment_id=d.id and s.kind='strategy' and s.content_hash=d.strategy_hash
    join artifacts c on c.tenant_id=d.tenant_id and c.deployment_id=d.id and c.kind='catalog' and c.content_hash=d.catalog_hash
    where r.tenant_id=$1 and r.deployment_id=$2 and r.generation=$3 and r.run_id=$4`, scope)).rows[0];
  if (!run) return false;
  const records = (await pool.query<{ id: string; operation_key: string; request: BrokerRequest; response: BrokerResult }>(
    `select b.id,b.operation_key,o.request,b.response from broker_results b
     join broker_operations o on o.tenant_id=b.tenant_id and o.operation_key=b.operation_key
     join runs r on r.tenant_id=b.tenant_id and r.run_id=b.run_id
     where r.tenant_id=$1 and r.deployment_id=$2 and r.generation=$3 and r.run_id=$4 and b.id=any($5::uuid[])`,
    [...scope, intent.observationRefs],
  )).rows;
  if (records.length !== intent.observationRefs.length) return false;
  // SQL errors remain infrastructure failures. Malformed/mismatched evidence fails authorization.
  try {
    const catalog = JSON.parse(run.catalog) as Catalog;
    const program = await compileStrategy(run.strategy, catalog);
    if (program.hash !== run.strategy_hash || await contentHash(catalog) !== run.catalog_hash) return false;
    let checkpoint = await startRun(program, { deploymentRevision: run.deployment_revision, triggerId: run.trigger_id, sourceEventKey: run.source_event_key });
    if (checkpoint.runId !== intent.runId) return false;
    let next = await advanceRun(program, checkpoint);
    const used = new Set<string>();
    while (next.command) {
      const command = next.command;
      if (command.kind === 'swap.exactInput' && command.nodeId === intent.nodeId && canonicalize(command.iterationPath) === canonicalize(intent.iterationPath)) return used.size === records.length;
      const identity = { deploymentId: authority.deploymentId, generation: authority.generation, runId: intent.runId, nodeId: command.nodeId, iterationPath: command.iterationPath };
      let response: HostResponse;
      if (command.kind === 'read' || command.kind === 'ai.decide') {
        const key = await operationKey(command.kind, identity);
        const record = records.find(r => r.operation_key === key);
        if (!record || used.has(record.id)) return false;
        const checked = validate('brokerResult', record.response);
        if (!checked.ok || checked.value.disposition !== 'completed' || checked.value.resultId !== record.id || checked.value.operationKey !== key) return false;
        if (command.kind === 'read') {
          const observed = Date.parse(checked.value.observedAt ?? '');
          const maxAge = program.bindings[command.nodeId]?.maxAgeSeconds;
          if (!Number.isFinite(observed) || observed > now.getTime() || (maxAge !== undefined && now.getTime() - observed > maxAge*1000)) return false;
        }
        const { key: _coreKey, ...request } = command;
        if (canonicalize(record.request) !== canonicalize({ schemaVersion: 'broker-request/1', ...request, operationKey: key })) return false;
        used.add(record.id);
        response = { key: command.key, outcome: 'recorded', result: checked.value.value, ...(checked.value.receivedAt ? { receivedAt: checked.value.receivedAt } : {}) };
      } else if (command.kind === 'swap.exactInput') {
        const key = await intentKey(identity);
        const settled = await pool.query(`select 1 from intents where tenant_id=$1 and deployment_id=$2 and generation=$3 and run_id=$4 and logical_key=$5 and state='settled'`, [...scope, key]);
        if (!settled.rowCount) return false;
        response = { key: command.key, outcome: 'settled' };
      } else {
        const key = await operationKey('notify', identity);
        const acknowledged = await pool.query(`select 1 from run_operations where tenant_id=$1 and run_id=$2 and operation_key=$3 and outcome='acknowledged'`, [authority.tenantId, intent.runId, key]);
        if (!acknowledged.rowCount) return false;
        response = { key: command.key, outcome: 'acknowledged' };
      }
      checkpoint = next.checkpoint;
      next = await advanceRun(program, checkpoint, response);
    }
    return false;
  } catch (error) {
    // PostgreSQL failures must not be reported as forged evidence.
    if (error instanceof LanguageError || error instanceof SyntaxError || error instanceof TypeError) return false;
    throw error;
  }
}
